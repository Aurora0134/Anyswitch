import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseOpenAIPath, buildOpenAIPath, buildAgentPrefixedSegment, AGENT_SEGMENT_SEPARATOR, PARSE_REASON } from "./openai-path.mjs";

describe("parseOpenAIPath", () => {
  it("parses a valid path with provider and subpath", () => {
    const result = parseOpenAIPath("/openai/acme-default/v1/chat/completions");
    assert.equal(result.ok, true);
    assert.equal(result.providerId, "acme-default");
    assert.equal(result.subpath, "/v1/chat/completions");
  });

  it("parses a path with percent-encoded provider id", () => {
    const result = parseOpenAIPath("/openai/acme%2Ddefault/v1/models");
    assert.equal(result.ok, true);
    assert.equal(result.providerId, "acme-default");
  });

  it("rejects a path without /openai/ prefix", () => {
    const result = parseOpenAIPath("/v1/models");
    assert.equal(result.ok, false);
    assert.equal(result.reason, PARSE_REASON.NOT_OPENAI);
  });

  it("rejects a path that is not a string", () => {
    const result = parseOpenAIPath(null);
    assert.equal(result.ok, false);
    assert.equal(result.reason, PARSE_REASON.NOT_A_STRING);
  });

  it("rejects a path with no provider segment", () => {
    const result = parseOpenAIPath("/openai/");
    assert.equal(result.ok, false);
    assert.equal(result.reason, PARSE_REASON.NO_PROVIDER);
  });

  it("rejects a path with empty provider segment", () => {
    const result = parseOpenAIPath("/openai//v1/models");
    assert.equal(result.ok, false);
    assert.equal(result.reason, PARSE_REASON.EMPTY_PROVIDER);
  });

  it("rejects a provider id with embedded slash", () => {
    const result = parseOpenAIPath("/openai/foo%2Fbar/v1/models");
    assert.equal(result.ok, false);
    assert.equal(result.reason, PARSE_REASON.INVALID_PROVIDER);
  });

  it("rejects invalid percent-encoding", () => {
    const result = parseOpenAIPath("/openai/%GGfoo/v1/models");
    assert.equal(result.ok, false);
    assert.equal(result.reason, PARSE_REASON.INVALID_PROVIDER);
  });

  it("strips the agent identity prefix and reports it separately", () => {
    const result = parseOpenAIPath("/openai/qoder~poke-api/v1/chat/completions");
    assert.equal(result.ok, true);
    assert.equal(result.providerId, "poke-api");
    assert.equal(result.agentHint, "qoder");
    assert.equal(result.subpath, "/v1/chat/completions");
  });

  it("reports a null agentHint for a bare provider segment", () => {
    const result = parseOpenAIPath("/openai/poke-api/v1/models");
    assert.equal(result.ok, true);
    assert.equal(result.agentHint, null);
  });

  it("treats a leading separator as part of the provider id, not an empty hint", () => {
    // "~foo" 不构成身份位（前缀为空），整段照原样交给 store 查找去 404。
    const result = parseOpenAIPath("/openai/~foo/v1/models");
    assert.equal(result.ok, true);
    assert.equal(result.providerId, "~foo");
    assert.equal(result.agentHint, null);
  });

  it("keeps the v2 slash invariant on the whole segment, not the stripped tail", () => {
    // 剥离必须发生在 '/' 检查之后，否则 qoder~a%2Fb 能绕过 v2 不变量。
    const result = parseOpenAIPath("/openai/qoder~a%2Fb/v1/models");
    assert.equal(result.ok, false);
    assert.equal(result.reason, PARSE_REASON.INVALID_PROVIDER);
  });

  it("rejects a prefix with no provider after it", () => {
    const result = parseOpenAIPath("/openai/qoder~/v1/models");
    assert.equal(result.ok, false);
    assert.equal(result.reason, PARSE_REASON.EMPTY_PROVIDER);
  });

  it("strips the prefix after percent-decoding", () => {
    // provider id 自身含 %7E（解码后是 '~'）同样按语法剥离——真 id 不含 '~'，
    // 这条路径只可能来自带前缀的 URL，不会误伤正常渠道。
    const result = parseOpenAIPath("/openai/qoder%7Epoke-api/v1/models");
    assert.equal(result.ok, true);
    assert.equal(result.providerId, "poke-api");
    assert.equal(result.agentHint, "qoder");
  });
});

describe("buildOpenAIPath", () => {
  it("builds a path from provider id and subpath", () => {
    assert.equal(buildOpenAIPath("acme-default", "/v1/chat/completions"), "/openai/acme-default/v1/chat/completions");
  });

  it("builds default subpath", () => {
    assert.equal(buildOpenAIPath("poke-api"), "/openai/poke-api/v1/chat/completions");
  });

  it("encodes special characters", () => {
    const path = buildOpenAIPath("poke api", "/v1/models");
    assert.equal(path, "/openai/poke%20api/v1/models");
    const back = parseOpenAIPath(path);
    assert.equal(back.ok, true);
    assert.equal(back.providerId, "poke api");
  });

  it("throws on provider id with slash", () => {
    assert.throws(() => buildOpenAIPath("foo/bar"), /must not contain/);
  });

  it("throws on empty provider id", () => {
    assert.throws(() => buildOpenAIPath(""), /must be a non-empty string/);
  });
});

describe("buildAgentPrefixedSegment", () => {
  it("keeps the separator literal and encodes both sides", () => {
    assert.equal(
      buildAgentPrefixedSegment("qoder", "poke-api"),
      `qoder${AGENT_SEGMENT_SEPARATOR}poke-api`,
    );
    assert.equal(buildAgentPrefixedSegment("qoder", "poke api"), `qoder${AGENT_SEGMENT_SEPARATOR}poke%20api`);
  });

  it("round-trips through parseOpenAIPath", () => {
    // qoder-merge-config 自己拼绝对 baseURL，只共用这套语法；互逆是它唯一的契约。
    const segment = buildAgentPrefixedSegment("qoder", "poke api");
    const back = parseOpenAIPath(`/openai/${segment}/v1/chat/completions`);
    assert.equal(back.ok, true);
    assert.equal(back.agentHint, "qoder");
    assert.equal(back.providerId, "poke api");
  });

  it("throws on empty agent or provider id", () => {
    assert.throws(() => buildAgentPrefixedSegment("", "poke-api"), /agentId must be a non-empty string/);
    assert.throws(() => buildAgentPrefixedSegment("qoder", ""), /providerId must be a non-empty string/);
  });
});