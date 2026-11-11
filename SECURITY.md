# Security Policy

## English

### Reporting a vulnerability

Please report security vulnerabilities through **GitHub Security Advisories** (the "Security" tab of this repository → "Report a vulnerability"). If that channel is unavailable, you may open a GitHub Issue — but please avoid including secrets, credential material, or exploit details that could put other users at risk before a fix is available.

Please do not test against other users' installations or access data that does not belong to you.

### Security model highlights

- **DPAPI sealing** — upstream API keys are sealed with Windows DPAPI (CurrentUser scope, per-provider entropy `ApiCred|DPAPI|v2|<ProviderId>`). Ciphertext is stored one file per provider under `%LOCALAPPDATA%\Anyswitch\credentials\`; keys are decrypted in memory at request time. Decrypted plaintext is by default reused within the process for a short time, keyed by ciphertext hash — the cache can be disabled in settings (disabling it means every request re-decrypts and nothing is retained), and rotating a provider's ciphertext invalidates the retained plaintext immediately.
- **The store holds no secrets** — `store.json` contains routing/metadata only. The schema validator recursively rejects any secret-looking field; the only link to a key is a strictly validated `credentialFile` reference that cannot escape the credentials directory.
- **Fail-closed** — no default provider, no fuzzy prefix matching, no fallback to another key when decryption fails. Error messages are generalized and never leak URLs, credentials, upstream response bodies, or stack traces.
- **Loopback only** — the relay and panel listen on 127.0.0.1 only, and panel write endpoints accept only the local panel (trusted Origin/Referer). The relay and terminal host authenticate with a token kept in the data root: stored in plaintext, propagated into the endpoint configs it manages, rotated to a fresh generation every 7 days, with idle generations retired after 24 hours and at most 8 generations retained. Per-process session tokens remain CSPRNG-generated, never persisted, never logged. `NO_PROXY` is enforced for loopback addresses to prevent leakage through inherited HTTP proxies.
- **Single-user trust boundary** — loopback binding is a network boundary, not a per-user boundary on Windows. This tool is designed for a single user per machine: processes running as that user are trusted, and protection against other local accounts or untrusted local processes is out of scope.

---

## 中文

### 漏洞报告

请通过 **GitHub Security Advisories**（本仓库的 "Security" 标签页 → "Report a vulnerability"）报告安全漏洞。如果该渠道不可用，也可以开 GitHub Issue——但在修复发布前，请避免在公开内容中包含秘密、凭据材料或可能危及其他用户的利用细节。

请不要对其他用户的安装环境进行测试，也不要访问不属于你的数据。

### 安全模型要点

- **DPAPI 封存** — 上游 API Key 用 Windows DPAPI 封存（CurrentUser 作用域，按提供方熵 `ApiCred|DPAPI|v2|<ProviderId>`）。密文按提供方一文件存于 `%LOCALAPPDATA%\Anyswitch\credentials\`；Key 仅在请求时内存中解密。解出的明文默认在本进程内按密文哈希做短时复用（设置里可关，关掉即用后即焚、每个请求重新解密）；轮换密文会立即失效。
- **store 不含秘密** — `store.json` 只存路由/元数据。schema 校验递归拒绝任何秘密样字段；与 Key 的唯一关联是经过严格校验、无法逃出 credentials 目录的 `credentialFile` 引用。
- **fail-closed** — 无默认 provider、无前缀模糊匹配、解密失败不回退其它 Key。错误信息泛化，绝不泄露 URL、凭据、上游响应体或栈。
- **仅环回** — relay 与面板只监听 127.0.0.1，面板写接口只认本地面板（可信 Origin/Referer）。relay 与终端宿主用数据根里的本地 token 鉴权：token 明文存放、随所管理的端点配置分发，每 7 天自动轮换一代，闲置 24 小时的旧代自动退役，最多保留 8 代；会话 token 仍由 CSPRNG 按进程生成，不落盘、不记录。为环回地址强制 `NO_PROXY`，防止流量经继承的 HTTP 代理外泄。
- **单用户信任边界** — 环回绑定是网络边界，不是 Windows 上的用户边界。本工具按单用户设计：该用户身份下运行的进程即受信任，对其他本机账户或不可信本机进程的防护不在范围内。
