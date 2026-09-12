# Anyswitch App（B 层）— 架构说明

## 1. 项目简介

Anyswitch 是一套把多家 OpenAI 兼容上游（以及经由协议转换的 Anthropic 客户端）统一收口到本地 relay 的凭据与路由系统。核心目标：

- **凭据不出本机**：上游 API Key 用 Windows DPAPI 按提供方熵封存，relay 仅在请求时即时解密、用后即焚，从不缓存、从不落盘明文。
- **store 即唯一真相源**：一份 v2 `store.json` 描述全部 provider/模型/路由元数据，relay 路由纯靠它，管理面（panel）写、注入插件读。
- **无感多地址退避 + 协议透传**：主地址失败自动按序重试备用地址（180s 生成预算、5xx 透传）；Anthropic 客户端经 relay 无缝对接 OpenAI 兼容上游。
- **解耦独立常驻**：常驻 relay 宿主与独立常驻 Web 控制面板分离，relay 停止/崩溃时面板仍可用；支持免管理员权限开机自启（计划任务 AnyswitchRelay/AnyswitchWatchdog）。

B 层（本仓库）是 relay app：一个仅监听 127.0.0.1 的 HTTP 服务，负责鉴权、路由、协议转换、多 BaseURL 退避、流式转发，并由各客户端启动器把端点 + 一次性会话 token 注入子进程。

## 2. 架构分层

系统分两层，共享同一份 v2 store（位于 `%LOCALAPPDATA%\Anyswitch\`）：

```
┌──────────────────────────────────────────────────────────────────┐
│  A 层 · OpenCode 运行时注入插件（可选配套，未随本仓库发布）          │
│  职责: OpenCode 启动时从 store 注入托管 provider 与 reasoning      │
│        variants（只读 store，不改写 opencode.jsonc）               │
└───────────────┬──────────────────────────────────────────────────┘
                │ 只读
                ▼
┌──────────────────────────────────────────────────────────────────┐
│  v2 store（单一真相源）  %LOCALAPPDATA%\Anyswitch\                   │
│    store.json        —— 路由/元数据, 不含任何秘密                   │
│    credentials\      —— 每提供方一个 DPAPI 密文文件                 │
│    app\              —— 本仓库（B 层 relay 代码）                    │
└───────────────┬──────────────────────────────────────────────────┘
                │ 只读 + 请求时解密
                ▼
┌──────────────────────────────────────────────────────────────────┐
│  B 层 · relay app（本仓库）                                       │
│  位置: %LOCALAPPDATA%\Anyswitch\app                                  │
│  职责: loopback HTTP relay —— 鉴权/路由/协议转换/退避/流式,         │
│        常驻宿主+Web 控制面板, 启动器注入端点+token                  │
└──────────────────────────────────────────────────────────────────┘
```

- **A 层**是可选的 OpenCode 配套注入插件，未随本仓库发布：OpenCode 启动时从 store 注入托管 provider 与推理挡位（只读 store，不改写 `opencode.jsonc`）。store 的管理面（add/rotate/delete/filter、DPAPI 封存 Key、写 store.json）在 B 层 panel（Web 面板，`/panel/api/store/*`）。
- **B 层**是 relay：启动后读 store，把客户端请求路由到对应上游；不持有任何持久秘密，会话 token 随进程生灭。控制面 panel 与 relay 同层（见下文「控制面层」）。
- 两层解耦点就是 store：管理面（panel）写、relay 与注入插件读，路由完全由 store 决定（B 不内置任何 provider 列表）。

## 3. 核心特性

1. **多 BaseURL 无感退避**
   provider 可配置 `fallbackURLs`（string[]）。请求时按 `baseURL` + `fallbackURLs` 顺序逐个尝试：每次 180s 生成超时预算、指数退避（1s/2s/4s 封顶）、4xx 视为终态不重试、5xx 切下一个备用地址；端点耗尽时透传最后一次上游真实 5xx 状态码，纯网络/传输失败返回 502。

2. **reasoning 元数据采集**
   discovery（`GET /v1/models`）正确采集并映射各模型的 `contextWindow`、`maxOutputTokens`、`supportsReasoning`（布尔）；store-schema 接受 per-model 的 `supportsReasoning`/`reasoningEffortLevels`/`defaultEffort` 与 provider 级模板 `reasoningVariants`；catalog-resolver 透传这些字段。

3. **opencode 推理挡位注入**
   托管 provider（baseURL 指向 relay、apiKey 用 relay token）与 reasoning variants 由可选的 OpenCode 插件启动时直接从 store 注入，`opencode.jsonc` 不被 anyswitch 修改。策略：只填空（已有 variants 跳过，保护手补）、`supportsReasoning:false` 硬豁免。

4. **协议透传**
   Anthropic Messages API ↔ OpenAI Chat Completions 双向转换（仅翻译 Claude Code 实际发出的允许字段，其余丢弃）。`reasoning_effort` 透传已撤销（Claude Code 挡位选择器前端固定，透传无效）。请求面注入落在翻译之后，判「客户端是否已自选」看的是原始 Anthropic 请求里的 `thinking`/`reasoning_effort`/`effort`，因此被丢弃的自选值不会被库默认顶替。

5. **兜底档位映射**
   catalog 生成阶段用关键词档位映射推断上下文窗口（如 `claude-opus/gpt-5.5/5.6 → 1M`、`GPT-5.x → 272K`）；未命中关键词的模型统一给 `1M` 兜底（而非 128K 硬编码或 999M 假数值）。

6. **DSH 推理挡位知识库兜底**
   DSH 对自定义 provider route 只认 `settings.yaml` 显式声明的 `reasoningEfforts`（`dsh-llm-pi-ai` 的 `resolveModelReasoning` 对非 catalog route 恒 `reasoning: false`），线上发现协议（`LlmDiscoveredModel`）也不携带推理字段——两层都断供。`reasoning-fallback.mjs` 读取 DSH 自带安装的 pi-ai 模型知识库（`@earendil-works/pi-ai/dist/providers/data/*.json`，与 DSH dispatch 同源），按模型 id（含 `go/` 等网关前缀的末段回退）解析 `thinkingLevelMap` wire 拼写与 `compat.thinkingFormat`，作为 store 字段/provider 模板之后的第 3 级兜底注入 `settings.yaml`。厂商条目优先于网关镜像；无 map 条目按 pi-ai 基础五挡语义展开；`enabled/off` 二值开关折叠为 `off/low`。fail-open：知识库缺失时返回空索引，不阻塞配置同步。

7. **store 单一真相源 + 写保护**
   v2 `store.json` 是唯一真相源，relay 路由纯靠它。写保护两道：(a) CAS 哈希写——`writeStore` 基于读取时拿到的内容哈希做 compare-and-swap（`casWriteFile` + 跨进程文件锁），并发改写会以 `PreconditionFailed` 失败而非静默覆盖；(b) generation digest——discovery 记录“决定请求去哪的 store 字段”的内容摘要，`POST /v1/messages` 重算并失配即返 409，防止路由漂移。

8. **思考强度挡位库（两面注入）**
   上游 `/models` 不声明推理挡位能力，客户端也大多不发 `reasoning_effort`，端点里的挡位区因此对中转站渠道整体失效。anyswitch 自持一份「模型 → 可选挡位」库补齐两面：

   - **数据**：`%LOCALAPPDATA%\Anyswitch\thinking-efforts.db.json`（人工可改、不进仓库、不进 git 锚点）。读库唯一入口 `effort-catalog.mjs`：按 `mtimeMs`+体积缓存、改了下一轮即生效；解析失败沿用上一次可用副本并标 `stale`，文件缺失等价于「只有乐观默认」。条目级校验**逐条生效不整表作废**：形状不对/非文本却带挡位的行跳过并计数，挡位名不在词表内的剔除（剔空才跳过），`default` 不在该模型挡位列表内时按偏好重算而非弃行。模型 id 先归一化（循环剥 `[前缀]`、挡位词尾、日期尾、命名空间、Claude 家族名重排），再按点/横两种拼写查——生产 83 个模型 id 全部命中，其中 2 个只能靠点横折叠命中。
   - **配置面**：把挡位写进各端点自己的模型能力配置，让选择器出真挡位。pi `thinkingLevelMap`+`compat.thinkingFormat`、ZCode `reasoning{enabled,variants,defaultVariant}`、Reasonix `supported_efforts`/`default_effort`（先与渠道族允许集求交，交空则整个模型不写）、kimi `support_efforts`/`default_effort`/`reasoning`——这四家过 `modelEffortSurface` 按各自词表裁剪。DSH 在 store 标注 / 渠道模板 / pi-ai 知识库之后追加一级兜底（不参与路由级方言判定），兜底级同样按 DSH 词表裁剪（dsh-llm-pi-ai 对 `reasoningEfforts` 键做固定集合校验，词表外的挡位名会让整份 settings.yaml 拒载）。词表共八档 `off/light/minimal/low/medium/high/xhigh/max`：`light` 是 gpt-5.6 及以上独有的最轻挡，pi/DSH 两家的固定档位集不含它、裁剪时剔除，其余端点原样渲染。Qoder 只取"有无挡位"的布尔（`capabilities.thinking` 必须是裸布尔——其运行时严格按布尔解析，对象形状会静默落成 false），挡位只能走请求面到达。
   - **请求面**：`effort-injection.mjs` 在出上游前补默认（OpenAI 路径与 Anthropic 路径共用一个注入器实例）。三条规则——客户端已发（含显式 `null`）一律不覆盖；注入值取库 `default`，现库默认只落 `high`/`xhigh`、无 `max`，库缺失时乐观默认 `high`（不给 `max`：a6api 网关 ~296s 墙钟且照常计费）；上游 400/422 报文提到该参数则去字段重试一次并把渠道记为拒收。拒收集是**进程内存态**：`store.json` 归 panel 进程写（CAS+删除日志），relay 写它会与 UI 抢盘，重启丢一个标记只多一次重试。
   - **开关**：面板设置项「注入思考强度」（`settings.json` 的 `injectThinkingEffort`，默认开）同时管请求面注入与 kimi 全局 `[thinking]` 接管；关闭后请求原样透传。kimi 的 `[thinking]` 只改已存在的表：把 `enabled` 就地翻 true（表内没有该键时在表内补一行），找不到该表或值不是裸布尔就拒改并落日志（重复定义 `[thinking]` 会让 kimi 整份配置解析失败），改前由 `writeKimiConfigTomlWithBackup` 落带时间戳备份。
   - fail-open 贯穿两面：挡位解析失败绝不拖垮 relay 请求或配置同步。

## 4. 目录结构

### store / 真相源层
- `store-io.mjs` — 存储 IO 层：加载校验 v2 store.json（返回内容哈希供 CAS），在固定 credentials 根下解析 `credentialFile`、读取密文；`writeStore` 支持 CAS 乐观并发；含只读的 v1 旧存储加载器。
- `store-schema.mjs` — v2 store 纯函数校验器：强制“store 不含秘密”不变量，校验 providers/models/`credentialFile` 引用/`fallbackURLs`/`contextWindow`/`maxOutputTokens`/`reasoningVariants`。
- `credential-ref.mjs` — `credentialFile` 引用纯函数校验器：拒绝绝对路径/盘符/UNC/父级穿越/分隔符/Windows 保留设备名，确保引用无法逃出 credentials 目录。
- `atomic-write.mjs` — 原子写助手：`atomicWriteFile`（temp+rename）、`casWriteFile`（基于内容哈希的 CAS + 跨进程文件锁）、`contentHash`（sha256 CAS 比较）。
- `catalog-generation.mjs` — 路由摘要（generation digest）：对决定“请求去哪”的 store 字段取哈希；discovery 记录、请求时重算失配返 409。
- `catalog-resolver.mjs` — 模型目录解析器：把 OpenCode 风格 model 条目解析为 Store 模型对象，透传 `contextWindow`/`maxOutputTokens`/`supportsReasoning` 等元数据。
- `context-fallback.mjs` — 上下文分层兜底规则（tier-based context fallback）。
- `reasoning-fallback.mjs` — 推理挡位知识库兜底：按模型 id 查询 DSH 内置 pi-ai 模型数据库（`thinkingLevelMap`/`thinkingFormat`），产出 DSH `reasoningEfforts` wire 映射。
- `effort-catalog.mjs` — 思考强度挡位库的唯一读入口（`%LOCALAPPDATA%\Anyswitch\thinking-efforts.db.json`）：模型 id 归一化 + 点横拼写候选、条目级校验、mtime+体积热加载、解析失败沿用旧副本，并按端点词表/Reasonix 渠道族允许集裁剪挡位；库缺失时给乐观默认 `high,xhigh,max`。
- `effort-injection.mjs` — 请求面注入：客户端未发挡位时补库默认，上游 400/422 提到该参数则去字段重试一次并把渠道记为拒收（进程内存态，不写 store）；受「注入思考强度」开关控制，OpenAI 与 Anthropic 两条路径共用一个实例。

### 协议与流处理层
- `protocol.mjs` — Anthropic ↔ OpenAI 兼容协议互转（纯函数）。
- `wire-id.mjs` — Claude wire ID 打包/解包：`anthropic/<provider>/<model>`，严格单次剥离、按首个 `/` 切分；`buildWireCatalog` 检测 wire ID 碰撞。
- `stream.mjs` — SSE 流翻译（纯状态机）：把上游 OpenAI `chat.completion.chunk` 流翻译为 Anthropic Messages SSE 事件序列。
- `openai-stream-guard.mjs` — OpenAI 流式响应守卫（坏流过滤、孤儿 tool_call 拦截、reasoning 字段即时放行）。

### relay / 服务层
- `handler.mjs` — Anthropic 路径请求处理器：恒定时间 token 鉴权 → 加载 store → 解包 wire ID → generation 校验 → 解密凭据 → 协议转换 → fallback URL 列表发上游；全程 fail-closed。
- `openai-handler.mjs` — OpenAI 原生路径处理器：`/v1/models` 与 `/chat/completions` 直通到 OpenAI 兼容上游（不做协议翻译）。
- `openai-path.mjs` — OpenAI relay 路径解析。
- `server.mjs` — Anthropic 前端 loopback HTTP 服务（127.0.0.1、随机会话 token）。
- `openai-server.mjs` — OpenAI 前端 loopback HTTP 服务。
- `launch.mjs` — 生产装配线：组装 loadStore + DPAPI loadCredential + `createRetryingFetch`（180s 超时/指数退避/5xx 透传/502 兜底）。
- `launcher.mjs` — Claude 启动器：注入端点与 token、设置 NO_PROXY、剥离继承 API Key。

### 控制面层
- `relay-host.mjs` — 常驻 relay 宿主（127.0.0.1:47821，crash 不自愈是刻意设计）。
- `panel-host.mjs` — 独立常驻控制面板宿主（127.0.0.1:47820）：relay 停止/崩溃时面板仍可用，并承载 followAgent 探活 watcher。
- `panel.mjs` — 面板路由（`/panel` 与 `/panel/api/*`），relay 与 panel-host 两个进程共用。
- `panel-ui/panel.html` — 面板 Web UI 本体（relay 每请求现读，刷新即生效）。
- `panel-launcher.mjs` / `panel-app.vbs` — 桌面快捷方式入口：拉起 panel-host 并打开浏览器面板。
- `agent-skills.mjs` — Skills 管理 tab 后端：主仓库扫描（递归识别含 SKILL.md 的目录）、NTFS junction 部署/解除到各 agent 端点（claude/zcode/opencode/pi/kimi/dsh/reasonix）、回收站删除、端点本地 skill 收编合并、原生目录选择对话框；配置存 `%LOCALAPPDATA%\Anyswitch\skills.json`（仅存 repoPath，部署状态以文件系统为准）。
- `relay-process-manager.mjs` — relay 生命周期（按记录 PID 启停/重启）。
- `agent-watcher.mjs` — followAgent 自愈：检测到 coding agent 运行而 relay 未启时静默拉起。
- `agent-sync.mjs` — store 变更毫秒级同步下游 agent 配置（zcode/dsh/pi/kimi/reasonix）。
- `relay-settings.mjs` — 持久设置（`%LOCALAPPDATA%\Anyswitch\settings.json`，原子写）。
- `instance-socket-owner.mjs` — relay 侧 socket→PID 兜底数据源：解析 netstat 输出维护「连接对端端口 → 客户端进程 PID」缓存（同步查快照、后台 fire-and-forget 刷新），openai 服务器在请求无 `x-agent-instance` 头时用它合成 `<agentId>-<PID>` 实例 id（此即规范形态，消费侧归一对它是恒等映射）。
- `autostart.mjs` — 开机自启管理（每用户计划任务 AnyswitchRelay/AnyswitchWatchdog，免管理员权限）。
- `git-anchor.mjs` — 将 `app/.git` 锚定为指向耐久对象库（`%LOCALAPPDATA%\Anyswitch-git\objects`）的 gitfile；默认关闭（每次启动直接跳过），设 `ANYSWITCH_GIT_ANCHOR=1` 才开启。

### 客户端集成
- `opencode-launcher.mjs` / `pi-launcher.mjs` / `zcode-launcher.mjs` / `dsh-launcher.mjs` / `kimi-launcher.mjs` / `reasonix-launcher.mjs` / `codex-launcher.mjs` — 各客户端启动器：探测或拉起 47821 relay、同步托管配置、注入 `ANYSWITCH_RELAY_TOKEN` 与 NO_PROXY 后启动客户端。opencode 启动器只确保 relay 运行、设置环境变量并启动 OpenCode；`opencode.jsonc` 不被 anyswitch 修改，托管 provider 由 OpenCode 插件从 store 注入；opencode 启动器还会生成统一实例 ID（`<cwd基名>-<launcher pid>`）经 `ANYSWITCH_AGENT_INSTANCE` 传给该插件，插件在 config hook 里给注入的 provider 加 `options.headers["x-agent-instance"]`（per-process，不写盘）。codex 启动器不经环境变量注入 relay token（桌面 GUI 看不到启动器环境），token 只以字面量 Authorization 头活在托管配置块里；实例标记走 `ANYSWITCH_INSTANCE_ID` 环境变量，由 config.toml 托管 provider 的 `env_http_headers` 占位符展开成 `x-agent-instance` 头。launcher 注入的 `<cwd基名>-<launcher pid>` 只是传输形态：消费侧（collector.startRequest 内的 normalizeInstanceId，按进程血缘把 launcher pid 解析到客户端 pid）会把它归一为规范的 `<agentId>-<客户端pid>`，cwd 基名降级为实例行的展示 label；归一失败（无数字尾或血缘查不到）才按原样保留为自定义 id。codex 特例：归一化与实例存活对账都只认引擎进程集合 `codexEnginePids`（codex.exe app-server，桌面 GUI 每会话拉起一个），ChatGPT.exe 外壳与 codex-code-mode-host.exe / codex-command-runner.exe 沙箱宿主计入卡面进程数但不产生实例行，实例 id 形如 `codex-<引擎pid>`，GUI pid 标签经血缘表折叠到引擎 pid。已接受的取舍（冷缓存窗口）：归一依赖 scanProcesses 的进程缓存（面板轮询驱动刷新）；relay 刚重启且缓存尚空时，恰好到达的 launcher 形态 id 归一失败会以原始 `<cwd基名>-<launcher pid>` 建行，与缓存热后归一出的 `<agentId>-<客户端pid>` 行短暂并存——面板双行、首请求计数拆两桶，旧行无流量刷新、10min 闲置 TTL 自愈。触发需「relay 刚重启 + 面板未轮询 + launcher 实例恰在发请求」三者同时成立，日常面板常开时打不中。
- `pi-merge-models.mjs` / `zcode-merge-config.mjs` / `reasonix-merge-config.mjs` — pi / zcode / reasonix 客户端配置合并（reasonix 额外把 relay token 写入 `%APPDATA%\reasonix\.env`，并在托管 provider 上带 `x-agent-id: reasonix` 头）。
- `codex-merge-config.mjs` — codex 客户端配置合并：托管渠道写入 `~/.codex/config.toml` 的 `[model_providers.anyswitch-*]` 表（`wire_api="responses"` 指向 relay 的 `/openai/<seg>/v1`，token 为字面量 Authorization 头，`x-agent-instance` 走 `env_http_headers` 环境变量名占位）；并生成模型目录 `~/.codex/model-catalogs/anyswitch-models.json`——字段模板取自模板资产 `codex-model-catalog-template.json`（上游 openai/codex 官方 models.json 的 gpt-5.5 条目逐字提取），生成时强制覆盖 `multi_agent_version:"v2"`、`supports_search_tool:false`、`prefer_websockets:false` 等请求塑形字段，config.toml 顶层写 `model_catalog_json` 指针；用户自指的 `model_catalog_json` 不覆盖（残留的旧目录文件会被清掉），空模型集时清掉指针与生成的目录文件。
- 实例归组兜底：用户绕过启动器直接在终端敲 npm shim 命令（如 `kimi`）时，请求既无 `x-agent-instance` 头、relay key 也无实例后缀；此类直连请求由 relay 侧 socket→PID 兜底归组——按连接对端端口查 netstat 缓存拿到客户端进程 PID，实例 id 形如 `kimi-<PID>`，面板实例行与实例计数因此照常出现。边角：客户端若经本地代理（环回代理进程）转发，连接归属的是代理 PID，多个实例会折叠进同一行。

### 安全与加解密
- `dpapi.mjs` — DPAPI 桥（调用 `dpapi.ps1`）：`protect`/`unprotect`，不缓存不记录、自分配缓冲区退出清零；v2 熵 `ApiCred|DPAPI|v2|<ProviderId>`。

## 5. 安全模型

- **DPAPI 加密**：上游 API Key 用 Windows DPAPI 按提供方熵封存（v2 熵 `ApiCred|DPAPI|v2|<ProviderId>`），密文存于 `credentials\` 下每提供方一个独立文件。
- **store 不含秘密**：`store.json` 按契约只存路由/元数据，绝不存 Key；只保留一个 `credentialFile` 引用。`store-schema.mjs` 递归扫描并拒绝任何秘密样字段名。
- **credentialFile 引用受控**：`credential-ref.mjs` 拒绝绝对路径/盘符/UNC/父级穿越/任何路径分隔符/Windows 保留设备名，确保无法逃出 credentials 目录。
- **会话 token 与 代理隔离**：relay 启动时 CSPRNG 生成 256-bit token，不落盘、不记录、随进程死亡；为环回地址强制设 `NO_PROXY`/`no_proxy`，防 relay 流量经继承的 HTTP_PROXY 外泄。
- **fail-closed**：无默认 provider、无前缀模糊匹配、解密失败不回退其它 Key。所有错误信息泛化，绝不泄露 URL/凭据/原始上游响应体/栈。
- **CAS 写保护**：store 写入走内容哈希 CAS（`casWriteFile` + 跨进程文件锁），并发改写以 `PreconditionFailed` 失败而非静默覆盖。

## 6. 测试

- 全量：在 `app\` 目录下运行 `npm test`（即 `node --test *.test.mjs`）。glob 由 Node 自带的 test runner 展开（Node ≥ 21），Windows npm script 不展开通配符也没关系；项目零依赖，无需 `npm install`。
- 单文件：`node --test <file>.test.mjs`（如 `node --test autostart.test.mjs`）。
- 环境依赖说明：
  - `dpapi.test.mjs` 走真实 Windows DPAPI（CurrentUser 作用域，经 `dpapi.ps1`），需要 Windows 交互登录会话下运行；非交互/无用户上下文的服务会话中会失败。
  - dsh / reasoning 相关用例（`dsh-launcher.test.mjs`、`dsh-merge-config.test.mjs`、`reasoning-fallback.test.mjs`）依赖本机已安装 dsh（roaming npm 根下的 `@deepseek-ai/dsh`）；未安装时 `loadPiAiReasoningIndex` 相关用例自动跳过（按空索引短路），其余用例不受影响。
