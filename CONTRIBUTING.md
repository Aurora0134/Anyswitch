# Contributing to Anyswitch

## English

### Running tests

- Full suite, from the repository root:

  ```bat
  npm test
  ```

  This runs `node --test *.test.mjs`. The glob is expanded by Node's own test runner, so it works even though Windows npm scripts don't expand wildcards. Use **Node.js 24 LTS** for development. The required API range in `package.json` is `>=22.15.0 <23 || >=23.8.0`, accounting for the built-in SQLite and zstd APIs used by session reading; it does not claim that every matching Node version has been tested. The relay and panel are dependency-free, but the suite exercises the virtual terminal's terminal host, so run `npm install` once before the first run.

- Single file:

  ```bat
  node --test <file>.test.mjs
  ```

  e.g. `node --test autostart.test.mjs`.

- Environment notes:
  - `dpapi.test.mjs` exercises real Windows DPAPI (CurrentUser scope, via `dpapi.ps1`) and must run in a Windows interactive logon session; it fails in non-interactive/service sessions without a user context.
  - dsh/reasoning-related cases (`dsh-launcher.test.mjs`, `dsh-merge-config.test.mjs`, `reasoning-fallback.test.mjs`) depend on a local dsh installation (`@deepseek-ai/dsh` under the roaming npm root). When dsh is not installed, the `loadPiAiReasoningIndex` cases skip automatically (short-circuit on an empty index); all other cases are unaffected.

### Code style

- Plain Node.js ESM (`.mjs`). The relay, panel and launchers use the standard library only — do not add npm packages there. `package.json` declares dependencies for the experimental virtual terminal (the terminal host binding, renderer and add-ons); keep new ones out of that list.
- Tests use the built-in `node:test` runner; keep new tests in the same `*.test.mjs` flat layout.
- Match the surrounding code's naming, comment density, and idioms.

### Spec co-update conventions

- **Stats tab**: any change to stats-tab behavior must update the corresponding entry in `docs/stats-spec.md` in the same commit. That file is the single living spec — it records what is true *now*.
- **Theme / style-lab**: `panel-ui/style-lab/*.css` files are the source of truth; edits must be mirrored into the corresponding banner block embedded in `panel-ui/panel.css` (see `panel-ui/style-lab/CONTRACT.md`). `style-lab-sync.test.mjs` fails on any drift.

### Release note conventions

Release notes are the changelog a user reaches from the About page, so their audience is the person installing this source tree — not the person maintaining it.

- **Cover the range, not the last commit.** Take `git log --no-merges <previous tag>..<new tag>` as the only source of truth, and write one verdict line per commit into an inventory file first: either it goes into the notes (naming the section) or it is explicitly ruled out with a reason that the user-visible surface is zero. A note that omits commits is a false statement, not an abbreviation.
- **Keep maintainer-facing content out of the notes.** No test counts (`2503/2503`, "N cases green"), no test file names, no class, function or header names, no verification methodology or control groups, no flaky-failure attribution, no internal process names. What stays is whatever changes the reader's decision: that a restart is required, the exact error string they may have seen, and the commands to upgrade.
- **State the effective surface and the upgrade path.** Whether a change needs a new backend process or a page refresh is part of the release, same as the version and tag.
- **Commit messages are the other half and stay maintainer-facing.** Test counts and root-cause detail belong there; do not let either side borrow the other's vocabulary.
- Run the release checker against both the draft and the published body before considering a release done. It lives with maintenance tooling outside the source tree.

---

## 中文

### 运行测试

- 全量，在仓库根目录：

  ```bat
  npm test
  ```

  即 `node --test *.test.mjs`。通配符由 Node 自带的 test runner 展开，Windows npm script 不展开通配符也没关系。开发推荐 **Node.js 24 LTS**。`package.json` 的 API 下限范围为 `>=22.15.0 <23 || >=23.8.0`，涵盖会话读取所需的内置 SQLite 与 zstd API，不表示范围内每个 Node 版本均已实测。relay 与面板本身零依赖，但套件覆盖虚拟终端的终端宿主，首次运行前先执行一次 `npm install`。

- 单文件：

  ```bat
  node --test <file>.test.mjs
  ```

  如 `node --test autostart.test.mjs`。

- 环境依赖说明：
  - `dpapi.test.mjs` 走真实 Windows DPAPI（CurrentUser 作用域，经 `dpapi.ps1`），需要在 Windows 交互登录会话下运行；非交互/无用户上下文的服务会话中会失败。
  - dsh / reasoning 相关用例（`dsh-launcher.test.mjs`、`dsh-merge-config.test.mjs`、`reasoning-fallback.test.mjs`）依赖本机已安装 dsh（roaming npm 根下的 `@deepseek-ai/dsh`）；未安装时 `loadPiAiReasoningIndex` 相关用例自动跳过（按空索引短路），其余用例不受影响。

### 代码风格

- 纯 Node.js ESM（`.mjs`）。relay、面板与各启动器只用标准库——不要给它们引入 npm 包。`package.json` 里声明的是实验性虚拟终端所需的依赖（终端宿主绑定、渲染器与附加组件），不要再往这份清单里加东西。
- 测试用内置 `node:test`；新测试保持根目录平铺的 `*.test.mjs` 布局。
- 命名、注释密度与写法与周围代码保持一致。

### 规格同笔更新约定

- **统计页**：凡改动统计页行为的提交，必须同笔更新 `docs/stats-spec.md` 对应条目。该文件是单一现行规格——只记录「现在是什么」。
- **主题 / style-lab**：`panel-ui/style-lab/*.css` 是源文件，改动必须同步嵌入 `panel-ui/panel.css` 对应横幅块（见 `panel-ui/style-lab/CONTRACT.md`）；`style-lab-sync.test.mjs` 对漂移直接判红。

### 发布说明撰写约定

发布说明就是用户从关于页点进去看到的更新日志，受众是把它装起来的人，不是维护这个仓库的人。

- **按区间覆盖，不按最后一笔。** 以 `git log --no-merges <上一个标签>..<新标签>` 为唯一依据，先落一份覆盖清单：区间内每笔提交一行裁决，要么进正文并写明落在哪个小节，要么明确判「不入正文」并写清用户可见面为零。漏掉提交的正文是陈述失实，不是简写。
- **维护者向内容不进正文。** 不写测试计数（`2503/2503`、「N 例全绿」）、不写测试文件名、不写类名函数名请求头、不写验证方法与对照组、不写偶发失败归因、不写内部流程名。留下的是会改变读者判断的事实：要不要重启、他可能见过的原样报错串、升级要执行的命令。
- **生效面与升级步骤必写。** 一处改动是刷新页面即得、还是要换新进程，属于发布内容本身，与版本号、标签同级。
- **提交说明是另一半，继续面向维护者。** 测试计数与根因写在那里，两边不互相借词。
- 发布前对草稿、发布后对线上正文各跑一次发布校验脚本；脚本随维护工具放在源码树外。
