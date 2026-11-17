// claude-merge-config 单元测试：Claude Desktop 3p 配置密钥保鲜写手的守卫矩阵。
// 覆盖面＝目录缺席/无归属配置/守卫三条/密钥相同 no-op/过期改写＋备份＋字段保真/
// 坏 JSON 不覆写/注册表与备份文件不进扫描面/token 缺失。协调器层的接线与摘要
// 归属在 agent-sync.test.mjs（安装闸门区）另有集成用例。

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  writeClaudeDesktopConfig,
  claudeDesktopProfileDir,
  claudeProfileFiles,
  profileTargetsRelay,
} from "../src/launchers/claude-merge-config.mjs";
import { mkTestDir } from "../test-helpers/tmp.mjs";

describe("claude-merge-config", () => {
  let tmpRoot;
  let dir;
  let logs;

  beforeEach(() => {
    tmpRoot = mkTestDir("claude-merge-config-test-");
    dir = join(tmpRoot, "Claude-3p", "configLibrary");
    logs = [];
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  const log = {
    info: (m) => logs.push(["info", m]),
    warn: (m) => logs.push(["warn", m]),
    error: (m) => logs.push(["error", m]),
  };

  function writeProfile(name, fields) {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, name);
    writeFileSync(path, JSON.stringify({
      inferenceProvider: "gateway",
      inferenceGatewayBaseUrl: "http://127.0.0.1:47821",
      inferenceGatewayApiKey: "stale-generation-token",
      inferenceGatewayAuthScheme: "bearer",
      inferenceModels: [],
      inferenceCustomHeaders: { "x-agent-id": "claude" },
      ...fields,
    }, null, "\t"));
    return path;
  }

  it("目录不存在：未接入跳过，不新建任何文件", () => {
    const res = writeClaudeDesktopConfig(47821, "current-token", dir, { log });
    assert.deepEqual(res, { ok: true, unchanged: true, notInstalled: true });
    assert.equal(existsSync(dir), false, "不建目录");
  });

  it("空目录与无归属配置：都按未接入跳过", () => {
    mkdirSync(dir, { recursive: true });
    assert.deepEqual(
      writeClaudeDesktopConfig(47821, "current-token", dir, { log }),
      { ok: true, unchanged: true, notInstalled: true },
      "空目录没有可刷新对象",
    );
    writeProfile("foreign.json", {
      inferenceProvider: "anthropic",
      inferenceGatewayBaseUrl: undefined,
    });
    assert.deepEqual(
      writeClaudeDesktopConfig(47821, "current-token", dir, { log }),
      { ok: true, unchanged: true, notInstalled: true },
      "非 gateway 配置不属于本 relay",
    );
    writeProfile("remote.json", { inferenceGatewayBaseUrl: "https://api.example.com/v1" });
    writeProfile("wrong-port.json", { inferenceGatewayBaseUrl: "http://127.0.0.1:47899" });
    assert.deepEqual(
      writeClaudeDesktopConfig(47821, "current-token", dir, { log }),
      { ok: true, unchanged: true, notInstalled: true },
      "公网域名与错端口都不是保鲜对象",
    );
    for (const name of ["foreign.json", "remote.json", "wrong-port.json"]) {
      const profile = JSON.parse(readFileSync(join(dir, name), "utf8"));
      assert.equal(profile.inferenceGatewayApiKey, "stale-generation-token", `${name} 原样不动`);
    }
  });

  it("密钥已是现行代次：no-op，不写不备份", () => {
    const path = writeProfile("11111111-2222-4333-8444-555555555555.json", {
      inferenceGatewayApiKey: "current-token",
    });
    const before = readFileSync(path, "utf8");
    const res = writeClaudeDesktopConfig(47821, "current-token", dir, { log });
    assert.equal(res.ok, true);
    assert.equal(res.unchanged, true);
    assert.equal(existsSync(`${path}.bak-anys`), false, "不改就不备份");
    assert.equal(readFileSync(path, "utf8"), before, "文件一字不动");
  });

  it("过期密钥：重指现行 token，留滚动备份，字段保真", () => {
    const path = writeProfile("11111111-2222-4333-8444-555555555555.json", {
      inferenceModels: [{ name: "claude-sonnet-4-5", anthropicFamilyTier: "sonnet" }],
    });
    const res = writeClaudeDesktopConfig(47821, "current-token", dir, { log });
    assert.equal(res.ok, true);
    assert.equal(res.unchanged, false);
    assert.equal(res.refreshed, 1);
    assert.deepEqual(res.backupPaths, [`${path}.bak-anys`]);
    const profile = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(profile.inferenceGatewayApiKey, "current-token");
    assert.equal(profile.inferenceGatewayBaseUrl, "http://127.0.0.1:47821");
    assert.equal(profile.inferenceGatewayAuthScheme, "bearer");
    assert.deepEqual(profile.inferenceModels, [{ name: "claude-sonnet-4-5", anthropicFamilyTier: "sonnet" }]);
    assert.deepEqual(profile.inferenceCustomHeaders, { "x-agent-id": "claude" });
    assert.match(readFileSync(path, "utf8"), /\n\t"inferenceProvider": "gateway"/, "写回沿用 tab 缩进");
    const backup = JSON.parse(readFileSync(`${path}.bak-anys`, "utf8"));
    assert.equal(backup.inferenceGatewayApiKey, "stale-generation-token", "备份是改写前的原文");
    assert.ok(logs.some(([level, m]) => level === "info" && m.includes("refreshed")), "改写有一条 info 日志");
  });

  it("localhost 与 ::1 也算环回；多份配置只刷新指向本 relay 的那几份", () => {
    writeProfile("a-localhost.json", { inferenceGatewayBaseUrl: "http://localhost:47821" });
    writeProfile("b-ipv6.json", { inferenceGatewayBaseUrl: "http://[::1]:47821" });
    writeProfile("c-foreign.json", { inferenceGatewayBaseUrl: "https://api.example.com/v1" });
    const res = writeClaudeDesktopConfig(47821, "current-token", dir, { log });
    assert.equal(res.ok, true);
    assert.equal(res.refreshed, 2, "localhost 与 IPv6 各一份，公网那份不动");
    assert.equal(JSON.parse(readFileSync(join(dir, "a-localhost.json"), "utf8")).inferenceGatewayApiKey, "current-token");
    assert.equal(JSON.parse(readFileSync(join(dir, "b-ipv6.json"), "utf8")).inferenceGatewayApiKey, "current-token");
    assert.equal(JSON.parse(readFileSync(join(dir, "c-foreign.json"), "utf8")).inferenceGatewayApiKey, "stale-generation-token");
  });

  it("坏 JSON 不覆写：warn 一条，整体仍算成功", () => {
    const path = writeProfile("broken.json");
    writeFileSync(path, "{ not json");
    const res = writeClaudeDesktopConfig(47821, "current-token", dir, { log });
    assert.equal(res.ok, true);
    assert.equal(readFileSync(path, "utf8"), "{ not json", "读不出就写不回，一字不动");
    assert.ok(logs.some(([level, m]) => level === "warn" && m.includes("unparseable")), "坏文件有 warn 日志");
  });

  it("注册表与备份文件不进扫描面：不会被当成配置重写", () => {
    const path = writeProfile("11111111-2222-4333-8444-555555555555.json");
    writeFileSync(join(dir, "_meta.json"), JSON.stringify({ appliedId: "x", entries: [] }));
    // 备份内容同样过 gateway 守卫且密钥过期——不排除就会无限重写备份自己。
    writeFileSync(`${path}.bak-anys-20260930`, readFileSync(path, "utf8"));
    const res = writeClaudeDesktopConfig(47821, "current-token", dir, { log });
    assert.equal(res.refreshed, 1, "只刷新主配置一份");
    assert.equal(JSON.parse(readFileSync(`${path}.bak-anys-20260930`, "utf8")).inferenceGatewayApiKey, "stale-generation-token", "备份不被重写");
    assert.equal(JSON.parse(readFileSync(join(dir, "_meta.json"), "utf8")).appliedId, "x", "注册表不被重写");
  });

  it("token 缺失：端点级失败，不带原因不上成功面", () => {
    const res = writeClaudeDesktopConfig(47821, "", dir, { log });
    assert.equal(res.ok, false);
    assert.ok(typeof res.reason === "string" && res.reason.length > 0);
  });

  it("目录读不出来：端点级失败带原因", () => {
    // 用一个文件顶住 configLibrary 目录：readdirSync 落 ENOTDIR。
    mkdirSync(join(tmpRoot, "Claude-3p"), { recursive: true });
    writeFileSync(dir, "not a dir");
    const res = writeClaudeDesktopConfig(47821, "current-token", dir, { log });
    assert.equal(res.ok, false);
    assert.match(res.reason, /configLibrary/);
  });
});

describe("claude-merge-config 纯函数", () => {
  it("claudeProfileFiles：只收 JSON，排除注册表与任何备份形态", () => {
    assert.deepEqual(
      claudeProfileFiles([
        "11111111-2222-4333-8444-555555555555.json",
        "_meta.json",
        "11111111-2222-4333-8444-555555555555.json.bak-anys",
        "notes.txt",
        "profile.bak-20260930.json",
      ]),
      ["11111111-2222-4333-8444-555555555555.json"],
    );
  });

  it("profileTargetsRelay：gateway＋环回＋本端口三条全过才认", () => {
    const profile = (fields) => ({ inferenceProvider: "gateway", inferenceGatewayBaseUrl: "http://127.0.0.1:47821", ...fields });
    assert.equal(profileTargetsRelay(profile({}), 47821), true);
    assert.equal(profileTargetsRelay(profile({ inferenceGatewayBaseUrl: "http://localhost:47821" }), 47821), true);
    assert.equal(profileTargetsRelay(profile({ inferenceGatewayBaseUrl: "http://127.0.0.1:47821" }), 47899), false, "端口不对不是本 relay");
    assert.equal(profileTargetsRelay(profile({ inferenceGatewayBaseUrl: "https://api.example.com" }), 443), false, "公网域名不认");
    assert.equal(profileTargetsRelay(profile({ inferenceProvider: "anthropic" }), 47821), false, "非 gateway 不认");
    assert.equal(profileTargetsRelay(profile({ inferenceGatewayBaseUrl: "not a url" }), 47821), false, "坏 URL 不认");
    assert.equal(profileTargetsRelay(profile({ inferenceGatewayBaseUrl: undefined }), 47821), false, "缺 baseUrl 不认");
    assert.equal(profileTargetsRelay(null, 47821), false);
    assert.equal(profileTargetsRelay([1, 2], 47821), false);
    assert.equal(profileTargetsRelay("string", 47821), false);
  });

  it("claudeDesktopProfileDir：LOCALAPPDATA 缺席时回落 USERPROFILE 拼装", () => {
    assert.equal(
      claudeDesktopProfileDir({ LOCALAPPDATA: "C:\\L", USERPROFILE: "C:\\U" }),
      join("C:\\L", "Claude-3p", "configLibrary"),
    );
    assert.equal(
      claudeDesktopProfileDir({ USERPROFILE: "C:\\U" }),
      join("C:\\U", "AppData", "Local", "Claude-3p", "configLibrary"),
    );
    assert.equal(
      claudeDesktopProfileDir({}),
      join("AppData", "Local", "Claude-3p", "configLibrary"),
      "全缺失时是相对路径，由协调器的绝对路径闸门判失败",
    );
  });
});
