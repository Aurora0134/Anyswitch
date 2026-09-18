<p align="center">
  <img src="docs/assets/logo.png" alt="Anyswitch logo" width="128">
</p>

# Anyswitch

<p align="center">
  <a href="#english"><b>English</b></a> · <a href="#中文"><b>中文</b></a>
</p>

A local AI credential relay for Windows: it funnels multiple OpenAI-compatible upstreams into a single loopback relay on 127.0.0.1, served through two protocol frontends — OpenAI-native and Anthropic Messages (via translation). Upstream API keys are sealed with Windows DPAPI and never leave your machine. It is meant for developers who put several model providers behind one endpoint, or who run more than one coding agent at the same time.

---

## English

### Features

- **Credentials stay on your machine** — upstream API keys are sealed per-provider with Windows DPAPI (entropy `ApiCred|DPAPI|v2|<ProviderId>`), decrypted only in memory at request time, never cached, never written to disk in plaintext.
- **Single source of truth** — one v2 `store.json` describes all providers, models, and routing metadata; it contains no secrets, only a controlled `credentialFile` reference.
- **Two protocol frontends, one relay** — the loopback relay on `127.0.0.1:47821` serves OpenAI-compatible requests natively (`/openai/<provider>/v1/...`) and Anthropic Messages requests via translation, so clients of both protocol families can share the same credential store.
- **Loopback-only, token-authenticated** — the relay refuses non-loopback peers and authenticates each request: Anthropic-protocol clients get a one-shot 256-bit session token that lives and dies with the launch; OpenAI-protocol clients share a persistent relay token stored under the data root.
- **Provider pools & route chains** — group 2–5 providers into a pool that fans a request out across its members with sticky failover; or build a per-endpoint route chain that serves the virtual model `auto`, walking channels and pools in order and backing off to the next node on failure.
- **Multi-BaseURL failover** — per-provider `fallbackURLs` with a 180s generation budget per attempt, exponential backoff, and real upstream 5xx pass-through.
- **Web control panel** — a standalone, always-available panel on `127.0.0.1:47820` for managing providers, sealing keys, monitoring, and usage statistics.
- **Client launchers** — per-client launchers inject the relay endpoint and auth token into each supported coding agent listed below.
- **Zero dependencies** — plain Node.js ESM, no `npm install` required.

### Prerequisites

- Windows (the credential store relies on Windows DPAPI)
- **Node.js 24 LTS recommended.** Required API range: `>=22.15.0 <23 || >=23.8.0`. Session reading uses Node's built-in SQLite and zstd APIs; the range states the API minimum, not that every matching Node version has been tested.
- No dependencies — nothing to install via npm

### Installation

Anyswitch is distributed as source code. GitHub Releases provide source archives, with no `.exe`/`.msi` installer; the panel does not install updates itself. Choose a published tag from the [Releases page](https://github.com/Aurora0134/Anyswitch/releases). For `v0.5.0-preview`, once that release is available, clone into a new directory:

```bat
git clone --branch v0.5.0-preview --single-branch https://github.com/Aurora0134/Anyswitch.git "%LOCALAPPDATA%\Anyswitch\app"
```

The conventional location is `%LOCALAPPDATA%\Anyswitch\app`; another location works too. For a first installation from a source archive, extract into a new `app` directory. Do not extract over an existing installation.

`panel-app.vbs` is the desktop entry point: it locates `panel-launcher.mjs` relative to itself, so it works from any clone location. It starts the panel host and opens the panel in your browser. Point a desktop shortcut at it for one-click access. Manual fallback entry: `node panel-launcher.mjs` (or `node panel-host.mjs`) from the repo directory.

Notes:

- Node.js must be on `PATH` or installed at `%ProgramFiles%\nodejs`.
- The autostart scheduled tasks (`AnyswitchRelay` / `AnyswitchWatchdog`) bake in the repo path at registration time. If you move the install directory, re-toggle autostart in the panel so the tasks pick up the new path.

### Upgrading

Open **设置 → 关于 (Settings → About)** and click **检查更新 (Check for updates)** to check Anyswitch releases, then read the linked release notes. Preview versions include prereleases in the comparison; stable versions check stable releases only. A failed check is reported as unavailable, not as up to date. Checking does not download, replace, or restart Anyswitch, and does not upgrade your coding agents.

Keep your user data in the parent directory `%LOCALAPPDATA%\Anyswitch\`: `store.json`, `credentials`, settings, presets, and usage records belong there, outside `app`. Back it up before upgrading, and preserve the repository's `.git` file or directory and any external Git object store it points to. Do not replace the whole installation directory or use `git reset --hard` to upgrade.

For an existing Git clone, first schedule a break in active sessions and inspect the working tree from the repository directory:

```bat
git status --short
```

If this prints anything, preserve and resolve your local changes before proceeding; do not discard them to make the command succeed. With a clean working tree, fetch only the chosen published tag and switch to it. For `v0.5.0-preview`, after it is published:

```bat
git fetch --no-tags origin tag v0.5.0-preview
git switch --detach v0.5.0-preview
```

A detached checkout is normal for a release installation. These steps are for users running a release clone; maintainers working on the local development `master` keep that branch and do not switch it to a release tag. For an archive-based installation, unpack into a separate directory and compare/apply source-file changes, including removed files, while retaining user data and existing Git metadata; do not overlay the entire directory.

After updating the source, the backend needs a new panel-host process. Refreshing the browser only reloads static page files; it does not replace the old backend or its recorded version. The existing panel **重启 (Restart)** button restarts the relay first and then the panel host, interrupting active relay requests and potentially coding sessions. Use it only at a time you have arranged, then reopen or refresh the panel and confirm the version in About.

### Quick start

1. Open the panel at `http://127.0.0.1:47820/panel` (via `panel-app.vbs`). The panel UI is Chinese; tab names below are given in both languages.
2. In the **渠道管理 (Channels)** tab, click **新增渠道 (Add provider)** and fill in:
   - **ID** — letters, digits, `.`, `_`, `-` only (e.g. `deepseek`);
   - **Display name** — optional, defaults to the ID;
   - **Base URL(s)** — the upstream's OpenAI-compatible endpoint; extra lines become failover `fallbackURLs`;
   - **API Key** — sealed with DPAPI the moment you save.
   
   On save, Anyswitch discovers the model list from the upstream's `GET /v1/models`. If discovery fails (the upstream has no models endpoint), you can paste model IDs manually instead.
3. Optionally, in the same tab: group providers into a **号池 (pool)**, or edit a **路由链 (route chain)** so that requesting the model `auto` walks your channels in order. Click **同步到端点 (Sync to endpoints)** to write the managed channels into client configs — this also happens automatically whenever the store changes (Kimi Code, Codex, OpenCode, Pi, DSH, ZCode, Qoder).

   ![Route chain editor](docs/screenshots/s5-route-chain.png)
4. Start your coding agent through its launcher (see the table below), e.g. `node launcher.mjs` for Claude Code. The launcher injects the relay endpoint and token automatically; any extra arguments are passed straight through to the client.

### Supported clients

| Client | Protocol | How to connect |
| --- | --- | --- |
| Claude Code | Anthropic | `node launcher.mjs [claude args]` — starts a per-launch relay on an ephemeral loopback port and injects `ANTHROPIC_BASE_URL` + a one-shot `ANTHROPIC_AUTH_TOKEN` via process env only; the relay and token die when Claude exits. |
| Kimi Code | Anthropic | `node kimi-launcher.mjs [kimi args]` — same per-launch injection, plus managed providers merged into `~/.kimi-code/config.toml`. |
| Codex CLI | OpenAI Responses | `node codex-launcher.mjs [codex args]` — ensures the relay is available on 47821, merges managed providers into `~/.codex/config.toml`, and supplies a model catalog unless you have chosen your own. Relay authentication is written into the managed config; the launcher passes instance identity through the process environment. |
| OpenCode | OpenAI | `node opencode-launcher.mjs [opencode args]` — ensures the relay is available on 47821 and merges managed providers into `~/.config/opencode/opencode.json` using the built-in config writer. No companion plugin is required; your `opencode.jsonc` is left untouched. |
| Pi | OpenAI | `node pi-launcher.mjs [pi args]` — syncs managed providers into `~/.pi/agent/models.json`, then launches pi. |
| ZCode | OpenAI | `node zcode-launcher.mjs [zcode args]` — merges managed providers into `~/.zcode/v2/config.json`. |
| DSH | OpenAI | `node dsh-launcher.mjs [dsh args]` — merges managed providers into `~/.dsh/settings.yaml`. |
| Qoder | OpenAI | `node qoder-launcher.mjs [qoder args]` — reuses the resident relay on 47821 (or brings one up), merges managed providers into `~/.qoder/settings.json`, and starts Qoder's own `qoder.cmd` dispatcher with `ANYSWITCH_RELAY_TOKEN` + `NO_PROXY` set in the process environment only. Two behaviours are specific to Qoder and worth knowing up front: requests are attributed by an identity prefix in the URL segment (`/openai/qoder~<provider>/v1`) because Qoder has no way to send a custom header, and the launcher starts Qoder with a DevTools port bound to 127.0.0.1 so it can ask Qoder to reload its model catalog after a config change — that reload is best-effort and its failure never blocks startup. |

For the config-merging clients (Kimi Code, Codex, OpenCode, Pi, ZCode, DSH, Qoder), the resident relay watches the store and re-syncs the client configs on every change, so adding or rotating a provider in the panel needs no launcher re-run.

### Agent skills

Anyswitch ships an optional agent skill that teaches a coding agent the correct way to author and manage Anyswitch **presets** — prompt presets that the panel writes into each supported client's own global instruction file (`AGENTS.md` for most clients, `CLAUDE.md` for Claude Code, a dedicated `~/.qoder/rules/` file for Qoder) through the panel API. The skill lives at [`skills/anyswitch-preset/`](skills/anyswitch-preset/SKILL.md) in this repo.

Installing a preset changes files in your home directory that belong to your other tools, not just files in this repository; the panel exposes a master switch and a per-client switch so you can turn that off at any time.

To install it into a coding agent that loads skills from a directory (e.g. Kimi Code), copy the folder into that agent's skills directory:

```bat
xcopy skills\anyswitch-preset "%USERPROFILE%\.kimi-code\skills\anyswitch-preset" /E
```

```bash
cp -r skills/anyswitch-preset ~/.kimi-code/skills/
```

Once installed, the agent follows the skill's rules: it writes presets only through the panel API at `http://127.0.0.1:47820` (never by hand-editing `prompts.json`), and reports when each endpoint actually picks up the change (hot-reload endpoints apply immediately; the other five apply on next session).

### Panel overview

The panel is served by a standalone panel host decoupled from the relay, so it stays up even when the relay is down. Its features include:

- **看板 (Board)** — service status (listen address, uptime, autostart toggle, relay stop/restart), recent-call health per model, route-chain lamps, a live log window, and per-endpoint instance rows for every supported client.
- **Skills 管理 (Skills)** — one master skills repo; import skills from a directory or zip, deploy/undeploy them to agent endpoints, and surface endpoint anomalies.
- **渠道管理 (Channels)** — provider management (add, rotate key, delete, model filter) with DPAPI key sealing; model discovery refresh plus manual model add/remove; pools (号池) and route-chain (自动路由) editing; manual **同步到端点** sync.
- **使用统计 (Stats)** — today's overview, 90-day heatmap, token trends, TTFT/TPS, per-endpoint work hours — see `docs/stats-spec.md`.
- **设置 (Settings)** — **通用 (General) / 主题 (Theme) / 关于 (About)**. About has two stacked cards: Anyswitch version and update checks above, local environment below.

The upper card shows the version of the running panel process and a preview label where applicable. Opening About loads that version; Anyswitch checks for updates only when you click **检查更新 (Check for updates)**, with a link to the matching release notes when a newer release is found.

The lower **本地环境 (Local environment)** card shows Windows, the Node version used by the panel, and all eight clients listed above. It reads installation locations and product metadata without launching a client, then separately queries official versions. Local results appear first; official versions fill in per client. **重新检测 (Refresh detection)** refreshes both. Paths, version sources, and query times are available in details; one failed query does not hide the other results.

Detection distinguishes an installation found, not found, a version that cannot be read, and a detection failure. It does not prove a client can run, is signed in, or is connected to the relay. Official `latest` is the published channel being queried, not a claim about your selected update channel or a guarantee of a stable release; prerelease labels are retained. Qoder stays one client entry with separate **CLI** and **desktop** version rows, compared only within their own product lines. Unknown local versions remain unknown even when an official version is available.

<p align="center">
  <img src="docs/screenshots/s1-board.png" alt="Board tab" width="720">
  <img src="docs/screenshots/s2-channels.png" alt="Channels tab" width="720">
  <img src="docs/screenshots/s3-stats.png" alt="Stats tab" width="720">
  <img src="docs/screenshots/s4-skills.png" alt="Skills tab" width="720">
</p>

### Security model

- Keys are sealed with Windows DPAPI under the current user; ciphertext lives in `%LOCALAPPDATA%\Anyswitch\credentials\`, one file per provider.
- `store.json` holds routing/metadata only and is schema-validated to reject any secret-looking field.
- Session tokens are generated with a CSPRNG — the per-launch token is never persisted or logged; the shared relay token lives only under the data root.
- Everything is fail-closed: no default provider, no fuzzy prefix matching, no fallback to another key on decryption failure; error messages are generalized and never leak URLs, credentials, upstream bodies, or stack traces.
- See `SECURITY.md` for reporting vulnerabilities.

### FAQ

**Is it Windows-only?**
Yes. Key sealing relies on Windows DPAPI, autostart uses Windows scheduled tasks, and `package.json` declares `"os": ["win32"]`. There is no macOS/Linux support.

**Where are my API keys stored, and is that safe?**
Each provider's key is sealed with Windows DPAPI under your user account and stored as one ciphertext file per provider in `%LOCALAPPDATA%\Anyswitch\credentials\`. The plaintext exists only in memory while a request is being forwarded — it is never cached, never logged, and never written to `store.json` (the schema validator rejects secret-looking fields outright).

**What happens if the relay crashes?**
It stays down — crash-without-self-healing is a deliberate design choice, so a fault can't be masked by a restart loop. The control panel is a separate process on port 47820 and remains fully usable; restart the relay from the Board tab. If you enable autostart, the `AnyswitchWatchdog` scheduled task also revives the relay automatically when a coding agent appears.

**Which upstreams are supported?**
Any OpenAI-compatible endpoint — the store schema fixes `protocol: "openai-compatible"`. The upstream only needs chat completions; a `GET /v1/models` endpoint is used for model discovery, but you can enter model IDs manually when it is missing. Anthropic-protocol clients are served by translating to that same OpenAI-compatible upstream.

**How does multi-BaseURL failover behave?**
A provider can list `fallbackURLs` behind its primary `baseURL`. Each attempt gets a 180s generation budget with exponential backoff; 4xx is terminal (your request's problem, passed through), while 5xx moves to the next address. When every address is exhausted you get the last real upstream 5xx, or 502 for pure transport failures.

**Can I change the ports?**
No. The panel (47820), relay (47821), and watchdog marker (47822) ports are fixed constants in code, shared as the single source of truth by the launchers, panel, and watchdog — that is how all the pieces reliably find each other without configuration.

### Documentation

- [Architecture (Chinese)](docs/architecture.md) — layering, module map, security model
- [Usage stats spec (Chinese)](docs/stats-spec.md) — the living spec of the stats tab

### Tests

```bat
npm test
```

Zero-dependency `node --test` suite; see [CONTRIBUTING.md](CONTRIBUTING.md) for single-file runs and environment notes.

### Naming

- This project is named **Anyswitch**. It was developed under the working name "ApiCred". The install location, data directory, and durable git object store now all use the Anyswitch name (`%LOCALAPPDATA%\Anyswitch`, `%LOCALAPPDATA%\Anyswitch-git`); pre-rename installs are migrated in place. One load-bearing identifier intentionally keeps the old name: the DPAPI entropy prefix `ApiCred|DPAPI|v2|` - changing it would seal out every stored key.

### License

[Apache-2.0](LICENSE). See [NOTICE](NOTICE) for third-party trademark attributions.

---

## 中文

一个 Windows 本地 AI 凭据 relay：把多家 OpenAI 兼容上游统一收口到 127.0.0.1 本地 relay，对外提供两种协议前端——OpenAI 原生、Anthropic Messages（经协议转换）。上游 API Key 用 Windows DPAPI 封存，不出本机。面向把多家模型服务商收在一个入口后使用、或同时使用多个 coding agent 的开发者。

### 特性

- **凭据不出本机** — 上游 API Key 用 Windows DPAPI 按提供方熵封存（`ApiCred|DPAPI|v2|<ProviderId>`），仅在请求时内存中即时解密，从不缓存、从不落盘明文。
- **store 单一真相源** — 一份 v2 `store.json` 描述全部 provider/模型/路由元数据；不含任何秘密，只保留受控的 `credentialFile` 引用。
- **双协议前端，一个 relay** — 环回 relay（`127.0.0.1:47821`）同时承载：OpenAI 兼容原生转发（`/openai/<provider>/v1/...`）、Anthropic Messages 协议转换，两个协议族的客户端共享同一份凭据 store。
- **仅环回监听 + token 鉴权** — relay 拒绝非环回连接并逐请求鉴权：Anthropic 协议客户端拿随启动生灭的一次性 256-bit 会话 token；OpenAI 协议客户端共用存放在数据目录下的常驻 relay token。
- **渠道池与路由链** — 把 2–5 个 provider 组成号池，请求在成员间粘性分发、故障自动切换；或为端点配置路由链，用虚拟模型 `auto` 按渠道/号池顺序逐跳路由，失败自动退避下一节点。
- **多 BaseURL 无感退避** — provider 级 `fallbackURLs`，每次尝试 180s 生成预算、指数退避、真实透传上游 5xx。
- **Web 控制面板** — 独立常驻面板 `127.0.0.1:47820`，管理 provider、封存 Key、监测与使用统计。
- **客户端启动器** — 各客户端启动器自动注入 relay 端点与鉴权 token，覆盖下表所列各家 coding agent。
- **零依赖** — 纯 Node.js ESM，无需 `npm install`。

### 前置条件

- Windows（凭据封存依赖 Windows DPAPI）
- **推荐 Node.js 24 LTS。** API 下限范围为 `>=22.15.0 <23 || >=23.8.0`。会话读取使用 Node 内置 SQLite 与 zstd API；此范围说明 API 最低要求，不表示每个符合范围的 Node 版本均已实测。
- 零依赖，无需 npm 安装任何东西

### 安装

Anyswitch 以源码发行。GitHub Release 提供源码归档，没有 `.exe`/`.msi` 安装器，面板也不含自更新功能。先在 [Releases 页面](https://github.com/Aurora0134/Anyswitch/releases) 选择已发布标签；以 `v0.5.0-preview` 为例，待该版本发布后，克隆到一个新目录：

```bat
git clone --branch v0.5.0-preview --single-branch https://github.com/Aurora0134/Anyswitch.git "%LOCALAPPDATA%\Anyswitch\app"
```

约定位置是 `%LOCALAPPDATA%\Anyswitch\app`，也可使用其他位置。首次使用源码归档安装时，解压到一个新的 `app` 目录，不要解压覆盖已有安装。

`panel-app.vbs` 是桌面入口：按脚本自身位置定位 `panel-launcher.mjs`，克隆到任意路径都能用。它会拉起面板宿主并在浏览器中打开面板。给它建一个桌面快捷方式即可一键进入。手动备用入口：在仓库目录下执行 `node panel-launcher.mjs`（或 `node panel-host.mjs`）。

注意事项：

- Node.js 需在 `PATH` 中，或安装在 `%ProgramFiles%\nodejs`。
- 开机自启的计划任务（`AnyswitchRelay` / `AnyswitchWatchdog`）固化注册时的仓库路径。移动安装目录后，需在面板中重开自启，让任务更新为新路径。

### 升级

打开 **设置 → 关于**，点 **检查更新** 查询 Anyswitch 新版，再查看结果链接中的发布说明。预览版会把预发布纳入比较，正式版仅检查正式发布；检查失败会显示暂时无法检查，不会误报为最新。检查不会下载、替换或重启 Anyswitch，也不会升级你的 coding agent。

保留 `app` 上层 `%LOCALAPPDATA%\Anyswitch\` 中的用户数据：`store.json`、`credentials`、设置、预设和用量记录等都在这里。升级前备份数据，并保留仓库的 `.git` 文件或目录及其指向的外部 Git 对象库。不要整目录替换安装，也不要用 `git reset --hard` 升级。

已有 Git clone 的用户应先安排会话空档，在仓库目录检查工作树：

```bat
git status --short
```

若有输出，先妥善保存并处理本地修改，不要为了继续升级而丢弃它们。确认工作树干净后，只获取所选已发布标签，再切到该标签；以 `v0.5.0-preview` 为例，发布后执行：

```bat
git fetch --no-tags origin tag v0.5.0-preview
git switch --detach v0.5.0-preview
```

发布版安装处于 detached HEAD 状态是正常的。这套步骤适用于使用发布版 clone 的用户；维护者的本机开发 `master` 保持原分支，不按此步骤切到发布标签。源码归档用户应先解压到单独目录，对照应用源文件变更（包括已删除的文件），保留用户数据和已有 Git 元数据，不要整目录覆盖。

源码更新后，后端需要换成新的 panel-host 进程。浏览器刷新只会重新加载静态页面，不会替换旧后端或更新其记录的运行版本。面板已有的 **重启** 按钮会先重启 relay，再重启面板宿主，中断正在转发的请求，可能打断 coding 会话。请自行安排合适时机使用，随后重新打开或刷新面板，在关于页确认版本。

### 快速开始

1. 打开面板 `http://127.0.0.1:47820/panel`（经 `panel-app.vbs`）。
2. 在 **渠道管理** tab 点 **新增渠道**，填写：
   - **ID** — 仅限字母、数字、`.`、`_`、`-`（如 `deepseek`）；
   - **显示名** — 可选，默认同 ID；
   - **Base URL** — 上游的 OpenAI 兼容端点；多填几行即为备用地址（`fallbackURLs`）；
   - **API Key** — 保存即用 DPAPI 封存。

   保存时 Anyswitch 自动通过上游的 `GET /v1/models` 拉取模型列表；若发现失败（上游没有 models 端点），可以改为手动粘贴模型 ID。
3. 可选：在同一个 tab 里把多个渠道组成 **号池**，或编辑 **路由链**（请求模型 `auto` 时按链逐跳路由）。点 **同步到端点** 把托管渠道写入各客户端配置——store 每次变更时也会自动同步（Kimi Code、Codex、OpenCode、Pi、DSH、ZCode、Qoder）。

   ![路由链编辑器](docs/screenshots/s5-route-chain.png)
4. 通过对应启动器启动 coding agent（见下表），例如 Claude Code 用 `node launcher.mjs`。启动器自动注入 relay 端点与 token；多余参数原样透传给客户端。

### 支持的客户端

| 客户端 | 协议 | 接入方式 |
| --- | --- | --- |
| Claude Code | Anthropic | `node launcher.mjs [claude 参数]` — 在临时环回端口拉起一次性 relay，仅以进程环境变量注入 `ANTHROPIC_BASE_URL` + 一次性 `ANTHROPIC_AUTH_TOKEN`；Claude 退出时 relay 与 token 一并销毁。 |
| Kimi Code | Anthropic | `node kimi-launcher.mjs [kimi 参数]` — 同样的一次性注入，另把托管 provider 合并进 `~/.kimi-code/config.toml`。 |
| Codex CLI | OpenAI Responses | `node codex-launcher.mjs [codex 参数]` — 确保 47821 relay 可用，把托管 provider 合并进 `~/.codex/config.toml`；未自选模型目录时提供托管模型目录。relay 鉴权写入托管配置，启动器通过进程环境传递实例标识。 |
| OpenCode | OpenAI | `node opencode-launcher.mjs [opencode 参数]` — 确保 47821 relay 可用，由仓内配置写手把托管 provider 合并进 `~/.config/opencode/opencode.json`。无需配套插件，用户的 `opencode.jsonc` 保持不动。 |
| Pi | OpenAI | `node pi-launcher.mjs [pi 参数]` — 先把托管 provider 同步进 `~/.pi/agent/models.json`，再启动 pi。 |
| ZCode | OpenAI | `node zcode-launcher.mjs [zcode 参数]` — 合并托管 provider 进 `~/.zcode/v2/config.json`。 |
| DSH | OpenAI | `node dsh-launcher.mjs [dsh 参数]` — 合并托管 provider 进 `~/.dsh/settings.yaml`。 |
| Qoder | OpenAI | `node qoder-launcher.mjs [qoder 参数]` — 复用 47821 常驻 relay（不在则拉起），把托管 provider 合并进 `~/.qoder/settings.json`，再经 Qoder 自家的 `qoder.cmd` 调度器启动，`ANYSWITCH_RELAY_TOKEN` 与 `NO_PROXY` 只走进程环境变量、不落盘。两处 Qoder 特有行为需先知晓：请求归属靠 URL 段里的身份前缀（`/openai/qoder~<provider>/v1`），因为 Qoder 没有下发自定义请求头的位置；启动器会带一个只绑 127.0.0.1 的 DevTools 端口拉起 Qoder，用于在配置变更后请它重载模型目录——该重载是尽力而为，失败也不阻塞启动。 |

对会合并配置的客户端（Kimi Code、Codex、OpenCode、Pi、ZCode、DSH、Qoder），常驻 relay 监听 store 变更并自动重同步客户端配置，在面板里新增或轮换渠道后无需重跑启动器。

### 智能体技能

Anyswitch 附带一个可选的智能体技能，教 coding agent 以正确的方式编写与管理 Anyswitch **预设**——预设正文由面板写入各客户端自家的全局指令文件（多数客户端是 `AGENTS.md`，Claude Code 是 `CLAUDE.md`，Qoder 是 `~/.qoder/rules/` 下的专属文件），写入只经面板 API。技能位于本仓库的 [`skills/anyswitch-preset/`](skills/anyswitch-preset/SKILL.md)。

需要先知晓：写入预设改动的是你家目录里属于其他工具的文件，不局限于本仓库；面板提供总开关与逐端点开关，随时可关。

要把它装进从目录加载技能的 coding agent（如 Kimi Code），把该目录复制到对应 agent 的 skills 目录即可：

```bat
xcopy skills\anyswitch-preset "%USERPROFILE%\.kimi-code\skills\anyswitch-preset" /E
```

```bash
cp -r skills/anyswitch-preset ~/.kimi-code/skills/
```

安装后，agent 会遵循该技能的规则：只通过 `http://127.0.0.1:47820` 的面板 API 写预设（绝不手改 `prompts.json`），并如实报告各端点的生效时机（热加载端点立即生效，其余五个下次会话生效）。

### 面板功能简介

面板由独立面板宿主承载，与 relay 解耦，relay 停止/崩溃时面板仍可用。主要功能包括：

- **看板** — 服务状态（监听地址、已连续运行、开机自启开关、relay 停止/重启）、各模型近期调用健康度、路由链灯、实时输出日志窗，以及全部端点的实例行。
- **Skills 管理** — 单一 skills 主仓库：从目录或 zip 导入 skill、部署/解除到各 agent 端点、端点异常提示。
- **渠道管理** — provider 管理（新增、轮换 Key、删除、模型过滤）并 DPAPI 封存 Key；模型发现刷新与手动增删模型；号池与路由链（自动路由）编辑；手动 **同步到端点**。
- **使用统计** — 今日概览、90 天热力图、Token 趋势、TTFT/TPS、端点工时——见 `docs/stats-spec.md`。
- **设置** — 分为 **通用｜主题｜关于**。关于页上下两张卡：上方是 Anyswitch 版本与检查更新，下方是本地环境。

上卡显示当前面板进程的 Anyswitch 版本，并在预览版时标明预览状态。打开关于页先读取当前版本；只有点击 **检查更新** 才查询 Anyswitch 发布记录，发现新版时可打开对应发布说明。

下方 **本地环境** 卡展示 Windows、面板使用的 Node 版本，以及上表中的八个客户端。检测只读取安装位置和产品资料，不启动客户端；随后独立查询各客户端官方版本。本地结果先出现，官方版本逐项补齐；**重新检测** 会刷新两者。路径、版本来源和查询时间可展开查看，单项查询失败不会隐藏其他结果。

检测区分已发现、未找到、版本无法读取和检测失败，不表示客户端一定可运行、已登录或已接入转发。官方 `latest` 表示本次查询的发布渠道，不代表已读取用户选择的更新渠道，也不保证是稳定版；预发布标识会保留。Qoder 仍是一个客户端条目，分别显示 **CLI** 与 **桌面** 两行版本，始终在各自产品线内比较。本地版本读不到时保留未知状态，官方版本仍可单独显示。

<p align="center">
  <img src="docs/screenshots/s1-board.png" alt="看板" width="720">
  <img src="docs/screenshots/s2-channels.png" alt="渠道管理" width="720">
  <img src="docs/screenshots/s3-stats.png" alt="使用统计" width="720">
  <img src="docs/screenshots/s4-skills.png" alt="Skills 管理" width="720">
</p>

### 安全模型要点

- Key 用 Windows DPAPI 在当前用户作用域封存；密文存于 `%LOCALAPPDATA%\Anyswitch\credentials\`，每提供方一个文件。
- `store.json` 只存路由/元数据，schema 校验递归拒绝任何秘密样字段。
- 会话 token 由 CSPRNG 生成——一次性 token 不落盘、不记录；共享 relay token 只存放在数据目录下。
- 全程 fail-closed：无默认 provider、无前缀模糊匹配、解密失败不回退其它 Key；错误信息泛化，绝不泄露 URL/凭据/上游响应体/栈。
- 漏洞报告见 `SECURITY.md`。

### FAQ

**只支持 Windows 吗？**
是。Key 封存依赖 Windows DPAPI，开机自启用 Windows 计划任务，`package.json` 也声明了 `"os": ["win32"]`。没有 macOS/Linux 支持。

**我的 API Key 存在哪？安全吗？**
每个 provider 的 Key 用 Windows DPAPI 在你的用户账户下封存，密文以每提供方一个文件存于 `%LOCALAPPDATA%\Anyswitch\credentials\`。明文只在转发请求的瞬间存在于内存——不缓存、不记录日志、也绝不会写进 `store.json`（schema 校验会直接拒绝任何秘密样字段）。

**relay 崩了怎么办？**
它会保持停止——崩溃不自愈是刻意设计，避免故障被重启循环掩盖。控制面板是 47820 上的独立进程，照常可用，在看板 tab 重启 relay 即可。如果开了开机自启，`AnyswitchWatchdog` 计划任务还会在 coding agent 出现时自动拉起 relay。

**支持哪些上游？**
任何 OpenAI 兼容端点——store schema 固定 `protocol: "openai-compatible"`。上游只需提供 chat completions；`GET /v1/models` 用于模型发现，缺了可以手动填模型 ID。Anthropic 协议的客户端由 relay 转换到这同一个 OpenAI 兼容上游。

**多 BaseURL 的退避行为是怎样的？**
provider 可在主 `baseURL` 后排 `fallbackURLs`。每次尝试有 180s 生成预算并按指数退避；4xx 视为终态（请求自身的问题，原样透传），5xx 切下一个地址。所有地址耗尽时透传最后一个真实上游 5xx，纯传输失败返回 502。

**端口能改吗？**
不能。面板（47820）、relay（47821）、watchdog 标记端口（47822）都是代码里的固定常量，作为启动器、面板、watchdog 共享的单一真相源——正是固定端口让各组件无需配置就能互相找到对方。

### 文档

- [架构说明](docs/architecture.md) — 分层、模块地图、安全模型
- [使用统计页规格](docs/stats-spec.md) — 统计 tab 的单一现行规格

### 测试

```bat
npm test
```

零依赖 `node --test` 测试套件；单文件跑法与环境说明见 [CONTRIBUTING.md](CONTRIBUTING.md)。

### 命名说明

- 本项目名为 **Anyswitch**，开发期曾用名 "ApiCred"。安装位置、数据目录与耐久 git 对象库现已统一为新名（`%LOCALAPPDATA%\Anyswitch`、`%LOCALAPPDATA%\Anyswitch-git`），改名前的旧安装就地迁移。唯一有意保留旧名的承重标识符是 DPAPI 熵前缀 `ApiCred|DPAPI|v2|`——改动将封死全部已存密钥。

### License

[Apache-2.0](LICENSE)。第三方商标声明见 [NOTICE](NOTICE)。
