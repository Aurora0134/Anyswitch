---
name: anyswitch-preset
description: 规范 Anyswitch（原 apicred）提示词预设的写入流程与文本内容。凡用户要求新建、编写、添加、修改、删除、启用或停用 Anyswitch 预设，或说"写个预设""加一条预设""把这段话存成预设""改一下预设的措辞""给 kimi 关掉那条预设""现在有哪些预设"，或提到提示词预设 / prompt preset 时使用。预设会注入全部 8 个 coding agent 端点的全局指令文件，写入必须走 panel API——本 skill 给出唯一正确的流程与起草规范。
---

# Anyswitch 预设写入规范

## 机制（为什么必须走这个流程）

- 预设存在 `%LOCALAPPDATA%\Anyswitch\prompts.json`（数据根 2026-09-06 由旧名 `ApiCred` 翻转，旧路径已不存在），但**对各端点全局指令文件的注入只由 panel API 的变更触发**。手改 prompts.json 不会刷新任何端点文件，造成"文件里改了、端点里没生效"的静默不一致——禁止这样做。
- 每条生效预设渲染进端点文件的托管块，托管块标记：`# >>> anyswitch-managed-prompts` … `# <<< anyswitch-managed-prompts`，**只注入正文，不注入标题**（title 仅存 prompts.json 供面板展示）；多条预设之间以一个空行分隔。
- 某端点生效集 = 总开关 ∧ 预设 enabled ∧ 未被该端点 off override。
- 8 个端点与目标文件：

| id | 端点 | 目标文件 | 热加载 |
|---|---|---|---|
| claude | Claude Code | ~/.claude/CLAUDE.md | 否 |
| kimi | Kimi Code | ~/.kimi-code/AGENTS.md | 是 |
| zcode | ZCode | ~/.zcode/AGENTS.md | 否 |
| dsh | DSH | ~/.dsh/AGENTS.md | 否 |
| pi | Pi | ~/.pi/agent/AGENTS.md | 否 |
| opencode | OpenCode | ~/.config/opencode/AGENTS.md | 是 |
| reasonix | Reasonix | %APPDATA%/reasonix/AGENTS.md | 否 |
| qoder | Qoder | ~/.qoder/rules/anyswitch-managed-prompts.md | 是 |

热加载端点写完即生效，其余 5 个下次会话启动才读到——向用户如实报告生效时机。

> agy（Antigravity）端点已于 2026-09-08 下线，不要再作为注入目标或验证抽查对象。
> qoder 写的是它自己的用户级规则目录下的**专属文件**（不是用户的 `~/.qoder/AGENTS.md`）；
> 清空该端点生效集时整个文件会被删除。

## 写入通道

Base URL：`http://127.0.0.1:47820`（panel-host）；不可达时改用 `http://127.0.0.1:47821`（relay-host，同一组路由）。

所有 POST 必须带两个头，否则返回 403 `{"ok":false,"error":"csrf"}`：

```
-H "X-AnySwitch-Panel: 1" -H "Origin: http://127.0.0.1:47820"
```

（Origin 端口与实际请求的 Base URL 一致。）

动手前先探活：`GET /panel/api/prompts/state`。两个端口都不通 → 报告"面板未运行"并停止；不降级改文件，不自行拉起或杀进程。

## 新建主流程

1. 明确意图：这条预设要约束 coding agent 的什么行为。信息不足问一句，不要猜主题。
2. 按"文本规范"起草。确认策略：
   - agent 起草或改写过文本 → 把最终 title + content 完整展示给用户，确认后才写入；
   - 用户逐字给定文本 → 直接写入，不再复述确认。
3. 创建。正文含换行/中文时写成 UTF-8 的 JSON 临时文件用 `-d @file` 传递，避免 shell 转义与编码问题：

```bash
curl -s -X POST http://127.0.0.1:47820/panel/api/prompts/preset/create \
  -H "Content-Type: application/json" \
  -H "X-AnySwitch-Panel: 1" -H "Origin: http://127.0.0.1:47820" \
  -d @preset.json
```

成功返回 `{ok:true, preset:{id,…}}`，记下 id。

4. 端点范围：默认注入全部 8 端点，不必询问；仅当用户点名"只给某端点 / 不给某端点"时设 off override（见分支）。
5. 写后验证（必做，不向用户承诺未验证的生效）：
   - `GET state` 确认新预设已在列表且 enabled；
   - 抽查一个目标文件（如 ~/.zcode/AGENTS.md），确认托管块内出现预设正文、且没有标题行（`## {title}` 不应出现）；
   - 向用户报告：已写入、id、生效时机（热加载 / 下次会话）。

## 分支操作

全部走同一组头与 Base URL；id 一律先 `GET state` 取，不要凭记忆。

- 列表/探活：`GET /panel/api/prompts/state`
- 修改：`POST preset/update`，body `{id,title,tag,content}`——整体覆盖语义，content 必须传完整新文本
- 删除：`POST preset/delete`，body `{id}`。托管块自动移除；若文件原本只含托管块则连文件一起删除，注入→删除可还原原始字节
- 单条启停：`POST preset/enable`，body `{id,enabled}`
- 总开关：`POST master`，body `{enabled}`。关闭时全部端点即时失效（热加载端点立即，其余下次会话）
- 端点级 off：`POST override`，body `{endpointId,presetId,off}`

修改/停用/删除若为 agent 代笔新文本，同样适用"先过目再写入"的确认策略。

## 文本规范

一条预设只管一个主题，不混装多条无关规则。风格基准是库内现有两条："规范前端文案""防方案拆分"。

- 祈使句，"必须 / 禁止 / 不要"句式，写对 agent 行为的约束，不写背景介绍；
- 带一句"为什么"，让 agent 能外推到未列举的情形；
- 结尾给可自查判据（如"读起来像在向开发者解释代码为什么这么写，就是错的"）；
- title：≤10 字动宾短语；
- content：默认中文；**在内容完整的前提下尽量简明**——500 字是硬上限不是目标，能一句说清的不写三句；
- tag 一般留空。

API 硬限（超出返回 400，错误信息为中文）：title ≤200 字符、tag ≤50 字符、content ≤32 KiB。

## 失败处理

- 403 `csrf` → 检查两个请求头及 Origin 端口是否与 Base URL 一致；
- 400 → 按错误信息修正（title 为空、超长、类型不对），不绕过校验改文件；
- 404 `预设不存在` → id 已过期，重新 `GET state` 取；
- 请求超时或 state 返回 `ok:false` → 面板未运行，停止并如实报告，不重试写操作。
