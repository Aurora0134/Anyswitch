import { it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { join } from "node:path";
import { normalizeProxyUrl, resolveHttpProxy, fetchViaProxy } from "../src/ops/net-proxy.mjs";

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

// 真代理握手：CONNECT 的目标、鉴权头与拒绝收尾都钉住。隧道内的 TLS 层是标准库
// 组合，单测不另起自签 CA——那条腿由运行面实测覆盖。
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
