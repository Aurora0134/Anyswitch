# 面板美术风格重构 · 风格片段契约（常驻主题机制）

目标：`../panel.html` 单文件（CSS / DOM / JS 三段）现有 5 套可切换面板主题（经典 + 4 套风格片段）。
**布局、DOM 结构、文案、既有注释一律不动**；只换皮肤。

主题已转正为常驻设置：片段以内嵌 CSS 块形式存于 panel.html（每块带 `/* ===== style-lab: SLUG ===== */`
横幅注释），本目录的 `SLUG.css` 是**源文件**——改动片段后必须把最新内容同步嵌入 panel.html 对应块。

同步由仓库根目录 `style-lab-sync.test.mjs`（node:test，随全量测试一起跑）强制校验：解析 panel.html 的
横幅块与对应 `SLUG.css` 归一化行尾（CRLF/LF）后逐字比对，漂移即红。
若发现两侧漂移：以现行生效的一侧为准回写另一侧（panel.html 内嵌块是实际加载的样式，
通常是内嵌块领先、源文件落后，把内嵌块内容回写进 `SLUG.css`），不许只改一侧留漂移。
`neon` 已退役仅作存档保留，不在校验范围。

## 切换机制（集成方实现，片段作者只需了解）

- `<html>` 上新增 `data-style` 属性：缺省 = 当前经典样式；`saas` /
  `aurora` / `blueprint` / `sepia` = 四套风格
  （`neon` 已退役不可选，CSS 暂保留，存档值回落经典）。
- 亮暗仍由既有 `data-theme="light|dark"` + `prefers-color-scheme` 决定，与 `data-style` 正交，
  亮暗由右上角按钮独立控制。
- 设置弹窗「面板主题」栏切换，即时生效，localStorage `panel-style` 记忆在本机。

## 片段文件必须包含的三段（顺序、选择器形式严格照此）

```css
/* 1) 亮色 token 全集 */
:root[data-style="SLUG"] { ... }

/* 2) 暗色 token 全集（显式 dark） */
:root[data-style="SLUG"][data-theme="dark"] { ... }

/* 3) 暗色 token 全集（跟随系统）——内容与 2) 完全相同 */
@media (prefers-color-scheme: dark) {
  :root[data-style="SLUG"]:not([data-theme="light"]):not([data-theme="dark"]) { ... }
}
```

之后可追加**皮肤覆盖规则**，一律以 `:root[data-style="SLUG"]` 开头限定作用域，例如
`:root[data-style="SLUG"] .panel-card { ... }`。

## 必须定义齐全的 token（亮色一套、暗色一套，语义不变只换值）

既有 token（panel.html 9–145 行有当前经典值可作基准）：
`--font-sans --font-mono --ease-out`
`--bg --bg-page --surface --surface-sunken --surface-hover --surface-glass`
`--text --text-2 --text-3 --text-4`
`--border --border-strong --divider`
`--accent --accent-soft --accent-border`
`--ok --ok-soft --ok-border`
`--warn --warn-soft --warn-border`
`--danger --danger-soft --danger-border`
`--pool --pool-soft --pool-border`（号池 tag 用色，须与本主题 accent/ok/warn/danger 拉开色相）
`--spark-line --spark-fill --danger-glow`
`--shadow-xs --shadow-sm --shadow-md --shadow-lg`

新增 token（集成方会把基础 CSS 改成带经典值兜底的 `var()`，片段只需给值）：
`--radius-sm --radius-md --radius-lg`（经典基准 6px / 8px / 12px）
`--accent-gradient`（品牌图标渐变，经典基准 `linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%)`）
`--accent-glow`（品牌图标/强调光晕阴影，经典基准 `0 2px 8px rgba(37, 99, 235, 0.35)`）

## 红线

- **布局几何默认禁止**：覆盖规则里不应出现 `width/height/min-*/max-*/padding/margin/gap/top/left/right/bottom/flex/grid/order/position` 等会移动元素的属性。
  允许少量布局级覆盖，但必须在文件头注释里逐条列出清单（见各片段头部「布局级覆盖清单」）。
- 允许：color/background/border(-color/-style/-width≤2px)/border-radius/box-shadow/font(-family/-weight/-style/-size±2px)/letter-spacing/text-shadow/backdrop-filter/transition/animation/filter/opacity/渐变/装饰性伪元素（伪元素不得占布局空间）。
- 不用 `!important`（基础样式里已有的除外）；不改写全局 reset；不动 JS。
- 徽章语义色（ok/warn/danger/accent）必须可区分——监控面板靠颜色读状态。
- 暗色两套（段 2/段 3）内容逐字相同。

## 参考

- 选择器清单与组件分区：读 `../panel.html` 8–817 行（分区注释齐全：header/卡片/徽章/按钮/日志控制台/遥测四宫格/toggle/seg-control/toast/modal/Skills 视图全套）。
- 想确认 DOM 结构再读 819–1802 行对应段落，不要通读全文。
- 产出：`panel-ui/style-lab/SLUG.css` 源文件 + 同步嵌入 `panel.html` 的对应主题块。
