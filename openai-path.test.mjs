import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseOpenAIPath, buildOpenAIPath, PARSE_REASON } from "./openai-path.mjs";

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