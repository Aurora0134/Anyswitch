# Anyswitch App（B 层）— 架构说明

## 1. 项目简介

Anyswitch 是一套把多家 OpenAI 兼容上游（以及经由协议转换的 Anthropic 客户端）统一收口到本地 relay 的凭据与路由系统。核心目标：

- **凭据不出本机**：上游 API Key 用 Windows DPAPI 按提供方熵封存，relay 仅在请求时即时解密、用后即焚，从不缓存、从不落盘明文。
- **store 即唯一真相源**：一份 v2 `store.json` 描述全部 provider/模型/路由元数据，relay 路由纯靠它，管理面（panel）写、relay 与各端点配置写手读。
- **无感多地址退避 + 协议透传**：主地址失败自动按序重试备用地址（180s 生成预算、5xx 透传）；Anthropic 客户端经 relay 无缝对接 OpenAI 兼容上游。
- **解耦独立常驻**：常驻 relay 宿主与独立常驻 Web 控制面板分离，relay 停止/崩溃时面板仍可用；支持免管理员权限开机自启（计划任务 AnyswitchRelay/AnyswitchWatchdog）。

B 层（本仓库）是 relay app：一个仅监听 127.0.0.1 的 HTTP 服务，负责鉴权、路由、协议转换、多 BaseURL 退避、流式转发，并由各客户端启动器把端点 + 一次性会话 token 注入子进程。

## 2. 架构分层

系统单层化，全部能力在 B 层（本仓库），共享同一份 v2 store（位于 `%LOCALAPPDATA%\Anyswitch\`）：

```
┌──────────────────────────────────────────────────────────────────┐
│  v2 store（单一真相源）  %LOCALAPPDATA%\Anyswitch\                   │
│    store.json        —— 路由/元数据, 不含任何秘密                   │
│    credentials\      —— 每提供方一个 DPAPI 密文文件                 │
│    app\              —— 本仓库（B 层 relay 代码）                    │
└───────┬───────────────────────────────┬──────────────────────────┘
        │ 只读 + 请求时解密              │ 只读（同步写各家配置）
        ▼                               ▼
┌───────────────────────────┐  ┌────────────────────────────────────┐
│  B 层 · relay（本仓库）     │  │  B 层 · 端点配置写手（本仓库）        │
│  loopback HTTP 服务：鉴权/  │  │  把托管渠道写进 8 家端点各自的配置    │
│  路由/协议转换/退避/流式,   │  │  文件（zcode/dsh/pi/kimi/qoder/     │
│  常驻宿主+Web 控制面板      │  │  codex/opencode/grok）             │
└───────────────────────────┘  └────────────────────────────────────┘
```

- **B 层 relay**：启动后读 store，把客户端请求路由到对应上游；不持有任何持久秘密，会话 token 随进程生灭。控制面 panel 与 relay 同层（见下文「控制面层」）。
- **B 层端点配置写手**：store 变更即把托管渠道（号池归并后）整体重建进各家配置文件；opencode 历史上由仓外注入插件供给（A 层，2026-08-29 管理 CLI 退役后仅存此件），2026-09-15 起同样收编为仓内写手（`opencode-merge-config.mjs`），插件整体退役。
- 解耦点就是 store：管理面（panel）写、relay 与配置写手读，路由完全由 store 决定（B 不内置任何 provider 列表）。

## 3. 核心特性

1. **多 BaseURL 无感退避**
   provider 可配置 `fallbackURLs`（string[]）。请求时按 `baseURL` + `fallbackURLs` 顺序逐个尝试：每次 180s 生成超时预算、指数退避（1s/2s/4s 封顶）、4xx 视为终态不重试、5xx 切下一个备用地址；端点耗尽时透传最后一次上游真实 5xx 状态码，纯网络/传输失败返回 502。

2. **reasoning 元数据采集**
   discovery（`GET /v1/models`）正确采集并映射各模型的 `contextWindow`、`maxOutputTokens`、`supportsReasoning`（布尔）；store-schema 接受 per-model 的 `supportsReasoning`/`reasoningEffortLevels`/`defaultEffort` 与 provider 级模板 `reasoningVariants`；catalog-resolver 透传这些字段。

3. **opencode 托管渠道外部注入**
   托管 provider（baseURL 指向 relay、apiKey 用 `{file:...}` 引用 relay token 文件、静态 `x-agent-id` 头 + `{env:ANYSWITCH_AGENT_INSTANCE}` 实例头）与 reasoning variants 由 `opencode-merge-config.mjs` 整体重建进 `~/.config/opencode/opencode.json`（纯 JSON 托管文件；opencode 会把它与用户手写的 `opencode.jsonc` 合并加载，后者永不被 anyswitch 触碰）。策略：号池经 `deriveVisibleChannels` 归并为单渠道、成员吸收；`supportsReasoning:false` 硬豁免；无显式 wire 值的 `off` 档不出 variants。仓外注入插件已于 2026-09-15 整体退役（其 shell.env 清秘功能随之放弃）。

4. **协议透传**
   Anthropic Messages API ↔ OpenAI Chat Completions 双向转换（仅翻译 Claude Code 实际发出的允许字段，其余丢弃，思考深度不在允许字段内）。Claude Code 点名的档位（`output_config.effort`／顶层 `reasoning_effort`／顶层 `effort`）因此只在原始 Anthropic body 里可见，由请求面注入层读出、夹到该模型已知挡位后写成上游的 `reasoning_effort`；只表示「要思考」而没给档的（`thinking.type=adaptive`、只带 `budget_tokens`）仍按库默认代填，`thinking.type=disabled`／`off`／`none` 则既不转发也不代填。详见下条请求面规则。

5. **兜底档位映射**
   catalog 生成阶段用关键词档位映射推断上下文窗口（各端点写入器与 Codex 模型目录共用 `context-fallback.mjs`）：GPT-5.x/GPT-6 → 1.05M，Claude Opus 4.6 起/Sonnet 5/Sonnet 4.6/Fable → 1M，Opus 4.5 与 Sonnet 4.5/Haiku → 200K，Kimi K3 → 1048576、Kimi K2 → 262144，Grok 4.5–4.7 → 500000，SenseNova 6.7/6.8 → 262144；未命中关键词的模型统一给 `1M` 兜底（而非 128K 硬编码或 999M 假数值）。

6. **DSH 推理挡位知识库兜底**
   DSH 对自定义 provider route 只认 `settings.yaml` 显式声明的 `reasoningEfforts`（`dsh-llm-pi-ai` 的 `resolveModelReasoning` 对非 catalog route 恒 `reasoning: false`），线上发现协议（`LlmDiscoveredModel`）也不携带推理字段——两层都断供。`reasoning-fallback.mjs` 读取 DSH 自带安装的 pi-ai 模型知识库（`@earendil-works/pi-ai/dist/providers/data/*.json`，与 DSH dispatch 同源），按模型 id（含 `go/` 等网关前缀的末段回退）解析 `thinkingLevelMap` wire 拼写与 `compat.thinkingFormat`，作为 store 字段/provider 模板之后的第 3 级兜底注入 `settings.yaml`。厂商条目优先于网关镜像；无 map 条目按 pi-ai 基础五挡语义展开；`enabled/off` 二值开关折叠为 `off/low`。fail-open：知识库缺失时返回空索引，不阻塞配置同步。

7. **store 单一真相源 + 写保护**
   v2 `store.json` 是唯一真相源，relay 路由纯靠它。写保护两道：(a) CAS 哈希写——`writeStore` 基于读取时拿到的内容哈希做 compare-and-swap（`casWriteFile` + 跨进程文件锁），并发改写会以 `PreconditionFailed` 失败而非静默覆盖；(b) generation digest——discovery 记录“决定请求去哪的 store 字段”的内容摘要，`POST /v1/messages` 重算并失配即返 409，防止路由漂移。

8. **思考强度挡位库（两面注入）**
   上游 `/models` 不声明推理挡位能力，客户端也大多不发 `reasoning_effort`，端点里的挡位区因此对中转站渠道整体失效。anyswitch 自持一份「模型 → 可选挡位」库补齐两面：

   - **数据**：`%LOCALAPPDATA%\Anyswitch\thinking-efforts.db.json`（人工可改；运行时实机文件不进仓库、不进 git 锚点，仓根另留一份脱敏基线 `thinking-efforts-baseline.json`，脱敏规则与恢复方式见 `docs/operator-data-baseline.md`）。读库唯一入口 `effort-catalog.mjs`：按 `mtimeMs`+体积缓存、改了下一轮即生效；解析失败沿用上一次可用副本并标 `stale`，文件缺失等价于「只有乐观默认」。条目级校验**逐条生效不整表作废**：形状不对/非文本却带挡位的行跳过并计数，挡位名不在词表内的剔除（剔空才跳过），`default` 不在该模型挡位列表内时按偏好重算而非弃行。模型 id 先归一化（循环剥 `[前缀]`、挡位词尾、日期尾、命名空间、Claude 家族名重排），再按点/横两种拼写查——生产 83 个模型 id 全部命中，其中 2 个只能靠点横折叠命中。
   - **配置面**：把挡位写进各端点自己的模型能力配置，让选择器出真挡位。pi `thinkingLevelMap`+`compat.thinkingFormat`、ZCode `reasoning{enabled,variants,defaultVariant}`、kimi `support_efforts`/`default_effort`/`reasoning` 与 `capabilities = ["thinking"]`——后一项是桌面端与网页端唯一认的「这个模型会思考」：它们那张模型目录表里没有 `reasoning` 这个键，而自动补 thinking 只在 anthropic 协议上发生，托管渠道一律是 `type = "openai"`，所以缺这一行就是「终端能选档、桌面端写着不支持思考强度」（2026-09-23 实测）。声明与 kimi 自探的能力取并集，只加不减，故不影响工具调用等既有能力；`always_thinking` 永不写入（那是连关掉思考都不许）。这三家过 `modelEffortSurface` 按各自词表裁剪。DSH 在 store 标注 / 渠道模板 / pi-ai 知识库之后追加一级兜底（不参与路由级方言判定），兜底级同样按 DSH 词表裁剪（dsh-llm-pi-ai 对 `reasoningEfforts` 键做固定集合校验，词表外的挡位名会让整份 settings.yaml 拒载）。词表共八档 `off/light/minimal/low/medium/high/xhigh/max`：`light` 是 gpt-5.6 及以上独有的最轻挡，pi/DSH 两家的固定档位集不含它、裁剪时剔除，其余端点原样渲染。Qoder 只取"有无挡位"的布尔（`capabilities.thinking` 必须是裸布尔——其运行时严格按布尔解析，对象形状会静默落成 false），挡位只能走请求面到达。
   - **请求面**：`effort-injection.mjs` 在出上游前补写思考深度（OpenAI 路径与 Anthropic 路径共用一个注入器实例）。五条规则——客户端自己把字段写在 body 里（含显式 `null`）一律不覆盖；客户端以别的协议形状点名档位（Anthropic 面没有 `reasoning_effort`）则转成上游字段，先夹到该模型已知挡位表内最接近的一档（保证发出去的值一定被接受、不会误触渠道拒收）；代填值取库 `default`，现库默认只落 `high`/`xhigh`、无 `max`，库缺失时乐观默认 `high`（不给 `max`：a6api 网关 ~296s 墙钟且照常计费）；上游 400/422 报文提到该参数则去字段重试一次并把渠道记为拒收。拒收集是**进程内存态**：`store.json` 归 panel 进程写（CAS+删除日志），relay 写它会与 UI 抢盘，重启丢一个标记只多一次重试。
   - **开关**：面板设置项「注入思考强度」（`settings.json` 的 `injectThinkingEffort`，默认开）同时管请求面注入与 kimi 全局 `[thinking]` 接管；关闭后请求原样透传。kimi 的 `[thinking]` 只改已存在的表：把 `enabled` 就地翻 true（表内没有该键时在表内补一行），找不到该表或值不是裸布尔就拒改并落日志（重复定义 `[thinking]` 会让 kimi 整份配置解析失败），改前由 `writeKimiConfigTomlWithBackup` 落带时间戳备份。
   - fail-open 贯穿两面：挡位解析失败绝不拖垮 relay 请求或配置同步。

## 4. 目录结构

### store / 真相源层
- `store-core.mjs` — store 管理的纯函数：渠道注册、模型发现结果的分类与合并、刷新语义、错误面判定，全部无 IO；面板写侧与诊断共用这一份判定，避免两处各自解释 store 形状。
- `store-service.mjs` — 面板写侧的 store 服务：把 `store-core` 的纯函数接到 `store-io`/DPAPI/catalog 上，承载注册、刷新、删除事务（先落删除日志、再动 store、最后动密文，任一步失败可判定该继续还是保留凭据）与路由链/号池写入。
- `store-io.mjs` — 存储 IO 层：加载校验 v2 store.json（返回内容哈希供 CAS），在固定 credentials 根下解析 `credentialFile`、读取密文；`writeStore` 支持 CAS 乐观并发；含只读的 v1 旧存储加载器。
- `store-schema.mjs` — v2 store 纯函数校验器：强制“store 不含秘密”不变量，校验 providers/models/`credentialFile` 引用/`fallbackURLs`/`contextWindow`/`maxOutputTokens`/`reasoningVariants`。
- `credential-ref.mjs` — `credentialFile` 引用纯函数校验器：拒绝绝对路径/盘符/UNC/父级穿越/分隔符/Windows 保留设备名，确保引用无法逃出 credentials 目录。
- `atomic-write.mjs` — 原子写助手：`atomicWriteFile`（temp+rename）、`casWriteFile`（基于内容哈希的 CAS + 跨进程文件锁）、`contentHash`（sha256 CAS 比较）。
- `catalog-generation.mjs` — 路由摘要（generation digest）：对决定“请求去哪”的 store 字段取哈希；discovery 记录、请求时重算失配返 409。
- `catalog-resolver.mjs` — 模型目录解析器：把 OpenCode 风格 model 条目解析为 Store 模型对象，透传 `contextWindow`/`maxOutputTokens`/`supportsReasoning` 等元数据。
- `context-fallback.mjs` — 上下文分层兜底规则（tier-based context fallback）。
- `reasoning-fallback.mjs` — 推理挡位知识库兜底：按模型 id 查询 DSH 内置 pi-ai 模型数据库（`thinkingLevelMap`/`thinkingFormat`），产出 DSH `reasoningEfforts` wire 映射。
- `effort-catalog.mjs` — 思考强度挡位库的唯一读入口（`%LOCALAPPDATA%\Anyswitch\thinking-efforts.db.json`）：模型 id 归一化 + 点横拼写候选、条目级校验、mtime+体积热加载、解析失败沿用旧副本，并按端点词表裁剪挡位；库缺失时给乐观默认 `high,xhigh,max`。
- `effort-injection.mjs` — 请求面注入：客户端未发挡位时补库默认，上游 400/422 提到该参数则去字段重试一次并把渠道记为拒收（进程内存态，不写 store）；受「注入思考强度」开关控制，OpenAI 与 Anthropic 两条路径共用一个实例。

### 协议与流处理层
- `protocol.mjs` — Anthropic ↔ OpenAI 兼容协议互转（纯函数）。
- `wire-id.mjs` — Claude wire ID 打包/解包：`anthropic/<provider>/<model>`，严格单次剥离、按首个 `/` 切分；`buildWireCatalog` 检测 wire ID 碰撞。
- `claude-tier-mapping.mjs` — Claude Code 档位入口名（Sonnet/Opus/Fable/Haiku）→ 托管模型的映射判据（纯函数）：剔 `[1m]` 后缀、认档位词本身与 `claude-` 家族段，两个档位词同现即不接管，未配置的档位不降级、不塌默认。判据与设置归一（`parseClaudeTierMappings`）同处一个模块，中继与设置层共用。
- `stream.mjs` — SSE 流翻译（纯状态机）：把上游 OpenAI `chat.completion.chunk` 流翻译为 Anthropic Messages SSE 事件序列。
- `openai-stream-guard.mjs` — OpenAI 流式响应守卫（坏流过滤、孤儿 tool_call 拦截、reasoning 字段即时放行）；可选的信封补齐（`fillChunkEnvelope`，仅 grok 开启）为缺 `id`/`created`/`model` 的数据块补字段并回显首值。

### relay / 服务层
- `handler.mjs` — Anthropic 路径请求处理器：恒定时间 token 鉴权 → 加载 store → 档位映射接管预检（仅 Claude 端点、仅严格解析已拒的档位名）→ 解包 wire ID → generation 校验 → 解密凭据 → 协议转换 → fallback URL 列表发上游；除该预检外全程 fail-closed。
- `openai-handler.mjs` — OpenAI 原生路径处理器：`/v1/models` 与 `/chat/completions` 直通到 OpenAI 兼容上游（不做协议翻译）。
- `openai-path.mjs` — OpenAI relay 路径解析。
- `server.mjs` — Anthropic 前端 loopback HTTP 服务（127.0.0.1、随机会话 token）。
- `openai-server.mjs` — OpenAI 前端 loopback HTTP 服务。
- `launch.mjs` — 生产装配线：组装 loadStore + DPAPI loadCredential + `createRetryingFetch`（180s 超时/指数退避/5xx 透传/502 兜底）。
- `launcher.mjs` — Claude 启动器：注入端点与 token、设置 NO_PROXY、剥离继承 API Key。

### 控制面层
- `relay-host.mjs` — 常驻 relay 宿主（127.0.0.1:47821，crash 不自愈是刻意设计）。
- `panel-host.mjs` — 独立常驻控制面板宿主（127.0.0.1:47820）：relay 停止/崩溃时面板仍可用，并承载 followAgent 探活 watcher。
- `panel.mjs` — 面板路由（`/panel` 与 `/panel/api/*`），relay 与 panel-host 两个进程共用。关于页通过 `app-info`、`updates`、`environment` 及逐客户端官方版本接口访问只读服务；客户端安装/更新走 `POST /panel/api/environment/update` 加 `GET /panel/api/environment/update/<runId>` 查询进度：写请求沿用面板写闸门，服务端锁按客户端分（同一个客户端并发第二个任务 409，不同客户端并行放行——同一个包的两份并发全局安装会互搬目录，不同包各写各的目录），任务在后台跑、结果留内存供轮询，安装完成或失败后强制重查本地检测与官方最新再归为已更新/未生效/失败/装上了跑不起来。当前 Anyswitch 版本在模块随进程启动加载时读取相邻 `package.json` 并保存，不在首次查询时重读磁盘，避免将尚未运行的新代码报成当前版本。
- `panel-ui/panel.html` — 面板 Web UI 骨架（DOM + 防闪烁/开屏内联小脚本，2026-09-17 起样式与主脚本外链到 `panel-ui/panel.css` / `panel-ui/panel.js`）；静态文件按请求检查 mtime 缓存与 ETag，刷新可加载新的页面资源。后端模块和进程版本需 panel-host 换新进程才生效；现有「重启」按钮先重启 relay、再重启 panel-host，会中断在途请求，执行时机由用户安排。
- `agent-discovery.mjs` — 无启动副作用的客户端路径发现，供启动器和本地环境检测共享；除 Grok Build 一次有界 `--version` 自报外，检测不得调用启动器或目标客户端。
- `environment-service.mjs` — 关于页本地环境服务：读取九个客户端选定安装的公开包元数据、包装脚本目标、必要的 PE/ASAR 产品资料及 Microsoft Store 包注册信息；返回 Windows、当前面板 Node 版本、安装发现状态与版本来源。Codex 一张卡呈现两行安装：CLI 行读 npm 全局 `@openai/codex` 的包清单，桌面行读商店包 `OpenAI.Codex` 的注册版本。只发现安装不代表可运行、已登录或已接入 relay；路径存在但缺执行体、无法读产品版本、装了但跑不起来、读取失败分别呈现。
- `client-lifecycle.mjs` — 关于页安装/更新的执行面，与只读检测分开，两种形态：六个 npm 托管 CLI 各绑一个固定包名，用当前 node 直接跑与它同目录的 `npm-cli.js` 执行全局安装；Grok Build 的原生执行体先跑检测到的 `grok.exe update`，失败才降级到 npm 安装——降级那一跳必须钉住服务端查到的官方版本、显式把 registry 指回官方源并放行该包脚本（用户 npm 配置的 registry 可能停在同步落后的镜像上，跟 `@latest` 会把执行体降级；脚本被白名单拦下则装完二进制也不动），版本号不可信或检测不到执行体时不做兜底安装。原生自更新的客户端只接受更新，未安装时不代装：从裸装起切换安装形态不由一个按钮代劳。zcode/qoder 是桌面应用，两张表都不收，面板只提供官方入口。所有命令不经 shell、不依赖 PATH，客户端 id 只做白名单查表。超时只当泄漏兜底（分钟级），不中途杀慢安装。
- `version-check.mjs` / `release-service.mjs` — 版本比较与固定官方来源查询。Anyswitch 查固定仓库 Releases，排除草稿；preview 身份包含预发布，正式版身份优先正式发布、正式渠道一个 Release 都没有时回退到最新预览版并带预览标识；按 SemVer 选择目标并返回对应真实发布页；分页不完整或网络失败不能报「已是最新」。客户端官方版本逐项查询，失败互不影响；远端缓存十分钟、本地检测缓存一分钟，进关于页自动查一次走缓存、手动检查强制刷新但复用同一进行中请求，不接入每秒看板轮询。
- `panel-launcher.mjs` / `panel-app.vbs` — 桌面快捷方式入口：拉起 panel-host 并打开浏览器面板。
- `agent-skills.mjs` — Skills 管理 tab 后端：主仓库扫描（递归识别含 SKILL.md 的目录）、NTFS junction 部署/解除到各 agent 端点（claude/codex/zcode/opencode/pi/kimi/dsh/qoder/grok）、回收站删除、端点本地 skill 收编合并、原生目录选择对话框；配置存 `%LOCALAPPDATA%\Anyswitch\skills.json`（仅存 repoPath，部署状态以文件系统为准）。
- `relay-process-manager.mjs` — relay 生命周期（按记录 PID 启停/重启）。
- `agent-watcher.mjs` — followAgent 自愈：检测到 coding agent 运行而 relay 未启时静默拉起。
- `agent-sync.mjs` — store 变更毫秒级同步下游 agent 配置（zcode/dsh/pi/kimi/qoder/codex/opencode/grok）。
- `relay-settings.mjs` — 持久设置（`%LOCALAPPDATA%\Anyswitch\settings.json`，原子写）；抗截断的总开关与各端点开关（`keepAlive.endpoints[agentId]`）同在此规整，端点开关按端点深合并、缺省跟随总开关。
- `instance-socket-owner.mjs` — relay 侧 socket→PID 兜底数据源：解析 netstat 输出维护「连接对端端口 → 客户端进程 PID」缓存（同步查快照、后台 fire-and-forget 刷新），openai 服务器在请求无 `x-agent-instance` 头时用它合成 `<agentId>-<PID>` 实例 id（此即规范形态，消费侧归一对它是恒等映射）。
- `autostart.mjs` — 开机自启管理（每用户计划任务 AnyswitchRelay/AnyswitchWatchdog，免管理员权限）。
- `git-anchor.mjs` — 将 `app/.git` 锚定为指向耐久对象库（`%LOCALAPPDATA%\Anyswitch-git\objects`）的 gitfile；默认关闭（每次启动直接跳过），设 `ANYSWITCH_GIT_ANCHOR=1` 才开启。

### 关于页的版本来源边界
- 本地版本来自所选安装的产品资料；唯一例外是 Grok Build——原生二进制，没有可读的产品版本资源，改由一次带超时、无 shell 的 `grok --version` 自报，探测不达时呈现「已安装但无法运行」，文件消失则回落未找到。其余情形不运行客户端的 `--version`，也不以安装证据推断登录或接入状态。Codex 一张卡两行安装：CLI 行的版本读自 npm 全局 `@openai/codex` 的 package.json（即更新按钮代管重装的那份工件），桌面行读自 Microsoft Store 包 `OpenAI.Codex` 的注册版本（四段 Appx 版本剥去尾部 `.0` 归一；该行不提供更新动作）。Claude Code 的包与 PE 产品版本冲突保留提示；OpenCode 的 Bun 版本不作为产品版本。Kimi Code 的 npm 包与旧 Python `kimi-cli` 分开识别；ZCode 以 ASAR 中的产品版本为准，PE 构建号仅作参考；桌面应用的 ASAR 取实际会运行的那一份安装，Qoder 因此按版本目录取最新（安装根目录那份是首次安装的过期副本，PE 版本信息同样停在旧版，两者都不能作依据）。
- 官方查询限定产品来源：Claude Code、OpenCode、Pi、Kimi Code、DSH 取对应 npm 包的 `latest`；Codex 的 CLI 行同样取 `@openai/codex` 的 `latest`——它的本地版本读自 npm 全局包、更新装的也是这个包，查 GitHub Release 会在两源发版不同步时报出一个装不到的新版本；Grok Build 取 `@xai-official/grok` 的 `latest`，执行体虽是原生二进制，官方分发与它自身的 `grok update` 都以这个 dist-tag 为准。Codex 桌面行查 Microsoft Store 更新清单；ZCode 查官方 stable manifest；Qoder 查官方桌面清单。npm `latest` 不等于稳定版，也不代表读取了用户的更新渠道，DSH 等版本中的 `rc` 标识须保留；用户 npm 配置把 registry 指向同步落后的镜像时，比对基准仍取官方 registry 的值，不取镜像的 dist-tag。
- Qoder 是纯桌面条目：`~/.qoder/entry/qoder.cmd` 是桌面 IDE 随装的命令调度器（`code.cmd` 同构），不是独立安装的 CLI 产品，不作检测对象；包装入口残留而执行体缺失不能报已安装。Qoder 的每次自更新把整包装进安装根目录下的 `.qoder-versions/<版本>/`，安装根目录那份 ASAR 从此停在首次安装的版本，因此本地版本取版本目录里版本号最大、且执行体与 ASAR 都在的那一份安装，呈现的路径与版本都来自它；那份 ASAR 读不出产品版本时呈现「版本无法读取」，不回落安装根目录的旧版本，也不拿目录哈希、运行时版本或另一产品版本代填。没有版本目录的安装（含 ZCode 这类原地安装的桌面应用）仍读安装根目录 ASAR。无法读取本地版本时仍可独立显示官方版本。
- 关于页的版本比对与链接是只读的；安装/更新只走 `client-lifecycle.mjs` 的白名单执行面（见上），包名、目标版本与执行体路径都由服务端决定，不接受调用方给出的包名、版本或命令。查询不携带用户认证和设备标识；接口只接受白名单客户端和刷新参数，不接受任意 URL、路径或命令。

### 客户端集成
- `codex-launcher.mjs` / `opencode-launcher.mjs` / `pi-launcher.mjs` / `zcode-launcher.mjs` / `dsh-launcher.mjs` / `kimi-launcher.mjs` / `qoder-launcher.mjs` / `grok-launcher.mjs` — 各客户端启动器：探测或拉起 relay、同步托管配置，按各客户端约定提供鉴权与实例标识，并设置 NO_PROXY 后启动客户端。
- `qoder-cdp-refresh.mjs` — Qoder 模型目录重载：Qoder 没有从配置面触发目录刷新的入口，启动器因此带一个只绑 127.0.0.1 的 DevTools 端口拉起它，等渲染进程就绪后调用一次重载。尽力而为——端口不可用、渲染进程未就绪或对方接口变动都只记录并跳过，不阻塞也不打断启动。
- opencode 启动器确保 relay 运行、经 `writeOpencodeConfig` 同步 `~/.config/opencode/opencode.json`、设置环境变量后启动 OpenCode；生成的统一实例 ID（`<cwd基名>-<launcher pid>`）经 `ANYSWITCH_AGENT_INSTANCE` 传给子进程，由托管配置里每个 provider 的 `{env:ANYSWITCH_AGENT_INSTANCE}` 头引用展开为 `x-agent-instance`（per-process，不落盘；直启无该环境变量时头为空，relay 丢弃后走 socket→PID 兜底）。
- launcher 注入的 `<cwd基名>-<launcher pid>` 只是传输形态：消费侧（collector.startRequest 内的 normalizeInstanceId，按进程血缘把 launcher pid 解析到客户端 pid）会把它归一为规范的 `<agentId>-<客户端pid>`，cwd 基名降级为实例行的展示 label；归一失败（无数字尾或血缘查不到）才按原样保留为自定义 id。
- 已知限制（实例归一的冷缓存窗口）：归一依赖 scanProcesses 的进程缓存，该缓存由 relay 启动时预热（relay-host 的 warmProcessScanCache，冷探针不留给面板首读）、之后由面板轮询驱动刷新。启动预热轮落地前（约一次进程探测的耗时）到达的 launcher 形态 id 仍会归一失败，以原始 `<cwd基名>-<launcher pid>` 建行，与缓存热后归一出的 `<agentId>-<客户端pid>` 行短暂并存（面板出两行、首请求计数拆两桶）；旧行无流量刷新，由 10min 闲置 TTL 清除。需「relay 刚启动 + 预热扫描未落地 + launcher 实例恰在发请求」三者同时成立才触发。
- `kimi-merge-config.mjs` / `zcode-merge-config.mjs` / `dsh-merge-config.mjs` / `pi-merge-models.mjs` / `qoder-merge-config.mjs` / `opencode-merge-config.mjs` / `grok-merge-config.mjs` — 各家客户端配置合并：把 store 的托管渠道写进各家自己的配置文件，格式与位置按各家约定（kimi `~/.kimi-code/config.toml`、zcode `~/.zcode/v2/config.json`、dsh `~/.dsh/settings.yaml`、pi `~/.pi/agent/models.json`、qoder `~/.qoder/settings.json`、opencode `~/.config/opencode/opencode.json`、grok `~/.grok/config.toml`）。opencode 带 `x-agent-id: opencode` + `{env:}` 实例头，apiKey 用 `{file:}` 引用不落盘；qoder 无自定义头能力，改由 URL 段身份前缀归属（见 `openai-path.mjs`）。
- `codex-merge-config.mjs` — codex 客户端配置合并：托管渠道写入 `~/.codex/config.toml` 的 `[model_providers.anyswitch-*]` 表（`wire_api="responses"` 指向 relay 的 `/openai/<seg>/v1`，token 为字面量 Authorization 头，`x-agent-instance` 走 `env_http_headers` 环境变量名占位）；并生成模型目录 `~/.codex/model-catalogs/anyswitch-models.json`——字段模板取自模板资产 `codex-model-catalog-template.json`（上游 openai/codex 官方 models.json 的 gpt-5.5 条目逐字提取），生成时强制覆盖 `multi_agent_version:"v2"`、`supports_search_tool:false`、`prefer_websockets:false` 等请求塑形字段，config.toml 顶层写 `model_catalog_json` 指针；用户自指的 `model_catalog_json` 不覆盖（残留的旧目录文件会被清掉），空模型集时清掉指针与生成的目录文件。
- `merge-common.mjs` — 上述合并模块共用的 sidecar 读写契约：数据根下一个 JSON 对象 `{ "providers": [ids…] }`（id 排序、2 空格缩进、结尾换行），记录 anyswitch 托管了哪些条目，解除托管时据此精确剥离、不碰用户自有条目。
- 不经启动器直接启动客户端（例如在终端里跑 `kimi`）是支持的用法，此时请求既无 `x-agent-instance` 头、relay key 也无实例后缀；这类直连请求由 relay 侧 socket→PID 兜底归组——按连接对端端口查 netstat 缓存拿到客户端进程 PID，实例 id 形如 `kimi-<PID>`，面板实例行与实例计数因此照常出现。边角：客户端若经本地代理（环回代理进程）转发，连接归属的是代理 PID，多个实例会折叠进同一行。
- DSH 的两个界面（`dsh web` 与社区终端前端 `dst`）共用一张卡，靠进程命令行分面：一次 npm 形态的 TUI 启动是三条 node.exe 行（全局启动器壳 → profile 内启动器壳 → `dsh --profile dsh-tui`），前两条只是 stdio 继承的委托壳。DSH 桶因此分 engine/family 两集（同 codex 的 `codexPids`/`codexEnginePids` 形状），`procCounts.dsh`、实例行与存活判定一律只看 engine 集（即 harness 本体进程），family 集只服务 pid 存活对账；与 codex 的差别是刻意的——DSH 的壳不是产品界面，codex 的 ChatGPT.exe 是。`dsh plugin --profile x add` 与 `--dump-config` 走同一个 bin.js 但不启动会话，同样不计。面名取 `--profile <name>` 或 `dsh web` 别名，喂给卡头副行（`Web ×1 · TUI ×2`）与实例行徽标；读不出 profile（plain-tasklist 回退行、pip 打包的 `dsh.exe` 无命令行）时副行按 `未知 ×n` 如实兜底、行上不贴徽标，副行加总恒等于卡上进程数。
- DSH 实例行是**进程粒度**：一个 web 进程一行、每个 TUI 终端一行，同一进程里的多会话（后台会话、fork、subagent）并到该行；web 侧所有浏览器会话共用一个进程。上限由客户端决定，不是实现取舍——DSH 把会话 id 一路传到 LLM 调用层却不让它上线（`dsh-llm-pi-ai` 的 compat 门把会话亲和头标为 `withhold`，写进 settings.yaml 会被判非法；`prompt_cache_key` 只在 `api.openai.com` 或长缓存保留时才写；强制 UA 是固定的 `产品/版本 (+URL)` 串），所以请求面最多到进程。每会话真值仍走 `session-scan.mjs` 的 `~/.dsh/sessions` 适配器，web 与 TUI 同库同源。
- Kimi Code 的一个端点 id 之上有三个界面：终端 `kimi`、`kimi web`（在终端里前台起的 server，浏览器只是它的观看端）、原生桌面端 `Kimi Code.exe`。三面共用同一份 `~/.kimi-code` 家目录，因此托管渠道（`config.toml` 的 `anyswitch-managed-kimi` 块）、`AGENTS.md`、skills 投影与会话库对三面同时生效，不需要任何额外的写入面。桌面端是 Electron 原生包，命令行里没有 `kimi-code` 安装路径，原有的 node 路径谓词一条都不命中——故镜像名 `Kimi Code.exe` 进 kimi 桶，并照 qoder/ChatGPT.exe 的口径过滤 `--type=` 辅助子进程。kimi 桶同分 engine/family 两集，`procCounts.kimi`、实例行与存活判定只看 engine 集；与 DSH 相反的是，桌面端的主进程本身就是会话属主（kimi 核心内嵌其中、relay 连接挂在它身上），所以它计数、它出行。
- Kimi 的分面不读命令行：桌面端由镜像名定性（`Desktop`）；剩下的 node 行里，谁在 `~/.kimi-code/server/instances/` 名下留了以自己 pid 署名的登记，谁就是 `kimi web` 的 server（`Web`），没留的就是终端客户端（`TUI`）。这张表的写入方只有四条，且全部经过客户端唯一的登记调用点（2026-09-23 读自本机实际执行的 `@moonshot-ai/kimi-code` 安装包）：`kimi web`、`kimi rc` 远程控制面板、在 TUI 里把当前会话交给浏览器（TUI 退出后同一个进程就地变成 server）、以及内嵌同一份 server 代码的官方桌面端；纯交互式 TUI 不起 server、不留记录。桌面端的 pid 也记在同一张表里，所以这张表只证明「有界面在服务」，不证明是哪一个界面。读不出的那一档落 `未知 ×n`，副行加总恒等于卡上进程数，面名一律由后端下发（`KIMI_SURFACE_LABELS`），前端不猜也不产名字。注册表**只分面、不判活**：`kimi-server-registry.mjs` 返回的 pid 必须已经在本轮扫描的 engine 集里才算数，残档既撑不出实例行也点不亮卡片；提级方向因此只有 `TUI → Web`，无权改动桌面行；旧档的判据取心跳时效——客户端每 15 秒重写一次自己的登记，而桌面端退出时不删档（真机 2026-09-23 12:55 那次退出后登记文件原样留在盘上），故窗口按 6 个心跳周期收在 90 秒，超期退回终端面；TUI 交棒那条路会让同一个进程号中途从 `TUI` 变 `Web`，面由每轮扫描重算，卡头副行与实例行在同一轮里一起跟上；整轮读不出（目录缺失、无权限、格式变更）就退化成"所有 kimi 进程算终端面"，计数与卡片不受影响。请求面上三面共用同一条 kimi 归属（桌面端不经启动器，UA 是 `kimi-code-desktop/<ver>`，靠 `openai-server.mjs` 的 UA 嗅探命中），本期不由请求面承担分面——进程面是快照、请求面是事件流，两套口径并存必然出现"卡上 1 个进程、统计页两个面"这类无法核对的组合。

### 路由决策层
- `pool-providers.mjs` — 可见渠道派生的唯一源头（`deriveVisibleChannels`）：算出端点应当看到哪些渠道与模型（号池吸收其成员、按池展示），运行时 wire 目录与各客户端配置合并模块都从这里取数，避免多处各自实现导致口径漂移。
- `pool-routing.mjs` — 号池路由原语（纯函数＋一张进程内存粘性表）：号池把 2–5 个 provider 收在自己的 id 下，请求命中池 id 时按粘性成员分发，成员失败则退避到下一档。无 IO，store 由调用方传入。
- `chain-routing.mjs` — 路由链原语（纯函数＋进程内存链状态表）：虚拟模型 `auto` 按端点配置的链逐跳走，节点失败后退避（一跳本次请求彻底失败即计数，链尾一跳同样计数；连续失败达阈值即锁死）、每 5 分钟由请求驱动惰性回链首重试、成功即粘回链首，并产出面板链灯所需的节点状态。无 IO，store 由调用方传入。
- `modalities-fallback.mjs` — 输入模态的本机兜底表：优先级为 store 显式声明 > 本表推断，数据由本仓库自持，不属于任何端点的目录。

### 流转发与保活
- `stream-pipe.mjs` — 三条 relay 管线（OpenAI 直通、常驻 Anthropic、一次性 Anthropic）共用的流转发管道：抗截断保活、重试、usage 采集与错误归因都在此一处实现，各前端只传入自己的渠道描述符。
- `keepalive-backoff.mjs` — 保活重试的退避时长表，纯函数、RNG 可注入，便于测试钉死具体数值。
- `late-socket-instance.mjs` — socket 归属晚于请求开始时的实例补挂：把已开始的请求挂到后到的进程身份上。参与端点是白名单（`SOCKET_FALLBACK_AGENT_IDS`，与 collector 的 `instanceBuckets` 同口径：kimi/opencode/pi/codex/grok/dsh），未列入的端点一律不兜底。

### 观测·统计·会话
- `agent-metrics.mjs` — 进程与请求观测采集器：扫描各家客户端进程、维护端点级与会话级实时状态、按 agentId 分桶，向面板下发看板所需的计数、折线样本与链归因；含实例 id 归一与迟到挂载重放。累计量与样本窗跨进程重启持久化（`agent-metrics-snapshot.json`，30s 防抖 + 退出前冲刷）：relay 重启/换新后看板立即回到重启前的数据，不再出现整段空窗；在飞计数与故障闩锁属活状态，恢复时一律归零。
- `model-stability.mjs` — 模型稳定性：8 小时滚动窗、10 分钟桶、按调用量取前 5，进程内存态＋可选 sidecar 持久化，供面板链灯与统计页判渠道健康。
- `usage-journal.mjs` — 逐请求用量流水：数据根 `usage\` 下按日滚动的 JSONL（requests / sessions 两条流），90 天自清理。它是 relay 热路径的旁路——写失败只告警，绝不抛回调用方。
- `usage-stats.mjs` — 在流水之上做聚合，产出使用统计页的状态。每次 `getState()` 现读且分段读取（热力图读它固定的 90 天，其余口径只读所选窗口），不设聚合缓存；各项口径的定义与红线见 `docs/stats-spec.md`。
- `logger.mjs` — 进程内日志器：环形缓冲＋发布订阅，面板的实时输出窗口经 SSE 订阅它。
- `session-scan.mjs` — 面板「会话管理」的数据层：按需现扫各客户端自己的会话存储，不建索引、不自建数据库，每次列表都重读对方文件；各家记录形状的差异（含多帧压缩容器、派生索引滞后等）在本模块内适配掉。

### 预设注入层
- `agent-prompts.mjs` — 预设数据面：数据根下的 `prompts.json`（总开关、预设增删改查、逐端点 off 覆盖），文件损坏时严格隔离不连带覆写。某端点的生效集＝总开关 ∧ 预设 enabled ∧ 未被该端点 off。
- `agent-prompts-inject.mjs` — 预设注入面：把各端点的生效集渲染进该端点自家的全局指令文件，写成带 `# >>> anyswitch-managed-prompts` / `# <<< anyswitch-managed-prompts` 标记的托管块；只注正文不注标题，幂等、只剩托管块时删文件以字节级还原，单端点失败互不影响。各端点目标文件与时机见 `skills/anyswitch-preset/SKILL.md`。

### 进程与运维
- `agent-watchdog.mjs` — followAgent 的独立看门狗进程（占用 47822 标记端口）：不依赖面板是否开着，检测到 coding agent 在跑而 relay 未启时拉起。
- `agent-sync-run.mjs` / `agent-sync-spawn.mjs` — 配置同步的独立短命进程与其拉起助手。同步刻意跑在常驻进程之外：每次新进程都从磁盘现读 `agent-sync` 与各 merge 模块，因此改动这些模块无需重启 relay 或面板。
- `panel-host-restart-helper.mjs` — 一次性重启助手：面板页的「重启」按钮由 panel-host 自己承载，进程无法重启自身，故由本助手等旧进程退出、拉起新进程并确认应答。
- `git-anchor-repair.mjs` — 运维脚本：修复或迁移 git 锚点（含把改名前路径下的旧对象库搬到 `%LOCALAPPDATA%\Anyswitch-git\objects`、重设 ACL）。会改动权限与对象库，属需人工授权的一次性操作。

### 安全与加解密
- `dpapi.mjs` — DPAPI 桥（调用 `dpapi.ps1`）：`protect`/`unprotect`，不缓存不记录、自分配缓冲区退出清零；v2 熵 `ApiCred|DPAPI|v2|<ProviderId>`。
- `pi-relay-token.mjs` — 常驻 relay 令牌的生成与读取（数据根下按端点存放），供无法自带鉴权头的客户端复用。

## 5. 安全模型

- **DPAPI 加密**：上游 API Key 用 Windows DPAPI 按提供方熵封存（v2 熵 `ApiCred|DPAPI|v2|<ProviderId>`），密文存于 `credentials\` 下每提供方一个独立文件。
- **store 不含秘密**：`store.json` 按契约只存路由/元数据，绝不存 Key；只保留一个 `credentialFile` 引用。`store-schema.mjs` 递归扫描并拒绝任何秘密样字段名。
- **credentialFile 引用受控**：`credential-ref.mjs` 拒绝绝对路径/盘符/UNC/父级穿越/任何路径分隔符/Windows 保留设备名，确保无法逃出 credentials 目录。
- **会话 token 与 代理隔离**：relay 启动时 CSPRNG 生成 256-bit token，不落盘、不记录、随进程死亡；为环回地址强制设 `NO_PROXY`/`no_proxy`，防 relay 流量经继承的 HTTP_PROXY 外泄。
- **fail-closed**：无默认 provider、无前缀模糊匹配、解密失败不回退其它 Key。所有错误信息泛化，绝不泄露 URL/凭据/原始上游响应体/栈。唯一有界例外是 Claude Code 档位映射：用户在设置里为某个档位指定托管模型后，中继才把那个档位名改投过去——只作用在 Claude 端点、只在严格解析已经拒绝之后、只认 unmistakable 的档位名（未配置的档位仍照原样拒绝，不降级、不塌默认）。
- **CAS 写保护**：store 写入走内容哈希 CAS（`casWriteFile` + 跨进程文件锁），并发改写以 `PreconditionFailed` 失败而非静默覆盖。

## 6. 测试

- 全量：在 `app\` 目录下运行 `npm test`（即 `node --test *.test.mjs`）。glob 由 Node 自带的 test runner 展开，Windows npm script 不展开通配符也没关系。推荐 Node.js 24 LTS；API 下限范围为 `>=22.15.0 <23 || >=23.8.0`，用于满足会话读取的内置 SQLite 与 zstd 依赖，不代表范围内所有 Node 版本均已实测。relay 与面板自身零依赖，但套件覆盖虚拟终端的终端宿主（`terminal-host.mjs` 导入 `node-pty`），首次运行前先执行一次 `npm install`。
- 单文件：`node --test <file>.test.mjs`（如 `node --test autostart.test.mjs`）。
- 环境依赖说明：
  - `dpapi.test.mjs` 走真实 Windows DPAPI（CurrentUser 作用域，经 `dpapi.ps1`），需要 Windows 交互登录会话下运行；非交互/无用户上下文的服务会话中会失败。
  - dsh / reasoning 相关用例（`dsh-launcher.test.mjs`、`dsh-merge-config.test.mjs`、`reasoning-fallback.test.mjs`）依赖本机已安装 dsh（roaming npm 根下的 `@deepseek-ai/dsh`）；未安装时 `loadPiAiReasoningIndex` 相关用例自动跳过（按空索引短路），其余用例不受影响。
