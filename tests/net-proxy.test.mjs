import { it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { join } from "node:path";
import { normalizeProxyUrl, resolveHttpProxy, fetchViaProxy } from "../src/ops/net-proxy.mjs";

// 隧道成功腿需要本地自签 HTTPS 目标：测试进程内关闭证书校验，只为本夹具放行；
// 端到端证书校验语义仍由实现默认开启保证，不由本夹具背书。
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

it("normalizeProxyUrl accepts only http:// proxies with a hostname", () => {
  assert.equal(normalizeProxyUrl("http://127.0.0.1:7890"), "http://127.0.0.1:7890/");
  assert.equal(normalizeProxyUrl("http://user:pass@proxy.local:8080"), "http://user:pass@proxy.local:8080/");
  assert.equal(normalizeProxyUrl("  http://192.168.1.2:10809  "), "http://192.168.1.2:10809/");
  for (const bad of ["", "  ", null, undefined, 7890, "not a url", "socks5://127.0.0.1:1080", "https://proxy.local:8443", "http://"]) {
    assert.equal(normalizeProxyUrl(bad), null, String(bad));
  }
});

const gitSpawn = (behavior) => (file, args, options, callback) => behavior(file, args, callback);

it("resolveHttpProxy prefers env vars in git's reading order and never asks git when env hits", async () => {
  let gitAsked = false;
  const spawnFn = gitSpawn((_file, _args, callback) => { gitAsked = true; callback(null, "http://from-git:1\n", ""); });
  const found = await resolveHttpProxy({ env: { HTTPS_PROXY: "http://upper:1", https_proxy: "http://lower:2", HTTP_PROXY: "http://plain:3" }, spawnFn });
  assert.equal(found, "http://upper:1/");
  assert.equal(gitAsked, false);
  assert.equal(await resolveHttpProxy({ env: { https_proxy: "http://lower:2" }, spawnFn }), "http://lower:2/");
  assert.equal(await resolveHttpProxy({ env: { HTTP_PROXY: "http://plain:3" }, spawnFn }), "http://plain:3/");
});

it("resolveHttpProxy falls back to git config, tries the install path on ENOENT, and reads absence as no-proxy", async () => {
  const calls = [];
  const enoent = Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" });
  const spawnFn = gitSpawn((file, _args, callback) => {
    calls.push(file);
    if (file === "git") return callback(enoent, "", "");
    callback(null, "http://from-git:7890\n", "");
  });
  assert.equal(await resolveHttpProxy({ env: {}, spawnFn }), "http://from-git:7890/");
  // ENOENT 换腿后的第二候选是安装位 git.exe：夹具 env 为空，钉住按缺省
  // ProgramFiles 派生的完整路径——候选写成 bin 变体、派生段或缺省值写错都会红。
  assert.deepEqual(calls, ["git", join("C:\\Program Files", "Git", "cmd", "git.exe")]);

  // 键缺席（退出码 1，error 但非 ENOENT）即定论「未配置」，不再试下一个候选。
  const absent = await resolveHttpProxy({
    env: {},
    spawnFn: gitSpawn((_file, _args, callback) => callback(Object.assign(new Error("exit 1"), { code: 1 }), "", "")),
  });
  assert.equal(absent, null);

  // env 里的值不合法（如 socks5）不挡路，继续落到 git 配置。
  const viaGit = await resolveHttpProxy({
    env: { HTTPS_PROXY: "socks5://127.0.0.1:1080" },
    spawnFn: gitSpawn((_file, _args, callback) => callback(null, "http://from-git:7890\n", "")),
  });
  assert.equal(viaGit, "http://from-git:7890/");

  // git 配置值不合法同样如实 null。
  const invalid = await resolveHttpProxy({
    env: {},
    spawnFn: gitSpawn((_file, _args, callback) => callback(null, "socks5://127.0.0.1:1080\n", "")),
  });
  assert.equal(invalid, null);
});

// 真代理握手：CONNECT 的目标、鉴权头与拒绝收尾都钉住；隧道内的成功腿见文末用例。
it("fetchViaProxy forwards CONNECT target and Proxy-Authorization, and fails honestly on refusal", async () => {
  const seen = [];
  const proxy = http.createServer();
  proxy.on("connect", (req, socket) => {
    seen.push({ path: req.url, auth: req.headers["proxy-authorization"] ?? null });
    socket.write("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n");
    socket.destroy();
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const port = proxy.address().port;
  try {
    await assert.rejects(
      fetchViaProxy({ url: "https://api.github.com:443/repos/x/y", proxyUrl: `http://user:pass@127.0.0.1:${port}` }),
      /proxy_connect_failed_407/,
    );
    assert.deepEqual(seen, [{
      path: "api.github.com:443",
      auth: `Basic ${Buffer.from("user:pass").toString("base64")}`,
    }]);

    // 凭据带 percent-encoding（URL 形态里的 @/# 必须转义才能写进代理 URL）：
    // 出站头里的值必须解码还原。没有 decodeURIComponent 时，解码前的字面值
    // （user%40x:p%23ss）会被原样编码进 Basic——代理侧按错凭据拒鉴权。
    const encodedSeen = [];
    const encodedProxy = http.createServer();
    encodedProxy.on("connect", (req, socket) => {
      encodedSeen.push(req.headers["proxy-authorization"] ?? null);
      socket.write("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n");
      socket.destroy();
    });
    await new Promise((resolve) => encodedProxy.listen(0, "127.0.0.1", resolve));
    const encodedPort = encodedProxy.address().port;
    try {
      await assert.rejects(
        fetchViaProxy({ url: "https://api.github.com/", proxyUrl: `http://user%40x:p%23ss@127.0.0.1:${encodedPort}` }),
        /proxy_connect_failed_407/,
      );
      assert.deepEqual(encodedSeen, [
        `Basic ${Buffer.from("user@x:p#ss").toString("base64")}`,
      ], "Proxy-Authorization 必须携带 percent-decode 后的凭据");
    } finally {
      await new Promise((resolve) => encodedProxy.close(resolve));
    }

    // 已中止的信号立即拒绝、不发任何字节。
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      fetchViaProxy({ url: "https://api.github.com/", proxyUrl: `http://127.0.0.1:${port}`, signal: controller.signal }),
      /aborted/,
    );
    // 复查代理侧记录：预中止在建连前短路，seen 必须仍停留在上一腿的唯一一条
    // CONNECT——短路若被挪到建连之后仍以 aborted 收尾，这里会红。
    assert.equal(seen.length, 1);
  } finally {
    await new Promise((resolve) => proxy.close(resolve));
  }
});

// —— 隧道成功腿（relay-core-2:2 的覆盖缺口）——
// 本地 CONNECT 代理是真管道（200 后双向接通），不是回放桩；三条判据钉死「走的是
// 隧道」：内层 TLS 字节必须穿过代理（直连旁路时恒为 0）、目标只收到代理转发的
// 一条连接（旁路会多出第二条直连）、必需 UA 与 pathname+query 原样抵达目标。
const TUNNEL_KEY = `
-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQCXerrnr+rM7uZw
A9wjKZV3vzEJUCB5zayNlFuN90FS/ghq9CZiKkSwUCR3rEz5rwD/9X2+EsT0sbML
Uw78g2C/CX49zfy1z5SQmtdYA32mczzXwzllMRiF8D+XHHw//FxEtqSaqMrCoAfh
3uLIeCbDTM0mcbUC4i+CeGL5jAc716JeB2ykDtl/HtDj1wF7ZMiWrhRgNDRDNFdO
z6EwndaWQwlQjmjtyJLG52PKDSD80AYn2mbSEAyrZEmxhBNk53bpflU3iqapVYJ/
P4muUvkssAl2HrwoDY33iTIW7ZqEoeJBx1Qs+DvQ0BBFhSTredT+FZWR+6gAkTSi
DtsXd8pNAgMBAAECggEAFxPBRDlCd/CgZinMYIX+CaV0wsK0g+Hv2wziStVDnDFr
1mF2NIfUeZjoCVxUSMieyh/cBXhGDbJBwOSpOJKKS2hWlXNbf9ZNP597VaMIgjJ1
rzhEdvRdFFCm225hRn07kFNT7eTvqOlo8gH7Akf9vcymR2hUx4jubH3LNFHfK0BB
cT99FDYUtcuAWCtMQozN0XoQCYw/GfMas8K2JlfZeSYcDxetb75tXPy25pFzux0q
UqYPVeAigBGLzwyiKgo30vHGzAsVsinv6gao7Cym6T8g2FYtcWEmVIDcVGIqOCbn
AkzUtBv1PQG2g3trYhai+jMC2UY98IaDjISXYtYAaQKBgQDGPDwdfrt8SviaEEfR
/NNQ9Tc2NoDJ4LkNnsvNOH9w0gdrymgbYF7p6/M6q/nVI6pAmRR13/luldBRNAMC
fendQR+3F2NPCykz1F0e1Y9iP4TGDkz5tSzXEVv/d+MYbx8CEkLFTAjDuWm0aVcc
5von1tAp5wb3NlwGah0lddS1xQKBgQDDnqU36RX7ptIKJMcqrYvSybQcCWZFzBhw
tZMgxGVMQsQbSPChZgHH/2s2OAicATnjYdqw6reuRwLwYQgxGISem8i0ec7tlqgz
GuR+3QFulXpV/UOGcuNjdHnNe6AatOoUnxVN7Tt1Urn9pv2UsyKHk0GFolnk5AQX
EiPnK6SS6QKBgQC3J1oHilshGIeemKIy0pxPdXDApxTQ8M8pVWlJQAUHMRZoMgeE
G8M176m3sMNQePZJXuY3jmuAD+z7yclqGPnlUdFCsdowYsh7uZ8b6QbkKHm9H+Ng
51L5lnFglNz+a1TD7ilA7uI+K+YNKTKyYnoIKwIDZQ/bgp790jcBsF+KXQKBgQCu
vlXaZvWDMhbohsf/YL3JkvK4JNFeQh4G+LwwBiBzCiVCNlr14jhvHsP30AAo05OR
ggUoCtP/82E1t4foy30UbhbQ2Qq3A+DGnhxFE0lHLnH0xGOAg7qKSi7QFsIDeV6t
Axq13NhDSp3obzaQkaCjuTBLnqZsqB7bORInW74MmQKBgBgtKjT2KMsIi9YPZSYR
VxmrifnktpPWoO8cEQ6wwCA/CrXw4iSPiWkFwfpQFpARmZt3UojVsakA6YeZdUp8
T9PJVVNuRTyKpw/yBSDRbAlTE12qJu6VhExfGi+IG66Pn4zeT2ACnZ+0mFS91phM
hLe7lDbXK4yIc6vYoirXH3vh
-----END PRIVATE KEY-----
`;
const TUNNEL_CERT = `
-----BEGIN CERTIFICATE-----
MIIDQTCCAimgAwIBAgIUUPDD4KZxzVCSBMdGsAPp2G815KYwDQYJKoZIhvcNAQEL
BQAwIjEgMB4GA1UEAwwXYW55c3dpdGNoLWxvb3BiYWNrLXRlc3QwHhcNMjYxMTE1
MTMwMzIyWhcNMzYxMTEyMTMwMzIyWjAiMSAwHgYDVQQDDBdhbnlzd2l0Y2gtbG9v
cGJhY2stdGVzdDCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBAJd6uuev
6szu5nAD3CMplXe/MQlQIHnNrI2UW433QVL+CGr0JmIqRLBQJHesTPmvAP/1fb4S
xPSxswtTDvyDYL8Jfj3N/LXPlJCa11gDfaZzPNfDOWUxGIXwP5ccfD/8XES2pJqo
ysKgB+He4sh4JsNMzSZxtQLiL4J4YvmMBzvXol4HbKQO2X8e0OPXAXtkyJauFGA0
NEM0V07PoTCd1pZDCVCOaO3IksbnY8oNIPzQBifaZtIQDKtkSbGEE2Tndul+VTeK
pqlVgn8/ia5S+SywCXYevCgNjfeJMhbtmoSh4kHHVCz4O9DQEEWFJOt51P4VlZH7
qACRNKIO2xd3yk0CAwEAAaNvMG0wHQYDVR0OBBYEFKwGHjCYEUF3uphQrOa3S8Nf
x710MB8GA1UdIwQYMBaAFKwGHjCYEUF3uphQrOa3S8Nfx710MA8GA1UdEwEB/wQF
MAMBAf8wGgYDVR0RBBMwEYcEfwAAAYIJbG9jYWxob3N0MA0GCSqGSIb3DQEBCwUA
A4IBAQBXCQncSgHfFz3JZhl/1Zojbv2XrYL4EHCffzZJzSsJO7JcYyvxysxab1nK
pJloG7y/6xY332Tnv3K2A39Z4aWnnOKJXOFDIMvjBJaoRxq8zMykMUB0PetfLrk2
XKqumZOA6TSBfLh+SLzxaB7FckltAtZfWeEEjDgKFzsWP4/YCpOXVGPma8O76YK4
NMH+X4qJ3hzHisuGnG8umUS0cBI2omQ8BsgyF7vhdL738ZSQDWCFk/LPtE9QKTnu
fmaJGWK5eKtFTqHOGtxJzEMF4IYqiPu4SgFu2tPOm53qod6UcKhuc5DIEHZyKPmW
iW6hUVGCXPr+hK+2gR/rV4+kQp8A
-----END CERTIFICATE-----
`;

it("fetchViaProxy tunnels the inner GET through CONNECT: required UA and pathname+query reach the target over the tunnel", async () => {
  const hits = [];
  let targetConnections = 0;
  const target = https.createServer({ key: TUNNEL_KEY, cert: TUNNEL_CERT }, (req, res) => {
    hits.push({ url: req.url, ua: req.headers["user-agent"] });
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("tunnel-ok-body");
  });
  target.on("connection", () => { targetConnections += 1; });
  let tunnelBytes = 0;
  let connectSeen = 0;
  const liveSockets = new Set();
  const proxy = http.createServer();
  proxy.on("connect", (req, socket) => {
    connectSeen += 1;
    liveSockets.add(socket);
    socket.on("close", () => liveSockets.delete(socket));
    socket.on("data", (chunk) => { tunnelBytes += chunk.length; });
    const separator = String(req.url).lastIndexOf(":");
    const upstream = net.connect(Number(String(req.url).slice(separator + 1)), String(req.url).slice(0, separator), () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    socket.on("error", () => upstream.destroy());
    upstream.on("error", () => socket.destroy());
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  await new Promise((resolve) => target.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetchViaProxy({
      url: `https://127.0.0.1:${target.address().port}/check?branch=main`,
      proxyUrl: `http://127.0.0.1:${proxy.address().port}`,
    });
    assert.equal(response.ok, true);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "tunnel-ok-body");
    assert.equal(response.headers.get("content-type"), "text/plain");
    assert.equal(connectSeen, 1, "CONNECT must be requested exactly once");
    assert.ok(tunnelBytes > 0, "inner TLS bytes must flow through the CONNECT tunnel; a direct bypass leaves the tunnel idle at zero bytes");
    assert.equal(targetConnections, 1, "the target must see exactly the proxied connection; a bypass adds a second direct one");
    assert.deepEqual(hits, [{ url: "/check?branch=main", ua: "anyswitch-self-update" }]);
  } finally {
    for (const socket of liveSockets) socket.destroy();
    proxy.closeAllConnections?.();
    target.closeAllConnections?.();
    await new Promise((resolve) => proxy.close(resolve));
    await new Promise((resolve) => target.close(resolve));
  }
});
