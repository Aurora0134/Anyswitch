// 出口代理解析与 CONNECT 隧道：让检查腿用上用户已配置的代理。
//
// 背景：Node 的全局 fetch 不读系统代理、也不读代理环境变量，而更新通道的
// 下载腿（git fetch）天然认环境变量与 git 的 http.proxy 配置——同一台机器上
// 「git 能通、fetch 必断」的分裂由此而来。本模块把检查腿补齐到同一口径：
// 只尊重用户显式配置过的两个来源（代理环境变量、git http.proxy），不读系统
// 代理设置以外的任何私有状态，未配置即如实 null，调用方维持直连结论。
//
// 隧道只做 CONNECT + 标准 TLS 校验：代理全程只转发密文，证书校验仍是端到端
// 的，走代理不扩大信任面。只支持 http:// 代理（本地代理工具的普遍形态），
// 其余协议视为未配置。
import { execFile as execFileDefault } from "node:child_process";
import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import { join } from "node:path";

// git config 是本地读盘，询问预算可以短。
const GIT_CONFIG_TIMEOUT_MS = 3000;
// 隧道内响应体的硬上限：调用方有自己的按字节判错，这里只防内存被无界写爆
// （端点清单全是固定常量，正常响应远在 1MB 之内）。
const HARD_BODY_CAP_BYTES = 8 * 1024 * 1024;

// 代理 URL 形态钉住：http 协议 + 有主机名。返回 null 表示「不可用、当未配置」。
export function normalizeProxyUrl(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  let url;
  try { url = new URL(value.trim()); } catch { return null; }
  if (url.protocol !== "http:" || !url.hostname) return null;
  return url.href;
}

// 解析用户已配置的出口代理：环境变量（大写优先，与 git 的读取序一致）在先，
// 缺席再问 git 的 http.proxy——与下载腿认的是同两个来源。git 缺失换候选路径，
// git 在但没配（退出码 1）即定论 null。
export async function resolveHttpProxy({ env = process.env, spawnFn = execFileDefault } = {}) {
  for (const key of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]) {
    const found = normalizeProxyUrl(env?.[key]);
    if (found) return found;
  }
  const candidates = ["git", join(env?.ProgramFiles ?? "C:\\Program Files", "Git", "cmd", "git.exe")];
  const askGit = (file) => new Promise((done) => {
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; done(value); } };
    try {
      spawnFn(file, ["config", "--get", "http.proxy"], { timeout: GIT_CONFIG_TIMEOUT_MS, windowsHide: true, encoding: "utf8" }, (error, stdout) => {
        if (error?.code === "ENOENT") return finish({ missing: true });
        if (error) return finish({ value: null });
        finish({ value: String(stdout ?? "").trim() });
      });
    } catch { finish({ missing: true }); }
  });
  for (const candidate of candidates) {
    const result = await askGit(candidate);
    if (result.missing) continue;
    return normalizeProxyUrl(result.value) ?? null;
  }
  return null;
}

// 经 http:// 代理的 HTTPS GET：CONNECT 建隧道，隧道里跑标准 TLS（证书对目标
// 主机名校验，代理无法旁观或篡改内容），返回与全局 fetch 同形的最小响应面
// （ok/status/headers.get/text），调用方不需要知道走没走代理。
// 中止语义交给调用方传入的 AbortSignal：abort 即拆隧道、以失败收尾。
export function fetchViaProxy({ url, proxyUrl, headers = {}, signal, bodyCapBytes = HARD_BODY_CAP_BYTES }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let activeSocket = null;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      fn(value);
    };
    const onAbort = () => {
      try { activeSocket?.destroy(); } catch { /* 收尾尽力而为 */ }
      finish(reject, new Error("aborted"));
    };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });

    let target;
    let proxy;
    try {
      target = new URL(url);
      proxy = new URL(proxyUrl);
    } catch { return finish(reject, new TypeError("invalid_url")); }
    if (target.protocol !== "https:") return finish(reject, new TypeError("proxied_fetch_requires_https"));

    const auth = proxy.username || proxy.password
      ? { "Proxy-Authorization": `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")}` }
      : {};
    // 全局 fetch 会自带 User-Agent，隧道腿必须对齐：GitHub API 对不带 UA 的
    // 请求一律 403，缺了这一头代理腿会把可通的通道打成「服务端拒绝」。
    const requestHeaders = { "user-agent": "anyswitch-self-update", ...headers };
    const connectReq = http.request({
      host: proxy.hostname,
      port: proxy.port || 80,
      method: "CONNECT",
      path: `${target.hostname}:${target.port || 443}`,
      headers: auth,
      agent: false,
    });
    connectReq.on("error", (error) => finish(reject, error));
    connectReq.on("connect", (res, socket) => {
      activeSocket = socket;
      if (res.statusCode !== 200) {
        socket.destroy();
        return finish(reject, new Error(`proxy_connect_failed_${res.statusCode}`));
      }
      const request = https.request({
        hostname: target.hostname,
        port: target.port || 443,
        path: `${target.pathname}${target.search}`,
        method: "GET",
        headers: requestHeaders,
        agent: false,
        createConnection: () => {
          const tunneled = tls.connect({ socket, servername: target.hostname });
          activeSocket = tunneled;
          return tunneled;
        },
      }, (response) => {
        const chunks = [];
        let size = 0;
        response.on("data", (chunk) => {
          size += chunk.length;
          if (size > bodyCapBytes) { response.destroy(new Error("response_too_large")); return; }
          chunks.push(chunk);
        });
        response.on("error", (error) => finish(reject, error));
        response.on("end", () => {
          const rawHeaders = response.headers;
          finish(resolve, {
            ok: response.statusCode >= 200 && response.statusCode < 300,
            status: response.statusCode,
            headers: {
              get: (name) => {
                const value = rawHeaders[String(name).toLowerCase()];
                return Array.isArray(value) ? value.join(", ") : value ?? null;
              },
            },
            text: async () => Buffer.concat(chunks).toString("utf8"),
          });
        });
      });
      request.on("error", (error) => finish(reject, error));
      request.end();
    });
    connectReq.end();
  });
}
