import { compareVersions, parseVersion } from "./version-check.mjs";

const npmSource = (name, repository) => ({
  endpoint: `https://registry.npmjs.org/-/package/${encodeURIComponent(name)}/dist-tags`,
  source: `npm:${name}:latest`,
  url: `https://github.com/${repository}/releases`,
  field: "latest",
});

const CLIENTS = {
  claude: npmSource("@anthropic-ai/claude-code", "anthropics/claude-code"),
  opencode: npmSource("opencode-ai", "anomalyco/opencode"),
  pi: npmSource("@earendil-works/pi-coding-agent", "earendil-works/pi"),
  kimi: npmSource("@moonshot-ai/kimi-code", "MoonshotAI/kimi-code"),
  dsh: npmSource("@deepseek-ai/dsh", "deepseek-ai/deepseek-harness"),
  codex: {
    endpoint: "https://api.github.com/repos/openai/codex/releases/latest",
    source: "github:openai/codex:latest", format: "codex",
  },
  zcode: {
    endpoint: "https://zcode.z.ai/api/v1/releases/electron/manifest?platform=windows-x86_64&channel=1",
    source: "zcode:windows-x86_64:stable", format: "yaml", url: "https://zcode.z.ai/cn/changelog",
    headers: { "X-Platform": "windows-x86_64", "X-Release-Channel": "stable" },
  },
  qoder: {
    endpoint: "https://qoder-ide.oss-accelerate.aliyuncs.com/qodercli/channels/manifest.json",
    source: "qoder:cli:latest", field: "latest", url: "https://qoder.com/cli",
  },
  "qoder-desktop": {
    endpoint: "https://download.qoder.com.cn/qoder-app/releases/latest.yml",
    source: "qoder:desktop:latest", format: "yaml", url: "https://qoder.com/changelog",
  },
};

function yamlVersion(text) {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => /^version\s*:/.test(line));
  if (lines.length !== 1) return null;
  const match = /^version\s*:\s*(?:"([^"\\]*)"|'([^']*)'|([^\s#'"]+))\s*(?:#.*)?$/.exec(lines[0]);
  return match ? match[1] ?? match[2] ?? match[3] : null;
}

class ReleaseError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function parseJson(text) {
  try { return JSON.parse(text); }
  catch { throw new ReleaseError("invalid_response"); }
}

function releaseUrl(value, repository, tag) {
  try {
    const url = new URL(value);
    if (typeof value !== "string" || value !== url.href || url.origin !== "https://github.com"
      || url.username || url.password || url.search || url.hash
      || decodeURIComponent(url.pathname) !== `/${repository}/releases/tag/${tag}`) throw new Error();
    return value;
  } catch { throw new ReleaseError("unsafe_url"); }
}

const APP_RELEASES = "https://api.github.com/repos/Aurora0134/Anyswitch/releases";

function nextPage(link, page) {
  if (!link) return null;
  const entries = link.split(",").map((part) => /^\s*<([^>]+)>\s*;\s*rel="([a-z ]+)"\s*$/.exec(part));
  if (entries.some((entry) => !entry)) throw new ReleaseError("invalid_pagination");
  const next = entries.filter((entry) => entry[2].split(" ").includes("next"));
  if (!next.length) return null;
  try {
    const url = new URL(next[0][1]);
    if (next.length !== 1 || url.href !== next[0][1] || url.origin + url.pathname !== APP_RELEASES
      || url.username || url.password || url.hash || [...url.searchParams].length !== 2
      || url.searchParams.get("per_page") !== "100" || url.searchParams.get("page") !== String(page + 1)) throw new Error();
    return url.href;
  } catch { throw new ReleaseError("invalid_pagination"); }
}

export function createReleaseService({ currentVersion, fetchFn = fetch, now = Date.now, cacheTtlMs = 10 * 60 * 1000, maxConcurrent = 4, timeoutMs = 8000, maxResponseBytes = 1024 * 1024 } = {}) {
  const cache = new Map();
  const pending = new Map();

  function cached(key, force, operation) {
    const inFlight = pending.get(key);
    if (inFlight) return inFlight;
    const saved = cache.get(key);
    if (!force && saved && now() - saved.at < cacheTtlMs) return Promise.resolve(saved.value);
    const request = operation().then(
      (value) => {
        if (pending.get(key) === request) pending.delete(key);
        cache.set(key, { at: now(), value });
        return value;
      },
      (error) => {
        if (pending.get(key) === request) pending.delete(key);
        throw error;
      },
    );
    pending.set(key, request);
    return request;
  }

  let active = 0;
  const queue = [];

  async function request(endpoint, options) {
    if (active >= maxConcurrent) await new Promise((resolve) => queue.push(resolve));
    active++;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchFn(endpoint, { ...options, signal: controller.signal });
        const declared = Number(response.headers.get("content-length"));
        if (Number.isFinite(declared) && declared > maxResponseBytes) throw new ReleaseError("response_too_large");
        const text = await response.text();
        if (controller.signal.aborted) throw new ReleaseError("timeout");
        if (text.length > maxResponseBytes) throw new ReleaseError("response_too_large");
        return { response, text };
      } catch (error) {
        if (controller.signal.aborted) throw new ReleaseError("timeout");
        throw error;
      } finally {
        clearTimeout(timer);
      }
    } finally {
      active--;
      if (queue.length) queue.shift()();
    }
  }

  async function queryClientLatest(id) {
    const spec = CLIENTS[id];
    try {
      const { response, text } = await request(spec.endpoint, {
        credentials: "omit", redirect: "error",
        headers: { Accept: spec.format === "yaml" ? "text/yaml, text/plain" : "application/json", ...spec.headers },
      });
      if (!response.ok) {
        const limited = response.status === 429 || (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0");
        throw new ReleaseError(limited ? "rate_limited" : "http_error");
      }
      const data = spec.format === "yaml" ? null : parseJson(text);
      if (spec.format === "codex" && (typeof data?.tag_name !== "string" || !data.tag_name.startsWith("rust-v")
        || data.draft !== false || data.prerelease !== false)) throw new ReleaseError("invalid_response");
      const version = spec.format === "yaml" ? yamlVersion(text)
        : spec.format === "codex" ? data.tag_name.slice(6) : data?.[spec.field];
      const parsed = parseVersion(version);
      if (!parsed || (spec.format === "codex" && parsed.prerelease.length)) throw new ReleaseError("invalid_response");
      return {
        state: "ok", version, url: spec.format === "codex" ? releaseUrl(data.html_url, "openai/codex", data.tag_name) : spec.url, source: spec.source,
        checkedAt: new Date(now()).toISOString(), errorCode: null,
      };
    } catch (error) {
      return {
        state: "error", version: null, url: null, source: spec.source,
        checkedAt: new Date(now()).toISOString(), errorCode: error instanceof ReleaseError ? error.code : "network_error",
      };
    }
  }
  async function queryAppUpdate() {
    const base = { currentVersion: currentVersion ?? null, checkedAt: new Date(now()).toISOString(), release: null, errorCode: null };
    const current = parseVersion(currentVersion);
    if (!current) return { ...base, state: "unknown_version" };
    try {
      let endpoint = `${APP_RELEASES}?per_page=100&page=1`;
      let target = null;
      let page = 0;
      while (endpoint) {
        page++;
        const { response, text } = await request(endpoint, {
          credentials: "omit", redirect: "error", headers: { Accept: "application/json" },
        });
        if (!response.ok) throw new ReleaseError(response.status === 429 ? "rate_limited" : "http_error");
        const data = parseJson(text);
        if (!Array.isArray(data)) throw new ReleaseError("invalid_response");
        for (const item of data) {
          if (!item || typeof item.draft !== "boolean" || typeof item.prerelease !== "boolean") throw new ReleaseError("invalid_response");
          if (item.draft) continue;
          const version = typeof item.tag_name === "string" ? item.tag_name.replace(/^v/, "") : null;
          const parsed = parseVersion(version);
          if (!parsed) throw new ReleaseError("invalid_response");
          if (!current.prerelease.length && (item.prerelease || parsed.prerelease.length)) continue;
          if (typeof item.published_at !== "string" || !Number.isFinite(Date.parse(item.published_at))) throw new ReleaseError("invalid_response");
          const url = releaseUrl(item.html_url, "Aurora0134/Anyswitch", item.tag_name);
          if (!target || compareVersions(version, target.version) === 1) {
            target = { version, tag: item.tag_name, prerelease: item.prerelease, url, publishedAt: item.published_at };
          }
        }
        endpoint = nextPage(response.headers.get("link"), page);
      }
      const order = target ? compareVersions(currentVersion, target.version) : null;
      return { ...base, checkedAt: new Date(now()).toISOString(), release: target, state: !target ? "no_releases" : order < 0 ? "update_available" : order > 0 ? "ahead" : "current" };
    } catch (error) {
      return { ...base, checkedAt: new Date(now()).toISOString(), state: "error", errorCode: error instanceof ReleaseError ? error.code : "network_error" };
    }
  }
  function getClientLatest(id, { force = false } = {}) {
    if (typeof id !== "string" || !Object.hasOwn(CLIENTS, id)) return Promise.reject(new TypeError("Unsupported client id"));
    return cached(`client:${id}`, force, () => queryClientLatest(id));
  }

  function getAppUpdate({ force = false } = {}) {
    return cached("app", force, queryAppUpdate);
  }

  return { getClientLatest, getAppUpdate };
}
