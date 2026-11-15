// 回环 NO_PROXY 单源护栏：全部 launcher 环境的 NO_PROXY/no_proxy 都必须取自
// launcher.mjs 的 LOOPBACK_NO_PROXY（中继流量绝不许经继承代理离开本机），
// 且 src 下不允许再长出内联副本——值一致靠 import 保证，不靠逐文件手抄。

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildLauncherEnv, LOOPBACK_NO_PROXY } from "../src/launchers/launcher.mjs";
import { buildKimiLauncherEnv } from "../src/launchers/kimi-launcher.mjs";
import { buildCodexLauncherEnv } from "../src/launchers/codex-launcher.mjs";
import { buildGrokLauncherEnv } from "../src/launchers/grok-launcher.mjs";
import { buildPiLauncherEnv } from "../src/launchers/pi-launcher.mjs";
import { buildDshLauncherEnv } from "../src/launchers/dsh-launcher.mjs";
import { buildOpencodeLauncherEnv } from "../src/launchers/opencode-launcher.mjs";
import { buildQoderLauncherEnv } from "../src/launchers/qoder-launcher.mjs";
import { buildZcodeLauncherEnv } from "../src/launchers/zcode-launcher.mjs";
import { buildZcodeCliLauncherEnv } from "../src/launchers/zcode-cli-launcher.mjs";
import { buildWorkbuddyLauncherEnv } from "../src/launchers/workbuddy-launcher.mjs";

const ENVS = [
  ["claude", () => buildLauncherEnv({ port: 47821, token: "t" })],
  ["kimi", () => buildKimiLauncherEnv({ port: 47821, token: "t" })],
  ["codex", () => buildCodexLauncherEnv({ instanceId: "x" })],
  ["grok", () => buildGrokLauncherEnv({ instanceId: "x" })],
  ["pi", () => buildPiLauncherEnv({ port: 47821, token: "t", instanceId: "x" })],
  ["dsh", () => buildDshLauncherEnv({ port: 47821, token: "t" })],
  ["opencode", () => buildOpencodeLauncherEnv({ token: "t", instanceId: "x" })],
  ["qoder", () => buildQoderLauncherEnv({ token: "t" })],
  ["zcode", () => buildZcodeLauncherEnv({ port: 47821, token: "t" })],
  ["zcode-cli", () => buildZcodeCliLauncherEnv({ personalConfigPath: "p", builtinConfigPath: "b" })],
  ["workbuddy", () => buildWorkbuddyLauncherEnv({ instanceId: "x" })],
];

test("每个 launcher 环境的 NO_PROXY/no_proxy 都钉住共享的回环字面量", () => {
  for (const [endpoint, build] of ENVS) {
    const env = build();
    assert.equal(env.NO_PROXY, LOOPBACK_NO_PROXY, `${endpoint} 的 NO_PROXY 未钉住回环值`);
    assert.equal(env.no_proxy, LOOPBACK_NO_PROXY, `${endpoint} 的 no_proxy 未钉住回环值`);
  }
});

// 真实入口（launcher.mjs runLauncher / kimi-launcher.mjs runKimiLauncher）把
// base = process.env 原样交给 builder：继承到冲突的 NO_PROXY 时若改成「只在缺
// 失时补」的写法，中继流量会经继承代理离开本机。空 base 的断言抓不住这种回归，
// 所以 claude / kimi 两条真实入口的 builder 必须用带冲突代理的 base 再钉一次。
test("继承到冲突 NO_PROXY 的 base 也必须被回环值覆盖（claude 与 kimi 的真实入口）", () => {
  const base = {
    NO_PROXY: "proxy.corp.example:8080",
    no_proxy: "proxy.corp.example:8080",
    HTTP_PROXY: "http://proxy.corp.example:8080",
    HTTPS_PROXY: "http://proxy.corp.example:8080",
    ANTHROPIC_API_KEY: "inherited-key",
  };
  for (const [endpoint, build] of [
    ["claude", () => buildLauncherEnv({ port: 47821, token: "t", base })],
    ["kimi", () => buildKimiLauncherEnv({ port: 47821, token: "t", base, instanceId: "x" })],
  ]) {
    const env = build();
    assert.equal(env.NO_PROXY, LOOPBACK_NO_PROXY, `${endpoint}: 继承的 NO_PROXY 必须被覆盖，不是只在缺失时补`);
    assert.equal(env.no_proxy, LOOPBACK_NO_PROXY, `${endpoint}: 继承的 no_proxy 必须被覆盖，不是只在缺失时补`);
    assert.equal(env.ANTHROPIC_API_KEY, undefined, `${endpoint}: 继承的真 key 必须剥掉`);
  }
});

function listMjsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listMjsFiles(path));
    else if (entry.name.endsWith(".mjs")) out.push(path);
  }
  return out;
}

test("回环字面量在 src 下只存在于 launcher.mjs 单源定义处", () => {
  const srcRoot = join(fileURLToPath(new URL("../src", import.meta.url)));
  const offenders = listMjsFiles(srcRoot)
    .filter((path) => readFileSync(path, "utf8").includes("127.0.0.1,localhost"))
    .map((path) => path.replaceAll("\\", "/"))
    .filter((path) => !path.endsWith("/launchers/launcher.mjs"));
  assert.deepEqual(offenders, []);
});
