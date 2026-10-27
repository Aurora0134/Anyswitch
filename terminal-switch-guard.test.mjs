import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseProcessTable, hasRunningCommand, probeTerminalCommandTree } from "./terminal-switch-guard.mjs";

// switch-guard 的三段判定：解析（CIM 行形状）→ 后代搜索（锚优先＋根形态定证据层
// ＋dsh 派生豁免）→ 按需探测（execFile 注入）。路由层的 409 行为在
// panel-terminal-resume.test.mjs。

describe("parseProcessTable：CIM 四段制表符行", () => {
  it("正常行入表：pid/ppid 数字、image 归一小写、命令行整体归第四段", () => {
    const { ppidByPid, cmdByPid, imageByPid } = parseProcessTable(
      "100\t1\tCMD.EXE\tdsh --profile dsh-tui\n101\t100\tnode.exe\tx.js --flag",
    );
    assert.equal(ppidByPid.get(100), 1);
    assert.equal(imageByPid.get(100), "cmd.exe");
    assert.equal(cmdByPid.get(100), "dsh --profile dsh-tui");
    assert.equal(cmdByPid.get(101), "x.js --flag");
  });

  it("命令行可含制表符：只按前三段切，余下整体归命令行", () => {
    const { cmdByPid } = parseProcessTable("7\t2\tpython.exe\tpython\t-c\tprint(1)");
    assert.equal(cmdByPid.get(7), "python\t-c\tprint(1)");
  });

  it("空命令行落 null；垃圾行（无四段/pid 非数字）跳过", () => {
    const { ppidByPid, cmdByPid } = parseProcessTable("9\t2\tsys.exe\t\n\nno-tabs\nx\t1\ta.exe\twhatever");
    assert.equal(cmdByPid.get(9), null);
    assert.equal(ppidByPid.size, 1, "垃圾行不入表");
  });

  it("空输入/非字符串输入得空表", () => {
    assert.equal(parseProcessTable("").ppidByPid.size, 0);
    assert.equal(parseProcessTable(null).cmdByPid.size, 0);
  });
});

describe("hasRunningCommand：锚优先＋根形态定证据层＋dsh 派生豁免", () => {
  const table = (rows) => {
    const ppidByPid = new Map();
    const cmdByPid = new Map();
    const imageByPid = new Map();
    for (const [pid, ppid, image, cmd] of rows) {
      ppidByPid.set(pid, ppid);
      cmdByPid.set(pid, cmd);
      imageByPid.set(pid, image);
    }
    return { ppidByPid, cmdByPid, imageByPid };
  };
  // Anyswitch 拉起形态：cmd /c 一次性包装壳 → agent 本体。
  const CLAUDE_TREE = [
    [10, 1, "cmd.exe", "cmd /c claude"],
    [11, 10, "claude.exe", "claude"],
  ];

  it("锚（agent 主进程）优先：锚之下的新命令行才是在跑命令，锚与锚之上不算", () => {
    const idle = table(CLAUDE_TREE); // 等输入：锚是光杆
    assert.equal(hasRunningCommand(idle, { rootPid: 10, anchorPid: 11 }), false);

    const running = table([
      ...CLAUDE_TREE,
      [12, 11, "cmd.exe", "cmd /c npm install"],
      [13, 12, "node.exe", "npm-cli.js install"],
    ]);
    assert.equal(hasRunningCommand(running, { rootPid: 10, anchorPid: 11 }), true, "锚下挂命令");
    assert.equal(hasRunningCommand(idle, { rootPid: 11, anchorPid: null }), false, "无锚时锚即根也光杆");
  });

  it("锚在表外（归属过期）回落根形态判定，不误报", () => {
    const rows = table(CLAUDE_TREE);
    assert.equal(hasRunningCommand(rows, { rootPid: 10, anchorPid: 999 }), false, "锚失效＝无锚路径");
  });

  it("无锚＋一次性包装壳根：直接子进程是 agent 本体不算证据，再下一层起才算", () => {
    const idle = table(CLAUDE_TREE);
    assert.equal(hasRunningCommand(idle, { rootPid: 10 }), false, "cmd /c → claude 光杆（本体层不误报）");

    const running = table([
      ...CLAUDE_TREE,
      [12, 11, "node.exe", "npm-cli.js install"], // 不经 shell 直接 spawn
    ]);
    assert.equal(hasRunningCommand(running, { rootPid: 10 }), true, "本体之下挂命令进程");
  });

  it("无锚＋交互 shell 根（普通终端）：直接子进程就是用户跑的命令，算证据", () => {
    const idle = table([[20, 1, "powershell.exe", "powershell"]]);
    assert.equal(hasRunningCommand(idle, { rootPid: 20 }), false, "提示符下光杆");

    const running = table([
      [20, 1, "powershell.exe", "powershell"],
      [21, 20, "node.exe", "npm-cli.js install"],
    ]);
    assert.equal(hasRunningCommand(running, { rootPid: 20 }), true, "用户跑命令被保护");
  });

  it("dsh 派生引擎：同命令行不作为在跑证据（锚与无锚两形态），引擎子树照走", () => {
    const DSH_TREE = [
      [30, 1, "cmd.exe", "cmd /c dsh"],
      [31, 30, "dsh.exe", "dsh --profile dsh-tui"],
      [32, 31, "dsh.exe", "dsh --profile dsh-tui"], // 引擎（同命令行派生）
    ];
    // 锚形态：锚=dsh main，引擎由 main 派生（同命令行）。
    const dshIdleAnchored = table(DSH_TREE);
    assert.equal(hasRunningCommand(dshIdleAnchored, { rootPid: 30, anchorPid: 31 }), false, "引擎豁免＝光杆语义");

    const dshRunningAnchored = table([
      ...DSH_TREE,
      [33, 32, "node.exe", "build.mjs"], // 引擎底下挂的工作命令
    ]);
    assert.equal(hasRunningCommand(dshRunningAnchored, { rootPid: 30, anchorPid: 31 }), true, "引擎子树照走");

    // 无锚形态：cmd /c 壳 → main（本体层）→ 引擎（同命令行豁免）。
    assert.equal(hasRunningCommand(dshIdleAnchored, { rootPid: 30 }), false, "无锚 dsh 等输入不误报");
    assert.equal(hasRunningCommand(dshRunningAnchored, { rootPid: 30 }), true, "无锚 dsh 跑命令照常识别");
  });

  it("命令行为 null：证据层保守按在跑，本体层不误伤（子树照走）", () => {
    const deep = table([
      [40, 1, "cmd.exe", "cmd /c claude"],
      [41, 40, "claude.exe", null], // 本体层拿不到命令行：不是证据
      [42, 41, "node.exe", "watcher.js"], // 但它的子进程照常判
    ]);
    assert.equal(hasRunningCommand(deep, { rootPid: 40 }), true, "本体层 null 不遮蔽证据层的命令");
    const onlyNull = table([
      [40, 1, "cmd.exe", "cmd /c claude"],
      [41, 40, "claude.exe", null],
    ]);
    assert.equal(hasRunningCommand(onlyNull, { rootPid: 40 }), false, "本体层 null 不误报");
    const nullChild = table([
      [50, 1, "powershell.exe", "powershell"],
      [51, 50, "some.exe", null], // 证据层 null：保守保护
    ]);
    assert.equal(hasRunningCommand(nullChild, { rootPid: 50 }), true, "证据层 null 保守按在跑");
  });

  it("父指针环不死循环（pid 复用可见到环形态）", () => {
    const ring = table([
      [60, 61, "dsh.exe", "a"],
      [61, 60, "dsh.exe", "a"], // 互为父子、同命令行：豁免＋seen 双闸不挂死
    ]);
    assert.equal(hasRunningCommand(ring, { rootPid: 60 }), false, "环内无新命令行即光杆");
    const ringBusy = table([
      [60, 61, "dsh.exe", "a"],
      [61, 60, "node.exe", "b"], // 环上挂着新命令行：照常识别
    ]);
    assert.equal(hasRunningCommand(ringBusy, { rootPid: 60 }), true, "环不影响证据识别");
  });

  it("起点不在表里 → null（这轮枚举不可信）；坏参数 → null", () => {
    const rows = table([[70, 1, "cmd.exe", "cmd"]]);
    assert.equal(hasRunningCommand(rows, { rootPid: 99 }), null);
    assert.equal(hasRunningCommand({ ppidByPid: new Map(), cmdByPid: new Map(), imageByPid: new Map() }, { rootPid: 70 }), null);
    assert.equal(hasRunningCommand(rows, { rootPid: 0 }), null);
    assert.equal(hasRunningCommand(rows, { rootPid: -3 }), null);
    assert.equal(hasRunningCommand(null, { rootPid: 70 }), null);
  });
});

describe("probeTerminalCommandTree：按需探测", () => {
  const fakeExec = (out) => async (file, args, opts, cb) => cb(null, out);
  const failExec = async (file, args, opts, cb) => cb(new Error("probe blew up"), "");

  it("锚/无锚两路都落到探测结果；根不在输出表里 → null", async () => {
    const rows = "10\t1\tcmd.exe\tcmd /c claude\n11\t10\tclaude.exe\tclaude\n12\t11\tcmd.exe\tcmd /c npm\n";
    assert.equal(await probeTerminalCommandTree(10, { anchorPid: 11, execFileFn: fakeExec(rows) }), true, "锚下有命令");
    const bare = "10\t1\tcmd.exe\tcmd /c claude\n11\t10\tclaude.exe\tclaude\n";
    assert.equal(await probeTerminalCommandTree(10, { anchorPid: 11, execFileFn: fakeExec(bare) }), false, "锚下光杆");
    assert.equal(await probeTerminalCommandTree(10, { execFileFn: fakeExec(bare) }), false, "无锚包装壳光杆");
    assert.equal(await probeTerminalCommandTree(10, { execFileFn: fakeExec("99\t1\tcmd.exe\twhatever\n") }), null, "根不在表");
  });

  it("探测失败（error 且无输出）→ null", async () => {
    assert.equal(await probeTerminalCommandTree(10, { execFileFn: failExec }), null);
  });

  it("非法 pid 直接 null，不起子进程", async () => {
    let spawned = 0;
    const counting = async (...a) => { spawned += 1; a[3](null, ""); };
    assert.equal(await probeTerminalCommandTree(0, { execFileFn: counting }), null);
    assert.equal(await probeTerminalCommandTree("10", { execFileFn: counting }), null);
    assert.equal(spawned, 0);
  });

  // 复探形态（M2-T3）：观察点由子进程自己睡出来，好让两个探测的启动税重叠。
  it("delayMs：脚本先 Start-Sleep，睡的那段不占查询预算", async () => {
    let captured = null;
    const exec = async (file, args, opts, cb) => { captured = { file, args, opts }; cb(null, "10\t1\tcmd.exe\tcmd /c claude\n"); };
    await probeTerminalCommandTree(10, { execFileFn: exec, delayMs: 700, timeoutMs: 1200 });
    assert.match(captured.args[3], /^Start-Sleep -Milliseconds 700; Get-CimInstance /, "查询前先睡这一拍");
    assert.equal(captured.opts.timeout, 1900, "execFile 的超时要把睡的那段算进去，查询预算才不缩水");
    // 不给 delayMs 时脚本原样（首探形态），超时就是预算本身。
    await probeTerminalCommandTree(10, { execFileFn: exec, timeoutMs: 1500 });
    assert.match(captured.args[3], /^Get-CimInstance /);
    assert.equal(captured.opts.timeout, 1500);
  });

  it("signal 透传给 execFile；被中止（AbortError）按 null 处置", async () => {
    const ctl = new AbortController();
    let seenSignal = null;
    const exec = async (file, args, opts, cb) => {
      seenSignal = opts.signal;
      cb(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }), "");
    };
    ctl.abort();
    assert.equal(await probeTerminalCommandTree(10, { execFileFn: exec, signal: ctl.signal }), null);
    assert.equal(seenSignal, ctl.signal, "中止信号必须到得了子进程（掐掉复探靠它）");
    // 不给 signal 时不往 opts 里塞一个 undefined：老注入桩只认自己认识的键。
    await probeTerminalCommandTree(10, { execFileFn: async (file, args, opts, cb) => { assert.equal("signal" in opts, false); cb(null, "10\t1\tcmd.exe\tx\n"); } });
  });
});
