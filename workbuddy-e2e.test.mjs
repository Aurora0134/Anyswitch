// 覆盖边界：workbuddy 配置写入器 → URL/模型 id 解析 → relay 归属 → 上游重写
// 这一条接缝。
//
//   1. workbuddy-merge-models.mjs 的 buildWorkbuddyModels 产出的 url / id
//   2. openai-path.mjs 的 parseOpenAIPath 对 url path 段的解析（agentHint / providerId）
//   3. openai-server.mjs 的 chat/completions 路由：slug 剥壳、归属、上游 URL 与 body
//
// 不覆盖：指标状态机（agent-metrics 的窗口/TTFT/稳定性）、真实网络与真实凭据、
// 池/链扇出、Responses / Anthropic 通道。上游是假实现，relay 只在本进程里被
// 派发一次请求（never listens），端口是写进配置的固定数字。
//
// 注：仓库里没有「一次调用同时返回上游与归属」的导出函数；本用例用
// createOpenAIRelayServer 的 request 监听器在进程内直接派发（openai-server.test.mjs
// 同一 DI 形状），归属从 metricsCollector.startRequest 的 meta 读取——那才是
// agentId/providerId 的实际落点；recordGeneration 是 /v1/models 的目录代际绑定，
// 不携带归属（见报告）。

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";

import { buildWorkbuddyModels, deriveAnyswitchChannel } from "./workbuddy-merge-models.mjs";
import { parseOpenAIPath } from "./openai-path.mjs";
import { packChannelModelSlug } from "./channel-model-slug.mjs";
import { AUTO_CHANNEL_KEY } from "./merge-common.mjs";
import { createOpenAIRelayServer } from "./openai-server.mjs";

const TOKEN = "workbuddy-e2e-token";
const PORT = 47821; // 只写进配置；本用例从不监听这个端口
const CHANNEL_ID = "poke-api";
const CHANNEL_BASE = "https://upstream.invalid/v1";
const MODEL_ID = "claude-opus-5";
const SECOND_MODEL_ID = "claude-sonnet-5";
const UPSTREAM_KEY = "SENTINEL-UPSTREAM-KEY";

// provider 形状与 openai-server.test.mjs 的合成 store 一致（displayName /
// baseURL / protocol / credentialFile / models），外加写手用的 channelName。
const PROVIDERS = {
  [CHANNEL_ID]: {
    displayName: "Poke",
    channelName: "Poke",
    baseURL: CHANNEL_BASE,
    protocol: "openai-compatible",
    credentialFile: "poke-api.dpapi",
    models: {
      [MODEL_ID]: { displayName: "Opus 5" },
      [SECOND_MODEL_ID]: { displayName: "Sonnet 5" },
    },
  },
};

const STORE = {
  version: 2,
  providers: PROVIDERS,
  // 让 deriveAnyswitchChannel 产出伪渠道（auto），从而覆盖裸模型名那一档。
  routingChains: {
    workbuddy: { enabled: true, chain: [{ node: CHANNEL_ID, model: MODEL_ID }] },
  },
};

function buildConfig() {
  const autoChannel = deriveAnyswitchChannel(STORE, "workbuddy");
  assert.ok(autoChannel, "synthetic store must yield the Anyswitch pseudo-channel");
  return buildWorkbuddyModels(null, PROVIDERS, PORT, TOKEN, autoChannel).config;
}

// 进程内派发：直接调用 createServer 的 request 监听器，不 listen、不占端口。
function dispatchChat(server, path, body) {
  const listener = server.listeners("request")[0];
  assert.equal(typeof listener, "function", "relay request listener is reachable without listening");

  const req = Readable.from([Buffer.from(JSON.stringify(body), "utf8")]);
  req.method = "POST";
  req.url = path;
  // 刻意不带 user-agent：WorkBuddy 的真机请求会 delete 它，身份只能来自 URL 段。
  req.headers = { authorization: TOKEN, "content-type": "application/json" };
  req.socket = { remoteAddress: "127.0.0.1", localPort: 0, remotePort: 0 };

  const res = new EventEmitter();
  res.status = null;
  res.headers = null;
  res.body = "";
  res.headersSent = false;
  res.writableEnded = false;
  res.writeHead = (status, headers) => {
    res.status = status;
    res.headers = headers;
    res.headersSent = true;
    return res;
  };
  res.write = (chunk) => {
    res.body += chunk;
    return true;
  };
  res.end = (chunk) => {
    if (chunk !== undefined) res.body += chunk;
    res.writableEnded = true;
    res.emit("finish");
    return res;
  };
  res.flushHeaders = () => {
    res.headersSent = true;
  };

  return listener(req, res).then(() => res);
}

function makeDeps(captured) {
  return {
    token: TOKEN,
    loadStore: () => ({ ok: true, store: STORE }),
    loadCredential: async () => ({ ok: true, value: UPSTREAM_KEY }),
    upstreamFetch: async (urls, init) => {
      captured.urls = urls;
      captured.body = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: "chatcmpl-e2e", choices: [{ message: { role: "assistant", content: "ok" } }] }),
      };
    },
    recordGeneration: (value) => {
      captured.generation = value;
    },
    readGeneration: () => null,
    metricsCollector: {
      startRequest: (meta) => {
        captured.meta = meta;
        return { recordFirstChunk: () => {}, recordEnd: () => {} };
      },
    },
  };
}

describe("workbuddy 写入 → 解析 → 归属 → 上游重写", () => {
  it("真渠道条目：url 段解析出 agentHint=workbuddy / providerId=渠道，id 是 <渠道>~<模型>", () => {
    const config = buildConfig();
    const entry = config.models[0];

    assert.equal(entry.id, packChannelModelSlug(CHANNEL_ID, MODEL_ID), "真渠道 id 必须与 packChannelModelSlug 同口径");
    assert.ok(entry.url.includes(`:${PORT}/openai/workbuddy~${CHANNEL_ID}/v1/chat/completions`));

    const parsed = parseOpenAIPath(new URL(entry.url).pathname);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.agentHint, "workbuddy", "URL 段前缀就是归属主通道");
    assert.equal(parsed.providerId, CHANNEL_ID, "parse 后必须是剥离前缀的真实渠道 id");
    assert.equal(parsed.subpath, "/v1/chat/completions");
  });

  it("伪渠道条目：id 是裸模型名，url 段仍带 workbuddy 身份前缀", () => {
    const config = buildConfig();
    const entry = config.models.find((model) => model.id === AUTO_CHANNEL_KEY);
    assert.ok(entry, "auto 伪渠道条目必须存在");

    assert.equal(entry.id, AUTO_CHANNEL_KEY, "伪渠道不加 <渠道>~ 前缀，否则链拦截匹配不到触发词");
    assert.equal(entry.id.includes("~"), false);

    const parsed = parseOpenAIPath(new URL(entry.url).pathname);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.agentHint, "workbuddy");
    assert.equal(parsed.providerId, CHANNEL_ID, "伪渠道 url 段沿 auto 链头");
  });

  it("POST 写入器产出的 url：上游只剩 /chat/completions、body.model 剥成裸名、归属落 workbuddy", async () => {
    const config = buildConfig();
    const entry = config.models[0];
    const captured = {};
    const server = createOpenAIRelayServer(makeDeps(captured));

    const res = await dispatchChat(server, new URL(entry.url).pathname, {
      model: entry.id,
      stream: false,
      messages: [{ role: "user", content: "hello" }],
    });

    assert.equal(res.status, 200, `relay must accept the writer's url (body: ${res.body})`);

    // 上游 URL：baseURL 之后只剩 /chat/completions，slug 不得残留。
    assert.equal(captured.urls.length, 1);
    assert.ok(captured.urls[0].endsWith("/chat/completions"), "upstream URL must end at /chat/completions");
    assert.equal(captured.urls[0], `${CHANNEL_BASE}/chat/completions`, "渠道 baseURL 之后不得残留 slug");
    assert.equal(captured.urls[0].includes("~"), false);

    // 模型名：渠道限定 slug 在入口剥掉，上游只见裸模型名。
    assert.equal(captured.body.model, MODEL_ID);
    assert.equal(captured.body.model.includes("~"), false);

    // 归属：无 UA，只能来自 URL 段前缀；providerId 是剥离后的真实渠道。
    assert.equal(captured.meta.agentId, "workbuddy");
    assert.equal(captured.meta.providerId, CHANNEL_ID);
    assert.equal(captured.meta.model, MODEL_ID);
    assert.equal(captured.meta.userAgent, undefined, "用例本身不带 UA，归属不靠它");
    assert.equal(captured.generation, undefined, "chat/completions 不触发目录代际绑定");
  });
});
