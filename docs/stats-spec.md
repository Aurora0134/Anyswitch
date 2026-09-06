# 使用统计页现行规格

> 本文件是「使用统计」tab（panel-ui/panel.html statsView + usage-stats.mjs + usage-journal.mjs）的**单一现行规格**。
> 维护约定：**改统计页行为的提交必须同笔更新本文件对应条目**。本文件只留「现在是什么」。
> 条目格式：红线约束强制挂「锚点（文件/常量/行）+ 钉住测试 + 拍板出处」；无锚点的条目视为草稿。
> 行号会漂移，定位以常量名/函数名/测试名为准。

## 1. 数据口径（每卡的来源 / 时间窗 / 单位）

数据源：usage journal（`%LOCALAPPDATA%\ApiCred\usage\`，requests/sessions-YYYY-MM-DD.jsonl，按日滚动，90 天自清理）。
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

布局：TTFT 与 TPS 两卡在 `.skills-grid.stats-quad` 网格并排一行（左列=TTFT，右列=TPS，窄屏折行，2026-09-02 起；原左列「模型稳定性」卡已整卡移除，见 R-03）。

## 2. 红线约束

### R-01 横条填充上限 85%
最长条不顶到轨道右端，留呼吸余量（92→85 二次收窄）。
- 锚点：panel.html `STATS_BAR_FILL_MAX = 85`（约 :12142）
- 钉住：panel.test.mjs「最长条不顶到轨道满宽」（约 :1422，断言常量 <100 且 =85）
- 拍板：2026-08-31

### R-02 趋势图 Top5+其他（Top7 已废弃）
趋势与用量环均为 Top-5，其余并入 `__other__`（label「其他渠道/端点/模型」）。
- 锚点：usage-stats.mjs `TOP_N = 5`（约 :51）
- 钉住：usage-stats.test.mjs `__other__` 合并用例
- 拍板：2026-09-01（Top7→Top5）

### R-03（已移除）模型稳定性卡固定近 24h，不随 days seg
模型稳定性卡已整卡删除：前端 markup/CSS/renderStatsStability + 后端 `stability`/`stability24h`（48×30min 轴、行内 `cells24h`）字段一并清理，本条约束随卡失效。监测页模型稳定性（`/panel/api/model-stability` + panel.mjs `annotateStabilityModels` 号池富化）不受影响。
- 拍板：2026-08-31（原约束）；2026-09-02 整卡移除

### R-04 今日概览=自然日、热力图=90 天，均不随 days seg
days seg 只作用于趋势/TTFT/TPS/工时表。**模型用量环有独立的 24h/7日 seg**（`statsPrefs.usageDays`，2026-09-02 起），不随全局 days seg；后端 `getState` 每次响应同时下发 `usage["1"]`/`usage["7"]` 双窗口（分段读范围放宽到覆盖 7d 用量窗），前端切换只本地重渲。
- 锚点：usage-stats.mjs overview（today 过滤）/ heatmap（dayAxis 90）/ `usageFor`（双窗口 usage）
- 拍板：2026-08-30（首版即定）；用量环独立时间 seg 2026-09-02 用量卡修复
- 钉住：usage-stats.test.mjs「ships both windows independently」+ segmented reads 范围用例

### R-05 days 只支持 1|7，clamp 单点实现
旧值 30 等一律回落 7；clamp 实现只在 usage-stats.mjs `clampStatDays`，panel.mjs 复用，禁止第二处实现。
- 锚点：usage-stats.mjs `clampStatDays`（约 :69）；panel.mjs 路由复用
- 拍板：2026-09-02（双份实现收敛）

### R-06 auto 不作统计成员
journal 行归到**实际应答节点+绑定模型**；虚拟 auto 与中间失败跳不进任何统计。
- 锚点：agent-metrics.mjs 链归因（resolvedAttributeFor / attributeResolver，recordEnd 落行处）
- 钉住：chain/auto 归因相关测试（agent-metrics.test / openai-server-chain.test）
- 拍板：2026-09-01；已知：8-31 前存量 auto 行最迟 7 天自然滚出趋势窗口

### R-07 池=单一统计整体（尝试级口径）
池请求的成功与失败尝试都记池 id 名下；面板聚合把池行+成员直连行按 (池,模型) 合并。
- 锚点：agent-metrics.mjs stability 归属 meta.providerId 优先；panel.mjs annotateStabilityModels 合并
- 拍板：2026-08-30

### R-08 热力图线性相对 4 档（对数分位已废弃）
档位=当日值相对 90 天最大值的线性比例（ceil(t/maxT·4)，1-4 档）；对数分位会把同数量级值全压进顶格，已废弃。
- 锚点：panel.html 热力图 level 计算（约 :11491）
- 拍板：2026-08-31 三处修复
- ⚠️ 无独立测试钉档位函数，改动时人工核对

### R-09 路由链灯无黄档（仅链灯；他处红黄绿不变）
链灯三态：绿=可用 / 红=不可用退避 / 灰=无数据（进程生命周期内）。"慢但可用"不构成黄档。
- 锚点：chain-routing.mjs lamps 注释「deliberately NO yellow」（约 :299）
- 钉住：panel.test.mjs「ROUTE_TTFT_WARN_MS gone」（约 :1331）
- 拍板：2026-09-01
- 边界：仅路由链点阵；监测页 TTFT 灯、模型稳定性灯仍是红/黄/绿三档——**这是有意差分，不是不一致**（2026-09-02 确认）。

### R-10（已移除）统计页稳定性灯阈值镜像 model-stability.statusOf
统计页稳定性卡已整卡移除（R-03），panel.html 侧 lampKind 判定随之删除，镜像关系不再存在。model-stability.mjs `statusOf` 仍被监测页链灯/模型稳定性消费，勿动。
- 拍板：2026-08-31（原镜像）；2026-09-02 随卡移除

### R-11 主题双份维护契约 + 逐字校验
style-lab/*.css 是源文件，改动必须同步嵌入 panel.html 对应横幅块；漂移方向以现行生效侧为准回写。
- 锚点：panel-ui/style-lab/CONTRACT.md
- 钉住：style-lab-sync.test.mjs（归一化行尾逐字比对，漂移即红；neon 已退役按契约排除）
- 拍板：CONTRACT 既有约定；校验测试 2026-09-02 新增

### R-12 卡头口径标注只留一处
只留 TPS 卡「仅统计流式请求」；今日概览/趋势卡头不设标注，概览日期徽标已删（今日口径是默认读法）。成功率行标签为「成功率（不含取消）」。（原稳定性卡「成功率不含用户取消」标注随卡移除，2026-09-02。）
- 钉住：panel.test.mjs「卡片口径标注副标就位」用例（断言标注存在、被删文案与 statsOverviewDate 不存在）
- 拍板：2026-09-02；两处→一处

### R-13 取消（abort）不统计
两条落盘路径均跳过 abort；errKind 枚举里的 "abort" 是死枚举。成功率/失败率均不含取消（UI 已按 R-12 标注）。**已拍板不补取消/崩溃请求统计**。
- 锚点：agent-metrics.mjs recordEnd / recordEndCtx 的 `!aborted` 守卫；usage-journal.mjs 头注释 errKind 枚举
- 拍板：2026-08-30（首版行为）；2026-09-02 决定不补

### R-14 TPS 仅统计流式请求
非流式成功以全时长代理 ttftMs → 生成段≈0 → 被 TPS_MIN_GEN_SEC 过滤。UI 已按 R-12 标注。
- 锚点：usage-stats.mjs `TPS_MIN_GEN_SEC`（约 :56）+ 过滤逻辑；agent-metrics.mjs 非流式 ttft 代理（约 :824/:2078）
- 拍板：2026-08-30（口径遗留，2026-09-02 标注收口）

### R-15 claude request/session 行防双计（窗口级）
窗口内某 agentId 已有 request 行，则其 session-end 行 tokens 不再合并（全有或全无）。已知边界：跨 per-launch journaling 上线边界的混合窗口会整段丢掉老 session tokens（断崖），已接受。
- 锚点：usage-stats.mjs coveredAgents（约 :534）
- 钉住：usage-stats.test.mjs merge/防双计两用例
- 拍板：2026-09-01

### R-16 渠道名读取时解析（键=不可变 id，label=displayName）
journal/统计按渠道或号池 id 分键（wire 身份，永不随改名变）；统计接口在**读取时**经注入的 channelLabel 解析器把 id 翻成 displayName（改名 30s 轮询内生效、删渠道回退裸 id、空 key 恒为「未知渠道」）。键一律保持裸 id（图例显隐按 key 持久化），只有 label 被解析。池 id 可复用成员渠道 id（wire 语义 pools-before-providers 同款），同名时**池的显示名赢**；映射快照 15s TTL，store 不可读沿用旧表。趋势渠道口径的空 key 图例由此从空白 chip 变「未知渠道」（2026-09-03 同笔）。
- 锚点：usage-stats.mjs `labelChannel`（channelLabel 注入）+ panel.mjs `refreshStatsChannelLabels`（getBoardState 供名，poolNames 覆盖 providerNames）
- 钉住：usage-stats.test.mjs「channel display-name resolution」组；panel-stats.test.mjs「stats channel label wiring」组
- 拍板：2026-09-03（配套写入端：server.mjs/openai-server.mjs /v1/messages startRequest meta 对普通渠道 wire-id 请求补 `wireIdToTargetId(body?.model)`，消除 claude per-launch 行 providerId 空串→「未知渠道」柱的回归根因）

### R-17 TPS 出榜样本下限 10
每模型有效生成样本（genSec ≥ 0.2s 的成功流式请求）不足 10 个时整行从 TPS 卡剔除——小样本的总量加权均值被单请求噪声主导，读数没有参考意义。数据层面剔除（usage-stats.mjs 聚合出口），不是前端隐藏；样本数徽标「· N 样本」仍在值文案里，达标的行照常标注。
- 锚点：usage-stats.mjs `TPS_MIN_SAMPLES = 10` + 聚合出口 `.filter((e) => e.samples >= TPS_MIN_SAMPLES)`
- 钉住：usage-stats.test.mjs「drops TPS rows with < 10 samples」（9 样本剔除 / 10 样本出榜边界）
- 拍板：2026-09-06

### R-18 统计页手动刷新：变暗反馈 + 重播生长动画
页头刷新键点击后走 `.btn:disabled` 45% 变暗（与看板「重启」键、skills 刷新键同源，暗着即「还没好」，连点被挡），数据落地那次渲染**重播所有栏目的生长动画**——趋势图重置 `statsTrendPrev` 走 reveal 清屏左至右生长、模型用量重置 `statsUsageRevealed` 重播环+柱状图一笔画生长（与进 tab 首渲同款）；按钮亮串在动画播完之后（STATS_MORPH_MS=1500 覆盖环 1400ms）。30s 轮询保持静默 morph 不受影响；TTFT 小图/横条/表格无生长动画，随当次重渲自然刷新。
- 锚点：panel.html `runStatsRefreshWithFeedback` + `refreshStatsState(opts.replay)`（重置标记在 renderStatsAll 之前）
- 钉住：panel.test.mjs「今日概览卡头有手动刷新键：disabled 变暗反馈…」+「手动刷新重播生长动画」
- 拍板：2026-09-06

## 3. 阈值/参数镜像清单（改一处必须查另一处）

| 值 | 位置 | 镜像/钉住处 |
|---|---|---|
| 横条上限 85 | panel.html `STATS_BAR_FILL_MAX` | panel.test.mjs 断言（R-01） |
| 趋势 Top N=5 | usage-stats.mjs `TOP_N` | usage-stats.test.mjs（R-02） |
| TPS 生成段下限 0.2s | usage-stats.mjs `TPS_MIN_GEN_SEC` | usage-stats.test.mjs |
| TPS 出榜样本下限 10（不足整行不显示） | usage-stats.mjs `TPS_MIN_SAMPLES` | usage-stats.test.mjs「drops TPS rows with < 10 samples」 |
| 趋势动画时长/缓动 1500ms 'ease'（reveal 弧长生长与 morph 像素插值共用） | panel.html `STATS_MORPH_MS` / `STATS_MORPH_EASE`（约 :11724；旧 `REVEAL_MS` 1300ms 正弦已移除） | — |
| 环形图一笔画 1400ms easeOutCubic（柱状图生长同节奏同 rAF） | panel.html `USAGE_REVEAL_MS` | panel.test.mjs「模型用量卡两栏…同一 rAF 生长揭示」 |
| 趋势动画路径分配：进 tab 首张/空态恢复/**切口径 seg**/**手动刷新** → 清屏重绘左至右生长（reveal）；days seg（跨桶数索引映射）/图例显隐/30s 轮询 → morph | panel.html renderStatsTrend 动画决策 + `statsSegScope` wiring + `refreshStatsState(opts.replay)`（R-18） | panel.test.mjs「趋势图切口径 seg…不走 morph」+「手动刷新重播生长动画」 |
| journal 保留 90 天 | usage-journal.mjs retentionDays | usage-journal 测试 |
| 监测页实例陈旧 2min | panel.html `INSTANCE_STALE_MS`（:5440） | 属监测页，统计页不用 |

## 4. 已知限制与已接受坑

1. **成功率系统性偏乐观**：abort 不落行（R-13）+ 进程崩溃丢 in-flight 请求行（recordEnd 才落行）+ 强杀无 reportEnd 的 claude 会话不落 session 行。已接受，不补（2026-09-02 拍板）。
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
