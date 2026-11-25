# Contributing to Anyswitch

## English

### Testing

This repository intentionally does not carry a test suite. The full suite, its fixtures, and the packaging contract checks are maintained by the maintainer outside this tree and run against the exact candidate revision before anything is merged or released. You do not need to run tests locally to contribute — pull requests are validated on the maintainer's side.

Do not add test files (cases, fixtures, spec files) to this repository; the public tree does not carry them. If a change needs coverage, describe the scenario in your pull request or issue.

### Code style

- Plain Node.js ESM (`.mjs`). The relay, panel and launchers use the standard library only — do not add npm packages there. `package.json` declares dependencies for the experimental virtual terminal (the terminal host binding, renderer and add-ons); keep new ones out of that list.
- Development checkouts run on a Node.js release inside the range declared in `package.json` (`>=22.15.0 <23 || >=23.8.0`); the floor comes from the built-in SQLite and zstd APIs used for session reading.
- Match the surrounding code's naming, comment density, and idioms.

### Spec co-update conventions

- **Stats tab**: any change to stats-tab behavior must update the corresponding entry in `docs/stats-spec.md` in the same commit. That file is the single living spec — it records what is true *now*.
- **Theme / style-lab**: `panel-ui/style-lab/*.css` files are the source of truth; edits must be mirrored into the corresponding banner block embedded in `panel-ui/panel.css` (see `panel-ui/style-lab/CONTRACT.md`). Drift is caught by the maintainer's suite.
- **Logging**: the log bus (`logger.mjs`) holds two contracts. The level is carried by the entry's `level` field and by nothing else — never write a level word into a message, and never parse one back out of it. A caller that needs a different level calls `warn`/`error` instead of typing the word into the text. Second, every persisted line carries a wall-clock stamp; a line without one cannot be lined up against a user's report of when something broke. The maintainer's suite fails on both. A viewer may filter by minimum level (`logLevelAllows`) where entries are *shown* — the panel's SSE stream does, driven by the 日志级别 setting — but never where they are written: the persisted file and the ring buffer stay complete, and a frame with no `level` (a clear) always passes.
- Update the [runtime log specification](docs/runtime-log-spec.md) in the same commit whenever the rules for what to log or how to classify it change.

### Release note conventions

Release notes are the changelog a user reaches from the About page, so their audience is the person installing this source tree — not the person maintaining it.

- **Cover the range, not the last commit.** Take `git log --no-merges <previous tag>..<new tag>` as the only source of truth, and write one verdict line per commit into an inventory file first: either it goes into the notes (naming the section) or it is explicitly ruled out with a reason that the user-visible surface is zero. A note that omits commits is a false statement, not an abbreviation.
- **Keep maintainer-facing content out of the notes.** No test counts (`2503/2503`, "N cases green"), no test file names, no class, function or header names, no verification methodology or control groups, no flaky-failure attribution, no internal process names. What stays is whatever changes the reader's decision: that a restart is required, the exact error string they may have seen, and the commands to upgrade.
- **State the effective surface and the upgrade path.** Whether a change needs a new backend process or a page refresh is part of the release, same as the version and tag.
- **Commit messages are the other half and stay maintainer-facing.** Test counts and root-cause detail belong there; do not let either side borrow the other's vocabulary.
- Run the release checker against both the draft and the published body before considering a release done. It lives with maintenance tooling outside the source tree.

---

## 中文

### 测试

本仓库刻意不带测试套件：全量用例、夹具与打包契约检查由维护方在源码树外维护，合入与发布前在对应候选版本上运行。贡献改动不需要在本地跑测试——拉取请求由维护方验证。

不要往本仓库添加测试文件（用例、夹具、spec 文件）；公开树不承载测试。改动需要覆盖时，在拉取请求或 issue 里描述场景即可。

### 代码风格

- 纯 Node.js ESM（`.mjs`）。relay、面板与各启动器只用标准库——不要给它们引入 npm 包。`package.json` 里声明的是实验性虚拟终端所需的依赖（终端宿主绑定、渲染器与附加组件），不要再往这份清单里加东西。
- 开发检出跑在 `package.json` 声明的 Node.js 范围内（`>=22.15.0 <23 || >=23.8.0`）；下限来自会话读取所需的内置 SQLite 与 zstd API。
- 命名、注释密度与写法与周围代码保持一致。

### 规格同笔更新约定

- **统计页**：凡改动统计页行为的提交，必须同笔更新 `docs/stats-spec.md` 对应条目。该文件是单一现行规格——只记录「现在是什么」。
- **主题 / style-lab**：`panel-ui/style-lab/*.css` 是源文件，改动必须同步嵌入 `panel-ui/panel.css` 对应横幅块（见 `panel-ui/style-lab/CONTRACT.md`）；漂移由维护侧套件直接判红。
- **日志**：日志总线（`logger.mjs`）守两条契约。级别只由条目的 `level` 字段承载，别处不得再写一份——消息文本里不许出现级别字样，也不许反过来从文本里解析级别；需要别的级别就调 `warn`/`error`，不要把级别词敲进正文。其二，落盘的每一行都带墙钟时间戳，没有时间戳的行无法与用户「什么时候坏的」对齐。两条都由维护侧套件判红。消费方可以按最低级别过滤「显示」什么（`logLevelAllows`，面板 SSE 出口照设置项「日志级别」筛），但不许过滤「写入」：落盘文件与环形缓冲始终全量，没有 `level` 的控制帧（清空）一律放行。
- 记录范围与事件定级规则变更时，同笔更新 [运行日志级别现行规格](docs/runtime-log-spec.md)。

### 发布说明撰写约定

发布说明就是用户从关于页点进去看到的更新日志，受众是把它装起来的人，不是维护这个仓库的人。

- **按区间覆盖，不按最后一笔。** 以 `git log --no-merges <上一个标签>..<新标签>` 为唯一依据，先落一份覆盖清单：区间内每笔提交一行裁决，要么进正文并写明落在哪个小节，要么明确判「不入正文」并写清用户可见面为零。漏掉提交的正文是陈述失实，不是简写。
- **维护者向内容不进正文。** 不写测试计数（`2503/2503`、「N 例全绿」）、不写测试文件名、不写类名函数名请求头、不写验证方法与对照组、不写偶发失败归因、不写内部流程名。留下的是会改变读者判断的事实：要不要重启、他可能见过的原样报错串、升级要执行的命令。
- **生效面与升级步骤必写。** 一处改动是刷新页面即得、还是要换新进程，属于发布内容本身，与版本号、标签同级。
- **提交说明是另一半，继续面向维护者。** 测试计数与根因写在那里，两边不互相借词。
- 发布前对草稿、发布后对线上正文各跑一次发布校验脚本；脚本随维护工具放在源码树外。
