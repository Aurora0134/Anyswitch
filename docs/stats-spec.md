# 使用统计页现行规格

> 本文件是「使用统计」tab（panel-ui/panel.js statsView + usage-stats.mjs + usage-journal.mjs）的**单一现行规格**。
> 维护约定：**改统计页行为的提交必须同笔更新本文件对应条目**。本文件只留「现在是什么」，变更过程由提交历史承载。
> 条目格式：红线约束强制挂「锚点（文件/常量/函数/测试名）」；无锚点的条目视为草稿。
> 行号会漂移，定位以常量名/函数名/测试名为准。

## 1. 数据口径（每卡的来源 / 时间窗 / 单位）

数据源：usage journal（`%LOCALAPPDATA%\Anyswitch\usage\`，requests/sessions-YYYY-MM-DD.jsonl，按日滚动，90 天自清理）。
聚合：usage-stats.mjs `createUsageStats().getState(days)`，每次调用重读 journal（无聚合缓存）；读取已分段——热力图口径单独读 90 天，其余口径只读所选窗口。
接口：`GET /panel/api/stats/state?days=1|7`（panel.mjs，days 经 clampStatDays 单点钳制；usage 块恒同时返回 24h+7d 双窗口，见 R-04）。

| 卡 | 口径 |
|---|---|
| 今日概览 | **本地自然日**，与 days seg 无关。请求数 / 总 tokens(prompt+completion) / 缓存命中率(cached/prompt) / 平均 TTFT(仅成功且 ttftMs>0) / 成功率（**不含用户取消**，abort 不落行）。 |
| 90 天热力图 | 固定 90 天日轴（日历运算防 DST），tokens=prompt+completion，**只算 request 行**，零填充。 |
| Token 趋势 | days=1 → 24×1h 本地整点桶；days=7 → 21×8h 桶（对齐本地 0/8/16 点）；末桶进行中。三口径：渠道=providerId / 端点=agentId / 模型=`providerId/model` 复合键。值=各桶 prompt+completion。 |
| 模型用量卡 | **独立时间 seg（近 24h/近 7 日）**，不随全局 days seg；后端单次响应同时下发 `usage["1"]`/`usage["7"]` 双窗口，切换只本地重渲。窗口内单节点总量；**model 口径=裸模型名跨渠道合并**（与趋势的复合键不同，usage-stats.mjs buildUsage 注释）。**版式：卡体左右两栏**——左=环形图+图例排行榜，右=竖直柱状图（同源同排序同色，复用 `statsUsageColorOf(key, allNodes)`，「其他」灰同出场；柱从地面线生长，与环同一 `USAGE_REVEAL_MS`/easeOutCubic/同一 rAF，触发时机同一 `revealNow` 判定）。 |
| TTFT | 仅 `ok===true && ttftMs>0` 的行；按桶 avg/p95（nearest-rank）+ 按模型 Top5。**非流式请求的 ttftMs 是全时长代理**（采集侧约定）。 |
| TPS | 每模型 `Σcompletion / Σ((durationMs-ttftMs)/1000)`（总量加权，非单请求平均）；排除 completion<=0 或生成段 <0.2s。**非流式流量因 ttft 代理恒被排除**（见 R-14）。**样本 <10 的模型整行不显示**（小样本均值被单请求噪声主导，见 R-17）。 |
| 端点工时表 | 按 agentId：requests / tokens / sessions(30min 空档切段数 + sessionEnds) / workMs(busy 区间并集)。**legacy session 行 tokens 计入本卡但不进热力图/趋势**——两口径对不上是设计使然。 |

布局：TTFT 与 TPS 两卡在 `.skills-grid.stats-quad` 网格并排一行（左列=TTFT，右列=TPS，窄屏折行）。

## 2. 红线约束

R-03 与 R-10 已作废，编号不再复用，其余编号保持稳定。

### R-01 横条填充上限 85%
最长条不顶到轨道右端，留出呼吸余量。
- 锚点：panel.js `STATS_BAR_FILL_MAX = 85`
- 钉住：panel.test.mjs「最长条不顶到轨道满宽」（约 :1422，断言常量 <100 且 =85）

### R-02 趋势图 Top5+其他
趋势与用量环均为 Top-5，其余并入 `__other__`（label「其他渠道/端点/模型」）。
- 锚点：usage-stats.mjs `TOP_N = 5`（约 :51）
- 钉住：usage-stats.test.mjs `__other__` 合并用例

### R-04 今日概览=自然日、热力图=90 天，均不随 days seg
days seg 只作用于趋势/TTFT/TPS/工时表。**模型用量环有独立的 24h/7 日 seg**（`statsPrefs.usageDays`），不随全局 days seg；后端 `getState` 每次响应同时下发 `usage["1"]`/`usage["7"]` 双窗口（分段读范围放宽到覆盖 7d 用量窗），前端切换只本地重渲。
- 锚点：usage-stats.mjs overview（today 过滤）/ heatmap（dayAxis 90）/ `usageFor`（双窗口 usage）
- 钉住：usage-stats.test.mjs「ships both windows independently」+ segmented reads 范围用例

### R-05 days 只支持 1|7，clamp 单点实现
30 等越界值一律回落 7；clamp 实现只在 usage-stats.mjs `clampStatDays`，panel.mjs 复用，禁止出现第二处实现。
- 锚点：usage-stats.mjs `clampStatDays`（约 :69）；panel.mjs 路由复用

### R-06 auto 不作统计成员
journal 行归到**实际应答节点+绑定模型**；虚拟 auto 与中间失败跳不进任何统计。
- 锚点：agent-metrics.mjs 链归因（resolvedAttributeFor / attributeResolver，recordEnd 落行处）
- 钉住：chain/auto 归因相关测试（agent-metrics.test / openai-server-chain.test）

### R-07 池=单一统计整体（尝试级口径）
池请求的成功与失败尝试都记池 id 名下；面板聚合把池行+成员直连行按 (池,模型) 合并。
- 锚点：agent-metrics.mjs stability 归属 meta.providerId 优先；panel.mjs annotateStabilityModels 合并

### R-08 热力图线性相对 4 档
档位=当日值相对 90 天最大值的线性比例（`ceil(t/maxT·4)`，1-4 档）。不用对数分位：同一数量级的值会被全压进顶档，四档退化成一档。
- 锚点：panel.js 热力图 level 计算
- ⚠️ 无独立测试钉档位函数，改动时人工核对

### R-09 路由链灯无黄档（仅链灯；他处红黄绿不变）
链灯三态：绿=可用 / 红=不可用退避 / 灰=无数据（进程生命周期内）。"慢但可用"不构成黄档。
- 锚点：chain-routing.mjs lamps 的三态定义与不设黄档的说明（约 :299）
- 钉住：panel.test.mjs「链路状态区不含 TTFT 黄档判定」
- 边界：仅路由链点阵；监测页 TTFT 灯、模型稳定性灯仍是红/黄/绿三档——**这是有意差分，不是不一致**。

### R-11 主题双份维护契约 + 逐字校验
style-lab/*.css 是源文件，改动必须同步嵌入 panel.css 对应横幅块；漂移方向以现行生效侧为准回写。
- 锚点：panel-ui/style-lab/CONTRACT.md
- 钉住：style-lab-sync.test.mjs（归一化行尾逐字比对，漂移即红）

### R-12 卡头口径标注只留一处
只留 TPS 卡「仅统计流式请求」；今日概览与趋势卡头不设标注（今日口径是默认读法）。成功率行标签为「成功率（不含取消）」。
- 钉住：panel.test.mjs「统计卡口径标注唯一性」用例（断言该标注存在，且概览与趋势卡头标注、`statsOverviewDate` 日期徽标均不存在）

### R-13 取消（abort）不统计
两条落盘路径均跳过 abort；errKind 枚举里的 "abort" 是死枚举。成功率/失败率均不含取消（UI 已按 R-12 标注）。
- 锚点：agent-metrics.mjs recordEnd / recordEndCtx 的 `!aborted` 守卫；usage-journal.mjs 头注释 errKind 枚举

### R-14 TPS 仅统计流式请求
非流式成功以全时长代理 ttftMs → 生成段≈0 → 被 TPS_MIN_GEN_SEC 过滤。UI 已按 R-12 标注。
- 锚点：usage-stats.mjs `TPS_MIN_GEN_SEC`（约 :56）+ 过滤逻辑；agent-metrics.mjs 非流式 ttft 代理（约 :824/:2078）

### R-15 claude request/session 行防双计（窗口级）
窗口内某 agentId 已有 request 行，则其 session-end 行 tokens 不再合并（全有或全无）。跨 per-launch journaling 上线边界的混合窗口会整段丢掉老 session tokens（断崖），属已知边界，见 §4.3。
- 锚点：usage-stats.mjs coveredAgents（约 :534）
- 钉住：usage-stats.test.mjs merge/防双计两用例

### R-16 渠道名读取时解析（键=不可变 id，label=displayName）
journal/统计按渠道或号池 id 分键（wire 身份，永不随改名变）；统计接口在**读取时**经注入的 channelLabel 解析器把 id 翻成 displayName（改名 30s 轮询内生效、删渠道回退裸 id、空 key 恒为「未知渠道」）。键一律保持裸 id（图例显隐按 key 持久化），只有 label 被解析。池 id 可复用成员渠道 id（wire 语义 pools-before-providers 同款），同名时**池的显示名赢**；映射快照 15s TTL，store 不可读时沿用旧表。趋势渠道口径下空 key 的图例显示为「未知渠道」，不出空白 chip。
- 锚点：usage-stats.mjs `labelChannel`（channelLabel 注入）+ panel.mjs `refreshStatsChannelLabels`（getBoardState 供名，poolNames 覆盖 providerNames）
- 钉住：usage-stats.test.mjs「channel display-name resolution」组；panel-stats.test.mjs「stats channel label wiring」组
- 关联约束：`/v1/messages` 的 startRequest meta 必须携带 `wireIdToTargetId(body?.model)` 解出的真实渠道 id，否则 claude per-launch 行的 providerId 为空串、统计侧出「未知渠道」柱。

### R-17 TPS 出榜样本下限 10
每模型有效生成样本（genSec ≥ 0.2s 的成功流式请求）不足 10 个时整行从 TPS 卡剔除——小样本的总量加权均值被单请求噪声主导，读数没有参考意义。数据层面剔除（usage-stats.mjs 聚合出口），不是前端隐藏；样本数徽标「· N 样本」仍在值文案里，达标的行照常标注。
- 锚点：usage-stats.mjs `TPS_MIN_SAMPLES = 10` + 聚合出口 `.filter((e) => e.samples >= TPS_MIN_SAMPLES)`
- 钉住：usage-stats.test.mjs「drops TPS rows with < 10 samples」（9 样本剔除 / 10 样本出榜边界）

### R-18 统计页手动刷新：变暗反馈 + 重播生长动画
页头刷新键点击后走 `.btn:disabled` 45% 变暗（与看板「重启」键、skills 刷新键同源，暗着即「还没好」，连点被挡），数据落地那次渲染**重播所有栏目的生长动画**——趋势图重置 `statsTrendPrev` 走 reveal 清屏左至右生长、模型用量重置 `statsUsageRevealed` 重播环+柱状图一笔画生长（与进 tab 首渲同款）；按钮亮串在动画播完之后（STATS_MORPH_MS=1500 覆盖环 1400ms）。30s 轮询保持静默 morph 不受影响；TTFT 小图/横条/表格无生长动画，随当次重渲自然刷新。
- 锚点：panel.js `runStatsRefreshWithFeedback` + `refreshStatsState(opts.replay)`（重置标记在 renderStatsAll 之前）
- 钉住：panel.test.mjs「今日概览卡头有手动刷新键：disabled 变暗反馈…」+「手动刷新重播生长动画」

### R-19 codex 实例口径=引擎进程 codex.exe（外壳与沙箱宿主只计入进程数）
codex 卡的实例行只对应 codex.exe 引擎进程（桌面 GUI 每会话拉起的 app-server 子进程），一个桌面会话一行，实例 id 形如 `codex-<引擎pid>`。ChatGPT.exe 外壳与 codex-code-mode-host.exe / codex-command-runner.exe 沙箱宿主仍计入卡面进程数（`procCounts.codex` / `codexPids` 全家桶口径不变），但不产生实例行：`normalizeInstanceId` 与实例 housekeeping（占位行、PID 存活对账）都只对 `codexEnginePids` 集合 reconcile；GUI pid 标签经血缘表折叠到引擎 pid，同会话收敛到同一行。
- 锚点：agent-metrics.mjs `codexEnginePids`（parseTasklistCsv 约 :447 填入；normalizeInstanceId 约 :210、实例 housekeeping 约 :1862 消费）
- 钉住：agent-metrics.test.mjs「lists one instance for a desktop session (ChatGPT.exe GUI + codex.exe engine)」+「spawns no instance row for a short-lived codex-command-runner.exe」+「evicts the codex instance row when its engine process exits」+「folds codex ids against the engine pid set, not the whole bucket」
- 拍板：2026-09-12（全家桶口径下一个桌面会话恒列 GUI+引擎两行、command-runner 闪现再加行，收窄）

### R-20 状态检测/渠道可用性/Flow Rail 覆盖一次性 relay 流量
看板「状态检测」卡、渠道管理页行尾可用性灯/TTFT 均值、路由链运行时（Flow Rail）的唯一数据源是常驻 relay 进程内的 stability 追踪器与链状态；一次性 relay（claude/kimi 的 per-launch relay，随机端口、面板够不到）的流量必须经 session-report 通道捎带，由常驻 relay 代记代并：reporter 随快照捎带 `stabilityBatch`（终态 + 尝试级失败各一条，归因与 TTFT 规则同 R-06/R-07 与 journal 行，monotonic `seq`，POST 成功才清缓冲、失败重发）与 `chainRuntime`（链位置 + 节点成败全量覆盖）；常驻 `reportSession` 按会话游标去重后喂本进程 stability 追踪器，`/api/internal/route-chain-runtime` 把各存活会话的链 dump 并入 `buildChainRuntime`（同端点取最新 since）。禁止在一次性 relay 内自建 stability 追踪器（瞬态进程落盘即竞态）。
- 锚点：agent-metrics.mjs `createSessionReporter`（stabilityPending / recordRetryCtx / setChainState）+ `reportSession`（sessionStabilitySeq 去重 / reportedChainStates / getReportedChainRuntime）；server.mjs `tracker?.setChainState?.(handler.chainState)`；openai-server.mjs route-chain-runtime 合并处
- 钉住：agent-metrics.test.mjs「per-launch stability batch + chain runtime relay」组；anthropic-server-chain.test.mjs「稳定性批量随快照捎带」「链运行时随快照捎带」；openai-server-chain.test.mjs「一次性 relay 捎带的链状态并入 runtime」
- 拍板：2026-09-15（claude 流量长期不进状态检测/渠道灯，用户拍板修复）

## 3. 阈值/参数镜像清单（改一处必须查另一处）

| 值 | 位置 | 镜像/钉住处 |
|---|---|---|
| 横条上限 85 | panel.js `STATS_BAR_FILL_MAX` | panel.test.mjs 断言（R-01） |
| 趋势 Top N=5 | usage-stats.mjs `TOP_N` | usage-stats.test.mjs（R-02） |
| TPS 生成段下限 0.2s | usage-stats.mjs `TPS_MIN_GEN_SEC` | usage-stats.test.mjs |
| TPS 出榜样本下限 10（不足整行不显示） | usage-stats.mjs `TPS_MIN_SAMPLES` | usage-stats.test.mjs「drops TPS rows with < 10 samples」 |
| 趋势动画时长/缓动 1500ms 'ease'（reveal 弧长生长与 morph 像素插值共用） | panel.js `STATS_MORPH_MS` / `STATS_MORPH_EASE` | — |
| 环形图一笔画 1400ms easeOutCubic（柱状图生长同节奏同 rAF） | panel.js `USAGE_REVEAL_MS` | panel.test.mjs「模型用量卡两栏…同一 rAF 生长揭示」 |
| 趋势动画路径分配：进 tab 首张（有缓存即热渲染、动画随进 tab 即时起跑不等接口返回；落地数据未变由同终点签名守卫跳过、已变则 morph 半途接管）/空态恢复/**切口径 seg**/**手动刷新** → 清屏重绘左至右生长（reveal）；days seg（跨桶数索引映射）/图例显隐/30s 轮询 → morph | panel.js `enterStatsView` 缓存热渲染 + renderStatsTrend 动画决策 + `statsSegScope` wiring + `refreshStatsState(opts.replay)`（R-18） | panel.test.mjs「趋势图进 tab 缓存热渲染」+「趋势图切口径 seg…不走 morph」+「手动刷新重播生长动画」 |
| journal 保留 90 天 | usage-journal.mjs retentionDays | usage-journal 测试 |
| 监测页实例陈旧 2min | panel.js `INSTANCE_STALE_MS` | 属监测页，统计页不用 |

## 4. 已知限制与已接受坑

1. **成功率系统性偏乐观**：abort 不落行（R-13）+ 进程崩溃丢 in-flight 请求行（recordEnd 才落行）+ 强杀无 reportEnd 的 claude 会话不落 session 行。已接受，不补。
2. **panel 重启丢 startTs**：`sessionFirstSeen` 纯内存，重启后 ended 到达的会话落 `durationMs=0` 零时长行；reporter 重启/PID 复用时长失真。
3. **coveredAgents 断崖**：见 R-15。
4. **口径并存**：今日概览（自然日）vs 趋势（滚动 24h/7d）；工时表含 legacy session tokens 而热力图/趋势不含——卡间数字对不上属设计使然，今日概览已按 R-12 原则不另行标注。
5. **非流式 TTFT=全时长代理**：进 TTFT 均值但不进 TPS（R-14）。
6. **p95 nearest-rank 小样本≈max**（days=1 每模型常 <10 条）。
7. **桶轴不防 DST**（dayAxis 防了，bucketAxis 没防）；cleanup cutoff 用毫秒减，DST 边界日可能多留/少留一个文件。
8. **instanceId 已采集未消费**：journal request 行带 instanceId（归一形态 `<agentId>-<pid>`），聚合侧不读；实例下钻未立项（cwd 目录名不落盘是前置条件）。
9. **errKind "abort" 死枚举**（R-13）：枚举与实现脱节，勿依赖。
10. **复合键 `${providerId}/${model}` 分隔符碰撞面**：model 含 "/"（openrouter 风格）时可撞键；裸拼接碰撞已注释处理，分隔符碰撞未处理。
11. **多进程写同一 journal 目录**（relay/panel/各 launcher）：跨进程 append 可能读到半行（JSON.parse 容错兜底），cleanup 无锁（已容错）。
12. **一次性 relay 捎带通道的残余边界**（R-20）：常驻 relay 不可达期间，batch 暂存 reporter 内存（500 条上限，溢出丢最旧），恢复后按事件时间补落桶；reporter 进程被强杀则未上报部分丢失（与 §4.1 崩溃丢失同类）。Flow Rail 的 per-launch 链状态随会话行清除（ended 60s 后）消失，回到常驻自有状态。kimi 的 batch 被 reportSession 的 claude-only 闸门丢弃——kimi 实际流量走常驻 relay，其一次性 relay 是空转旁路，无实际影响。
