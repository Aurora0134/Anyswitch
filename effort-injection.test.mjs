import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  createEffortInjector,
  defaultEffortInjector,
  looksLikeEffortRejection,
  readResponseText,
  EFFORT_REQUEST_FIELD,
} from "./effort-injection.mjs";
import { mkTestDir } from "./test-helpers/tmp.mjs";

const reasoning = (levels, level) => ({ kind: "reasoning", levels, default: level, wire: {}, thinkingFormat: null });
const CATALOG = {
  models: new Map([
    ["glm-5.3", reasoning(["medium", "high", "xhigh", "max"], "high")],
    ["claude-fable-5", reasoning(["xhigh", "max"], "xhigh")],
    ["agnes-image-2.0-flash", { kind: "non-text", levels: [], default: null, wire: {}, thinkingFormat: null }],
  ]),
};

function makeInjector(overrides = {}) {
  const logs = [];
  const logger = {
    warn: (message) => logs.push(message),
    info: (message) => logs.push(message),
  };
  const injector = createEffortInjector({ catalog: CATALOG, logger, ...overrides });
  return { injector, logs };
}

const bodyFor = (model) => ({ model, messages: [{ role: "user", content: "hi" }] });

describe("createEffortInjector.inject", () => {
  it("fills the library default when the client named no level", () => {
    const { injector } = makeInjector();
    const result = injector.inject({ providerId: "a6api-main", body: bodyFor("glm-5.3") });
    assert.equal(result.body[EFFORT_REQUEST_FIELD], "high");
    assert.equal(result.injected, "high");
  });

  it("sends the model's own default level, not a fixed one", () => {
    const { injector } = makeInjector();
    assert.equal(injector.inject({ providerId: "p", body: bodyFor("claude-fable-5") }).injected, "xhigh");
  });

  it("never overrides a level the client chose, not even an explicit null", () => {
    const { injector } = makeInjector();
    const chosen = { ...bodyFor("glm-5.3"), [EFFORT_REQUEST_FIELD]: "max" };
    const kept = injector.inject({ providerId: "p", body: chosen });
    assert.equal(kept.body[EFFORT_REQUEST_FIELD], "max");
    assert.equal(kept.injected, null);
    const off = { ...bodyFor("glm-5.3"), [EFFORT_REQUEST_FIELD]: null };
    assert.equal(injector.inject({ providerId: "p", body: off }).injected, null);
  });

  it("forwards the level a client named in the Anthropic shape", () => {
    const { injector } = makeInjector();
    const result = injector.inject({
      providerId: "p",
      body: bodyFor("glm-5.3"),
      clientEffort: { stated: true, level: "xhigh" },
    });
    assert.equal(result.body[EFFORT_REQUEST_FIELD], "xhigh");
    assert.equal(result.injected, "xhigh");
  });

  it("clips the client's level to the nearest one the model carries", () => {
    const { injector } = makeInjector();
    // glm-5.3 offers medium/high/xhigh/max.
    assert.equal(injector.inject({
      providerId: "p", body: bodyFor("glm-5.3"), clientEffort: { stated: true, level: "max" },
    }).injected, "max");
    assert.equal(injector.inject({
      providerId: "p", body: bodyFor("glm-5.3"), clientEffort: { stated: true, level: "light" },
    }).injected, "medium");
    // ...but off means off: the field stays off the wire entirely.
    assert.equal(injector.inject({
      providerId: "p", body: bodyFor("glm-5.3"), clientEffort: { stated: true, level: "off" },
    }).injected, null);
    // claude-fable-5 offers only xhigh/max — a high request lands on xhigh.
    assert.equal(injector.inject({
      providerId: "p", body: bodyFor("claude-fable-5"), clientEffort: { stated: true, level: "high" },
    }).injected, "xhigh");
    assert.equal(injector.inject({
      providerId: "p", body: bodyFor("claude-fable-5"), clientEffort: { stated: true, level: "xhigh" },
    }).injected, "xhigh");
  });

  it("forwards a name the shared ladder does not know, unclipped", () => {
    const { injector } = makeInjector();
    const result = injector.inject({
      providerId: "p", body: bodyFor("glm-5.3"), clientEffort: { stated: true, level: "ultracode" },
    });
    assert.equal(result.body[EFFORT_REQUEST_FIELD], "ultracode");
  });

  it("adds nothing when the client said no thinking", () => {
    const { injector } = makeInjector();
    const result = injector.inject({
      providerId: "p", body: bodyFor("glm-5.3"), clientEffort: { stated: true, level: null },
    });
    assert.equal(EFFORT_REQUEST_FIELD in result.body, false);
    assert.equal(result.injected, null);
  });

  it("adds nothing for a model the library calls non-text", () => {
    const { injector } = makeInjector();
    const result = injector.inject({ providerId: "p", body: bodyFor("agnes-image-2.0-flash") });
    assert.equal(result.injected, null);
    assert.equal(EFFORT_REQUEST_FIELD in result.body, false);
  });

  it("still injects an optimistic level for a model the library lacks", () => {
    const { injector } = makeInjector();
    assert.equal(injector.inject({ providerId: "p", body: bodyFor("brand-new-model") }).injected, "high");
  });

  it("stops when the switch is off, and picks the switch back up per call", () => {
    let on = false;
    const { injector } = makeInjector({ isEnabled: () => on });
    assert.equal(injector.inject({ providerId: "p", body: bodyFor("glm-5.3") }).injected, null);
    on = true;
    assert.equal(injector.inject({ providerId: "p", body: bodyFor("glm-5.3") }).injected, "high");
  });

  it("treats a throwing switch as on rather than dropping the feature", () => {
    const { injector } = makeInjector({ isEnabled: () => { throw new Error("settings unreadable"); } });
    assert.equal(injector.inject({ providerId: "p", body: bodyFor("glm-5.3") }).injected, "high");
  });

  it("leaves a channel that refused the parameter alone, and logs once", () => {
    const { injector, logs } = makeInjector();
    injector.noteRejected("bad-gateway");
    assert.equal(injector.inject({ providerId: "bad-gateway", body: bodyFor("glm-5.3") }).injected, null);
    assert.equal(injector.isRejected("bad-gateway"), true);
    assert.equal(injector.isRejected("other-gateway"), false);
    injector.noteRejected("bad-gateway");
    assert.equal(logs.length, 1, "one log line per channel, not per request");
  });

  it("does not mutate the caller's body", () => {
    const { injector } = makeInjector();
    const original = bodyFor("glm-5.3");
    injector.inject({ providerId: "p", body: original });
    assert.equal(EFFORT_REQUEST_FIELD in original, false);
  });

  it("tolerates a non-object body", () => {
    const { injector } = makeInjector();
    assert.deepEqual(injector.inject({ providerId: "p", body: null }), { body: null, injected: null });
  });

  // A channel that states its own levels in the store answers before the
  // library — the operator's declaration is the authority on both faces.
  it("prefers the store's own declared levels over the library", () => {
    const { injector } = makeInjector();
    const result = injector.inject({
      providerId: "p",
      body: bodyFor("glm-5.3"),
      model: { reasoningEffortLevels: ["low", "high"] },
    });
    assert.equal(result.injected, "high");
  });

  it("honors the store's defaultEffort when it is a declared level", () => {
    const { injector } = makeInjector();
    const result = injector.inject({
      providerId: "p",
      body: bodyFor("glm-5.3"),
      model: { reasoningEffortLevels: ["low", "high", "max"], defaultEffort: "low" },
    });
    assert.equal(result.injected, "low");
  });

  it("ignores a defaultEffort the model does not offer", () => {
    const { injector } = makeInjector();
    const result = injector.inject({
      providerId: "p",
      body: bodyFor("glm-5.3"),
      model: { reasoningEffortLevels: ["low", "medium"], defaultEffort: "max" },
    });
    assert.equal(result.injected, "medium", "falls back to the deepest declared level");
  });

  it("prefers a channel-level declaration too", () => {
    const { injector } = makeInjector();
    const result = injector.inject({
      providerId: "p",
      body: bodyFor("glm-5.3"),
      provider: { reasoningVariants: ["low", "medium"] },
    });
    assert.equal(result.injected, "medium");
  });

  it("still uses the library when the store declares nothing", () => {
    const { injector } = makeInjector();
    const result = injector.inject({ providerId: "p", body: bodyFor("glm-5.3"), model: {} });
    assert.equal(result.injected, "high");
  });
});

describe("createEffortInjector.withoutEffort", () => {
  it("removes only the injected field", () => {
    const { injector } = makeInjector();
    const injected = injector.inject({ providerId: "p", body: bodyFor("glm-5.3") }).body;
    assert.deepEqual(injector.withoutEffort(injected), bodyFor("glm-5.3"));
  });

  it("returns the body untouched when there is nothing to remove", () => {
    const { injector } = makeInjector();
    const plain = bodyFor("glm-5.3");
    assert.equal(injector.withoutEffort(plain), plain);
  });
});

describe("looksLikeEffortRejection", () => {
  it("recognizes the parameter being named in a 400 or 422", () => {
    assert.equal(looksLikeEffortRejection(400, '{"error":"Unsupported parameter: \'reasoning_effort\'"}'), true);
    assert.equal(looksLikeEffortRejection(422, "unexpected extra field: effort"), true);
    assert.equal(looksLikeEffortRejection(400, "reasoningEffort 不被支持"), true);
  });

  it("does not read an unrelated failure as a rejection", () => {
    assert.equal(looksLikeEffortRejection(400, "max_tokens must be an integer"), false);
    assert.equal(looksLikeEffortRejection(500, "reasoning_effort"), false);
    assert.equal(looksLikeEffortRejection(401, "invalid effort credentials"), false);
    assert.equal(looksLikeEffortRejection(400, ""), false);
    assert.equal(looksLikeEffortRejection(400, undefined), false);
  });
});

describe("readResponseText", () => {
  it("yields the upstream's words when there are any", async () => {
    assert.equal(await readResponseText({ text: async () => "boom" }), "boom");
  });

  it("yields an empty string when the body cannot be read", async () => {
    assert.equal(await readResponseText({ text: async () => { throw new Error("already consumed"); } }), "");
    assert.equal(await readResponseText({}), "");
  });
});

describe("defaultEffortInjector", () => {
  function sandboxBase() {
    const dir = mkTestDir("anyswitch-effort-inj-");
    const root = join(dir, "Anyswitch");
    mkdirSync(root, { recursive: true });
    return { dir, base: { LOCALAPPDATA: dir, USERPROFILE: join(dir, "user") } };
  }

  it("injects while no settings file has been written", () => {
    const { dir, base } = sandboxBase();
    try {
      const injector = defaultEffortInjector({ base });
      assert.equal(injector.inject({ providerId: "p", body: { model: "brand-new-model" } }).injected, "high");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stops as soon as the switch is written off, without a restart", () => {
    const { dir, base } = sandboxBase();
    try {
      const injector = defaultEffortInjector({ base });
      writeFileSync(
        join(base.LOCALAPPDATA, "Anyswitch", "settings.json"),
        JSON.stringify({ injectThinkingEffort: false }),
      );
      assert.equal(injector.inject({ providerId: "p", body: { model: "brand-new-model" } }).injected, null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
