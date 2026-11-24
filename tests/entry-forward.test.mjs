// 入口壳转发芯测试——两个面：
//   1. forwardEntry 的机械行为：argv 跟队、stdio 全 inherit、cwd/env 透传、
//      退出码透传、spawn 失败落 stderr 一行退 1、error/exit 双拍只退一次。
//      spawnFn 全注入，零真进程。
//   2. 契约一致性钉：换树窗口四枚根壳逐一在盘、target 就是 src/ 真入口且在
//      盘、壳文件文本确实转发到该 target——壳与清单漂移（改名、挪位、清空）
//      在此翻红。launcher 壳（shim 目标位）是否入列待更新债结论拍板
//      （bridge anyswitch STATUS 2026-11-03 在途条）。

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { EventEmitter } from "node:events";
import { forwardEntry } from "../src/shared/entry-forward.mjs";

const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// 换树窗口四件：≤0.7.0 升级器/旧面板在换树后仍按根路径拉起的全部位置。
// 新增壳时同步此清单（新增分支若还有旧路径引用，先核 v0.7.0 的 spawn 位）。
const ROOT_ENTRY_SHELLS = [
  { shell: "relay-host.mjs", target: "src/relay/relay-host.mjs" },
  { shell: "panel-host.mjs", target: "src/panel/panel-host.mjs" },
  { shell: "panel-host-restart-helper.mjs", target: "src/panel/panel-host-restart-helper.mjs" },
];

// 可注入假子进程：on/emit 之外什么都不做。
function fakeChild() {
  return new EventEmitter();
}

test("forwardEntry 以真入口路径为 argv[1]、argv[2:] 原样跟队", () => {
  const spawns = [];
  const argv = ["--profile", "dsh-tui"];
  forwardEntry(new URL("file:///C:/anys/app/src/relay/relay-host.mjs"), {
    spawnFn: (...args) => { spawns.push(args); return fakeChild(); },
    execPath: "node.exe",
    argv,
    cwd: "C:\\work",
    env: { TOKEN: "x" },
  });
  assert.equal(spawns.length, 1);
  const [file, args, opts] = spawns[0];
  assert.equal(file, "node.exe");
  assert.deepEqual(args, ["C:\\anys\\app\\src\\relay\\relay-host.mjs", "--profile", "dsh-tui"]);
  assert.equal(opts.cwd, "C:\\work");
  assert.equal(opts.env.TOKEN, "x");
  // stdio 必须 inherit：终端交互、ps1 shim 的管道输入、helper 的 stderr 重定向全靠它
  assert.equal(opts.stdio, "inherit");
});

test("forwardEntry 透传子进程退出码", () => {
  const exits = [];
  const child = fakeChild();
  forwardEntry(new URL("file:///C:/t.mjs"), {
    spawnFn: () => child,
    exit: (code) => exits.push(code),
  });
  child.emit("exit", 3);
  assert.deepEqual(exits, [3]);
});

test("forwardEntry 信号致死（code=null）退 1", () => {
  const exits = [];
  const child = fakeChild();
  forwardEntry(new URL("file:///C:/t.mjs"), {
    spawnFn: () => child,
    exit: (code) => exits.push(code),
  });
  child.emit("exit", null);
  assert.deepEqual(exits, [1]);
});

test("forwardEntry spawn 失败：stderr 落一行含目标路径、退 1", () => {
  const exits = [];
  const lines = [];
  const fakeStderr = { write: (s) => lines.push(s) };
  const child = fakeChild();
  forwardEntry(new URL("file:///C:/gone/relay-host.mjs"), {
    spawnFn: () => child,
    stderr: fakeStderr,
    exit: (code) => exits.push(code),
  });
  child.emit("error", new Error("spawn ENOENT"));
  assert.equal(exits.length, 1);
  assert.equal(exits[0], 1);
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes("C:\\gone\\relay-host.mjs"), "诊断行必须含目标路径");
  assert.ok(lines[0].includes("ENOENT"), "诊断行必须含失败原因");
});

test("forwardEntry error 与 exit 双拍只退一次", () => {
  const exits = [];
  const child = fakeChild();
  forwardEntry(new URL("file:///C:/t.mjs"), {
    spawnFn: () => child,
    exit: (code) => exits.push(code),
  });
  child.emit("error", new Error("boom"));
  child.emit("exit", 0);
  assert.deepEqual(exits, [1]);
});

test("换树窗口根壳与真入口逐一在盘、壳文本确实转发到该 target", () => {
  for (const { shell, target } of ROOT_ENTRY_SHELLS) {
    const shellPath = join(appRoot, shell);
    const targetPath = join(appRoot, target);
    assert.ok(existsSync(shellPath), `根壳缺失：${shell}`);
    assert.ok(existsSync(targetPath), `真入口缺失：${target}`);
    const text = readFileSync(shellPath, "utf8");
    assert.ok(text.includes(`new URL("./${target}"`), `${shell} 未转发到 ${target}`);
    assert.ok(text.includes("entry-forward.mjs"), `${shell} 应经由共享转发芯`);
    // 真入口必须带 isEntryModule 守卫——守卫在才说明壳的转发 exec 形态是必需的
    const targetText = readFileSync(targetPath, "utf8");
    assert.ok(targetText.includes("isEntryModule"), `${target} 缺 isEntryModule 守卫（守卫没了要回头重估壳形态）`);
  }
});

test("壳的 new URL 必须以壳自身为基准解析到真入口（基准写死或丢失即红）", () => {
  // 旧断言只匹配 `new URL("./<target>"` 这个前缀子串：基准参数被换成写死的
  // 路径、别的变量甚至整个删掉时照样全绿——而换树后写死的基准指向的旧树位置
  // 不再存在，转发必然 ENOENT。这里把调用形态整段解析出来：基准必须是
  // import.meta.url，且以壳自身位置解析出的入口必须等于真入口的实际落点。
  for (const { shell, target } of ROOT_ENTRY_SHELLS) {
    const shellPath = join(appRoot, shell);
    const text = readFileSync(shellPath, "utf8");
    const call = text.match(/forwardEntry\(\s*new URL\(\s*("(?:[^"\\]|\\.)*")\s*,\s*([^)\s][^)]*?)\s*\)\s*\)/);
    assert.ok(call, `${shell} 必须以 forwardEntry(new URL(<字符串字面量>, <基准>)) 的形态转发`);
    assert.equal(
      call[2].trim(),
      "import.meta.url",
      `${shell} 的 URL 基准必须是壳自身路径（import.meta.url），写死的基准在换树后指向旧树`,
    );
    const resolved = new URL(JSON.parse(call[1]), pathToFileURL(shellPath).href);
    assert.equal(
      resolved.href,
      pathToFileURL(join(appRoot, target)).href,
      `${shell} 以自身为基准解析出的入口必须是 ${target} 的实际落点`,
    );
  }
});
