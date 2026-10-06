import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import {
  readSyncStatus,
  syncStatusFromResult,
  syncStatusPath,
  writeSyncStatus,
  SYNC_STATUS_FILENAME,
} from "./sync-status.mjs";
import { SYNC_RESULT_PREFIX } from "./agent-sync.mjs";
import { mkTestDir } from "./test-helpers/tmp.mjs";

const summaryLine = (payload) => `${SYNC_RESULT_PREFIX}${JSON.stringify(payload)}`;

describe("sync-status 落盘与读取", () => {
  it("write/read roundtrip：写出的状态原样读回，含可选 error", () => {
    const root = mkTestDir("sync-status-roundtrip-");
    const status = {
      at: "2026-10-06T01:02:03.456Z",
      ok: false,
      failed: ["kimi", "codex"],
      synced: ["zcode", "dsh"],
      error: "runner exit 1",
      source: "store-change",
    };
    writeSyncStatus(root, status);
    assert.deepEqual(readSyncStatus(root), status);
  });

  it("文件缺失返回 null（「无从报告」，不抛错）", () => {
    const root = mkTestDir("sync-status-missing-");
    assert.equal(readSyncStatus(root), null);
  });

  it("JSON 损坏返回 null，不得抛给路由层", () => {
    const root = mkTestDir("sync-status-corrupt-");
    writeFileSync(syncStatusPath(root), "{ not json", "utf8");
    assert.equal(readSyncStatus(root), null);
  });

  it("形状不符（缺 at/ok）同样按 null 处理", () => {
    const root = mkTestDir("sync-status-shape-");
    writeFileSync(syncStatusPath(root), JSON.stringify({ hello: "world" }), "utf8");
    assert.equal(readSyncStatus(root), null);
  });
});

describe("syncStatusFromResult 映射", () => {
  it("全部端点成功：ok=true、failed 为空、synced 全名单", () => {
    const synced = ["zcode", "dsh", "pi", "kimi", "qoder", "codex", "opencode", "grok"];
    const result = { ok: true, code: 0, stdout: `${summaryLine({ ok: true, synced, failed: [] })}\n`, stderr: "" };
    const status = syncStatusFromResult(result, "startup");
    assert.equal(status.ok, true);
    assert.deepEqual(status.failed, []);
    assert.deepEqual(status.synced, synced);
    assert.equal(status.source, "startup");
    assert.equal(status.error, undefined);
    assert.ok(Number.isFinite(Date.parse(status.at)), "at 是可解析的 ISO 时间");
  });

  it("部分端点失败（退出码仍为 0）：ok=false、failed 点名、不带 error", () => {
    const result = {
      ok: true,
      code: 0,
      stdout: `${summaryLine({ ok: true, synced: ["zcode"], failed: ["kimi"] })}\n`,
      stderr: "",
    };
    const status = syncStatusFromResult(result, "store-change");
    assert.equal(status.ok, false);
    assert.deepEqual(status.failed, ["kimi"]);
    assert.deepEqual(status.synced, ["zcode"]);
    assert.equal(status.error, undefined);
  });

  it("进程级失败（无摘要行）：ok=false、failed 为空、error 带原因", () => {
    const byError = syncStatusFromResult(
      { ok: false, error: "spawn ENOENT", stdout: "", stderr: "" },
      "manual",
    );
    assert.equal(byError.ok, false);
    assert.deepEqual(byError.failed, []);
    assert.equal(byError.error, "spawn ENOENT");

    const byCode = syncStatusFromResult(
      { ok: false, code: 1, stdout: "", stderr: "[agent-sync] boom" },
      "settings",
    );
    assert.equal(byCode.ok, false);
    assert.equal(byCode.error, "runner exit 1");
  });

  it("摘要行报整体失败（store 读不出）：ok=false、failed 为空、error 兜底", () => {
    const result = {
      ok: false,
      code: 1,
      stdout: `${summaryLine({ ok: false, synced: [], failed: [] })}\n`,
      stderr: "",
    };
    const status = syncStatusFromResult(result, "startup");
    assert.equal(status.ok, false);
    assert.deepEqual(status.failed, []);
    assert.equal(status.error, "runner exit 1");
  });
});
