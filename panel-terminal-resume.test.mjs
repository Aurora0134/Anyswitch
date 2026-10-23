import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createPanelRouter } from "./panel.mjs";
import { mkTestDir } from "./test-helpers/tmp.mjs";
import { loadOrGenerateToken } from "./pi-relay-token.mjs";

// 路由级：点历史会话续接时，面板只把会话身份（endpoint/id/file）交给服务端，
// 命令行按 session-scan 的 RESUME_COMMAND 模板重建；客户端给什么命令原文都不接。
// createTerminalSession 注入假实现，不起真 terminal-host。

const panelMjs = readFileSync(fileURLToPath(new URL("./panel.mjs", import.meta.url)), "utf8");

const SESSION_ID = "3f2b8c1e-9a44-4d0b-8f6e-1c2d3e4f5a6b";
const PI_FILE = "C:\\Users\\someone\\.pi\\sessions\\3f2b8c1e.jsonl";

function fakeReqRes(url, method = "GET", body = null) {
  const res = {
    statusCode: null,
    headers: {},
    body: "",
    writeHead(code, h) { this.statusCode = code; this.headers = h || {}; },
    end(data) { if (data !== undefined) this.body += data; },
  };
  const listeners = {};
  const req = {
    url,
    method,
    headers: {
      host: "127.0.0.1:47820",
      origin: "http://127.0.0.1:47820",
      "x-anyswitch-panel": "1",
    },
    on(event, fn) { listeners[event] = fn; return req; },
  };
  if (body !== null) {
    queueMicrotask(() => {
      listeners.data?.(Buffer.from(JSON.stringify(body)));
      listeners.end?.();
    });
  }
  const json = () => (res.body ? JSON.parse(res.body) : null);
  return { req, res, json };
}

function resumeRouter({ root, createSession } = {}) {
  const calls = [];
  const router = createPanelRouter({
    storePaths: { root },
    logger: null, metricsCollector: null, aliasResolver: null, aliasPath: null,
    fetchRelayAgents: async () => null,
    createTerminalSession: createSession ?? (async (body, options) => {
      calls.push({ body, options });
      return {
        status: 201,
        body: {
          id: "t-resume-1", label: body.label, cwd: body.cwd, shell: "cmd", pid: 778,
          status: "running", agentId: body.agentId, agentName: body.agentName, launch: body.launch,
        },
      };
    }),
  });
  return { router, calls };
}

// 每个续接端点的可执行文件都指向临时文件：组装层要求真实存在，测试不依赖
// 本机装没装这些 CLI。进程环境用后即还。
function withFakeAgents(fn) {
  const root = mkTestDir("anyswitch-resume-route-");
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const exe = (name) => {
    const path = join(bin, name);
    writeFileSync(path, "");
    return path;
  };
  const overrides = {
    CLAUDE_EXECUTABLE: exe("claude.exe"),
    KIMI_EXECUTABLE: exe("kimi.cmd"),
    PI_EXECUTABLE: exe("pi.cmd"),
    OPENCODE_EXECUTABLE: exe("opencode.exe"),
    GROK_EXECUTABLE: exe("grok.exe"),
    DSH_EXECUTABLE: exe("dsh.cmd"),
    ZCODE_CLI_EXECUTABLE: exe("zcode.mjs"),
    LOCALAPPDATA: join(root, "local"),
    USERPROFILE: join(root, "user"),
  };
  // codex 走官方原生安装位；qoder CLI 固定在 USERPROFILE/.qoder/bin/qodercli。
  mkdirSync(join(overrides.LOCALAPPDATA, "OpenAI", "Codex", "bin", "hash-1"), { recursive: true });
  writeFileSync(join(overrides.LOCALAPPDATA, "OpenAI", "Codex", "bin", "hash-1", "codex.exe"), "");
  mkdirSync(join(overrides.USERPROFILE, ".qoder", "bin", "qodercli"), { recursive: true });
  writeFileSync(join(overrides.USERPROFILE, ".qoder", "bin", "qodercli", "qodercli.exe"), "");
  const saved = {};
  for (const [key, value] of Object.entries(overrides)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  return fn(root).finally(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

describe("续接历史会话（terminal agent-sessions + resume）", () => {
  it("九个端点：按模板重建的续接参数随 launch 转发，env/label 与普通启动同源", async () => {
    await withFakeAgents(async (cwd) => {
      const expected = {
        claude: ["--resume", SESSION_ID],
        kimi: ["--session", SESSION_ID],
        pi: ["--session", PI_FILE],
        opencode: ["--session", SESSION_ID],
        codex: ["resume", SESSION_ID],
        grok: ["--resume", SESSION_ID],
        // dsh 模板自带的 --profile 与端点固定参数同值，合并去重后恰一次。
        dsh: ["--profile", "dsh-tui", "--resume", SESSION_ID],
        zcode: [fileURLToPath(new URL("./zcode-cli-launcher.mjs", import.meta.url)), "--resume", SESSION_ID],
        qoder: ["--resume", SESSION_ID],
      };
      for (const [endpoint, tail] of Object.entries(expected)) {
        const root = mkTestDir("anyswitch-resume-route-root-");
        const { router, calls } = resumeRouter({ root });
        const { req, res, json } = fakeReqRes("/panel/api/terminal/agent-sessions", "POST", {
          agentId: endpoint,
          cwd,
          cols: 100,
          rows: 30,
          resume: { endpoint, id: SESSION_ID, file: PI_FILE },
        });
        await router.handle(req, res);
        assert.equal(res.statusCode, 201, `${endpoint} 续接起终端`);
        assert.equal(calls.length, 1, `${endpoint} 走注入的 createTerminalSession`);
        const forwarded = calls[0].body;
        assert.deepEqual(forwarded.launch.args.slice(0, 6), ["/d", "/c", "chcp", "65001", ">nul", "&"], `${endpoint} 码页前置不动`);
        assert.deepEqual(forwarded.launch.args.slice(7), tail, `${endpoint} 的续接参数由服务端重建`);
        assert.equal(forwarded.cwd, cwd);
        assert.equal(forwarded.agentId, endpoint);
        assert.equal("env" in json(), false, `${endpoint} 响应不回显 env`);
        assert.ok(!JSON.stringify(forwarded.launch.args).includes(loadOrGenerateToken(root)), `${endpoint} 命令行不含令牌`);
      }
    });
  });

  it("resume 端点与 agentId 不配对返回 400 resume-invalid，不转发", async () => {
    await withFakeAgents(async (cwd) => {
      // 可续接的 agentId 配上另一家的 resume.endpoint：不能拿 kimi 的执行体
      // 拼一条 dsh 的续接命令——归到身份配对错误（resume-invalid），也不转发。
      const root = mkTestDir("anyswitch-resume-route-root-");
      const { router, calls } = resumeRouter({ root });
      const { req, res, json } = fakeReqRes("/panel/api/terminal/agent-sessions", "POST", {
        agentId: "kimi",
        cwd,
        resume: { endpoint: "dsh", id: SESSION_ID },
      });
      await router.handle(req, res);
      assert.equal(res.statusCode, 400);
      assert.equal(json().ok, false);
      assert.equal(json().code, "resume-invalid");
      assert.match(json().error, /不属于这个 Agent/);
      assert.equal(calls.length, 0);
    });
  });

  it("resume 载荷不合法返回 400 resume-invalid，不转发", async () => {
    await withFakeAgents(async (cwd) => {
      // 每条用例都写明要启动的 agentId：配对必须对得上，否则会被「身份与 agent
      // 不一致」那条先拦下，测不到本条真正想验的规则。
      const cases = [
        ["resume 不是对象", "kimi", "kimi"],
        ["缺 endpoint", "kimi", { id: SESSION_ID }],
        ["缺 id", "kimi", { endpoint: "kimi" }],
        ["id 全空白", "kimi", { endpoint: "kimi", id: "  " }],
        ["pi 缺存档路径", "pi", { endpoint: "pi", id: SESSION_ID }],
        ["身份与要启动的 agent 不一致", "kimi", { endpoint: "claude", id: SESSION_ID }],
        ["cmd 元字符", "kimi", { endpoint: "kimi", id: "a&calc" }],
        ["相对路径存档", "pi", { endpoint: "pi", id: SESSION_ID, file: "sessions\\abc.jsonl" }],
        // 超长身份必须在面板这一层就判非法：放过去会被 terminal-host 的
        // MAX_LAUNCH_ARG_BYTES 拦成裸 invalid_launch，逃出 resume-* 契约。
        ["超长 id", "kimi", { endpoint: "kimi", id: "a".repeat(4097) }],
        ["超长存档路径", "pi", { endpoint: "pi", id: SESSION_ID, file: `C:\\${"a".repeat(4095)}` }],
        ["客户端夹带命令原文", "kimi", { endpoint: "kimi", id: SESSION_ID, command: "calc.exe" }],
      ];
      for (const [label, agentId, resume] of cases) {
        const root = mkTestDir("anyswitch-resume-route-root-");
        const { router, calls } = resumeRouter({ root });
        const { req, res, json } = fakeReqRes("/panel/api/terminal/agent-sessions", "POST", { agentId, cwd, resume });
        await router.handle(req, res);
        assert.equal(res.statusCode, 400, `${label} 判非法`);
        assert.equal(json().ok, false, `${label} 带 ok:false`);
        assert.equal(json().code, "resume-invalid", `${label} 回机器可判的 code`);
        assert.match(json().error, /[\u4e00-\u9fff]/, `${label} 的文案面向用户`);
        assert.equal(calls.length, 0, `${label} 不转发`);
      }
    });
  });

  it("客户端夹带命令原文：整包判非法，不转发也不执行", async () => {
    await withFakeAgents(async (cwd) => {
      const root = mkTestDir("anyswitch-resume-route-root-");
      const { router, calls } = resumeRouter({ root });
      const { req, res, json } = fakeReqRes("/panel/api/terminal/agent-sessions", "POST", {
        agentId: "claude",
        cwd,
        resume: {
          endpoint: "claude",
          id: SESSION_ID,
          command: "claude --resume ../../../etc/passwd",
          args: ["--dangerously-skip-permissions"],
          launch: { file: "C:\\Windows\\System32\\cmd.exe", args: ["/c", "calc.exe"] },
        },
      });
      await router.handle(req, res);
      // 续接载荷只认 endpoint/id/file 三个字段：多一个字段就整包拒，命令原文
      // 连「被忽略」的机会都没有，不存在被误读成启动参数的路径。
      assert.equal(res.statusCode, 400);
      assert.equal(json().code, "resume-invalid");
      assert.equal(calls.length, 0, "不转发");
    });
  });

  it("无 resume 字段：转发与响应逐位不变", async () => {
    await withFakeAgents(async (cwd) => {
      const root = mkTestDir("anyswitch-resume-route-root-");
      const { router, calls } = resumeRouter({ root });
      for (const extra of [{}, { resume: undefined }, { resume: null }]) {
        const { req, res, json } = fakeReqRes("/panel/api/terminal/agent-sessions", "POST", {
          agentId: "kimi",
          cwd,
          cols: 120,
          rows: 34,
          ...extra,
        });
        await router.handle(req, res);
        assert.equal(res.statusCode, 201);
        assert.equal(json().id, "t-resume-1");
        assert.equal("code" in json(), false, "普通启动的响应不新增字段");
        const forwarded = calls.at(-1).body;
        assert.equal(forwarded.launch.args.length, 7, "kimi 普通启动仍是零附加参数");
        assert.deepEqual(forwarded.launch.args.slice(0, 6), ["/d", "/c", "chcp", "65001", ">nul", "&"]);
        assert.equal(forwarded.label, "Kimi Code");
        assert.equal(forwarded.cols, 120);
        assert.equal(forwarded.rows, 34);
      }
    });
  });

  it("源码钉死：无 resume 的组装调用原样保留，续接只是同一次调用的可选入参", () => {
    assert.ok(
      panelMjs.includes("buildAgentSessionLaunch({ agentId, cwd: body?.cwd, port: AGENT_RELAY_PORT, token, base, claudeBypassPermissions })"),
      "无 resume 时的组装调用与改造前逐字一致",
    );
    assert.ok(panelMjs.includes("resume-unsupported"), "不支持续接的端点有独立错误码");
  });

  // M7 S5：续接创建的终端要把「替哪条会话续接的」记进宿主会话记录（前端历史会话
  // 点击先查它做去重聚焦）。面板负责把校验过的 resume 身份随创建转发——只递
  // endpoint + 会话 id 两个非密字段。
  it("resume 身份随创建转发给 terminal-host：只递 endpoint + id，不进 file/命令原文", async () => {
    await withFakeAgents(async (cwd) => {
      const root = mkTestDir("anyswitch-resume-forward-root-");
      const { router, calls } = resumeRouter({ root });
      const { req, res, json } = fakeReqRes("/panel/api/terminal/agent-sessions", "POST", {
        agentId: "kimi",
        cwd,
        resume: { endpoint: "kimi", id: SESSION_ID, file: PI_FILE },
      });
      await router.handle(req, res);
      assert.equal(res.statusCode, 201);
      assert.equal(calls.length, 1, "走注入的 createTerminalSession");
      assert.deepEqual(calls[0].body.resume, { endpoint: "kimi", id: SESSION_ID },
        "转发 resume:{endpoint,id}（file 不转发——去重不需要路径）");
      // 无 resume 的普通创建不递这个字段（M3 契约逐位不变）
      const plain = resumeRouter({ root: mkTestDir("anyswitch-resume-plain-root-") });
      const plainCall = fakeReqRes("/panel/api/terminal/agent-sessions", "POST", { agentId: "kimi", cwd });
      await plain.router.handle(plainCall.req, plainCall.res);
      assert.equal(plainCall.res.statusCode, 201);
      assert.ok(!("resume" in plain.calls[0].body), "普通创建不递 resume");
    });
  });
});

// M12-A 内切路由：把已开着的终端就地换成目标会话（同记录 terminate+spawn+身份
// 换绑），页签不新增。working 判定在面板侧，本路由只接「已决定内切」的请求。
describe("内切切换会话（terminal sessions switch）", () => {
  function switchRouter({ root, hostSession, restarted, probe } = {}) {
    const calls = { restart: [], fetch: [], probe: [] };
    const router = createPanelRouter({
      storePaths: { root },
      logger: null, metricsCollector: null, aliasResolver: null, aliasPath: null,
      fetchRelayAgents: async () => null,
      fetchRelayDetectedProcesses: async () => null,
      createTerminalSession: async (body) => ({ status: 201, body: { id: "t-new", ...body } }),
      fetchTerminalSessionFn: async (id, options) => {
        calls.fetch.push({ id, options });
        return hostSession === undefined
          ? { id, label: "Anyswitch", cwd: "C:\\shell-dir", shell: "powershell", status: "running", pid: 42 }
          : hostSession;
      },
      probeTerminalCommandTreeFn: async (pid) => {
        calls.probe.push(pid);
        return probe === undefined ? false : probe;
      },
      restartTerminalSessionFn: async (id, body, options) => {
        calls.restart.push({ id, body, options });
        return restarted === undefined
          ? { status: 200, body: { id, status: "running", pid: 99, label: body.label, agentId: body.agentId, agentName: body.agentName, resume: body.resume } }
          : restarted;
      },
      scanAgentConversationsFn: async () => [],
      bindingRefreshScheduleFn: () => {},
    });
    return { router, calls };
  }

  it("空白壳内切：launch 带目标 resume 重建，身份三件＋resume 同步进宿主记录", async () => {
    await withFakeAgents(async (cwd) => {
      const root = mkTestDir("anyswitch-switch-route-root-");
      const { router, calls } = switchRouter({ root });
      const { req, res, json } = fakeReqRes(`/panel/api/terminal/sessions/${SESSION_ID}/switch`, "POST", {
        resume: { endpoint: "kimi", id: SESSION_ID },
        cwd,
      });
      await router.handle(req, res);
      assert.equal(res.statusCode, 200, "内切起终端");
      assert.equal(calls.fetch.length, 1, "先读宿主会话记录");
      assert.equal(calls.restart.length, 1, "走 restart（同记录 terminate+spawn）");
      const forwarded = calls.restart[0].body;
      assert.ok(forwarded.launch.args.includes("--session"), "kimi 续接参数由服务端按模板重建");
      assert.ok(forwarded.launch.args.includes(SESSION_ID), "目标会话 id 进命令行");
      assert.equal(forwarded.cwd, cwd, "cwd 用目标会话自己的项目目录");
      assert.deepEqual(forwarded.resume, { endpoint: "kimi", id: SESSION_ID }, "resume 身份同步（去重数据源）");
      assert.ok(typeof forwarded.label === "string" && forwarded.label, "label 同步");
      assert.equal(forwarded.agentId, "kimi", "agentId 同步");
      assert.ok(typeof forwarded.agentName === "string" && forwarded.agentName, "agentName 同步");
      assert.ok("env" in forwarded, "env 随 restart 走（不回显）");
      assert.equal("env" in json(), false, "响应不回显 env");
    });
  });

  it("杀前复核：running 且探测有活命令子进程（或探测失败）→ 409 switch_busy 不 restart；exited 不探测照旧内切", async () => {
    await withFakeAgents(async (cwd) => {
      for (const [name, probe] of [["有活后代", true], ["探测失败（null）", null]]) {
        const { router, calls } = switchRouter({ root: mkTestDir("anyswitch-switch-busy-"), probe });
        const { req, res, json } = fakeReqRes(`/panel/api/terminal/sessions/${SESSION_ID}/switch`, "POST", {
          resume: { endpoint: "kimi", id: SESSION_ID }, cwd,
        });
        await router.handle(req, res);
        assert.equal(res.statusCode, 409, `${name} 拒换`);
        assert.equal(json().code, "switch_busy", "机器可判短码");
        assert.equal(json().error, "switch_busy", "error 即机器码本身（零文案）");
        assert.deepEqual(calls.probe, [42], `${name} 按会话 pid 探测过一次`);
        assert.equal(calls.restart.length, 0, `${name} 不 restart（在跑命令不被杀）`);
      }
      const gone = switchRouter({
        root: mkTestDir("anyswitch-switch-exit-"),
        hostSession: { id: SESSION_ID, label: "Anyswitch", cwd: "C:\\shell-dir", shell: "powershell", status: "exited", pid: 42 },
        probe: true,
      });
      const call = fakeReqRes(`/panel/api/terminal/sessions/${SESSION_ID}/switch`, "POST", {
        resume: { endpoint: "kimi", id: SESSION_ID }, cwd,
      });
      await gone.router.handle(call.req, call.res);
      assert.equal(call.res.statusCode, 200, "exited 照旧内切");
      assert.equal(gone.calls.probe.length, 0, "exited 不探测（树里没有活进程可杀，restart 只收残留登记）");
      assert.equal(gone.calls.restart.length, 1, "照旧走 restart");
    });
  });

  it("宿主无此会话 404；restart 失败 503；都不静默", async () => {
    await withFakeAgents(async (cwd) => {
      const missing = switchRouter({ root: mkTestDir("anyswitch-switch-404-"), hostSession: null });
      const missCall = fakeReqRes(`/panel/api/terminal/sessions/${SESSION_ID}/switch`, "POST", {
        resume: { endpoint: "kimi", id: SESSION_ID }, cwd,
      });
      await missing.router.handle(missCall.req, missCall.res);
      assert.equal(missCall.res.statusCode, 404);
      assert.equal(missing.calls.restart.length, 0, "无记录不换绑");

      const down = switchRouter({ root: mkTestDir("anyswitch-switch-503-"), restarted: null });
      const downCall = fakeReqRes(`/panel/api/terminal/sessions/${SESSION_ID}/switch`, "POST", {
        resume: { endpoint: "kimi", id: SESSION_ID }, cwd,
      });
      await down.router.handle(downCall.req, downCall.res);
      assert.equal(downCall.res.statusCode, 503);
      assert.equal(downCall.json().ok, false);
    });
  });

  it("目标端点不可续接/不在册、resume 形状不合法：400 不转发", async () => {
    await withFakeAgents(async (cwd) => {
      const cases = [
        // 组装失败（身份值带 cmd 元字符）：走 catch 的原有形状——code 机器可判，error 是组装错误原文
        { resume: { endpoint: "dsh", id: "a&calc" }, expectCode: "resume-invalid", machine: false },
        // 路由级拒换（M12-A 三处 400）：error 即机器码本身，零文案——连字符族让前端门接住落批准句
        { resume: { endpoint: "kimi" }, expectCode: "resume-invalid", machine: true },
        { resume: { endpoint: "kimi", id: "" }, expectCode: "resume-invalid", machine: true },
        { resume: { endpoint: "no-such-agent", id: SESSION_ID }, expectCode: "resume-unsupported", machine: true },
      ];
      for (const item of cases) {
        const { router, calls } = switchRouter({ root: mkTestDir("anyswitch-switch-400-") });
        const { req, res, json } = fakeReqRes(`/panel/api/terminal/sessions/${SESSION_ID}/switch`, "POST", {
          resume: item.resume, cwd,
        });
        await router.handle(req, res);
        assert.equal(res.statusCode, 400, `${JSON.stringify(item.resume)} 拒换`);
        assert.equal(json().code, item.expectCode, "机器可判的 code");
        if (item.machine) {
          assert.equal(json().error, item.expectCode, "路由级拒换：error 即机器码本身，零文案（文案零新增冻结条款）");
        } else {
          assert.match(json().error, /[\u4e00-\u9fff]/, "组装失败的 error 维持原有形状");
        }
        assert.equal(calls.restart.length, 0, "不转发给 terminal-host");
      }
    });
  });
});
