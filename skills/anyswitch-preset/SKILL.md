---
name: anyswitch-preset
description: 规范 Anyswitch（原 apicred）提示词预设的写入流程与文本内容。凡用户要求新建、编写、添加、修改、删除、启用或停用 Anyswitch 预设，或说"写个预设""加一条预设""把这段话存成预设""改一下预设的措辞""给 kimi 关掉那条预设""现在有哪些预设"，或提到提示词预设 / prompt preset 时使用。预设会注入全部 coding agent 端点的全局指令文件，写入必须走 panel API——本 skill 给出唯一正确的流程与起草规范。
---

# Anyswitch 预设写入规范

## 机制

- 预设存 `%LOCALAPPDATA%\Anyswitch\prompts.json`；端点文件的注入只由 panel API 变更触发，手改它不生效——禁止手改。
- 托管块 `# >>> anyswitch-managed-prompts` … `# <<< anyswitch-managed-prompts` 内，每条预设以「`## 标题` + 正文」成段写入——标题与正文一并进 agent 上下文，标题即该条的主题线索。
- 端点清单（id、名称、目标文件、是否热加载）查 `GET state` 的 `endpoints`，不凭记忆或旧笔记。
- 某端点生效集 = 总开关 ∧ 预设 enabled ∧ 未被该端点 off override。
- `hotReload` 为真的端点写完即生效，其余下次会话启动才读到——报告生效时机按此说，不要一律说"已生效"。

## 写入通道

Base URL `http://127.0.0.1:47820`（panel-host）；不通改用 `http://127.0.0.1:47821`（relay-host，同路由）。

POST 必须带 `-H "X-AnySwitch-Panel: 1"` 与 `-H "Origin: http://127.0.0.1:47820"`（Origin 端口跟着 Base URL 走），否则 403 `{"ok":false,"error":"csrf"}`。

动手前先 `GET /panel/api/prompts/state` 探活。两个端口都不通 → 报告"面板未运行"并停止；不降级改文件，不自行拉起或杀进程。

## 新建主流程

1. 明确这条预设要约束 agent 的什么行为；信息不足问一句，不猜主题。
2. 起草见「文本规范」。agent 起草或改写的 title + content 必须完整给用户过目，确认后写入；用户逐字给定的直接写入。
3. 创建。正文含换行/中文时写 UTF-8 JSON 临时文件，用 `-d @file` 传，避免转义与编码问题：

```bash
curl -s -X POST http://127.0.0.1:47820/panel/api/prompts/preset/create \
  -H "Content-Type: application/json" \
  -H "X-AnySwitch-Panel: 1" -H "Origin: http://127.0.0.1:47820" \
  -d @preset.json
```

返回 `{ok:true, preset:{id,…}}`，记下 id。

4. 端点范围默认全部，不必问；用户点名"只给某端点 / 不给某端点"时才设 off override。
5. 写完必验证：`GET state` 确认在列表且 enabled；抽查一个端点文件（路径取自 state），确认托管块内每条预设都有「`## 标题`」行，其下是该条正文；向用户报告 id、命中端点、生效时机。

## 分支操作

请求头与 Base URL 同上；id 一律先 `GET state` 取；代笔的 update 文本同样先过目再写入。

- 列表/探活：`GET /panel/api/prompts/state`
- 修改：`POST preset/update`，body `{id,title,tag,content}`——整体覆盖，content 传完整新文本
- 删除：`POST preset/delete`，body `{id}`——托管块自动移除；文件原本只含托管块时连文件一并删除
- 单条启停：`POST preset/enable`，body `{id,enabled}`
- 总开关：`POST master`，body `{enabled}`
- 端点级 off：`POST override`，body `{endpointId,presetId,off}`

## 文本规范

一条预设只管一个主题，不混装无关规则。

- 祈使句，"必须 / 禁止 / 不要"，写对 agent 行为的约束，不写背景介绍；
- 带一句"为什么"，让 agent 能外推到未列举的情形；
- 结尾给可自查判据（如"读起来像在向开发者解释代码为什么这么写，就是错的"）；
- title ≤10 字动宾短语，单行不含 `#` 与 `@`（`@` 会被 Claude Code 当成文件导入），也不得只由 `#` 组成（标题净化后为空会让本条正文粘到上一条）；标题进 agent 上下文，是该条预设的主题线索，须能独立成立；content 默认中文、500 字以内，能一句说清的不写三句；正文不写 markdown 标题行（`#` 开头）——正文里的标题会脱离本条的标题段；tag 一般留空。

API 硬限（超出 400，中文报错）：title ≤200 字符、tag ≤50 字符、content ≤32 KiB。

## 失败处理

- 403 `csrf` → 查两个请求头，Origin 端口与 Base URL 一致；
- 400 → 按报错修正（title 空、超长、类型不对），不绕过校验改文件；
- 404 `预设不存在` → id 已过期，重取 state；
- 超时或 `ok:false` → 面板未运行，停止并如实报告，不重试写操作。
