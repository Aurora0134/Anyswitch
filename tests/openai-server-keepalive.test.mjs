import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createOpenAIRelayServer, listenLoopback } from "../src/relay/openai-server.mjs";
import { createAgentMetricsCollector } from "../src/agents/agent-metrics.mjs";
import { createEffortInjector } from "../src/catalog/effort-injection.mjs";
import { DEFAULT_SPARK_WINDOW_POINTS } from "../src/relay/relay-settings.mjs";

const TOKEN = "test-token-keepalive";

const STORE = {
  version: 2,
  providers: {
    "test-prov": {
      displayName: "Test Provider",
      baseURL: "https://upstream.invalid/v1",
      protocol: "openai-compatible",
      credentialFile: "test.dpapi",
      models: { "gpt-test": { displayName: "GPT Test" } },
    },
  },
};

// effort 注入与图片降级两门钉死为关（与 openai-server-chain.test.mjs 同一桩）：
// 不注入时 handler 回落 relay-settings 的磁盘现读默认（openai-handler.mjs
// `effortInjector ?? defaultEffortInjector`），逐请求读本机 %LOCALAPPDATA%\Anyswitch
// 下的 settings.json 与 thinking-efforts 库，测试结果就会挂在本机用户目录上。
// isEnabled 短路在目录/开关读取之前，注入器全程不落盘。
const OFF_EFFORT_INJECTOR = createEffortInjector({ isEnabled: () => false });

function createIsolatedCollector(extra = {}) {
  return createAgentMetricsCollector({
    nowFn: () => 1000,
    execFn: (cmd, opts, cb) => cb(null, ""),
    // getAgentsStatus 每次都会经 loadSettings() 现读本机 settings.json 取折线
    // 视窗（agent-metrics.mjs 的 loadSparkSettings 三元）。注意传 false 挡不住：
    // false||null 后仍回落 loadSettings 照样读盘（已用重定向 LOCALAPPDATA 的
    // 探针实测，sparkWindowPoints:5 仍生效）；必须给函数桩，且返回出厂窗口值，
    // 让 applySparkWindow 的新旧比较恒等、零副作用。
    loadSparkSettings: () => ({ sparkWindowPoints: DEFAULT_SPARK_WINDOW_POINTS }),
    ...extra,
  });
}

function createMockDeps({ upstreamFetch, getKeepAliveConfig, metricsCollector }) {
  return {
    token: TOKEN,
    loadStore: () => ({ ok: true, store: STORE }),
    loadCredential: async () => ({ ok: true, value: "TEST_SECRET" }),
    upstreamFetch,
    recordGeneration: () => {},
    readGeneration: () => null,
    getKeepAliveConfig,
    metricsCollector,
    effortInjector: OFF_EFFORT_INJECTOR,
    imageFallbackGate: () => false,
    imageHeuristicGate: () => false,
  };
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

function postChat(port, { signal, headers } = {}) {
  return fetch(`http://127.0.0.1:${port}/openai/test-prov/v1/chat/completions`, {
    method: "POST",
    // 显式端点身份：断言都挂在 zcode 卡上（旧语义里的默认兜底桶）。
    // 归属四通道全落空现在是「无归属不显示」，裸请求不再计到任何卡片。
    headers: { authorization: TOKEN, "content-type": "application/json", "x-agent-id": "zcode", ...headers },
    body: JSON.stringify({
      model: "gpt-test",
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    }),
    signal,
  });
}

function sseStream(chunks) {
  return (async function* () {
    const enc = new TextEncoder();
    for (const c of chunks) yield enc.encode(c);
  })();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 轮询到条件成立为止；超时即失败（绝不静默放过——条件没等到就是测试本身没跑到位）。
async function waitUntil(cond, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`waitUntil(${label}) timed out after ${timeoutMs}ms`);
    await sleep(2);
  }
}

describe("openai relay keep-alive anti-truncation", () => {
  it("(a) recovers on empty stream via 1 keep-alive retry and delivers successful stream to client", async () => {
    let callCount = 0;
    const upstreamFetch = async () => {
      callCount += 1;
      if (callCount === 1) {
        // First attempt: clean empty stream (no text deltas)
        return {
          ok: true,
          status: 200,
          body: sseStream([
            'data: {"id":"1","choices":[{"delta":{}}]}\n\n',
            "data: [DONE]\n\n",
          ]),
        };
      }
      // Second attempt: healthy stream
      return {
        ok: true,
        status: 200,
        body: sseStream([
          'data: {"id":"2","choices":[{"delta":{"content":"recovered text"}}]}\n\n',
          "data: [DONE]\n\n",
        ]),
      };
    };

    const collector = createIsolatedCollector();
    const deps = createMockDeps({
      upstreamFetch,
      getKeepAliveConfig: () => ({ enabled: true, maxRetries: 1, backoffMs: 10 }),
      metricsCollector: collector,
    });

    await withServer(deps, async (port) => {
      const res = await postChat(port);
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.ok(text.includes("recovered text"), "client must receive healthy payload from retried stream");
      assert.equal(callCount, 2, "upstream should have been called twice (1 retry)");

      const status = await collector.getAgentsStatus();
      const zcode = status.find((a) => a.id === "zcode");
      assert.equal(zcode.errorActive, false, "first chunk of successful stream clears fault latch");
      assert.equal(zcode.metrics.keepAlive.retries, 1, "keepAlive retries counter incremented");
      assert.equal(zcode.metrics.keepAlive.recoveries, 1, "keepAlive recoveries counter incremented");

      const stability = await collector.getModelStability();
      const m = stability.models.find((x) => x.model === "gpt-test");
      assert.ok(m, "model-stability should include the retried model");
      assert.equal(m.total, 2, "the failed attempt must also count toward call volume");
      assert.equal(m.successRate, 50.0, "success rate must reflect the absorbed failure");
    });
  });

  // 夹具故意不带 mode：这是 per-launch 兜底中继的现役配置形状——8 个
  // *-launcher.mjs 的 createOpenAIProductionDeps() 都不转发 getKeepAliveConfig，
  // 运行时落到 stream-pipe.mjs 的内置兜底 {enabled:true,maxRetries:1,backoffMs:500}
  // （同样无 mode）→ 非 on 档、不续接，首字前耗尽走 502 JSON。
  // 面板常驻链路的 parseKeepAliveConfig 产物恒带 mode:"on"，同一场景走 (A4) 的
  // 200+SSE。两条分支都是现役行为，各有用例钉住，502 与 SSE 并不自相矛盾。
  it("(b) exhausts retries when all attempts return empty stream, returns 502 and keeps fault latched", async () => {
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

    const collector = createIsolatedCollector();
    const deps = createMockDeps({
      upstreamFetch,
      getKeepAliveConfig: () => ({ enabled: true, maxRetries: 1, backoffMs: 10 }),
      metricsCollector: collector,
    });

    await withServer(deps, async (port) => {
      const res = await postChat(port);
      assert.equal(res.status, 502);
      const body = await res.json();
      assert.equal(body.error.type, "api_error");
      assert.match(body.error.message, /模型未返回任何内容/);
      assert.match(body.error.message, /保活重试已耗尽/, "a spent retry budget may claim exhaustion");
      assert.equal(callCount, 2, "initial attempt + 1 retry = 2 calls");

      const status = await collector.getAgentsStatus();
      const zcode = status.find((a) => a.id === "zcode");
      assert.equal(zcode.errorActive, true, "fault must stay latched on panel until next genuine first chunk");
      assert.equal(zcode.metrics.keepAlive.retries, 1);
      assert.equal(zcode.metrics.keepAlive.exhausted, 1);

      const stability = await collector.getModelStability();
      const m = stability.models.find((x) => x.model === "gpt-test");
      assert.ok(m, "model-stability should include the exhausted model");
      assert.equal(m.total, 2, "both exhausted attempts must count");
      assert.equal(m.successRate, 0.0, "success rate must be zero when all attempts failed");
    });
  });

  it("(b2) silently retries a transient upstream 5xx and counts the failed attempt in stability", async () => {
    let callCount = 0;
    const upstreamFetch = async () => {
      callCount += 1;
      if (callCount === 1) {
        return {
          ok: false,
          status: 503,
          body: { error: { message: "upstream unavailable" } },
        };
      }
      return {
        ok: true,
        status: 200,
        body: sseStream([
          'data: {"id":"2","choices":[{"delta":{"content":"recovered after 503"}}]}\n\n',
          "data: [DONE]\n\n",
        ]),
      };
    };

    const collector = createIsolatedCollector();
    const deps = createMockDeps({
      upstreamFetch,
      getKeepAliveConfig: () => ({ enabled: true, maxRetries: 1, backoffMs: 10 }),
      metricsCollector: collector,
    });

    await withServer(deps, async (port) => {
      const res = await postChat(port);
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.ok(text.includes("recovered after 503"), "client must receive the retried stream");
      assert.equal(callCount, 2, "upstream 503 must be silently retried once");

      const stability = await collector.getModelStability();
      const m = stability.models.find((x) => x.model === "gpt-test");
      assert.ok(m, "model-stability should include the retried model");
      assert.equal(m.total, 2, "the 503 attempt and the successful retry both count");
      assert.equal(m.successRate, 50.0, "success rate must reflect the absorbed 503 failure");
    });
  });

  it("(c) does NOT retry when keepAlive is disabled via config", async () => {
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

    const collector = createIsolatedCollector();
    const deps = createMockDeps({
      upstreamFetch,
      getKeepAliveConfig: () => ({ enabled: false, maxRetries: 1, backoffMs: 10 }),
      metricsCollector: collector,
    });

    await withServer(deps, async (port) => {
      const res = await postChat(port);
      assert.equal(res.status, 502);
      const body = await res.json();
      assert.match(body.error.message, /未配置重试/, "zero-retry exhaustion must not claim a spent budget");
      assert.doesNotMatch(body.error.message, /已耗尽/);
      assert.equal(callCount, 1, "zero retry when enabled:false");

      const status = await collector.getAgentsStatus();
      const zcode = status.find((a) => a.id === "zcode");
      assert.equal(zcode.metrics.keepAlive.exhausted, 0, "nothing was exhausted when no retry budget existed");
      assert.equal(zcode.metrics.keepAlive.retries, 0);
    });
  });

  // 无 mode 夹具同 (b)：per-launch 兜底中继的现役配置形状，耗尽契约是 502 JSON
  // 而非 on 档续接后的 200+SSE。逐端点开关的语义由 callCount 断言独立承载，
  // 在任一档位下都成立；状态断言只负责钉住这条分支的客户端可见契约。
  it("(c2) does NOT retry on an endpoint switched off in the panel, while other endpoints keep retrying", async () => {
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

    const collector = createIsolatedCollector();
    const deps = createMockDeps({
      upstreamFetch,
      getKeepAliveConfig: () => ({ enabled: true, maxRetries: 1, backoffMs: 10, endpoints: { dsh: { enabled: false } } }),
      metricsCollector: collector,
    });

    await withServer(deps, async (port) => {
      const switchedOff = await postChat(port, { headers: { "x-agent-id": "dsh" } });
      assert.equal(switchedOff.status, 502);
      assert.equal(callCount, 1, "an endpoint with its own switch off must not retry");

      const inheriting = await postChat(port, { headers: { "x-agent-id": "kimi" } });
      assert.equal(inheriting.status, 502);
      assert.equal(callCount, 3, "an endpoint absent from the map inherits the master switch and retries once");
    });
  });

  // 无 mode 夹具同 (b)：per-launch 兜底中继的现役形状——守卫非整轮持有，内容
  // 逐块下发（字节真会中途提交），且 maxRetries 照常生效，所以「已提交压过重试
  // 预算」在这里是可区分的真语义：bytes 已到客户端后再炸，不重试，客户端拿到
  // partial content + mid-response 错误帧（stream-pipe.mjs 的 committed 分支）。
  it("(d) does NOT retry when stream was already committed (bytes delivered mid-response)", async () => {
    let callCount = 0;
    const upstreamFetch = async () => {
      callCount += 1;
      return {
        ok: true,
        status: 200,
        body: (async function* () {
          const enc = new TextEncoder();
          yield enc.encode('data: {"id":"1","choices":[{"delta":{"content":"partial content"}}]}\n\n');
          // Then abrupt socket throw mid-stream
          throw new Error("upstream socket died");
        })(),
      };
    };

    const deps = createMockDeps({
      upstreamFetch,
      getKeepAliveConfig: () => ({ enabled: true, maxRetries: 1, backoffMs: 10 }),
    });

    await withServer(deps, async (port) => {
      const res = await postChat(port);
      assert.equal(res.status, 200, "headers were already sent 200");
      const text = await res.text();
      assert.ok(text.includes("partial content"));
      assert.ok(text.includes("the upstream stream failed mid-response"));
      assert.equal(callCount, 1, "must NOT retry once bytes were already committed to client");
    });
  });

  it("(f) retries when a gateway keep-alive `data:` line precedes an otherwise-empty stream", async () => {
    // Gateway keep-alive shape: an empty `data:` ping line must not disarm the
    // stream guard, or a truncated stream would look like a normal completion
    // and the retry would never fire. It is classified empty and retried.
    let callCount = 0;
    const upstreamFetch = async () => {
      callCount += 1;
      if (callCount === 1) {
        return {
          ok: true,
          status: 200,
          body: sseStream([
            "data:\n\n",
            'data: {"id":"1","choices":[{"delta":{}}]}\n\n',
            "data: [DONE]\n\n",
          ]),
        };
      }
      return {
        ok: true,
        status: 200,
        body: sseStream([
          'data: {"id":"2","choices":[{"delta":{"content":"recovered text"}}]}\n\n',
          "data: [DONE]\n\n",
        ]),
      };
    };

    const collector = createIsolatedCollector();
    const deps = createMockDeps({
      upstreamFetch,
      getKeepAliveConfig: () => ({ enabled: true, maxRetries: 1, backoffMs: 10 }),
      metricsCollector: collector,
    });

    await withServer(deps, async (port) => {
      const res = await postChat(port);
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.ok(text.includes("recovered text"), "client must receive the retried stream's payload");
      assert.ok(!text.includes("[DONE]\n\ndata:"), "no duplicated terminator from the failed attempt");
      assert.equal(callCount, 2, "empty-ping stream must trigger the keep-alive retry");

      const status = await collector.getAgentsStatus();
      const zcode = status.find((a) => a.id === "zcode");
      assert.equal(zcode.metrics.keepAlive.retries, 1);
      assert.equal(zcode.metrics.keepAlive.recoveries, 1);
      assert.equal(zcode.errorActive, false);
      assert.ok(!zcode.lastError, "a recovered request must not leave a stale fault entry");
    });
  });

  it("(e) immediately halts retry loop when client disconnects/aborts during backoff", async () => {
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

    const ac = new AbortController();
    const deps = createMockDeps({
      upstreamFetch,
      getKeepAliveConfig: () => ({ enabled: true, maxRetries: 2, backoffMs: 200 }),
    });

    await withServer(deps, async (port) => {
      const p = postChat(port, { signal: ac.signal });
      // 旧版用 setTimeout(20ms) 盲等，带两个竞态：abort 可能抢在首轮上游调用
      // 之前（callCount=0，假红）；而断言紧跟 await p 立即采样，落在退避窗
      // （backoffMs 200 → computeRetryDelay 100–200ms，keepalive-backoff.mjs）
      // 之前——忽略 abort 的实现要到 ~100ms 后才发起第二次调用，恒然断不到，
      // 对缺陷永远假绿。所以改为：先等首轮调用确实发生，再 abort；然后等过
      // 一个完整退避窗以上才断言，给「忽略 abort 的重试」留出暴露窗口。
      await waitUntil(() => callCount === 1, 2_000, "first upstream call");
      ac.abort();
      try {
        await p;
      } catch {
        /* client abort error expected */
      }
      await sleep(400); // > 最长退避 200ms
      assert.equal(callCount, 1, "must not perform subsequent retries after client aborts");
    });
  });
});

describe("on tier: mid-response truncation is resumed, not held", () => {
  it("(A1) resumes a mid-word cut after reasoning; the client sees one continuous turn", async () => {
    let callCount = 0;
    const upstreamFetch = async () => {
      callCount += 1;
      if (callCount === 1) {
        // reasoning-first stream cut mid-word: no [DONE], no finish_reason
        return {
          ok: true,
          status: 200,
          body: sseStream([
            'data: {"id":"1","choices":[{"delta":{"role":"assistant","reasoning_content":"thinking"}}]}\n\n',
            'data: {"id":"1","choices":[{"delta":{"content":"partial answ"}}]}\n\n',
          ]),
        };
      }
      return {
        ok: true,
        status: 200,
        body: sseStream([
          'data: {"id":"2","choices":[{"delta":{"role":"assistant","reasoning_content":"thinking"}}]}\n\n',
          'data: {"id":"2","choices":[{"delta":{"content":"full answer"}}]}\n\n',
          'data: {"id":"2","choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
          "data: [DONE]\n\n",
        ]),
      };
    };

    const collector = createIsolatedCollector();
    const deps = createMockDeps({
      upstreamFetch,
      getKeepAliveConfig: () => ({ enabled: true, mode: "on", maxRetries: 1, backoffMs: 10 }),
      metricsCollector: collector,
    });

    await withServer(deps, async (port) => {
      const res = await postChat(port);
      assert.equal(res.status, 200);
      const text = await res.text();
      // 抗截断不再整段扣住：第一段照常下发，续接段接在后面，客户端看到的是
      // 一条带接缝的完整回复——这与「手动截断后发继续」是同一形状。
      assert.ok(text.includes("partial answ"), "the first segment reaches the client as it streams");
      assert.ok(text.includes("full answer"), "the resumed segment is appended");
      assert.ok(!text.includes('"error"'), "a resumed turn carries no error frame");
      assert.equal((text.match(/data: \[DONE\]/g) || []).length, 1, "exactly one terminator");
      assert.equal(callCount, 2);

      const status = await collector.getAgentsStatus();
      const zcode = status.find((a) => a.id === "zcode");
      assert.equal(zcode.metrics.keepAlive.retries, 1);
      assert.equal(zcode.metrics.keepAlive.recoveries, 1);
      assert.equal(zcode.errorActive, false);
    });
  });

  it("(A2) exhausts the resume budget on repeated truncation; the error frame carries 502", async () => {
    const upstreamFetch = async () => ({
      ok: true,
      status: 200,
      body: sseStream([
        'data: {"id":"1","choices":[{"delta":{"reasoning_content":"r"}}]}\n\n',
        'data: {"id":"1","choices":[{"delta":{"content":"cut mid"}}]}\n\n',
      ]),
    });

    const collector = createIsolatedCollector();
    const deps = createMockDeps({
      upstreamFetch,
      getKeepAliveConfig: () => ({ enabled: true, mode: "on", maxRetries: 1, backoffMs: 10 }),
      metricsCollector: collector,
    });

    await withServer(deps, async (port) => {
      const res = await postChat(port);
      assert.equal(res.status, 200, "content was already streaming; the error must ride SSE");
      const text = await res.text();
      assert.ok(text.includes("cut mid"), "the first segment legitimately reached the client");
      assert.ok(text.includes('"error"'), "a structured error event ends the turn");
      assert.ok(!/\ndata: \[DONE\]/.test(text), "no bare [DONE] terminator line may ride along");
      const errorPayload = JSON.parse(
        text.split("\n").find((line) => line.startsWith("data:") && line.includes('"error"')).slice(5),
      );
      assert.equal(errorPayload.error.code, 502, "the terminal frame names the upstream-incomplete code");

      const status = await collector.getAgentsStatus();
      const zcode = status.find((a) => a.id === "zcode");
      assert.equal(zcode.errorActive, true, "exhaustion must latch the panel fault");
      assert.equal(zcode.metrics.keepAlive.exhausted, 1);
    });
  });

  it("(A3) healthy reasoning-first turn passes through with content intact", async () => {
    let callCount = 0;
    const upstreamFetch = async () => {
      callCount += 1;
      return {
        ok: true,
        status: 200,
        body: sseStream([
          'data: {"id":"1","choices":[{"delta":{"role":"assistant","reasoning_content":"think"}}]}\n\n',
          'data: {"id":"1","choices":[{"delta":{"content":"hello"}}]}\n\n',
          'data: {"id":"1","choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
          "data: [DONE]\n\n",
        ]),
      };
    };

    const collector = createIsolatedCollector();
    const deps = createMockDeps({
      upstreamFetch,
      getKeepAliveConfig: () => ({ enabled: true, mode: "on", maxRetries: 1, backoffMs: 10 }),
      metricsCollector: collector,
    });

    await withServer(deps, async (port) => {
      const res = await postChat(port);
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.ok(text.includes("reasoning_content"));
      assert.ok(text.includes("hello"));
      assert.ok(text.includes("[DONE]"));
      assert.equal(callCount, 1, "healthy turns must not be retried");
      const status = await collector.getAgentsStatus();
      const zcode = status.find((a) => a.id === "zcode");
      assert.equal(zcode.metrics.keepAlive.retries, 0);
    });
  });

  it("(A1b) a malformed JSON data line is dropped and the turn is resumed", async () => {
    let callCount = 0;
    const truncated =
      'data: {"choices":[{"delta":{"reasoning_content":" DNS","role":"assistant"},"index":0}],"created":1,"id":"x","model":"glm-5.3","object":"chat.completion.chunk"\n\n';
    const upstreamFetch = async () => {
      callCount += 1;
      if (callCount === 1) {
        return {
          ok: true,
          status: 200,
          body: sseStream([
            truncated,
            'data: {"id":"1","choices":[{"delta":{"content":"hello"}}]}\n\n',
            'data: {"id":"1","choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
            "data: [DONE]\n\n",
          ]),
        };
      }
      return {
        ok: true,
        status: 200,
        body: sseStream([
          'data: {"id":"2","choices":[{"delta":{"content":"recovered text"}}]}\n\n',
          "data: [DONE]\n\n",
        ]),
      };
    };
    const collector = createIsolatedCollector();
    const deps = createMockDeps({
      upstreamFetch,
      getKeepAliveConfig: () => ({ enabled: true, mode: "on", maxRetries: 1, backoffMs: 10 }),
      metricsCollector: collector,
    });
    await withServer(deps, async (port) => {
      const res = await postChat(port);
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.ok(!text.includes("chat.completion.chunk"), "truncated JSON line must not reach the client");
      assert.ok(text.includes("recovered text"));
      assert.equal(callCount, 2);
    });
  });

  it("(A3b) an empty stream still retries and recovers", async () => {
    let callCount = 0;
    const upstreamFetch = async () => {
      callCount += 1;
      if (callCount === 1) {
        return {
          ok: true,
          status: 200,
          body: sseStream([
            'data: {"id":"1","choices":[{"delta":{}}]}\n\n',
            "data: [DONE]\n\n",
          ]),
        };
      }
      return {
        ok: true,
        status: 200,
        body: sseStream([
          'data: {"id":"2","choices":[{"delta":{"content":"recovered text"}}]}\n\n',
          "data: [DONE]\n\n",
        ]),
      };
    };
    const collector = createIsolatedCollector();
    const deps = createMockDeps({
      upstreamFetch,
      getKeepAliveConfig: () => ({ enabled: true, mode: "on", maxRetries: 1, backoffMs: 10 }),
      metricsCollector: collector,
    });
    await withServer(deps, async (port) => {
      const res = await postChat(port);
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.ok(text.includes("recovered text"), "client must receive the retried healthy payload");
      assert.equal(callCount, 2);
      const status = await collector.getAgentsStatus();
      const zcode = status.find((a) => a.id === "zcode");
      assert.equal(zcode.metrics.keepAlive.retries, 1);
      assert.equal(zcode.metrics.keepAlive.recoveries, 1);
    });
  });

  it("(A4) an empty-stream exhaustion returns a real HTTP 502, not a 200 with an error frame", async () => {
    // 整段扣住取消后，空流耗尽时 SSE 头还没发出去——这正是「off 档能发真实
    // 状态码」的同一条性质在 on 档的延续：能发状态码就不要只发错误帧。
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
    const collector = createIsolatedCollector();
    const deps = createMockDeps({
      upstreamFetch,
      getKeepAliveConfig: () => ({ enabled: true, mode: "on", maxRetries: 1, backoffMs: 10 }),
      metricsCollector: collector,
    });
    await withServer(deps, async (port) => {
      const res = await postChat(port);
      assert.equal(res.status, 502, "nothing was committed, so the status line can still carry the fault");
      const text = await res.text();
      assert.match(text, /模型未返回任何内容/);
      assert.equal(callCount, 2);
    });
  });

  it("(A5) timestamps the upstream first token so TPS measures the generation segment", async () => {
    // TPS = completion over the generation segment (first token → end), not
    // over the whole request (which would fold the TTFT into the denominator
    // and understate the speed by the TTFT share).
    let fakeNow = 1000;
    const upstreamFetch = async () => ({
      ok: true,
      status: 200,
      body: (async function* () {
        const enc = new TextEncoder();
        await new Promise((r) => setTimeout(r, 25)); // ordering only; the clock is fakeNow
        fakeNow += 400; // upstream TTFT (queue + prefill)
        yield enc.encode('data: {"id":"1","choices":[{"index":0,"delta":{"content":"hello world"}}]}\n\n');
        await new Promise((r) => setTimeout(r, 25));
        fakeNow += 300; // generation segment
        yield enc.encode('data: {"id":"1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":100,"completion_tokens":20}}\n\n');
        yield enc.encode("data: [DONE]\n\n");
      })(),
    });
    const collector = createIsolatedCollector({ nowFn: () => fakeNow });
    const deps = createMockDeps({
      upstreamFetch,
      getKeepAliveConfig: () => ({ enabled: true, mode: "on", maxRetries: 1, backoffMs: 10 }),
      metricsCollector: collector,
    });
    await withServer(deps, async (port) => {
      const res = await postChat(port);
      assert.equal(res.status, 200);
      await res.text();
      const status = await collector.getAgentsStatus();
      const zcode = status.find((a) => a.id === "zcode");
      // 20 tokens over a 300ms generation segment → ~66.7 tok/s. Measuring over
      // the whole 700ms request instead would give 28.6, so the two are separable.
      assert.ok(Math.abs(zcode.metrics.tps - 66.7) < 1, `tps must reflect the generation segment, got ${zcode.metrics.tps}`);
      assert.ok(Math.abs(zcode.metrics.lastTtftMs - 400) < 5, `ttft must reflect the upstream first token, got ${zcode.metrics.lastTtftMs}`);
    });
  });
});
describe("keep-alive resume (mid-response truncation, on tier)", () => {
  it("resumes a mid-word cut: the client sees one SSE stream with no error frame", async () => {
    let callCount = 0;
    const upstreamFetch = async () => {
      callCount += 1;
      if (callCount === 1) {
        // First attempt: partial output, then the TCP stream dies mid-word.
        return {
          ok: true,
          status: 200,
          body: sseStream([
            'data: {"id":"cmpl-1","choices":[{"delta":{"content":"partial output that got cut "}}]}\n\n',
          ]),
        };
      }
      // Resume attempt: the relay re-issued the request with the partial
      // output appended; the upstream continues from it.
      return {
        ok: true,
        status: 200,
        body: sseStream([
          'data: {"id":"cmpl-2","choices":[{"delta":{"content":"and here is the rest"}}]}\n\n',
          'data: {"id":"cmpl-2","choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
          "data: [DONE]\n\n",
        ]),
      };
    };

    const collector = createIsolatedCollector();
    const deps = createMockDeps({
      upstreamFetch,
      getKeepAliveConfig: () => ({ enabled: true, mode: "on", maxRetries: 2, backoffMs: 10 }),
      metricsCollector: collector,
    });

    await withServer(deps, async (port) => {
      const res = await postChat(port);
      assert.equal(res.status, 200);
      const text = await res.text();

      // The client sees one continuous stream: the first part, then the
      // resumed part, then exactly one [DONE].
      assert.ok(text.includes("partial output that got cut"), "the first part must survive");
      assert.ok(text.includes("and here is the rest"), "the resumed part must be appended");
      assert.ok(!text.includes('"error"'), "no error frame may appear mid-stream");
      const doneCount = (text.match(/data: \[DONE\]/g) || []).length;
      assert.equal(doneCount, 1, "exactly one terminator");
      assert.equal(callCount, 2, "upstream was called twice (1 resume)");
    });
  });

  it("a think-only turn is resumed: the client sees reasoning, then the answer", async () => {
    let callCount = 0;
    const upstreamFetch = async () => {
      callCount += 1;
      if (callCount === 1) {
        return {
          ok: true,
          status: 200,
          body: sseStream([
            'data: {"id":"cmpl-1","choices":[{"delta":{"reasoning_content":"thinking"}}]}\n\n',
            'data: {"id":"cmpl-1","choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
            "data: [DONE]\n\n",
          ]),
        };
      }
      return {
        ok: true,
        status: 200,
        body: sseStream([
          'data: {"id":"cmpl-2","choices":[{"delta":{"content":"the answer"}}]}\n\n',
          'data: {"id":"cmpl-2","choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
          "data: [DONE]\n\n",
        ]),
      };
    };

    const deps = createMockDeps({
      upstreamFetch,
      getKeepAliveConfig: () => ({ enabled: true, mode: "on", maxRetries: 1, backoffMs: 10 }),
    });

    await withServer(deps, async (port) => {
      const res = await postChat(port);
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.ok(text.includes("thinking"), "reasoning must survive");
      assert.ok(text.includes("the answer"), "the resumed answer must be appended");
      assert.ok(!text.includes('"error"'));
      const doneCount = (text.match(/data: \[DONE\]/g) || []).length;
      assert.equal(doneCount, 1, "exactly one terminator");
      assert.equal(callCount, 2, "upstream was called twice (1 resume)");
    });
  });

  it("budget exhausted: the error frame carries 502 and no [DONE] follows", async () => {
    const upstreamFetch = async () => ({
      ok: true,
      status: 200,
      body: sseStream([
        'data: {"id":"cmpl-1","choices":[{"delta":{"content":"partial output"}}]}\n\n',
      ]),
    });

    const deps = createMockDeps({
      upstreamFetch,
      getKeepAliveConfig: () => ({ enabled: true, mode: "on", maxRetries: 1, backoffMs: 10 }),
    });

    await withServer(deps, async (port) => {
      const res = await postChat(port);
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.ok(text.includes("partial output"), "the first part must survive");
      assert.ok(text.includes('"error"'), "budget exhaustion must end in an error frame");
      assert.ok(!text.split("\n").some((line) => line.trim() === "data: [DONE]"), "no terminator after a failed resume");
      const errorPayload = JSON.parse(
        text.split("\n").find((line) => line.startsWith("data:") && line.includes('"error"')).slice(5),
      );
      assert.match(errorPayload.error.message, /续接 1 次仍未完成/, "the message names how many resumes were spent");
    });
  });

  it("a second cut resumes from everything the client has seen, not just the last segment", async () => {
    // Three attempts: two cuts then a clean finish. Each resume request must
    // carry the accumulated output; carrying only the last segment would
    // restart the model mid-sentence.
    const bodies = [];
    let callCount = 0;
    const upstreamFetch = async (_urls, init) => {
      callCount += 1;
      bodies.push(JSON.parse(init.body));
      if (callCount === 1) {
        return {
          ok: true,
          status: 200,
          body: sseStream(['data: {"id":"c1","choices":[{"delta":{"content":"part one "}}]}\n\n']),
        };
      }
      if (callCount === 2) {
        return {
          ok: true,
          status: 200,
          body: sseStream(['data: {"id":"c2","choices":[{"delta":{"content":"part two "}}]}\n\n']),
        };
      }
      return {
        ok: true,
        status: 200,
        body: sseStream([
          'data: {"id":"c3","choices":[{"delta":{"content":"end"}}]}\n\n',
          'data: {"id":"c3","choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
          "data: [DONE]\n\n",
        ]),
      };
    };

    const deps = createMockDeps({
      upstreamFetch,
      getKeepAliveConfig: () => ({ enabled: true, mode: "on", maxRetries: 2, backoffMs: 10 }),
    });

    await withServer(deps, async (port) => {
      const res = await postChat(port);
      const text = await res.text();
      assert.ok(text.includes("part one "), "first segment survives");
      assert.ok(text.includes("part two "), "second segment appended");
      assert.ok(text.includes("end"), "third segment appended");
      assert.equal((text.match(/data: \[DONE\]/g) || []).length, 1, "exactly one terminator");
      assert.equal(callCount, 3, "two resumes");

      // 末条是续写指令（user），assistant 预填在它前面。
      const secondPrefill = bodies[1].messages.at(-2);
      assert.equal(secondPrefill.role, "assistant");
      assert.equal(secondPrefill.content, "part one ", "the first resume carries the first segment");
      const thirdPrefill = bodies[2].messages.at(-2);
      assert.equal(thirdPrefill.content, "part one part two ", "the second resume carries both segments");
    });
  });

  it("drops a tool call the resumed segment replays verbatim", async () => {
    // 模型偶尔会把切断前已经做完的调用再发一遍。第二次下发会让工具跑两遍。
    // 第一个调用由第二个调用的起始帧闭合（已下发），截断落在第二个调用的参数
    // 中途；续接段重放第一个调用时必须被丢掉。
    let callCount = 0;
    const upstreamFetch = async () => {
      callCount += 1;
      if (callCount === 1) {
        return {
          ok: true,
          status: 200,
          body: sseStream([
            'data: {"id":"c1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_a","function":{"name":"read","arguments":"{\\"path\\":\\"a.txt\\"}"}}]}}]}\n\n',
            'data: {"id":"c1","choices":[{"index":0,"delta":{"tool_calls":[{"index":1,"id":"call_b","function":{"name":"read","arguments":"{\\"path\\":\\"b"}}]}}]}\n\n',
          ]),
        };
      }
      return {
        ok: true,
        status: 200,
        body: sseStream([
          'data: {"id":"c2","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_a","function":{"name":"read","arguments":"{\\"path\\":\\"a.txt\\"}"}}]}}]}\n\n',
          'data: {"id":"c2","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
          "data: [DONE]\n\n",
        ]),
      };
    };

    const deps = createMockDeps({
      upstreamFetch,
      getKeepAliveConfig: () => ({ enabled: true, mode: "on", maxRetries: 1, backoffMs: 10 }),
    });

    await withServer(deps, async (port) => {
      const res = await postChat(port);
      const text = await res.text();
      const frames = text.split("\n").filter((line) => line.includes("call_a"));
      assert.equal(frames.length, 1, "the replayed call is dropped, not forwarded twice");
      assert.equal(callCount, 2, "one resume");
      assert.equal((text.match(/data: \[DONE\]/g) || []).length, 1, "exactly one terminator");
    });
  });
});
