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
  it("六个端点：按模板重建的续接参数随 launch 转发，env/label 与普通启动同源", async () => {
    await withFakeAgents(async (cwd) => {
      const expected = {
        claude: ["--resume", SESSION_ID],
        kimi: ["--session", SESSION_ID],
        pi: ["--session", PI_FILE],
        opencode: ["--session", SESSION_ID],
        codex: ["resume", SESSION_ID],
        grok: ["--resume", SESSION_ID],
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

  it("不支持续接的端点返回 400 resume-unsupported，不转发", async () => {
    await withFakeAgents(async (cwd) => {
      for (const endpoint of ["dsh", "zcode", "qoder"]) {
        const root = mkTestDir("anyswitch-resume-route-root-");
        const { router, calls } = resumeRouter({ root });
        const { req, res, json } = fakeReqRes("/panel/api/terminal/agent-sessions", "POST", {
          agentId: endpoint,
          cwd,
          resume: { endpoint, id: SESSION_ID },
        });
        await router.handle(req, res);
        assert.equal(res.statusCode, 400, `${endpoint} 判不支持`);
        assert.equal(json().ok, false);
        assert.equal(json().code, "resume-unsupported", `${endpoint} 回机器可判的 code`);
        assert.match(json().error, /[\u4e00-\u9fff]/, `${endpoint} 的文案面向用户`);
        assert.equal(calls.length, 0, `${endpoint} 不转发给 terminal-host`);
      }
      // 可续接的 agentId 配上不支持续接的 resume.endpoint：同样判不支持，
      // 不能拿 kimi 的执行体拼一条不存在的续接命令。
      const root = mkTestDir("anyswitch-resume-route-root-");
      const { router, calls } = resumeRouter({ root });
      const { req, res, json } = fakeReqRes("/panel/api/terminal/agent-sessions", "POST", {
        agentId: "kimi",
        cwd,
        resume: { endpoint: "dsh", id: SESSION_ID },
      });
      await router.handle(req, res);
      assert.equal(res.statusCode, 400);
      assert.equal(json().code, "resume-unsupported");
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
});
