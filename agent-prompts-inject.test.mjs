import test, { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPromptsInjector,
  buildManagedBlock,
  applyManagedBlock,
  MANAGED_BEGIN,
  MANAGED_END,
  PROMPT_ENDPOINTS,
} from "./agent-prompts-inject.mjs";

// Injection plane: every injector runs against a temp fake home + fake
// %APPDATA% so real endpoint instruction files are never touched.

const tempDirs = [];

function makeInjector() {
  const root = mkdtempSync(join(tmpdir(), "anyswitch-inject-"));
  tempDirs.push(root);
  const homeDir = join(root, "home");
  const appData = join(root, "appdata");
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(appData, { recursive: true });
  return { injector: createPromptsInjector({ homeDir, appData, base: {} }), homeDir, appData };
}

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop(), { recursive: true, force: true });
});

const PRESET_A = { id: "aaaaaaaaaaaa", title: "规则A", tag: "", enabled: true, content: "先读文件再修改" };
const PRESET_B = { id: "bbbbbbbbbbbb", title: "规则B", tag: "", enabled: true, content: "第二行\n第三行" };

describe("agent-prompts-inject endpoint table", () => {
  it("covers all eight endpoints with verified targets", () => {
    const { injector, homeDir, appData } = makeInjector();
    const endpoints = injector.listEndpoints();
    assert.deepEqual(endpoints.map((e) => e.id), ["claude", "kimi", "zcode", "dsh", "pi", "opencode", "agy", "reasonix"]);
    const byId = Object.fromEntries(endpoints.map((e) => [e.id, e]));
    assert.equal(byId.claude.target, join(homeDir, ".claude", "CLAUDE.md"));
    assert.equal(byId.kimi.target, join(homeDir, ".kimi-code", "AGENTS.md"));
    assert.equal(byId.zcode.target, join(homeDir, ".zcode", "AGENTS.md"));
    assert.equal(byId.dsh.target, join(homeDir, ".dsh", "AGENTS.md"));
    assert.equal(byId.pi.target, join(homeDir, ".pi", "agent", "AGENTS.md"));
    assert.equal(byId.opencode.target, join(homeDir, ".config", "opencode", "AGENTS.md"));
    assert.equal(byId.agy.target, join(homeDir, ".gemini", "config", "GEMINI.md"));
    // reasonix lives under %APPDATA%, never homeDir-relative.
    assert.equal(byId.reasonix.target, join(appData, "reasonix", "AGENTS.md"));
    assert.equal(byId.kimi.hotReload, true);
    assert.equal(byId.opencode.hotReload, true);
    for (const id of ["claude", "zcode", "dsh", "pi", "agy", "reasonix"]) {
      assert.equal(byId[id].hotReload, false, id);
    }
    assert.equal(PROMPT_ENDPOINTS.length, 8);
  });
});

describe("agent-prompts-inject block rendering and application", () => {
  it("renders one ## title section per preset inside the managed markers", () => {
    const block = buildManagedBlock([PRESET_A, PRESET_B]);
    assert.equal(
      block,
      [MANAGED_BEGIN, "", "## 规则A", "", "先读文件再修改", "", "## 规则B", "", "第二行\n第三行", "", MANAGED_END].join("\n"),
    );
  });

  it("creates a missing file only when there is content to inject", () => {
    const { injector, homeDir } = makeInjector();
    const target = join(homeDir, ".claude", "CLAUDE.md");
    // Empty effective set on a missing file: nothing is created.
    assert.deepEqual(injector.syncEndpoint("claude", []), { ok: true, changed: false, target });
    assert.equal(existsSync(target), false);

    const result = injector.syncEndpoint("claude", [PRESET_A]);
    assert.equal(result.changed, true);
    const text = readFileSync(target, "utf8");
    assert.equal(text, `${buildManagedBlock([PRESET_A])}\n`);
  });

  it("appends below user content with a blank separator and removes byte-exactly", () => {
    const { injector, homeDir } = makeInjector();
    const target = join(homeDir, ".kimi-code", "AGENTS.md");
    mkdirSync(join(homeDir, ".kimi-code"), { recursive: true });
    const original = "# 用户自己的规则\n保持手写内容\n";
    writeFileSync(target, original, "utf8");

    injector.syncEndpoint("kimi", [PRESET_A]);
    const injected = readFileSync(target, "utf8");
    assert.equal(injected, `${original}\n${buildManagedBlock([PRESET_A])}\n`);

    injector.syncEndpoint("kimi", []);
    assert.equal(readFileSync(target, "utf8"), original, "inject → remove restores the original bytes");
  });

  it("deletes the file when it held only the managed block", () => {
    const { injector, homeDir } = makeInjector();
    const target = join(homeDir, ".zcode", "AGENTS.md");
    injector.syncEndpoint("zcode", [PRESET_A]);
    assert.equal(existsSync(target), true);
    const result = injector.syncEndpoint("zcode", []);
    assert.equal(result.removed, true);
    assert.equal(existsSync(target), false);
  });

  it("replaces an existing block in place, preserving content around it", () => {
    const { injector, homeDir } = makeInjector();
    const target = join(homeDir, ".dsh", "AGENTS.md");
    mkdirSync(join(homeDir, ".dsh"), { recursive: true });
    const head = "头部内容\n";
    const tail = "尾部内容\n";
    writeFileSync(target, `${head}\n${buildManagedBlock([PRESET_A])}\n${tail}`, "utf8");

    injector.syncEndpoint("dsh", [PRESET_B]);
    const text = readFileSync(target, "utf8");
    assert.equal(text, `${head}\n${buildManagedBlock([PRESET_B])}\n${tail}`);
  });

  it("is idempotent: an unchanged result is not written", () => {
    const { injector, homeDir } = makeInjector();
    const target = join(homeDir, ".pi", "agent", "AGENTS.md");
    assert.equal(injector.syncEndpoint("pi", [PRESET_A]).changed, true);
    const first = readFileSync(target, "utf8");
    const second = injector.syncEndpoint("pi", [PRESET_A]);
    assert.equal(second.changed, false);
    assert.equal(readFileSync(target, "utf8"), first);
  });

  it("a dangling begin marker swallows to EOF and is rewritten whole", () => {
    const { injector, homeDir } = makeInjector();
    const target = join(homeDir, ".config", "opencode", "AGENTS.md");
    mkdirSync(join(homeDir, ".config", "opencode"), { recursive: true });
    writeFileSync(target, `保留行\n${MANAGED_BEGIN}\n## 手改的内容\n被破坏的尾巴\n`, "utf8");

    injector.syncEndpoint("opencode", [PRESET_A]);
    assert.equal(readFileSync(target, "utf8"), `保留行\n${buildManagedBlock([PRESET_A])}\n`);

    // Removal with a dangling begin swallows to EOF too.
    writeFileSync(target, `保留行\n${MANAGED_BEGIN}\n手改区\n`, "utf8");
    injector.syncEndpoint("opencode", []);
    assert.equal(readFileSync(target, "utf8"), "保留行\n");
  });

  it("syncAll isolates per-endpoint failures", () => {
    const { injector, homeDir } = makeInjector();
    // Break claude: a regular file where its directory must be.
    writeFileSync(join(homeDir, ".claude"), "not a dir", "utf8");
    const results = injector.syncAll(() => [PRESET_A]);
    assert.equal(results.claude.ok, false);
    assert.match(results.claude.error, /.+/);
    for (const id of ["kimi", "zcode", "dsh", "pi", "opencode", "agy", "reasonix"]) {
      assert.deepEqual(results[id], { ok: true }, id);
    }
    // The healthy endpoints really were written.
    assert.equal(readFileSync(join(homeDir, ".kimi-code", "AGENTS.md"), "utf8").startsWith(MANAGED_BEGIN), true);
  });

  it("rejects an unknown endpoint id with a 400", () => {
    const { injector } = makeInjector();
    assert.throws(() => injector.syncEndpoint("ghost", []), (err) => err.statusCode === 400);
  });

  it("applyManagedBlock leaves a block-free file untouched on remove", () => {
    const text = "纯用户内容\n没有托管块\n";
    assert.equal(applyManagedBlock(text, null), text);
  });
});
