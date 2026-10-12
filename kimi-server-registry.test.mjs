import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  KIMI_REGISTRY_HEARTBEAT_MAX_AGE_MS,
  resolveKimiCodeHome,
  kimiServerInstancesDir,
  decodeKimiServerInstance,
  readKimiServerInstances,
} from "./kimi-server-registry.mjs";

// 本机 2026-09-23 桌面端真实跑过一轮后留下的那条登记，逐字段照抄。
const REAL_ROW = '{"server_id":"01M3628YJKJ9Q8HXYAXA98HV8D","pid":21460,"host":"127.0.0.1","port":7457,"started_at":1790131337810,"heartbeat_at":1790131653029,"host_version":"2.0.1"}';

test("home resolution follows the client's own order: env first, then ~/.kimi-code", () => {
  const home = () => "C:\\Users\\fixture";
  assert.equal(resolveKimiCodeHome({ KIMI_CODE_HOME: "D:\\kimi-home" }, home), "D:\\kimi-home");
  assert.equal(resolveKimiCodeHome({ KIMI_CODE_HOME: "  " }, home), join("C:\\Users\\fixture", ".kimi-code"));
  assert.equal(resolveKimiCodeHome({}, home), join("C:\\Users\\fixture", ".kimi-code"));
  assert.equal(kimiServerInstancesDir("D:\\kimi-home"), join("D:\\kimi-home", "server", "instances"));
});

test("a real desktop registration decodes into pid / port / heartbeat / core version", () => {
  assert.deepEqual(decodeKimiServerInstance(REAL_ROW), {
    pid: 21460,
    port: 7457,
    heartbeatAt: 1790131653029,
    hostVersion: "2.0.1",
  });
});

test("host_version is optional (the field the client itself writes conditionally)", () => {
  const row = '{"server_id":"S","pid":7,"port":7457,"started_at":1,"heartbeat_at":2}';
  assert.deepEqual(decodeKimiServerInstance(row), { pid: 7, port: 7457, heartbeatAt: 2, hostVersion: null });
});

test("unreadable rows decode to null instead of guessing a face", () => {
  assert.equal(decodeKimiServerInstance("not json"), null);
  assert.equal(decodeKimiServerInstance(""), null);
  assert.equal(decodeKimiServerInstance("[]"), null);
  assert.equal(decodeKimiServerInstance("null"), null);
  assert.equal(decodeKimiServerInstance('{"pid":0,"heartbeat_at":1}'), null);
  assert.equal(decodeKimiServerInstance('{"pid":-9,"heartbeat_at":1}'), null);
  assert.equal(decodeKimiServerInstance('{"pid":"21460","heartbeat_at":1}'), null);
  // 没有心跳的旧形态（pre-0.28 daemon 的 server/lock 不是这个形状）读不出时效，
  // 也就没有任何资格把一个进程号标成 web。
  assert.equal(decodeKimiServerInstance('{"pid":11,"port":7457}'), null);
  assert.equal(decodeKimiServerInstance('{"pid":11,"heartbeat_at":0}'), null);
  assert.deepEqual(decodeKimiServerInstance('{"pid":11,"heartbeat_at":1,"port":"x"}'), {
    pid: 11, port: null, heartbeatAt: 1, hostVersion: null,
  });
});

// 每个用例都显式给 KIMI_CODE_HOME：不读 process.env，免得真机上的同名变量改判。
const ENV = { KIMI_CODE_HOME: "C:\\Users\\fixture\\.kimi-code" };
const DIR = kimiServerInstancesDir(ENV.KIMI_CODE_HOME);

function fakeIo(files, { throwOnReaddir = false, throwOnReadFor = () => false } = {}) {
  return {
    readdir: async (target) => {
      if (target !== DIR) throw new Error(`unexpected dir ${target}`);
      if (throwOnReaddir) throw new Error("EACCES");
      return Object.keys(files);
    },
    readFile: async (target) => {
      const name = target.slice(DIR.length + 1);
      if (throwOnReadFor(name)) throw new Error("EIO");
      if (!(name in files)) throw new Error("ENOENT");
      return files[name];
    },
  };
}

test("missing directory, unreadable directory and unreadable files all degrade to empty", async () => {
  const now = 1790131653029 + 1000;
  const missing = await readKimiServerInstances({
    env: { KIMI_CODE_HOME: "D:\\nowhere" },
    nowFn: () => now,
    io: { readdir: async () => { throw new Error("ENOENT"); }, readFile: async () => "" },
  });
  assert.equal(missing.size, 0);

  const noPermission = await readKimiServerInstances({ env: ENV, nowFn: () => now, io: fakeIo({}, { throwOnReaddir: true }) });
  assert.equal(noPermission.size, 0);

  const brokenFile = await readKimiServerInstances({
    env: ENV,
    nowFn: () => now,
    io: fakeIo({ "A.json": REAL_ROW, "B.json": "{half-written" }, { throwOnReadFor: (n) => n === "C.json" }),
  });
  assert.deepEqual([...brokenFile.keys()], [21460]);
});

test("only .json files are considered, and stale heartbeats are dropped", async () => {
  const now = 1790131653029;
  const io = fakeIo({
    "A.json": REAL_ROW,
    "README.txt": '{"pid":99,"heartbeat_at":' + now + "}",
    "stale.json": '{"pid":123,"heartbeat_at":' + (now - KIMI_REGISTRY_HEARTBEAT_MAX_AGE_MS - 1) + "}",
    "fresh.json": '{"pid":456,"heartbeat_at":' + (now - KIMI_REGISTRY_HEARTBEAT_MAX_AGE_MS + 1000) + "}",
  });
  const found = await readKimiServerInstances({ env: ENV, nowFn: () => now, io });
  assert.deepEqual([...found.keys()].sort((a, b) => a - b), [456, 21460]);
});

test("a recycled pid keeps the fresher of two registrations", async () => {
  const now = 1790131653029;
  const io = fakeIo({
    "old.json": `{"pid":500,"port":7450,"heartbeat_at":${now - 60000},"host_version":"2.0.0"}`,
    "new.json": `{"pid":500,"port":7457,"heartbeat_at":${now},"host_version":"2.0.1"}`,
  });
  const found = await readKimiServerInstances({ env: ENV, nowFn: () => now, io });
  assert.equal(found.size, 1);
  assert.equal(found.get(500).port, 7457);
  assert.equal(found.get(500).hostVersion, "2.0.1");
});

test("the window tracks the client's own heartbeat cadence: a beating row counts, a row left by an app that exited three minutes ago does not", async () => {
  // 15 秒是客户端安装包里的默认心跳间隔（createInstanceRegistry），每拍重写一次
  // 自己的登记，与有没有活动无关。所以一个还活着的 server 的 heartbeat_at 永远
  // 只有一拍老；反过来，退出时不删档的那条路（真机桌面端 2026-09-23 12:55 那次）
  // 留下的残档会立刻停止前进。窗口取几拍 = 90 秒：余量给唤醒与慢盘，上限压住
  // 「进程号被新起的 kimi 复用、残档替它冒充另一张面」。这两个界把常量的取值
  // 理由钉在客户端节律上，而不是任一个数字。
  const CLIENT_HEARTBEAT_MS = 15_000;
  assert.ok(KIMI_REGISTRY_HEARTBEAT_MAX_AGE_MS >= 4 * CLIENT_HEARTBEAT_MS, "窗口要容得下漏写几拍");
  assert.ok(KIMI_REGISTRY_HEARTBEAT_MAX_AGE_MS <= 8 * CLIENT_HEARTBEAT_MS, "窗口不能长到让残档顶面");

  const now = 1790131653029;
  const io = fakeIo({
    "beating.json": `{"pid":700,"port":58627,"heartbeat_at":${now - CLIENT_HEARTBEAT_MS}}`,
    "leftover.json": `{"pid":701,"port":9600,"heartbeat_at":${now - 3 * 60 * 1000}}`,
  });
  const found = await readKimiServerInstances({ env: ENV, nowFn: () => now, io });
  assert.deepEqual([...found.keys()], [700], "刚写过心跳的算一条，三分钟前的残档不算");
});
