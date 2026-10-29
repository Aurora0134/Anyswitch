// Restore-native driver (uninstall/rollback) — strips every trace Anyswitch
// leaves in an endpoint's own configuration, per endpoint, idempotently.
//
// What an endpoint integration leaves behind, and how each is stripped:
//   - kimi/grok/codex/qoder/opencode/dsh/zcode/pi: the launcher merge modules
//     wrote a managed provider set into the tool's own config file, recorded
//     in a per-endpoint sidecar under the relay data root. The primary strip
//     is the endpoint's own public writer run with an EMPTY store — the
//     "empty managed set sync" the launchers already use for
//     last-channel-deleted cleanup (kimi-launcher.mjs writeKimiConfig).
//   - that public path early-returns when the sidecar is already empty, so a
//     managed block whose sidecar was lost (data root wiped, file
//     hand-deleted) would survive it. A marker/fingerprint sweep therefore
//     runs after every public sync, built from the merge modules' own
//     exported strip helpers and id conventions (MANAGED_BEGIN/END markers,
//     the reserved "_" id prefix, qoder's deterministic connection-id
//     prefix, and the loopback-relay URL fingerprint every managed entry
//     carries). The sweep also removes the empty marker block an empty sync
//     itself leaves behind.
//   - claude never got a config merge (pure env injection); its residue is
//     the managed block in ~/.claude/CLAUDE.md (removed through the prompts
//     injector's public API) and the skill junctions under ~/.claude/skills
//     (rmdir on a junction removes only the link — agent-skills.mjs).
//   - the shims under ~/.config/anyswitch-bin and their HKCU PATH entries
//     are retired through shim-manager.mjs. A shim directory's PATH entry is
//     dropped exactly when the directory no longer exists, so the shared
//     bin/ keeps its entry while any of dsh-cli/zcode still lives there.
//
// Prompt presets on the non-claude endpoints (~/.kimi-code/AGENTS.md etc.)
// are user-authored panel content, not routing residue, and are deliberately
// out of scope. Timestamped config.backup.* files are left in place — they
// are the user's recovery net, already bounded by the writers' pruneBackups.
//
// Pure library: importing touches nothing. The driver takes its home dir,
// sidecar root, shim manager and prompts injector as injected dependencies;
// tests run entirely against temp directories with fake PATH stores.

import { existsSync, lstatSync, readFileSync, readdirSync, rmSync, rmdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { relayDataRoot } from "./relay-settings.mjs";
import { createPromptsInjector } from "./agent-prompts-inject.mjs";
import { createShimManager, SHIM_SPECS } from "./shim-manager.mjs";

import { writeKimiConfig, kimiConfigPath } from "./kimi-launcher.mjs";
import * as kimiMerge from "./kimi-merge-config.mjs";
import { ANYSWITCH_CHANNEL_NAME } from "./merge-common.mjs";
import * as grokMerge from "./grok-merge-config.mjs";
import * as codexMerge from "./codex-merge-config.mjs";
import * as qoderMerge from "./qoder-merge-config.mjs";
import { writeZcodeConfig, zcodeConfigPath } from "./zcode-launcher.mjs";
import * as zcodeMerge from "./zcode-merge-config.mjs";
import * as zcodePersonal from "./zcode-personal-config.mjs";
import { writeOpencodeConfig, opencodeConfigPath } from "./opencode-launcher.mjs";
import * as opencodeMerge from "./opencode-merge-config.mjs";
import { writePiModels, piModelsPath } from "./pi-launcher.mjs";
import * as piMerge from "./pi-merge-models.mjs";
import { dshSettingsPath } from "./dsh-launcher.mjs";
import * as dshMerge from "./dsh-merge-config.mjs";

// Placeholder port/token for the strip syncs: with an empty managed set no
// provider entry is ever built, so neither value reaches a file. They exist
// only to satisfy the write-function signatures.
const STRIP_PORT = 47821;
const STRIP_TOKEN = "";

// Every managed entry an Anyswitch sync writes points at the loopback relay's
// OpenAI surface — the fingerprint that identifies our residue when the
// sidecar record is gone (same convention as zcode-personal-config.mjs's
// isAnyswitchRule).
const RELAY_OPENAI_BASE_URL = /^http:\/\/127\.0\.0\.1:[0-9]{1,5}\/openai\//;

// Pre-rename markers (apicred era) — kimi-merge-config.mjs's stripManagedBlock
// recognizes them too; the residue gate needs the literal to look for.
const KIMI_LEGACY_MANAGED_BEGIN = "# >>> apicred-managed-kimi (managed by ApiCred; do not edit) >>>";

function stepFail(step, error) {
  return { step, ok: false, changed: false, error: error?.message ?? String(error) };
}

// Map a writer's { ok, unchanged, reason } onto a step record.
function syncStep(result) {
  if (result?.ok) {
    return { step: "config-sync", ok: true, changed: result.unchanged !== true, ...(result.reason ? { detail: result.reason } : {}) };
  }
  return { step: "config-sync", ok: false, changed: false, error: result?.reason ?? "sync failed" };
}

// Marker sweep for the TOML-family endpoints (kimi/grok/codex), built from
// each merge module's own exported strip functions so the marker and
// stale-table conventions never drift between sync and uninstall. A file
// reduced to nothing is deleted rather than left as an empty husk (same
// convention as the prompts injector's block removal).
function sweepTomlResidue({ configPath, hasResidue, strip, writeWithBackup }) {
  if (!existsSync(configPath)) return { step: "marker-sweep", ok: true, changed: false };
  const text = readFileSync(configPath, "utf8");
  if (!hasResidue(text)) return { step: "marker-sweep", ok: true, changed: false };
  let stripped;
  try {
    stripped = strip(text);
  } catch (error) {
    return stepFail("marker-sweep", error);
  }
  if (stripped === text) return { step: "marker-sweep", ok: true, changed: false };
  if (stripped.trim() === "") {
    rmSync(configPath, { force: true });
    return { step: "marker-sweep", ok: true, changed: true, removed: true };
  }
  const result = writeWithBackup(configPath, stripped);
  return { step: "marker-sweep", ok: result.ok !== false, changed: result.unchanged !== true };
}

// Shared JSON sweep shape: load via the module's own fail-closed reader,
// delete the keys selectManaged marks, then validate + write back with the
// module's own writer. Nothing is written when no key matched.
function sweepJsonResidue({ configPath, read, selectManaged, validate, writeWithBackup }) {
  if (!existsSync(configPath)) return { step: "marker-sweep", ok: true, changed: false };
  let config;
  try {
    config = read(configPath);
  } catch (error) {
    return stepFail("marker-sweep", error);
  }
  const removed = selectManaged(config);
  if (removed.length === 0) return { step: "marker-sweep", ok: true, changed: false };
  if (validate) {
    const gate = validate(config);
    if (!gate.valid) return stepFail("marker-sweep", new Error(gate.error));
  }
  const result = writeWithBackup(configPath, config);
  return { step: "marker-sweep", ok: result.ok !== false, changed: result.unchanged !== true, removed };
}

// ─────────────────────────────────────────────────────────────
// Per-endpoint strips
// ─────────────────────────────────────────────────────────────

async function stripKimi(ctx) {
  const configPath = kimiConfigPath(ctx.env);
  const steps = [];
  try {
    // effort options pinned off: uninstall must not rewrite the user's own
    // [thinking] table (the default resolution would read the panel switch).
    steps.push(syncStep(await writeKimiConfig({}, STRIP_PORT, STRIP_TOKEN, ctx.sidecarRoot, configPath, { catalog: null, takeOverThinking: false })));
  } catch (error) {
    steps.push(stepFail("config-sync", error));
  }
  steps.push(sweepTomlResidue({
    configPath,
    hasResidue: (text) =>
      text.includes(kimiMerge.MANAGED_BEGIN) ||
      text.includes(KIMI_LEGACY_MANAGED_BEGIN) ||
      /^\s*\[(providers|models)\."?_/m.test(text) ||
      // The Anyswitch pseudo-channel's provider id is its display name, so it
      // is the one managed table the "_" prefix cannot catch.
      /^\s*\[providers\.(?:"Anyswitch"|Anyswitch)\]/m.test(text),
    strip: (text) => kimiMerge.stripPrefixedTables(kimiMerge.stripManagedBlock(text)),
    writeWithBackup: kimiMerge.writeKimiConfigTomlWithBackup,
  }));
  return steps;
}

async function stripGrok(ctx) {
  const configPath = grokMerge.grokConfigPath(ctx.env);
  const steps = [];
  try {
    steps.push(syncStep(await grokMerge.writeGrokConfig({}, STRIP_PORT, STRIP_TOKEN, ctx.sidecarRoot, configPath, { catalog: null })));
  } catch (error) {
    steps.push(stepFail("config-sync", error));
  }
  steps.push(sweepTomlResidue({
    configPath,
    hasResidue: (text) =>
      text.includes(grokMerge.MANAGED_BEGIN) || /^\s*\[+model\."?anyswitch-/m.test(text),
    strip: (text) => grokMerge.stripManagedTables(grokMerge.stripManagedBlock(text)),
    writeWithBackup: grokMerge.writeGrokConfigTomlWithBackup,
  }));
  return steps;
}

// codex's generated model catalog is pointed at by a top-level
// model_catalog_json line. The public writer already strips the pointer and
// removes the file on an empty sync; the sweep path has to do both itself —
// the pointer line first (it sits outside the markers), then the file, and
// only once no surviving pointer names it.
function codexCatalogPointerMatch(line) {
  const kv = line.match(/^\s*model_catalog_json\s*=\s*(["'])((?:[^"\\]|\\.)*)\1\s*(?:#.*)?$/);
  if (!kv) return false;
  return kv[2].replace(/\\(["\\])/g, "$1") === codexMerge.CATALOG_POINTER_VALUE;
}

function stripCodexCatalogPointer(text) {
  const lines = text.split("\n");
  const out = [];
  let inTopLevel = true;
  for (const line of lines) {
    if (/^\s*\[/.test(line)) inTopLevel = false;
    if (inTopLevel && codexCatalogPointerMatch(line)) continue;
    out.push(line);
  }
  return out.join("\n");
}

function hasCodexCatalogPointer(text) {
  let inTopLevel = true;
  for (const line of text.split("\n")) {
    if (/^\s*\[/.test(line)) inTopLevel = false;
    if (inTopLevel && codexCatalogPointerMatch(line)) return true;
  }
  return false;
}

function removeOrphanedCodexCatalog(configPath) {
  const catalogPath = join(dirname(configPath), codexMerge.CATALOG_POINTER_VALUE);
  if (!existsSync(catalogPath)) return { step: "catalog-file", ok: true, changed: false };
  const text = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  if (hasCodexCatalogPointer(text)) return { step: "catalog-file", ok: true, changed: false };
  rmSync(catalogPath, { force: true });
  try {
    rmdirSync(dirname(catalogPath)); // only succeeds when nothing else lives there
  } catch { /* not empty — keep */ }
  return { step: "catalog-file", ok: true, changed: true, removed: catalogPath };
}

async function stripCodex(ctx) {
  const configPath = codexMerge.codexConfigPath(ctx.env);
  const steps = [];
  try {
    steps.push(syncStep(await codexMerge.writeCodexConfig({}, STRIP_PORT, STRIP_TOKEN, ctx.sidecarRoot, configPath, null, false)));
  } catch (error) {
    steps.push(stepFail("config-sync", error));
  }
  steps.push(sweepTomlResidue({
    configPath,
    hasResidue: (text) =>
      text.includes(codexMerge.MANAGED_BEGIN) ||
      /^\s*\[model_providers\."?anyswitch-/m.test(text) ||
      hasCodexCatalogPointer(text),
    strip: (text) => codexMerge.stripManagedTables(codexMerge.stripManagedBlock(stripCodexCatalogPointer(text))),
    writeWithBackup: codexMerge.writeCodexConfigTomlWithBackup,
  }));
  try {
    steps.push(removeOrphanedCodexCatalog(configPath));
  } catch (error) {
    steps.push(stepFail("catalog-file", error));
  }
  return steps;
}

// The public writers create their target file when it is missing but the
// sidecar says something was managed. On restore-native, a file that did not
// exist before the strip and now holds only an empty managed container is
// reclaimed — an empty husk is residue, not user data.
function reclaimCreatedHusk(steps, configPath, existedBefore, huskShape) {
  if (existedBefore || !existsSync(configPath)) return;
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8"));
    if (!huskShape(parsed)) return;
    rmSync(configPath, { force: true });
    steps.push({ step: "husk", ok: true, changed: true, removed: configPath });
  } catch { /* a file we cannot classify stays */ }
}

function isSingleEmptyMapKey(parsed, key) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const keys = Object.keys(parsed);
  if (keys.length === 0) return true;
  if (keys.length > 1 || keys[0] !== key) return false;
  const value = parsed[key];
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0;
}

async function stripQoder(ctx) {
  const settingsPath = qoderMerge.qoderSettingsPath(ctx.env.USERPROFILE ?? "");
  const steps = [];
  const existedBefore = existsSync(settingsPath);
  try {
    steps.push(syncStep(await qoderMerge.writeQoderConfig({}, STRIP_PORT, STRIP_TOKEN, ctx.sidecarRoot, settingsPath, null, false)));
  } catch (error) {
    steps.push(stepFail("config-sync", error));
  }
  // Managed connection ids are deterministic "qoder-custom-anyswitch-<hash>"
  // (qoder-merge-config.mjs managedConnectionId). The prefix constant itself
  // is module-private; derive it from the exported function instead of
  // redeclaring a string that could drift.
  const managedPrefix = qoderMerge.managedConnectionId("anyswitch-uninstall").replace(/[0-9a-f]{16}$/, "");
  steps.push(sweepJsonResidue({
    configPath: settingsPath,
    read: qoderMerge.readQoderSettings,
    selectManaged: (settings) => {
      const providers = settings?.providers;
      if (!providers || typeof providers !== "object" || Array.isArray(providers)) return [];
      const removed = Object.keys(providers).filter((id) => id.startsWith(managedPrefix));
      for (const id of removed) delete providers[id];
      if (Object.keys(providers).length === 0) delete settings.providers;
      return removed;
    },
    validate: null,
    writeWithBackup: qoderMerge.writeQoderSettingsWithBackup,
  }));
  reclaimCreatedHusk(steps, settingsPath, existedBefore, (parsed) => isSingleEmptyMapKey(parsed, "providers"));
  return steps;
}

async function stripZcode(ctx) {
  const configPath = zcodeConfigPath(ctx.env);
  const steps = [];
  // writeZcodeConfig also maintains the client-side provider_config.json and
  // CREATES both files when absent — fine for a sync, residue for an
  // uninstall. Remember pre-state so fresh empty husks can be reclaimed.
  const personalPath = zcodePersonal.personalConfigPath(configPath);
  const configExisted = existsSync(configPath);
  const personalExisted = existsSync(personalPath);
  try {
    steps.push(syncStep(await writeZcodeConfig({}, STRIP_PORT, STRIP_TOKEN, ctx.sidecarRoot, configPath, null, false)));
  } catch (error) {
    steps.push(stepFail("config-sync", error));
  }
  steps.push(sweepJsonResidue({
    configPath,
    read: zcodeMerge.readZcodeConfig,
    selectManaged: (config) => {
      const providers = config?.provider;
      if (!providers || typeof providers !== "object" || Array.isArray(providers)) return [];
      // The "_" prefix is the reserved managed namespace; the relay
      // fingerprint keeps a hand-made "_"-provider pointing at a real
      // upstream safe.
      const removed = Object.keys(providers).filter((id) =>
        id.startsWith("_") && RELAY_OPENAI_BASE_URL.test(providers[id]?.options?.baseURL ?? ""));
      for (const id of removed) delete providers[id];
      return removed;
    },
    validate: zcodeMerge.validateZcodeConfig,
    writeWithBackup: zcodeMerge.writeZcodeConfigWithBackup,
  }));
  reclaimCreatedHusk(steps, configPath, configExisted, (parsed) => isSingleEmptyMapKey(parsed, "provider"));
  // provider_config.json: the empty-set merge drops both sidecar-named and
  // fingerprinted rules. Guarded by existence — the sync WRITES the file
  // when it is absent, which would create residue instead of removing it.
  if (existsSync(personalPath)) {
    try {
      const result = zcodePersonal.syncZcodePersonalConfig({ configPath, managedEntries: {}, previousManaged: [] });
      steps.push({ step: "personal-config", ok: result.ok !== false, changed: result.unchanged !== true, ...(result.reason ? { detail: result.reason } : {}) });
    } catch (error) {
      steps.push(stepFail("personal-config", error));
    }
    if (!personalExisted) {
      try {
        const parsed = JSON.parse(readFileSync(personalPath, "utf8"));
        const rules = parsed?.config?.providerConfigRules?.providerRules;
        const modelRules = parsed?.config?.modelConfigRules?.providerModelRules;
        if (Array.isArray(rules) && rules.length === 0 && Array.isArray(modelRules) && modelRules.length === 0) {
          rmSync(personalPath, { force: true });
          steps.push({ step: "personal-config-husk", ok: true, changed: true, removed: personalPath });
        }
      } catch { /* keep a file we cannot classify */ }
    }
  }
  // CLI 槽位：上面的空集 writeZcodeConfig 已顺路把槽位条目剥掉（经共享
  // sidecar）；槽位目录整个是 Anyswitch 自有产物（只含托管
  // provider_config.json 与其备份，用户内容从不落在里面），卸载即整体移除，
  // 连同它的 sidecar（桌面版 sidecar 由驱动表的 sidecar 字段统一删）。
  const cliSlotDir = zcodeMerge.zcodeCliSlotDir(ctx.sidecarRoot);
  try {
    const existed = existsSync(cliSlotDir);
    rmSync(cliSlotDir, { recursive: true, force: true });
    steps.push({ step: "cli-slot", ok: true, changed: existed });
  } catch (error) {
    steps.push(stepFail("cli-slot", error));
  }
  const cliSidecar = zcodeMerge.zcodeCliSidecarPath(ctx.sidecarRoot);
  try {
    const existed = existsSync(cliSidecar);
    rmSync(cliSidecar, { force: true });
    steps.push({ step: "cli-sidecar", ok: true, changed: existed });
  } catch (error) {
    steps.push(stepFail("cli-sidecar", error));
  }
  return steps;
}

async function stripOpencode(ctx) {
  const configPath = opencodeConfigPath(ctx.env);
  const steps = [];
  try {
    steps.push(syncStep(await writeOpencodeConfig({}, STRIP_PORT, ctx.sidecarRoot, configPath, null, false)));
  } catch (error) {
    steps.push(stepFail("config-sync", error));
  }
  // Managed provider ids carry NO prefix (opencode-merge-config.mjs:10), so
  // with the sidecar gone the relay fingerprint is the only identification
  // left. A user provider matching it would itself be pointing at the relay.
  const isManagedEntry = (entry) =>
    entry && typeof entry === "object" &&
    entry.npm === "@ai-sdk/openai-compatible" &&
    RELAY_OPENAI_BASE_URL.test(entry.options?.baseURL ?? "") &&
    entry.options?.headers?.["x-agent-id"] === "opencode";
  steps.push(sweepJsonResidue({
    configPath,
    read: opencodeMerge.readOpencodeConfig,
    selectManaged: (config) => {
      const providers = config?.provider;
      if (!providers || typeof providers !== "object" || Array.isArray(providers)) return [];
      const removed = Object.keys(providers).filter((id) => isManagedEntry(providers[id]));
      for (const id of removed) delete providers[id];
      return removed;
    },
    validate: opencodeMerge.validateOpencodeConfig,
    writeWithBackup: opencodeMerge.writeOpencodeConfigWithBackup,
  }));
  // opencode.json is a wholesale-managed file (opencode-merge-config.mjs:4-8):
  // whenever nothing but an empty provider map remains — no matter which step
  // emptied it — native state is no file at all.
  if (existsSync(configPath)) {
    try {
      const parsed = opencodeMerge.readOpencodeConfig(configPath);
      if (isSingleEmptyMapKey(parsed, "provider")) {
        rmSync(configPath, { force: true });
        steps.push({ step: "husk", ok: true, changed: true, removed: configPath });
      }
    } catch { /* an unparseable file stays untouched */ }
  }
  return steps;
}

async function stripPi(ctx) {
  const modelsPath = piModelsPath(ctx.env);
  const steps = [];
  const existedBefore = existsSync(modelsPath);
  try {
    steps.push(syncStep(await writePiModels({}, STRIP_PORT, ctx.sidecarRoot, modelsPath, null, false)));
  } catch (error) {
    steps.push(stepFail("config-sync", error));
  }
  steps.push(sweepJsonResidue({
    configPath: modelsPath,
    read: piMerge.readModelsJson,
    selectManaged: (config) => {
      const providers = config?.providers;
      if (!providers || typeof providers !== "object" || Array.isArray(providers)) return [];
      const removed = Object.keys(providers).filter((id) =>
        (id === ANYSWITCH_CHANNEL_NAME || id.startsWith("_")) &&
        RELAY_OPENAI_BASE_URL.test(providers[id]?.baseUrl ?? ""));
      for (const id of removed) delete providers[id];
      return removed;
    },
    validate: piMerge.validatePiModelsConfig,
    writeWithBackup: piMerge.writeModelsJsonWithBackup,
  }));
  reclaimCreatedHusk(steps, modelsPath, existedBefore, (parsed) => isSingleEmptyMapKey(parsed, "providers"));
  return steps;
}

// dsh managed providers inside a profile's llm row: a managed key (the "_"
// prefix for real channels, the channel display name for the Anyswitch
// pseudo-channel), relay baseURL, endpoint header, and a relay credential —
// either the legacy token-by-env reference or the token-by-header the writer now emits
// (dsh-merge-config.mjs buildDshProviderEntry). Both shapes are accepted so an
// uninstall still cleans a profile written before the credential moved into
// the headers. Together they are the fingerprint — the merge module documents
// that a user's own "_" provider must survive.
function isDshManagedEntry(entry) {
  if (!entry || typeof entry !== "object") return false;
  if (entry.api !== "openai-completions") return false;
  if (!RELAY_OPENAI_BASE_URL.test(entry.baseURL ?? "")) return false;
  if (entry.headers?.["x-agent-id"] !== "dsh") return false;
  const authorization = entry.headers?.Authorization;
  return entry.apiKeyEnv === "ANYSWITCH_RELAY_TOKEN" ||
    (typeof authorization === "string" && authorization.startsWith("Bearer "));
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

// Collect the managed provider ids still present in any profile patch,
// identified by fingerprint rather than by the (lost) sidecar. Unparseable
// profiles are skipped — the launcher's sync reports them, uninstall leaves
// them alone.
async function collectDshResidueIds(dshHome) {
  const yaml = await dshMerge.getYamlModule();
  const ids = new Set();
  for (const patchPath of dshMerge.dshProfilePatchPaths(dshHome)) {
    if (!existsSync(patchPath)) continue;
    let entries;
    try {
      entries = yaml.load(stripBom(readFileSync(patchPath, "utf8")), { schema: dshMerge.dshYamlSchema(yaml) });
    } catch {
      continue;
    }
    if (!Array.isArray(entries)) continue;
    const row = entries.find((entry) => entry && entry.id === dshMerge.DSH_LLM_ENTRY_ID);
    const providers = row?.config?.providers;
    if (!providers || typeof providers !== "object" || Array.isArray(providers)) continue;
    for (const [key, entry] of Object.entries(providers)) {
      if (!isDshManagedEntry(entry)) continue;
      // The sweep seeds the sidecar with logical ids, which the writer's own
      // removal path maps back onto on-disk keys.
      if (key.startsWith("_")) ids.add(key.slice(1));
      else if (key === dshMerge.ANYSWITCH_CHANNEL_NAME) ids.add(dshMerge.AUTO_CHANNEL_KEY);
    }
  }
  return [...ids].sort();
}

// True when the patch file holds exactly one row — an llm row with no
// providers — i.e. the husk an empty sync creates in a profile that never
// had a patch file.
async function isEmptyLlmOnlyPatch(patchPath) {
  try {
    const yaml = await dshMerge.getYamlModule();
    const entries = yaml.load(stripBom(readFileSync(patchPath, "utf8")), { schema: dshMerge.dshYamlSchema(yaml) });
    if (!Array.isArray(entries) || entries.length !== 1) return false;
    const row = entries[0];
    if (row?.id !== dshMerge.DSH_LLM_ENTRY_ID) return false;
    const providers = row?.config?.providers;
    return !providers || (typeof providers === "object" && Object.keys(providers).length === 0);
  } catch {
    return false;
  }
}

async function stripDsh(ctx) {
  const dshHome = dirname(dshSettingsPath(ctx.env));
  const steps = [];
  // The strip syncs an empty store, so no provider profile is built and the
  // token never reaches the file; null keeps the (unused) credential honest.
  const runPublicSync = () => dshMerge.writeDshProfilePatches({}, STRIP_PORT, null, ctx.sidecarRoot, dshHome, null, false, null);
  // The public writer splices an (empty) llm row into EVERY profile patch
  // path, including profiles that never had a patch file. Record pre-state
  // so those creations can be reclaimed at the end.
  const preExisting = new Set(dshMerge.dshProfilePatchPaths(dshHome).filter((p) => existsSync(p)));
  try {
    steps.push(syncStep(await runPublicSync()));
  } catch (error) {
    steps.push(stepFail("config-sync", error));
  }
  // Sidecar-lost sweep: rebuild the managed-id list from fingerprinted
  // residue, seed the sidecar with it, and let the public writer's own
  // removal path take the entries out (the YAML splice helpers are private
  // to dsh-merge-config, so uninstall never reimplements them).
  try {
    const residueIds = await collectDshResidueIds(dshHome);
    if (residueIds.length > 0) {
      dshMerge.writeSidecar(ctx.sidecarRoot, residueIds);
      const rerun = await runPublicSync();
      steps.push({
        step: "marker-sweep",
        ok: rerun.ok !== false,
        changed: rerun.unchanged !== true,
        removed: residueIds,
        ...(rerun.ok === false ? { error: rerun.reason ?? "sweep sync failed" } : {}),
      });
    } else {
      steps.push({ step: "marker-sweep", ok: true, changed: false });
    }
  } catch (error) {
    steps.push(stepFail("marker-sweep", error));
  }
  // Reclaim patch files this strip created in profiles that never had one.
  const reclaimed = [];
  for (const patchPath of dshMerge.dshProfilePatchPaths(dshHome)) {
    if (preExisting.has(patchPath) || !existsSync(patchPath)) continue;
    if (!(await isEmptyLlmOnlyPatch(patchPath))) continue;
    try {
      rmSync(patchPath, { force: true });
      reclaimed.push(patchPath);
    } catch { /* leave it — harmless empty row */ }
  }
  steps.push({ step: "patch-husks", ok: true, changed: reclaimed.length > 0, ...(reclaimed.length > 0 ? { removed: reclaimed } : {}) });
  return steps;
}

// claude's only on-disk residue: the CLAUDE.md managed block and the skill
// junctions under ~/.claude/skills. Junction removal follows the documented
// semantics (agent-skills.mjs): rmdir on a junction removes ONLY the link,
// never the target; real directories are never touched.
function removeClaudeSkillJunctions(skillsDir) {
  if (!existsSync(skillsDir)) return { step: "skill-junctions", ok: true, changed: false };
  const removed = [];
  let entries = [];
  try {
    entries = readdirSync(skillsDir);
  } catch {
    return { step: "skill-junctions", ok: true, changed: false };
  }
  for (const name of entries) {
    const abs = join(skillsDir, name);
    let isLink = false;
    try {
      isLink = lstatSync(abs).isSymbolicLink();
    } catch {
      continue;
    }
    if (!isLink) continue;
    rmdirSync(abs);
    removed.push(name);
  }
  return { step: "skill-junctions", ok: true, changed: removed.length > 0, ...(removed.length > 0 ? { removed } : {}) };
}

function stripClaude(ctx) {
  const steps = [];
  try {
    const result = ctx.promptsInjector.syncEndpoint("claude", []);
    steps.push({ step: "prompt-block", ok: result.ok !== false, changed: result.changed === true });
  } catch (error) {
    steps.push(stepFail("prompt-block", error));
  }
  try {
    steps.push(removeClaudeSkillJunctions(join(ctx.homeDir, ".claude", "skills")));
  } catch (error) {
    steps.push(stepFail("skill-junctions", error));
  }
  return steps;
}

// ─────────────────────────────────────────────────────────────
// Endpoint registry + driver
// ─────────────────────────────────────────────────────────────

const ENDPOINT_DEFS = Object.freeze([
  { id: "claude", strip: stripClaude, shim: "claude" },
  { id: "kimi", strip: stripKimi, sidecar: kimiMerge.sidecarPath },
  { id: "grok", strip: stripGrok, sidecar: grokMerge.sidecarPath, shim: "grok" },
  { id: "codex", strip: stripCodex, sidecar: codexMerge.sidecarPath, shim: "codex" },
  { id: "qoder", strip: stripQoder, sidecar: qoderMerge.sidecarPath },
  { id: "opencode", strip: stripOpencode, sidecar: opencodeMerge.sidecarPath, shim: "opencode" },
  { id: "dsh", strip: stripDsh, sidecar: dshMerge.sidecarPath, shim: "dsh" },
  { id: "zcode", strip: stripZcode, sidecar: zcodeMerge.sidecarPath, shim: "zcode" },
  { id: "pi", strip: stripPi, sidecar: piMerge.sidecarPath, shim: "pi" },
]);

export const UNINSTALL_ENDPOINT_IDS = Object.freeze(ENDPOINT_DEFS.map((def) => def.id));

/**
 * The restore-native driver. Every dependency with side effects is
 * injectable; the defaults are the production wiring.
 *
 * @param {object} deps
 * @param {object} deps.env process-env style base (USERPROFILE/LOCALAPPDATA)
 * @param {string} deps.homeDir user home the endpoint configs live under
 * @param {string} deps.sidecarRoot relay data root holding the sidecars
 * @param {object} deps.shimManager createShimManager() instance
 * @param {object} deps.promptsInjector createPromptsInjector() instance
 */
export function createUninstallDriver({
  env = process.env,
  homeDir = env.USERPROFILE ?? homedir(),
  sidecarRoot = relayDataRoot(env),
  shimManager = createShimManager({ env }),
  promptsInjector = createPromptsInjector({ homeDir }),
} = {}) {
  const ctx = { env, homeDir, sidecarRoot, promptsInjector };

  /**
   * Restore one endpoint to its native state: strip managed config, delete
   * the sidecar, retire the shim (files + PATH entry). Idempotent — a second
   * run reports changed:false everywhere. Per-step failures are collected,
   * never thrown.
   */
  async function uninstallEndpoint(endpointId, { broadcast = true } = {}) {
    const def = ENDPOINT_DEFS.find((entry) => entry.id === endpointId);
    if (!def) throw new Error(`unknown endpoint: ${endpointId}`);
    const steps = [];
    try {
      steps.push(...(await def.strip(ctx)));
    } catch (error) {
      steps.push(stepFail("config-strip", error));
    }
    if (def.sidecar) {
      const path = def.sidecar(sidecarRoot);
      try {
        const existed = existsSync(path);
        rmSync(path, { force: true });
        steps.push({ step: "sidecar", ok: true, changed: existed });
      } catch (error) {
        steps.push(stepFail("sidecar", error));
      }
    }
    let pathChanged = false;
    if (def.shim) {
      try {
        const result = await shimManager.retireShim(def.shim);
        pathChanged = result.path.changed;
        steps.push({
          step: "shim",
          ok: true,
          changed: result.removed.length > 0 || result.dirRemoved,
          ...(result.removed.length > 0 ? { removed: result.removed } : {}),
          dirRemoved: result.dirRemoved,
        });
        steps.push({ step: "path", ok: true, changed: result.path.changed });
      } catch (error) {
        steps.push(stepFail("shim", error));
      }
    }
    if (broadcast && pathChanged) {
      try {
        await shimManager.broadcastEnvironmentChange();
        steps.push({ step: "broadcast", ok: true, changed: true });
      } catch (error) {
        steps.push(stepFail("broadcast", error));
      }
    }
    return { endpoint: endpointId, ok: steps.every((step) => step.ok), pathChanged, steps };
  }

  /**
   * Restore every endpoint, then retire shims whose launcher no longer ships
   * (retired specs — no endpoint owns them any more). The environment
   * broadcast is sent once at the end when any PATH entry changed.
   */
  async function uninstallAll() {
    const endpoints = {};
    let anyPathChanged = false;
    for (const def of ENDPOINT_DEFS) {
      endpoints[def.id] = await uninstallEndpoint(def.id, { broadcast: false });
      anyPathChanged = anyPathChanged || endpoints[def.id].pathChanged;
    }
    const retiredShims = [];
    for (const spec of SHIM_SPECS.filter((entry) => entry.retired)) {
      try {
        const result = await shimManager.retireShim(spec.id);
        anyPathChanged = anyPathChanged || result.path.changed;
        retiredShims.push({
          id: spec.id,
          ok: true,
          changed: result.removed.length > 0 || result.dirRemoved || result.path.changed,
          dirRemoved: result.dirRemoved,
        });
      } catch (error) {
        retiredShims.push({ id: spec.id, ok: false, changed: false, error: error?.message ?? String(error) });
      }
    }
    let broadcast = { ok: true, changed: false };
    if (anyPathChanged) {
      try {
        await shimManager.broadcastEnvironmentChange();
        broadcast = { ok: true, changed: true };
      } catch (error) {
        broadcast = { ok: false, changed: false, error: error?.message ?? String(error) };
      }
    }
    const ok =
      Object.values(endpoints).every((result) => result.ok) &&
      retiredShims.every((result) => result.ok) &&
      broadcast.ok;
    return { ok, endpoints, retiredShims, broadcast };
  }

  return { uninstallEndpoint, uninstallAll };
}
