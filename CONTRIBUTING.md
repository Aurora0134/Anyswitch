# Contributing to Anyswitch

## English

### Running tests

- Full suite, from the repository root:

  ```bat
  npm test
  ```

  This runs `node --test *.test.mjs`. The glob is expanded by Node's own test runner (Node ≥ 21), so it works even though Windows npm scripts don't expand wildcards. The project is zero-dependency — no `npm install` needed.

- Single file:

  ```bat
  node --test <file>.test.mjs
  ```

  e.g. `node --test autostart.test.mjs`.

- Environment notes:
  - `dpapi.test.mjs` exercises real Windows DPAPI (CurrentUser scope, via `dpapi.ps1`) and must run in a Windows interactive logon session; it fails in non-interactive/service sessions without a user context.
  - dsh/reasoning-related cases (`dsh-launcher.test.mjs`, `dsh-merge-config.test.mjs`, `reasoning-fallback.test.mjs`) depend on a local dsh installation (`@deepseek-ai/dsh` under the roaming npm root). When dsh is not installed, the `loadPiAiReasoningIndex` cases skip automatically (short-circuit on an empty index); all other cases are unaffected.

### Code style

- Plain Node.js ESM (`.mjs`), **zero runtime dependencies** — do not add npm packages; use the standard library.
- Tests use the built-in `node:test` runner; keep new tests in the same `*.test.mjs` flat layout.
- Match the surrounding code's naming, comment density, and idioms.

### Spec co-update conventions

- **Stats tab**: any change to stats-tab behavior must update the corresponding entry in `docs/stats-spec.md` in the same commit. That file is the single living spec — it records what is true *now*.
- **Theme / style-lab**: `panel-ui/style-lab/*.css` files are the source of truth; edits must be mirrored into the corresponding banner block embedded in `panel.html` (see `panel-ui/style-lab/CONTRACT.md`). `style-lab-sync.test.mjs` fails on any drift.

---

## 中文

### 运行测试

- 全量，在仓库根目录：

  ```bat
  npm test
  ```

  即 `node --test *.test.mjs`。通配符由 Node 自带的 test runner 展开（Node ≥ 21），Windows npm script 不展开通配符也没关系。项目零依赖，无需 `npm install`。

- 单文件：

  ```bat
  node --test <file>.test.mjs
  ```

  如 `node --test autostart.test.mjs`。

- 环境依赖说明：
  - `dpapi.test.mjs` 走真实 Windows DPAPI（CurrentUser 作用域，经 `dpapi.ps1`），需要在 Windows 交互登录会话下运行；非交互/无用户上下文的服务会话中会失败。
  - dsh / reasoning 相关用例（`dsh-launcher.test.mjs`、`dsh-merge-config.test.mjs`、`reasoning-fallback.test.mjs`）依赖本机已安装 dsh（roaming npm 根下的 `@deepseek-ai/dsh`）；未安装时 `loadPiAiReasoningIndex` 相关用例自动跳过（按空索引短路），其余用例不受影响。

### 代码风格

- 纯 Node.js ESM（`.mjs`），**零运行时依赖**——不要引入 npm 包，只用标准库。
- 测试用内置 `node:test`；新测试保持根目录平铺的 `*.test.mjs` 布局。
- 命名、注释密度与写法与周围代码保持一致。

### 规格同笔更新约定

- **统计页**：凡改动统计页行为的提交，必须同笔更新 `docs/stats-spec.md` 对应条目。该文件是单一现行规格——只记录「现在是什么」。
- **主题 / style-lab**：`panel-ui/style-lab/*.css` 是源文件，改动必须同步嵌入 `panel.html` 对应横幅块（见 `panel-ui/style-lab/CONTRACT.md`）；`style-lab-sync.test.mjs` 对漂移直接判红。
