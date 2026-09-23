// 数据搬迁包：把这台机器上「人写出来的配置」打成一个 zip，在另一台机器整体恢复。
//
// 包里放：store.json（渠道 / 号池 / 路由链——三者互相引用，只能整块走）、
// relay 设置、提示词预设、Skills 主仓库目录树，以及全部凭据的明文。
// 包里不放：model-stability、metrics 快照、各 *-sidecar（运行时自己长回来）、
// usage 日志（换机后统计从当天重新开始）、thinking-efforts 库（由仓库基线文件承载）。
//
// 导入语义是整体覆盖，覆盖前先把当前这几份写进 backups/pre-import-<ts>/，
// 备份号回显给界面。任何校验不通过就整包拒绝，一个字节都不落。
//
// 明文密钥只为「本机 → 本机」这一跳服务：包一旦离开这台机器就是敏感文件，
// 界面必须提示导入完成后删除。DPAPI 密文不在包里——CurrentUser 作用域绑本机
// 本账户，换机器解不开，带上只是自欺。
//
// 打包解包用系统自带 bsdtar（Win10 1803+ 的 C:\Windows\System32\tar.exe），与
// Skills 的 zip 导入同源。tarPath / spawnFn / protect / unprotect 全部可注入，
// 测试不起真进程、也不碰真 DPAPI。

import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { atomicWriteFile } from "./atomic-write.mjs";
import { protect as defaultProtect, unprotect as defaultUnprotect } from "./dpapi.mjs";
import { loadSkillsConfig, saveSkillsConfig, skillsConfigPath } from "./agent-skills.mjs";
import { loadStore, storePaths, writeStore } from "./store-io.mjs";
import { defaultSettingsPath, relayDataRoot } from "./relay-settings.mjs";
import { promptsPath } from "./agent-prompts.mjs";
import { validateStore } from "./store-schema.mjs";

export const BUNDLE_FORMAT = 1;
export const EXPORT_PREFIX = "anyswitch-export";
export const MANIFEST_NAME = "manifest.json";
export const CREDENTIALS_NAME = "credentials.json";
export const SKILLS_DIR_NAME = "skills";
export const DEFAULT_TAR = "C:\\Windows\\System32\\tar.exe";
// 预览与落定是两次请求；票据只认这里登记过的目录，路径不接受界面传入，
// 免得把临时目录名当参数用、开出任意目录读取的口子。
export const TICKET_TTL_MS = 15 * 60 * 1000;

const CONFIG_FILES = ["store.json", "settings.json", "prompts.json", "skills.json"];
// Skills 主仓库本身就是个 git 仓库：.git 既不是「人写的配置」，git 对象又是只读
// 文件，回拷到已有目录会撞 Access denied。打包与落盘两端都按名字整段跳过。
const SKIP_NAMES = new Set([".git"]);

function notSkipped(src) {
  return !src.split(/[\\/]/).some((part) => SKIP_NAMES.has(part));
}

function copyTree(src, dest) {
  cpSync(src, dest, { recursive: true, filter: notSkipped });
}

function stamp(now) {
  const d = new Date(now);
  const n = (v, w = 2) => String(v).padStart(w, "0");
  return `${d.getFullYear()}${n(d.getMonth() + 1)}${n(d.getDate())}-${n(d.getHours())}${n(d.getMinutes())}${n(d.getSeconds())}`;
}

export function exportFileName(now = Date.now()) {
  return `${EXPORT_PREFIX}-${stamp(now)}.zip`;
}

function readTextIfExists(path) {
  try {
    return existsSync(path) ? readFileSync(path, "utf8") : null;
  } catch {
    return null;
  }
}

// 把暂存目录里的明文密钥读进内存并从盘上摘掉，返回 entries（包里没这个文件返回
// null，区别于"有文件但零条密钥"）。删除失败时照样把 entries 交回去：宁可Temp里
// 多留一份，也不能把用户要导入的密钥弄丢——那份会在落定后随暂存一起清。
function liftCredentialsOut(dir) {
  const file = join(dir, CREDENTIALS_NAME);
  const text = readTextIfExists(file);
  if (text === null) return null;
  let entries;
  try {
    entries = JSON.parse(text)?.entries;
  } catch {
    entries = null;
  }
  if (!Array.isArray(entries)) return null;
  rmSafe(file);
  return entries;
}

function countPresets(text) {
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed?.presets) ? parsed.presets.length : 0;
  } catch {
    return 0;
  }
}

function topLevelDirs(dir) {
  if (!dir || !existsSync(dir) || !statSync(dir).isDirectory()) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !SKIP_NAMES.has(e.name))
    .map((e) => e.name).sort();
}

// 压缩包内条目必须落在解包目录之内：绝对路径、盘符、.. 一律拒。bsdtar 自己
// 也会剥掉这些前缀，但包是用户从网上拿来的，不能把安全性寄托在解压器默认值上。
export function assertSafeEntries(lines) {
  for (const raw of lines) {
    const entry = raw.replace(/^\.\//, "").replace(/\/$/, "");
    if (!entry) continue;
    const norm = entry.split("/").join("\\").toLowerCase();
    if (norm === ".." || norm.startsWith("..\\") || norm.includes("\\..\\") || /^[a-z]:\\/.test(norm) || norm.startsWith("\\\\")) {
      return { ok: false, error: `压缩包里有不安全的条目路径：${entry}` };
    }
  }
  return { ok: true };
}

function runTar(tarPath, args, { spawnFn, timeoutMs = 120000 }) {
  return new Promise((resolvePromise, rejectPromise) => {
    if (!existsSync(tarPath)) {
      rejectPromise(new Error(`无法打包：未找到 ${tarPath}（Windows 10 1803+ 自带 bsdtar）`));
      return;
    }
    let child;
    try {
      child = spawnFn(tarPath, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], shell: false });
    } catch (error) {
      rejectPromise(error);
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (c) => (stdout += c));
    child.stderr?.on("data", (c) => (stderr += c));
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      rejectPromise(new Error(`打包或解包超过 ${timeoutMs}ms 未结束`));
    }, timeoutMs);
    child.on("error", (error) => { clearTimeout(timer); rejectPromise(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise({ stdout, stderr });
      else rejectPromise(new Error(`bsdtar 退出码 ${code}：${stderr.trim() || stdout.trim() || "无输出"}`));
    });
  });
}

export function createDataBundleService({
  base = process.env,
  root = relayDataRoot(base),
  paths = storePaths(root),
  settingsPath = defaultSettingsPath(base),
  promptsJsonPath = promptsPath(base),
  skillsCfg = loadSkillsConfig({ base }),
  tarPath = DEFAULT_TAR,
  spawnFn = spawn,
  protect = defaultProtect,
  unprotect = defaultUnprotect,
  now = () => Date.now(),
  timeoutMs = 120000,
} = {}) {
  const tickets = new Map();
  sweepStaleStaging(now);

  // 上一次进程被杀时留下的暂存目录，这一次的票据表里已经没有指针了；建服务时按
  // 有效期扫一遍。只看自己的前缀、只删超过 TTL 的——正在被别的预览用的目录 mtime
  // 是新的，动不到；清不动也不该影响任何一次导出导入。
  function sweepStaleStaging(nowFn) {
    try {
      const cutoff = nowFn() - TICKET_TTL_MS;
      for (const name of readdirSync(tmpdir())) {
        if (!name.startsWith("anyswitch-import-") && !name.startsWith("anyswitch-export-")) continue;
        const abs = join(tmpdir(), name);
        try {
          if (statSync(abs).mtimeMs > cutoff) continue;
        } catch {
          continue;
        }
        rmSafe(abs);
      }
    } catch { /* 暂存清理是顺带的事 */ }
  }

  function newStaging(reason) {
    return mkdtempSync(join(tmpdir(), `anyswitch-${reason}-`));
  }

  function issueTicket(dir, summary, credentialEntries) {
    sweepExpiredTickets();
    const token = `t${tickets.size + 1}-${now().toString(36)}`;
    tickets.set(token, { dir, summary, credentialEntries, expiresAt: now() + TICKET_TTL_MS });
    return token;
  }

  // 票据有效期只是"还能不能落定"的判据，不是清理保证：被弃用的预览（用户看完
  // 摘要就关页面、换包、放弃导入）自己不会回来取，暂存目录就一直躺在 %TEMP%。
  // 每次新建票据时顺手扫一遍，最坏情况是再等一次预览。
  function sweepExpiredTickets() {
    const cutoff = now();
    for (const [token, t] of [...tickets]) {
      if (cutoff <= t.expiresAt) continue;
      tickets.delete(token);
      rmSafe(t.dir);
    }
  }

  function takeTicket(token) {
    const t = tickets.get(String(token ?? ""));
    if (!t) return { ok: false, error: "导入确认已过期或无效，请重新选择导出包" };
    tickets.delete(String(token));
    if (now() > t.expiresAt || !existsSync(t.dir)) {
      rmSafe(t.dir);
      return { ok: false, error: "导入确认已过期，请重新选择导出包" };
    }
    return { ok: true, ticket: t };
  }

  // ── 导出 ─────────────────────────────────────────────────
  async function exportBundle({ targetDir }) {
    if (!targetDir || !existsSync(targetDir) || !statSync(targetDir).isDirectory()) {
      return { ok: false, error: "导出目录不存在，请重新选择" };
    }
    // 明文密钥包绝不能落在 app/ 里：那是 git 工作树，而 .gitignore 只挡 *.dpapi。
    const appDir = resolve(paths.appDir).toLowerCase();
    const target = resolve(targetDir).toLowerCase();
    if (target === appDir || target.startsWith(appDir + "\\")) {
      return { ok: false, error: "导出位置不能在应用安装目录内，那里是代码仓库，含明文密钥的包会被误提交" };
    }

    const loaded = loadStore(paths);
    if (!loaded.ok) {
      return { ok: false, error: `当前渠道配置读不出来（${loaded.reason}），已停止导出` };
    }
    const store = loaded.store;

    const staging = newStaging("export");
    const zipPath = join(target, exportFileName(now()));
    try {
      writeFileSync(join(staging, "store.json"), loaded.text, "utf8");
      const settingsText = readTextIfExists(settingsPath);
      if (settingsText !== null) writeFileSync(join(staging, "settings.json"), settingsText, "utf8");
      const promptsText = readTextIfExists(promptsJsonPath);
      if (promptsText !== null) writeFileSync(join(staging, "prompts.json"), promptsText, "utf8");
      const skillsJsonText = readTextIfExists(skillsConfigPath(base));
      if (skillsJsonText !== null) writeFileSync(join(staging, "skills.json"), skillsJsonText, "utf8");

      const skillsSource = skillsCfg?.repoPath || null;
      const skillDirs = topLevelDirs(skillsSource);
      if (skillDirs.length) {
        copyTree(skillsSource, join(staging, SKILLS_DIR_NAME));
      }

      const credentials = [];
      const skippedCredentials = [];
      for (const [providerId, provider] of Object.entries(store.providers)) {
        const credentialFile = provider?.credentialFile;
        if (typeof credentialFile !== "string" || !credentialFile) continue;
        const cipherPath = join(paths.credentialsDir, credentialFile);
        if (!existsSync(cipherPath)) { skippedCredentials.push({ providerId, reason: "本机没有该渠道的密钥文件" }); continue; }
        let ciphertext = null;
        try {
          ciphertext = readFileSync(cipherPath);
          const plaintext = await unprotect(ciphertext, providerId);
          credentials.push({ providerId, credentialFile, plaintextBase64: Buffer.from(plaintext).toString("base64") });
        } catch {
          skippedCredentials.push({ providerId, reason: "本机解不开该密钥" });
        } finally {
          ciphertext?.fill?.(0);
        }
      }
      writeFileSync(join(staging, CREDENTIALS_NAME), JSON.stringify({ entries: credentials }, null, 2) + "\n", "utf8");

      const manifest = {
        format: BUNDLE_FORMAT,
        storeVersion: store.version,
        createdAt: new Date(now()).toISOString(),
        source: { computerName: hostnameSafe(), repoPathOfSkills: skillsSource },
        includes: {
          store: true,
          settings: settingsText !== null,
          prompts: promptsText !== null,
          skills: skillDirs.length > 0,
        },
        counts: {
          providers: Object.keys(store.providers).length,
          pools: Object.keys(store.pools ?? {}).length,
          routingChains: Object.keys(store.routingChains ?? {}).length,
          presets: promptsText === null ? 0 : countPresets(promptsText),
          skillDirs: skillDirs.length,
          credentials: credentials.length,
          credentialsSkipped: skippedCredentials.length,
        },
        skippedCredentials,
        notice: "本包含明文 API 密钥。导入完成后请删除此文件。",
      };
      writeFileSync(join(staging, MANIFEST_NAME), JSON.stringify(manifest, null, 2) + "\n", "utf8");

      await runTar(tarPath, ["--format=zip", "-cf", zipPath, "-C", staging, "."], { spawnFn, timeoutMs });
      return { ok: true, path: zipPath, sizeBytes: statSync(zipPath).size, counts: manifest.counts, skippedCredentials: manifest.skippedCredentials };
    } finally {
      rmSafe(staging);
    }
  }

  // ── 导入预览 ─────────────────────────────────────────────
  async function previewBundle(zipPath) {
    if (!zipPath || !/\.zip$/i.test(zipPath)) return { ok: false, error: "只能选择 .zip 导出包" };
    if (!existsSync(zipPath) || !statSync(zipPath).isFile()) return { ok: false, error: "所选文件不存在" };

    const listed = await runTar(tarPath, ["-tf", zipPath], { spawnFn, timeoutMs });
    const safety = assertSafeEntries(listed.stdout.split(/\r?\n/));
    if (!safety.ok) return { ok: false, error: safety.error };

    const staging = newStaging("import");
    try {
      await runTar(tarPath, ["-xf", zipPath, "-C", staging], { spawnFn, timeoutMs });
      const checked = inspectBundle(staging);
      if (!checked.ok) { rmSafe(staging); return { ok: false, error: checked.error }; }
      // 解包一落地，明文密钥就在 %TEMP% 里了。读进票据内存、把盘上这份立刻删掉：
      // 用户看完摘要放弃导入时，Temp 里剩下的只是渠道、预设这些不含密钥的部分。
      const credentialEntries = liftCredentialsOut(staging);
      const token = issueTicket(staging, checked.summary, credentialEntries);
      return { ok: true, token, ...checked.summary };
    } catch (error) {
      rmSafe(staging);
      throw error;
    }
  }

  function inspectBundle(dir) {
    const manifestText = readTextIfExists(join(dir, MANIFEST_NAME));
    if (manifestText === null) return { ok: false, error: "包里缺 manifest.json，不像 anyswitch 导出包" };
    let manifest;
    try {
      manifest = JSON.parse(manifestText);
    } catch {
      return { ok: false, error: "包里的 manifest.json 不是合法 JSON" };
    }
    if (manifest?.format !== BUNDLE_FORMAT) {
      return { ok: false, error: `包格式版本 ${manifest?.format ?? "未知"}，当前程序只认 ${BUNDLE_FORMAT}` };
    }
    const storeText = readTextIfExists(join(dir, "store.json"));
    if (storeText === null) return { ok: false, error: "包里缺 store.json" };
    let parsedStore;
    try {
      parsedStore = JSON.parse(storeText);
    } catch {
      return { ok: false, error: "包里的 store.json 不是合法 JSON" };
    }
    const valid = validateStore(parsedStore);
    if (!valid.valid) {
      return { ok: false, error: `包里的渠道配置不合法：${(valid.errors ?? []).slice(0, 3).join("；") || "校验未通过"}` };
    }
    if (parsedStore.version !== 2) {
      return { ok: false, error: `包里渠道配置的版本是 ${parsedStore.version}，本程序只接受 2` };
    }
    let credentials = { entries: [] };
    const credText = readTextIfExists(join(dir, CREDENTIALS_NAME));
    if (credText !== null) {
      try {
        credentials = JSON.parse(credText);
      } catch {
        return { ok: false, error: "包里的 credentials.json 不是合法 JSON" };
      }
      if (!Array.isArray(credentials?.entries)) return { ok: false, error: "包里的 credentials.json 缺 entries 数组" };
    }
    const skillDirs = topLevelDirs(join(dir, SKILLS_DIR_NAME));
    const promptsText = readTextIfExists(join(dir, "prompts.json"));
    return {
      ok: true,
      summary: {
        createdAt: manifest.createdAt ?? null,
        sourceComputer: manifest.source?.computerName ?? null,
        storeVersion: parsedStore.version,
        counts: {
          providers: Object.keys(parsedStore.providers ?? {}).length,
          pools: Object.keys(parsedStore.pools ?? {}).length,
          routingChains: Object.keys(parsedStore.routingChains ?? {}).length,
          presets: promptsText === null ? 0 : countPresets(promptsText),
          skillDirs: skillDirs.length,
          credentials: credentials.entries.length,
        },
        includes: {
          settings: readTextIfExists(join(dir, "settings.json")) !== null,
          prompts: promptsText !== null,
          skills: skillDirs.length > 0,
        },
        skillsSourcePath: manifest.source?.repoPathOfSkills ?? null,
        hasPlaintextKeys: credentials.entries.length > 0,
      },
    };
  }

  // ── 导入落定 ─────────────────────────────────────────────
  async function applyBundle({ token, skillsRepoPath }) {
    const got = takeTicket(token);
    if (!got.ok) return { ok: false, error: got.error };
    const { dir } = got.ticket;
    try {
      const checked = inspectBundle(dir);
      if (!checked.ok) return { ok: false, error: checked.error };
      const store = JSON.parse(readFileSync(join(dir, "store.json"), "utf8"));

      const backupId = stamp(now());
      const backupDir = join(paths.root, "backups", `pre-import-${backupId}`);
      const saved = [];
      mkdirSync(backupDir, { recursive: true });
      for (const name of CONFIG_FILES) {
        const src = name === "settings.json" ? settingsPath : name === "prompts.json" ? promptsJsonPath : name === "skills.json" ? skillsConfigPath(base) : paths.storeFile;
        if (existsSync(src)) { cpSync(src, join(backupDir, name)); saved.push(name); }
      }
      if (existsSync(paths.credentialsDir)) {
        cpSync(paths.credentialsDir, join(backupDir, "credentials"), { recursive: true });
        saved.push("credentials/");
      }
      writeFileSync(join(backupDir, MANIFEST_NAME), JSON.stringify({ backupId, createdAt: new Date(now()).toISOString(), saved }, null, 2) + "\n", "utf8");

      const written = writeStore(store, { paths });
      if (!written.ok) {
        return { ok: false, error: `渠道配置写入被拒（${written.reason}），当前数据未改动；备份在 ${backupDir}`, backupId };
      }

      const applied = { store: true, settings: false, prompts: false, skills: false, credentials: 0, credentialFailures: [] };
      const settingsText = readTextIfExists(join(dir, "settings.json"));
      if (settingsText !== null) {
        atomicWriteFile(settingsPath, settingsText);
        applied.settings = true;
        // followAgent 不只是盘上一个字段：它背后挂着登录计划 AnyswitchWatchdog
        // 和常驻自愈进程，而那串副作用归设置路由所有，导入绕开了它。把刚写进盘
        // 的值原样交回调用方对齐。解析不成按关处理——坏文件经 loadSettings 就是
        // 空对象，读出来同样是关，两边不能给出不一致的答复。
        try {
          applied.followAgent = JSON.parse(settingsText)?.followAgent === true;
        } catch {
          applied.followAgent = false;
        }
      }
      const promptsText = readTextIfExists(join(dir, "prompts.json"));
      if (promptsText !== null) { atomicWriteFile(promptsJsonPath, promptsText); applied.prompts = true; }

      // 预览阶段已经把明文密钥从暂存里摘走、放进票据内存（见 liftCredentialsOut）；
      // 只有票据由外部直接构造（测试替身）时才可能还得读盘。两边都没有，就当我
      // 这个包不含密钥。
      const entries = got.ticket.credentialEntries
        ?? JSON.parse(readTextIfExists(join(dir, CREDENTIALS_NAME)) ?? '{"entries":[]}').entries
        ?? [];
      if (entries.length) {
        mkdirSync(paths.credentialsDir, { recursive: true });
        for (const entry of entries) {
          const plaintext = Buffer.from(String(entry.plaintextBase64 ?? ""), "base64");
          try {
            const ciphertext = await protect(plaintext, entry.providerId);
            atomicWriteFile(join(paths.credentialsDir, entry.credentialFile), ciphertext);
            applied.credentials += 1;
          } catch {
            applied.credentialFailures.push(entry.providerId);
          } finally {
            plaintext.fill(0);
          }
        }
      }

      const bundledSkills = join(dir, SKILLS_DIR_NAME);
      const skillDirs = topLevelDirs(bundledSkills);
      if (skillDirs.length) {
        const target = (skillsRepoPath && String(skillsRepoPath).trim()) || got.ticket.summary.skillsSourcePath;
        if (!target) {
          applied.skillsSkippedReason = "包里带了 Skills 目录，但目标位置为空，未落盘";
        } else {
          mkdirSync(target, { recursive: true });
          copyTree(bundledSkills, target);
          saveSkillsConfig({ repoPath: target }, { base });
          applied.skills = true;
          applied.skillsTarget = target;
          applied.skillDirs = skillDirs.length;
        }
      }

      return { ok: true, backupId, backupDir, applied, counts: got.ticket.summary.counts };
    } finally {
      rmSafe(dir);
    }
  }

  // 面板宿主退出时调用（见 panel-host.mjs 的 shutdown）：把还攥着明文密钥内存副本
  // 与暂存目录的票据一次清掉。进程不退出，弃用的票据就靠 sweepExpiredTickets 扫。
  function dropAllTickets() {
    for (const [, t] of tickets) rmSafe(t.dir);
    tickets.clear();
  }

  return { exportBundle, previewBundle, applyBundle, inspectBundle, dropAllTickets, paths };
}

function rmSafe(dir) {
  if (!dir) return;
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  } catch { /* 清理失败不能把一次成功的导入报成失败 */ }
}

function hostnameSafe() {
  try {
    return hostname() || process.env.COMPUTERNAME || null;
  } catch {
    return process.env.COMPUTERNAME ?? null;
  }
}
