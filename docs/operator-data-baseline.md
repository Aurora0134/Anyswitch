# 运维数据基线 · 思考力度库

仓库根目录的 `thinking-efforts-baseline.json` 是运行时数据文件
`%LOCALAPPDATA%\Anyswitch\thinking-efforts.db.json` 的**脱敏快照**。

运行时不读这一份。relay 与面板只读数据目录那一份（`effort-catalog.mjs`，缓存键是文件的修改时间与大小，改了免重启生效）；仓库这份的作用只有两个——异地留存，以及留下"某个档位是哪条规则给的"这条审计线。

## 脱敏规则

删掉每条模型记录的 `seenOn` 与 `aliases` 两个字段，其余内容一字不动。排版可字节还原：把 live 文件按同格式重排能得到与原文件完全相同的字节，因此这份文件的 diff 只有字段增减，没有顺带的格式改动。

- `seenOn` 是生成时从 `store.json` 反查出的投影（"这个模型在哪些渠道挂过"），值就是渠道标识本身。全仓对它的引用为零。
- `aliases` 是折进同一规范键的**中转站原名**。全仓对它的引用同样为零。里面的 `[次]`、`[AN]`、`[Kiro]`、`[Cloud]`、`[官]`、`autoroute` 这类前缀不是渠道 id，但按命名风格足以反推网关。

保留下来的是人工判断所在：`policy.operatorDirectives` 的具名规则清单，以及逐条记录的 `source`/`rule`/`preOperator`/`confidence`。运行时真正消费的字段只有 `kind`/`levels`/`default`/`wire`/`thinkingFormat` 五个，因此删这两个字段不改变任何行为。

## 恢复与更新

- 换机恢复：把这份拷回数据目录即可用。缺 `aliases` 不影响行为，重跑一次生成器会按那台机器的 `store.json` 重建它。生成器目前不在版本控制内，本仓库不承诺其可得。
- 更新基线：数据目录那份改动后重新脱敏、跑一次下面的泄露核查，得到同样判据后再提交。

## 泄露核查判据

拿 `store.json` 的全部 provider id，以及上文的私有前缀词表，对基线全文做匹配：除模型家族名 `sensenova`（商汤公开型号名，出现在"sensenova u1 / 1.5 判为非文本"这类规则文字里，与渠道重名属巧合）之外，应零命中。
