// Resident relay Anthropic-path tests: real loopback sockets against
// createOpenAIRelayServer (openai-server.mjs), synthetic store, mock upstream.
// These cover the resident /v1/messages streaming route, which the per-launch
// server.test.mjs suite does not reach.
// No real credentials, no real network egress, no DPAPI.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createOpenAIRelayServer, listenLoopback } from "../src/relay/openai-server.mjs";
import { createEffortInjector } from "../src/catalog/effort-injection.mjs";
import { mkTestDir } from "../test-helpers/tmp.mjs";

// Isolation fixture: redirect the per-user data root to a temp directory for
// this whole test process. Deps below inject every injectable default-path
// reader, but not every reader goes through deps (protocol.mjs
// anthropicToOpenAI consults midSystemRewriteEnabled() directly), so the env
// redirect is what guarantees no request touches the real
// %LOCALAPPDATA%\Anyswitch tree — same idea as panel-self-update.test.mjs's
// per-case base. node --test runs each file in its own process, so this
// cannot leak into sibling suites; test-helpers/tmp.mjs sweeps it on exit.
const envRoot = mkTestDir("anys-anthropic-stream-env-");
process.env.LOCALAPPDATA = envRoot;
process.env.APPDATA = envRoot;
process.env.USERPROFILE = envRoot;

const TOKEN = "test-token-anthropic-stream";

const STORE = {
  version: 2,
  providers: {
    "test-prov": {
      displayName: "Test Provider",
      baseURL: "https://upstream.invalid/v1",
      protocol: "openai-compatible",
      credentialFile: "test.dpapi",
      models: { "claude-test": { displayName: "Claude Test" } },
    },
  },
};

// Without these injections createHandler falls back to the disk-backed
// defaults (defaultEffortInjector + imageFallbackEnabled/imageHeuristicEnabled),
// which read the real %LOCALAPPDATA%\Anyswitch settings.json and
// thinking-efforts.db.json on every request — contradicting the isolation
// promised in the file header. isEnabled:false makes inject() short-circuit
// before the effort library is ever opened; same pattern as
// anthropic-server-chain.test.mjs (OFF_EFFORT_INJECTOR).
const OFF_EFFORT_INJECTOR = () => createEffortInjector({ isEnabled: () => false });

function createMockDeps({ upstreamFetch, getKeepAliveConfig }) {
  return {
    token: TOKEN,
    loadStore: () => ({ ok: true, store: STORE }),
    loadCredential: async () => ({ ok: true, value: "TEST_SECRET" }),
    upstreamFetch,
    recordGeneration: () => {},
    readGeneration: () => null,
    getKeepAliveConfig,
    effortInjector: OFF_EFFORT_INJECTOR(),
    imageFallbackGate: () => false,
    imageHeuristicGate: () => false,
  };
}

// Subsequence scan over the emitted Anthropic SSE event names. The cursor must
// advance PAST the matched frame: stopping at the match's start (`cursor = at`)
// lets a repeated name in `order` be satisfied by the very same earlier
// occurrence, so a missing second delta could never fail this loop.
function assertSseEventOrder(text, order) {
  let cursor = 0;
  for (const event of order) {
    const needle = `event: ${event}`;
    const at = text.indexOf(needle, cursor);
    assert.ok(at !== -1, `missing ${event}`);
    cursor = at + needle.length;
  }
}

async function withServer(deps, fn) {
  const server = createOpenAIRelayServer(deps);
  const { port, close } = await listenLoopback(server, 0);
  try {
    return await fn(port);
  } finally {
    await close();
  }
}

function postMessages(port) {
  return fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { authorization: TOKEN, "content-type": "application/json" },
    body: JSON.stringify({
      model: "anthropic/test-prov/claude-test",
      max_tokens: 64,
      stream: true,
      messages: [{ role: "user", content: "hello" }],
    }),
  });
}

function sseStream(chunks) {
  return (async function* () {
    const enc = new TextEncoder();
    for (const c of chunks) yield enc.encode(c);
  })();
}

describe("resident relay /v1/messages streaming (Anthropic path)", () => {
  it("translates a healthy upstream stream into an ordered Anthropic SSE sequence", async () => {
    const upstreamFetch = async () => ({
      ok: true,
      status: 200,
      body: sseStream([
        'data: {"id":"cmpl-1","choices":[{"delta":{"content":"He"}}]}\n\n',
        'data: {"id":"cmpl-1","choices":[{"delta":{"content":"llo"}}]}\n\n',
        'data: {"id":"cmpl-1","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":5}}\n\n',
        "data: [DONE]\n\n",
      ]),
    });

    await withServer(createMockDeps({ upstreamFetch }), async (port) => {
      const res = await postMessages(port);
      assert.equal(res.status, 200, "a healthy stream must not end in a 502");
      assert.match(res.headers.get("content-type"), /text\/event-stream/);
      const text = await res.text();

      // The client speaks the Anthropic Messages protocol: the relay must
      // translate the upstream OpenAI chunks into Anthropic-shaped events.
      const order = ["message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"];
      assertSseEventOrder(text, order);
      assert.ok(text.includes('"text_delta"'));
      assert.ok(text.includes("He"), "first text fragment must survive");
      assert.ok(text.includes("llo"), "second text fragment must survive");
    });
  });

  it("translates upstream reasoning into a thinking block that closes before the answer", async () => {
    const upstreamFetch = async () => ({
      ok: true,
      status: 200,
      body: sseStream([
        'data: {"id":"cmpl-1","choices":[{"delta":{"reasoning_content":"想"}}]}\n\n',
        'data: {"id":"cmpl-1","choices":[{"delta":{"reasoning_content":"想"}}]}\n\n',
        'data: {"id":"cmpl-1","choices":[{"delta":{"content":"答"}}]}\n\n',
        'data: {"id":"cmpl-1","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":3}}\n\n',
        "data: [DONE]\n\n",
      ]),
    });

    await withServer(createMockDeps({ upstreamFetch }), async (port) => {
      const res = await postMessages(port);
      assert.equal(res.status, 200);
      const text = await res.text();

      // The thinking block opens, streams, and closes BEFORE the text block.
      const order = [
        "message_start",
        "content_block_start",
        "content_block_delta",
        "content_block_delta",
        "content_block_stop",
        "content_block_start",
        "content_block_delta",
        "content_block_stop",
        "message_delta",
        "message_stop",
      ];
      assertSseEventOrder(text, order);
      assert.ok(text.includes('"thinking"'), "a thinking block must be opened");
      assert.ok(text.includes('"thinking_delta"'), "reasoning must stream as thinking_delta");
      assert.ok(text.includes("想"), "the thinking text must survive");
      assert.ok(text.includes('"text_delta"'));
      assert.ok(text.includes("答"), "the answer text must survive");
    });
  });

  it("exhausts keep-alive retries on empty streams and answers 502 with a readable message", async () => {
    let callCount = 0;
    const upstreamFetch = async () => {
      callCount += 1;
      return {
        ok: true,
        status: 200,
        body: sseStream([
          'data: {"id":"1","choices":[{"delta":{}}]}\n\n',
          "data: [DONE]\n\n",
        ]),
      };
    };

    const deps = createMockDeps({
      upstreamFetch,
      getKeepAliveConfig: () => ({ enabled: true, maxRetries: 1, backoffMs: 10 }),
    });

    await withServer(deps, async (port) => {
      const res = await postMessages(port);
      assert.equal(res.status, 502);
      const body = await res.json();
      assert.equal(body.error.type, "api_error");
      assert.match(body.error.message, /模型未返回任何内容/, "exhaustion message must be readable Chinese, not mojibake");
      // The title promises retry EXHAUSTION, so the spent-budget semantics must
      // be asserted, not just the 502: with maxRetries 1 the upstream is called
      // twice, and the wording must claim a spent budget — the never-configured
      // variant (「未配置重试」) satisfies neither of these (stream-pipe.mjs
      // anthropicExhaustedMessage distinguishes the two via retryCtx).
      assert.equal(callCount, 2, "initial attempt + exactly one keep-alive retry");
      assert.match(body.error.message, /保活重试已耗尽/, "a spent retry budget may claim exhaustion");
    });
  });

  it("a cut after reasoning keeps the bytes flowing: content lands, then a coded 502 error frame", async () => {
    // on 档不再整轮扣留：思考与正文逐字下发，无需等裁决。截断发生在两者
    // 之后，头部早已提交，故障只能走 event: error；预算为 0 时一次也不续接，
    // 于是它必须带上三槽位里的数字码，而不是让客户端以为回合正常结束。
    const upstreamFetch = async () => ({
      ok: true,
      status: 200,
      body: sseStream([
        'data: {"id":"1","choices":[{"delta":{"reasoning_content":"thinking"}}]}\n\n',
        'data: {"id":"1","choices":[{"delta":{"content":"partial answ"}}]}\n\n',
      ]),
    });

    const deps = createMockDeps({
      upstreamFetch,
      getKeepAliveConfig: () => ({ enabled: true, mode: "on", maxRetries: 0, backoffMs: 10 }),
    });

    await withServer(deps, async (port) => {
      const res = await postMessages(port);
      assert.equal(res.status, 200, "content was already on the wire, so the status line cannot carry the fault");
      const text = await res.text();
      assert.ok(text.includes("thinking"), "reasoning was streamed as it arrived, not withheld");
      assert.ok(text.includes("partial answ"), "answer text was streamed as it arrived");
      assert.ok(text.includes("event: error"), "the cut ends the turn with an event: error frame");
      const errorPayload = JSON.parse(
        text.split("\n").find((line) => line.startsWith("data:") && line.includes("\"error\"")).slice(5),
      );
      assert.equal(errorPayload.error.code, 502, "the error frame carries the numeric code");
      assert.equal(text.includes("event: message_stop"), false, "a cut turn must not look like a normal completion");
    });
  });

  it("retries a transient upstream 5xx (e.g. Cloudflare 522) before any content and delivers the recovered stream", async () => {
    let callCount = 0;
    const upstreamFetch = async () => {
      callCount += 1;
      if (callCount === 1) return { ok: false, status: 522 };
      return {
        ok: true,
        status: 200,
        body: sseStream([
          'data: {"id":"1","choices":[{"delta":{"content":"recovered from 522"},"index":0}]}\n\n',
          'data: {"id":"1","choices":[{"delta":{},"finish_reason":"stop","index":0}]}\n\n',
          "data: [DONE]\n\n",
        ]),
      };
    };

    const deps = createMockDeps({
      upstreamFetch,
      getKeepAliveConfig: () => ({ enabled: true, maxRetries: 1, backoffMs: 10 }),
    });

    await withServer(deps, async (port) => {
      const res = await postMessages(port);
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.ok(text.includes("recovered from 522"), "client must receive the retried stream after the transient 5xx");
      assert.equal(callCount, 2, "the 522 attempt plus exactly one silent retry");
    });
  });

  it("surfaces the upstream 5xx only after retries are exhausted", async () => {
    let callCount = 0;
    const upstreamFetch = async () => {
      callCount += 1;
      return { ok: false, status: 522 };
    };

    const deps = createMockDeps({
      upstreamFetch,
      getKeepAliveConfig: () => ({ enabled: true, maxRetries: 1, backoffMs: 10 }),
    });

    await withServer(deps, async (port) => {
      const res = await postMessages(port);
      assert.equal(res.status, 522);
      const body = await res.json();
      assert.match(body.error.message, /status 522/, "the terminal error must carry the upstream status");
      assert.equal(callCount, 2, "initial attempt + 1 retry, then pass through");
    });
  });

  it("resumes a mid-word cut inside the same Anthropic message", async () => {
    // Anthropic 通道的续接靠 assistant prefill，不靠「请继续」指令：留影正文
    // 作为最后一条 assistant 消息发回上游。两次生成必须落进同一个 message——
    // 一个 message_start、一个 message_stop，中间不出现错误帧。
    const bodies = [];
    let callCount = 0;
    const upstreamFetch = async (_urls, init) => {
      callCount += 1;
      bodies.push(JSON.parse(init.body));
      if (callCount === 1) {
        return {
          ok: true,
          status: 200,
          body: sseStream([
            'data: {"id":"1","choices":[{"delta":{"content":"partial "}}]}\n\n',
          ]),
        };
      }
      return {
        ok: true,
        status: 200,
        body: sseStream([
          'data: {"id":"2","choices":[{"delta":{"content":"rest"}}]}\n\n',
          'data: {"id":"2","choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
          "data: [DONE]\n\n",
        ]),
      };
    };

    const deps = createMockDeps({
      upstreamFetch,
      getKeepAliveConfig: () => ({ enabled: true, mode: "on", maxRetries: 2, backoffMs: 10 }),
    });

    await withServer(deps, async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: "POST",
        headers: { authorization: TOKEN, "content-type": "application/json" },
        body: JSON.stringify({
          model: "anthropic/test-prov/claude-test",
          system: "you are helpful",
          max_tokens: 64,
          stream: true,
          messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
        }),
      });
      assert.equal(res.status, 200);
      const text = await res.text();

      assert.ok(text.includes("partial "), "the first segment survives");
      assert.ok(text.includes("rest"), "the resumed segment is appended");
      assert.equal((text.match(/event: message_start/g) || []).length, 1, "one message only");
      assert.equal((text.match(/event: message_stop/g) || []).length, 1, "one terminator");
      assert.equal(text.includes("event: error"), false, "a resumed cut must not surface an error frame");
      assert.equal(callCount, 2, "one resume");

      // 上游只认 OpenAI 兼容形状：预填在这里会被翻译成一条 assistant 消息，
      // 内容就是客户端已经看到的那半句。
      const prefill = bodies[1].messages.at(-1);
      assert.equal(prefill.role, "assistant", "the partial output goes back as an assistant prefill");
      assert.equal(prefill.content, "partial ");
    });
  });
});
