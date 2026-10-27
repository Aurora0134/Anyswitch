// Anyswitch 面板主脚本（自 panel.html 拆出，2026-09-17）。由 panel.html 以
// <script src="/panel/assets/panel.js" defer> 引入：defer 保证 DOM 就绪后执行，
// 与原先「置于 body 末尾的内联脚本」执行时机一致。
(function () {
  "use strict";

  // ═══════════════════════════════════════════════
  // 基础状态与工具
  // ═══════════════════════════════════════════════
  const API_BASE = window.location.origin + "/panel";
  let agentsInFlight = false;
  let es = null;

  // 折线图按请求节点时序保留，不按墙钟 TTL 过期。
  const DEFAULT_SPARK_WINDOW_POINTS = 16;
  const MIN_SPARK_WINDOW_POINTS = 2;
  const MAX_SPARK_WINDOW_POINTS = 128;
  let sparkWindowPoints = DEFAULT_SPARK_WINDOW_POINTS;

  const historyBuffers = {
    ttft: [],
    tps: [],
    cache: [],
    qoder_ttft: [],
    qoder_tps: [],
    qoder_cache: [],
  };

  function $(id) { return document.getElementById(id); }
  function escapeHtml(s) {
    return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  // opts.durationMs 覆盖默认 3s 驻留；opts.action = { label, onClick }（单钮）或
  // opts.actions = [{ label, onClick }, …]（多钮）在文案后追加可点小字——点中即
  // 瞬时收起 toast 再执行 onClick。动效（M13，dsh 同款）：入场 -6px 滑入＋淡入
  // 160ms（CSS 基座过渡）；驻留期满先转 1s 淡出（is-leaving）再落暗；动作点击
  // 瞬时消失（is-gone 压掉过渡）。
  function toast(msg, isErr, opts) {
    const t = $("toast");
    const actions = opts && (opts.actions || (opts.action ? [opts.action] : null));
    if (actions) {
      t.textContent = "";
      t.append(document.createTextNode(msg));
      for (const action of actions) {
        if (!action) continue;
        const link = document.createElement("span");
        link.className = "toast-action";
        link.textContent = action.label;
        link.onclick = () => { dismissToast(t); action.onClick(); };
        t.append(link);
      }
    } else {
      t.textContent = msg;
    }
    t.className = "toast" + (isErr ? " err" : "") + " show";
    clearTimeout(t._tid);
    t._tid = setTimeout(() => {
      t.classList.add("is-leaving");
      t._tid = setTimeout(() => t.classList.remove("show", "is-leaving"), 1000);
    }, (opts && opts.durationMs) || 3000);
  }

  // 动作钮点击的瞬时收场：压掉过渡（is-gone）再摘 show——撤销/筛选引导点了就该
  // 立刻没影，不再滑半拍；驻留期满的 1s 淡出走 is-leaving，与此路互斥。
  function dismissToast(t) {
    clearTimeout(t._tid);
    t.classList.add("is-gone");
    t.classList.remove("show", "is-leaving");
    t._tid = setTimeout(() => t.classList.remove("is-gone"), 200);
  }

  // /panel/api/* 的失败文本按语言分两种身份：中文句子是为这个界面写的，可以直接
  // 上屏；英文短句是校验语、短码（"cas-conflict"、"pool members must be an array…"）
  // 或系统错误，一律换成调用方自带的中文兜底，原文交给控制台**并记入面板日志**。
  // 新增端点文案要落中文，否则会被当开发者文本吞掉。短码分支一律读 err.code
  // （err.message 带 "HTTP <status>：" 前缀）。
  const PANEL_UI_COPY_RE = /[\u4e00-\u9fff]/;

  function panelCopy(raw, fallback) {
    const text = String(raw == null ? "" : raw);
    return PANEL_UI_COPY_RE.test(text) ? text : fallback;
  }

  function panelError(err, fallback) {
    const raw = (err && err.code) || (err && err.message) || "";
    const text = panelCopy(raw, fallback);
    if (text === fallback) {
      console.warn("[panel] " + fallback + " ← " + raw);
      reportMaskedPanelError(fallback, raw);
    }
    return text;
  }

  // 被折叠掉的服务端原文原先只进浏览器控制台：用户看不到，面板日志里也没有，界面上
  // 只剩一句笼统的兜底，出了事无从查起（2026-10-02 那次「导出未完成」查不出原因就是
  // 卡在这里）。这里把原文一并送进面板日志，面板的日志页即可看到。走裸 fetch 而非
  // api()：本函数正处在报错路径上，上报失败必须彻底静默，绝不能把原错误盖掉。
  function reportMaskedPanelError(fallback, raw) {
    try {
      fetch(API_BASE + "/api/logs/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-AnySwitch-Panel": "1" },
        body: JSON.stringify({ level: "warn", message: `[面板] ${fallback}（服务端原文：${raw}）` }),
        keepalive: true,
      }).catch(() => { /* 上报是顺带的事 */ });
    } catch { /* 同上 */ }
  }

  // 数据搬迁卡专用：服务端给了中文说明就照原样上屏（那是业务原因，刷新无用）；只有
  // 被折叠时才是「这次请求没送达或服务端出错」，刷新页面重试才是有意义的下一步。
  const PANEL_FAILURE_HINT = "（请刷新页面后重试；详情见面板日志）";
  function panelFailure(err, fallback) {
    const text = panelError(err, fallback);
    return text === fallback ? text + PANEL_FAILURE_HINT : text;
  }

async function api(method, path, body) {
    // server also accepts x-apicred-panel from resident processes spawned pre-rename
    const opts = { method, headers: { "Content-Type": "application/json", "X-AnySwitch-Panel": "1" } };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(API_BASE + path, opts);
    let data;
    try { data = await res.json(); } catch { data = { ok: res.ok }; }
    // 非 2xx 或服务端显式 ok:false 一律抛出：message 带状态码供控制台定位，服务端原文只挂到 err.code
    if (!res.ok || data.ok === false) {
      const detail = String(data.error || data.message || data.reason || "");
      const err = new Error(`HTTP ${res.status}${detail ? "：" + detail : ""}`);
      err.code = detail;
      // 服务端随错误附带的机读信号（如 skills_repo_empty），供调用方分支处理
      if (typeof data.code === "string") err.serverCode = data.code;
      throw err;
    }
    return data;
  }

  function formatTokens(t) {
    if (!t) return "0";
    if (t >= 1000000) return (t / 1000000).toFixed(2) + "M";
    if (t >= 1000) return (t / 1000).toFixed(1) + "k";
    return String(t);
  }

  // 数据统计页专用：token 用中文数量级单位 万=1e4、亿=1e8、兆=1e12；
  // 暂只做到兆（更大数值继续用兆表示），万以下直接出原数；
  // 换算后整数部分 ≥100 时省略小数，避免轴标签出现「7500.00万」式拖尾
  function formatTokensCn(t) {
    if (!t) return "0";
    const unit = t >= 1e12 ? [1e12, "兆"] : t >= 1e8 ? [1e8, "亿"] : t >= 1e4 ? [1e4, "万"] : null;
    if (!unit) return String(t);
    const v = t / unit[0];
    return (v >= 100 ? v.toFixed(0) : v.toFixed(2)) + unit[1];
  }

  function formatDurationSeconds(ms) {
    if (!ms || ms <= 0) return "0秒";
    const totalSec = Math.floor(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (h > 0) return h + "小时" + m + "分" + s + "秒";
    if (m > 0) return m + "分" + s + "秒";
    return s + "秒";
  }

  // ═══════════════════════════════════════════════
  // 折线图 (Sparkline) 渲染
  // ═══════════════════════════════════════════════
  function updateSparkline(containerId, dataPoints, minVal, maxVal, size) {
    const container = $(containerId);
    if (!container) return;
    // 盒子尺寸随调用方传入并与 CSS 盒等大：viewBox 1:1 映射像素，线宽/圆角不失真
    // （看板 68×26 与终端侧栏 56×22 是两个原生规格，不再互相拉伸）。
    const w = Number(size?.w) > 0 ? size.w : 68;
    const h = Number(size?.h) > 0 ? size.h : 26;
    // B3 路径级 diff：已有正常态 SVG（area+line 两个 path 子节点）时只改 d，
    // d 相同零 DOM 写；空态 1-path SVG 不命中判定，维持现状重建（不劣化）。
    const EMPTY_D = `M0,${h / 2} L${w},${h / 2}`;
    if (!dataPoints || dataPoints.length < 2) {
      const svg0 = container.firstElementChild;
      if (svg0 && svg0.tagName === "svg" && svg0.children.length === 2) {
        // 正常态跌入空态：area path 的 d 必须置空，否则残留现状没有的填充色块
        const area0 = svg0.children[0], line0 = svg0.children[1];
        if (area0.getAttribute("d")) area0.setAttribute("d", "");
        if (line0.getAttribute("d") !== EMPTY_D) line0.setAttribute("d", EMPTY_D);
        if (line0.getAttribute("stroke-dasharray") !== "2,2") line0.setAttribute("stroke-dasharray", "2,2");
        // 对齐空态原状：空态 path 无 round 端点/拐角
        if (line0.hasAttribute("stroke-linecap")) line0.removeAttribute("stroke-linecap");
        if (line0.hasAttribute("stroke-linejoin")) line0.removeAttribute("stroke-linejoin");
        return;
      }
      container.innerHTML = `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><path d="${EMPTY_D}" fill="none" stroke="var(--spark-line)" stroke-width="1.5" stroke-dasharray="2,2"/></svg>`;
      return;
    }
    const pad = 3;
    const availH = h - pad * 2;
    const min = (minVal !== undefined) ? minVal : Math.min(...dataPoints);
    const max = (maxVal !== undefined) ? maxVal : Math.max(...dataPoints);
    const range = (max - min) || 1;

    const pts = [];
    const step = w / (dataPoints.length - 1);
    for (let i = 0; i < dataPoints.length; i++) {
      const x = (i * step).toFixed(1);
      const normalized = (dataPoints[i] - min) / range;
      const y = (h - pad - normalized * availH).toFixed(1);
      pts.push(`${x},${y}`);
    }

    const pathD = "M" + pts.join(" L");
    const areaD = `${pathD} L${w},${h} L0,${h} Z`;

    const svg = container.firstElementChild;
    if (svg && svg.tagName === "svg" && svg.children.length === 2) {
      const area = svg.children[0], line = svg.children[1];
      if (area.getAttribute("d") !== areaD) area.setAttribute("d", areaD);
      if (line.getAttribute("d") !== pathD) line.setAttribute("d", pathD);
      // 从空态复用回来的线：摘掉虚线、恢复 round 端点/拐角
      if (line.hasAttribute("stroke-dasharray")) line.removeAttribute("stroke-dasharray");
      if (line.getAttribute("stroke-linecap") !== "round") line.setAttribute("stroke-linecap", "round");
      if (line.getAttribute("stroke-linejoin") !== "round") line.setAttribute("stroke-linejoin", "round");
      return;
    }
    container.innerHTML = `
      <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
        <path d="${areaD}" fill="var(--spark-fill)" />
        <path d="${pathD}" fill="none" stroke="var(--spark-line)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    `;
  }

  function clampSparkWindow(n) {
    const parsed = Number.parseInt(n, 10);
    if (!Number.isInteger(parsed) || parsed < MIN_SPARK_WINDOW_POINTS) return DEFAULT_SPARK_WINDOW_POINTS;
    return Math.min(MAX_SPARK_WINDOW_POINTS, parsed);
  }

  function pruneSparkBuffer(buf) {
    while (buf.length > sparkWindowPoints) buf.shift();
  }

  function sparkValues(buf, authoritativeHistory) {
    const limit = sparkWindowPoints;
    if (authoritativeHistory && Array.isArray(authoritativeHistory) && authoritativeHistory.length > 0) {
      return authoritativeHistory.slice(-limit);
    }
    pruneSparkBuffer(buf);
    return buf.map(p => p.v).slice(-limit);
  }

  function pushMetricPoint(bufferKey, val, authoritativeHistory) {
    const buf = historyBuffers[bufferKey];
    if (!buf) return;
    if (authoritativeHistory && Array.isArray(authoritativeHistory) && authoritativeHistory.length > 0) {
      buf.length = 0;
      for (const v of authoritativeHistory) buf.push({ t: 0, v });
      pruneSparkBuffer(buf);
      return;
    }
    if (typeof val === "number" && !isNaN(val)) {
      const last = buf[buf.length - 1];
      if (!last || last.v !== val) buf.push({ t: Date.now(), v: val });
    }
    pruneSparkBuffer(buf);
  }

  // 端点级四宫格折线：prefix → [容器 id, historyBuffers 键]，旧机制四栏共用。
  const ENDPOINT_SPARK_KEYS = {
    zc: [["zcSparkTtft", "ttft"], ["zcSparkTps", "tps"], ["zcSparkCache", "cache"]],
    qoder: [["qoderSparkTtft", "qoder_ttft"], ["qoderSparkTps", "qoder_tps"], ["qoderSparkCache", "qoder_cache"]],
  };

  // 端点级陈旧标记：render* 每轮写，redrawEndpointSparklines 读——陈旧端点不绘历史折线
  // （与实例行 data-stale 同语义；setFold 展开补绘也经此门控）。
  const endpointStaleFlags = {};

  // 端点级折线绘制入口（唯一）：四宫格被折叠（grid.hidden）时跳过——隐藏 DOM 不参与
  // 布局/绘制，每秒 d 属性写纯属空转；buffer 由 pushMetricPoint 照常累积，展开瞬间
  // 经 setFold → redrawEndpointSparklines 补绘。容器不在 DOM（如未运行）同样跳过。
  function redrawEndpointSparklines(prefix) {
    if (endpointStaleFlags[prefix]) return;
    const grid = $(prefix + "TelemetryGrid");
    if (!grid || grid.hidden) return;
    for (const [containerId, bufKey] of ENDPOINT_SPARK_KEYS[prefix] || []) {
      updateSparkline(containerId, sparkValues(historyBuffers[bufKey]), ...(bufKey.endsWith("cache") ? [0, 100] : []));
    }
  }

  // ═══════════════════════════════════════════════
  // 初始化与轮询
  // ═══════════════════════════════════════════════
  // 品牌版本徽标：版本只有一处来源——package.json 经 /api/app-info 下发，
  // 页面里不写死版本号（写死就得每次发版记得手改，漏改即显示过期版本）。
  // 取不到就保持隐藏：宁可没有徽标，也不显示占位符或可能过期的数字。
  // 两处同源：头行品牌（旧版可见）与新版左栏栏顶品牌，一次取值写两个 id——新版下
  // 头行品牌已让位给栏顶那一份，各写各的就得请求两次、还可能一处成功一处失败。
  async function initBrandVersion() {
    const tags = [$("brandVersion"), $("railBrandVersion")].filter(Boolean);
    if (!tags.length) return;
    try {
      const info = await api("GET", "/api/app-info");
      const version = info && typeof info.version === "string" ? info.version.trim() : "";
      if (!version) return;
      for (const tag of tags) {
        tag.textContent = "v" + version;
        tag.hidden = false;
      }
    } catch { /* 接口不可达（面板服务换新中）：不显示版本，不进控制台噪音 */ }
  }

  // 「开屏动画」本机偏好：与 head 里的 panelStartupBootstrap 读同一条存档、同一缺省
  // 口径（缺省按「开」处理）。绘制前的那一份判定只能同步读 localStorage——主脚本是
  // defer 外链、HTML 由后端按静态文件直出，服务端存档读回来首绘已经过去了。
  // 这里只负责绘制之后的两处：设置页这颗开关的回显与写入、看板「重启」的复播入口。
  function startupAnimationEnabled() {
    try { return localStorage.getItem("panel-startup-animation") !== "0"; } catch { return true; }
  }

  // 「UI版本」本机偏好：与开屏动画同一类存档（localStorage、绘制前由 head 脚本读、
  // 不 POST、缺省旧版）。不同之处是它即时生效——设置页分段钮改写 <html> 的
  // data-ui-version，看板 CSS 当帧换列；这里只管回显与写入。
  function newUiEnabled() {
    try { return localStorage.getItem("panel-ui-version") === "v2"; } catch { return false; }
  }

  let startupViewReady = Promise.resolve();
  async function init() {
    initTheme();
    initStylePicker();
    initBrandVersion();
    initSettingsView();
    if (typeof initTerminalPreview === "function") initTerminalPreview();
    // 与 initTerminalPreview 同款 typeof 守卫：panel-startup 测试把 init() 抽进桩环境
    // 真跑，桩里只提供固定名单上的函数。
    if (typeof initTerminalHostControls === "function") initTerminalHostControls();
    if (typeof initRailCollapse === "function") initRailCollapse();
    if (typeof initTerminalRail === "function") initTerminalRail();
    initRelayControls();
    initSkillsTab();
    initPresetsTab();
    initStoreTab();
    initStatsTab();
    initSessionsTab();
    loadAutostartState();
    // 首刷预加载：链配置 + 路由链运行时必须在第一次 agents 渲染（1s 轮询）
    // 之前落地，否则胶囊标记只能靠 loading 守卫抑制（直连样式一帧）。
    // 并行拉取，二者互不阻塞；失败各自走下一轮轮询重试。
    await Promise.allSettled([refreshRouteChainsCache(), refreshRouteRuntimeCache()]);
    const firstStatus = startStatusPolling();
    // 自动同步失败上屏：3s 轮询，独立启动不阻塞开屏 ready。
    startSyncStatusPolling();
    // 日志流入口：内部先问运行日志开关再决定连不连，不阻塞开屏 ready。
    startLogStream();
    if (window.panelStartupController) {
      // 重启恢复的入场动画挂开屏淡出起点（onLeave）：ready() 调用时刻 settled 未必
      // 已到位（数据快于 1100ms 动画时长时 leave 会等 settle），直接播会在开屏层
      // 底下播完；onLeave 在开屏层实际开始淡出的那一帧触发，淡出与浮入重叠。
      // launcher 首开无 restartEnterView，不挂钩子，行为不变。
      if (restartEnterView) {
        const view = restartEnterView;
        restartEnterView = null;
        window.panelStartupController.onLeave = () => {
          if (view === "board") playBoardEnter(document.querySelector(".telemetry-view"));
          else {
            const enteredView = view === "skills" ? $("skillsView")
              : view === "presets" ? $("presetsView")
              : view === "store" ? $("storeView")
              : view === "stats" ? $("statsView")
              : view === "settings" ? $("settingsView")
              : view === "terminal" ? $("terminalView")
              : $("sessionsView");
            enteredView.classList.remove("view-enter");
            void getComputedStyle(enteredView).animationName;
            enteredView.classList.add("view-enter");
            enteredView.addEventListener("animationend", () => enteredView.classList.remove("view-enter"), { once: true });
          }
        };
      }
      // 开屏层的退场判据从「请求 resolve 了」改成「看板拿到能当事实说的首帧」
      // （frame.ready，见 refreshAgents 的帧闸）。前者会把遮挡层掀在那幅静态基线上——
      // 八张「未检测到运行中的 X」加一张带「运行中」徽标的空 ZCode，正是 2026-10-07 报的
      // 中间态。落点不是看板页时不等这一帧（看板没渲染，等它只会白等）。
      // 2500ms 上限：取数一直不通就让开屏照常淡出、由 data-board=pending 的骨架条接着
      // 盖住画面，不把用户锁在动画后面；开屏自己的兜底时限仍在。
      const startupWaits = [firstStatus, startupViewReady];
      if (boardVisible()) {
        startupWaits.push(Promise.race([
          boardLivePromise,
          new Promise((resolve) => setTimeout(resolve, 2500)),
        ]));
      }
      await Promise.allSettled(startupWaits);
      requestAnimationFrame(() => requestAnimationFrame(() => window.panelStartupController?.ready()));
    }
  }

  // 当前视图：agents/stability 数据只喂看板卡片，非看板视图暂停其轮询；
  // status 保持常开（头部状态灯跨视图可见）。首次立即取数不做门控，保证首刷。
  let currentView = "board";
  // restoreView 恢复视图时置位：首屏/刷新恢复不播入场动画，switchView 消费一次即复位
  let suppressViewEnter = false;
  // 重启恢复（panelStartupRestart）时 restoreView 记下的待播入场动画视图名；
  // init() 末尾在开屏 ready() 之后消费一次——与开屏淡出同步起播，连接处平滑。
  let restartEnterView = null;
  // 设置全页视图：记住进入前的视图供头行「←」钮返回；进入钩子由 initSettingsView
  // 装配。设置视图不占 panel-view——那份继续存主视图，刷新恢复回设置页时正好拿它当
  // 返回目标；「停在设置页」另由 panel-settings-open 标记记录。
  let settingsReturnView = "board";
  // restoreView 恢复设置页时待激活的子 tab（取自 panel-settings-subtab），
  // enterSettingsView 消费一次即清；主动点齿轮进入恒落「通用」，不看它。
  let settingsSubTabToRestore = null;
  // 终端页的返回上下文：入口是看板左栏那张卡，离开终端页一律落回看板——别的视图上没有
  // 这张卡，落过去用户就找不回入口。滚动位置随进来那一眼记下，返回时补回。
  let terminalReturnView = "board";
  let terminalReturnScrollTop = 0;
  // 看板渲染完成的通知钩子：恢复进「主题」子页时镜像快照拍到的是还没取到数据的空壳
  // 看板，靠它补拍一次（实现在 initSettingsView）。
  let notifyBoardRendered = () => {};
  let enterSettingsView = () => {};
  let leaveSettingsView = () => {};
  function boardVisible() { return currentView === "board"; }

  function startStatusPolling() {
    const statusReady = refreshStatus();
    const agentsReady = refreshAgents();
    const stabilityReady = refreshModelStability();
    const firstReady = Promise.allSettled(boardVisible() ? [statusReady, agentsReady, stabilityReady] : [statusReady]);
    setInterval(() => {
      if (document.hidden) return;
      refreshStatus();
      if (boardVisible()) refreshAgents();
    }, 1000);
    setInterval(() => {
      if (document.hidden) return;
      if (boardVisible()) refreshModelStability();
    }, 15000);
    return firstReady;
  }

  // 后台切回立即补刷。三处轮询（本页 1s/15s、统计页 30s）都带 document.hidden
  // 闸，隐藏期间完全不取数；而 Chrome 会把隐藏页的定时器节流到约每分钟一次，
  // 所以回前台后首个 tick 仍可能等近一分钟——期间画面停在切走前的旧数字上，
  // 折线图也因没有新帧而不更新。按当前视图各补一次即可，不新起定时器：
  // refreshAgents / refreshModelStability / refreshStatsState 自带在飞与序号守卫。
  document.addEventListener("visibilitychange", () => {
    // 先记账再动手：这条转折由本处处理完了，兜底那一拍就不必再补一次。
    terminalVisibilityWasHidden = document.hidden;
    // 进后台第一件事是拆掉会话字节流（理由见 syncTerminalDataStream）；回前台由下面
    // 各视图分支重建。这条转折漏发也不要紧：1s 轮询拍里同一个函数再核一次。
    //
    // 拆之前先把画面停成垫片（M4，见 parkTerminalScreen）：拆流之后唯一还能留在屏上
    // 的只有垫片，切回时它就是「新画面画好之前的内容」。typeof 闸护单测桩环境。
    if (typeof parkTerminalScreen === "function") parkTerminalScreen();
    syncTerminalDataStream();
    if (document.hidden) return;
    refreshStatus();
    if (currentView === "stats") {
      refreshStatsState({ silent: true });
      return;
    }
    if (currentView === "terminal") {
      // 后台切回：隐藏期定时器被节流到分钟级，立即补一拍归属数据。
      pollTerminalSessions();
      // 隐藏期这条流连同它的未解析积压已经被拆掉，画面按宿主镜像重建一次。
      // revive:false——切回来不是"用户挑了这条会话"，进程已退就只回放最后一屏，
      // 不因为回来了就替他重开一个空壳；要新壳仍然点页签，那是既有通路。
      renderTerminalPreviewSession({ revive: false });
      return;
    }
    if (!boardVisible()) return;
    refreshAgents();
    refreshModelStability();
  });

  // relay 状态 → 顶栏与侧栏的呈现。抽成纯函数是为了这段判断能在测试里真跑一遍，
  // 而不是只对源码做正则断言。
  //
  // 四种呈现：运行中 / 服务异常 / 启动中 / 已停止。「服务异常」这一态是因为
  // 2026-10-05 那次连续 70 分钟的请求全败被显示成「运行中 / 运行正常」——进程在、
  // 端口在、探针也答得出来，但每一个真实请求都在失败。它不是「已停止」（进程还
  // 活着，停止按钮该给的是「停止」），也不是「正常」。
  function relayStatusPresentation(relay, defaultPort) {
    const port = relay.port || defaultPort;
    if (relay.status === "running" && relay.degraded === true) {
      return {
        dotClass: "pulse-dot stopped",
        statusText: `Relay 服务异常 (${port})`,
        badgeClass: "badge badge-warn",
        badgeText: "服务异常",
      };
    }
    if (relay.status === "running") {
      return {
        dotClass: "pulse-dot running",
        statusText: `Relay 运行中 (${port})`,
        badgeClass: "badge badge-ok",
        badgeText: "运行正常",
      };
    }
    if (relay.status === "starting") {
      return {
        dotClass: "pulse-dot starting",
        statusText: "Relay 启动中...",
        badgeClass: "badge badge-warn",
        badgeText: "启动中",
      };
    }
    return {
      dotClass: "pulse-dot stopped",
      statusText: "Relay 已停止",
      badgeClass: "badge badge-danger",
      badgeText: "已停止",
    };
  }

  async function refreshStatus() {
    try {
      const res = await api("GET", "/api/status");
      // 记住面板进程身份：请求重启面板后，靠 pid/startTime 变化判定新进程已接管。
      lastPanelIdentity = { pid: res?.pid ?? null, startTime: res?.startTime ?? null };
      // 自更新捎带帧喂给页面级观察者（旧版服务端没有这个字段：喂 null 即无任务）。
      selfUpdateWatcher.frame(res?.selfUpdate ?? null);
      const dot = $("topDot");
      const statusText = $("topRelayStatus");
      const sbState = $("sbStateBadge");
      const hostEl = $("sbHost");
      const uptimeEl = $("sbUptime");

      const relay = res && res.relay ? res.relay : { status: res && res.running ? "running" : "stopped" };
      // Drive the start/stop toggle (text + red/blue) from the relay's real state.
      updateRelayControls(relay);

      // 四态呈现由 relayStatusPresentation 决定（含「服务异常」——在跑但每个请求
      // 都在失败），这里只负责落到 DOM 上。
      const presentation = relayStatusPresentation(relay, 47821);
      dot.className = presentation.dotClass;
      statusText.textContent = presentation.statusText;
      sbState.className = presentation.badgeClass;
      sbState.textContent = presentation.badgeText;
      if (relay.status === "running") {
        hostEl.textContent = `127.0.0.1:${relay.port || 47821}`;
        if (res && res.startTime) {
          uptimeEl.textContent = formatDurationSeconds(Date.now() - res.startTime);
        }
      }
      // 终端宿主状态随状态帧一起下发：驱动入口卡与终端页头的徽标与起停钮
      applyTerminalHostState(normalizeTerminalHostState(res?.terminalHost?.state));
    } catch {
      // 面板服务正在换新进程：47820 整个不可达是预期内的，徽标已由
      // watchPanelHostComeBack 写成「面板服务重启中…」，这里不能再把它改判成
      // 「Relay 未运行」——relay 其实活着。
      if (panelRestarting) return;
      $("topDot").className = "pulse-dot stopped";
      $("topRelayStatus").textContent = "Relay 未运行";
      $("sbStateBadge").className = "badge badge-danger";
      $("sbStateBadge").textContent = "已停止";
      updateRelayControls({ status: "stopped" });
      // 状态帧取不到时宿主状态同样不可知：徽标落「状态未知」、起停钮禁用
      applyTerminalHostState("unknown");
    }
  }

  // 端点卡排序语义：三段分层——「生成中」的卡在顶层；待命超过 STANDBY_SINK_MS
  // 的已启动卡掉到待命层（生成中卡下方、未启动卡之上），刚生成完（待命 ≤ 宽
  // 限期）的卡留在顶层防请求间隙抖动；恢复生成中立即回顶；未启动的卡垫底。
  // 层内保持基准顺序。「生成中」判定与卡片状态徽标同口径
  // （聚合卡看 metrics.activeRequests，claude 看任一 session 在途）。
  // 待命时长锚定端点最近活动时间（聚合卡=全局汇总 lastSeen，claude=各
  // session lastSeen 最大值）而非面板观测起点——页签隐藏后回看板，长待命卡
  // 立即就位，不用再等一个宽限期；从未有过活动的卡（锚点缺失）按启动状态
  // 归层（已启动入待命层，未启动垫底）。
  // 顺序没变就不动 DOM，避免每秒轮询重排抖动、打断点击。
  // 这套分层只有取到 /api/agents 才算得出来，晚于首绘；刷新后取数落地前的那一帧
  // 由 panel.html 的 panelCardOrderPrepaint 按「上一次重排出来的卡序」画，真重排
  // 那一刻交棒回 DOM 顺序（见下方 reorderAgentCards 末段）。
  const AGENT_CARD_ORDER = ["zcode", "claude", "dsh", "pi", "kimi", "opencode", "qoder", "codex", "grok"];
  const STANDBY_SINK_MS = 5000;

  // 每卡历史最大活动锚点：claude 会话整行退出后 payload 锚点会消失（relay
  // 重启同理归零），记住见过的最大值让待命计时连续、不因锚点回退而提前下沉。
  const cardActivityAnchor = {};
  let lastCardOrderKey = "";
  function cardIsGenerating(a) {
    if (!a) return false;
    if (a.id === "claude") {
      return Array.isArray(a.sessions) && a.sessions.some((s) => s && (s.activeRequests > 0 || s.status === "active"));
    }
    return (a.metrics && a.metrics.activeRequests > 0) || a.activeRequests > 0;
  }
  function cardStandbyAnchor(a) {
    let latest = 0;
    const bump = (v) => { if (typeof v === "number" && v > latest) latest = v; };
    if (a.id === "claude") {
      (a.sessions || []).forEach((s) => bump(s && s.lastSeen));
    } else {
      const s0 = a.sessions && a.sessions[0];
      bump(s0 && s0.lastSeen);
    }
    if (latest > (cardActivityAnchor[a.id] || 0)) cardActivityAnchor[a.id] = latest;
    return cardActivityAnchor[a.id] || 0;
  }
  function reorderAgentCards(agents) {
    const container = document.querySelector(".agent-cards-container");
    if (!container || !Array.isArray(agents)) return;
    const byId = {};
    agents.forEach(a => { if (a && a.id) byId[a.id] = a; });
    const isCardTop = (id) => {
      const a = byId[id];
      if (!a) return false;
      if (cardIsGenerating(a)) return true;
      const anchor = cardStandbyAnchor(a);
      return anchor > 0 && (Date.now() - anchor) <= STANDBY_SINK_MS;
    };
    const top = [];
    const standby = [];
    const bottom = [];
    for (const id of AGENT_CARD_ORDER) {
      if (isCardTop(id)) top.push(id);
      else if (byId[id] && byId[id].status === "running") standby.push(id);
      else bottom.push(id);
    }
    const targetOrder = top.concat(standby, bottom);
    const key = targetOrder.join(",");
    if (key === lastCardOrderKey) return;
    const cards = [];
    targetOrder.forEach(id => {
      const card = container.querySelector('[data-agent-id="' + id + '"]');
      if (card) cards.push(card);
    });
    lastCardOrderKey = key;
    // 交棒给运行时，两步都紧跟下面的重排、同处一个同步块（中间不产帧）：
    // ① 摘掉 <html> 上的首帧属性——那一帧的卡序由 CSS order 撑着，DOM 一旦重排完
    //    就该回到「DOM 顺序即视觉顺序」，否则 order 会压过真卡序把画面锁在存档上；
    // ② 把这份卡序写进存档，供下次刷新时 panel.html 的 panelCardOrderPrepaint
    //    直接画在首帧（只在这里写，等于「用户上一次真正看到的卡序」）。
    // 摘属性不放 try：它抛错就是 DOM 坏了，兜住只会把跳帧留成静默故障；
    // 写存档兜住，存储不可用时顶多首帧接管失效、行为回到没有接管之前。
    document.documentElement.removeAttribute("data-prepaint-card-order");
    try { localStorage.setItem("agent-card-order", key); } catch {}
    container.append(...cards);
  }

  // ── 已安装 Agent 可见性（各展示面共用的唯一口径）──────────────────────
  // 「Agent 装在本机」由环境检测判定（与关于页、终端「+」菜单同一真值源）：
  // 任一形态（CLI/桌面）检测到即算在，全部形态都未找到才算不在，任一形态检测
  // 出错按在（fail-open——宁可多显示，也不能把真实存在的 Agent 藏掉）。
  // 看板卡、设置-抗截断端点钮、设置-自动路由瓦片、会话筛选都从这里取数；
  // skills / presets 两页的端点清单由服务端按同一判定过滤下发，不在这里管。
  // 快照写一份进 localStorage，供 panel.html 的 panelHiddenAgentsPrepaint
  // 在首绘前把未安装的看板卡直接画没（否则每次刷新都先闪 9 张再收）。
  const INSTALLED_AGENTS_LS_KEY = "anyswitch.installed-agents";
  let installedAgentIds = readInstalledAgentsSnapshot(); // null = 未知 → 全部可见
  let installedAgentIdsAt = 0;
  function readInstalledAgentsSnapshot() {
    try {
      const raw = localStorage.getItem(INSTALLED_AGENTS_LS_KEY);
      if (typeof raw !== "string" || !raw) return null;
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) && parsed.length && parsed.every((x) => typeof x === "string")
        ? new Set(parsed) : null;
    } catch { return null; }
  }
  function writeInstalledAgentsSnapshot(ids) {
    try { localStorage.setItem(INSTALLED_AGENTS_LS_KEY, JSON.stringify([...ids])); } catch {}
  }
  function applyAgentCardVisibility(ids) {
    const container = document.querySelector(".agent-cards-container");
    if (!container) return;
    for (const card of container.querySelectorAll(".panel-card[data-agent-id]")) {
      // hidden=true 才是隐藏：只有「ids 非 null 且不在册」才藏；ids 为 null
      // （检测未知/失败）按 fail-open 全显示。首版把布尔写反（null→全藏、
      // 已装→藏、未装→显），全装机器看板卡全数消失且取数救不回——此行为
      // 测试所钉，勿再翻回。
      card.hidden = ids !== null && !ids.has(card.getAttribute("data-agent-id"));
    }
    // 运行时接管即摘首帧属性，prepaint CSS 层整体失效（与 panelCardOrderPrepaint
    // 的交棒同款手法）。无条件摘：null（fail-open 全显示）时若不摘，过期快照
    // 画的 CSS 层会压住本该显示的卡——首帧属性只在「首绘到本脚本执行之间」
    // 有意义，此后运行时是唯一真值源。
    document.documentElement.removeAttribute("data-prepaint-hidden-agents");
  }
  // 可见集变化时由 initSettingsView 注册重建入口：buildKeepAliveEndpoints 嵌在
  // 它的闭包里，IIFE 层不能直引（跨作用域 ReferenceError），走回调解耦。
  let rebuildKeepAliveButtons = null;
  // 取数成功且可见集变化时，把依赖它的三处静态 UI 重算一遍。变化才重算：
  // 刷新轮询每次都全量重画会打断展开中的下拉/悬停。
  function applyInstalledAgentIds(ids) {
    const prev = installedAgentIds;
    installedAgentIds = ids;
    installedAgentIdsAt = Date.now();
    if (ids === null) return;
    const same = prev instanceof Set && ids.size === prev.size && [...ids].every((id) => prev.has(id));
    if (same) return;
    writeInstalledAgentsSnapshot(ids);
    applyAgentCardVisibility(ids);
    if (rebuildKeepAliveButtons) rebuildKeepAliveButtons(); // 设置-抗截断端点钮（幂等重建）
    renderRouteChains();                // 设置-自动路由瓦片墙
    sessEpOptionsKey = "";              // 会话筛选下拉按新可见集重算
    refreshSessEndpointOptions();
  }
  function loadInstalledAgentIds() {
    if (installedAgentIdsAt && Date.now() - installedAgentIdsAt < 60000 && installedAgentIds) {
      return Promise.resolve(installedAgentIds);
    }
    return api("GET", "/api/environment")
      .then((state) => {
        const clients = Array.isArray(state.clients) ? state.clients : [];
        // 客户端清单为空是检测异常形态，不是「什么都没装」：按未知处理
        if (!clients.length) return null;
        const ids = new Set();
        for (const client of clients) {
          const installations = Array.isArray(client.installations) ? client.installations : [];
          if (installations.some((item) => item && item.status !== "not_found")) ids.add(client.id);
        }
        applyInstalledAgentIds(ids);
        return ids;
      })
      .catch(() => null); // 失败不进缓存：期间沿用快照，下次取数再试
  }
  // 首帧先用上次快照隐藏（panel.html 的 prepaint 已把 CSS 画好，这里同步挂
  // [hidden] 接棒），再取一次环境检测对齐真值。放在 reorderAgentCards 之后：
  // panel.test.mjs 的卡序沙箱从 AGENT_CARD_ORDER 切到本函数结尾，中间这段
  // 属于它，可见性 helper 不得插进那个切片。
  applyAgentCardVisibility(installedAgentIds);
  loadInstalledAgentIds();

  // ── B1 卡片渲染指纹：数据没变就整卡跳过，不碰 DOM ──
  // 指纹 = routeChainsVer/msModelsCacheVer/routeRuntimeVer/sparkWindowPoints
  // + JSON.stringify(agent)。routeChainsVer 由链配置引用变化驱动（R9：Store tab
  // 改链后 storeState.routingChains 换引用即失配，切回看板另有清表+补刷兜底）。
  const agentRenderFp = {};
  // 最近一次 /api/agents 的 payload：看板侧活跃真值流（boardActivityApplyFrame）按它
  // 定位要改的端点/实例行。随每次轮询整体换引用；SSE 渲染只改字段、不换引用，
  // 指纹闸依旧只由轮询维护（agentRenderFp 不变即跳过重渲，口径由轮询收口）。
  let lastBoardAgents = [];
  let routeChainsVer = 0;
  let msModelsCacheVer = 0;
  let routeRuntimeVer = 0;
  let lastBoardChainsRef = null;

  function syncRouteChainsVer() {
    const chains = (storeState && Array.isArray(storeState.routingChains))
      ? storeState.routingChains : routeChainsCache;
    if (chains !== lastBoardChainsRef) { lastBoardChainsRef = chains; routeChainsVer += 1; }
  }

  function resetAgentRenderFingerprints() {
    for (const k of Object.keys(agentRenderFp)) delete agentRenderFp[k];
  }

  // 速率类指标是 last-N 计数窗口而非时间窗，闲置再久数值也不失效；
  // lastSeen 超阈值即陈旧：速率类置 —，累计类（工时/tokens/请求数）不动。
  const INSTANCE_STALE_MS = 2 * 60 * 1000;

  function formatRelativeAge(ts) {
    const diff = Date.now() - ts;
    if (diff < 45 * 1000) return "刚刚";
    const m = Math.floor(diff / 60000);
    if (m < 1) return Math.floor(diff / 1000) + " 秒前";
    if (m < 60) return m + " 分钟前";
    const h = Math.floor(m / 60);
    if (h < 24) return h + " 小时前";
    return Math.floor(h / 24) + " 天前";
  }

  function isInstanceStale(inst) {
    if (!inst || inst.status === "active") return false;
    const ls = inst.lastSeen;
    return typeof ls === "number" && (Date.now() - ls) > INSTANCE_STALE_MS;
  }

  // 静态卡（zc/qoder）端点级陈旧判定：读全局汇总行 lastSeen，口径同实例行。
  function isEndpointStale(agent, isGenerating) {
    if (isGenerating) return false;
    const s0 = agent.sessions && agent.sessions[0];
    const ls = s0 && s0.lastSeen;
    return typeof ls === "number" && (Date.now() - ls) > INSTANCE_STALE_MS;
  }

  // 静态卡速率类三格压暗/恢复（工时卡不动）。
  function dimEndpointRateCards(prefix, stale) {
    for (const suffix of ["TtftVal", "TpsVal", "CacheVal"]) {
      const el = $(prefix + suffix);
      const card = el && el.closest ? el.closest(".telemetry-card") : null;
      if (card) card.classList.toggle("inst-stale", stale);
    }
  }

  // 含陈旧行时把分钟桶混入指纹，「X 前」标注至多每分钟重渲染刷新一次。
  function agentStaleTick(agent) {
    const now = Date.now();
    const has = (ls) => typeof ls === "number" && (now - ls) > INSTANCE_STALE_MS;
    if (Array.isArray(agent.instances) && agent.instances.some((i) => i.status !== "active" && has(i.lastSeen))) {
      return Math.floor(now / 60000);
    }
    if (Array.isArray(agent.sessions) && agent.sessions.some((s) => s.status !== "active" && has(s.lastSeen))) {
      return Math.floor(now / 60000);
    }
    return 0;
  }

  function renderIfChanged(id, agent, render) {
    const fp = routeChainsVer + "/" + msModelsCacheVer + "/" + routeRuntimeVer
      + "/" + sparkWindowPoints + "/" + agentStaleTick(agent) + "|" + JSON.stringify(agent);
    if (agentRenderFp[id] === fp) return;
    agentRenderFp[id] = fp;
    render(agent);
  }

  // 看板首帧闸：pending → live 的唯一翻转点。
  //
  // 判据是「后端明说这一帧能当事实说」（frame.ready），不是「请求成功了吗」：relay 没起、
  // 面板跨进程拉取超时又手里没有可续的陈旧快照时，回来的是一帧结构完整但空有其形的东西，
  // 渲染它就把「还没取到数」画成「什么都没跑」（2026-10-07 报的那段中间态）。此时什么都不画，
  // 画面继续停在 HTML 静态带的 data-board="pending" 上——卡内只有骨架条（见 panel.css 同名段）。
  // 兼容不带 frame 的旧后端：非空 agents 即算数，行为与改前一致。
  //
  // 判定抽成纯函数是为了让这段逻辑能在测试里真跑一遍（与 relayStatusPresentation 同因），
  // 而不是只对源码做正则断言。
  function boardFrameVerdict(res) {
    const agents = res && Array.isArray(res.agents) ? res.agents : null;
    if (!agents || agents.length === 0) return false;
    if (res.frame) return res.frame.ready === true;
    return true;
  }

  let boardLive = false;
  let boardLiveSettled = null;
  const boardLivePromise = new Promise((resolve) => { boardLiveSettled = resolve; });
  function markBoardLive() {
    if (boardLive) return;
    boardLive = true;
    document.documentElement.setAttribute("data-board", "live");
    // 一次性消费：开屏层用它决定退场时机（拿到可信首帧才揭，而不是请求一 resolve 就揭）。
    if (boardLiveSettled) boardLiveSettled();
  }

  async function refreshAgents() {
    if (agentsInFlight) return;
    agentsInFlight = true;
    try {
      const res = await api("GET", "/api/agents");
      const boardWasPending = !boardLive;
      if (!boardFrameVerdict(res)) return;
      markBoardLive();
      if (res && res.agents) {
        lastBoardAgents = res.agents;
        syncRouteChainsVer();
        reorderAgentCards(res.agents);
        const zc = res.agents.find(a => a.id === "zcode");
        const cc = res.agents.find(a => a.id === "claude");
        const dsh = res.agents.find(a => a.id === "dsh");
        const pi = res.agents.find(a => a.id === "pi");
        const kimi = res.agents.find(a => a.id === "kimi");
        const qoder = res.agents.find(a => a.id === "qoder");
        const opencode = res.agents.find(a => a.id === "opencode");
        const codex = res.agents.find(a => a.id === "codex");
        const grok = res.agents.find(a => a.id === "grok");
        if (zc) renderIfChanged("zcode", zc, () => renderZcode(zc));
        if (cc) renderIfChanged("claude", cc, () => renderClaude(cc));
        if (dsh) renderIfChanged("dsh", dsh, () => renderDsh(dsh));
        if (pi) renderIfChanged("pi", pi, () => renderPi(pi));
        if (qoder) renderIfChanged("qoder", qoder, () => renderQoder(qoder));
        if (kimi) renderIfChanged("kimi", kimi, () => renderKimi(kimi));
        if (opencode) renderIfChanged("opencode", opencode, (agent) => renderOpencode(opencode));
        if (codex) renderIfChanged("codex", codex, () => renderCodex(codex));
        if (grok) renderIfChanged("grok", grok, () => renderGrok(grok));
        // 左栏路由链卡：随 1s 轮询刷退避倒计时，结构指纹闸控 DOM 重建
        renderRouteChainBoard();
        // 看板内容已真实：通知设置页主题镜像补拍恢复路径下那张空壳快照（一次性）
        notifyBoardRendered();
        // 落数据重播入屏揭示：无开屏层遮挡时（普通刷新、关开屏、开屏兜底超时已退场）
        // 加载态骨架一直露在屏上，拿到可信帧这一刻把看板阶梯入场补播一遍，「骨架→真容」
        // 有个落位交代而不是硬切。开屏层还在时不播：首开/重启窗口内的那次入场已挂在
        // 开屏淡出起点（onLeave），这里再播只会在遮挡层底下空放一遍；落在别的视图也
        // 不播，那一屏的入场归 switchView 管。时点放在整卡渲染完之后：动画首帧看到的
        // 就是真内容，且 reorderAgentCards 已摘掉首帧卡序属性，阶梯按真卡序发延迟。
        if (boardWasPending && boardVisible() && !document.documentElement.hasAttribute("data-startup")) {
          playBoardEnter(document.querySelector(".telemetry-view"));
        }
      }
    } catch {}
    finally { agentsInFlight = false; }
  }

  // 收起态简要信息栏：与多实例端点实例行同构——名称行（标题 + 状态徽标 + 请求数徽标）+
  // tokens 行（Prompt/Completion/Cached）+ 胶囊行（tok/s、TTFT 灯、缓存命中率、工时）。
  // staleText 非空时（陈旧端点）隐藏速率类三枚，改显示相对时间胶囊；
  // tokens/请求数为累计量，陈旧态照常显示（与实例行同口径）。
  function updateDetailBrief(prefix, { isGenerating, ttft, ttftColor, tps, hit, durationText, staleText, requests, tokensText }) {
    const state = $(prefix + "BriefState");
    if (!state) return;
    state.className = "badge " + (isGenerating ? "badge-ok" : "badge-neutral");
    state.textContent = isGenerating ? "生成中" : "待命";
    const reqs = $(prefix + "BriefReqs");
    if (reqs) reqs.textContent = `${requests || 0} 请求`;
    const tokensLine = $(prefix + "BriefTokens");
    if (tokensLine && typeof tokensText === "string") tokensLine.textContent = tokensText;
    const setPill = (suffix, show, html) => {
      const el = $(prefix + suffix);
      if (!el) return;
      el.hidden = !show;
      if (show) el.innerHTML = html;
    };
    const staleMode = typeof staleText === "string";
    setPill("BriefStale", staleMode, staleMode ? staleText : "");
    setPill("BriefTps", !staleMode && tps !== null, tps !== null ? `${tps.toFixed(1)} tok/s` : "");
    setPill("BriefTtft", !staleMode && ttft !== null, ttft !== null ? `<i class="lamp lamp-${ttftColor}"></i> ${(ttft / 1000).toFixed(2)}s` : "");
    setPill("BriefCache", !staleMode && hit !== null, hit !== null ? `缓存 ${hit.toFixed(1)}%` : "");
    setPill("BriefDuration", true, `工作 ${durationText}`);
  }

  // 端点详情折叠（zcode/qoder）：运行中默认收起——
  // 详细遥测四宫格换成与多实例端点实例行同构的简要信息栏（含 tokens 行/请求数徽标），
  // 「全局汇总」行改仅展开态显示（与多实例栏 detail-open-only 同范式：收起态 tokens/请求数
  // 已由简要栏承载，双行并存属重复展示）；
  // 展开后换回四宫格。展开态记 localStorage（与 route-fold 同交互语义），刷新不回落；
  // 渲染只拨 *MetricsBlock.hidden，不碰 grid/brief.hidden，故折叠态跨 15s 轮询自然保持；
  // 未运行时折叠钮由 card-collapsed CSS 隐藏。
  // dsh/pi/kimi/opencode/codex 已从此旧机制摘除，改走下方 data-prefix 事件委托。
  ["zc", "qoder"].forEach((prefix) => {
    const grid = $(prefix + "TelemetryGrid");
    const brief = $(prefix + "DetailBrief");
    const foldBtn = $(prefix + "DetailFoldBtn");
    if (!grid || !brief || !foldBtn) return;
    const sessionRow = $(prefix + "SessionRow");
    const aggWrap = sessionRow ? sessionRow.closest(".session-table-wrapper") : null;
    const storeKey = "agent-detail-fold-" + prefix;
    const setFold = (open) => {
      grid.hidden = !open;
      brief.hidden = open;
      if (aggWrap) aggWrap.hidden = !open;
      foldBtn.setAttribute("aria-expanded", open ? "true" : "false");
      foldBtn.textContent = open ? "收起 ▴" : "展开 ▾";
      // 展开瞬间补绘：折叠期间端点级 buffer 照常累积但不绘制（见 redrawEndpointSparklines），
      // 这里用已攒数据立刻上屏，不等下一轮 1s 轮询。
      if (open) {
        redrawEndpointSparklines(prefix);
      }
    };
    let open = false; // 默认收起
    try { open = localStorage.getItem(storeKey) === "1"; } catch {}
    setFold(open);
    foldBtn.onclick = () => {
      open = !open;
      setFold(open);
      try { localStorage.setItem(storeKey, open ? "1" : "0"); } catch {}
    };
  });

  // ═══════════════════════════════════════════════
  // 多实例栏共享地基（claude/kimi/opencode/pi/codex）：
  // 实例行渲染、实例级 sparkline、折叠状态机与事件委托
  // ═══════════════════════════════════════════════

  // 实例级 sparkline 历史：与端点级 historyBuffers 完全隔离，
  // 按 `${prefix}:${instanceId}` 分键；实例消失时由 renderInstanceRows 清理，防内存泄漏。
  const instanceSparkBuffers = {};

  // 推入一个实例采样点；与 pushMetricPoint 同语义（连续同值去重、按窗口裁剪），
  // 只是落到独立的实例 buffer store。vals = { tps, cacheHitRate, ttft }，非数值忽略。
  function pushInstanceSpark(prefix, instanceId, vals) {
    const key = prefix + ":" + String(instanceId);
    const buf = instanceSparkBuffers[key] || (instanceSparkBuffers[key] = { tps: [], cache: [], ttft: [] });
    const pushOne = (arr, val) => {
      if (typeof val === "number" && !isNaN(val)) {
        const last = arr[arr.length - 1];
        if (!last || last.v !== val) arr.push({ t: Date.now(), v: val });
      }
      pruneSparkBuffer(arr);
    };
    pushOne(buf.tps, vals ? vals.tps : null);
    pushOne(buf.cache, vals ? vals.cacheHitRate : null);
    pushOne(buf.ttft, vals ? vals.ttft : null);
  }

  // 折叠状态机：prefix → 是否展开，惰性从 localStorage 初始化
  // （key 与旧机制同语义：agent-detail-fold-<prefix>，claude 用 cc）。
  const detailFoldState = {};
  function isDetailOpen(prefix) {
    if (!(prefix in detailFoldState)) {
      let open = false; // 默认收起
      try { open = localStorage.getItem("agent-detail-fold-" + prefix) === "1"; } catch {}
      detailFoldState[prefix] = open;
    }
    return detailFoldState[prefix];
  }
  // 翻转 + 持久化，返回新状态；DOM 应用由调用方走 applyDetailFold。
  function toggleDetailFold(prefix) {
    const open = !isDetailOpen(prefix);
    detailFoldState[prefix] = open;
    try { localStorage.setItem("agent-detail-fold-" + prefix, open ? "1" : "0"); } catch {}
    return open;
  }

  // 把折叠态应用到 DOM：同步该 prefix 所有折叠钮的 aria-expanded/文案，
  // 并切换钮所在卡片内实例四宫格与 .detail-open-only（如「全局汇总」行）的 hidden。
  // renderInstanceRows 渲染后与折叠钮点击时都会走这里，不等下轮轮询。
  function applyDetailFold(prefix) {
    const open = isDetailOpen(prefix);
    document.querySelectorAll('.agent-detail-fold[data-prefix="' + prefix + '"]').forEach((btn) => {
      btn.setAttribute("aria-expanded", open ? "true" : "false");
      btn.textContent = open ? "收起 ▴" : "展开 ▾";
      const card = btn.closest(".panel-card");
      if (!card) return;
      card.querySelectorAll(".instance-telemetry-grid, .detail-open-only").forEach((el) => { el.hidden = !open; });
      // 展开瞬间补绘：折叠期间 buffer 照常累积但不绘制，这里用已攒数据立刻上屏，
      // 不等下一轮 1s 轮询（renderInstanceRows 渲染后调用时 open 已正确，重复补绘被
      // updateSparkline 的路径级 diff 吸收为零 DOM 写）。
      if (open) redrawInstanceSparklines(prefix);
    });
  }

  // 静态「全局汇总」行门控：有实例时归 detail-open-only 机制（仅展开态显示）；
  // 零实例时让位给 renderInstanceRows 的伪实例行——摘掉 detail-open-only 并强制隐藏，
  // 避免展开态两行「全局汇总」并存。须在 applyDetailFold 之后调用（以其结果为最终态）。
  function gateAggregateRow(prefix, rowEl, instanceCount) {
    if (!rowEl) return;
    const has = instanceCount > 0;
    rowEl.classList.toggle("detail-open-only", has);
    rowEl.hidden = !(has && isDetailOpen(prefix));
  }

  // 聚合伪实例行数据：零实例时用端点聚合量造一行「全局汇总」，字段与实例行同构。
  // lastSeen 透出给陈旧判定（聚合桶同为无 TTL 残留）。
  function buildAggregateFallback(m, d, isGenerating) {
    const sess = (d.sessions && d.sessions[0]) || {};
    const ttft = m.lastTtftMs || d.lastTtftMs;
    const tps = m.tps !== undefined ? m.tps : d.tps;
    const hit = m.cacheHitRate !== undefined ? m.cacheHitRate : d.cacheHitRate;
    const dur = m.activeDurationMs || d.activeDurationMs;
    return {
      status: isGenerating ? "active" : "idle",
      tokens: m.tokens || sess.tokens || {},
      requests: m.totalRequests || d.totalRequests || 0,
      tps: (typeof tps === "number" && tps > 0) ? tps : null,
      lastTtftMs: (typeof ttft === "number" && ttft > 0) ? ttft : null,
      ttftColor: m.ttftColor || "green",
      cacheHitRate: (typeof hit === "number") ? hit : null,
      activeDurationFormatted: formatDurationSeconds(dur),
      lastSeen: typeof sess.lastSeen === "number" ? sess.lastSeen : null,
    };
  }

  // claude 无端点级聚合桶（per-launch 会话流量只落各会话行，不进常驻 relay 聚合桶），
  // 「全局汇总」由各会话行求和派生：tokens/请求数/工时累加，tps 为各会话之和，
  // 缓存命中率按 prompt 加权，TTFT 与 lastSeen 取最近有活动的会话。会话行消亡
  // 后其累计并入后端下发的退役账（retiredMetrics）——汇总 = 活行 + 退役账。
  function claudeAggregateMetrics(sessions, retired) {
    const tokens = { prompt: 0, completion: 0, cached: 0 };
    let totalRequests = 0, tpsSum = 0, durationMs = 0;
    let lastSeen = null, ttftMs = null, ttftColor = "green", ttftSeen = -1;
    for (const s of Array.isArray(sessions) ? sessions : []) {
      const tk = s.tokens || {};
      tokens.prompt += tk.prompt || 0;
      tokens.completion += tk.completion || 0;
      tokens.cached += tk.cached || 0;
      totalRequests += s.requests || 0;
      if (typeof s.tps === "number" && s.tps > 0) tpsSum += s.tps;
      durationMs += s.activeDurationMs || 0;
      const seen = typeof s.lastSeen === "number" ? s.lastSeen : null;
      if (seen !== null && (lastSeen === null || seen > lastSeen)) lastSeen = seen;
      if (typeof s.lastTtftMs === "number" && s.lastTtftMs > 0 && (seen || 0) >= ttftSeen) {
        ttftSeen = seen || 0;
        ttftMs = s.lastTtftMs;
        ttftColor = s.ttftColor || "green";
      }
    }
    // 退役账并表：计数类直接加总；lastSeen/TTFT 与活行取最近。后端在 claude
    // 家族全灭清零时同步归零退役账，无需前端再做归零判断。
    const ledger = retired && typeof retired === "object" ? retired : null;
    if (ledger) {
      tokens.prompt += ledger.promptTokens || 0;
      tokens.completion += ledger.completionTokens || 0;
      tokens.cached += ledger.cachedTokens || 0;
      totalRequests += ledger.requests || 0;
      durationMs += ledger.activeDurationMs || 0;
      const seen = typeof ledger.lastSeen === "number" ? ledger.lastSeen : null;
      if (seen !== null && (lastSeen === null || seen > lastSeen)) lastSeen = seen;
      if (typeof ledger.lastTtftMs === "number" && ledger.lastTtftMs > 0
        && seen !== null && seen >= ttftSeen) {
        ttftSeen = seen;
        ttftMs = ledger.lastTtftMs;
      }
    }
    return {
      tokens,
      totalRequests,
      tps: tpsSum > 0 ? Number(tpsSum.toFixed(1)) : null,
      lastTtftMs: ttftMs,
      ttftColor,
      cacheHitRate: tokens.prompt > 0 ? Number(((tokens.cached / tokens.prompt) * 100).toFixed(1)) : null,
      activeDurationMs: durationMs,
      lastSeen,
    };
  }

  // 折叠钮事件委托：栏位只需在栏头放 <button class="agent-detail-fold" data-prefix="kimi">，
  // 即可获得完整折叠行为（翻转 + 持久化 + 对该栏已渲染行即时应用）。
  document.addEventListener("click", (ev) => {
    const btn = ev.target && ev.target.closest ? ev.target.closest(".agent-detail-fold[data-prefix]") : null;
    if (!btn) return;
    const prefix = btn.getAttribute("data-prefix");
    toggleDetailFold(prefix);
    applyDetailFold(prefix);
  });
  // 首刷同步静态折叠钮的初始文案/折叠态（暂无 data-prefix 钮时为空转）
  document.querySelectorAll(".agent-detail-fold[data-prefix]").forEach((btn) => applyDetailFold(btn.getAttribute("data-prefix")));

  // 实例计数胶囊：更新 #<prefix>InstanceCount 文本为「N 实例」；
  // n>0 显示，否则隐藏；元素不存在时静默返回。
  function setInstanceCount(prefix, n) {
    const el = $(prefix + "InstanceCount");
    if (!el) return;
    el.hidden = !(n > 0);
    if (n > 0) el.textContent = n + " 实例";
  }

  // 通用实例行渲染器：把实例数组渲染成「简要行 + 行内可展开四宫格」。
  // 简要行与 Claude Code 会话行同构；四宫格 DOM 带稳定 id（<prefix>Inst*-<domId>）
  // 并以 data-instance-id 索引，便于后续按实例更新。instances 为空时用
  // aggregateFallback 渲染一行「全局汇总」伪实例行，走同一范式。
  // 渲染后按当前折叠态应用四宫格 hidden，并清理已消失实例的 spark buffer。
  // showSurface：行上贴一枚 `inst.surface` 徽标。行号只能表达「第几行」，
  // 表达不了「这一行是哪个界面」——DSH 的 web 与每个 TUI 终端同属一个端点 id，
  // 徽标取后端从进程命令行读出的 profile 显示名，读不出就不贴（不猜）。
  function renderInstanceRows({ prefix, listEl, instances, aggregateFallback, showSurface = false }) {
    if (!listEl) return;
    const list = (Array.isArray(instances) && instances.length > 0)
      ? instances
      : (aggregateFallback ? [Object.assign({ id: "__aggregate__", title: "全局汇总" }, aggregateFallback)] : []);
    const open = isDetailOpen(prefix);
    const seenKeys = {};
    listEl.innerHTML = "";
    list.forEach((inst, idx) => {
      const iid = String(inst.id || "unknown");
      const domId = iid.replace(/[^A-Za-z0-9_-]/g, "_");
      seenKeys[prefix + ":" + iid] = true;
      const tokens = inst.tokens || {};
      const isAct = inst.status === "active";
      const tps = inst.tps;
      const ttft = inst.lastTtftMs;
      const ttftColor = inst.ttftColor || "green";
      const hit = inst.cacheHitRate;
      const durText = inst.activeDurationFormatted || formatDurationSeconds(inst.activeDurationMs);
      // 陈旧行：速率类三格置 — 压暗、折线停绘，胶囊行换成最后活动时间；累计量不动。
      const stale = isInstanceStale(inst);
      const staleCls = stale ? " inst-stale" : "";

      // 简要行：名称行（「会话 #x」编号 + 面徽标（showSurface 时）+ 状态徽标 + 请求数徽标）
      // + tokens 行 + 胶囊行。
      // 编号按本卡行显示顺序 1 起，纯渲染时按 idx 派生，不持久化；
      // 伪「全局汇总」行（__aggregate__）不是实例，不编号、不挂生成中/待命状态徽标。
      const isAggregate = iid === "__aggregate__";
      const rowTitle = isAggregate ? escapeHtml(inst.title || iid) : "会话 #" + (idx + 1);
      const surfaceBadge = !isAggregate && showSurface && inst.surface
        ? `<span class="badge badge-neutral">${escapeHtml(String(inst.surface))}</span>`
        : "";
      const stateBadge = isAggregate ? "" : (
        isAct
          ? `<span class="badge badge-ok">生成中</span>`
          : `<span class="badge badge-neutral">待命</span>`
      );
      const row = document.createElement("div");
      row.className = "session-row";
      row.dataset.instanceId = iid;
      row.innerHTML = `
        <div class="session-main">
          <div class="session-name-line">
            <span>${rowTitle}</span>
            ${surfaceBadge}
            ${stateBadge}
            <span class="badge badge-neutral">${inst.requests || inst.totalRequests || 0} 请求</span>
          </div>
          <div class="session-tokens-line">
            Prompt: ${formatTokens(tokens.prompt)} · Completion: ${formatTokens(tokens.completion)} · Cached: ${formatTokens(tokens.cached)}
          </div>
        </div>
        <div class="session-tags-line">
          ${stale ? `<span class="tag-bubble tag-stale">${formatRelativeAge(inst.lastSeen)}</span>` : `
          ${tps ? `<span class="tag-bubble">${tps.toFixed(1)} tok/s</span>` : ""}
          ${ttft ? `<span class="tag-bubble"><i class="lamp lamp-${ttftColor}"></i> ${(ttft / 1000).toFixed(2)}s</span>` : ""}
          ${typeof hit === "number" ? `<span class="tag-bubble">缓存 ${hit.toFixed(1)}%</span>` : ""}`}
          ${durText ? `<span class="tag-bubble">工作 ${durText}</span>` : ""}
        </div>
      `;
      listEl.appendChild(row);

      // 行内四宫格：本实例自己的遥测（卡序与静态卡一致：首字响应 + sparkline、生成速度 + sparkline、缓存命中率 + sparkline、已工作时间）
      const sparkTpsId = prefix + "InstSparkTps-" + domId;
      const sparkCacheId = prefix + "InstSparkCache-" + domId;
      const sparkTtftId = prefix + "InstSparkTtft-" + domId;
      const grid = document.createElement("div");
      grid.className = "instance-telemetry-grid";
      grid.dataset.instanceId = iid;
      grid.dataset.stale = stale ? "1" : "0";
      grid.hidden = !open;
      grid.innerHTML = `
        <div class="telemetry-card${staleCls}">
          <div class="telemetry-header">
            <span class="telemetry-label">首字响应时间</span>
            <div class="telemetry-sparkline" id="${sparkTtftId}"></div>
          </div>
          <div class="telemetry-content">
            <div class="telemetry-num">
              <i class="lamp lamp-${!stale && ttft > 0 ? ttftColor : "gray"}"></i>
              <span>${!stale && ttft > 0 ? (ttft / 1000).toFixed(2) : "-"}</span>
              <span class="telemetry-unit">s</span>
            </div>
          </div>
        </div>
        <div class="telemetry-card${staleCls}">
          <div class="telemetry-header">
            <span class="telemetry-label">生成速度</span>
            <div class="telemetry-sparkline" id="${sparkTpsId}"></div>
          </div>
          <div class="telemetry-content">
            <div class="telemetry-num">
              <span>${!stale && tps > 0 ? tps.toFixed(1) : "-"}</span>
              <span class="telemetry-unit">tok/s</span>
            </div>
          </div>
        </div>
        <div class="telemetry-card${staleCls}">
          <div class="telemetry-header">
            <span class="telemetry-label">缓存命中率</span>
            <div class="telemetry-sparkline" id="${sparkCacheId}"></div>
          </div>
          <div class="telemetry-content">
            <div class="telemetry-num">
              <span>${!stale && typeof hit === "number" ? hit.toFixed(1) : "-"}</span>
              <span class="telemetry-unit">%</span>
            </div>
          </div>
        </div>
        <div class="telemetry-card">
          <div class="telemetry-header">
            <span class="telemetry-label">已工作时间</span>
          </div>
          <div class="telemetry-content">
            <div class="telemetry-num">
              <span>${escapeHtml(durText || "0秒")}</span>
            </div>
          </div>
        </div>
      `;
      listEl.appendChild(grid);

      // 实例级 sparkline：按 `${prefix}:${instanceId}` 分键累积后绘制（缓存锁定 0-100 量程）
      pushInstanceSpark(prefix, iid, {
        tps: typeof tps === "number" ? tps : null,
        cacheHitRate: typeof hit === "number" ? hit : null,
        ttft: typeof ttft === "number" && ttft > 0 ? ttft / 1000 : null,
      });
      const buf = instanceSparkBuffers[prefix + ":" + iid];
      // 权威历史暂存：折叠期间无 inst 可用，展开补绘（redrawInstanceSparklines）
      // 要用与本次渲染同源的 sparkHistory，否则 ttft 曲线口径回退到本地去重 buffer。
      if (inst.sparkHistory) buf.sparkHistory = inst.sparkHistory;
      // 折叠门控：收起态跳过绘制，展开瞬间经 applyDetailFold 补绘；陈旧行不绘历史折线。
      // 三条线统一接权威历史：tps/cache 与 ttft 同样消费 sparkHistory，刷新或丢
      // buffer 后的首轮即由服务端历史整线恢复。只让一条线接历史，其余两条会在刷新后
      // 从零攒点，表现为折线节点丢失。
      if (open && !stale) {
        updateSparkline(sparkTpsId, sparkValues(buf.tps, buf.sparkHistory?.tps));
        updateSparkline(sparkCacheId, sparkValues(buf.cache, buf.sparkHistory?.cache), 0, 100);
        updateSparkline(sparkTtftId, sparkValues(buf.ttft, buf.sparkHistory?.ttft));
      }
    });
    // 实例消失：清理其 spark buffer，防内存泄漏
    for (const key of Object.keys(instanceSparkBuffers)) {
      if (key.startsWith(prefix + ":") && !seenKeys[key]) delete instanceSparkBuffers[key];
    }
  }

  // 展开瞬间补绘：按当前 DOM 行序把已攒 buffer 画回本栏实例折线（不串其他栏），
  // 供 applyDetailFold（data-prefix 栏）与旧 id 接线栏的 setFold（zcode/qoder）
  // 展开时调用——否则折叠期间攒的数据要等下一轮 1s 轮询才上屏。
  // 行→实例配对与 renderInstanceRows 同构（.instance-telemetry-grid[data-instance-id]），
  // ttft 取 buffer 暂存的权威历史、cache 锁 0-100 量程，与渲染时口径一致。
  function redrawInstanceSparklines(prefix) {
    document.querySelectorAll('.instance-telemetry-grid[data-instance-id]').forEach((grid) => {
      const card = grid.closest(".panel-card");
      if (!card) return;
      // 本栏的折叠钮：新机制按 data-prefix 找，旧机制按 <prefix>DetailFoldBtn 找。
      if (!card.querySelector('.agent-detail-fold[data-prefix="' + prefix + '"]')
        && !card.querySelector("#" + prefix + "DetailFoldBtn")) return;
      if (grid.dataset.stale === "1") return; // 陈旧行不补绘历史折线
      const iid = grid.dataset.instanceId;
      const buf = instanceSparkBuffers[prefix + ":" + iid];
      if (!buf) return;
      const domId = iid.replace(/[^A-Za-z0-9_-]/g, "_");
      // 与渲染路径同口径：三条线都接 buffer 暂存的权威历史（见 renderInstanceRows 内注释）
      updateSparkline(prefix + "InstSparkTps-" + domId, sparkValues(buf.tps, buf.sparkHistory?.tps));
      updateSparkline(prefix + "InstSparkCache-" + domId, sparkValues(buf.cache, buf.sparkHistory?.cache), 0, 100);
      updateSparkline(prefix + "InstSparkTtft-" + domId, sparkValues(buf.ttft, buf.sparkHistory?.ttft));
    });
  }

  const msOpen = new Set();
  function fmtMsClock(ts) {
    const d = new Date(ts);
    const p = (x) => (x < 10 ? "0" : "") + x;
    return p(d.getHours()) + ":" + p(d.getMinutes());
  }
  function fmtLatency(ms) {
    if (!ms) return "—";
    return ms >= 1000 ? (ms / 1000).toFixed(1) + "s" : Math.round(ms) + "ms";
  }

  // ── 看板路由链状态的数据缓存 ──
  // msModelsCache = 最近一次 stability 行（节点灯色的数据源，随 15s 轮询刷新）；
  // routeChainsCache/routeNodeInfoCache = 端点链配置与节点显示名映射（60s TTL：
  // 链配置低频变化，避免每 15s 全量重拉 store；Store tab 编辑链后经
  // boardRoutingChains 的 storeState 优先读取立即生效，不等 TTL）。
  let msModelsCache = [];
  let routeChainsCache = null;
  let routeVirtualModelsCache = null;
  let routeChainsFetchedAt = 0;
  let routeNodeInfoCache = null; // { providers: Map<id,name>, pools: Map<id,name> }
  const ROUTE_CHAINS_CACHE_TTL_MS = 60000;

  async function refreshRouteChainsCache() {
    const now = Date.now();
    if (routeChainsCache !== null && now - routeChainsFetchedAt < ROUTE_CHAINS_CACHE_TTL_MS) return;
    try {
      const res = await api("GET", "/api/store/state");
      routeChainsCache = Array.isArray(res.routingChains) ? res.routingChains : [];
      routeVirtualModelsCache = Array.isArray(res.virtualModels) ? res.virtualModels : [];
      routeNodeInfoCache = {
        providers: new Map(((res && res.providers) || []).map((p) => [p.id, p.displayName || p.id])),
        pools: new Map(((res && res.pools) || []).map((pl) => [pl.id, pl.displayName || pl.id])),
      };
      routeChainsFetchedAt = now;
    } catch { /* 保留旧缓存，下轮再试 */ }
  }

  // 路由链运行时态（链粘性位置 node+model / 退避起始点 since / 重试间隔），
  // 供左栏路由链卡定位当前跳与倒计时。15s TTL 跟随监测页轮询节奏（fetchedAt
  // 先行置位，失败也节流）。
  //
  // 端点卡胶囊的 auto 标记不读本缓存（按 rt.current 匹配=「下一跳位置」，会把
  // 行走服务中的模型漏标、把直连同 model 误标）。胶囊改用条目自身的服务归因
  //（activeTargets.autoCount / lastViaAuto，与胶囊模型名同源），见
  // autoRouteMarkForTarget。本缓存只剩路由链卡一个消费者。
  let routeRuntimeCache = null;
  let routeRuntimeState = "loading";
  let routeRuntimeFetchedAt = 0;
  const ROUTE_RUNTIME_CACHE_TTL_MS = 15000;

  async function refreshRouteRuntimeCache() {
    const now = Date.now();
    if (now - routeRuntimeFetchedAt < ROUTE_RUNTIME_CACHE_TTL_MS) return;
    routeRuntimeFetchedAt = now;
    try {
      const res = await api("GET", "/api/route-chain/runtime");
      routeRuntimeCache = (res && res.endpoints) || null;
      routeRuntimeState = "ok";
      routeRuntimeVer += 1; // B1：成功刷新
    } catch {
      routeRuntimeCache = null;
      routeRuntimeState = "absent"; // 端点 404 / 拉取失败：按旧版退化口径
      routeRuntimeVer += 1; // B1：置 null 也是状态变化，同样须失配
    }
  }

  // 链配置读取：Store tab 已拉过 storeState 时优先（编辑后即时生效），否则用看板 60s 缓存
  function boardRoutingChains() {
    if (storeState && Array.isArray(storeState.routingChains)) return storeState.routingChains;
    return routeChainsCache || [];
  }

  function boardVirtualModels() {
    if (storeState && Array.isArray(storeState.virtualModels)) return storeState.virtualModels;
    return routeVirtualModelsCache || [];
  }

  // 按链身份取链配置：端点链的键是端点 id（routingChains[].endpointId），虚拟模型链
  // 的键是模型名（virtualModels[].name）——两者同一个命名空间，服务归因的 chainKey
  // 报的就是这个键。同一（渠道,模型）可同时出现在端点链和虚拟模型链里（例如
  // demo-pool/kimi-k3），所以位次必须按「服务它的那条链」数，不能按端点猜。
  function boardChainByKey(chainKey) {
    if (typeof chainKey !== "string" || !chainKey) return null;
    const endpointChain = boardRoutingChains().find((c) => c && c.endpointId === chainKey);
    if (endpointChain && Array.isArray(endpointChain.chain) && endpointChain.chain.length > 0) {
      return endpointChain.chain;
    }
    const virtualModel = boardVirtualModels().find((m) => m && m.name === chainKey);
    if (virtualModel && Array.isArray(virtualModel.chain) && virtualModel.chain.length > 0) {
      return virtualModel.chain;
    }
    return null;
  }

  // 「启用自动路由」判定（语义=该端点正在用 auto 工作）：端点配了链 且 启用
  // 开关开（entry.enabled !== false；getState 显式下发布尔，缺省=开）且端点
  // 进程在运行（status === "running"）。开关本身就是「正在用 auto 工作」的
  // 声明，不再看活跃/最近模型；命中返回链，供胶囊 auto 标记（renderModelBadges）
  // 判定流量来源，否则返回 null，胶囊保持直连样式。
  //
  // 只作旧 relay 的退化来源：新 relay 在归因里直接给 chainKey（服务它的那条链，
  // 虚拟模型链也算），胶囊按 chainKey 定位，不靠端点自己的链去猜。
  function agentUsingAutoRoute(agentId, st) {
    const entry = boardRoutingChains().find((c) => c.endpointId === agentId);
    const chain = entry && Array.isArray(entry.chain) ? entry.chain : null;
    if (!chain || !chain.length) return null;
    if (entry.enabled === false) return null;
    if (!st || st.status !== "running") return null;
    return chain;
  }

  // 胶囊 auto 标记判定（按服务归因，不读链位置快照）：
  // viaAuto 由胶囊条目自身的归因字段给出（activeTargets.autoCount / lastViaAuto，
  // 与胶囊模型名同源——都来自成员宣布时的服务归因），表示「这个模型正在/最近
  // 经 auto 链服务」。位次按（渠道,模型）在链配置里精确定位；链已重编辑找不到
  // 配位时返回 cur:-1（仍挂标，title 不带位次）。runtime 的 current 是链粘性
  // 位置（下一跳起点），与「正在服务什么」是两回事，那是左栏路由链卡的职责。
  function autoRouteMarkForTarget(chain, providerId, modelName, viaAuto) {
    if (!viaAuto || !chain || !modelName) return null;
    const cur = chain.findIndex((it) => it.node === providerId && it.model === modelName);
    return { cur, total: chain.length };
  }

  // 虚拟模型 "auto" 是自动路由的路由胶水，不是任何渠道上的真实模型。没有渠道
  // 配对的 auto 条目没有可展示身份，不该上屏：旧 relay（未重启的 per-launch 中
  // 继）与预检失败的请求都会送来这种条目，胶囊必须丢弃它而不是把 auto 当模型名。
  function hasDisplayIdentity(providerId, model) {
    if (typeof model !== "string" || !model) return false;
    return !(model === "auto" && !providerId);
  }

  // 胶囊数据整形：新 relay 快照带 activeTargets（渠道×模型复合账本）→ 逐条出
  // 双段胶囊（同名模型跨渠道不再坍缩为一颗）；活跃账本为空但 lastModel 在 →
  // 最近灰胶囊携带 lastProvider/lastViaAuto 来源。旧 relay 无该字段时退化为
  // 旧 activeModels/currentModel 名单（单段、无 auto 标记）——panel.html 热读
  // 而 relay 未重启的窗口期按旧口径渲染，不报错不误标。
  //
  // chainKey 随条目透传（与 viaAuto 同源）：它是「服务这条请求的链」的键，位次要按
  // 它去数。旧 relay 没有该字段时为 null，退化成按端点自己的链猜（原口径）。
  function capsuleTargetList(st) {
    if (Array.isArray(st?.activeTargets)) {
      const list = (st.activeTargets || [])
        .filter((t) => hasDisplayIdentity(t?.providerId, t?.model))
        .map((t) => ({
          providerId: t.providerId || null,
          model: t.model,
          active: true,
          viaAuto: (Number(t.autoCount) || 0) > 0,
          chainKey: typeof t.chainKey === "string" && t.chainKey ? t.chainKey : null,
        }));
      if (list.length > 0) return list;
      return hasDisplayIdentity(st.lastProvider, st.lastModel)
        ? [{
          providerId: st.lastProvider || null,
          model: st.lastModel,
          active: false,
          viaAuto: Boolean(st.lastViaAuto),
          chainKey: typeof st.lastChainKey === "string" && st.lastChainKey ? st.lastChainKey : null,
        }]
        : [];
    }
    const activeList = (st.activeModels || (st.currentModel ? [st.currentModel] : []))
      .filter((m) => hasDisplayIdentity(null, m));
    if (activeList.length > 0) return activeList.map((m) => ({ providerId: null, model: m, active: true, viaAuto: false, chainKey: null }));
    return hasDisplayIdentity(null, st.lastModel)
      ? [{ providerId: null, model: st.lastModel, active: false, viaAuto: false, chainKey: null }]
      : [];
  }

  // 胶囊文案：渠道显示名经 routeNodeName（池 id 先 pools 后 providers）；
  // 虚拟 auto 与无渠道维度的条目保持单段，绝不出现「渠道/auto」伪配对。
  function capsuleLabel(providerId, model) {
    if (!providerId || model === "auto") return model;
    return `${routeNodeName(providerId)}/${model}`;
  }

  // 端点卡胶囊区：永远渲染真实模型胶囊（活跃绿 / 最近灰），按（渠道,模型）复合
  // 键去重并双段上屏（A/a 与 B/a 各一颗）；条目自身的服务归因（viaAuto）命中时
  // 改挂 badge-auto（紫色相 + auto 角标 + title 位次），直连胶囊保持原样。
  //
  // 位次按条目自带的 chainKey 去对应链里数（端点链与虚拟模型链同口径）；旧 relay
  // 没有 chainKey 时退回端点自己的链（原口径），两条路径都取不到链就不挂标。
  function renderModelBadges(listEl, agentId, st) {
    listEl.innerHTML = "";
    const fallbackChain = agentUsingAutoRoute(agentId, st);
    const running = Boolean(st && st.status === "running");
    const seen = new Set();
    for (const t of capsuleTargetList(st)) {
      const key = (t.providerId || "") + "\u0000" + t.model;
      if (seen.has(key)) continue;
      seen.add(key);
      const chain = boardChainByKey(t.chainKey) || fallbackChain;
      // 端点在跑才挂 auto 标（与旧口径一致）：停掉的卡只剩「最近」灰胶囊，不把
      // 历史链服务说成正在使用。
      const mark = running ? autoRouteMarkForTarget(chain, t.providerId, t.model, t.viaAuto) : null;
      const b = document.createElement("span");
      b.className = "badge " + (mark ? "badge-auto" : t.active ? "badge-accent" : "badge-neutral");
      b.innerHTML = (t.active ? `<i class="lamp lamp-green"></i> 活跃: ` : "最近: ")
        + escapeHtml(capsuleLabel(t.providerId, t.model)) + (mark ? ` <em class="badge-auto-tag">auto</em>` : "");
      if (mark) b.title = mark.cur >= 0 ? `自动路由链 · 第 ${mark.cur + 1}/${mark.total} 跳` : "自动路由链";
      listEl.appendChild(b);
    }
  }

  // 实例行「模型 @ 渠道」标签已移除（端点卡胶囊升级为渠道×模型复合键后，该
  // 标签的归因信息已被端点级胶囊完整覆盖，保留只会重复展示）。

  async function refreshModelStability() {
    const list = $("msList");
    const emptyEl = $("msEmpty");
    if (!list) return;
    refreshRouteChainsCache(); // 顺带维持链配置缓存（TTL 闸控实际请求，fire-and-forget）
    refreshRouteRuntimeCache(); // 同上：路由链运行时态（路由链卡当前跳/倒计时数据源）
    try {
      const res = await api("GET", "/api/model-stability");
      const models = res && Array.isArray(res.models) ? res.models : [];
      msModelsCache = models;
      msModelsCacheVer += 1; // B1：灯色数据源变了，卡片指纹须失配
      renderModelStability(models, res && res.generatedAt);
    } catch {
      if (!list.childElementCount) {
        if (emptyEl) { emptyEl.hidden = false; emptyEl.textContent = "近 8h 暂无调用记录"; }
      }
    }
  }

  function renderModelStability(models, generatedAt) {
    const list = $("msList");
    const emptyEl = $("msEmpty");
    if (!list) return;
    const has = models && models.some((m) => m.total > 0);
    if (emptyEl) emptyEl.hidden = !!has;
    list.textContent = "";
    if (!has) return;
    const now = generatedAt || Date.now();
    models.forEach((m, idx) => {
      const st = m.status || "gray";
      const rateTxt = m.total ? Number(m.successRate).toFixed(1) + "%" : "—";
      const key = (m.provider || "") + "/" + m.model;
      const item = document.createElement("div");
      item.className = "ms-item" + (msOpen.has(key) ? " open" : "");

      const info = document.createElement("div");
      info.className = "ms-info";
      const row1 = document.createElement("div");
      row1.className = "ms-row";
      const rank = document.createElement("span");
      rank.className = "ms-rank" + (idx === 0 ? " top" : "");
      rank.textContent = String(idx + 1);
      const name = document.createElement("span");
      name.className = "ms-name";
      name.textContent = m.model;
      name.title = m.model + " @ " + m.provider + " · 8h " + m.total + " 次";
      const tail = document.createElement("span");
      tail.className = "ms-tail";
      const lamp = document.createElement("i");
      lamp.className = "lamp lamp-" + (st === "green" ? "green" : st === "yellow" ? "yellow" : st === "red" ? "red" : "gray");
      const rate = document.createElement("span");
      rate.className = "ms-rate " + (st === "green" ? "g" : st === "yellow" ? "y" : st === "red" ? "r" : "");
      rate.textContent = rateTxt;
      const chev = document.createElement("span");
      chev.className = "ms-chevron";
      chev.textContent = "▸";
      tail.appendChild(lamp); tail.appendChild(rate); tail.appendChild(chev);
      row1.appendChild(rank); row1.appendChild(name); row1.appendChild(tail);

      const row2 = document.createElement("div");
      row2.className = "ms-row";
      const prov = document.createElement("span");
      // 号池行（后端按 pools 富化）：注释显示号池名（正常灰字），后跟紫色「号池」小标注
      const isPoolRow = typeof m.poolName === "string" && m.poolName.length > 0;
      prov.className = "ms-prov";
      prov.textContent = isPoolRow ? m.poolName : (m.provider || "");
      row2.appendChild(prov);
      if (isPoolRow) {
        const note = document.createElement("span");
        note.className = "ms-prov-note";
        note.textContent = "号池";
        note.title = m.memberName
          ? `号池 ${m.poolId} · 成员渠道 ${m.memberName}`
          : `号池 ${m.poolId}`;
        row2.appendChild(note);
      }
      const mid = document.createElement("span");
      mid.className = "ms-mid";
      mid.title = "近8h 平均延迟 / 缓存命中率";
      mid.innerHTML = '<span class="k">延迟</span> <span class="v">' + fmtLatency(m.latencyMs) + '</span>' +
        '<span class="k">缓存</span> <span class="v">' + (m.cacheHit != null ? m.cacheHit + "%" : "—") + "</span>";
      row2.appendChild(mid);
      info.appendChild(row1); info.appendChild(row2);
      item.appendChild(info);

      const cells = document.createElement("div");
      cells.className = "ms-cells";
      cells.hidden = !msOpen.has(key);
      const arr = Array.isArray(m.cells) ? m.cells : [];
      const lastIdx = arr.length - 1;
      arr.forEach((c, ci) => {
        const el = document.createElement("i");
        el.className = "ms-cell";
        if (!c || !c.n) el.classList.add("idle");
        else {
          if (c.status === "yellow") el.classList.add("mid");
          else if (c.status === "red") el.classList.add("bad");
          const rate = Number(c.rate) || 0;
          el.style.height = (4 + Math.round((rate / 100) * 18)) + "px";
        }
        const end = now - (lastIdx - ci) * 10 * 60 * 1000;
        el.title = c && c.n
          ? fmtMsClock(end - 600000) + "–" + fmtMsClock(end) + " · " + c.n + " 次 · " + Number(c.rate).toFixed(1) + "%"
          : fmtMsClock(end - 600000) + "–" + fmtMsClock(end) + " · 无调用";
        cells.appendChild(el);
      });
      item.appendChild(cells);
      info.addEventListener("click", () => {
        const open = cells.hidden;
        cells.hidden = !open;
        item.classList.toggle("open", open);
        if (open) msOpen.add(key); else msOpen.delete(key);
      });
      list.appendChild(item);
    });
  }

  function applyFaultBanner(agent, bannerEl, msgEl, timeEl) {
    if (!bannerEl || !msgEl || !timeEl) return;
    const activeErrors = Array.isArray(agent.activeErrors) ? agent.activeErrors : null;
    let faults = null;
    if (activeErrors) {
      if (agent.errorActive && activeErrors.length > 0) faults = activeErrors;
    } else if (typeof agent.errorActive === "boolean") {
      if (agent.errorActive && agent.lastError) faults = [agent.lastError];
    }
    if (!faults || faults.length === 0) {
      bannerEl.hidden = true;
      return;
    }
    bannerEl.hidden = false;
    msgEl.textContent = faults.map((f) => {
      const model = f.model ? ` · ${f.model}` : "";
      return `HTTP ${f.status || 500}${model}`;
    }).join(" · ");
    const latest = faults.reduce((a, b) => ((a.time || 0) >= (b.time || 0) ? a : b));
    timeEl.textContent = latest.time ? new Date(latest.time).toLocaleTimeString() : "刚刚";
  }

  function renderZcode(z) {
    const stateBadge = $("zcStateBadge");
    const modelBadgesList = $("zcModelBadgesList");
    const errorBanner = $("zcErrorBanner");
    const empty = $("zcEmpty");
    const metricsBlock = $("zcMetricsBlock");

    if (modelBadgesList) renderModelBadges(modelBadgesList, "zcode", z);

    applyFaultBanner(z, errorBanner, $("zcErrorMsg"), $("zcErrorTime"));
    stateBadge.closest(".panel-card").classList.toggle("card-collapsed", z.status !== "running");

    if (z.status === "running") {
      empty.hidden = true;
      metricsBlock.hidden = false;
      const isGenerating = (z.metrics && z.metrics.activeRequests > 0) || (z.activeRequests > 0);
      stateBadge.className = isGenerating ? "badge badge-ok" : "badge badge-neutral";
      stateBadge.textContent = isGenerating ? "生成中" : "待命";

      const m = z.metrics || {};
      const sess = (z.sessions && z.sessions[0]) || {};
      // 陈旧端点：速率类置 —、压暗、折线停绘，简要栏换相对时间胶囊；工时等累计量不动。
      const stale = isEndpointStale(z, isGenerating);
      endpointStaleFlags.zc = stale;
      dimEndpointRateCards("zc", stale);
      const ttft = m.lastTtftMs || z.lastTtftMs;
      if (!stale && typeof ttft === "number" && ttft > 0) {
        $("zcTtftVal").textContent = (ttft / 1000).toFixed(2);
        $("zcTtftUnit").textContent = "s";
        const color = m.ttftColor || "green";
        $("zcTtftLamp").className = "lamp lamp-" + color;
      } else {
        $("zcTtftVal").textContent = "-";
        $("zcTtftLamp").className = "lamp lamp-gray";
      }

      const tps = m.tps !== undefined ? m.tps : z.tps;
      $("zcTpsVal").textContent = (!stale && typeof tps === "number" && tps > 0) ? tps.toFixed(1) : "-";

      const hit = m.cacheHitRate !== undefined ? m.cacheHitRate : z.cacheHitRate;
      $("zcCacheVal").textContent = (!stale && typeof hit === "number") ? hit.toFixed(1) : "-";

      const dur = m.activeDurationMs || z.activeDurationMs;
      $("zcDurationVal").textContent = formatDurationSeconds(dur);

      const tokens = m.tokens || sess.tokens || {};
      updateDetailBrief("zc", {
        isGenerating,
        ttft: (typeof ttft === "number" && ttft > 0) ? ttft : null,
        ttftColor: m.ttftColor || "green",
        tps: (typeof tps === "number" && tps > 0) ? tps : null,
        hit: (typeof hit === "number") ? hit : null,
        durationText: formatDurationSeconds(dur),
        staleText: stale ? formatRelativeAge(sess.lastSeen) : null,
        requests: m.totalRequests || z.totalRequests || 0,
        tokensText: `Prompt: ${formatTokens(tokens.prompt)} · Completion: ${formatTokens(tokens.completion)} · Cached: ${formatTokens(tokens.cached)}`,
      });

      if (!stale) {
        pushMetricPoint("ttft", typeof ttft === "number" ? ttft / 1000 : null, m.sparkHistory?.ttft);
        pushMetricPoint("tps", tps, m.sparkHistory?.tps);
        pushMetricPoint("cache", hit, m.sparkHistory?.cache);

        redrawEndpointSparklines("zc");
      }

      $("zcSessionTokens").textContent = `Prompt: ${formatTokens(tokens.prompt)} · Completion: ${formatTokens(tokens.completion)} · Cached: ${formatTokens(tokens.cached)}`;
      $("zcSessionReqs").textContent = `${m.totalRequests || z.totalRequests || 0} 次请求`;

      const activeTag = $("zcActiveTag");
      if (isGenerating) {
        activeTag.hidden = false;
      } else {
        activeTag.hidden = true;
      }

      const activeList = z.activeModels || (z.currentModel ? [z.currentModel] : []);
      const lastModelTag = $("zcLastModelTag");
      if (activeList.length > 0) {
        lastModelTag.textContent = "模型: " + activeList.join(", ");
      } else if (z.lastModel) {
        lastModelTag.textContent = "模型: " + z.lastModel;
      } else {
        lastModelTag.textContent = "模型: 待命";
      }
    } else {
      stateBadge.className = "badge badge-neutral";
      stateBadge.textContent = "未运行";
      empty.hidden = false;
      metricsBlock.hidden = true;
    }
  }

  function renderClaude(c) {
    const modelBadgesList = $("ccModelBadgesList");
    const errorBanner = $("ccErrorBanner");
    const empty = $("ccEmpty");
    const block = $("ccSessionsBlock");
    const list = $("ccSessionsList");

    if (modelBadgesList) renderModelBadges(modelBadgesList, "claude", c);

    // Claude telemetry is per-session: aggregate every session's active fault
    // into one banner so an upstream error surfaces here the same way it does
    // on the aggregate endpoints.
    // Claude exposes the same instance contract as Kimi. `sessions` remains
    // a compatibility field for older relay snapshots only.
    const sessions = Array.isArray(c.instances) ? c.instances : (c.sessions || []);
    const activeFaults = sessions.filter((s) => s.errorActive && s.lastError).map((s) => s.lastError);
    applyFaultBanner(
      { errorActive: activeFaults.length > 0, activeErrors: activeFaults },
      errorBanner,
      $("ccErrorMsg"),
      $("ccErrorTime"),
    );

    empty.closest(".panel-card").classList.toggle("card-collapsed", c.status !== "running");

    if (c.status === "running") {
      setInstanceCount("cc", sessions.length);
      empty.hidden = true;
      block.hidden = false;

      // 实例按行排列：无实例时用会话求和派生的聚合量渲染一行「全局汇总」伪实例行，
      // 收起态不为空；静态「全局汇总」行的门控/展开规则与其他多实例栏一致。
      // showSurface：桌面形态收敛成的 claude-desktop 行贴一枚 Desktop 徽标
      //（与 kimi 行徽标同一渲染位、同一 token），逐 PID 行无徽标不变。
      const isGenerating = sessions.some((s) => s.activeRequests > 0 || s.status === "active");
      const agg = claudeAggregateMetrics(sessions, c.retiredMetrics);
      renderInstanceRows({ prefix: "cc", listEl: list, instances: sessions, showSurface: true, aggregateFallback: buildAggregateFallback(agg, c, isGenerating) });
      applyDetailFold("cc");
      gateAggregateRow("cc", $("ccSessionRow"), sessions.length);

      $("ccSessionTokens").textContent = `Prompt: ${formatTokens(agg.tokens.prompt)} · Completion: ${formatTokens(agg.tokens.completion)} · Cached: ${formatTokens(agg.tokens.cached)}`;
      $("ccSessionReqs").textContent = `${agg.totalRequests} 次请求`;

      $("ccActiveTag").hidden = !isGenerating;

      const ccLastModelTag = $("ccLastModelTag");
      // 卡头与胶囊同源：胶囊能显示什么，卡头就显示什么（虚拟模型 auto 已被
      // capsuleTargetList 过滤掉），两者不会各说各话。没有可展示身份时按既有
      // 语义显示「待命」。
      const capsuleLabels = capsuleTargetList(c).map((t) => capsuleLabel(t.providerId, t.model));
      if (capsuleLabels.length > 0) {
        ccLastModelTag.textContent = "模型: " + capsuleLabels.join(", ");
      } else {
        ccLastModelTag.textContent = "模型: 待命";
      }
      renderSurfaceSummary("cc", c.surfaces);
    } else {
      setInstanceCount("cc", 0);
      empty.hidden = false;
      block.hidden = true;
      // 停止态必须显式清掉副行：卡收起时 CSS 不藏徽标，脏值会一直挂到下一轮
      // running 刷新（DSH / Kimi 同一处置）。
      renderSurfaceSummary("cc", []);
    }
  }

  // 端点卡分面副行："Web ×1 · TUI ×2"。只有进程扫描能在第一条请求之前分辨面
  // （DSH 的 web 与 TUI 在请求面上同像：同一条 x-agent-id: dsh；Kimi 的终端、
  // web 与桌面端同理共用同一条 kimi 归属），后端读不出面的那一档按「未知 ×n」
  // 如实显示，所以副行加总恒等于卡上的进程数。徽标位只放界面形态，读不出就是
  // 「未知」，不拿产品名顶替——与后端 DSH_SURFACE_LABELS / KIMI_SURFACE_LABELS
  // 同一口径，显示名一律由后端下发。
  function renderSurfaceSummary(prefix, surfaces) {
    const el = $(`${prefix}SurfaceSummary`);
    if (!el) return;
    const rows = (Array.isArray(surfaces) ? surfaces : []).filter((s) => s && s.count > 0);
    if (rows.length === 0) {
      el.hidden = true;
      el.textContent = "";
      return;
    }
    el.hidden = false;
    el.textContent = rows.map((s) => `${s.label ?? s.profile ?? "未知"} ×${s.count}`).join(" · ");
  }

  function renderDsh(d) {
    const stateBadge = $("dshStateBadge");
    const modelBadgesList = $("dshModelBadgesList");
    const errorBanner = $("dshErrorBanner");
    const empty = $("dshEmpty");
    const metricsBlock = $("dshMetricsBlock");

    if (modelBadgesList) renderModelBadges(modelBadgesList, "dsh", d);

    applyFaultBanner(d, errorBanner, $("dshErrorMsg"), $("dshErrorTime"));
    stateBadge.closest(".panel-card").classList.toggle("card-collapsed", d.status !== "running");

    if (d.status === "running") {
      empty.hidden = true;
      metricsBlock.hidden = false;
      const isGenerating = (d.metrics && d.metrics.activeRequests > 0) || (d.activeRequests > 0);
      stateBadge.className = isGenerating ? "badge badge-ok" : "badge badge-neutral";
      stateBadge.textContent = isGenerating ? "生成中" : "待命";

      const m = d.metrics || {};
      const sess = (d.sessions && d.sessions[0]) || {};
      const tokens = m.tokens || sess.tokens || {};

      // 实例行：一行 = 一个 DSH 进程（一个 web 进程一行、每个 TUI 终端一行），
      // 行上的面徽标取后端从该进程命令行读出的 profile 名。
      // 不传 aggregateFallback：running 必有引擎占位行，零实例只在 stopped
      // 时整块 metricsBlock 隐藏。端点遥测由实例行与展开态「全局汇总」行
      // 承担——DSH 卡与其余多实例卡同构（端点四宫格/简要栏已摘除）。
      const instances = Array.isArray(d.instances) ? d.instances : [];
      const instancesWrap = $("dshInstancesWrapper");
      setInstanceCount("dsh", instances.length);
      if (instancesWrap) instancesWrap.hidden = instances.length === 0;
      renderInstanceRows({ prefix: "dsh", listEl: $("dshInstancesList"), instances, showSurface: true });
      renderSurfaceSummary("dsh", d.surfaces);
      applyDetailFold("dsh");
      gateAggregateRow("dsh", $("dshSessionRow"), instances.length);

      $("dshSessionTokens").textContent = `Prompt: ${formatTokens(tokens.prompt)} · Completion: ${formatTokens(tokens.completion)} · Cached: ${formatTokens(tokens.cached)}`;
      $("dshSessionReqs").textContent = `${m.totalRequests || d.totalRequests || 0} 次请求`;

      const activeTag = $("dshActiveTag");
      if (isGenerating) {
        activeTag.hidden = false;
      } else {
        activeTag.hidden = true;
      }

      const activeList = d.activeModels || (d.currentModel ? [d.currentModel] : []);
      const lastModelTag = $("dshLastModelTag");
      if (activeList.length > 0) {
        lastModelTag.textContent = "模型: " + activeList.join(", ");
      } else if (d.lastModel) {
        lastModelTag.textContent = "模型: " + d.lastModel;
      } else {
        lastModelTag.textContent = "模型: 待命";
      }
    } else {
      stateBadge.className = "badge badge-neutral";
      stateBadge.textContent = "未运行";
      setInstanceCount("dsh", 0);
      const instancesWrap = $("dshInstancesWrapper");
      if (instancesWrap) instancesWrap.hidden = true;
      renderSurfaceSummary("dsh", []);
      empty.hidden = false;
      metricsBlock.hidden = true;
    }
  }

  function renderPi(p) {
    const modelBadgesList = $("piModelBadgesList");
    const errorBanner = $("piErrorBanner");
    const empty = $("piEmpty");
    const metricsBlock = $("piMetricsBlock");

    if (modelBadgesList) renderModelBadges(modelBadgesList, "pi", p);

    applyFaultBanner(p, errorBanner, $("piErrorMsg"), $("piErrorTime"));
    empty.closest(".panel-card").classList.toggle("card-collapsed", p.status !== "running");

    if (p.status === "running") {
      empty.hidden = true;
      metricsBlock.hidden = false;
      const isGenerating = (p.metrics && p.metrics.activeRequests > 0) || (p.activeRequests > 0);

      const m = p.metrics || {};
      const sess = (p.sessions && p.sessions[0]) || {};
      const tokens = m.tokens || sess.tokens || {};

      // 实例按行排列：无实例时用端点聚合量渲染一行「全局汇总」伪实例行，收起态不为空
      const instances = Array.isArray(p.instances) ? p.instances : [];
      setInstanceCount("pi", instances.length);
      renderInstanceRows({ prefix: "pi", listEl: $("piInstancesList"), instances, aggregateFallback: buildAggregateFallback(m, p, isGenerating) });
      applyDetailFold("pi");
      gateAggregateRow("pi", $("piSessionRow"), instances.length);

      $("piSessionTokens").textContent = `Prompt: ${formatTokens(tokens.prompt)} · Completion: ${formatTokens(tokens.completion)} · Cached: ${formatTokens(tokens.cached)}`;
      $("piSessionReqs").textContent = `${m.totalRequests || p.totalRequests || 0} 次请求`;

      const activeTag = $("piActiveTag");
      if (isGenerating) {
        activeTag.hidden = false;
      } else {
        activeTag.hidden = true;
      }

      const activeList = p.activeModels || (p.currentModel ? [p.currentModel] : []);
      const lastModelTag = $("piLastModelTag");
      if (activeList.length > 0) {
        lastModelTag.textContent = "模型: " + activeList.join(", ");
      } else if (p.lastModel) {
        lastModelTag.textContent = "模型: " + p.lastModel;
      } else {
        lastModelTag.textContent = "模型: 待命";
      }
    } else {
      setInstanceCount("pi", 0);
      empty.hidden = false;
      metricsBlock.hidden = true;
    }
  }

  function renderQoder(p) {
    const stateBadge = $("qoderStateBadge");
    const modelBadgesList = $("qoderModelBadgesList");
    const errorBanner = $("qoderErrorBanner");
    const empty = $("qoderEmpty");
    const metricsBlock = $("qoderMetricsBlock");

    if (modelBadgesList) renderModelBadges(modelBadgesList, "qoder", p);

    applyFaultBanner(p, errorBanner, $("qoderErrorMsg"), $("qoderErrorTime"));
    stateBadge.closest(".panel-card").classList.toggle("card-collapsed", p.status !== "running");

    if (p.status === "running") {
      empty.hidden = true;
      metricsBlock.hidden = false;
      const isGenerating = (p.metrics && p.metrics.activeRequests > 0) || (p.activeRequests > 0);
      stateBadge.className = isGenerating ? "badge badge-ok" : "badge badge-neutral";
      stateBadge.textContent = isGenerating ? "生成中" : "待命";

      const m = p.metrics || {};
      const sess = (p.sessions && p.sessions[0]) || {};
      // 陈旧端点：速率类置 —、压暗、折线停绘，简要栏换相对时间胶囊；工时等累计量不动。
      const stale = isEndpointStale(p, isGenerating);
      endpointStaleFlags.qoder = stale;
      dimEndpointRateCards("qoder", stale);
      const ttft = m.lastTtftMs || p.lastTtftMs;
      if (!stale && typeof ttft === "number" && ttft > 0) {
        $("qoderTtftVal").textContent = (ttft / 1000).toFixed(2);
        $("qoderTtftUnit").textContent = "s";
        const color = m.ttftColor || "green";
        $("qoderTtftLamp").className = "lamp lamp-" + color;
      } else {
        $("qoderTtftVal").textContent = "-";
        $("qoderTtftLamp").className = "lamp lamp-gray";
      }

      const tps = m.tps !== undefined ? m.tps : p.tps;
      $("qoderTpsVal").textContent = (!stale && typeof tps === "number" && tps > 0) ? tps.toFixed(1) : "-";

      const hit = m.cacheHitRate !== undefined ? m.cacheHitRate : p.cacheHitRate;
      $("qoderCacheVal").textContent = (!stale && typeof hit === "number") ? hit.toFixed(1) : "-";

      const dur = m.activeDurationMs || p.activeDurationMs;
      $("qoderDurationVal").textContent = formatDurationSeconds(dur);

      const tokens = m.tokens || sess.tokens || {};
      updateDetailBrief("qoder", {
        isGenerating,
        ttft: (typeof ttft === "number" && ttft > 0) ? ttft : null,
        ttftColor: m.ttftColor || "green",
        tps: (typeof tps === "number" && tps > 0) ? tps : null,
        hit: (typeof hit === "number") ? hit : null,
        durationText: formatDurationSeconds(dur),
        staleText: stale ? formatRelativeAge(sess.lastSeen) : null,
        requests: m.totalRequests || p.totalRequests || 0,
        tokensText: `Prompt: ${formatTokens(tokens.prompt)} · Completion: ${formatTokens(tokens.completion)} · Cached: ${formatTokens(tokens.cached)}`,
      });

      if (!stale) {
        pushMetricPoint("qoder_ttft", typeof ttft === "number" ? ttft / 1000 : null, m.sparkHistory?.ttft);
        pushMetricPoint("qoder_tps", tps, m.sparkHistory?.tps);
        pushMetricPoint("qoder_cache", hit, m.sparkHistory?.cache);

        redrawEndpointSparklines("qoder");
      }

      $("qoderSessionTokens").textContent = `Prompt: ${formatTokens(tokens.prompt)} · Completion: ${formatTokens(tokens.completion)} · Cached: ${formatTokens(tokens.cached)}`;
      $("qoderSessionReqs").textContent = `${m.totalRequests || p.totalRequests || 0} 次请求`;

      const activeTag = $("qoderActiveTag");
      if (isGenerating) {
        activeTag.hidden = false;
      } else {
        activeTag.hidden = true;
      }

      const activeList2 = p.activeModels || (p.currentModel ? [p.currentModel] : []);
      const lastModelTag = $("qoderLastModelTag");
      if (activeList2.length > 0) {
        lastModelTag.textContent = "模型: " + activeList2.join(", ");
      } else if (p.lastModel) {
        lastModelTag.textContent = "模型: " + p.lastModel;
      } else {
        lastModelTag.textContent = "模型: 待命";
      }
    } else {
      stateBadge.className = "badge badge-neutral";
      stateBadge.textContent = "未运行";
      empty.hidden = false;
      metricsBlock.hidden = true;
    }
  }

  function renderCodex(p) {
    const modelBadgesList = $("codexModelBadgesList");
    const errorBanner = $("codexErrorBanner");
    const empty = $("codexEmpty");
    const metricsBlock = $("codexMetricsBlock");

    if (modelBadgesList) renderModelBadges(modelBadgesList, "codex", p);

    applyFaultBanner(p, errorBanner, $("codexErrorMsg"), $("codexErrorTime"));
    empty.closest(".panel-card").classList.toggle("card-collapsed", p.status !== "running");

    if (p.status === "running") {
      empty.hidden = true;
      metricsBlock.hidden = false;
      const isGenerating = (p.metrics && p.metrics.activeRequests > 0) || (p.activeRequests > 0);

      const m = p.metrics || {};
      const sess = (p.sessions && p.sessions[0]) || {};
      const tokens = m.tokens || sess.tokens || {};

      // 实例按行排列：无实例时用端点聚合量渲染一行「全局汇总」伪实例行，收起态不为空
      const instances = Array.isArray(p.instances) ? p.instances : [];
      setInstanceCount("codex", instances.length);
      renderInstanceRows({ prefix: "codex", listEl: $("codexInstancesList"), instances, aggregateFallback: buildAggregateFallback(m, p, isGenerating) });
      applyDetailFold("codex");
      gateAggregateRow("codex", $("codexSessionRow"), instances.length);

      $("codexSessionTokens").textContent = `Prompt: ${formatTokens(tokens.prompt)} · Completion: ${formatTokens(tokens.completion)} · Cached: ${formatTokens(tokens.cached)}`;
      $("codexSessionReqs").textContent = `${m.totalRequests || p.totalRequests || 0} 次请求`;

      const activeTag = $("codexActiveTag");
      if (isGenerating) {
        activeTag.hidden = false;
      } else {
        activeTag.hidden = true;
      }

      const activeList = p.activeModels || (p.currentModel ? [p.currentModel] : []);
      const lastModelTag = $("codexLastModelTag");
      if (activeList.length > 0) {
        lastModelTag.textContent = "模型: " + activeList.join(", ");
      } else if (p.lastModel) {
        lastModelTag.textContent = "模型: " + p.lastModel;
      } else {
        lastModelTag.textContent = "模型: 待命";
      }
    } else {
      setInstanceCount("codex", 0);
      empty.hidden = false;
      metricsBlock.hidden = true;
    }
  }

  function renderKimi(p) {
    const modelBadgesList = $("kimiModelBadgesList");
    const errorBanner = $("kimiErrorBanner");
    const empty = $("kimiEmpty");
    const metricsBlock = $("kimiMetricsBlock");

    if (modelBadgesList) renderModelBadges(modelBadgesList, "kimi", p);

    applyFaultBanner(p, errorBanner, $("kimiErrorMsg"), $("kimiErrorTime"));
    empty.closest(".panel-card").classList.toggle("card-collapsed", p.status !== "running");

    if (p.status === "running") {
      empty.hidden = true;
      metricsBlock.hidden = false;
      const isGenerating = (p.metrics && p.metrics.activeRequests > 0) || (p.activeRequests > 0);

      const m = p.metrics || {};
      const sess = (p.sessions && p.sessions[0]) || {};
      const tokens = m.tokens || sess.tokens || {};

      // 实例按行排列：无实例时用端点聚合量渲染一行「全局汇总」伪实例行，收起态不为空
      // showSurface：与 DSH 同口径，行上贴这一进程所属界面的徽标（TUI / Web /
      // Desktop），徽标名由后端下发；聚合伪行不贴。
      const instances = Array.isArray(p.instances) ? p.instances : [];
      setInstanceCount("kimi", instances.length);
      renderInstanceRows({ prefix: "kimi", listEl: $("kimiInstancesList"), instances, showSurface: true, aggregateFallback: buildAggregateFallback(m, p, isGenerating) });
      renderSurfaceSummary("kimi", p.surfaces);
      $("kimiSessionTokens").textContent = `Prompt: ${formatTokens(tokens.prompt)} · Completion: ${formatTokens(tokens.completion)} · Cached: ${formatTokens(tokens.cached)}`;
      $("kimiSessionReqs").textContent = `${m.totalRequests || p.totalRequests || 0} 次请求`;

      const activeTag = $("kimiActiveTag");
      if (isGenerating) {
        activeTag.hidden = false;
      } else {
        activeTag.hidden = true;
      }

      const activeList2 = p.activeModels || (p.currentModel ? [p.currentModel] : []);
      const lastModelTag = $("kimiLastModelTag");
      if (activeList2.length > 0) {
        lastModelTag.textContent = "模型: " + activeList2.join(", ");
      } else if (p.lastModel) {
        lastModelTag.textContent = "模型: " + p.lastModel;
      } else {
        lastModelTag.textContent = "模型: 待命";
      }
      applyDetailFold("kimi");
      gateAggregateRow("kimi", $("kimiSessionRow"), instances.length);
    } else {
      empty.hidden = false;
      metricsBlock.hidden = true;
      setInstanceCount("kimi", 0);
      // 停止态必须显式清掉副行：卡收起时 CSS 不藏徽标，脏值会一直挂到下一轮
      // running 刷新（DSH 同一处置，见 renderDsh 的 else 分支）。
      renderSurfaceSummary("kimi", []);
    }
  }

  function renderGrok(p) {
    const modelBadgesList = $("grokModelBadgesList");
    const errorBanner = $("grokErrorBanner");
    const empty = $("grokEmpty");
    const metricsBlock = $("grokMetricsBlock");

    if (modelBadgesList) renderModelBadges(modelBadgesList, "grok", p);

    applyFaultBanner(p, errorBanner, $("grokErrorMsg"), $("grokErrorTime"));
    empty.closest(".panel-card").classList.toggle("card-collapsed", p.status !== "running");

    if (p.status === "running") {
      empty.hidden = true;
      metricsBlock.hidden = false;
      const isGenerating = (p.metrics && p.metrics.activeRequests > 0) || (p.activeRequests > 0);

      const m = p.metrics || {};
      const sess = (p.sessions && p.sessions[0]) || {};
      const tokens = m.tokens || sess.tokens || {};

      // 实例按行排列：无实例时用端点聚合量渲染一行「全局汇总」伪实例行，收起态不为空
      const instances = Array.isArray(p.instances) ? p.instances : [];
      setInstanceCount("grok", instances.length);
      renderInstanceRows({ prefix: "grok", listEl: $("grokInstancesList"), instances, aggregateFallback: buildAggregateFallback(m, p, isGenerating) });
      applyDetailFold("grok");
      gateAggregateRow("grok", $("grokSessionRow"), instances.length);

      $("grokSessionTokens").textContent = `Prompt: ${formatTokens(tokens.prompt)} · Completion: ${formatTokens(tokens.completion)} · Cached: ${formatTokens(tokens.cached)}`;
      $("grokSessionReqs").textContent = `${m.totalRequests || p.totalRequests || 0} 次请求`;

      const activeTag = $("grokActiveTag");
      if (isGenerating) {
        activeTag.hidden = false;
      } else {
        activeTag.hidden = true;
      }

      const activeList = p.activeModels || (p.currentModel ? [p.currentModel] : []);
      const lastModelTag = $("grokLastModelTag");
      if (activeList.length > 0) {
        lastModelTag.textContent = "模型: " + activeList.join(", ");
      } else if (p.lastModel) {
        lastModelTag.textContent = "模型: " + p.lastModel;
      } else {
        lastModelTag.textContent = "模型: 待命";
      }
    } else {
      setInstanceCount("grok", 0);
      empty.hidden = false;
      metricsBlock.hidden = true;
    }
  }

  function renderOpencode(p) {
    const modelBadgesList = $("opencodeModelBadgesList");
    const errorBanner = $("opencodeErrorBanner");
    const empty = $("opencodeEmpty");
    const metricsBlock = $("opencodeMetricsBlock");

    if (modelBadgesList) renderModelBadges(modelBadgesList, "opencode", p);

    applyFaultBanner(p, errorBanner, $("opencodeErrorMsg"), $("opencodeErrorTime"));
    empty.closest(".panel-card").classList.toggle("card-collapsed", p.status !== "running");

    if (p.status === "running") {
      empty.hidden = true;
      metricsBlock.hidden = false;
      const isGenerating = (p.metrics && p.metrics.activeRequests > 0) || (p.activeRequests > 0);

      const m = p.metrics || {};
      const sess = (p.sessions && p.sessions[0]) || {};
      const tokens = m.tokens || sess.tokens || {};
      $("opencodeSessionTokens").textContent = `Prompt: ${formatTokens(tokens.prompt)} · Completion: ${formatTokens(tokens.completion)} · Cached: ${formatTokens(tokens.cached)}`;
      $("opencodeSessionReqs").textContent = `${m.totalRequests || p.totalRequests || 0} 次请求`;

      const activeTag = $("opencodeActiveTag");
      if (isGenerating) {
        activeTag.hidden = false;
      } else {
        activeTag.hidden = true;
      }

      const activeList2 = p.activeModels || (p.currentModel ? [p.currentModel] : []);
      const lastModelTag = $("opencodeLastModelTag");
      if (activeList2.length > 0) {
        lastModelTag.textContent = "模型: " + activeList2.join(", ");
      } else if (p.lastModel) {
        lastModelTag.textContent = "模型: " + p.lastModel;
      } else {
        lastModelTag.textContent = "模型: 待命";
      }

      // 实例按行排列：无实例时用端点聚合量渲染一行「全局汇总」伪实例行，收起态不为空
      const instances = Array.isArray(p.instances) ? p.instances : [];
      setInstanceCount("opencode", instances.length);
      renderInstanceRows({ prefix: "opencode", listEl: $("opencodeInstancesList"), instances, aggregateFallback: buildAggregateFallback(m, p, isGenerating) });
      applyDetailFold("opencode");
      gateAggregateRow("opencode", $("opencodeSessionRow"), instances.length);
    } else {
      setInstanceCount("opencode", 0);
      empty.hidden = false;
      metricsBlock.hidden = true;
    }
  }

  // 实时 SSE 日志流
  const LOG_LINE_CAP = 25;
  let followLogs = true;
  // 运行日志开关的当前值。null = 还没问出来，此时不覆盖界面。
  let loggingEnabled = null;
  // 实时输出级别过滤的当前值。null = 还没问出来，此时不重连已有的流。
  let logLevel = null;

  // 换级别后重连一次：服务端按新门槛重放缓冲里最近 500 条，屏幕立刻换成筛过的结果，
  // 而不是等下一条新日志来证明这一项生效了。记录停着时没有流可重连，跳过。
  function restartLogStream() {
    if (loggingEnabled === false) return;
    if (es) { es.close(); es = null; }
    const body = $("logBody");
    if (body) body.innerHTML = "";
    connectLogStream();
  }

  // 级别的落地面。同值不动（进设置页会重读一次设置，不该每次都闪一下）；只有已经
  // 建着流时才重连——开屏那一次定态发生在建流之前，服务端按这一档重放即可。
  function applyLogLevel(level) {
    const sel = $("logLevelSelect");
    if (sel) sel.value = level;
    if (logLevel === level) return;
    logLevel = level;
    if (es) restartLogStream();
  }

  // 运行日志开关的落地面（开关本体在设置→通用）。「日志级别」是它的从属项：记录都
  // 停了，选级别没有意义，所以整段跟着一起收起，只藏控件、不重置已选值。
  function applyLoggingEnabled(enabled) {
    loggingEnabled = enabled;
    const card = $("liveLogCard");
    if (card) card.hidden = !enabled;
    const levelRows = $("logLevelRows");
    if (levelRows) levelRows.hidden = !enabled;
    if (enabled) {
      connectLogStream();
      return;
    }
    if (es) { es.close(); es = null; }
    const body = $("logBody");
    if (body) body.innerHTML = "";
  }

  // 页面加载时的入口：先问开关，再决定连不连流。这一问发生在开屏层还盖着的时候，
  // 所以不影响首屏；读不到就按默认开——日志是排障时唯一的凭据，一次读失败不该把它
  // 静默关掉。问的途中用户已经在设置页切过开关，就以那次为准，不被这次结果盖回。
  async function startLogStream() {
    // 滚动跟随只挂一次：贴底时自动跟随新日志，上翻查看旧日志即暂停，回到底部自动
    // 恢复。挂在开与关之外，反复切开关不会越积越多份监听。
    const body = $("logBody");
    body.addEventListener("scroll", () => {
      followLogs = body.scrollTop + body.clientHeight >= body.scrollHeight - 24;
    });
    // 真清空：服务端缓冲一并清掉，刷新不再复活旧日志，其它打开的面板窗口同步清空。
    $("clearLog").onclick = async () => {
      body.innerHTML = "";
      try { await api("POST", "/api/logs/clear"); } catch {}
    };
    let enabled = true;
    let level = "info";
    try {
      const d = await api("GET", "/api/settings");
      enabled = d?.settings?.loggingEnabled !== false;
      const saved = d?.settings?.logLevel;
      level = saved === "warn" || saved === "error" ? saved : "info";
    } catch { /* 按默认开 */ }
    // 先定级别再建流：门槛在重放那一刻就生效，窗口不会先把全量闪一遍再筛。
    if (logLevel === null) applyLogLevel(level);
    if (loggingEnabled === null) applyLoggingEnabled(enabled);
  }

  function connectLogStream() {
    if (es) return;
    es = new EventSource(API_BASE + "/api/logs");
    es.onopen = () => {
      $("logConn").textContent = "● 实时传输";
      $("logConn").className = "log-status live";
      $("logConnBadge").textContent = "● 在线";
      $("logConnBadge").className = "badge badge-ok";
    };
    es.onmessage = (e) => {
      try { handleLogEntry(JSON.parse(e.data)); } catch { appendLog({ level: "info", message: e.data }); }
    };
    es.onerror = () => {
      $("logConn").textContent = "○ 正在重连";
      $("logConn").className = "log-status";
      $("logConnBadge").textContent = "○ 重连";
      $("logConnBadge").className = "badge badge-warn";
    };
  }

  function handleLogEntry(entry) {
    if (entry && entry.type === "clear") {
      $("logBody").innerHTML = "";
      return;
    }
    appendLog(entry);
  }

  function appendLog(entry) {
    const body = $("logBody");
    const div = document.createElement("div");
    div.className = "log-line " + (entry.level || "info");
    const ts = entry.ts ? new Date(entry.ts).toLocaleTimeString() : "";
    div.innerHTML = `<span class="ts">${ts}</span><span class="lvl">${(entry.level || "info").toUpperCase()}</span> ${escapeHtml(entry.message || "")}`;
    body.appendChild(div);
    // 行数上限：只保留最新 LOG_LINE_CAP 行，页面长开也不会无限堆积 DOM。
    while (body.childElementCount > LOG_LINE_CAP) body.removeChild(body.firstChild);
    if (followLogs) body.scrollTop = body.scrollHeight;
  }

  // 开机自启
  async function loadAutostartState() {
    const t = $("autostartToggle");
    if (!t) return;
    try {
      const cached = localStorage.getItem("panel-autostart");
      if (cached !== null) t.checked = cached === "1" || cached === "true";
    } catch {}
    try {
      const d = await api("GET", "/api/autostart");
      t.checked = !!d.enabled;
      try { localStorage.setItem("panel-autostart", d.enabled ? "1" : "0"); } catch {}
    } catch {}

    t.onchange = async () => {
      const next = t.checked;
      t.disabled = true;
      try {
        const path = next ? "/api/autostart/enable" : "/api/autostart/disable";
        const d = await api("POST", path);
        if (!d.ok) {
          t.checked = !next;
          try { localStorage.setItem("panel-autostart", !next ? "1" : "0"); } catch {}
          toast("设置失败: " + (d.error || "未知错误"), true);
        } else {
          try { localStorage.setItem("panel-autostart", next ? "1" : "0"); } catch {}
          toast(next ? "已开启开机自启" : "已关闭开机自启");
        }
      } catch (e) {
        t.checked = !next;
        try { localStorage.setItem("panel-autostart", !next ? "1" : "0"); } catch {}
        toast(panelError(e, "请求失败"), true);
      } finally {
        t.disabled = false;
      }
    };
  }

  // 高级选项页的数据搬迁。导出与导入都只把「路径」交给后端，包体不过界面，
  // 所以十几 MB 的包也不受请求体上限影响。导入分两步：先读包回摘要与一次性
  // 票据，用户点「备份并导入」才写入；票据过期只能重选包，不做静默重试。
  // 结构沿用本页其它设置卡的写法：卡头右侧放动作按钮，卡体第一行是状态行、第二行是
  // 次要明细，需要独立控件的行用 .modal-item；状态色只由 data-tone 决定。
  function createDataBundleController({ request, doc, notify = () => {}, errorText = (err, fallback) => err?.code || fallback }) {
    const get = (id) => doc.getElementById(id);
    const exportBtn = get("dataExportBtn");
    const exportStatus = get("dataExportStatus");
    const exportMeta = get("dataExportMeta");
    const pickBtn = get("dataImportPickBtn");
    const summaryLine = get("dataImportSummary");
    const importMeta = get("dataImportMeta");
    const modal = get("dataImportModal");
    if (!exportBtn || !pickBtn || !modal) return { enter() {}, leave() {} };
    const modalSummary = get("dataImportModalSummary");
    const modalMeta = get("dataImportModalMeta");
    const modalError = get("dataImportModalError");
    const applyBtn = get("dataImportApplyBtn");
    const repoLine = get("dataSkillsRepoLine");
    const repoLabel = get("dataSkillsRepoLabel");
    const repoCheck = get("dataSkillsRepoCheck");
    const repoPath = get("dataSkillsRepoPath");
    const customItem = get("dataSkillsCustomItem");
    const customPathLine = get("dataSkillsCustomPath");
    const customPickBtn = get("dataSkillsCustomPickBtn");
    const customClearBtn = get("dataSkillsCustomClearBtn");
    const defaultItem = get("dataSkillsDefaultItem");
    const defaultPathLine = get("dataSkillsDefaultPath");
    const defaultPickBtn = get("dataSkillsDefaultPickBtn");

    let ticket = null;
    let preview = null;
    let customPath = null;
    let applyArmed = false;
    let busy = false;
    // 本卡文本分两种身份，复位规则不同——混为一谈就会出现「成功文案无限期挂着」：
    //   状态 = 卡面初始行。预览摘要与 Skills 落点选择都在弹窗里，不占卡面。
    //   结果 = 一次性回执。导出成功/失败、导入完成/失败、取消都是结果，必须有界：
    //          离开本页即回初值；若结果是用户离开期间才落地的，留到切回看过，再于
    //          下次离开复位（与渠道刷新小字的「等切回」同精神）。
    // 初值一律取 markup 里写的那份，不在这里另造文案，两边不会漂。
    const initial = {
      export: exportStatus.textContent,
      import: summaryLine.textContent,
    };
    let away = true;         // 卡片默认不可见：设置视图没打开时它不在屏上
    let awaitReturn = false; // 离开期间落了结果，留到用户切回看过再复位

    const baseName = (p) => String(p || "").split(/[\\/]/).filter(Boolean).pop() || "";
    const COUNT_LABELS = [
      ["providers", "渠道"], ["pools", "号池"], ["routingChains", "路由链"],
      ["presets", "预设"], ["skillDirs", "Skills"], ["credentials", "密钥"],
    ];
    const countsText = (counts = {}) =>
      COUNT_LABELS.filter(([k]) => typeof counts[k] === "number").map(([k, label]) => `${label} ${counts[k]}`).join(" · ");
    const timeText = (iso) => {
      if (!iso) return "时间未知";
      const d = new Date(iso);
      return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString();
    };
    // 状态行说这一步的结果（带色调），明细行摆数据（计数、路径、备份号）；
    // 空明细由 CSS 的 :empty 收起，不留空行。
    function show(el, tone, text) {
      el.textContent = text;
      if (tone) el.dataset.tone = tone;
      else delete el.dataset.tone;
    }
    function showMeta(el, text) { el.textContent = text ?? ""; }
    // 结果落地：人不在本页就置「等切回」，别让结果在没人看的时候被复位掉。
    function resultLanded() { if (away) awaitReturn = true; }
    // 复位结果：导出与导入都回 markup 初值。
    function resetResults() {
      show(exportStatus, "", initial.export);
      showMeta(exportMeta, "");
      show(summaryLine, "", initial.import);
      showMeta(importMeta, "");
    }
    function setBusy(on) {
      busy = on;
      exportBtn.disabled = on;
      pickBtn.disabled = on;
    }

    async function runExport() {
      if (busy) return;
      setBusy(true);
      show(exportStatus, "busy", "正在打包…");
      showMeta(exportMeta, "");
      try {
        const result = await request("POST", "/api/data/export-pick", {});
        if (result.cancelled) {
          show(exportStatus, "", "未选择导出位置");
          resultLanded();
          return;
        }
        const skipped = (result.skippedCredentials ?? []).length;
        show(exportStatus, "ok", `已导出 ${baseName(result.path)}`);
        showMeta(exportMeta, `${countsText(result.counts)}${skipped ? ` · ${skipped} 个密钥未取到` : ""}`);
        resultLanded();
        notify("导出完成", false);
      } catch (err) {
        show(exportStatus, "danger", errorText(err, "导出未完成"));
        showMeta(exportMeta, "");
        resultLanded();
      } finally {
        setBusy(false);
      }
    }

    // ── 导入：预览与落点选择全在弹窗里 ──────────────────────────
    // 「备份并导入」是双击确认：内置浏览器里 window.confirm 会卡死，第一击变红
    // 常驻（不自动复位），换包/改落点/取消/落定才解除。
    function disarmApply() {
      applyArmed = false;
      applyBtn.textContent = "备份并导入";
      applyBtn.classList.remove("btn-danger-armed");
    }
    function openModal() { modal.classList.add("show"); }
    // 取消/关闭 = 丢弃这次选择：票据作废（服务端留着等过期扫掉），卡面回初值。
    function closeModal() {
      modal.classList.remove("show");
      ticket = null;
      preview = null;
      customPath = null;
      disarmApply();
      show(summaryLine, "", initial.import);
      showMeta(importMeta, "");
    }

    // 自选位置与「导入到仓库」勾选互斥：自选一旦选到文件夹，勾选强制退出并锁定，
    // 再点弹报错；清除自选后勾选恢复默认打上。锁定不置 disabled——禁用的控件
    // 点不出任何反馈，用户只会以为坏了。
    const repoLocked = () => customPath != null;
    function syncRepoLock() { repoLine.classList.toggle("is-locked", repoLocked()); }
    function repoLockGuard(ev) {
      if (!repoLocked()) return;
      ev?.preventDefault?.();
      notify("已选择自选位置，与导入到仓库二选一；如需改回，请先清除自选位置", true);
    }

    function showPreview(result) {
      ticket = result.token ?? null;
      preview = result;
      customPath = null;
      disarmApply();
      applyBtn.disabled = !ticket;
      modalError.hidden = true;
      const from = result.sourceComputer ? `来自 ${result.sourceComputer} · ` : "";
      show(modalSummary, "", `已读取包内容：${from}${timeText(result.createdAt)}`);
      showMeta(modalMeta, countsText(result.counts));
      repoLine.hidden = true;
      customItem.hidden = true;
      defaultItem.hidden = true;
      if (result.includes?.skills && result.skillsRepoPath) {
        repoLine.hidden = false;
        customItem.hidden = false;
        repoPath.textContent = result.skillsRepoPath;
        repoCheck.checked = true;
        syncRepoLock();
        customPathLine.textContent = "尚未选择文件夹（不导入 Skills）";
        customClearBtn.hidden = true;
      } else if (result.includes?.skills) {
        defaultItem.hidden = false;
        defaultPathLine.textContent = result.skillsDefaultPath;
      }
      openModal();
    }

    async function runPick() {
      if (busy) return;
      setBusy(true);
      show(summaryLine, "busy", "正在读取包内容…");
      showMeta(importMeta, "");
      try {
        const result = await request("POST", "/api/data/import-pick", {});
        if (result.cancelled) {
          show(summaryLine, "", "未选择配置包");
          resultLanded();
          return;
        }
        show(summaryLine, "", initial.import);
        showPreview(result);
      } catch (err) {
        show(summaryLine, "danger", errorText(err, "包内容读取失败"));
        resultLanded();
      } finally {
        setBusy(false);
      }
    }

    async function runCustomPick() {
      try {
        const result = await request("POST", "/api/skills/repo/pick", {});
        if (result.cancelled || !result.path) return;
        customPath = result.path;
        customPathLine.textContent = customPath;
        customClearBtn.hidden = false;
        repoCheck.checked = false;
        syncRepoLock();
        disarmApply();
      } catch (err) {
        notify(errorText(err, "位置选择失败"), true);
      }
    }

    function runCustomClear() {
      customPath = null;
      customPathLine.textContent = "尚未选择文件夹（不导入 Skills）";
      customClearBtn.hidden = true;
      repoCheck.checked = true;
      syncRepoLock();
      disarmApply();
    }

    async function runDefaultPick() {
      try {
        const result = await request("POST", "/api/skills/repo/pick", {});
        if (result.cancelled || !result.path) return;
        defaultPathLine.textContent = result.path;
        disarmApply();
      } catch (err) {
        notify(errorText(err, "位置选择失败"), true);
      }
    }

    async function runApply() {
      if (busy || !ticket) return;
      if (!applyArmed) {
        applyArmed = true;
        applyBtn.textContent = "确认导入？再点一次";
        applyBtn.classList.add("btn-danger-armed");
        return;
      }
      disarmApply();
      const usedTicket = ticket;
      const usedPreview = preview;
      let decision = { skillsMode: "skip" };
      if (usedPreview?.includes?.skills) {
        if (usedPreview.skillsRepoPath) {
          decision = repoCheck.checked
            ? { skillsMode: "repo" }
            : customPath
              ? { skillsMode: "custom", skillsTarget: customPath }
              : { skillsMode: "skip" };
        } else {
          const shown = defaultPathLine.textContent;
          decision = shown === usedPreview.skillsDefaultPath
            ? { skillsMode: "default" }
            : { skillsMode: "custom", skillsTarget: shown };
        }
      }
      setBusy(true);
      applyBtn.disabled = true;
      applyBtn.textContent = "正在备份并导入…";
      modalError.hidden = true;
      try {
        // 业务失败（HTTP 200 + ok:false）由 api() 统一抛出并把服务端原文挂到 err.code，
        // 这里不再判一次 ok，否则重造出的 Error 会丢掉原文。
        const result = await request("POST", "/api/data/import-apply", { token: usedTicket, ...decision });
        // 「跟随 Coding Agent 启动」的登录自启或自愈进程没对齐回来时，数据已经换完，
        // 坏的是那一层：状态行仍报导入完成、只是转成提醒色，没跟上的具体是什么写进明细。
        const wd = result.watchdog;
        const reason = (r) => (r ? `（${r}）` : "");
        let note = "";
        if (wd && (wd.task === "failed" || wd.task === "unknown")) {
          note = `「跟随 Coding Agent 启动」已按包里的设置更新，但登录自启没跟着改，重启电脑后的行为可能和设置显示的不一致${reason(wd.reasons?.task)}。可以在设置里把它拨一次再拨回来重试。`;
        } else if (wd && (wd.process === "failed" || wd.process === "unknown")) {
          note = `「跟随 Coding Agent 启动」的开关已更新，但自愈进程没跟上${reason(wd.reasons?.process)}。当前实际行为可能和设置显示的不一致。`;
        }
        // Skills 落点结果如实进明细：落到哪、主仓库指向动没动、没导是为什么。
        const applied = result.applied ?? {};
        let summary = `导入完成 · 备份号 ${result.backupId}`;
        const metaParts = [countsText(result.counts)];
        if (applied.skills) {
          metaParts.push(`Skills 落到：${applied.skillsTarget}`);
          if (usedPreview?.skillsRepoPath && applied.skillsRepoChanged === false) metaParts.push("主仓库指向未变");
        } else if (usedPreview?.includes?.skills && applied.skillsSkippedReason) {
          summary += "（Skills 未导入）";
          metaParts.push(applied.skillsSkippedReason);
        }
        ticket = null;
        preview = null;
        customPath = null;
        modal.classList.remove("show");
        show(summaryLine, note ? "warn" : "ok",
          `${summary}${note ? "，但「跟随 Coding Agent 启动」没完全跟上" : ""}`);
        showMeta(importMeta, [...metaParts, note].filter(Boolean).join(" · "));
        resultLanded();
        notify(`导入完成，已备份为 ${result.backupId}`, false);
      } catch (err) {
        // 票据在服务端已一次性作废，留在弹窗里只能取消后重选包。
        const detail = errorText(err, "导入未完成");
        ticket = null;
        preview = null;
        applyBtn.disabled = true;
        modalError.hidden = false;
        show(modalError, "danger", detail);
        notify(detail, true);
      } finally {
        setBusy(false);
      }
    }

    exportBtn.onclick = runExport;
    pickBtn.onclick = runPick;
    applyBtn.onclick = runApply;
    get("dataImportModalClose").onclick = closeModal;
    get("dataImportModalCancel").onclick = closeModal;
    repoLabel.onclick = repoLockGuard;
    repoCheck.onclick = repoLockGuard;
    repoCheck.onchange = disarmApply;
    customPickBtn.onclick = runCustomPick;
    customClearBtn.onclick = runCustomClear;
    defaultPickBtn.onclick = runDefaultPick;
    // 初始显隐由控制器定，不靠 markup 上的 disabled：票据状态只有一处真相。
    setBusy(false);
    applyBtn.disabled = true; // 弹窗只能随预览打开，打开时才按票据放开
    // 视图作用域钩子，由设置页子 tab 机制调用（与「关于」的 enter/leave 同款）。
    // 离开时复位结果，但「离开期间才落地的结果」要留到用户切回看过。
    return {
      enter() { away = false; awaitReturn = false; },
      leave() { away = true; if (awaitReturn) return; resetResults(); },
    };
  }

  function createAboutController({ request, doc, now = () => Date.now(), notify = () => {}, schedule = setTimeout, cancelSchedule = clearTimeout }) {
    const get = (id) => doc.getElementById(id);
    const pending = new Map();
    const remoteCache = new Map();
    const rows = new Map();
    let active = false, environmentGen = 0, updateGen = 0;
    let appInfo = null, local = null, localAt = 0, update = null, updateAt = 0;
    let bleedingMode = false; // 先行轨道开关（进页从设置现读；渲染层只读它）
    let environmentTask = null, updateTask = null, localFailed = false;
    const products = {
      claude: ["anthropics/claude-code", "@anthropic-ai/claude-code"],
      codex: ["openai/codex", "@openai/codex"],
      opencode: ["anomalyco/opencode", "@opencode/cli"],
      pi: ["earendil-works/pi", "@earendil-works/pi-coding-agent"],
      kimi: ["MoonshotAI/kimi-code", "@moonshot-ai/kimi-code"],
      // dsh 的 CLI 入口是社区插件（npm @deepseek-harness-tui/dsh-tui），它的上游来源
      // 只有 npm 包页（与服务端 release-service 同源）。本体 harness 在关于页不单列
      // 来源，因此这里没有 dsh 条目。
      "dsh-tui": ["", "@deepseek-harness-tui/dsh-tui"],
      // 原生二进制没有公开仓库发布页，官方来源只有 npm 包页（与服务端 release-service 同源）。
      grok: ["", "@xai-official/grok"],
      "qoder-cli": ["", "@qoder-ai/qodercli"],
      zcode: [], qoder: [],
      // 桌面副形态的官方来源与主形态不同源：kimi 桌面端是独立仓库（仓库页照 github
      // 分支放行），claude 桌面端官方入口只有下载页（域名白名单在 safeLink）。
      "claude-desktop": [],
      "kimi-desktop": ["MoonshotAI/kimi-code-app", ""],
    };
    // 面板可代管「更新」的客户端：npm 全局包按包名重装最新版，Grok Build / Qoder CLI
    // 跑自身的升级命令。服务端 client-lifecycle.mjs 的 CLIENT_PACKAGES / NATIVE_CLIENTS
    // 才是权威，这里只决定按钮是否出现，两份清单的一致性由 client-lifecycle.test.mjs 钉住。
    const updatableClients = new Set(["claude", "codex", "opencode", "pi", "kimi", "dsh", "grok", "qoder"]);
    // 未安装时面板代为装包的客户端：只有 npm 全局包这一条路。zcode / qoder 是桌面应用，
    // 走官方更新渠道；Grok Build 未安装时只报未找到——从裸装起会把用户切进另一种安装
    // 形态，这件事不由关于页的一个按钮代劳。
    const installableClients = new Set(["claude", "codex", "opencode", "pi", "kimi", "dsh"]);
    function safeLink(raw, id) {
      try {
        const url = new URL(raw);
        if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
        const path = decodeURIComponent(url.pathname).replace(/\/$/, "");
        if (id === "app") return url.hostname === "github.com" && /^\/Aurora0134\/Anyswitch\/releases\/tag\/[^/]+$/.test(path) ? url.href : null;
        const [repo, pkg] = products[id] || [];
        if (url.hostname === "github.com" && repo && (path === `/${repo}` || path.startsWith(`/${repo}/releases`))) return url.href;
        if (url.hostname === "www.npmjs.com" && pkg && path === `/package/${pkg}`) return url.href;
        const hosts = id === "zcode" ? ["zcode.z.ai"]
          : id === "qoder" ? ["qoder.com", "www.qoder.com", "qoder.com.cn", "www.qoder.com.cn", "docs.qoder.com", "download.qoder.com.cn"]
          : id === "codex-desktop" ? ["apps.microsoft.com", "www.microsoft.com"]
          : id === "claude-desktop" ? ["claude.ai", "www.claude.ai"] : [];
        return hosts.includes(url.hostname) ? url.href : null;
      } catch { return null; }
    }
    function fetchOnce(path) {
      if (!pending.has(path)) {
        const task = Promise.resolve().then(() => request("GET", path)).finally(() => pending.delete(path));
        pending.set(path, task);
      }
      return pending.get(path);
    }
    function element(tag, className, text) {
      const node = doc.createElement(tag);
      node.className = className;
      if (text != null) node.textContent = text;
      return node;
    }
    function timeText(value) {
      if (!value) return "";
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? "" : date.toLocaleString("zh-CN", { hour12: false });
    }
    function busy(id, on, idle, working) {
      const button = get(id);
      button.disabled = on;
      button.textContent = on ? working : idle;
      button.setAttribute("aria-busy", String(on));
    }
    function validLocal(installation) {
      const version = installation.version;
      return installation.status === "found" && typeof version === "string" && /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version) ? version : null;
    }
    function cacheKey(installation) { return `${installation.remoteId}:${validLocal(installation) || ""}`; }

    // ── 客户端安装/更新（本地环境卡的动作位）──────────────────────────
    // 锁按客户端分：同一个客户端的两个 npm 全局安装会互相搬目录（服务端实测过会搬坏），
    // 所以每个客户端同一时间只跑一个任务；不同客户端各装各的包，可以并行，
    // 于是开着一个更新时其他行的按钮照常可点。
    // 任务在后台跑，这里持 runId 轮询；离开关于页就放弃轮询与本地标记，
    // 服务端会自己跑完，结果由重新检测兜底呈现。
    const lifecycleRuns = new Map(); // clientId -> { clientId, action, runId, poll }，每客户端至多一条
    let lifecycleGen = 0; // leave() 时 +1，丢弃迟到的轮询回调
    let lifecycleBatch = null; // { results }，批量更新进行中非 null；批量与单行整段时间互斥
    let lifecycleModalResolve = null;
    const lifecycleModalQueue = []; // 弹层是单例，同时到来的确认请求排队逐个弹
    // 该安装项当前能做什么：可更新 > 未安装可装；桌面应用、状态不明与不给装包的客户端不给动作。
    // kind "tui" 是 dsh 的终端插件：它跟着端点级更新一起走（对齐流程），因此放行
    // 更新分支；安装分支仍只认 CLI——插件未装不代装，首装形态不由这里决定。
    function installationAction(client, installation) {
      if (!installation || (installation.kind !== "cli" && installation.kind !== "tui")) return null;
      const remote = remoteCache.get(cacheKey(installation))?.data;
      if (remote?.state === "ok" && remote.version && validLocal(installation) && remote.comparison === "update_available") {
        return { kind: "update", version: remote.version };
      }
      if (installation.kind === "cli" && installation.status === "not_found" && installableClients.has(client.id)) return { kind: "install" };
      return null;
    }
    function clientName(id) { return local?.clients.find((client) => client.id === id)?.name || id; }
    function updateBatchButton() {
      const button = get("aboutUpdateAll");
      if (!button) return;
      const count = (local?.clients ?? []).filter((client) => updatableClients.has(client.id))
        .filter((client) => client.installations.some((installation) => installationAction(client, installation)?.kind === "update")).length;
      button.disabled = count === 0 || lifecycleRuns.size > 0 || Boolean(lifecycleBatch);
      button.textContent = lifecycleBatch ? "批量更新中…" : count > 0 ? `全部更新 (${count})` : "全部更新";
    }
    function clientUpdateModalPayload(names, many) {
      return {
        title: many ? `${names.length} 个客户端正在运行` : `${names[0]} 正在运行`,
        body: `${names.join("、")} 正在运行，更新可能失败或打断当前会话。建议先退出后再更新。`,
      };
    }
    function showLifecycleModal({ title, body, confirmLabel }) {
      get("clientUpdateModalTitle").textContent = title;
      get("clientUpdateModalBody").textContent = body;
      // 确认键跟随本次动作命名（下载/应用/更新），不沿用上一次弹层留下的字面。
      get("clientUpdateModalConfirm").textContent = confirmLabel || "仍要更新";
      get("clientUpdateModal").classList.toggle("show", true);
      return new Promise((resolve) => { lifecycleModalResolve = resolve; });
    }
    function showClientUpdateModal(names, many) {
      return showLifecycleModal(clientUpdateModalPayload(names, many));
    }
    // 弹层是单例：已经有一个确认在屏上时，后到的请求排队等它答完再弹，
    // 否则两个并发任务会互相覆盖对方的标题与按钮归属。
    function confirmClientUpdate(names, many) {
      if (lifecycleModalResolve) return new Promise((resolve) => { lifecycleModalQueue.push({ ...clientUpdateModalPayload(names, many), resolve }); });
      return showClientUpdateModal(names, many);
    }
    // 自更新与客户端更新共用同一只弹层；自更新是全局单飞，不会与单行更新并发争抢，
    // 排队只是防「弹层还开着时用户点了别的确认」的兜底。
    function confirmSelfUpdate(title, body, confirmLabel) {
      if (lifecycleModalResolve) return new Promise((resolve) => { lifecycleModalQueue.push({ title, body, confirmLabel, resolve }); });
      return showLifecycleModal({ title, body, confirmLabel });
    }
    function closeLifecycleModal(decision) {
      get("clientUpdateModal").classList.toggle("show", false);
      const resolve = lifecycleModalResolve;
      lifecycleModalResolve = null;
      if (resolve) resolve(decision);
      const next = lifecycleModalQueue.shift();
      if (next) void showLifecycleModal(next).then(next.resolve);
    }
    // 离开关于页：排队中的确认一律按取消作答，不留悬挂的 Promise 等着一个不会出现的弹层。
    function drainLifecycleModalQueue(decision) {
      while (lifecycleModalQueue.length) lifecycleModalQueue.shift().resolve(decision);
    }
    // 目标端点正在运行时更新，Windows 下在跑的 exe/cmd 被占用会让安装覆盖失败且打断会话；
    // agents 查询失败时跳过这层确认，由更新命令自身的报错兜底。
    async function runningClients(ids) {
      try {
        const data = await fetchOnce("/api/agents");
        const live = new Set((data?.agents ?? []).filter((agent) => agent?.id && agent.status === "running").map((agent) => agent.id));
        return ids.filter((id) => live.has(id));
      } catch { return []; }
    }
    function pollLifecycle(run, runId) {
      const gen = lifecycleGen;
      return new Promise((resolve, reject) => {
        const step = async () => {
          let status;
          try { status = await fetchOnce(`/api/environment/update/${encodeURIComponent(runId)}`); }
          catch { status = null; }
          if (!active || gen !== lifecycleGen) { reject(Object.assign(new Error("lifecycle abandoned"), { abandoned: true })); return; }
          run.poll = null;
          if (status?.state === "running") { run.poll = schedule(step, 1500); return; }
          if (!status) reject(new Error("lifecycle status unavailable"));
          else resolve(status);
        };
        void step();
      });
    }
    function reportLifecycleOutcome(status, id) {
      const name = clientName(id);
      if (status?.outcome === "updated") { notify(`${name} ${status.message}`, false); return; }
      let text = `${name}：${status?.message || "更新失败，请重新检测确认结果"}`;
      const detail = typeof status?.detail === "string" ? status.detail.split("\n").find(Boolean) : "";
      if (detail) text += `（${detail}）`;
      notify(text, true);
    }
    async function performLifecycleRun({ id, action }) {
      if (lifecycleRuns.has(id)) return { id, outcome: "skipped" };
      const run = { clientId: id, action, runId: null, poll: null };
      lifecycleRuns.set(id, run);
      renderLocal();
      updateBatchButton();
      try {
        const started = await request("POST", "/api/environment/update", { id, action });
        run.runId = started.runId;
        const status = await pollLifecycle(run, started.runId);
        reportLifecycleOutcome(status, id);
        return { id, outcome: status?.outcome ?? "unknown" };
      } catch (error) {
        if (!error?.abandoned) {
          if (error?.code === "busy") notify("已有更新任务在进行中，请等待完成后重试", true);
          else notify("更新失败，请重新检测确认结果", true);
        }
        return { id, outcome: "failed" };
      } finally {
        lifecycleRuns.delete(id);
        if (run.poll !== null) { cancelSchedule(run.poll); run.poll = null; }
        if (active) { renderLocal(); updateBatchButton(); }
      }
    }
    // 单个动作：只跟自己这行为敌——本行在跑就点不动，别人在跑不影响。
    async function updateClient(id, action) {
      if (lifecycleRuns.has(id) || lifecycleBatch) return;
      const running = await runningClients([id]);
      if (running.length && !(await confirmClientUpdate(running.map(clientName), false))) return;
      // 确认期间状态可能已变（等待排队弹层时别人先跑起来了），动手前再核一次
      if (lifecycleRuns.has(id) || lifecycleBatch) return;
      await performLifecycleRun({ id, action });
      if (active) await loadEnvironment(true);
    }
    // 批量：只挑「有新版本」的，不给未安装的客户端静默装机；一次确认后全部并行派出。
    // 服务端锁按客户端分（同客户端并发 409），不同客户端互不触碰对方的 npm 目录，
    // 本机隔离前缀实测过多客户端并发安装互不干扰，不限并发上限。
    // 批量与单行整段时间互斥：否则同一行会被批量与本行同时更新，那正是会互相搬目录的场景。
    async function startUpdateAll() {
      if (lifecycleRuns.size > 0 || lifecycleBatch) return;
      const targets = (local?.clients ?? []).filter((client) => updatableClients.has(client.id))
        .filter((client) => client.installations.some((installation) => installationAction(client, installation)?.kind === "update"))
        .map((client) => ({ id: client.id, action: "update" }));
      if (!targets.length) return;
      const running = await runningClients(targets.map((target) => target.id));
      if (running.length && !(await confirmClientUpdate(running.map(clientName), true))) return;
      if (lifecycleRuns.size > 0 || lifecycleBatch) return;
      lifecycleBatch = { results: [] };
      const batch = lifecycleBatch;
      updateBatchButton();
      // 各目标一任务直发并发跑；中途离开（lifecycleBatch 已置空）就不弹汇总，
      // 各任务自身的轮询、提示与解锁由 performLifecycleRun 自理，服务端照样跑完。
      const settled = await Promise.all(targets.map((target) => performLifecycleRun(target)));
      if (lifecycleBatch !== batch) return; // 中途离开关于页，批量收尾交给服务端与下次检测
      batch.results = settled;
      lifecycleBatch = null;
      const ran = batch.results.filter((result) => result.outcome !== "skipped");
      if (active) {
        const updated = ran.filter((result) => result.outcome === "updated").length;
        const failed = ran.length - updated;
        notify(failed ? `批量更新完成：${updated} 个成功，${failed} 个未生效` : `批量更新完成：${updated} 个客户端已更新`, failed > 0);
        updateBatchButton();
        await loadEnvironment(true);
      } else {
        updateBatchButton();
      }
    }
    // ── 自身更新（下载 → 应用）────────────────────────────────────────
    // 一键更新在服务端是一条流水线：确认弹层授权的就是「下载并应用」，worker
    // 下载核验通过后原地续跑应用段（autoApply），本页只负责在页时的进度渲染。
    // 应用段换装（ready-to-restart / waiting-panel）时 panel-host 会自杀换新，
    // 本页面借 anyswitch:self-update-swap 事件把恢复监视交给顶栏
    // （watchPanelHostComeBack），面板身份变化后整页刷新到新版。最终结论由
    // 刷新后的新页面经 /api/self-update/last 补显——不把「已更新到 X」画在
    // 旧版本号旁边。中途离开关于页只是放弃轮询，任务照跑；关于页之外的完成
    // 提示与换装接管由页面级观察者（handleSelfUpdateFrame）负责，与本页共用
    // 同一份已读标记（localStorage），全局恰好提示一次。
    // 自动下载（设置项）不带 autoApply，仍停在「已下载待应用」，按钮转「应用更新」。
    const SELF_UPDATE_PHASES = {
      staging: (target) => `正在下载 ${target}…`,
      installing: () => "正在应用更新…",
      "ready-to-restart": () => "正在重启 Relay…",
      "waiting-panel": () => "正在重启面板，页面即将自动恢复…",
    };
    let selfUpdateRun = null; // { runId, poll } 进行中的任务（下载或应用），全局单飞；一键任务由服务端 autoApply 跑完两步
    let selfUpdateStaged = null; // 已下载待应用的记录（active 查询的 staged 载荷）
    let selfUpdateLastOutcome = null; // 本次进页补显过的最终结论（防被检查更新盖掉）
    let selfUpdateAdopted = false; // enter() 时接回检查完成前，按钮先不出
    let selfUpdateGen = 0; // leave() 时 +1，丢弃迟到的轮询回调
    function renderSelfUpdateProgress(status) {
      const statusEl = get("aboutUpdateStatus");
      let phaseText = SELF_UPDATE_PHASES[status?.phase];
      // 换装恢复页（本页就是换装的产物）上，换装类相位早已发生——再播报「正在重启
      // Relay / 正在重启面板」是把已完成的事说成进行中，统一交代「正在完成更新」。
      if (window.panelStartupRestart && (status?.phase === "ready-to-restart" || status?.phase === "waiting-panel")) phaseText = () => "正在完成更新…";
      statusEl.textContent = phaseText ? phaseText(status?.targetVersion || "") : "更新进行中…";
      statusEl.dataset.tone = "";
      get("aboutUpdateTime").textContent = "";
      get("aboutSelfUpdate").hidden = true;
    }
    function renderSelfUpdateStaged() {
      if (!active || !selfUpdateStaged) return;
      const statusEl = get("aboutUpdateStatus");
      // 横幅文案以任务自报的结论为准（先行轨的落点是提交标识，稳定轨是版本号）；
      // 结论缺失时按记录里的目标兜底拼同一句式。
      statusEl.textContent = selfUpdateStaged.message || `已下载 ${selfUpdateStaged.targetVersion || ""}，应用后生效`;
      statusEl.dataset.tone = "";
      get("aboutUpdateTime").textContent = "";
      const btn = get("aboutSelfUpdate");
      btn.textContent = "应用更新";
      btn.hidden = false;
    }
    function renderSelfUpdateOutcome(status) {
      const wasDownload = status?.outcome === "downloaded";
      selfUpdateRun = null;
      if (!active) return;
      const statusEl = get("aboutUpdateStatus");
      if (wasDownload) {
        // 下载只是备好比特（自动下载调度落的单）：版本号保持现状，按钮转「应用
        // 更新」。一键任务不再途经这里——服务端 autoApply 原地续跑，同一 runId
        // 直达终态。
        selfUpdateStaged = status;
        renderSelfUpdateStaged();
        notify(status?.message || `已下载 ${status?.targetVersion || ""}，应用后生效`);
        return;
      }
      selfUpdateStaged = null;
      // 无刷新终态的本页交代：写已读标记，页面级观察者凭它不再重弹。「已更新到
      // X」的旧页面分支例外——它随即换新刷新，结论由新页面补显，那里才是写标
      // 记的地方（上面 panelStartupRestart 分支）。
      const markShown = () => {
        try { if (status?.runId) localStorage.setItem(`anyswitch:self-update-shown:${status.runId}`, "1"); } catch { /* 存档不可写：观察者可能再提示一次，可接受 */ }
      };
      if (status?.outcome === "updated") {
        get("aboutSelfUpdate").hidden = true;
        if (window.panelStartupRestart) {
          // 本页就是换装后的新页面（结局经接回的轮询落在这里）：直接显示最终结论，
          // 不存在「即将刷新」。同时记入已读，/last 补显通道不再为它重弹一次。
          selfUpdateLastOutcome = status;
          statusEl.textContent = status?.message || `已更新到 ${status?.targetVersion || ""}`;
          statusEl.dataset.tone = "ok";
          try { if (status?.runId) localStorage.setItem(`anyswitch:self-update-shown:${status.runId}`, "1"); } catch { /* 存档不可写：/last 会再补显一次 */ }
          if (status?.message) notify(status.message);
          return;
        }
        // 旧页面（本页发起的应用）：换装完成、页面随换新刷新在即，只交代「即将刷新」，
        // 版本结论交给新页面（上面那条分支），不与旧版本号同框。
        statusEl.textContent = "更新完成，页面即将刷新…";
        statusEl.dataset.tone = "ok";
        if (status?.message) notify(status.message);
        return;
      }
      const copy = {
        updated_pending_restart: status?.message || "新版本已安装，重启面板后生效",
        rolled_back: status?.message || "已恢复到更新前版本",
        failed: status?.message || "更新失败，请重新检查更新",
      };
      statusEl.textContent = copy[status?.outcome] || "更新已结束";
      statusEl.dataset.tone = status?.outcome === "updated_pending_restart" ? "" : "danger";
      get("aboutSelfUpdate").hidden = true;
      markShown();
      notify(copy[status?.outcome] || "更新已结束", true);
    }
    function pollSelfUpdate(runId, isApply) {
      const gen = selfUpdateGen;
      return new Promise((resolve, reject) => {
        let swapAnnounced = false;
        // 换装信号的武装条件：发起时就是应用任务，或轮询中见过记录翻到 apply。
        // 一键任务（autoApply）从 download 一路跑到 apply，若只看发起态，下载期
        // 一次落空轮询（网络抖动）就会被误判成面板退场、提前盖开屏。
        let sawApply = isApply;
        const step = async () => {
          let status;
          try { status = await fetchOnce(`/api/self-update/${encodeURIComponent(runId)}`); }
          catch { status = null; }
          if (!active || gen !== selfUpdateGen) { reject(Object.assign(new Error("self update abandoned"), { abandoned: true })); return; }
          if (status?.step === "apply" || status?.phase === "ready-to-restart" || status?.phase === "waiting-panel") sawApply = true;
          // 换装信号有两路：worker 自报 ready-to-restart / waiting-panel，或应用中轮询
          // 开始落空（面板已退场）。后者才是多数情况下真实的第一信号——服务端监听器
          // 在 ready-to-restart 落盘后一秒内就点火自退，1.5s 的页面轮询经常来不及看到
          // 那个相位，等看到相位再盖开屏就永远盖不上。
          // 终态帧不派：失败收场或 updated_pending_restart 的 done 记录也带着
          // waiting-panel 相位，在终态帧上派发会让恢复监视空等一次永远不会来的退场。
          // 重启恢复页（panelStartupRestart）不派换装事件：本页就是换装的产物，
          // 顶栏监视只会空等一次永远不会再来的身份变化，超时后谎报重启失败。
          const atSwap = status === null || status?.phase === "ready-to-restart" || status?.phase === "waiting-panel";
          const swapSignal = sawApply && atSwap && (status === null || status?.state === "running");
          if (swapSignal && !swapAnnounced && !window.panelStartupRestart) {
            swapAnnounced = true;
            doc.dispatchEvent(new CustomEvent("anyswitch:self-update-swap"));
          }
          if (status?.state === "running") { if (selfUpdateRun) selfUpdateRun.poll = schedule(step, 1500); return; }
          // 应用中的落空轮询按 1s 补：面板退场窗口就那么几秒，3s 一拍容易把开屏
          // 拖到换装快结束才盖上。
          if (!status) { if (selfUpdateRun) selfUpdateRun.poll = schedule(step, isApply ? 1000 : 3000); return; }
          resolve(status);
        };
        void step();
      });
    }
    function trackSelfUpdate(runId, targetVersion, firstPhase, isApply = false) {
      selfUpdateStaged = null;
      selfUpdateRun = { runId, poll: null };
      renderSelfUpdateProgress({ phase: firstPhase, targetVersion });
      void pollSelfUpdate(runId, isApply).then(renderSelfUpdateOutcome, () => {});
    }
    async function startSelfUpdate() {
      if (selfUpdateRun || !selfUpdateAdopted) return;
      // 目标标识按轨道取：先行轨是远端最新提交的标识，稳定轨是 release 版本号。
      // 确认与进度文案用同一份；服务端登记时自会以它自己的强制检查为准。
      const bleedingTrack = update?.track === "bleeding" && update.identity !== false;
      const target = bleedingTrack ? (update?.remoteCommit || "") : (update?.release?.version || "");
      if (!target) return;
      // 一键更新：一次确认覆盖下载与应用两步。下载不动任何运行中的东西，应用才打断
      // 服务——重启提示是底线，有在跑 Agent 时把中断警示叠加上去，两条都要让用户看到。
      let warning = `将自动下载并应用新版本 ${target}：下载不影响当前使用，应用期间面板与 Relay 会自动重启，服务中断几秒钟。`;
      try {
        const data = await fetchOnce("/api/agents");
        const running = (data?.agents ?? []).filter((agent) => agent?.id && agent.status === "running");
        if (running.length) warning += `当前有正在运行的 Agent（${running.map((agent) => agent.name || agent.id).join("、")}），其进行中的请求会被中断。`;
      } catch { /* agents 读取失败不阻塞确认，交给更新流程自身的报错兜底 */ }
      const confirmed = await confirmSelfUpdate(
        `更新 Anyswitch 到 ${target}`,
        `${warning}安装目录中的手动修改会被覆盖。确认现在更新？`,
        "立即更新",
      );
      if (!confirmed) return;
      if (selfUpdateRun) return; // 确认期间可能已从 adopt 接回
      try {
        const started = await request("POST", "/api/self-update", {});
        trackSelfUpdate(started.runId, started.targetVersion || target, "staging", false);
      } catch (error) {
        selfUpdateRun = null;
        notify(error?.code === "busy" ? "已有更新任务在进行中" : "更新未能启动，请稍后重试", true);
        renderUpdate();
      }
    }
    // 应用阶段的手动入口：「应用更新」按钮（startSelfUpdateApply 确认后）经这里
    // 发 apply 并接续轮询。一键任务不走这里——服务端 autoApply 原地续跑。
    async function applySelfUpdateRun(staged) {
      try {
        await request("POST", "/api/self-update/apply", { runId: staged.runId });
        trackSelfUpdate(staged.runId, staged.targetVersion, "installing", true);
      } catch (error) {
        notify(error?.code === "busy" ? "已有更新任务在进行中" : error?.code === "no_staged" ? "没有已下载待应用的更新，请先检查更新" : "更新未能启动，请稍后重试", true);
        void adoptSelfUpdate();
      }
    }
    async function startSelfUpdateApply() {
      if (selfUpdateRun || !selfUpdateStaged) return;
      const staged = selfUpdateStaged;
      // 应用这一步才打断服务：与客户端更新同一层确认。重启提示是底线，有在跑
      // Agent 时把中断警示叠加上去——两条都要让用户看到，不能互相顶替。
      let warning = "应用期间面板与 Relay 会自动重启，服务中断几秒钟。";
      try {
        const data = await fetchOnce("/api/agents");
        const running = (data?.agents ?? []).filter((agent) => agent?.id && agent.status === "running");
        if (running.length) warning += `当前有正在运行的 Agent（${running.map((agent) => agent.name || agent.id).join("、")}），其进行中的请求会被中断。`;
      } catch { /* agents 读取失败不阻塞确认，交给更新流程自身的报错兜底 */ }
      const confirmed = await confirmSelfUpdate(`应用更新 ${staged.track === "bleeding" ? String(staged.targetSha ?? "").slice(0, 7) : staged.targetVersion || ""}`, `${warning}确认现在应用？`, "立即应用");
      if (!confirmed) return;
      if (selfUpdateRun || selfUpdateStaged !== staged) return;
      await applySelfUpdateRun(staged);
    }
    // 换装后的新页面（或任何一次进页）补显最终结论：只补最近的、十五分钟内的、
    // 没补显过的那条；结论要能被「又有更新」盖掉，但不被「已是最新」盖掉。
    async function adoptSelfUpdateLastOutcome() {
      if (selfUpdateRun || selfUpdateStaged) return;
      let last = null;
      try { last = await fetchOnce("/api/self-update/last"); } catch { last = null; }
      if (!last?.finishedAt || !last?.outcome || last.outcome === "downloaded") return;
      if (Date.now() - Date.parse(last.finishedAt) > 15 * 60 * 1000) return;
      const seenKey = `anyswitch:self-update-shown:${last.runId}`;
      try { if (localStorage.getItem(seenKey)) return; localStorage.setItem(seenKey, "1"); } catch { /* 隐私模式：照旧显一次 */ }
      if (!last.message) return;
      selfUpdateLastOutcome = last;
      const statusEl = get("aboutUpdateStatus");
      statusEl.textContent = last.message;
      statusEl.dataset.tone = last.outcome === "updated" ? "ok" : last.outcome === "failed" || last.outcome === "rolled_back" ? "danger" : "";
      notify(last.message, last.outcome !== "updated");
    }
    async function adoptSelfUpdate() {
      selfUpdateAdopted = false;
      selfUpdateRun = null;
      selfUpdateStaged = null;
      try {
        const data = await fetchOnce("/api/self-update/active");
        const run = data?.runs?.[0] ?? null;
        if (run) {
          trackSelfUpdate(run.runId, run.targetVersion, run.phase, run.step === "apply");
        } else if (data?.staged) {
          selfUpdateStaged = data.staged;
          renderSelfUpdateStaged();
        }
      } catch { /* 服务不可用：按钮按检查结果呈现 */ }
      await adoptSelfUpdateLastOutcome();
      selfUpdateAdopted = true;
      // 进页的自动检查可能还在途（enter 先 checkUpdates 再 adopt）：此刻状态行
      // 归它所有，重绘要保留「正在检查更新…」，不能盖回「尚未检查更新」。
      if (active) renderUpdate(Boolean(updateTask));
    }
    function renderApp() {
      // 先行轨道的版本号带提交标识（app-info 自报的 HEAD 短哈希；无本地 git 身份
      // 时无后缀、只显徽标）。先行徽标与预览徽标互斥：带提交标识的版本号会被
      // 误判成预发布，先行时预览徽标必须让位。
      const commit = typeof appInfo?.commit === "string" ? appInfo.commit : "";
      get("aboutAppVersion").textContent = bleedingMode && commit ? `${appInfo?.version || ""}-${commit}` : (appInfo?.version || "版本暂时无法读取");
      get("aboutPreviewBadge").hidden = bleedingMode || !appInfo?.prerelease;
      get("aboutBleedingBadge").hidden = !bleedingMode;
      const system = local || appInfo;
      if (system) get("aboutSystem").textContent = `${({ win32: "Windows", darwin: "macOS", linux: "Linux" })[system.platform] || "当前系统"} · Node ${system.nodeVersion || "版本未知"}`;
    }
    // 不一致提示行的状态指纹：同一「本地身份＋远端身份」组合只提示一次，点过
    // 「不再显示」后同状态静默；本地或远端任一变化即新状态、重新出现。
    function driftFingerprint(drift) {
      return `${drift.localCommit || drift.localVersion || ""}:${drift.remoteVersion || ""}`;
    }
    // 不一致提示行：持续状态（条件在它就长期在），静态摆在状态行下方独占一行，
    // 与「检查时间」同级小字。先行轨道不判游离——先行即常态。
    function renderDriftRow() {
      const row = get("aboutDriftRow");
      const notice = get("aboutDriftNotice");
      const dismiss = get("aboutDriftDismiss");
      const drift = update?.track === "stable" ? update?.drift : null;
      if (!drift) {
        row.hidden = true;
        notice.textContent = "";
        dismiss.hidden = true;
        return;
      }
      const localLabel = drift.localCommit ? `${drift.localVersion}-${drift.localCommit}` : `${drift.localVersion}`;
      notice.textContent = drift.ahead && drift.offTag
        ? `当前安装不是官方发布的版本（${localLabel}），官方最新为 ${drift.remoteVersion || "未知"}`
        : drift.ahead
          ? `当前版本 ${drift.localVersion} 领先于官方最新 ${drift.remoteVersion || "未知"}`
          : `当前安装不是官方发布的版本，官方最新为 ${drift.remoteVersion || "未知"}`;
      let muted = false;
      try { muted = localStorage.getItem(`anyswitch:drift-shown:${driftFingerprint(drift)}`) === "1"; } catch { muted = false; }
      row.hidden = muted;
      dismiss.hidden = muted;
    }
    function renderUpdate(checking = false) {
      // 不一致提示行只看检查结果，与横幅/进度谁占状态行无关，先画再让位。
      renderDriftRow();
      // 自更新进行中：状态行归进度渲染所有，检查结果不插话（完成态由收尾渲染）。
      const selfBtn = get("aboutSelfUpdate");
      if (selfUpdateRun) {
        selfBtn.hidden = true;
        return;
      }
      // 已下载待应用：状态行与「应用更新」按钮归 staged 渲染，检查结果不插话——
      // 此时检查仍报 update_available（当前版本确实还是旧的），但不能把按钮
      // 画回「立即更新」。
      if (selfUpdateStaged) {
        renderSelfUpdateStaged();
        return;
      }
      // 刚进页补显的最终结论：只能被「又有更新」盖掉，不被「已是最新」盖掉。
      const keepOutcome = selfUpdateLastOutcome && !checking && update?.state !== "update_available";
      const state = update?.state;
      const drift = update?.track === "stable" ? update?.drift : null;
      const status = get("aboutUpdateStatus");
      // 先行轨按提交身份答话；无 git 身份的先行（镜像安装未引导）回退版本号比较，
      // 与稳定轨同一套文案。
      const bleedingTrack = update?.track === "bleeding" && update.identity !== false;
      const copy = bleedingTrack ? {
        current: "已是先行版最新",
        update_available: `发现先行新提交 ${update?.remoteCommit || ""}`,
        error: "暂时无法检查，请重试",
      } : {
        update_available: update?.release?.prerelease ? `发现新预览版 ${update?.release?.version || ""}` : `发现新版本 ${update?.release?.version || ""}`,
        // 不一致家族（ahead / 安装游离）：状态行只交代检查发生过，事实在不一致
        // 提示行上；点过「不再显示」后状态行也回落到这句。
        current: drift ? "已检查更新" : "当前已是最新",
        ahead: "已检查更新",
        no_releases: "暂无发布版本",
        error: "暂时无法检查，请重试", unknown_version: "当前版本无法比较",
      };
      if (!keepOutcome) {
        status.textContent = checking ? "正在检查更新…" : copy[state] || "尚未检查更新";
        status.dataset.tone = !checking && state === "error" ? "danger" : !checking && state === "current" ? "ok" : "";
      }
      get("aboutUpdateTime").textContent = update?.checkedAt ? `检查时间 ${timeText(update.checkedAt)}` : "";
      const link = get("aboutReleaseLink");
      const href = !checking && safeLink(update?.release?.url, "app");
      link.hidden = !href;
      if (href) link.href = href; else link.removeAttribute("href");
      // 一键自更新：只在确认有新版本（两条轨道各自的 update_available）且接回
      // 检查完成时出现（检查出错/暂无发布不出现）。
      selfBtn.textContent = "立即更新";
      selfBtn.hidden = checking || !selfUpdateAdopted || state !== "update_available";
    }
    function sourceText(raw) {
      if (!raw) return "未提供";
      if (/--version/i.test(raw)) return "命令行自报版本";
      if (/asar/i.test(raw)) return "应用安装资料";
      if (/pe|file.?version|product.?version/i.test(raw)) return "程序版本信息";
      if (/npm|package|manifest/i.test(raw)) return "安装包资料";
      return "本地安装资料";
    }
    function renderClient(client, loading = false) {
      let row = rows.get(client.id);
      if (!row) {
        row = element("div", "about-client");
        row.dataset.clientId = client.id;
        row.setAttribute("role", "listitem");
        rows.set(client.id, row);
        get("aboutClients").appendChild(row);
      }
      const wasOpen = row.querySelector("details")?.open || false;
      const main = element("div", "about-client-main");
      const name = element("div", "about-client-name");
      const avatar = doc.querySelector(`.agent-cards-container .panel-card[data-agent-id="${client.id}"] .agent-avatar`);
      if (avatar) {
        const icon = element("span", "about-client-icon");
        icon.setAttribute("aria-hidden", "true");
        const clone = avatar.cloneNode(true);
        clone.removeAttribute("id");
        for (const node of clone.querySelectorAll("[id]")) node.removeAttribute("id");
        icon.appendChild(clone); name.appendChild(icon);
      }
      name.appendChild(element("span", "", client.name));
      const lines = element("div", "about-version-lines");
      lines.setAttribute("aria-live", "polite");
      const details = element("details", "about-details");
      details.open = wasOpen;
      details.appendChild(element("summary", "", "路径与版本来源"));
      const list = element("dl", "");
      function detail(label, value) { list.append(element("dt", "", label), element("dd", "", value)); }
      // 主行归并为每端点一行：徽标｜本地版本｜最新｜结论｜动作位。
      // 徽标是端点入口形态枚举（服务端 entryForms 数据下发），「/」连写。
      const primary = client.installations[0] ?? null;
      const forms = Array.isArray(client.entryForms) && client.entryForms.length
        ? client.entryForms
        : [...new Set(client.installations.map((installation) => (installation.kind === "desktop" ? "Desktop" : "CLI")))];
      const remoteOf = (installation) => (installation?.remoteId ? remoteCache.get(cacheKey(installation))?.data ?? null : null);
      const goodRemote = (installation) => {
        const remote = remoteOf(installation);
        return remote?.state === "ok" && remote.version ? remote : null;
      };
      const formTag = (installation) => (installation.kind === "desktop" ? "Desktop" : "CLI");
      // dsh 的终端形态由两个组件构成：本体 harness（installations[0]）与界面插件
      // dsh-tui（kind "tui"）。主行 CLI 段跟着插件走——本体没有 CLI 入口产品，
      // 详情区也不单列它；插件未装时该段不占位（not_found 惯例）。
      const tuiInstallation = client.id === "dsh"
        ? client.installations.find((installation) => installation.kind === "tui") ?? null
        : null;
      const displayPrimary = tuiInstallation ?? primary;
      const localStatus = (installation) => installation.status === "not_found" ? "未找到"
        : installation.status !== "found" ? "检测失败"
        : installation.issue === "not_runnable" ? "已安装但无法运行"
        : !validLocal(installation) ? "版本无法读取" : "已发现";
      const line = element("div", "about-version-line");
      line.appendChild(element("span", "about-kind", forms.join("/")));
      // 本地版本格：只摆主更新形态（installations[0]）的版本。codex / kimi 例外：
      // 两形态的版本都摆，带形态小注并排；dsh 摆终端插件（CLI 段）与桌面端，
      // 顺序固定 CLI 在前。某形态没装（not_found）不占位，装着却读不出版本时
      // 状态词占它的位。
      const localParts = [];
      if (tuiInstallation) {
        const shown = [tuiInstallation, ...client.installations.filter((installation) => installation.kind === "desktop")];
        for (const installation of shown) {
          if (installation.status === "found" && installation.version) localParts.push(`${formTag(installation)} ${installation.version}`);
          else if (installation.status !== "not_found") localParts.push(localStatus(installation));
        }
      } else if (client.id === "codex" || client.id === "kimi") {
        for (const installation of client.installations) {
          if (installation.status === "found" && installation.version) localParts.push(`${formTag(installation)} ${installation.version}`);
          else if (installation.status !== "not_found") localParts.push(localStatus(installation));
        }
      } else if (primary && primary.status === "found" && primary.version) {
        localParts.push(primary.version);
      }
      const localSpan = element("span", "about-version", `本地 ${localParts.length ? localParts.join(" · ") : displayPrimary ? localStatus(displayPrimary) : "未找到"}`);
      if (displayPrimary && (displayPrimary.status === "error" || displayPrimary.issue === "not_runnable")) localSpan.dataset.tone = "danger";
      line.appendChild(localSpan);
      // 最新格：主更新形态那条渠道的版本。codex / kimi 的桌面渠道官方版本查得到就
      // 同口径并排，查不到不占位；dsh 的 CLI 段取终端插件、Desktop 段取桌面端；
      // 没有官方版本源的端点直述「自带更新」。
      const primaryRemote = goodRemote(displayPrimary);
      let remoteText = "自带更新";
      if (tuiInstallation) {
        const remoteParts = [];
        const tuiRemote = goodRemote(tuiInstallation);
        if (tuiRemote) remoteParts.push(`CLI ${tuiRemote.version}`);
        else if (tuiInstallation.status !== "not_found") remoteParts.push(loading ? "查询中…" : "查询失败");
        for (const installation of client.installations) {
          if (installation.kind !== "desktop") continue;
          const remote = goodRemote(installation);
          if (remote) remoteParts.push(`Desktop ${remote.version}`);
        }
        remoteText = remoteParts.length ? remoteParts.join(" · ") : "自带更新";
      } else if (primary?.remoteId) {
        const perFormRemotes = client.id === "codex" || client.id === "kimi";
        const remoteParts = [];
        if (primaryRemote) remoteParts.push(perFormRemotes ? `${formTag(primary)} ${primaryRemote.version}` : primaryRemote.version);
        else remoteParts.push(loading ? "查询中…" : "查询失败");
        if (perFormRemotes) {
          for (const installation of client.installations.slice(1)) {
            const remote = goodRemote(installation);
            if (remote) remoteParts.push(`${formTag(installation)} ${remote.version}`);
          }
        }
        remoteText = remoteParts.join(" · ");
      }
      // dsh 行前缀不带「官方」：CLI 段是社区插件，它的版本源不是官方发布渠道。
      line.appendChild(element("span", "about-version", `${tuiInstallation ? "最新" : "官方最新"} ${remoteText}`));
      // 结论与动作位都看主更新形态：一次点按由服务端按端点串行跑全腿（CLI 腿 +
      // 桌面腿），前端不拼逐形态消息。dsh 的结论跟着终端插件比对，harness 的
      // 比对只留详情区。
      const comparison = primaryRemote && validLocal(displayPrimary) ? primaryRemote.comparison : "unknown";
      const compared = { update_available: "有新版本", current: tuiInstallation ? "与最新版本一致" : "与官方最新版本一致", ahead: "本地版本较新" }[comparison];
      // 结果列只说比对结论：没有结论时不重复「本地」列已经显示过的状态词
      const resultText = compared || (primaryRemote ? "无法比较版本" : "");
      if (resultText) {
        const result = element("span", "about-result", resultText);
        result.dataset.tone = comparison === "update_available" ? "warn" : comparison === "current" ? "ok" : "";
        line.appendChild(result);
      }
      if (loading && remoteOf(displayPrimary)) line.appendChild(element("span", "about-meta", "查询中…"));
      // 动作位端点级一颗：本端点任务在跑 > 可更新/可安装；锁按客户端分，别人在跑不影响本行。
      // 可更新按任一安装项判定——dsh 只有终端插件过期时按钮也要出现。
      if (primary && updatableClients.has(client.id)) {
        let intent = null;
        const act = client.installations
          .map((installation) => installationAction(client, installation))
          .find((action) => action?.kind === "update") ?? installationAction(client, primary);
        const ownRun = lifecycleRuns.get(client.id);
        if (act) {
          intent = ownRun
            ? { label: ownRun.action === "install" ? "安装中…" : "更新中…", disabled: true }
            : { label: act.kind === "update" ? "更新" : "安装", action: act.kind, disabled: Boolean(lifecycleBatch) };
        }
        if (intent) {
          const actionButton = element("button", "btn btn-mini about-client-action", intent.label);
          actionButton.type = "button";
          actionButton.disabled = intent.disabled;
          if (!intent.disabled) actionButton.onclick = () => updateClient(client.id, intent.action);
          line.appendChild(actionButton);
        }
      }
      lines.appendChild(line);
      // 详情区逐安装项补行：路径、版本来源、来源、查询时间，一条安装记录一组。
      // dsh 的 CLI 入口是社区插件（kind "tui"）：它按 CLI 组呈现，来源行说「上游来源」、
      // 链接指 npm 包页，后面补一句说明。本体 harness 不单列——官方没有 CLI 入口产品，
      // 它的存在由那句说明交代；桌面组仍按原样跟在 CLI 组之后。
      const detailed = client.id === "dsh"
        ? [...client.installations.filter((installation) => installation.kind === "tui"),
          ...client.installations.filter((installation) => installation.kind === "desktop")]
        : client.installations;
      for (const installation of detailed) {
        const kind = installation.kind === "desktop" ? "桌面" : "CLI";
        detail(`${kind} 路径`, installation.path || "未找到");
        detail(`${kind} 版本来源`, sourceText(installation.versionSource));
        const href = safeLink(remoteOf(installation)?.url, installation.remoteId);
        if (href) {
          const target = element("dd", "");
          const link = element("a", "about-link", installation.kind === "tui" ? "查看上游版本" : "查看官方版本");
          link.href = href; link.target = "_blank"; link.rel = "noopener noreferrer";
          target.appendChild(link); list.append(element("dt", "", `${kind} ${installation.kind === "tui" ? "上游来源" : "官方来源"}`), target);
        }
        const remote = remoteOf(installation);
        if (remote?.checkedAt) detail(`${kind} 查询时间`, timeText(remote.checkedAt));
        if (installation.kind === "tui") detail("CLI 说明", "由社区插件提供，内核为官方版本");
      }
      if (local?.checkedAt) detail("检测时间", timeText(local.checkedAt));
      details.appendChild(list);
      main.append(name, lines);
      row.replaceChildren(main, details);
    }
    function renderLocal(loading = false) {
      if (!local) return;
      const keep = new Set(local.clients.map((client) => client.id));
      for (const [id, row] of rows) if (!keep.has(id)) { row.remove(); rows.delete(id); }
      for (const client of local.clients) renderClient(client, loading);
      renderApp();
      updateBatchButton();
    }
    async function loadApp(gen) {
      if (appInfo) return;
      try {
        const data = await fetchOnce("/api/app-info");
        if (!active || gen !== environmentGen) return;
        appInfo = data;
      } catch {
        if (!active || gen !== environmentGen) return;
      }
      renderApp();
    }
    function loadEnvironment(refresh = false) {
      if (!active) return Promise.resolve();
      if (environmentTask) return environmentTask;
      const gen = ++environmentGen;
      const current = () => active && gen === environmentGen;
      busy("aboutEnvironmentRefresh", true, "重新检测", "检测中…");
      get("aboutEnvironmentStatus").textContent = local ? "正在重新检测…" : "正在检测…";
      get("aboutEnvironmentStatus").dataset.tone = "";
      const appTask = loadApp(gen);
      const task = (async () => {
        try {
          if (refresh || !local || localFailed || now() - localAt >= 60_000) {
            const data = await fetchOnce(`/api/environment${refresh ? "?refresh=1" : ""}`);
            if (!current()) return;
            local = data; localAt = now(); localFailed = false;
          }
          if (!current()) return;
          renderLocal(true);
          get("aboutEnvironmentStatus").textContent = "正在查询官方版本…";
          const jobs = local.clients.flatMap((client) => client.installations.filter((installation) => installation.remoteId).map((installation) => ({ client, installation })));
          let cursor = 0;
          async function worker() {
            while (current() && cursor < jobs.length) {
              const { client, installation } = jobs[cursor++];
              const key = cacheKey(installation);
              const cached = remoteCache.get(key);
              if (!refresh && cached?.data.state === "ok" && now() - cached.at < 600_000) {
                renderClient(client); continue;
              }
              const query = new URLSearchParams();
              if (refresh) query.set("refresh", "1");
              const version = validLocal(installation);
              if (version) query.set("localVersion", version);
              const suffix = query.size ? `?${query}` : "";
              let data;
              try { data = await fetchOnce(`/api/environment/latest/${encodeURIComponent(installation.remoteId)}${suffix}`); }
              catch { data = { state: "error", version: null }; }
              if (!current()) return;
              remoteCache.set(key, { data, at: now() });
              renderClient(client);
            }
          }
          await Promise.all(Array.from({ length: Math.min(3, jobs.length) }, () => worker()));
          if (!current()) return;
          renderLocal();
          const failed = jobs.some(({ installation }) => remoteCache.get(cacheKey(installation))?.data.state !== "ok");
          get("aboutEnvironmentStatus").textContent = failed ? "部分官方版本查询失败，可重新检测" : `检测完成 · ${timeText(local.checkedAt)}`;
          get("aboutEnvironmentStatus").dataset.tone = failed ? "warn" : "";
        } catch {
          if (!current()) return;
          localFailed = true;
          get("aboutEnvironmentStatus").textContent = local ? "检测失败，保留上次结果，请重试" : "检测失败，请重试";
          get("aboutEnvironmentStatus").dataset.tone = "danger";
          renderLocal();
        } finally {
          await appTask;
          if (current()) {
            environmentTask = null;
            busy("aboutEnvironmentRefresh", false, "重新检测", "检测中…");
          }
        }
      })();
      environmentTask = task;
      return task;
    }
    function checkUpdates(force = true) {
      if (!active) return Promise.resolve();
      if (updateTask) return updateTask;
      const gen = ++updateGen;
      busy("aboutCheckUpdates", true, "检查更新", "检查中…");
      renderUpdate(true);
      const task = (async () => {
        let data;
        try { data = await fetchOnce(`/api/updates${force ? "?refresh=1" : ""}`); }
        catch { data = { state: "error" }; }
        if (!active || gen !== updateGen) return;
        update = data; updateAt = now();
        renderUpdate();
        updateTask = null;
        busy("aboutCheckUpdates", false, "检查更新", "检查中…");
      })();
      updateTask = task;
      return task;
    }
    function adoptRunningUpdates() {
      return fetchOnce("/api/environment/updates/active").then((data) => {
        if (!active) return;
        for (const run of data?.runs ?? []) {
          if (run?.state !== "running" || !run.clientId || lifecycleRuns.has(run.clientId)) continue;
          const tracked = { clientId: run.clientId, action: run.action, runId: run.runId, poll: null };
          lifecycleRuns.set(run.clientId, tracked);
          void pollLifecycle(tracked, run.runId).then(
            (status) => { if (active) reportLifecycleOutcome(status, run.clientId); },
            () => {},
          ).finally(() => {
            lifecycleRuns.delete(run.clientId);
            if (tracked.poll !== null) { cancelSchedule(tracked.poll); tracked.poll = null; }
            if (active) { renderLocal(); updateBatchButton(); loadEnvironment(true); }
          });
        }
        renderLocal();
        updateBatchButton();
      }, () => {});
    }
    // 先行轨道开关是运行时设置：进页现读一次（版本号后缀与徽标只由它驱动），
    // 高级页切换后回到关于页会重新进页、重新读取，不另挂监听。
    async function refreshBleedingMode() {
      try {
        const data = await fetchOnce("/api/settings");
        bleedingMode = data?.settings?.bleedingEdgeMode === true;
      } catch { return; }
      if (active) renderApp();
    }
    function enter() {
      if (active) return environmentTask || Promise.resolve();
      active = true;
      if (appInfo) renderApp();
      void refreshBleedingMode();
      renderUpdate();
      renderLocal();
      updateBatchButton();
      // 进页自动查一次（非强制、吃后端缓存）：没查过、上次失败、或结果超过 10 分钟才查；
      // 「检查更新」按钮保留 refresh=1 的强制语义
      if (!update || update.state === "error" || now() - updateAt >= 600_000) checkUpdates(false);
      // 面板关掉再打开时，安装还在脱离的进程里跑。进页把还没结束的接回来，
      // 否则按钮会重新变成可点，同一个客户端会被再开一次。
      const resumed = adoptRunningUpdates();
      const selfResumed = adoptSelfUpdate();
      return Promise.all([loadEnvironment(), resumed, selfResumed]);
    }
    function leave() {
      active = false;
      environmentGen++; updateGen++; lifecycleGen++; selfUpdateGen++;
      environmentTask = null; updateTask = null;
      // 更新任务交给服务端跑完：离开即放弃轮询与本地标记，结果由下次进页的重新检测呈现
      for (const run of lifecycleRuns.values()) {
        if (run.poll !== null) { cancelSchedule(run.poll); run.poll = null; }
      }
      lifecycleRuns.clear();
      lifecycleBatch = null;
      // 自更新同理：任务在后台照跑，下次进页由 adoptSelfUpdate 接回或按结果呈现。
      if (selfUpdateRun?.poll) { cancelSchedule(selfUpdateRun.poll); selfUpdateRun.poll = null; }
      selfUpdateRun = null;
      selfUpdateStaged = null;
      selfUpdateLastOutcome = null;
      // 先作废排队中的确认（它们还没上屏），再关掉屏上那个——否则关掉时会顺手把
      // 队列里的下一个弹出来，落在一个已经离开的页面上。
      drainLifecycleModalQueue(false);
      closeLifecycleModal(false);
      busy("aboutEnvironmentRefresh", false, "重新检测", "检测中…");
      busy("aboutCheckUpdates", false, "检查更新", "检查中…");
    }
    get("aboutCheckUpdates").onclick = () => checkUpdates(true);
    get("aboutSelfUpdate").onclick = () => { void (selfUpdateStaged ? startSelfUpdateApply() : startSelfUpdate()); };
    get("aboutEnvironmentRefresh").onclick = () => loadEnvironment(true);
    get("aboutUpdateAll").onclick = () => startUpdateAll();
    // 「不再显示」：压掉的是当前这个不一致状态（按状态指纹），状态变化后新状态
    // 会重新出现——不是永久关闭。
    get("aboutDriftDismiss").onclick = (event) => {
      event?.preventDefault?.();
      const drift = update?.track === "stable" ? update?.drift : null;
      if (!drift) return;
      try { localStorage.setItem(`anyswitch:drift-shown:${driftFingerprint(drift)}`, "1"); } catch { /* 存档不可写：保持提示，不吞状态 */ }
      renderDriftRow();
    };
    get("clientUpdateModalCancel").onclick = () => closeLifecycleModal(false);
    get("clientUpdateModalClose").onclick = () => closeLifecycleModal(false);
    get("clientUpdateModalConfirm").onclick = () => closeLifecycleModal(true);
    get("clientUpdateModal").onclick = (event) => { if (event?.target === get("clientUpdateModal")) closeLifecycleModal(false); };
    // confirmSelfUpdate 同时暴露给设置视图：先行版开关的双确认复用同一只弹层
    // （单例+排队语义不变）。弹层开着时遮罩盖住页面，切走即按取消作答，安全。
    return {
      enter,
      leave,
      checkUpdates,
      refresh: () => loadEnvironment(true),
      confirmSelfUpdate,
      // 页面级观察者的归属判据：本页正在跟踪自更新 run 时，完成提示与换装接管
      // 归本页（进度横幅与既有编排都在这），观察者让位。
      selfUpdateTracking: () => Boolean(selfUpdateRun),
    };
  }

  // 设置全页视图与各项开关
  function initSettingsView() {
    const keepAliveToggle = $("keepAliveToggle");
    const keepAliveEndpointsWrap = $("keepAliveEndpoints");
    const keepAliveTitle = $("keepAliveTitle");
    const keepAliveDesc = $("keepAliveDesc");
    const followAgentToggle = $("followAgentToggle");
    const startupAnimationToggle = $("startupAnimationToggle");
    const uiVersionSeg = $("uiVersionSeg");
    const injectEffortToggle = $("injectEffortToggle");
    const credentialCacheToggle = $("credentialCacheToggle");
    const autoDownloadUpdatesToggle = $("autoDownloadUpdatesToggle");
    const bleedingEdgeToggle = $("bleedingEdgeToggle");
    const loggingEnabledToggle = $("loggingEnabledToggle");
    const logLevelSelect = $("logLevelSelect");
    const claudeBypassPermissionsToggle = $("claudeBypassPermissionsToggle");
    const midSystemRewriteToggle = $("midSystemRewriteToggle");
    const claudeTierEnabledToggle = $("claudeTierEnabledToggle");
    const sparkWindowInput = $("sparkWindowInput");
    const keepAliveRetriesInput = $("keepAliveRetriesInput");
    const KEEP_ALIVE_MODES = ["off", "enhanced"];
    const DEFAULT_KEEPALIVE_RETRIES = 2;
    const MIN_KEEPALIVE_RETRIES = 0;
    const MAX_KEEPALIVE_RETRIES = 10;
    let keepAliveMaxRetries = DEFAULT_KEEPALIVE_RETRIES;
    function clampKeepAliveRetries(n) {
      const parsed = Number.parseInt(n, 10);
      if (!Number.isInteger(parsed) || parsed < MIN_KEEPALIVE_RETRIES) return DEFAULT_KEEPALIVE_RETRIES;
      return Math.min(MAX_KEEPALIVE_RETRIES, parsed);
    }
    const KEEP_ALIVE_COPY = {
      off: { title: "抗截断", desc: "不做防截断处理，输出即时；各 Agent 偏好保留，重新开启后生效。", toast: "已停用抗截断" },
      enhanced: { title: "抗截断", desc: "整段验证后一次性交付，截断或上游故障会静默重试；代价是回合内看不到逐字输出、失败重试会整段重跑。", toast: "已启用抗截断" },
    };
    let settingsLoadGen = 0;
    const settingsSaving = { keepAlive: false, followAgent: false, injectEffort: false, spark: false, keepAliveRetries: false, keepAliveEndpoints: false, claudeBypassPermissions: false, midSystemRewrite: false, claudeTierEnabled: false, loggingEnabled: false, logLevel: false, credentialCache: false, autoDownloadUpdates: false, bleedingEdge: false };
    // 端点图标开关：从未切换过的端点不在 keepAliveEndpoints 里，按「跟随总开关」
    // 显示为启用——与服务端 resolveKeepAliveEnabled 的缺省口径一致，因此首次打开
    // 总开关时天然是全端点亮起，无需初始化写入。
    let keepAliveMode = "enhanced";
    let keepAliveEndpoints = {};
    // 需要描边环托底的端点（pi 的白、zcode 的黑在某一侧底色上隐形）——与会话管理
    // 圆点的 SESS_EP_RINGED 同一判据，见面板调色 --ep-ring 说明
    const KEEP_ALIVE_EP_RINGED = new Set(["pi", "zcode"]);
    function keepAliveEndpointOn(agentId) {
      return keepAliveEndpoints[agentId]?.enabled !== false;
    }
    // 启停只由 aria-pressed 一个视觉通道驱动：启用=品牌色淡底+同色相描边（色值与
    // 「会话管理」圆点同套的 --ep-*；头像自带底衬与品牌色未必同色，实心铺满会把图标
    // 框成「镶边」，故止于淡底+描边），停用=35% 透明；pi 白/zcode 黑会隐形的两例由
    // --ep-ring 描边立边（同会话圆点前例），不用灰度滤镜。总开关 off 时整排图标收起
    // ——偏好仍在服务端，重开即按原样亮回。
    function applyKeepAliveEndpointsUi() {
      if (!keepAliveEndpointsWrap) return;
      for (const btn of keepAliveEndpointsWrap.querySelectorAll(".keepalive-ep")) {
        const agentId = btn.dataset.agentId;
        const on = keepAliveEndpointOn(agentId);
        btn.setAttribute("aria-pressed", on ? "true" : "false");
        const label = `${statsEndpointLabel(agentId)}：${on ? "已启用 ✓，点击停用" : "已停用，点击启用"}`;
        btn.title = label;
        btn.setAttribute("aria-label", label);
      }
    }
    function applyKeepAliveUi(mode) {
      const m = KEEP_ALIVE_MODES.includes(mode) ? mode : "enhanced";
      keepAliveMode = m;
      const copy = KEEP_ALIVE_COPY[m];
      if (keepAliveToggle) keepAliveToggle.checked = m !== "off";
      if (keepAliveTitle) keepAliveTitle.textContent = copy.title;
      if (keepAliveDesc) keepAliveDesc.textContent = copy.desc;
      applyKeepAliveEndpointsUi();
      if (keepAliveEndpointsWrap) keepAliveEndpointsWrap.hidden = m === "off";
      return m;
    }
    // 图标归一化：克隆看板头像整体（含各家底衬/描边/圆角——dsh 黑鲸鱼靠白底衬可辨、
    // qoder 与 codex 是 32px 内联白底方块，只取字形会糊掉或溢出方钮），由
    // .keepalive-ep-icon 等比缩放统一尺寸；品牌色经 --ep-color 指到 --ep-* token，
    // 启用态底衬/描边由它派生。点击监听直接挂在按钮上。
    function buildKeepAliveEndpoints() {
      if (!keepAliveEndpointsWrap) return;
      // 幂等重建：首次与 installedAgentIds 刷新后都会走这里（applyInstalledAgentIds），
      // 未安装的 Agent 不再出钮。null（检测未知/失败）按全部可见（fail-open）。
      keepAliveEndpointsWrap.innerHTML = "";
      const board = document.querySelector(".agent-cards-container");
      for (const agentId of AGENT_CARD_ORDER) {
        if (installedAgentIds && !installedAgentIds.has(agentId)) continue;
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "keepalive-ep";
        btn.dataset.agentId = agentId;
        btn.style.setProperty("--ep-color", `var(--ep-${agentId})`);
        if (KEEP_ALIVE_EP_RINGED.has(agentId)) btn.classList.add("keepalive-ep--ringed");
        const avatar = board?.querySelector(`.panel-card[data-agent-id="${agentId}"] .agent-avatar`);
        if (avatar) {
          const iconWrap = document.createElement("span");
          iconWrap.className = "keepalive-ep-icon";
          iconWrap.appendChild(avatar.cloneNode(true));
          btn.appendChild(iconWrap);
        } else btn.textContent = statsEndpointLabel(agentId);
        btn.addEventListener("click", () => persistKeepAliveEndpoint(agentId));
        keepAliveEndpointsWrap.appendChild(btn);
      }
      applyKeepAliveEndpointsUi(); // 重建即回填 aria-pressed/提示（存档回显路径之外也成立）
    }
    buildKeepAliveEndpoints();
    // 可见集变化时（环境检测落地）由 IIFE 层回调触达重建：buildKeepAliveEndpoints
    // 是本函数的内部函数，外层不直引（见 applyInstalledAgentIds 侧注释）。
    rebuildKeepAliveButtons = () => { buildKeepAliveEndpoints(); };

    // 设置入口：页头齿轮切入全页设置视图，退出回到进入前的视图
    const openBtn = $("settingsBtn");
    const exitBtn = $("settingsExitBtn");
    const openSettings = () => {
      if (currentView !== "settings") settingsReturnView = currentView;
      switchView("settings");
    };
    if (openBtn) openBtn.onclick = openSettings;
    // 新版左栏右下角的设置入口与头行齿轮同一处理函数（返回视图记忆语义不变）
    const railOpenBtn = $("railSettingsBtn");
    if (railOpenBtn) railOpenBtn.onclick = openSettings;
    // 退出设置的回跳目标（进入前的视图）只有一个状态源：头行「←」与 v2 栏底「返回」
    // 挂同一处理函数，不从两个入口各写一份。终端态下同一颗钮由 initTerminalRail 接管
    // （两态互斥，见那边的注释）。
    const exitSettings = () => switchView(settingsReturnView);
    if (exitBtn) exitBtn.onclick = exitSettings;
    const railBackBtn = $("railBackBtn");
    if (railBackBtn) railBackBtn.onclick = exitSettings;
    const terminalEntry = $("openTerminalPreviewBtn");
    if (terminalEntry) terminalEntry.onclick = () => openTerminalPreview();

    // 子 tab：通用 / 自动路由 / 主题 / 关于；主动进入设置固定落「通用」，刷新恢复回到离开前那一个。
    const about = createAboutController({ request: api, doc: document, notify: toast });
    // 观察者接线：关于页在跟踪自更新 run 时，完成提示与换装接管归它，观察者让位。
    selfUpdateWatcher.setAboutProbe(about.selfUpdateTracking);
    // 数据搬迁用 panelFailure：被折叠的失败要额外告诉用户「刷新页面重试」这条
    // 有意义的下一步，并指向面板日志里的服务端原文。
    const dataBundle = createDataBundleController({ request: api, doc: document, notify: toast, errorText: panelFailure });
    leaveSettingsView = () => { about.leave(); dataBundle.leave(); };
    const settingsSubTabs = {
      general: ["settingsTabGeneral", "settingsPanelGeneral"],
      advanced: ["settingsTabAdvanced", "settingsPanelAdvanced"],
      route: ["settingsTabRoute", "settingsPanelRoute"],
      theme: ["settingsTabTheme", "settingsPanelTheme"],
      about: ["settingsTabAbout", "settingsPanelAbout"],
    };
    // 左栏设置目录（v2 设置态整组替换主 tab 组）：键必须与 settingsSubTabs 逐格同，
    // 值是栏内目录项 id。目录项与原子 tab 同走 activateSettingsSubTab——点击入口
    // 两个、状态源一个，高亮/aria 在该函数循环里双向同步，不会两处漂移。
    const settingsDirItems = {
      general: "railDirGeneral",
      advanced: "railDirAdvanced",
      route: "railDirRoute",
      theme: "railDirTheme",
      about: "railDirAbout",
    };
    function activateSettingsSubTab(which, animate) {
      const selected = settingsSubTabs[which];
      if (!selected || $(selected[0]).classList.contains("active")) return;
      resetPageScroll();
      if (which !== "about") about.leave();
      if (which !== "advanced") dataBundle.leave();
      for (const [name, [tabId, panelId]] of Object.entries(settingsSubTabs)) {
        const on = name === which;
        $(tabId).classList.toggle("active", on);
        $(tabId).setAttribute("aria-selected", String(on));
        $(tabId).tabIndex = on ? 0 : -1;
        $(panelId).hidden = !on;
        // 栏内目录项同帧跟随（高亮类 + aria 与主栏 tab 同套：selected 之外点亮挂
        // aria-current="page"）；子 tab 的 roving tabindex 只属于原子 tab 条，目录
        // 项与主栏 tab 一样全员可聚焦。
        const dirItem = $(settingsDirItems[name]);
        if (dirItem) {
          dirItem.classList.toggle("active", on);
          dirItem.setAttribute("aria-selected", String(on));
          if (on) dirItem.setAttribute("aria-current", "page"); else dirItem.removeAttribute("aria-current");
        }
      }
      // 子 tab 存档 = 此刻真实显示的那一个：进设置时的「通用」重置也走这里，存档
      // 永远与用户看到的一致，刷新恢复不必再区分「用户点的」与「程序置的」。
      try { localStorage.setItem("panel-settings-subtab", which); } catch {}
      if (animate) replayViewEnter($(selected[1]));
      if (which === "theme") {
        captureSettingsMirror();
        mirrorAwaitRender = true;
      }
      // 「自动路由」的配置数据与渠道页同源（store state），进 tab 即刷新一次，
      // 与渠道页每次切入都刷新同语义；渲染在 doRefreshStoreState 内统一完成。
      if (which === "route") refreshStoreState();
      // 「通用」的档位映射下拉同样以 store state 为源：进子页即刷新并在数据落地后
      // 重生成选项，于是渠道增删/改名后回到这一页看到的就是最新模型清单。
      // 拉取失败保留上一次生成的选项，不让一次网络抖动把四行变成空下拉。
      if (which === "general") refreshStoreState().then(renderClaudeTierOptions, () => {});
      if (which === "advanced") return dataBundle.enter();
      if (which === "about") return about.enter();
    }
    // 主题预览 = 真实看板镜像：克隆看板页当前 DOM（导航 + telemetry-view），剥 id
    // 防重复 id 被全局 $() 命中；看板本体的 hidden 只是被设置视图顶掉，须从克隆根上
    // 去掉，元素级 hidden（路由链卡/错误横幅等）是真实显隐态，保留。快照随进主题子页
    // 抓一次即冻结——预览看样式不看数据；主题/亮暗切换经全局 token 即时作用于镜像。
    function captureSettingsMirror() {
      const viewport = $("settingsMirrorViewport");
      const sizer = $("settingsMirrorSizer");
      const scaleEl = $("settingsMirrorScale");
      const board = document.querySelector(".telemetry-view");
      const main = document.querySelector("main.layout-container");
      if (!viewport || !sizer || !scaleEl || !board || !main) return;
      const stripIds = (root) => {
        root.removeAttribute("id");
        for (const el of root.querySelectorAll("[id]")) el.removeAttribute("id");
      };
      scaleEl.textContent = "";
      // 导航区按 UI 版本取真实形态：旧版是头行胶囊 tab 条；新版主导航在左栏，头行那条
      // 已被 :root[data-ui-version="v2"] #mainHeadInner .view-tabs 隐去——剥了 id 的克隆体
      // 不再命中那条规则，照样克隆就是给新版用户画出一条界面上不存在的旧版导航，改为
      // 克隆一份迷你栏（fixed 通高形态由 :root[v2] .settings-mirror-scale .rail 剥成静态）。
      const v2 = newUiEnabled();
      let mirrorRailW = 0;
      if (v2) {
        const rail = document.querySelector(".rail");
        if (rail) {
          const railClone = rail.cloneNode(true);
          stripIds(railClone);
          scaleEl.appendChild(railClone);
          // 栏宽按克隆实渲取值（宽档 216、窄栏随媒体查询收 72），栏与内容区间的
          // 24px 间隔由镜像 CSS 的 gap 呈现，自然宽一并补回。
          mirrorRailW = railClone.offsetWidth;
        }
        // 头行一并进镜像：v2 真实看板顶部有 48px 头行（左页题、右 relay 状态条），
        // 只克隆栏+看板时预览的板内顶栏整条缺失。只克隆 #mainHeadInner（设置头行与
        // 主头行同在 header.site-head 内，整克隆会把设置头行也带进来），外套新建的
        // header.site-head 壳——皮肤玻璃底/底边线与 v2 的 48px 高都锚在 .site-head
        // 祖先链上。剥 id 后 v2 收编头行的 id 锚规则（隐品牌组/旧 tab 条/头行按钮、
        // 右对齐、栏让位）全部脱钩，由镜像作用域规则顶班（panel.css v2 集中段）；
        // 剥 hidden——设置态真身主头行带 hidden 属性（switchView 互斥切换），不剥
        // 克隆体整行不可见。
        const mainHead = document.querySelector("#mainHeadInner");
        if (mainHead) {
          const headClone = mainHead.cloneNode(true);
          stripIds(headClone);
          headClone.removeAttribute("hidden");
          const headWrap = document.createElement("header");
          headWrap.className = "site-head";
          headWrap.appendChild(headClone);
          scaleEl.appendChild(headWrap);
        }
      } else {
        const tabs = document.querySelector("#mainHeadInner nav.view-tabs");
        if (tabs) {
          const tabsClone = tabs.cloneNode(true);
          stripIds(tabsClone);
          const tabsWrap = document.createElement("div");
          tabsWrap.className = "settings-mirror-tabs";
          tabsWrap.appendChild(tabsClone);
          scaleEl.appendChild(tabsWrap);
        }
      }
      const boardClone = board.cloneNode(true);
      boardClone.removeAttribute("hidden");
      stripIds(boardClone);
      scaleEl.appendChild(boardClone);
      // 看板被切走时量不到自身宽度：镜像自然宽以 main 内容宽为准（两者同宽）；新版的
      // 栏宽与 24px 栏间隔不占 main 内容宽，按克隆实渲宽 + 24 补回。
      // 缩放比 = 预览可视宽 / 自然宽，sizer 按缩放后尺寸撑开供 viewport 内滚。
      const mainCs = getComputedStyle(main);
      const naturalW = main.clientWidth - parseFloat(mainCs.paddingLeft) - parseFloat(mainCs.paddingRight) + (mirrorRailW ? mirrorRailW + 24 : 0);
      const availW = viewport.clientWidth;
      if (!naturalW || !availW) return;
      scaleEl.style.width = naturalW + "px";
      const s = availW / naturalW;
      const naturalH = scaleEl.offsetHeight;
      scaleEl.style.transform = `scale(${s})`;
      sizer.style.width = naturalW * s + "px";
      sizer.style.height = naturalH * s + "px";
      viewport.scrollTop = 0;
    }
    // 恢复路径下进「主题」的那次快照可能拍在首刷数据落地之前（空壳看板）：挂一次性补拍，
    // 等 refreshAgents 把真实内容渲染完再拍。正常路径拍到的已是真实内容，补拍值相同、
    // 无视觉变化；已离开主题子页时补拍直接作废。
    let mirrorAwaitRender = false;
    notifyBoardRendered = () => {
      if (!mirrorAwaitRender) return;
      mirrorAwaitRender = false;
      const themePanel = $("settingsPanelTheme");
      if (themePanel && !themePanel.hidden) captureSettingsMirror();
    };
    let mirrorResizeTimer = 0;
    window.addEventListener("resize", () => {
      const themePanel = $("settingsPanelTheme");
      if (!themePanel || themePanel.hidden) return;
      clearTimeout(mirrorResizeTimer);
      mirrorResizeTimer = setTimeout(captureSettingsMirror, 200);
    });
    function resetSettingsSubTab() {
      for (const [id] of Object.values(settingsSubTabs)) $(id).classList.remove("active");
      activateSettingsSubTab("general", false);
    }
    function bindSettingsSubTabs() {
      const names = Object.keys(settingsSubTabs);
      names.forEach((name, index) => {
        const [tabId, panelId] = settingsSubTabs[name];
        const tab = $(tabId);
        tab.onclick = () => activateSettingsSubTab(name, true);
        // 栏内目录项点击与原子 tab 同一入口（activateSettingsSubTab 内部回同步两处高亮）
        const dirItem = $(settingsDirItems[name]);
        if (dirItem) dirItem.onclick = () => activateSettingsSubTab(name, true);
        $(panelId).setAttribute("role", "tabpanel");
        $(panelId).setAttribute("aria-labelledby", tabId);
        tab.onkeydown = (event) => {
          const target = event.key === "Home" ? 0 : event.key === "End" ? names.length - 1
            : event.key === "ArrowRight" ? (index + 1) % names.length
            : event.key === "ArrowLeft" ? (index + names.length - 1) % names.length : -1;
          if (target < 0) return;
          event.preventDefault();
          $(settingsSubTabs[names[target]][0]).focus();
          activateSettingsSubTab(names[target], true);
        };
      });
    }
    bindSettingsSubTabs();

    enterSettingsView = () => {
      // 刷新/重启恢复进设置页：按 restoreView 交来的存档回到原子 tab；主动点齿轮进入
      // 仍旧从头看起，落「通用」。存档只在此消费一次，不留到下一次进入。
      const restore = settingsSubTabToRestore;
      settingsSubTabToRestore = null;
      if (restore && Object.keys(settingsSubTabs).includes(restore)) activateSettingsSubTab(restore, false);
      else resetSettingsSubTab();
      return loadSettingsState();
    };

    async function loadSettingsState() {
      const gen = ++settingsLoadGen;
      try {
        const d = await api("GET", "/api/settings");
        if (gen !== settingsLoadGen) return;
        if (!settingsSaving.keepAlive && !settingsSaving.keepAliveEndpoints && d.keepAlive) {
          if (d.keepAlive.endpoints) keepAliveEndpoints = d.keepAlive.endpoints;
          applyKeepAliveUi(d.keepAlive.mode ?? (d.keepAlive.enabled === false ? "off" : "enhanced"));
        }
        if (!settingsSaving.keepAliveRetries && d.keepAlive) {
          keepAliveMaxRetries = clampKeepAliveRetries(d.keepAlive.maxRetries ?? keepAliveMaxRetries);
          if (keepAliveRetriesInput) keepAliveRetriesInput.value = String(keepAliveMaxRetries);
        }
        if (!settingsSaving.followAgent && followAgentToggle && d.settings && typeof d.settings.followAgent === "boolean") {
          followAgentToggle.checked = d.settings.followAgent;
        }
        // 「从上次中断的地方继续」：运行时缓存归终端生命周期区所有，这里只回填；
        // 正在保存的那次切换不被回灌盖回。
        if (!terminalRestoreSaving && d.settings && typeof d.settings.terminalRestoreSessions === "boolean") {
          terminalRestoreSessions = d.settings.terminalRestoreSessions;
        }
        // 「底部自动对齐」：同 restore 开关的回填纪律，保存中的那次切换不被回灌盖回。
        if (!terminalBottomAlignSaving && d.settings && typeof d.settings.terminalBottomAutoAlign === "boolean") {
          terminalBottomAutoAlign = d.settings.terminalBottomAutoAlign;
        }
        if (!settingsSaving.injectEffort && injectEffortToggle && d.settings && typeof d.settings.injectThinkingEffort === "boolean") {
          injectEffortToggle.checked = d.settings.injectThinkingEffort;
        }
        if (!settingsSaving.credentialCache && credentialCacheToggle && d.settings && typeof d.settings.credentialCacheEnabled === "boolean") {
          credentialCacheToggle.checked = d.settings.credentialCacheEnabled;
        }
        if (!settingsSaving.autoDownloadUpdates && autoDownloadUpdatesToggle && d.settings && typeof d.settings.autoDownloadUpdates === "boolean") {
          autoDownloadUpdatesToggle.checked = d.settings.autoDownloadUpdates;
        }
        // 先行版开关：保存中（含确认弹层挂着的那段时间）不被轮询回灌盖回。
        if (!settingsSaving.bleedingEdge && bleedingEdgeToggle && d.settings && typeof d.settings.bleedingEdgeMode === "boolean") {
          bleedingEdgeToggle.checked = d.settings.bleedingEdgeMode;
        }
        // 运行日志开关：回灌时把左侧那张实时输出卡的显隐一并跟上，免得设置页与看板
        // 各说各话。
        if (!settingsSaving.loggingEnabled && loggingEnabledToggle && d.settings && typeof d.settings.loggingEnabled === "boolean") {
          loggingEnabledToggle.checked = d.settings.loggingEnabled;
          applyLoggingEnabled(d.settings.loggingEnabled);
        }
        // 日志级别：从属于上面那个总开关，回灌只同步选框与门槛本身；整段显隐归
        // applyLoggingEnabled 管，两处不各说各话。认不出的值按「显示全部」处理，
        // 与服务端同一口径——这一项是拿来少看的，读不到时不该反过来多看不见。
        if (!settingsSaving.logLevel && logLevelSelect && d.settings && typeof d.settings.logLevel === "string") {
          applyLogLevel(d.settings.logLevel === "warn" || d.settings.logLevel === "error" ? d.settings.logLevel : "info");
        }
        if (!settingsSaving.claudeBypassPermissions && claudeBypassPermissionsToggle && d.settings && typeof d.settings.claudeBypassPermissions === "boolean") {
          claudeBypassPermissionsToggle.checked = d.settings.claudeBypassPermissions;
        }
        if (!settingsSaving.midSystemRewrite && midSystemRewriteToggle && d.settings && typeof d.settings.midSystemRewrite === "boolean") {
          midSystemRewriteToggle.checked = d.settings.midSystemRewrite;
        }
        if (!settingsSaving.spark) {
          const fromApi = d.sparkWindowPoints ?? d.settings?.sparkWindowPoints;
          sparkWindowPoints = clampSparkWindow(fromApi ?? sparkWindowPoints);
          resetAgentRenderFingerprints(); // B1：视窗宽度变了，卡片须重渲
          if (sparkWindowInput) sparkWindowInput.value = String(sparkWindowPoints);
          Object.values(historyBuffers).forEach(pruneSparkBuffer);
        }
        // 档位接管总开关：正在保存的那次切换不被轮询回灌盖回。
        if (!settingsSaving.claudeTierEnabled && claudeTierEnabledToggle && d.settings && typeof d.settings.claudeTierMappingsEnabled === "boolean") {
          claudeTierEnabled = d.settings.claudeTierMappingsEnabled;
          claudeTierEnabledToggle.checked = claudeTierEnabled;
        }
        // 档位映射按服务端归一值回灌；某行正在保存时不回灌，免得把用户刚敲进
        // 那一行的值按旧结果盖掉。收起态与回灌解耦：一次行内保存不该把四行的
        // 显隐卡在旧状态上，所以 applyClaudeTierUi 放在守卫之外。
        if (!anyClaudeTierSaving()) {
          claudeTierMappings = { ...(d.settings?.claudeTierMappings ?? {}) };
        }
        applyClaudeTierUi();
      } catch {}
    }

    async function persistKeepAliveMode(next, previous) {
      if (settingsSaving.keepAlive) return;
      const mode = applyKeepAliveUi(next);
      settingsSaving.keepAlive = true;
      settingsLoadGen += 1;
      if (keepAliveToggle) keepAliveToggle.disabled = true;
      try {
        const d = await api("POST", "/api/settings", { keepAlive: { mode } });
        if (!d.ok) {
          applyKeepAliveUi(previous);
          toast("设置保存失败", true);
          return;
        }
        const savedMode = d.keepAlive?.mode;
        const saved = KEEP_ALIVE_MODES.includes(savedMode) ? savedMode : mode;
        if (d.keepAlive?.endpoints) keepAliveEndpoints = d.keepAlive.endpoints;
        applyKeepAliveUi(saved);
        toast(KEEP_ALIVE_COPY[saved].toast);
      } catch (e) {
        applyKeepAliveUi(previous);
        toast(panelError(e, "请求失败"), true);
      } finally {
        settingsSaving.keepAlive = false;
        if (keepAliveToggle) keepAliveToggle.disabled = false;
      }
    }

    async function persistKeepAliveEndpoint(agentId) {
      if (settingsSaving.keepAliveEndpoints) return;
      const previous = keepAliveEndpointOn(agentId);
      const next = !previous;
      // 先本地亮暗、再落盘，失败回滚：点一下就要看见变化，不等往返。
      keepAliveEndpoints = { ...keepAliveEndpoints, [agentId]: { enabled: next } };
      applyKeepAliveEndpointsUi();
      settingsSaving.keepAliveEndpoints = true;
      settingsLoadGen += 1;
      if (keepAliveEndpointsWrap) keepAliveEndpointsWrap.setAttribute("aria-busy", "true");
      try {
        const d = await api("POST", "/api/settings", { keepAlive: { endpoints: { [agentId]: { enabled: next } } } });
        if (!d.ok) {
          keepAliveEndpoints = { ...keepAliveEndpoints, [agentId]: { enabled: previous } };
          applyKeepAliveEndpointsUi();
          toast("设置保存失败", true);
          return;
        }
        if (d.keepAlive?.endpoints) keepAliveEndpoints = d.keepAlive.endpoints;
        applyKeepAliveEndpointsUi();
        toast(`${statsEndpointLabel(agentId)}已${next ? "启用" : "停用"}抗截断`);
      } catch (e) {
        keepAliveEndpoints = { ...keepAliveEndpoints, [agentId]: { enabled: previous } };
        applyKeepAliveEndpointsUi();
        toast(panelError(e, "请求失败"), true);
      } finally {
        settingsSaving.keepAliveEndpoints = false;
        if (keepAliveEndpointsWrap) keepAliveEndpointsWrap.setAttribute("aria-busy", "false");
      }
    }

    if (keepAliveToggle) {
      keepAliveToggle.onchange = () => {
        const previous = keepAliveMode;
        const next = keepAliveToggle.checked ? "enhanced" : "off";
        if (next === previous) return;
        persistKeepAliveMode(next, previous);
      };
    }

    async function persistSparkWindow(raw) {
      if (settingsSaving.spark) return;
      const previous = sparkWindowPoints;
      const next = clampSparkWindow(raw);
      sparkWindowPoints = next;
      resetAgentRenderFingerprints(); // B1
      if (sparkWindowInput) sparkWindowInput.value = String(next);
      Object.values(historyBuffers).forEach(pruneSparkBuffer);
      settingsSaving.spark = true;
      settingsLoadGen += 1;
      try {
        const d = await api("POST", "/api/settings", { sparkWindowPoints: next });
        if (!d.ok) {
          sparkWindowPoints = previous;
          resetAgentRenderFingerprints(); // B1：回滚也要重渲（同秒可能未轮询）
          if (sparkWindowInput) sparkWindowInput.value = String(previous);
          toast("折线视窗保存失败", true);
          return;
        }
        sparkWindowPoints = clampSparkWindow(d.sparkWindowPoints ?? next);
        resetAgentRenderFingerprints(); // B1
        if (sparkWindowInput) sparkWindowInput.value = String(sparkWindowPoints);
        toast("折线视窗已设为 " + sparkWindowPoints + " 个节点");
      } catch (e) {
        sparkWindowPoints = previous;
        resetAgentRenderFingerprints(); // B1：回滚也要重渲
        if (sparkWindowInput) sparkWindowInput.value = String(previous);
        toast(panelError(e, "请求失败"), true);
      } finally {
        settingsSaving.spark = false;
      }
    }

    if (sparkWindowInput) {
      sparkWindowInput.onchange = () => persistSparkWindow(sparkWindowInput.value);
      sparkWindowInput.onkeydown = (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          persistSparkWindow(sparkWindowInput.value);
        }
      };
    }

    // ── Claude Code 档位映射 ────────────────────────────────────────────
    // 四行「不接管」下拉：值 = anyswitch 托管模型的完整模型名，「不接管」= 该档位
    // 不接管。逐行独立「即改即存 + 失败回滚」，与本页其余设置项同一语义；中继侧
    // 每次请求都重读设置，所以保存即生效，不需要重启任何端点。四行的显隐由
    // 「接管默认模型」总开关驱动：关 = 收起且映射暂停生效（服务端返回空映射），
    // 已填的值保留。
    const claudeTierInputs = {
      sonnet: $("claudeTierSonnetInput"),
      opus: $("claudeTierOpusInput"),
      fable: $("claudeTierFableInput"),
      haiku: $("claudeTierHaikuInput"),
    };
    const claudeTierRows = $("claudeTierRows");
    let claudeTierMappings = {};
    let claudeTierEnabled = true;
    // 逐档各自的在存标记：一行在存时既挡住轮询回灌（不覆盖用户正在编辑的那行），
    // 也不牵连另一行——单一布尔会把并发的那次保存静默丢掉。
    const claudeTierSaving = { sonnet: false, opus: false, fable: false, haiku: false };
    const anyClaudeTierSaving = () => Object.values(claudeTierSaving).some(Boolean);

    function applyClaudeTierUi() {
      if (claudeTierRows) claudeTierRows.hidden = !claudeTierEnabled;
      for (const [tier, input] of Object.entries(claudeTierInputs)) {
        if (!input) continue;
        if (claudeTierSaving[tier]) continue;
        input.value = claudeTierMappings[tier] ?? "";
      }
    }

    // 下拉选项 = 中继此刻真的认得的模型全集 + 首项「不接管」：先是 Anyswitch
    // 自建的虚拟模型（它们不在渠道目录里，却是中继真认得的模型），其后是与
    // 「自动路由」同源的 storeRows()（号池按合并行出、成员行不重复出现），成员
    // 并集即该池的可见目录；值就是中继的完整模型名，卡面上只见「[渠道名] 模型
    // 显示名」与「[Anyswitch] 虚拟模型名」——anthropic/ 前缀只是骗过 Claude Code
    // 目录过滤的线上身份，不进任何用户可读文本（统计页剥前缀是同一口径）。渠道
    // 增删后重进「通用」即随 store state 一起刷新。已存的值不在候选集时（渠道已删/
    // 模型下架/虚拟模型已删或已停用）补一项「已失效」如实显示——与链编辑器「已保存
    // 但目录里消失的模型补入选项」同一口径。
    function renderClaudeTierOptions() {
      const seen = new Set();
      const base = [`<option value="">不接管</option>`];
      // 虚拟模型（Anyswitch 自建的命名路由链）：目录 id 与 auto 同造法
      // 「anthropic/<名字>」——前缀段内无 '/'，永不与真 wire id 相撞，中继按它
      // 自己的链路由。准入口径与中继同源：启用中且链非空——停用或空链的模型不在
      // 中继目录里，选中它必然失败。
      for (const vm of storeVirtualModels()) {
        const name = vm && typeof vm.name === "string" ? vm.name : "";
        if (!name) continue;
        if (vm.enabled === false) continue;
        if (!Array.isArray(vm.chain) || vm.chain.length === 0) continue;
        const wireId = `anthropic/${name}`;
        if (seen.has(wireId)) continue;
        seen.add(wireId);
        base.push(`<option value="${esc(wireId)}">${esc(`[Anyswitch] ${name}`)}</option>`);
      }
      for (const row of storeRows()) {
        const label = row.kind === "pool" ? (row.displayName || row.id) : ((row.p && row.p.displayName) || row.id);
        const models = {};
        if (row.kind === "pool") {
          for (const member of row.members || []) Object.assign(models, (member && member.models) || {});
        } else {
          Object.assign(models, (row.p && row.p.models) || {});
        }
        for (const modelId of Object.keys(models)) {
          const wireId = `anthropic/${row.id}/${modelId}`;
          if (seen.has(wireId)) continue;
          seen.add(wireId);
          const shown = (models[modelId] && models[modelId].displayName) || modelId;
          base.push(`<option value="${esc(wireId)}">${esc(`[${label}] ${shown}`)}</option>`);
        }
      }
      for (const [tier, input] of Object.entries(claudeTierInputs)) {
        if (!input) continue;
        const options = base.slice();
        const current = claudeTierMappings[tier] ?? "";
        if (current && !seen.has(current)) {
          options.push(`<option value="${esc(current)}">已失效，请重选</option>`);
        }
        input.innerHTML = options.join("");
      }
      // 重画选项后必须按已存映射把四行回填一遍：进「通用」子页每次都重画，
      // 重画会把 select 重建跳回首项，不回填就会出现「切页回来显示与磁盘真值
      // 不符」——正在保存的那一行按 claudeTierSaving 跳过，不会被旧选项盖掉。
      applyClaudeTierUi();
    }

    async function persistClaudeTier(tier, raw) {
      const input = claudeTierInputs[tier];
      if (!input || claudeTierSaving[tier]) return;
      const previous = claudeTierMappings[tier] ?? "";
      const next = String(raw ?? "").trim();
      const optimistic = { ...claudeTierMappings };
      if (next) optimistic[tier] = next;
      else delete optimistic[tier];
      claudeTierMappings = optimistic;
      claudeTierSaving[tier] = true;
      settingsLoadGen += 1;
      try {
        const d = await api("POST", "/api/settings", { claudeTierMappings: { [tier]: next } });
        if (!d.ok) {
          claudeTierMappings = { ...claudeTierMappings };
          delete claudeTierMappings[tier];
          if (previous) claudeTierMappings[tier] = previous;
          toast("档位映射保存失败", true);
          return;
        }
        // 服务端写回的是归一化结果（空行即删键、未知档位名即丢），以它为准。
        claudeTierMappings = { ...(d.settings?.claudeTierMappings ?? optimistic) };
        toast(next ? "档位映射已保存" : "该档位已改为不接管");
      } catch (e) {
        delete claudeTierMappings[tier];
        if (previous) claudeTierMappings[tier] = previous;
        toast(panelError(e, "请求失败"), true);
      } finally {
        claudeTierSaving[tier] = false;
        applyClaudeTierUi();
      }
    }

    for (const [tier, input] of Object.entries(claudeTierInputs)) {
      if (!input) continue;
      input.onchange = () => persistClaudeTier(tier, input.value);
    }

    async function persistKeepAliveRetries(raw) {
      if (settingsSaving.keepAliveRetries) return;
      const previous = keepAliveMaxRetries;
      const next = clampKeepAliveRetries(raw);
      keepAliveMaxRetries = next;
      if (keepAliveRetriesInput) keepAliveRetriesInput.value = String(next);
      settingsSaving.keepAliveRetries = true;
      settingsLoadGen += 1;
      try {
        const d = await api("POST", "/api/settings", { keepAlive: { maxRetries: next } });
        if (!d.ok) {
          keepAliveMaxRetries = previous;
          if (keepAliveRetriesInput) keepAliveRetriesInput.value = String(previous);
          toast("重试次数保存失败", true);
          return;
        }
        keepAliveMaxRetries = clampKeepAliveRetries(d.keepAlive?.maxRetries ?? next);
        if (keepAliveRetriesInput) keepAliveRetriesInput.value = String(keepAliveMaxRetries);
        toast("抗截断重试次数已设为 " + keepAliveMaxRetries);
      } catch (e) {
        keepAliveMaxRetries = previous;
        if (keepAliveRetriesInput) keepAliveRetriesInput.value = String(previous);
        toast(panelError(e, "请求失败"), true);
      } finally {
        settingsSaving.keepAliveRetries = false;
      }
    }

    if (keepAliveRetriesInput) {
      keepAliveRetriesInput.onchange = () => persistKeepAliveRetries(keepAliveRetriesInput.value);
      keepAliveRetriesInput.onkeydown = (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          persistKeepAliveRetries(keepAliveRetriesInput.value);
        }
      };
    }

    if (followAgentToggle) {
      followAgentToggle.onchange = async () => {
        if (settingsSaving.followAgent) {
          followAgentToggle.checked = !followAgentToggle.checked;
          return;
        }
        const next = followAgentToggle.checked;
        settingsSaving.followAgent = true;
        settingsLoadGen += 1;
        followAgentToggle.setAttribute("aria-busy", "true");
        try {
          const d = await api("POST", "/api/settings", { followAgent: next });
          if (!d.ok) {
            followAgentToggle.checked = !next;
            toast("设置保存失败", true);
          } else {
            const saved = d.settings?.followAgent;
            if (typeof saved === "boolean") followAgentToggle.checked = saved;
            toast(next ? "已开启跟随 Agent 启动" : "已关闭跟随 Agent 启动");
          }
        } catch (e) {
          followAgentToggle.checked = !next;
          toast(panelError(e, "请求失败"), true);
        } finally {
          settingsSaving.followAgent = false;
          followAgentToggle.removeAttribute("aria-busy");
        }
      };
    }

    if (startupAnimationToggle) {
      // 本机浏览器偏好，逐控件即时写存档、不 POST：开屏在绘制前就要决定出不出，
      // 走 /api/settings 就赶不上那一帧（同主题、面板样式、终端字号）。
      // 写下去的值对当前这一页不再有影响——开屏只在页面起点出现一次，
      // 下一次打开面板、或下一次看板重启回跳的那个新页面按新值走。
      startupAnimationToggle.checked = startupAnimationEnabled();
      startupAnimationToggle.onchange = () => {
        try {
          localStorage.setItem("panel-startup-animation", startupAnimationToggle.checked ? "1" : "0");
        } catch {}
      };
    }

    if (uiVersionSeg) {
      // 本机浏览器偏好，点选即时写存档、不 POST（同开屏动画）；不同处是即时生效——
      // 写存档的同时改写 <html> data-ui-version，看板 CSS 当帧换列，不必等刷新。
      // 旧版是 CSS 默认态：选回旧版时摘属性、删存档，不留 "classic" 之类的冗余值。
      // 无 toast：选中枚高亮当帧移动本身就是反馈（同设置页子 tab）。
      const segBtns = Array.from(uiVersionSeg.querySelectorAll("[data-ui-version-choice]"));
      const reflectUiVersion = () => {
        const v2 = newUiEnabled();
        for (const b of segBtns) {
          b.setAttribute("aria-checked", String((b.dataset.uiVersionChoice === "v2") === v2));
        }
      };
      for (const b of segBtns) {
        b.onclick = () => {
          const next = b.dataset.uiVersionChoice === "v2";
          try {
            if (next) localStorage.setItem("panel-ui-version", "v2");
            else localStorage.removeItem("panel-ui-version");
          } catch {}
          if (next) document.documentElement.setAttribute("data-ui-version", "v2");
          else document.documentElement.removeAttribute("data-ui-version");
          reflectUiVersion();
        };
      }
      reflectUiVersion();
    }

    if (injectEffortToggle) {
      injectEffortToggle.onchange = async () => {
        if (settingsSaving.injectEffort) {
          injectEffortToggle.checked = !injectEffortToggle.checked;
          return;
        }
        const next = injectEffortToggle.checked;
        settingsSaving.injectEffort = true;
        settingsLoadGen += 1;
        injectEffortToggle.setAttribute("aria-busy", "true");
        try {
          const d = await api("POST", "/api/settings", { injectThinkingEffort: next });
          if (!d.ok) {
            injectEffortToggle.checked = !next;
            toast("设置保存失败", true);
          } else {
            const saved = d.settings?.injectThinkingEffort;
            if (typeof saved === "boolean") injectEffortToggle.checked = saved;
            toast(next ? "已开启注入推理强度" : "已关闭注入推理强度");
          }
        } catch (e) {
          injectEffortToggle.checked = !next;
          toast(panelError(e, "请求失败"), true);
        } finally {
          settingsSaving.injectEffort = false;
          injectEffortToggle.removeAttribute("aria-busy");
        }
      };
    }

    // 缓存上游密钥：与其它项同构的即改即存。改完当场生效——relay 每次取密钥都
    // 现读这个开关，所以关掉之后不必等重启，内存里的明文立刻被清掉。
    if (credentialCacheToggle) {
      credentialCacheToggle.onchange = async () => {
        if (settingsSaving.credentialCache) {
          credentialCacheToggle.checked = !credentialCacheToggle.checked;
          return;
        }
        const next = credentialCacheToggle.checked;
        settingsSaving.credentialCache = true;
        settingsLoadGen += 1;
        credentialCacheToggle.setAttribute("aria-busy", "true");
        try {
          const d = await api("POST", "/api/settings", { credentialCacheEnabled: next });
          if (!d.ok) {
            credentialCacheToggle.checked = !next;
            toast("设置保存失败", true);
          } else {
            const saved = d.settings?.credentialCacheEnabled;
            if (typeof saved === "boolean") credentialCacheToggle.checked = saved;
            toast(next ? "已开启缓存上游密钥" : "已关闭缓存上游密钥");
          }
        } catch (e) {
          credentialCacheToggle.checked = !next;
          toast(panelError(e, "请求失败"), true);
        } finally {
          settingsSaving.credentialCache = false;
          credentialCacheToggle.removeAttribute("aria-busy");
        }
      };
    }

    // 自动检测并下载更新：与其它项同构的即改即存。面板常驻调度每拍现读这个开关，
    // 改完下一拍即生效，不必重启。
    if (autoDownloadUpdatesToggle) {
      autoDownloadUpdatesToggle.onchange = async () => {
        if (settingsSaving.autoDownloadUpdates) {
          autoDownloadUpdatesToggle.checked = !autoDownloadUpdatesToggle.checked;
          return;
        }
        const next = autoDownloadUpdatesToggle.checked;
        settingsSaving.autoDownloadUpdates = true;
        settingsLoadGen += 1;
        autoDownloadUpdatesToggle.setAttribute("aria-busy", "true");
        try {
          const d = await api("POST", "/api/settings", { autoDownloadUpdates: next });
          if (!d.ok) {
            autoDownloadUpdatesToggle.checked = !next;
            toast("设置保存失败", true);
          } else {
            const saved = d.settings?.autoDownloadUpdates;
            if (typeof saved === "boolean") autoDownloadUpdatesToggle.checked = saved;
            toast(next ? "已开启自动下载更新" : "已关闭自动下载更新");
          }
        } catch (e) {
          autoDownloadUpdatesToggle.checked = !next;
          toast(panelError(e, "请求失败"), true);
        } finally {
          settingsSaving.autoDownloadUpdates = false;
          autoDownloadUpdatesToggle.removeAttribute("aria-busy");
        }
      };
    }

    // ── 先行版（更新通道）：开=确认后只切检测通道（换装仍走关于页的两步更新）；
    // 关=按回退计划确认——已在稳定节点上直接关，否则先换装回「本地之下的最近
    // 稳定版本」再关。回退的进度与终态结论都在关于页呈现（换装本来就要换掉本
    // 进程），确认通过后直接切过去接看；定不出回退计划（网络）时如实回弹开关。
    if (bleedingEdgeToggle) {
      bleedingEdgeToggle.onchange = async () => {
        if (settingsSaving.bleedingEdge) {
          bleedingEdgeToggle.checked = !bleedingEdgeToggle.checked;
          return;
        }
        const next = bleedingEdgeToggle.checked;
        settingsSaving.bleedingEdge = true;
        settingsLoadGen += 1;
        bleedingEdgeToggle.setAttribute("aria-busy", "true");
        const revert = () => { bleedingEdgeToggle.checked = !next; };
        try {
          if (next) {
            const confirmed = await about.confirmSelfUpdate(
              "开启先行版",
              "开启后只切换更新来源，当前已安装的版本不变；之后检查更新会显示上游最新提交，是否更新到它由你在关于页决定。先行版本包含尚未正式发布的改动。确认开启？",
              "开启先行版",
            );
            if (!confirmed) { revert(); return; }
            const d = await api("POST", "/api/settings", { bleedingEdgeMode: true });
            if (!d.ok) { revert(); toast("设置保存失败", true); return; }
            if (typeof d.settings?.bleedingEdgeMode === "boolean") bleedingEdgeToggle.checked = d.settings.bleedingEdgeMode;
            toast("已开启先行版");
            return;
          }
          let plan = null;
          try { plan = await api("GET", "/api/self-update/bleeding-plan"); } catch { plan = null; }
          if (!plan?.ok) { revert(); toast("暂时无法检查，请重试", true); return; }
          let confirmed, rollback = false;
          if (plan.onStableNode) {
            const body = plan.baseVersion
              ? `当前已在稳定版本（${plan.baseVersion}）上，关闭后更新只提供官方正式发布的版本。确认关闭？`
              : "关闭后更新只提供官方正式发布的版本。确认关闭？";
            confirmed = await about.confirmSelfUpdate("关闭先行版", body, "关闭先行版");
          } else {
            let warning = `关闭前会把 Anyswitch 回退到离当前最近的稳定版本（${plan.baseVersion}）：回退期间面板与 Relay 会自动重启，服务中断几秒钟；安装目录中的手动修改会被覆盖。关闭后，更新只提供官方正式发布的版本。`;
            try {
              const data = await api("GET", "/api/agents");
              const running = (data?.agents ?? []).filter((agent) => agent?.id && agent.status === "running");
              if (running.length) warning += `当前有正在运行的 Agent（${running.map((agent) => agent.name || agent.id).join("、")}），其进行中的请求会被中断。`;
            } catch { /* agents 读取失败不阻塞确认，交给更新流程自身的报错兜底 */ }
            confirmed = await about.confirmSelfUpdate("关闭先行版", `${warning}确认回退并关闭？`, "回退并关闭");
            rollback = true;
          }
          if (!confirmed) { revert(); return; }
          const d = await api("POST", "/api/settings", { bleedingEdgeMode: false });
          if (!d.ok) { revert(); toast("设置保存失败", true); return; }
          bleedingEdgeToggle.checked = false;
          if (!rollback) { toast("已关闭先行版"); return; }
          // 回退换装即刻开跑：切到关于页接看进度（换装完成时本页随面板换新）。
          // 起不来（busy 等）也切过去——那边的状态行会如实给出正在进行的任务。
          try { await api("POST", "/api/self-update/rollback", {}); } catch { /* 状态由关于页如实呈现 */ }
          activateSettingsSubTab("about");
        } finally {
          settingsSaving.bleedingEdge = false;
          bleedingEdgeToggle.removeAttribute("aria-busy");
        }
      };
    }

    // 运行日志：与其它项同构的即改即存，但保存成功后要立刻把左侧那张实时输出卡显隐
    // 掉——这个开关的意义就是「不再记录」，界面不跟着动就看不出它生效了。
    if (loggingEnabledToggle) {
      loggingEnabledToggle.onchange = async () => {
        if (settingsSaving.loggingEnabled) {
          loggingEnabledToggle.checked = !loggingEnabledToggle.checked;
          return;
        }
        const next = loggingEnabledToggle.checked;
        settingsSaving.loggingEnabled = true;
        settingsLoadGen += 1;
        loggingEnabledToggle.setAttribute("aria-busy", "true");
        try {
          const d = await api("POST", "/api/settings", { loggingEnabled: next });
          if (!d.ok) {
            loggingEnabledToggle.checked = !next;
            toast("设置保存失败", true);
          } else {
            const saved = d.settings?.loggingEnabled;
            if (typeof saved === "boolean") loggingEnabledToggle.checked = saved;
            applyLoggingEnabled(saved !== false);
            toast(next ? "已开启运行日志" : "已关闭运行日志");
          }
        } catch (e) {
          loggingEnabledToggle.checked = !next;
          toast(panelError(e, "请求失败"), true);
        } finally {
          settingsSaving.loggingEnabled = false;
          loggingEnabledToggle.removeAttribute("aria-busy");
        }
      };
    }

    // 日志级别：即改即存，保存成功后按新门槛重连日志流（在 applyLogLevel 里）。
    // 选项文字只写在 panel.html 一处，toast 从选中的那个 option 现取，不在脚本里
    // 另立一份中文级别名。
    if (logLevelSelect) {
      logLevelSelect.onchange = async () => {
        if (settingsSaving.logLevel) return;
        const next = logLevelSelect.value;
        const nextLabel = logLevelSelect.selectedOptions?.[0]?.textContent ?? next;
        settingsSaving.logLevel = true;
        settingsLoadGen += 1;
        logLevelSelect.setAttribute("aria-busy", "true");
        try {
          const d = await api("POST", "/api/settings", { logLevel: next });
          if (!d.ok) {
            logLevelSelect.value = logLevel ?? "info";
            toast("设置保存失败", true);
          } else {
            const saved = d.settings?.logLevel;
            applyLogLevel(typeof saved === "string" ? saved : next);
            toast(`日志级别已设为${nextLabel}`);
          }
        } catch (e) {
          logLevelSelect.value = logLevel ?? "info";
          toast(panelError(e, "请求失败"), true);
        } finally {
          settingsSaving.logLevel = false;
          logLevelSelect.removeAttribute("aria-busy");
        }
      };
    }

    // 以 bypassPermissions 启动：只改「下一次从 Anyswitch 拉起 Claude Code」
    // 的启动参数，已在跑的会话不受影响，也不需要重启任何常驻进程。
    if (claudeBypassPermissionsToggle) {
      claudeBypassPermissionsToggle.onchange = async () => {
        if (settingsSaving.claudeBypassPermissions) {
          claudeBypassPermissionsToggle.checked = !claudeBypassPermissionsToggle.checked;
          return;
        }
        const next = claudeBypassPermissionsToggle.checked;
        settingsSaving.claudeBypassPermissions = true;
        settingsLoadGen += 1;
        claudeBypassPermissionsToggle.setAttribute("aria-busy", "true");
        try {
          const d = await api("POST", "/api/settings", { claudeBypassPermissions: next });
          if (!d.ok) {
            claudeBypassPermissionsToggle.checked = !next;
            toast("设置保存失败", true);
          } else {
            const saved = d.settings?.claudeBypassPermissions;
            if (typeof saved === "boolean") claudeBypassPermissionsToggle.checked = saved;
            toast(next ? "已开启 bypassPermissions 启动" : "已关闭 bypassPermissions 启动");
          }
        } catch (e) {
          claudeBypassPermissionsToggle.checked = !next;
          toast(panelError(e, "请求失败"), true);
        } finally {
          settingsSaving.claudeBypassPermissions = false;
          claudeBypassPermissionsToggle.removeAttribute("aria-busy");
        }
      };
    }

    // 会话缓存优化：改写的是发往上游的消息形态，已在跑的请求不受影响；relay 每
    // 请求现读该设置，保存后下一请求即切换，无需重启任何常驻进程。
    if (midSystemRewriteToggle) {
      midSystemRewriteToggle.onchange = async () => {
        if (settingsSaving.midSystemRewrite) {
          midSystemRewriteToggle.checked = !midSystemRewriteToggle.checked;
          return;
        }
        const next = midSystemRewriteToggle.checked;
        settingsSaving.midSystemRewrite = true;
        settingsLoadGen += 1;
        midSystemRewriteToggle.setAttribute("aria-busy", "true");
        try {
          const d = await api("POST", "/api/settings", { midSystemRewrite: next });
          if (!d.ok) {
            midSystemRewriteToggle.checked = !next;
            toast("设置保存失败", true);
          } else {
            const saved = d.settings?.midSystemRewrite;
            if (typeof saved === "boolean") midSystemRewriteToggle.checked = saved;
            toast(next ? "已开启会话缓存优化" : "已关闭会话缓存优化");
          }
        } catch (e) {
          midSystemRewriteToggle.checked = !next;
          toast(panelError(e, "请求失败"), true);
        } finally {
          settingsSaving.midSystemRewrite = false;
          midSystemRewriteToggle.removeAttribute("aria-busy");
        }
      };
    }

    // 接管默认模型总开关：关 = 四行收起 + 映射暂停生效（服务端 loadSettings
    // 直接返回空映射），已填的值保留不清；开 = 四行展开、按已存值显示。
    if (claudeTierEnabledToggle) {
      claudeTierEnabledToggle.onchange = async () => {
        if (settingsSaving.claudeTierEnabled) {
          claudeTierEnabledToggle.checked = !claudeTierEnabledToggle.checked;
          return;
        }
        const next = claudeTierEnabledToggle.checked;
        settingsSaving.claudeTierEnabled = true;
        settingsLoadGen += 1;
        claudeTierEnabledToggle.setAttribute("aria-busy", "true");
        try {
          const d = await api("POST", "/api/settings", { claudeTierMappingsEnabled: next });
          if (!d.ok) {
            claudeTierEnabledToggle.checked = !next;
            toast("设置保存失败", true);
          } else {
            const saved = d.settings?.claudeTierMappingsEnabled;
            if (typeof saved === "boolean") claudeTierEnabledToggle.checked = saved;
            claudeTierEnabled = saved !== false;
            applyClaudeTierUi();
            toast(next ? "已开启默认模型接管" : "已暂停默认模型接管");
          }
        } catch (e) {
          claudeTierEnabledToggle.checked = !next;
          toast(panelError(e, "请求失败"), true);
        } finally {
          settingsSaving.claudeTierEnabled = false;
          claudeTierEnabledToggle.removeAttribute("aria-busy");
        }
      };
    }

    loadSettingsState();
  }

  // Terminal sessions are now backed by the persistent PTY host. The old mock
  // records remain as a shape reference for the inspector, but are not used as
  // a data source once the terminal page connects.
  const terminalPreviewSessions = {
    checkout: {
      // 归属链：终端会话 → shell 进程 → 检测到的 Agent 进程/实例 → 请求、指标与路由都挂在实例号下；
      // 归属只认进程与实例号，不从终端输出文本里猜。Agent 退出后会话保留终端自身状态，监测区随 agent 一并隐藏。
      label: "demo-service", cwd: "D:\\dev\\demo-service", branch: "main",
      shell: { name: "PowerShell", pid: 23140 },
      agent: { name: "Codex CLI", endpointId: "codex", instanceId: "codex-23140", pid: 24512 },
      status: "working",
      metrics: {
        activeRequests: 1,
        ttft: "0.86", ttftLamp: "green",
        tps: "42.6",
        cache: "61",
        workTime: "12 分 10 秒",
        requestCount: 14,
        tokens: "Prompt: 128,460 · Completion: 31,204 · Cached: 96,080",
        sparkTtft: [0.92, 0.88, 1.05, 0.97, 0.84, 0.79, 0.91, 0.86, 0.9, 0.83, 0.88, 0.95, 0.87, 0.82, 0.86, 0.86],
        sparkTps: [38, 41, 36, 44, 47, 39, 42, 45, 40, 43, 46, 41, 44, 42, 43, 42.6],
        sparkCache: [52, 55, 58, 54, 60, 63, 59, 62, 64, 61, 65, 63, 66, 62, 64, 61],
      },
      route: [
        { node: "north-main", model: "kimi-k3" },
        { node: "sensenova", model: "kimi-k3" },
        { node: "sensenova-backup2", model: "kimi-k3" },
        { node: "sensenova-backup3", model: "kimi-k3" },
        { node: "sensenova-backup1", model: "kimi-k3" },
        { node: "sensenova-main", model: "kimi-k3" },
      ],
      routeCurrent: 0,
      requests: [
        { model: "kimi-k3", provider: "north-main", metric: "1.82s", detail: "生成中 · 2,418 tokens", state: "ok" },
        { model: "kimi-k3", provider: "north-main", metric: "0.94s", detail: "完成 · 1,106 tokens", state: "ok" },
        { model: "kimi-k3", provider: "sensenova", metric: "3.10s", detail: "完成 · 842 tokens", state: "ok" },
      ],
      output: [
        ["dim", "Windows PowerShell"],
        ["dim", "Copyright (C) Microsoft Corporation. All rights reserved."],
        ["", ""],
        ["prompt-line", "PS D:\\dev\\demo-service> "],
        ["command-line", "codex --model kimi-k3"],
        ["dim", "╭──────────────────────────────────────────────────────────────╮"],
        ["agent-line", "│ Codex CLI                                             v0.154.0 │"],
        ["dim", "╰──────────────────────────────────────────────────────────────╯"],
        ["", ""],
        ["info-line", "  project  demo-service"],
        ["info-line", "  branch   main"],
        ["info-line", "  model    kimi-k3 · north-main"],
        ["", ""],
        ["agent-line", "› 检查支付回调的错误处理，并补充失败重试测试"],
        ["", ""],
        ["tool-line", "  ◇ 读取 src/payments/webhook.ts"],
        ["tool-line", "  ◇ 读取 src/payments/retry-policy.ts"],
        ["success-line", "  ✓ 找到 2 处未处理的超时异常"],
        ["", ""],
        ["agent-line", "  正在生成修改方案…"],
      ],
    },
    portal: {
      label: "portal", cwd: "D:\\dev\\portal", branch: "feature/permissions",
      shell: { name: "命令提示符", pid: 18972 },
      agent: { name: "Claude Code", endpointId: "claude", instanceId: "claude-18972", pid: 19084 },
      status: "idle",
      metrics: {
        activeRequests: 0,
        ttft: "1.32", ttftLamp: "yellow",
        tps: "35.4",
        cache: "58",
        workTime: "33 分 51 秒",
        requestCount: 9,
        tokens: "Prompt: 96,210 · Completion: 24,108 · Cached: 71,400",
        sparkTtft: [1.08, 1.14, 1.22, 1.1, 1.18, 1.26, 1.2, 1.32, 1.24, 1.3, 1.28, 1.36, 1.31, 1.29, 1.33, 1.32],
        sparkTps: [33, 36, 34, 38, 35, 37, 34, 36, 35, 38, 36, 34, 37, 35, 36, 35.4],
        sparkCache: [48, 51, 53, 50, 55, 57, 54, 58, 56, 59, 57, 60, 58, 61, 59, 58],
      },
      route: [
        { node: "north-main", model: "claude-sonnet", state: "failed" },
        { node: "sensenova", model: "claude-sonnet", state: "failed" },
        { node: "sensenova-backup2", model: "claude-sonnet" },
        { node: "sensenova-backup3", model: "claude-sonnet" },
        { node: "sensenova-backup1", model: "claude-sonnet" },
      ],
      routeCurrent: 2,
      requests: [
        { model: "claude-sonnet", provider: "north-main", metric: "1.14s", detail: "完成 · 3,820 tokens", state: "ok" },
        { model: "claude-sonnet", provider: "north-main", metric: "0.88s", detail: "完成 · 1,672 tokens", state: "ok" },
        { model: "claude-sonnet", provider: "north-main", metric: "—", detail: "上一轮请求", state: "ok" },
      ],
      output: [
        ["dim", "Microsoft Windows [Version 10.0.26100.6584]"],
        ["dim", "(c) Microsoft Corporation. All rights reserved."],
        ["", ""],
        ["prompt-line", "D:\\dev\\portal> "],
        ["command-line", "claude"],
        ["dim", "╭──────────────────────────────────────────────────────────────╮"],
        ["agent-line", "│ Claude Code                                      Sonnet 4.5 │"],
        ["dim", "╰──────────────────────────────────────────────────────────────╯"],
        ["", ""],
        ["success-line", "  ✓ 已完成权限矩阵重构"],
        ["info-line", "  12 个文件已更新 · 36 项测试通过"],
        ["", ""],
        ["prompt-line", "D:\\dev\\portal> "],
        ["command-line", "git status --short"],
        ["info-line", " M src/auth/permissions.ts"],
        ["info-line", " M src/routes/admin.ts"],
        ["", ""],
        ["dim", "等待输入…"],
      ],
    },
  };
  // 活跃终端会话指针：页签条/会话栏/inspector/归属恢复读写。"checkout" 是预览稿种子
  // 的首会话键（后端就绪前渲染预览稿用）；rebuildTerminalBackendSessions 回读存档后
  // 改写为真实会话 id。
  let activeTerminalPreviewId = "checkout";
  let terminalBackendSessions = {};
  // 上一次看到的窗口可见性，只为"漏掉的转折"服务（见轮询兜底拍与 syncTerminalDataStream）。
  let terminalVisibilityWasHidden = false;
  // 活跃真值流：panel 转发的 relay 工作/空闲绝对态 SSE。轮询（1s）仍是校准
  // 与指标数据源；这个流只负责把工作/空闲与在途请求数即时落到标签与实况行。
  let terminalActivitySource = null;
  let terminalEventSource = null;
  let terminalXterm = null;
  let terminalFitAddon = null;
  let terminalWebglAddon = null;
  // 宿主尺寸观察：inspector 收放、字号变化等任何改变终端区宽度的动作都不经
  // window resize，只挂窗口监听会漏掉——直接观察宿主元素，变动走同一防抖入口。
  let terminalHostResizeObserver = null;
  // 像素密度监视：显示缩放/睡眠唤醒会改 devicePixelRatio 而 CSS 布局宽度不变（窗口
  // 随 DPI 等比伸缩），宿主 RO 与 window resize 全看不见；WebGL 渲染器按整设备像素
  // 量化字宽，密度一变屏宽=cols×新 cell 直接跳变而 cols/PTY 不动——挂 resolution
  // 媒体查询补这条通路，否则跳变后没有下一次 fit 就卡死在错配态（2026-10-22 根因）。
  let terminalDprMediaQuery = null;
  let terminalDprMediaHandler = null;
  let terminalInputDisposable = null;
  // 定投会话 id：connectTerminalStream 建连时固化、closeTerminalStream 清空，值与
  // onData 闭包内的定投局部量同。附着在 xterm 实例上的键位处理器不再随连接重建
  // 闭包，改经此量读到与 onData 一致的定投目标，同样不读活动会话。
  let terminalBoundSessionId = null;
  // 输入法锚点：组字期间钉住隐藏输入框。空闲为 null；组字中为 { textarea, compositionView }。
  let terminalImeHold = null;
  let terminalImeHoldFrame = null;
  let terminalImeFitPending = false;
  let terminalImeAnchorTextarea = null;
  // 组字锚点的折叠补正要读实例缓冲（见 armTerminalImeAnchor）：装配时固化，关流清空。
  let terminalImeAnchorTerm = null;
  // 组字事件的挂/摘按引用配对（IME 锚点三件套装配时固化）。
  let terminalImeArmHandler = null;
  let terminalImeReleaseHandler = null;
  // 底部自动对齐（installTerminalBottomAlign）：最近一次用户上滚意图时间戳与
  // 已排队的裁剪帧。
  let terminalBottomAlignIntentAt = 0;
  let terminalBottomAlignTrimFrame = null;
  // 回放闩（见 installTerminalFollowBottomGuard）：reset() 后与回放写入期间的
  // 滚动不是用户滚动，闩住时护栏零动作。arm 排静默清闩定时器，cancel 在实例
  // 销毁时撤销它。
  let terminalReplayRestoring = false;
  let terminalReplayRestoreArm = null;
  let terminalReplayRestoreCancel = null;
  // 同步输出合帧（见 connectTerminalStream）：撤掉未闭合块的兜底定时器并丢弃
  // 其字节。连接重建时指向新连接的闭包，关流时由 closeTerminalStream 调一次。
  let terminalStreamSyncCancel = null;
  // 同步合帧写者（connectTerminalStream 赋值）：burst 冲刷经它进合帧层，保证
  // 两层缓冲对 term 的写入顺序不乱。关流时清空，回退直写。
  let terminalStreamWrite = null;
  // 回放突发合并（见 queueTerminalChunk）：进行中的突发 { term, chunks, bytes,
  // quietTimer, capTimer }，空闲为 null。
  let terminalWriteBurst = null;
  // 建连后「宿主的自足整屏重绘」那一帧还没到：它由 stream() 单帧发出，不需要
  // 合并，直接写；收到即清。
  let terminalReplayFramePending = false;
  let terminalBackendReady = false;
  // 空壳侧栏锁存（renderTerminalSessionData 的收拢状态机）：系统收拢标记记
  // 「当前 is-collapsed 是空壳自动收的」，归属恢复时只展开这一次；用户锁定集合
  // 记「用户在哪个空壳会话手动拉回过」，该会话保持空壳期间轮询不再收拢（防
  // 1s 轮询与用户意图拉锯）。
  let terminalInspectorHollowCollapsed = false;
  const terminalInspectorUserPinned = new Set();
  // 空壳塌缩防抖：归属轮询在「归属丢失/恢复」的边界上会闪一帧空 agent——面板按
  // 进程祖先链认领会话，检测面一拍缺席（agent 进程起落、relay 短暂没喂检测数据）
  // 这一拍整批会话就变空壳。原逻辑当拍即收拢、下一拍归属回来又展开，340↔48px 的
  // 宽度跳变每下都逼终端区整屏重排，用户看到的就是侧栏「抽搐」。改为同一会话连续
  // 3 拍归属观测都空壳才认「真丢了归属」：计数按会话 id 存这张模块级 Map，只在归
  // 属数据拍（rebuildTerminalBackendSessions 重建，见其注释）推进——SSE 活跃帧、
  // 页签切换等触发的重渲不推进，否则多开时他端活跃亚秒内凑满 3 拍，防抖窗口名存
  // 实亡；归属恢复的观测拍清零。会话关闭（关标签 / 关停清场 / 轮询重建后消失）走
  // pruneTerminalHollowStreak 一并清，不让陈旧计数串到同 id 的下一代会话。防抖只
  // 改塌缩触发时机，上面两条锁存规则（用户钉住 / 系统收拢标记）原样。
  const TERMINAL_HOLLOW_COLLAPSE_STREAK = 3;
  const terminalHollowStreak = new Map();
  // done（跑完未读）标记：dsh completed/completionUnread 的前端同构。后台会话
  // working→idle 翻转且非当前聚焦 → 置位（见 noteTerminalWorkingStatus）；清除＝
  // 聚焦该终端（每拍聚焦即清）/点它的会话栏行/向它发键入/会话退出或关闭。
  // 上一拍状态表 terminalPrevWorking 用来识别真实观测到的翻转：初拍（刷新后
  // 首见、无上一拍）不置——不拿「刷新前它在跑」的想象补标。两张表都是内存态、
  // 不持久化：面板刷新即清（与 dsh 同口径——completed 本就是事件派生非持久）。
  const terminalDoneUnread = new Map();
  const terminalPrevWorking = new Map();
  // 回合闸（terminalSessionBusyFromSignals 的状态位）：输出活跃窗只在本轮对话回合
  // 内算数。agent 会话空闲时 TUI 自己也会往 PTY 写字节（启动重绘、提示行轮换、
  // 光标/动画帧），只看「5s 内出过字节」会把空闲页点亮成进行中。回合的起点取
  // 「该实例出现在途请求」，终点取「无在途请求且输出窗过期」。内存态、不持久化，
  // 与上面两张表同生命周期（关会话、轮询重建后消失即清）。
  const terminalTurnArmed = new Set();
  // 首连定性位：false = 面板刚装载、会话列表请求还在飞（实测一个往返 16–41ms）。
  // 这一窗不落「终端不可用」——刷新恢复直接落进终端页时，那一帧的空白是「还不知道」
  // 而不是「服务没了」，把降级空态画出来再收走就是自己造一次闪烁。
  let terminalFirstConnectSettled = false;
  // 终端页位置存档，形状照设置页那次定案：panel-view 继续只存主视图（它是设置页
  // 「←退出」的目标），「停在终端页」记 panel-terminal-open（switchView 写、
  // restoreView 读），「看着哪个标签」记 panel-terminal-session（下面两个助手）。
  // 键名一律用字面量：restoreView 会被测试抽进桩环境真跑，那份环境只有 localStorage。

  function storedTerminalSessionId() {
    try { return localStorage.getItem("panel-terminal-session"); } catch { return null; }
  }

  // 只记后端会话：预览稿的假 id（"preview-N"）不进存档，否则下一次恢复会拿一个
  // 服务端根本不存在的 id 去认领。
  function rememberTerminalSessionId(id) {
    if (typeof id === "string" && id.startsWith("preview-")) id = null;
    try {
      if (id) localStorage.setItem("panel-terminal-session", id);
      else localStorage.removeItem("panel-terminal-session");
    } catch {}
  }

  // 归属数据轮询：1s 一拍（与看板同节奏），窗口隐藏 / 不在终端页时不取数；
  // 在飞守卫保证失败帧不会叠加（api 失败时保留上一帧画面）。
  let terminalPollTimer = null;
  let terminalPollInFlight = false;
  let terminalFontSize = 13;

  function clampTerminalFontSize(value) {
    const size = Number.parseInt(value, 10);
    if (!Number.isFinite(size)) return 13;
    return Math.min(24, Math.max(10, size));
  }

  function terminalFontSizeFromStored(raw) {
    const size = Number.parseInt(raw, 10);
    if (!Number.isFinite(size) || size < 10 || size > 24) return 13;
    return size;
  }

  function applyTerminalFontSize(size, { persist = true } = {}) {
    terminalFontSize = clampTerminalFontSize(size);
    const readout = $("terminalFontSizeValue");
    if (readout) readout.textContent = String(terminalFontSize);
    // 字号是全局单值：套到唯一 xterm 实例并 fit。
    if (terminalXterm) {
      terminalXterm.options.fontSize = terminalFontSize;
      fitTerminalXterm();
    }
    if (persist) try { localStorage.setItem("panel-terminal-font-size", String(terminalFontSize)); } catch {}
  }

  function nudgeTerminalFontSize(delta) {
    applyTerminalFontSize(terminalFontSize + delta);
  }

  function restoreTerminalFontSize() {
    let raw = null;
    try { raw = localStorage.getItem("panel-terminal-font-size"); } catch {}
    applyTerminalFontSize(raw === null ? 13 : terminalFontSizeFromStored(raw), { persist: false });
  }

  function isTerminalFontZoomKey(event) {
    if (!event.ctrlKey) return 0;
    if (event.key === "+" || event.key === "=" || event.code === "NumpadAdd") return 1;
    if (event.key === "-" || event.code === "NumpadSubtract") return -1;
    return 0;
  }

  // 剪贴板键位意图：只认裸 Ctrl+C / Ctrl+V。带 Shift/Alt/Meta 的组合一律不
  // 接管——Ctrl+Shift+C / Ctrl+Shift+V 是 xterm 放行给浏览器的既有可用通路
  // （复制 / 粘贴为纯文本），保持原样。
  function terminalClipboardKeyIntent(event) {
    if (!event || event.type !== "keydown") return null;
    if (!event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return null;
    const key = typeof event.key === "string" ? event.key.toLowerCase() : "";
    if (key === "v") return "paste";
    if (key === "c") return "copy";
    return null;
  }

  // 换行键位意图：只认不带 Alt/Meta 的 Ctrl+Enter / Shift+Enter，keydown 与其后的
  // keypress 两条都要认——内核在 keydown 之后还会吃 keypress，Shift+Enter 的那一条
  // （charCode 13）会被折叠成普通 "\r" 补发，真机上的表现是「先换行、紧接着发送」；
  // Ctrl+Enter 的 keypress 不折叠，所以只有 Shift 侧漏。内核求值 Enter 只保留 Alt，
  // Ctrl/Shift 被忽略。拦下这类键改定投换行字节，字节内容按会话端点分派（见
  // terminalNewlineData）：opencode 与 Claude Code 这类读原始字节流的 Node TUI 在
  // 拿不到 kitty 键盘协议的终端里，换行绑定可直接靠 ctrl+j（LF 字节）触发；codex
  // 这类读 Windows 控制台键事件的 TUI 则改发 ESC CR 命中其 alt(Enter) 换行绑定。
  // 拦截与投递分家：这条键任何时候都不许回到内核求值，组字态则只拦不发（见下）。
  function terminalNewlineEnterKey(event) {
    if (!event || (event.type !== "keydown" && event.type !== "keypress")) return false;
    if (event.key !== "Enter") return false;
    if (!event.ctrlKey && !event.shiftKey) return false;
    if (event.altKey || event.metaKey) return false;
    return true;
  }

  // 换行字节的投递闸门：组字态（isComposing / keyCode 229）这条键归输入法提交候选词，
  // 面板只把键从内核求值里摘出来、不替用户发字节——候选词由内核的 compositionend 通路
  // 上屏（实测照旧发出），要换行等字上屏后再按一次即可；兜底转发已经投过的那一条
  // （defaultPrevented）也不再第二次投，一次按键只落一个换行字节。
  function terminalNewlineDeliveryBlocked(event) {
    if (!event) return false;
    return !!(event.isComposing || event.keyCode === 229 || event.defaultPrevented);
  }

  // 换行字节按会话端点分派。读原始字节流的 Node TUI（opencode/Claude Code 等）拿
  // 单字节 LF（ctrl+j 换行语义）；codex 是 Rust/crossterm TUI，从 Windows 控制台读
  // 键事件，ConPTY 会把 LF 转译成无修饰符的普通 Enter 键事件被当成提交——对 codex
  // 改发 ESC CR（Alt+Enter 经典编码），ConPTY 产出 Enter+ALT 键事件，命中 codex
  // 默认 keymap 的 alt(Enter) 换行绑定。绝不能对其它端点发 ESC CR：读原始字节的
  // TUI 会把它解析成「Esc 再回车」两个字节而误提交。端点识别两条叠加：一键启动的
  // 会话看 terminal-host 快照携带的 agentId；纯 shell 里手动启动的看归属轮询注入的
  // agent.endpointId。两条都识别不上（含归属轮询落地前的那一拍）维持 LF——换行
  // 不生效但不误提交。
  function terminalNewlineData(session) {
    const endpointId = session?.agentId || session?.agent?.endpointId || null;
    return endpointId === "codex" ? "\x1b\r" : "\n";
  }

  // 新终端的默认工作目录跟随当前用户主目录，由终端宿主接口给出（谁的机器就是
  // 谁的），绝不写死、也绝不落到软件安装目录。前端启动时向 /api/terminal/
  // default-cwd 取一次并缓存；接口未就绪前用空串占位，输入框留空、创建时由后端
  // safeCwd 兜底，两者都不会指到本体目录。
  let terminalDefaultCwd = "";

  // 用户在新建菜单里改过一次目录后记住它：下次预填上次的目录，而不是每次回到默认。
  // 与字号、主题同级，走 localStorage。
  function rememberTerminalCwd(cwd) {
    if (!cwd) return;
    try { localStorage.setItem("panel-terminal-cwd", cwd); } catch {}
  }

  function loadTerminalCwd() {
    try { return localStorage.getItem("panel-terminal-cwd") || ""; } catch { return ""; }
  }

  // 新建菜单输入框的取值顺序：上次用过的目录 → 后端给的主目录默认。
  function terminalCwdInitial() {
    return loadTerminalCwd() || terminalDefaultCwd || "";
  }

  // 拉取一次默认目录并缓存。失败静默：默认值留空，创建时由后端兜底。
  function fetchTerminalDefaultCwd() {
    return api("GET", "/api/terminal/default-cwd")
      .then((d) => { if (d && typeof d.cwd === "string" && d.cwd) terminalDefaultCwd = d.cwd; })
      .catch(() => {});
  }

  function terminalSessionMap() {
    return terminalBackendReady ? terminalBackendSessions : terminalPreviewSessions;
  }

  function terminalSessionFor(id) {
    return terminalSessionMap()[id] || null;
  }

  function terminalBackendSession(item) {
    return {
      id: item.id,
      label: item.label || "Anyswitch",
      cwd: item.cwd || terminalDefaultCwd,
      branch: "",
      shell: { name: item.shell === "cmd" ? "命令提示符" : "PowerShell", pid: item.pid || "—" },
      // 归属接线：panel 层已按 shell pid ↔ 检测进程祖先链注入 agent 字段
      //（无归属的会话不带此键，保持纯外壳）。
      agent: item.agent && typeof item.agent === "object" ? item.agent : null,
      // 一键启动的 CLI Agent 会话：terminal-host 快照直接带这两个非密字段，
      // 归属轮询落地前标签就能显示是哪个 agent。
      agentId: typeof item.agentId === "string" ? item.agentId : null,
      agentName: typeof item.agentName === "string" ? item.agentName : null,
      // 续接身份（M7 S5）：这条终端是替哪条会话续接建的（宿主记录、随列表下发）。
      // 历史会话点击时先查它——同 endpoint＋同会话 id 的终端已开着就直接聚焦，
      // 不重复建。全新终端（无 resume 记录）不参与去重。
      resume: item.resume && typeof item.resume === "object"
        && typeof item.resume.endpoint === "string" && typeof item.resume.id === "string"
        ? { endpoint: item.resume.endpoint, id: item.resume.id }
        : null,
      status: item.status === "running" ? "idle" : "idle",
      metrics: null,
      route: [],
      routeCurrent: 0,
      requests: [],
      output: [],
      backend: true,
      backendState: item,
    };
  }

  // ---- 归属后展示口径 ----
  // 终端页的指标 / 路由 / 请求全部按看板同一数据口径取数：面板 agents 负载
  // 里按 instanceId 找实例行（聚合端点的行挂在 sessions 下）。
  function terminalInstanceRow(agentsPayload, agent) {
    if (!agent || !agent.instanceId || !Array.isArray(agentsPayload)) return null;
    const endpoint = agentsPayload.find((item) => item && item.id === agent.endpointId);
    if (!endpoint) return null;
    const rows = Array.isArray(endpoint.instances)
      ? endpoint.instances
      : (Array.isArray(endpoint.sessions) ? endpoint.sessions : []);
    return rows.find((inst) => inst && inst.id === agent.instanceId) || null;
  }

  function terminalMetricNum(value, digits = 1) {
    return typeof value === "number" && Number.isFinite(value) ? value.toFixed(digits) : "—";
  }

  // 已工作时间并轨其他三格的「数字 + 小单位」排印：取最大单位整数截断
  //（秒/分钟/小时/天），不再把「12分10秒」式长中文串塞进 16px 等宽数值位。
  function terminalWorkTime(ms) {
    const s = Math.floor((typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? ms : 0) / 1000);
    if (s < 60) return { workTime: String(s), workTimeUnit: "秒" };
    const m = Math.floor(s / 60);
    if (m < 60) return { workTime: String(m), workTimeUnit: "分钟" };
    const h = Math.floor(m / 60);
    if (h < 24) return { workTime: String(h), workTimeUnit: "小时" };
    return { workTime: String(Math.floor(h / 24)), workTimeUnit: "天" };
  }

  function terminalMetricsFromInstance(inst) {
    if (!inst) return null;
    const tokens = inst.tokens || {};
    const fmt = (n) => (typeof n === "number" && Number.isFinite(n) ? n.toLocaleString("en-US") : "0");
    return {
      activeRequests: typeof inst.activeRequests === "number" ? inst.activeRequests : 0,
      ttft: typeof inst.lastTtftMs === "number" && inst.lastTtftMs > 0 ? (inst.lastTtftMs / 1000).toFixed(2) : "—",
      ttftLamp: typeof inst.ttftColor === "string" ? inst.ttftColor : "gray",
      tps: terminalMetricNum(inst.tps),
      cache: typeof inst.cacheHitRate === "number" && Number.isFinite(inst.cacheHitRate) ? String(Math.round(inst.cacheHitRate)) : "—",
      ...terminalWorkTime(inst.activeDurationMs),
      requestCount: typeof inst.requests === "number" ? inst.requests : 0,
      // 实例身份（reporter 快照的 model/providerId，null 直至上报）：实况行
      // 「谁在服务」的首选数据源，auto 链缺位时回落路由当前跳。
      model: typeof inst.model === "string" ? inst.model : "",
      providerId: typeof inst.providerId === "string" ? inst.providerId : "",
      tokens: `Prompt: ${fmt(tokens.prompt)} · Completion: ${fmt(tokens.completion)} · Cached: ${fmt(tokens.cached)}`,
      sparkTtft: Array.isArray(inst.sparkHistory?.ttft) ? inst.sparkHistory.ttft : [],
      sparkTps: Array.isArray(inst.sparkHistory?.tps) ? inst.sparkHistory.tps : [],
      sparkCache: Array.isArray(inst.sparkHistory?.cache) ? inst.sparkHistory.cache : [],
    };
  }

  // 「当前确实在自动路由」vs「只配了链」：runtime 对每条启用链都下发条目
  //（current 缺省为链首、lamps 全灰时把链首强制点亮），所以「有条目」只证明
  // 配了链。真实走过链的证据只有两样——positions = 本 process 里链机制记过的
  // 粘性位置（首个请求走完 noteSuccess 就记下），红灯 = 节点已被降级退避
  //（CHAIN_DEMOTE_AFTER_FAILURES 次连续失败）。一样都没有 = 本次启动没人走
  // 过这条链：视为「不在自动路由」，不拿配置链冒充态。
  function terminalAutoRouteLive(rt) {
    if (!rt) return false;
    if (Array.isArray(rt.positions) && rt.positions.length > 0) return true;
    return Array.isArray(rt.lamps) && rt.lamps.includes("red");
  }

  // 路由链运行态：链配置给节点序列（含各跳属性），运行快照给当前跳与不可用
  // 节点。证据收口在这里——端点未配启用链、runtime 缺位、或只有配置没有本次
  // 运行的路由证据（terminalAutoRouteLive）一律空链；实况行归属
  //（terminalServingLabel）只在实例身份缺位（auto 链）时取当前跳作后备，
  // 普通终端无 agent 归属在 enrich 处就已给空链。
  function terminalRouteForEndpoint(endpointId, chains, runtimeCache) {
    const entry = (Array.isArray(chains) ? chains : []).find(
      (item) => item && item.endpointId === endpointId && Array.isArray(item.chain) && item.chain.length > 0 && item.enabled !== false,
    );
    if (!entry) return { route: [], routeCurrent: 0 };
    const rt = runtimeCache && typeof runtimeCache === "object" ? runtimeCache[endpointId] : null;
    if (!terminalAutoRouteLive(rt)) return { route: [], routeCurrent: 0 };
    const route = entry.chain.map((node, index) => ({
      node: node.node,
      model: node.model,
      ...(Array.isArray(rt?.lamps) && rt.lamps[index] === "red" ? { state: "failed" } : {}),
    }));
    let routeCurrent = 0;
    if (rt?.current) {
      const idx = entry.chain.findIndex((node) => node.node === rt.current.node && node.model === rt.current.model);
      if (idx >= 0) routeCurrent = idx;
    }
    return { route, routeCurrent };
  }

  // 实况行「谁在服务」标签：优先实例身份（metrics.model/providerId，看板胶囊
  // 同一口径 routeNodeName/模型名），缺位或虚拟 auto 时回落路由当前跳——auto
  // 链的真实服务方只在路由运行态里。两头都没有 = 没有可说的服务方，归空串。
  function terminalServingLabel(session) {
    const usable = (providerId, model) => hasDisplayIdentity(providerId, model) && model !== "auto";
    const metrics = session?.metrics;
    if (metrics && usable(metrics.providerId, metrics.model)) return capsuleLabel(metrics.providerId, metrics.model);
    const route = Array.isArray(session?.route) ? session.route : [];
    if (route.length > 0) {
      const hop = route[Math.max(0, Math.min(session.routeCurrent ?? 0, route.length - 1))];
      if (hop && usable(hop.node, hop.model)) return capsuleLabel(hop.node, hop.model);
    }
    return "";
  }

  // 最近请求：失败行的展开态集合（行键 = ts|providerId|model，与大板 logsRowKey
  // 同形）；点击失败行切换展开，1s 轮询重建列表时按此集合恢复。
  const terminalRequestExpanded = new Set();

  // 最近请求：usage journal 的结算行，与统计页请求日志同一份字段口径
  // （metric 取 TTFT，metricColor 取看板同款语义色）。右栏两行由数据层直接
  // 成形：成功行 io=输入/输出 tokens、cache=缓存命中（cached 为 0 不出灰字）；
  // 失败行只留 fail=失败类型码，不出 token 行（对齐请求日志大板「失败 429」
  // 徽标）。失败行额外保留 status/errMsg/durationMs，供点击展开的错误详情
  // 使用；key 即大板 logsRowKey 同形，用于跨轮询记忆展开态。
  function terminalRequestsFromRows(rows) {
    if (!Array.isArray(rows)) return [];
    return rows.map((row) => {
      const failed = row?.ok === false;
      const statusText = row?.status === null || row?.status === undefined || row?.status === "" ? "" : String(row.status);
      const ts = Number(row?.ts);
      let at = "";
      let rel = "";
      if (Number.isFinite(ts) && ts > 0) {
        const d = new Date(ts);
        const p = (n) => String(n).padStart(2, "0");
        at = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
        rel = `${p(d.getHours())}:${p(d.getMinutes())}`;
      }
      const prompt = Number(row?.prompt) || 0;
      const completion = Number(row?.completion) || 0;
      const cached = Number(row?.cached) || 0;
      const num = (n) => n.toLocaleString("en-US");
      return {
        model: typeof row?.model === "string" && row.model ? row.model : "—",
        provider: typeof row?.providerId === "string" && row.providerId ? row.providerId : "—",
        metric: typeof row?.ttftMs === "number" && row.ttftMs > 0 ? `${(row.ttftMs / 1000).toFixed(2)}s` : "—",
        metricColor: terminalTtftColor(row?.ttftMs),
        io: failed ? "" : `${num(prompt)} / ${num(completion)}`,
        cache: !failed && cached > 0 ? `缓存 ${num(cached)}` : "",
        fail: failed ? `失败${statusText ? " · " + statusText : ""}` : "",
        state: failed ? "failed" : "ok",
        rel,
        key: `${row?.ts ?? ""}|${typeof row?.providerId === "string" ? row.providerId : ""}|${typeof row?.model === "string" ? row.model : ""}`,
        errMsg: typeof row?.errMsg === "string" ? row.errMsg : "",
        at,
        duration: typeof row?.durationMs === "number" && row.durationMs > 0 ? `${(row.durationMs / 1000).toFixed(1)}s` : "",
      };
    });
  }

  // 首字响应时间的语义色：分档与看板 TTFT 灯同源（阈值见 agent-metrics.mjs 的
  // TTFT_THRESHOLDS / getTtftColor），panel.test.mjs 有逐边界同源钉死——只改
  // 一边会让对拍测试转红。无样本（null/非数/≤0）置灰。
  function terminalTtftColor(ttftMs) {
    if (typeof ttftMs !== "number" || isNaN(ttftMs) || ttftMs <= 0) return "gray";
    if (ttftMs < 5000) return "green";
    if (ttftMs <= 15000) return "yellow";
    return "red";
  }

  // 最近请求行三段：左=状态点+身份两行（lead 内 flex 横排；上=模型名大字，下=绝对时间
  // HH:MM · 来源显示名小灰字，溢出省略号）+ 中栏首字响应时间（看板同款红黄绿语义色，
  // 左右两列等宽吃余量，中列被对称夹住落整行几何中点）+ 右栏数据两行右对齐贴行右缘
  // （上=输入/输出 tokens 12px 收档字、斜杠两侧带空隙，下=缓存命中灰字）。label 是
  // 来源显示名（routeNodeName 同口径，未命中回落原始 id）。失败行右栏只留失败
  // 类型码（对齐请求日志大板「失败 429」徽标），不出 token 行，且可点击展开错误
  // 信息——展开态由调用方以行键记忆，轮询重建不丢。
  function terminalRequestItemHtml(req, source) {
    const label = typeof source?.label === "string" && source.label ? source.label : req.provider;
    const failed = req.state === "failed";
    const sub = req.rel ? `${escapeHtml(req.rel)} · ${escapeHtml(label)}` : escapeHtml(label);
    const metricColor = ["green", "yellow", "red", "gray"].includes(req.metricColor) ? req.metricColor : "gray";
    let expand = "";
    if (failed && source?.expanded) {
      const meta = [req.at ? `时间 ${req.at}` : "", req.duration ? `耗时 ${req.duration}` : ""].filter(Boolean).join(" · ");
      expand = `
      <div class="terminal-request-expand">
        ${req.errMsg ? `<div class="terminal-request-err">${escapeHtml(req.errMsg)}</div>` : ""}
        ${meta ? `<div class="terminal-request-expand-meta">${escapeHtml(meta)}</div>` : ""}
      </div>`;
    }
    const data = failed
      ? `<span class="terminal-request-detail is-failed">${escapeHtml(req.fail)}</span>`
      : `<span class="terminal-request-io">${escapeHtml(req.io)}</span>${req.cache ? `
            <span class="terminal-request-cache">${escapeHtml(req.cache)}</span>` : ""}`;
    return `
      <div class="terminal-request-item${failed ? " is-failed is-expandable" : ""}"${failed ? ` data-req-key="${escapeHtml(req.key)}"` : ""}>
        <div class="terminal-request-lead">
          <i class="terminal-request-dot${failed ? " is-failed" : ""}"></i>
          <div class="terminal-request-main">
            <strong>${escapeHtml(req.model)}</strong>
            <span>${sub}</span>
          </div>
        </div>
        <span class="terminal-request-metric is-${metricColor}">${escapeHtml(req.metric)}</span>
        <div class="terminal-request-data">
          ${data}
        </div>
      </div>${expand}`;
  }

  // ---- 活跃真值推送（工作/空闲即时落地） ----
  // relay 推 (endpointId, instanceId) 绝对状态，帧对键成对匹配 session.agent；
  // instanceId 为 null 的帧是端点级真值，只匹配同样未归属实例的会话，不放大到
  // 端点下所有实例会话。
  function terminalActivityKey(endpointId, instanceId) {
    return `${endpointId} ${instanceId ?? ""}`;
  }

  // 输出活跃窗：宿主 lastActiveAt（每块输出、退出时刷新；键入不刷新——键入记
  // lastInputAt 另走键入抑制窗）在窗内即视为在跑。relay 只对「模型在想」权威；
  // agent 执行工具命令的整段时间请求数是零，只看请求会把在跑的命令判成空闲
  // （页签/会话栏误显空闲＋内切判定门误放行的同源根因）。窗取 5s：跑命令的进度
  // 输出会持续刷新它，等输入静默几秒后回落空闲。窗与时刻可注入（vm 沙盒测试）。
  // 输出窗的输入面有两处污染，各用一只豁免窗收窄（dsh 的 running 是「回合在跑」
  // 布尔位、信号在 agent 进程内部拿不到，这里是在它缺席下的替代信号）：
  //  · 孵化窗 15s——新 shell 的 banner 与续接重放（宿主把盘上尾巴回放给终端）
  //    实测 6–12s，出生 15s 内的输出活跃一律不当「在跑」（出生≠活跃），窗值取
  //    实测上界再留一拍余量；出生点锚 spawnedAt（进程生日，内切/复活跟着走），
  //    老宿主快照没有时回落 createdAt。
  //  · 键入抑制窗 2s——PTY 对键入的回显会走 emit 顶进输出窗，把「用户在打字」
  //    误归因成「agent 在跑」；距最近一次键入 2s 内的输出活跃不判忙（回显随
  //    键入即时出现，静默 2s 后的输出才是程序自己的）。
  // 已知残留（替代信号的精度天花板，dsh 靠回合信号无此面）：空闲仍持续重绘的
  // TUI（htop 之类）在回合内会被输出启发误判忙；完全静默的长命令显示层回落空闲
  // 由服务端 /switch 的杀前进程树探测（switch-guard）兜底——既有，显示层不追求
  // 完美。另注：本函数只回答「输出窗内出过字节」，已归属 agent 会话还须过回合闸
  // （terminalSessionBusyFromSignals）才算忙。
  function terminalBusyByOutput(session, windowMs = 5000, now = Date.now()) {
    const TERMINAL_BUSY_INCUBATION_MS = 15000;
    const TERMINAL_BUSY_INPUT_SUPPRESS_MS = 2000;
    const state = session && session.backendState ? session.backendState : null;
    if (!state || state.status === "exited") return false;
    const at = state.lastActiveAt;
    if (!(Number.isFinite(at) && now - at < windowMs)) return false;
    // 孵化豁免：出生 15s 内不判忙。出生点缺位（更老的快照）不豁免——按纯输出
    // 窗口径走。
    const born = Number.isFinite(state.spawnedAt) ? state.spawnedAt : state.createdAt;
    if (Number.isFinite(born) && now - born < TERMINAL_BUSY_INCUBATION_MS) return false;
    // 键入抑制：最近 2s 内有键入则输出多半是回显，不判忙。lastInputAt 缺位
    // （undefined/0：老会话恢复、老宿主快照）按无抑制处理——抑制面只认明确的
    // 新鲜键入。
    const inputAt = state.lastInputAt;
    if (Number.isFinite(inputAt) && inputAt > 0 && now - inputAt < TERMINAL_BUSY_INPUT_SUPPRESS_MS) return false;
    return true;
  }

  // 口径：请求在途，或输出在活跃窗内 → working，两者都无 → idle。「N 个请求进行中」
  // 明细取自真值；metrics 还没被轮询富化出来时（活了一辈子但还没等满一拍）只落
  // 状态位，不为了一行明细编造空指标。
  //
  // 归属会话另过回合闸（terminalTurnArmed）：输出窗单独不足以证明「回合在跑」——
  // dsh 这类 Ink 自绘 TUI 空闲时也在写 PTY，只看字节会让空闲页周期性转圈，也会
  // 让 M12 内切判定门误走「保护性新开页签」。所以输出窗只在「本回合」内有效：
  // 该实例一出现在途请求即入回合，回落到无请求且输出窗过期即出回合；出回合后
  // 只有新的请求能重新入回合，界面自绘不再点亮。无归属的普通终端没有回合概念，
  // 维持原输出窗口径（用户在 shell 里跑命令照样看得到进行中）。
  //
  // 已知窄化（知情取舍，用户 2026-10-26 验收口径）：回合的入场券只能由「看到在途
  // 请求」签发，而两个写点都只在终端页可见时运行。所以「回合在面板刷新/停在看板页
  // 期间开跑、此刻已进工具执行段」的会话会显示空闲——直到下一次请求。要消掉它需要
  // relay 下发实例级「回合在跑」布尔位（本架构目前拿不到，见上面输出窗注释）。这段
  // 窗口里误杀风险仍由服务端杀前进程树探测兜住（/switch 会探到活命令并拒换），
  // 只是显示面不保证。
  function terminalSessionBusyFromSignals(session, count, now = Date.now()) {
    const id = session && typeof session.id === "string" ? session.id : null;
    if (count > 0) {
      if (id) terminalTurnArmed.add(id);
      return true;
    }
    const output = terminalBusyByOutput(session, undefined, now);
    if (!output) {
      if (id) terminalTurnArmed.delete(id);
      return false;
    }
    if (!session || !session.agent) return true;
    return !!(id && terminalTurnArmed.has(id));
  }

  function terminalActivityApplyToSession(session, activeRequests) {
    const count = Number.isFinite(activeRequests) && activeRequests > 0 ? Math.trunc(activeRequests) : 0;
    session.status = terminalSessionBusyFromSignals(session, count) ? "working" : "idle";
    noteTerminalWorkingStatus(session, session.status);
    if (session.metrics) session.metrics.activeRequests = count;
    return count;
  }

  // done（跑完未读）标记的翻转观测器——两个 working 写点（SSE apply 经上面的
  // terminalActivityApplyToSession／1s 轮询 enrichTerminalSessions）算出 status 后
  // 都先过这里再落定：非聚焦会话真实观测到 working→idle 翻转 → 置 doneUnread
  // （dsh completed：后台回合跑完且未被查看）；working 再起（idle→working）同拍
  // 清旧标——跑起来了就不再是「已完成」，下次翻完成再重新置；聚焦即清（每拍
  // 聚焦即清，不等事件：看着＝已读）；会话退出（backendState.status exited，
  // 含输入路径写回的 exited）不置标且清既有标。上一拍状态按会话 id 记模块级
  // Map（会话对象每秒整表换血，标记不能挂在对象上）。
  function noteTerminalWorkingStatus(session, next) {
    const id = session && typeof session.id === "string" ? session.id : null;
    if (!id) return;
    const prev = terminalPrevWorking.get(id);
    terminalPrevWorking.set(id, next);
    const exited = !!(session.backendState && session.backendState.status === "exited");
    if (exited || next === "working" || id === activeTerminalPreviewId) {
      terminalDoneUnread.delete(id);
      return;
    }
    if (prev === "working" && next === "idle") terminalDoneUnread.set(id, true);
  }

  // activity 帧定点更新匹配的会话；snapshot 帧整帧对齐——快照里查不到键的
  // 归属会话一律回落 0（relay 侧该实例当前没有在途请求）。任何会话被真值
  // 触过才返回 true，调用方据此决定是否重绘。
  function terminalActivityApplyFrame(frame, sessionMap) {
    if (!frame || typeof frame !== "object" || !sessionMap || typeof sessionMap !== "object") return false;
    let countByKey = null;
    if (frame.type === "snapshot" && Array.isArray(frame.instances)) {
      countByKey = new Map();
      for (const inst of frame.instances) {
        if (!inst || typeof inst.endpointId !== "string") continue;
        // 端点级聚合行（instanceId 缺省）代表整个端点的合计在途请求，不驱动任何
        // 单个终端会话：未绑定实例的新会话与它同键，会把别的实例的请求算到自己
        // 头上（空闲页闪转圈）。单会话只认自己的实例行，拿不到就等绑定落定。
        // 空串一并跳过：活跃键用 `?? ""` 归一，空串会与「未绑定」撞同一个键。
        if (!inst.instanceId) continue;
        countByKey.set(terminalActivityKey(inst.endpointId, inst.instanceId), inst.activeRequests);
      }
    } else if (frame.type === "activity" && typeof frame.endpointId === "string") {
      // 同款：端点级活跃帧不落到单会话上（见上）。
      if (!frame.instanceId) return false;
      countByKey = new Map([[terminalActivityKey(frame.endpointId, frame.instanceId), frame.activeRequests]]);
    } else {
      return false;
    }
    let touched = false;
    for (const session of Object.values(sessionMap)) {
      const agent = session?.agent || null;
      if (!agent || typeof agent.endpointId !== "string") continue;
      const key = terminalActivityKey(agent.endpointId, agent.instanceId ?? null);
      if (countByKey.has(key)) {
        terminalActivityApplyToSession(session, countByKey.get(key));
        touched = true;
      } else if (frame.type === "snapshot") {
        terminalActivityApplyToSession(session, 0);
        touched = true;
      }
    }
    return touched;
  }

  // 看板侧活跃真值应用：帧改的是数据不是 DOM。命中端点按 (endpointId, instanceId)
  // 落到 metrics.activeRequests（端点级 / null）或 instances/sessions 行的 activeRequests
  // 与 status（实例行徽标由 status 派生，两个字段必须同改），返回命中端点 id 列表，
  // 由调用方调对应渲染器整卡重渲（复用既有渲染口径，指纹闸不动）。
  // instanceId 查不到归属行（归属行还没被轮询建出来）时不编造，等下一拍轮询自然出现。
  //
  // 两条链路的取信口径不同：
  //  · activity 帧的 at 是发布时刻、毫秒级到达，直接采用——这正是降延迟的来源；
  //  · snapshot 帧是桥缓存的最新态，其 at 是「最后一次听到这个身份」的时刻。被合并
  //    计数的身份（如桌面行与其壳内引擎会话互为镜像）可能几十秒没帧，带着旧 at 的
  //    值写上去就是把旧值盖到比它新的一拍轮询上。所以快照按 at 取时效：点到「且
  //    新鲜」（BOARD_ACTIVITY_SNAPSHOT_TRUST_MS）的行才写、才命中；没点到或过期的
  //    行一律原样不动，口径交回轮询。「没听到」不等于「该归零」。
  //  终端页语义不动（那条链路由归属保证同身份，见 terminalActivityApplyFrame）。
  function boardActivityApplyFrame(frame, agents) {
    const hit = [];
    const BOARD_ACTIVITY_SNAPSHOT_TRUST_MS = 3000;
    if (!frame || typeof frame !== "object" || !Array.isArray(agents)) return hit;
    const applyTo = (endpointId, instanceId, count) => {
      const agent = agents.find((a) => a && a.id === endpointId);
      if (!agent) return false;
      const n = Number.isFinite(count) && count > 0 ? Math.trunc(count) : 0;
      if (instanceId === null || instanceId === undefined) {
        if (!agent.metrics || typeof agent.metrics !== "object") return false;
        agent.metrics.activeRequests = n;
        return true;
      }
      const rows = Array.isArray(agent.instances) ? agent.instances
        : (Array.isArray(agent.sessions) ? agent.sessions : []);
      const row = rows.find((r) => r && r.id === instanceId);
      if (!row) return false;
      row.activeRequests = n;
      // 实例行的「生成中」徽标由 status 派生（renderInstanceRows 读 inst.status），
      // 与 activeRequests 是两个字段：只改数不改状态，行徽标会停在旧态。这里按服务端
      // 同一口径镜像（instances/sessions 行只在 active/idle 之间取值）。
      row.status = n > 0 ? "active" : "idle";
      return true;
    };
    if (frame.type === "activity" && typeof frame.endpointId === "string") {
      if (applyTo(frame.endpointId, frame.instanceId ?? null, frame.activeRequests)) hit.push(frame.endpointId);
      return hit;
    }
    if (frame.type === "snapshot" && Array.isArray(frame.instances)) {
      const now = Date.now();
      // 一行一判：点到「且 fresh」才写、才命中；没点到或过期都原样留着，口径交回轮询。
      // 「没听到这个身份」不等于「该归零」——被合并计数的身份（桌面行 vs 壳内引擎会话）
      // 可能几十秒没帧，按 0 写就是把旧值盖到比它新的一拍轮询上。
      const trusted = (endpointId, instanceId) => {
        const raw = frame.instances.find((i) => i && i.endpointId === endpointId && (i.instanceId ?? null) === instanceId);
        if (!raw) return null;
        if (typeof raw.at !== "number" || now - raw.at > BOARD_ACTIVITY_SNAPSHOT_TRUST_MS) return null;
        return raw;
      };
      const countOf = (raw) => (raw && Number.isFinite(raw.activeRequests) && raw.activeRequests > 0 ? Math.trunc(raw.activeRequests) : 0);
      for (const agent of agents) {
        if (!agent || typeof agent.id !== "string") continue;
        let touched = false;
        if (agent.metrics && typeof agent.metrics === "object") {
          const raw = trusted(agent.id, null);
          if (raw) {
            const n = countOf(raw);
            if (agent.metrics.activeRequests !== n) agent.metrics.activeRequests = n;
            touched = true;
          }
        }
        const rows = Array.isArray(agent.instances) ? agent.instances
          : (Array.isArray(agent.sessions) ? agent.sessions : []);
        for (const row of rows) {
          if (!row || row.id === undefined || row.id === null) continue;
          const raw = trusted(agent.id, row.id);
          if (!raw) continue;
          const n = countOf(raw);
          if (row.activeRequests !== n || row.status !== (n > 0 ? "active" : "idle")) {
            row.activeRequests = n;
            row.status = n > 0 ? "active" : "idle";
          }
          touched = true;
        }
        if (touched) hit.push(agent.id);
      }
      return hit;
    }
    return hit;
  }

  // 看板各端点的整卡渲染器：boardActivityApplyFrame 命中后按 id 调对应渲染器重渲。
  // 覆盖全部九个端点；表外端点的帧照样改数据，只是不即时重渲（等下一拍轮询）。
  const BOARD_RENDERERS = {
    zcode: (a) => renderZcode(a),
    claude: (a) => renderClaude(a),
    dsh: (a) => renderDsh(a),
    pi: (a) => renderPi(a),
    kimi: (a) => renderKimi(a),
    qoder: (a) => renderQoder(a),
    opencode: (a) => renderOpencode(a),
    codex: (a) => renderCodex(a),
    grok: (a) => renderGrok(a),
  };

  // 空壳防抖计数表的会话关闭清零：只清「两张会话表都不认」的 id——轮询重建是整表
  // 换血，别处关掉的会话从此不再出现在后端表；预览表同查是为了保住尚未就绪期的
  // 预览稿计数。还在任一表里的会话计数不动（切页签、换窗口不算关闭）。
  function pruneTerminalHollowStreak() {
    for (const id of terminalHollowStreak.keys()) {
      if (!terminalBackendSessions[id] && !terminalPreviewSessions[id]) terminalHollowStreak.delete(id);
    }
  }

  // done（跑完未读）两张表的同款清零：只清后端会话表不认的 id——轮询整表换血后，
  // 别处（另一个面板窗口）关掉的会话从此不再出现，未读标记与上一拍状态不串到
  // 同 id 的下一代会话。预览稿假会话从不会有 done 标（只对真实翻转置位），不查
  // 预览表。
  function pruneTerminalDoneState() {
    for (const id of terminalDoneUnread.keys()) {
      if (!terminalBackendSessions[id]) terminalDoneUnread.delete(id);
    }
    for (const id of terminalPrevWorking.keys()) {
      if (!terminalBackendSessions[id]) terminalPrevWorking.delete(id);
    }
    // 回合闸同款：会话没了，闸位不留给同 id 的下一代会话。
    for (const id of terminalTurnArmed) {
      if (!terminalBackendSessions[id]) terminalTurnArmed.delete(id);
    }
  }

  function rebuildTerminalBackendSessions(items) {
    terminalBackendSessions = Object.fromEntries((Array.isArray(items) ? items : []).map((item) => [item.id, terminalBackendSession(item)]));
    pruneTerminalHollowStreak();
    pruneTerminalDoneState();
    // 空壳拍计数在这张表重建时推进：每次重建（1s 轮询、连接）都是一轮
    // 新的归属观测——空壳会话计数 +1、有归属会话清零。计数必须跟着数据拍走而非
    // 跟着渲染走：SSE 活跃真值流命中任一会话就会整渲当前会话（renderTerminal-
    // SessionData），那些渲染不带新归属数据，若计数随渲染递增，多开时他端一活跃，
    // 3 拍在亚秒内凑满，防抖窗口名存实亡。
    for (const session of Object.values(terminalBackendSessions)) {
      if (session.agent) terminalHollowStreak.delete(session.id);
      else terminalHollowStreak.set(session.id, (terminalHollowStreak.get(session.id) || 0) + 1);
    }
    if (!terminalBackendSessions[activeTerminalPreviewId]) {
      // 刷新后「看着哪个标签」从存档回读：整页加载把内存里的活动 id 打回预览稿遗留的
      // 初值，直接取会话表第一个键等于永远落回最早创建的那个终端——多标签时这就是
      // 「历史丢了」。认不到（别的窗口关了它、宿主换过）才回落第一个，并把落定的
      // id 写回存档，不留着失效值让下一次恢复再踩。
      const remembered = storedTerminalSessionId();
      activeTerminalPreviewId = (remembered && terminalBackendSessions[remembered])
        ? remembered
        : (Object.keys(terminalBackendSessions)[0] || null);
      rememberTerminalSessionId(activeTerminalPreviewId);
    }
  }

  // 新会话的初始行列数取当前实测值：PTY 若以固定猜测值（120×34）起步，而
  // 可见区其实是别的尺寸，SSE 首帧回放与 TUI 首帧排版就会按错宽度折行——xterm
  // 加大列宽不重排已折行内容，首帧画错就一直错。已有 xterm 实例时直接取
  // 它的实测 cols/rows；尚未创建（首装载入路径）才回落兜底值，随后的建流前 fit
  // 会立刻把真实尺寸补正。
  function terminalCreateSize() {
    if (terminalXterm && Number.isFinite(terminalXterm.cols) && Number.isFinite(terminalXterm.rows)) {
      return { cols: terminalXterm.cols, rows: terminalXterm.rows };
    }
    return { cols: 120, rows: 34 };
  }

  // 零会话不自动补建：新终端只属于用户动作（「+」菜单 / 一键启动 agent），连接与
  // 刷新恢复在零会话一律落空态。此处曾自动 POST 一个空白终端——页面加载必经这趟
  // 首连，任何页刷新都会在零页签时蹦出空白页签并静默起一个 powershell（预览期
  // 「至少留一标签」遗规在连接路径的残部，勿复活）。
  async function fetchTerminalSessions() {
    const data = await api("GET", "/api/terminal/sessions");
    rebuildTerminalBackendSessions(data.sessions);
    terminalBackendReady = true;
  }

  // 流的生命周期即 xterm 的生命周期，旧连接的一切随关闭一并销毁。此前复用
  // 单例 xterm：onData 监听器虽随切换拆除，但 WriteBuffer 里旧会话已排队未解析
  // 的字节（大回放跨越多个事件循环切片，setTimeout 续跑不可取消）会在之后解析
  // 时触发当前监听器，把旧会话的 DA/CPR 自动应答 POST 进新会话的 PTY。逐连接
  // 重建 xterm 后，旧积压只能打进监听器表已随之清空的旧实例，彻底落空。
  function closeTerminalStream() {
    terminalEventSource?.close();
    terminalEventSource = null;
    terminalInputDisposable?.dispose();
    terminalInputDisposable = null;
    terminalBoundSessionId = null;
    terminalXterm?.dispose();
    terminalXterm = null;
    terminalFitAddon = null;
    terminalWebglAddon = null;
    terminalHostResizeObserver?.disconnect();
    terminalHostResizeObserver = null;
    // 像素密度监视随流一起摘除（挂/销理由见 armTerminalDprWatch 注释）。
    disarmTerminalDprWatch();
    if (terminalImeAnchorTextarea) {
      terminalImeAnchorTextarea.removeEventListener("compositionstart", terminalImeArmHandler);
      terminalImeAnchorTextarea.removeEventListener("compositionend", terminalImeReleaseHandler);
      terminalImeAnchorTextarea = null;
      terminalImeAnchorTerm = null;
      terminalImeArmHandler = null;
      terminalImeReleaseHandler = null;
    }
    terminalImeHold = null;
    terminalImeFitPending = false;
    if (terminalImeHoldFrame !== null) cancelAnimationFrame(terminalImeHoldFrame);
    terminalImeHoldFrame = null;
    // 回放闩随实例销毁：撤销静默清闩定时器，别让它在 dispose 之后再碰实例。
    terminalReplayRestoreCancel?.();
    terminalReplayRestoreCancel = null;
    terminalReplayRestoreArm = null;
    terminalReplayRestoring = false;
    // 同步输出合帧的挂起块同理：撤销兜底定时器并丢弃未闭合的字节。
    terminalStreamSyncCancel?.();
    terminalStreamSyncCancel = null;
    // 合帧写者随流关闭摘除：burst 冲刷从此回退直写（旧 term 已 dispose，本就不该再写）。
    terminalStreamWrite = null;
    // 未落屏的突发随实例销毁：攒着的字节写进已 dispose 的实例没有意义，定时器
    // 更要在销毁前撤掉。
    discardTerminalBurst();
    terminalReplayFramePending = false;
  }

  // 整页清场入口（关停清场 / 零会话）：关闭终端流与实例。
  function closeAllTerminalStreams() {
    dropTerminalStaleScreen();
    closeTerminalStream();
  }

  // ---- 切签垫片：切换期屏上始终有内容 ----
  //
  // 病灶（S2 §2）：切换链第一步就是 closeTerminalStream() → terminalXterm.dispose()，
  // xterm 自己把 DOM 从宿主摘掉，三层覆盖层（未连接/降级/零会话）都不服务「正在重建」，
  // 于是中间态只能是 #terminalScreen 的一块底色。
  //
  // 形态：切换时**不停留旧连接、只停留旧实例的那一帧像素**。停放的做法是借
  // closeTerminalStream 本身那一拍——把实例的 dispose 临时换成空操作，让它把这套
  // teardown（关事件源、摘 onData、断 RO、摘 dpr 监视与 IME 锚点、撤回放闩与合帧层、
  // 丢突发）照跑一遍、全局引用全部归零，唯独不真的销毁实例；调用返回后立刻把真身
  // dispose 还回去。这样拆流公共体一个字都不用改（它在别处的语义必须原样），
  // 而旧实例的 DOM 与最后一帧像素留在宿主里，打上 .terminal-stale-frame 绝对定位
  // 盖在新实例上方；新实例照常在同一个已可见宿主里新建、同步 fit 把尺寸 POST 进
  // PTY、整屏回放，等它真的画出内容（首帧回放落地）再撤垫片。
  //
  // 旧会话未解析字节为什么打不进新会话（三道，逐条可验）：
  //  1) 连接语义不变：停放那一拍 closeTerminalStream 已经把 onData 监听 dispose 了，
  //     而 xterm 的自动应答（DA/CPR）只经实例的 onData 派发——旧积压后来解析出来也只
  //     落到空的监听器表，这与直接 dispose 版本依赖的是同一条机制，没有放宽。
  //  2) 更靠前的一道：停放时置 `disableStdin = true`，xterm 5.5 的
  //     CoreService.triggerDataEvent 在 disableStdin 为真时直接早退（xterm.js 原文：
  //     `triggerDataEvent(e,t=!1){if(this._optionsService.rawOptions.disableStdin)return;…}`），
  //     应答在产生处就被掐掉，连「派发给空表」这一步都到不了。
  //  3) 新实例是全新构造的（WriteBuffer 空、监听器表自带新闭包），建连时固化的
  //     boundSessionId 只属于它自己；垫片实例不在任何全局写者手里（terminalStreamWrite
  //     / burst / 回放闩全部在停放那一刻被置空），也不会被重新绑定——它连全局引用都没了。
  // 另：垫片 pointer-events: none，键盘/滚轮/拖选都落不到它身上。
  //
  // 与「隐藏期不建流、不测量」的关系：那条闸一字未动。垫片期间终端页可见，新实例在
  // 同一个已可见宿主里按原尺寸布局与测量（不是 display:none、也不是 0×0），建流前的
  // 同步 fit 照旧把尺寸 POST 进 PTY；垫片不参与布局，也不改变任何测量结果。
  const TERMINAL_STALE_SCREEN_MAX_MS = 2000;
  let terminalStaleScreen = null;
  // 「首帧回放已经落地」的单调计数（只增不减，跨实例累加）：垫片观察者拿停放时的值与
  // 当前值比较，变了就是新画面已经交代过一屏。见 connectTerminalStream 的 data 处理器。
  let terminalReplayEpoch = 0;
  // 延后重建流的帧令牌（M5 live 行快路径）：renderTerminalPreviewSession 的
  // deferScreen 把停放＋建流＋fit 整组推到双 rAF 之后，连点两条会话时旧帧
  // 醒来发现令牌已变即整组退场——不拿旧会话的流覆盖新会话。
  let terminalScreenSeq = 0;

  function dropTerminalStaleScreen() {
    const stale = terminalStaleScreen;
    if (!stale) return;
    terminalStaleScreen = null;
    stale.done = true; // 在飞的观察循环与揭幕回调看到这一位就自行作废
    if (stale.timer !== null) clearTimeout(stale.timer);
    stale.timer = null;
    if (stale.frame !== null) cancelAnimationFrame(stale.frame);
    stale.frame = null;
    stale.el?.classList?.remove("terminal-stale-frame");
    // dispose 自己会把 element 从宿主摘掉（xterm 的 dispose 里 removeChild）；摘不
    // 干净时再兜一刀，避免一个已死的空壳继续占着屏。
    try { stale.term?.dispose(); } catch {}
    if (stale.el?.parentNode) stale.el.parentNode.removeChild(stale.el);
  }

  // 停放当前实例当垫片：返回垫片句柄；没有可停的画面时照旧整条拆流（首连、或上次
  // 就没建出实例）。
  function parkTerminalScreen() {
    // 隐藏期不停放也不拆流：与 connectTerminalStream 的隐藏闸同一条口径——离开终端页
    // 后活着的那条流，不能被隐藏期的重渲染路径关掉。
    if ($("terminalView")?.hidden) return null;
    const term = terminalXterm;
    const el = term && term.element ? term.element : null;
    if (!term || !el) {
      // 没有可停的画面（首连；或后台切回时实例已在隐藏期拆掉）：**不撤**已有的垫片
      // ——它正是此刻屏上唯一的内容，撤了就是一块底色。照旧整条拆流。
      closeTerminalStream();
      return null;
    }
    dropTerminalStaleScreen();
    // 先掐输入面再拆流：顺序反了会有「监听还在、实例已脱离全局」的窗口。
    try { term.options.disableStdin = true; } catch {}
    const originalDispose = term.dispose;
    term.dispose = () => {}; // 只在这一拍的拆流里让 dispose 空转
    try {
      closeTerminalStream();
      // 加类也放进 try：它若抛，finally 必须照样把真身 dispose 还回去，否则这个实例
      // 永久没有销毁路径（拆流已经跑完，全局引用已经清空）。
      el.classList.add("terminal-stale-frame");
    } finally {
      term.dispose = originalDispose;
    }
    const stale = { term, el, timer: null, frame: null, done: false, epochAtPark: terminalReplayEpoch };
    terminalStaleScreen = stale;
    // 兜底撤垫片：新画面迟迟不来（握手失败、宿主在飞）时不能把旧画面永久留在屏上
    // ——那是一屏别的会话的内容，看久了就是错的信息。到点撤走，退回既有三态覆盖层，
    // 也就是今天的行为，不是新增的中间态。
    //
    // 窗口在后台时不撤：隐藏期 rAF 停摆，观察循环叫不醒，撤了就等于把「切回时的那一
    // 屏」也撤了。此时重新起一次计时，回前台由观察循环（按「新画面有内容」揭幕）接手。
    const armCap = () => {
      stale.timer = setTimeout(() => {
        stale.timer = null;
        if (typeof document !== "undefined" && document.hidden) { armCap(); return; }
        dropTerminalStaleScreen();
      }, TERMINAL_STALE_SCREEN_MAX_MS);
    };
    armCap();
    watchTerminalStaleScreen(stale);
    return stale;
  }

  // 就绪判据（两条任一）：
  //  a) 新实例的缓冲区里真的**有字**——首帧回放的字节被解析了（空屏会话走 b）；
  //  b) **首帧回放那一拍已经发生过**：拿「停放时的计数」与当前值比，变了即成立。
  //
  // 判「有字」不能看 buffer.active.length：xterm 一开屏就有 rows 行空行，length 恒
  // ≥ rows，拿它当判据等于「实例一建出来就算就绪」——CDP 实测（M4 T6）这条错判据会
  // 让垫片在新画面写入前约 340ms 就被撤走，空白照旧。必须逐行看有没有非空白字符。
  //
  // b 为什么是「计数」而不是「逐帧看 terminalReplayFramePending」：snapshot 与首帧 data
  // 实测只隔 0.6ms、同帧到达，rAF 逐帧采样永远采不到那个中间态——判据于是恒假，空屏
  // 会话只能等 2s 兜底（评审实测 2009ms，那 2 秒里用户看的是上一个会话的画面）。改成
  // 在 data 处理器消费标志的那一拍自增计数（见 connectTerminalStream），观察循环只做
  // 「变了没有」的比较，同帧发生也照样算数。
  function terminalScreenHasContent(term) {
    const buf = term && term.buffer ? term.buffer.active : null;
    if (!buf || typeof buf.getLine !== "function") return false;
    const top = buf.viewportY || 0;
    const rows = term.rows || 0;
    for (let y = top; y < top + rows; y += 1) {
      const line = buf.getLine(y);
      if (line && String(line.translateToString(true)).trim()) return true;
    }
    return false;
  }

  // 垫片就绪判据（唯一一处判定，观察循环与单测都调它）：
  //   有字（首帧回放的字节被解析了）或「首帧回放那一拍已经发生过」（计数变了）。
  // 抽成纯函数是为了它能被直接钉住——判据写死在观察循环里时，测试只能整条链路跑，
  // 而「删掉计数比较」这种变异会被兜底计时器掩盖掉，测不出来。
  function terminalStaleScreenReady(stale) {
    if (!stale) return false;
    if (terminalReplayEpoch !== stale.epochAtPark) return true;
    return terminalScreenHasContent(terminalXterm);
  }

  // 逐帧观察新画面何时就绪，就绪后再等两帧（一帧给渲染器排程、一帧给合成器上屏）
  // 才撤垫片。视图被藏起来时当即收掉：垫片只服务可见的重建。
  function watchTerminalStaleScreen(stale) {
    if (stale.done) return;
    if (terminalStaleScreen !== stale) return;
    if ($("terminalView")?.hidden) { dropTerminalStaleScreen(); return; }
    if (terminalStaleScreenReady(stale)) { revealTerminalStaleScreen(stale); return; }
    if (typeof requestAnimationFrame !== "function") return;
    stale.frame = requestAnimationFrame(() => {
      stale.frame = null;
      watchTerminalStaleScreen(stale);
    });
  }

  // 撤垫片 + 补一帧整屏重绘：垫片盖住期间新实例可能被合成器裁掉（不合成就不呈现
  // 画面），而 webgl 渲染器不保留绘制缓冲，揭幕拿到底的可能是旧像素。重绘一次只有
  // 一帧成本。
  function revealTerminalStaleScreen(stale) {
    if (!stale || stale.done || terminalStaleScreen !== stale) return;
    const settle = () => {
      stale.frame = null;
      if (stale.done || terminalStaleScreen !== stale) return;
      dropTerminalStaleScreen();
      const term = terminalXterm;
      if (term && Number.isFinite(term.rows) && term.rows > 0 && typeof term.refresh === "function") {
        try { term.refresh(0, term.rows - 1); } catch {}
      }
    };
    if (typeof requestAnimationFrame !== "function") { settle(); return; }
    stale.frame = requestAnimationFrame(() => {
      if (stale.done || terminalStaleScreen !== stale) return;
      stale.frame = requestAnimationFrame(settle);
    });
  }

  // 窗口级尺寸闸的下限：按 13px 字号一格约 7.8×17px 取整，80×34 约合 10 列 2 行。
  // 正常布局不会掉到这条线以下，视口塌陷则一定掉到它以下——阈值只用来区分这两件事，
  // 不承担"最小可用终端尺寸"的承诺。
  const TERMINAL_FIT_MIN_HOST_WIDTH_PX = 80;
  const TERMINAL_FIT_MIN_HOST_HEIGHT_PX = 34;

  function terminalHostMeasurable() {
    const host = $("terminalXtermHost");
    return !!host
      && host.clientWidth >= TERMINAL_FIT_MIN_HOST_WIDTH_PX
      && host.clientHeight >= TERMINAL_FIT_MIN_HOST_HEIGHT_PX;
  }

  function fitTerminalXterm() {
    // 终端页隐藏期不测量：FitAddon 从 display:none 的宿主只能量到百分比兜底值
    // （实测把 xterm 压成 12×6），按这个宽度折行的回放会把整行提示符碎成几段，
    // 而 xterm 加大列宽时不重排已折行内容——首帧画错就一直错。窗口 resize 的
    // 防抖路径也经由此闸：切到别的页后 resize 不再把兜底尺寸 POST 进 PTY。
    if ($("terminalView")?.hidden) return;
    // 视图闸只管"这一屏被藏起来"，管不了"整个窗口被最小化"：后者宿主量得到 0×0，
    // FitAddon 会把 xterm 收成 2 列 1 行（实测），这个尺寸还会被 POST 进 PTY——承载
    // 的 TUI 当场按 2 列重排成碎条，而宿主尺寸回来后 xterm 不会自己回弹（实测停在
    // 2×1）。量不到可信尺寸就既不 fit 也不 POST；窗口恢复时 ResizeObserver 与
    // window resize 会再叫一次此入口，无需在这里补测。
    if (!terminalHostMeasurable()) return;
    // 组字期间不重排：锚点钉在组字开始的格子上，终端一变宽它会跟着整块挪走。
    // 记下，组字结束后补一次。
    if (terminalImeHold) {
      terminalImeFitPending = true;
      return;
    }
    terminalFitAddon?.fit();
    // fit 后 POST 的目标是建连时固化的定投会话，不读页级活跃指针：避免
    // 「别窗关掉当前会话、活跃指针已回落而流未拆」的窗口期向未在观看
    // 的新会话误投 resize。
    const session = terminalBoundSessionId ? terminalSessionFor(terminalBoundSessionId) : null;
    if (!session?.backend || !terminalXterm) return;
    // fit 后尺寸与 PTY 侧已知尺寸完全一致就跳过这次 POST：PTY 收到 resize（哪怕
    // 同值）也会让承载的 TUI 整屏重排一次，1s 轮询的兜底 fit、inspector 收放、字
    // 号微调等入口在尺寸实际没变时重复 POST 同值，就是用户看到的「终端没动却抽
    // 一下」。fit 本身照跑（客户端按新测量重排不需要 PTY 陪跑）。backendState 拿
    // 不到或不完整时照旧 POST——宁可多一次重排，不漏一次对齐（保守）。
    const backendSize = session.backendState;
    if (backendSize
      && Number.isFinite(backendSize.cols) && Number.isFinite(backendSize.rows)
      && backendSize.cols === terminalXterm.cols && backendSize.rows === terminalXterm.rows) return;
    postTerminalResize(session, terminalXterm.cols, terminalXterm.rows);
  }

  // resize POST 失败不再静默吞掉——PTY 停在旧列宽而 xterm 已按新宽度渲染，TUI 按
  // 旧列宽排版时右侧会溢出到可见区外（kimi 输入框满行甩行即此形态）。失败短重试
  // 一次；安排与执行前各校验一次 xterm 仍停在同一个尺寸——用户继续 resize 产生的
  // 更新测量优先，旧重试不回溯；两次都失败才告警（会话可能已关闭，属预期末路）。
  function postTerminalResize(session, cols, rows, attempt = 0) {
    api("POST", `/api/terminal/sessions/${encodeURIComponent(session.id)}/resize`, { cols, rows })
      .then((result) => {
        if (result && Number.isFinite(result.cols) && Number.isFinite(result.rows)) {
          session.backendState = { ...session.backendState, cols: result.cols, rows: result.rows };
        }
      })
      .catch((error) => {
        const stillCurrent = () => terminalXterm && terminalXterm.cols === cols && terminalXterm.rows === rows;
        if (!stillCurrent()) return; // 已有更新的测量接管，旧失败不回溯也不告警
        if (attempt === 0) {
          setTimeout(() => { if (stillCurrent()) postTerminalResize(session, cols, rows, 1); }, 250);
          return;
        }
        console.warn("[terminal] resize failed:", error);
      });
  }

  // 「重画终端画面」：画面看着不对时的兜底入口。两件事各治一半——
  //   1) 让 agent 重画一帧：把宽度挤掉一列再恢复。TUI 只在收到尺寸变化时整屏重画，
  //      这是唯一能把「已经画错的画面」盖掉的动作（手动调字号能救回来就是这个道理）。
  //      xterm 必须跟着一起缩：只改 PTY 不改客户端，agent 按新列宽排版、客户端按旧
  //      列宽渲染，右侧反而会错位。
  //   2) 重建客户端画面：把流重开一遍，客户端拿到的是后端镜像的整屏回放，等价于一次
  //      页签切换，客户端侧的残留状态随之清掉（重建时那次 fit 会把真实尺寸 POST 回去）。
  // 挤宽度与恢复之间要留一拍：两次尺寸变化挨得太近，应用可能只看到净结果（没变），
  // 那样它不会重画，这一下就白点了。
  const TERMINAL_REDRAW_NUDGE_MS = 150;
  function redrawTerminalScreen() {
    // 会话取当前活跃页签，实例校验盯唯一 xterm。
    const session = terminalSessionFor(activeTerminalPreviewId);
    const term = terminalXterm ?? null;
    if (!term || !session) return;
    if (!session.backend || term.cols <= 2) {
      // 预览会话没有 PTY 可挤，只能重建客户端画面
      connectTerminalStream(session);
      return;
    }
    const cols = term.cols;
    const rows = term.rows;
    term.resize(cols - 1, rows);
    postTerminalResize(session, cols - 1, rows);
    setTimeout(() => {
      if (terminalXterm !== term) return;
      connectTerminalStream(session);
    }, TERMINAL_REDRAW_NUDGE_MS);
  }

  // 窗口 resize 的 fit 走防抖：拖动/最大化动画里事件逐帧来，逐跳 fit 会让
  // xterm 每帧 reflow 并连发 resize 请求；合并到静默期后一次即可。其它调用点
  //（终端页显示、字号变更）仍直接调 fitTerminalXterm，不被这条入口影响。
  const TERMINAL_RESIZE_DEBOUNCE_MS = 120;
  let terminalResizeDebounceTimer = null;
  function debounceTerminalFit(delayMs = TERMINAL_RESIZE_DEBOUNCE_MS) {
    if (terminalResizeDebounceTimer !== null) clearTimeout(terminalResizeDebounceTimer);
    terminalResizeDebounceTimer = setTimeout(() => {
      terminalResizeDebounceTimer = null;
      fitTerminalXterm();
    }, delayMs);
  }

  // 挂/换挂当前像素密度的 resolution 媒体查询：查询只对「这一档密度」发声，密度变了
  // 必须换挂新值的查询，否则下一次变化就聋了（内核 CoreBrowserService 同款换挂式）。
  // 事件到达时 window.devicePixelRatio 已是新值，换挂后走与宿主 RO 同一条防抖 fit——
  // fit 体内自带视图/尺寸/组字全部闸门，cols 未跨界时由同值闸空转，跨界正常
  // resize＋POST，agent 重画后两侧尺寸重新对齐。
  function armTerminalDprWatch() {
    disarmTerminalDprWatch();
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(`screen and (resolution: ${window.devicePixelRatio}dppx)`);
    const handler = () => {
      armTerminalDprWatch();
      debounceTerminalFit();
    };
    if (typeof query.addEventListener === "function") query.addEventListener("change", handler);
    else query.addListener(handler);
    terminalDprMediaQuery = query;
    terminalDprMediaHandler = handler;
  }

  function disarmTerminalDprWatch() {
    const query = terminalDprMediaQuery;
    const handler = terminalDprMediaHandler;
    if (!query || !handler) return;
    if (typeof query.removeEventListener === "function") query.removeEventListener("change", handler);
    else query.removeListener(handler);
    terminalDprMediaQuery = null;
    terminalDprMediaHandler = null;
  }

  // xterm 主题与终端屏 CSS token 同源：底色/前景/光标/选区从 --terminal-* 现值取，
  // 亮暗与三皮肤换肤即换终端。亮态追加一套浅底可读的 ANSI 调色板（xterm 内置默认
  // 色按深底设计，直接放浅底黄/亮绿会洗没）；暗态不动 ANSI，沿用内核默认。
  const TERMINAL_ANSI_LIGHT = {
    black: "#1f2937", red: "#dc2626", green: "#16a34a", yellow: "#b45309",
    blue: "#2563eb", magenta: "#9333ea", cyan: "#0e7490", white: "#d1d5db",
    brightBlack: "#6b7280", brightRed: "#ef4444", brightGreen: "#22c55e", brightYellow: "#d97706",
    brightBlue: "#3b82f6", brightMagenta: "#a855f7", brightCyan: "#0891b2", brightWhite: "#111827",
  };
  // 暗态 0-15 调色板＝xterm 内核默认色（暗态不覆写 ANSI，沿用内核值）。上报给
  // 宿主的调色板必须与渲染器实际生效色逐格一致，因此暗态就是这份默认表；xterm
  // 升级换默认色时这里要同步。
  const TERMINAL_ANSI_DARK = {
    black: "#2e3436", red: "#cc0000", green: "#4e9a06", yellow: "#c4a000",
    blue: "#3465a4", magenta: "#75507b", cyan: "#06989a", white: "#d3d7cf",
    brightBlack: "#555753", brightRed: "#ef2929", brightGreen: "#8ae234", brightYellow: "#fce94f",
    brightBlue: "#729fcf", brightMagenta: "#ad7fa8", brightCyan: "#34e2e2", brightWhite: "#eeeeec",
  };
  const TERMINAL_ANSI_KEYS = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
    "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite"];
  function terminalXtermTheme() {
    const cs = getComputedStyle(document.documentElement);
    const pick = (name, fallback) => {
      const v = cs.getPropertyValue(name).trim();
      return v || fallback;
    };
    const theme = {
      background: pick("--terminal-bg", "#0b1220"),
      foreground: pick("--terminal-fg", "#d5e2f4"),
      cursor: pick("--terminal-cursor", "#dbeafe"),
      selectionBackground: pick("--terminal-selection", "#29486d"),
    };
    if (cs.colorScheme !== "dark") Object.assign(theme, TERMINAL_ANSI_LIGHT);
    return theme;
  }
  // 终端亮暗/颜色上报（match terminal 契约的面板半边）：虚拟终端里的 agent
  //（kimi 的 Auto (match terminal)、claude code 的同一档、pi 的整套颜色询问）靠
  // 宿主的 997 报告感知亮暗变化，靠宿主回答「背景/前景/调色板是什么」决定用哪
  // 套配色——事实源都在面板。setTheme/系统亮暗/皮肤重刷都会走到这里，值变了才
  // 上报，失败视同未上报等下次重试。颜色与终端屏/xterm 同源（--terminal-* 与
  // TERMINAL_ANSI_*），深浅没变只换肤时也要重报：宿主按这个值回答颜色询问，
  // 答旧色等于答错。
  let terminalThemeReported = "";
  function terminalCssHex(name, fallback) {
    const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim().toLowerCase();
    const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(raw);
    if (!hex) return fallback;
    const value = hex[1];
    if (value.length === 6) return `#${value}`;
    return `#${value[0]}${value[0]}${value[1]}${value[1]}${value[2]}${value[2]}`;
  }
  function terminalBackgroundHex(dark) {
    return terminalCssHex("--terminal-bg", dark ? "#0b1220" : "#f8fafc");
  }
  function terminalForegroundHex(dark) {
    return terminalCssHex("--terminal-fg", dark ? "#d5e2f4" : "#1e293b");
  }
  function reportTerminalThemeToBackend(force = false) {
    const dark = getComputedStyle(document.documentElement).colorScheme === "dark";
    const background = terminalBackgroundHex(dark);
    const foreground = terminalForegroundHex(dark);
    const palette = TERMINAL_ANSI_KEYS.map((key) => (dark ? TERMINAL_ANSI_DARK : TERMINAL_ANSI_LIGHT)[key]);
    const key = `${dark ? "dark" : "light"}|${background}|${foreground}|${palette.join(",")}`;
    if (!force && terminalThemeReported === key) return;
    terminalThemeReported = key;
    api("POST", "/api/terminal/theme", { dark, background, foreground, palette }).catch(() => {
      terminalThemeReported = "";
    });
  }
  // 主题/皮肤/系统亮暗变化后重刷在跑的 xterm；不在跑（未建流）则等下次创建时自然取新值
  function applyTerminalXtermTheme() {
    if (terminalXterm) terminalXterm.options.theme = terminalXtermTheme();
    reportTerminalThemeToBackend();
  }

  // 终端侧栏折线的原生规格：与 .terminal-metric-spark 的 CSS 盒等大（56×22，
  // 0.6.6 发布版尺寸），viewBox 1:1 映射像素，线宽/round 端点不失真
  const TERMINAL_SPARK_SIZE = { w: 56, h: 22 };

  // 跳顶回归护栏（跟随底部焊死）：xterm 的 Viewport 把 .xterm-viewport 的 scroll
  // 事件翻译成缓冲区行号（_handleScroll：newRow = scrollTop/行高，与 ydisp 的差值
  // 直接写进缓冲区）。渲染尺寸同步存在瞬时塌缩窗口（实测：建流回放+输出洪峰期间，
  // 滚动区高度被瞬刻算成一屏大小——scrollTop 从底部 40095 被浏览器钳到 345），
  // 钳制派发的 scroll 事件不带任何标记，xterm 拿它当「用户滚动」写进 ydisp；此后
  // ydisp≠ybase，新输出不再带动视口，画面卡死在接近顶端的位置不自行恢复。
  // 护栏恢复 xterm 的跟随语义（视口在底部就跟着输出走）：跟随态下、最近没有用户
  // 语义对齐 Claude Desktop（实证规格 .pocketower/findings/m1-claude-bottom-align-spec.md，
  // 2026-10-20 用户拍板）：空区出现时不自动折回——视口原地不动，空白带留在屏上；用户
  // 上滚翻看历史时「地板」随滚动逐拍收紧（trim 只缩不扩），空区被吃掉而视口不跳；滚回
  // 地板即恢复跟随，落点恰好是修剪后的内容底。用户主动离底的各条通路都先记意图——滚轮/
  // 拖滚动条/触摸/选择拖动，以及键盘翻页（xterm 把 Shift+PageUp/PageDown 译为
  // scrollLines，见下方 keydown 监听）——意图窗口内的离底事件退出跟随态，停在
  // 历史上绝不拉回（含回放清闩：读历史时回放结束不拽底）。
  const TERMINAL_SCROLL_INTENT_MS = 250;
  // 回放闩的静默窗：reset()/回放洪峰的写入不是用户滚动，静默一拍后才清闩并锚定。
  const TERMINAL_EFFECTIVE_BOTTOM_SETTLE_MS = 120;
  // 有效底部（「底部自动对齐」开启时护栏采信）：TUI 整屏清除（ESC[2J+光标归零，典型=
  // Kimi 收起 / 指令表）后把矮框架从屏幕顶重画，尾部屏幕行无人写入——这块空白带在
  // xterm 缓冲层，外层收带（installTerminalBottomAlign 只写外层 scrollTop）结构性
  // 够不着（2026-10-18 实测：30 行屏 17 行空白，外层 gap 却是 0）。有效底部把尾屏
  // 最后一个含文本行当内容底：地板最多收到这里（空白全部吃掉、上方回滚补位，真实
  // 终端观感：历史在上、活内容贴底）。整屏全空（清屏后未重画 / 3J 后无回滚）回退
  // 真尾——空屏之下没有可对齐的内容，硬拉只会露旧画面。判空只看文本不看背景色：
  // 带背景无字的装饰条会被判空，现网 TUI 底栏都带字，此边界可接受。
  function terminalEffectiveBottomBase(term) {
    const buffer = term.buffer.active;
    const baseY = buffer.baseY;
    let lastPainted = -1;
    for (let y = buffer.length - 1; y >= baseY; y -= 1) {
      const line = buffer.getLine(y);
      if (line && line.translateToString(true).length > 0) { lastPainted = y; break; }
    }
    if (lastPainted < 0) return baseY;
    return Math.min(baseY, Math.max(0, lastPainted - (term.rows - 1)));
  }
  function installTerminalFollowBottomGuard(term) {
    const root = term.element;
    const viewport = root?.querySelector(".xterm-viewport");
    if (!root || !viewport) return;
    let followBottom = true;
    let lastScrollIntentAt = 0;
    const noteIntent = () => { lastScrollIntentAt = Date.now(); };
    root.addEventListener("wheel", noteIntent, { capture: true, passive: true });
    root.addEventListener("touchstart", noteIntent, { capture: true, passive: true });
    root.addEventListener("pointerdown", noteIntent, { capture: true, passive: true });
    // 按住拖动（滚动条拖拽、选择拖动触发 xterm 自己的滚动）持续刷新意图窗口
    root.addEventListener("pointermove", (event) => { if (event.buttons) noteIntent(); }, { capture: true, passive: true });
    // 键盘翻页同样是用户滚动：xterm 原生把 Shift+PageUp/PageDown 译为
    // scrollLines(±(rows-1))（common/input/Keyboard.ts，Home/End 无滚动映射）——
    // 这条路径不产生 wheel/pointer 意图，不补会把从底部翻页的用户误判成抖动拉回。
    root.addEventListener("keydown", (event) => {
      if (event.shiftKey && (event.key === "PageUp" || event.key === "PageDown")) noteIntent();
    }, { capture: true, passive: true });
    // 地板（CD 的 hold/trim 在缓冲层的等价物）：跟随态的停泊行，恒夹在 [内容底, 真尾]。
    // 初始=真尾（空白带完全可见）。trim 见下方 scroll 监听；内容增长时地板随内容底
    // 同幅平移（屏上可视空白恒定，/ 菜单类向下延伸的绘制始终可见）；收缩不动地板。
    let floor = term.buffer.active.baseY;
    let lastEffBottom = null;
    const trackFloor = () => {
      const buffer = term.buffer.active;
      if (!terminalBottomAlignEnabled()) { floor = buffer.baseY; lastEffBottom = null; return; }
      const eff = terminalEffectiveBottomBase(term);
      if (lastEffBottom !== null && eff > lastEffBottom) floor += eff - lastEffBottom;
      lastEffBottom = eff;
      if (floor > buffer.baseY) floor = buffer.baseY;
      if (floor < eff) floor = eff; // 内容长过地板=地板被顶起（CD 的 settle 语义）
    };
    // 底部基准：开关关=缓冲真尾（与历史行为逐位一致）；开关开=地板。
    const bottomBase = () => (terminalBottomAlignEnabled() ? floor : term.buffer.active.baseY);
    let intentRetryTimer = null;
    let replayTimer = null;
    // 视口唯一写者：增长跟随、尺寸变化重锚、回放落点都汇到这里，过同一组闸。
    // 意图窗内不动作但补排到窗口结束——直接 return 会让这次跟随永远丢失。
    const anchorToBottom = () => {
      if (terminalReplayRestoring) return;
      if (!terminalBottomAlignEnabled()) return;
      if (!followBottom) return;
      if (term.buffer.active.type === "alternate") return; // 备屏无滚动历史，baseY=0，不参与
      if (terminalImeHold) return;
      if ($("terminalView")?.hidden) return;
      if (!term.element?.isConnected) return;
      const intentLeft = TERMINAL_SCROLL_INTENT_MS - (Date.now() - lastScrollIntentAt);
      if (intentLeft > 0) {
        if (intentRetryTimer === null) {
          intentRetryTimer = setTimeout(() => { intentRetryTimer = null; anchorToBottom(); }, intentLeft + 1);
        }
        return;
      }
      trackFloor();
      // 跟随由护栏全权负责（折回动作会把 xterm 原生跟随的上滚标志置位，原生跟随从此
      // 不纠偏）：地板在哪就停哪，无带时=真尾。不能再以「无带即视口在真尾」提前
      // 返回——那是 / 菜单沉底的直接成因（2026-10-20 定案）。
      if (term.buffer.active.viewportY !== floor) term.scrollToLine(floor);
    };
    // 写解析是内容变化的唯一来源：地板重算后锚定。收缩零动作是地板语义的自然结果。
    term.onWriteParsed?.(() => {
      if (terminalReplayRestoring) {
        terminalReplayRestoreArm?.();
        return;
      }
      anchorToBottom();
    });
    // 尺寸变化后行数变了，内容底与地板的换算基准随之变：重算后锚一次。
    term.onResize?.(() => {
      trackFloor();
      anchorToBottom();
    });
    // 回放闩：reset() 把 ydisp/ybase 归零会派发一次「离底」滚动，回放期间逐块
    // 写入也不是用户滚动——闩住期间护栏零动作。回放每来一块重置静默定时器，
    // 静默一拍后清闩并锚一次；没有回放数据时同一定时器兜底清闩，不会永久闩住。
    // 清闩只恢复「进入回放前本来就在跟随」的会话：用户在读历史时回放结束绝不
    // 拽底（CD：处理白区时视窗自己不动）。
    let armedFollow = true;
    terminalReplayRestoreArm = () => {
      if (replayTimer === null) armedFollow = followBottom; // 一次回放只取首拍的跟随态
      if (replayTimer !== null) clearTimeout(replayTimer);
      replayTimer = setTimeout(() => {
        replayTimer = null;
        terminalReplayRestoring = false;
        // 实例已销毁（关流/切列）就不再碰它的缓冲：闩清掉即可。
        if (!term.element?.isConnected) return;
        followBottom = armedFollow;
        trackFloor();
        anchorToBottom();
      }, TERMINAL_EFFECTIVE_BOTTOM_SETTLE_MS);
    };
    terminalReplayRestoreCancel = () => {
      if (replayTimer !== null) clearTimeout(replayTimer);
      replayTimer = null;
      if (intentRetryTimer !== null) clearTimeout(intentRetryTimer);
      intentRetryTimer = null;
    };
    // 挂在 xterm 自己的 scroll 监听之后（它绑在 open() 里，本护栏在 open 之后装），
    // 读到的 ydisp 已是它翻译过的值：落到地板即恢复跟随（历史意图一并作废——其后
    // 的无意图离底只能是抖动）；有意图的上滚退出跟随并把地板收到经过的最低点
    // （trim，只缩不扩；地板不越过内容底——深滚进历史不削内容）；跟随态下无意图
    // 的离底事件即钳制抖动，拉回地板（无带时=真尾）。
    viewport.addEventListener("scroll", () => {
      if (terminalReplayRestoring) return;
      const buffer = term.buffer.active;
      if (buffer.type === "alternate") return;
      trackFloor();
      const bottom = bottomBase();
      if (buffer.viewportY >= bottom - 1) {
        followBottom = true;
        lastScrollIntentAt = 0;
        return;
      }
      if (Date.now() - lastScrollIntentAt <= TERMINAL_SCROLL_INTENT_MS) {
        followBottom = false;
        if (terminalBottomAlignEnabled() && buffer.viewportY < floor) {
          floor = buffer.viewportY;
          const eff = terminalEffectiveBottomBase(term);
          if (floor < eff) floor = eff;
        }
        return;
      }
      if (!followBottom) return;
      if (bottom < buffer.baseY) term.scrollToLine(bottom);
      else term.scrollToBottom();
    });
  }

  // 底部自动对齐（设置 terminalBottomAutoAlign，缺省关）：窗口收放等尺寸错配期，xterm
  // 渲染层旧高度溢出宿主盒、被外层 .terminal-screen 的 overflow:auto 接住，形成底部可
  // 滚入的空白带（CDP 取证：收窗期实测 263–353px 可滚余量，寿命跟随错配期而非瞬态；
  // 内层 .xterm-viewport 全程贴底恒等，空白不在 buffer 层）。开启后用户上滚翻看历史
  // （wheel 上滚 / Shift+PageUp，与跳顶护栏同一 term root capture 事件面，不在
  // .terminal-screen 上另挂 wheel）即把外层 scrollTop 收 0 吃掉带子；外层滚动事件流内
  // 带意图时效窗同做收带（滚动事件无标记，裸信会把布局抖动误判成用户意图）。动作只写
  // 外层 scrollTop，不写 .xterm-viewport、不调 scrollToBottom/scrollToLines——缓冲层
  // 的空白带（/ 指令表收起形态）由护栏的地板承接：不自动折回，随用户上滚逐拍吃掉，
  // 两条通路各管一层。外层
  // 自然停靠位即 0（带收掉后滚动链终点 = 内容底），「再滚回底部恰好对齐」自动成立。
  const TERMINAL_BOTTOM_ALIGN_BAND_MIN_PX = 4;
  function installTerminalBottomAlign(term) {
    const root = term.element;
    if (!root) return;
    // 外层滚动盒是静态基名 id（终端屏唯一，无按列定址）。
    const screen = $("terminalScreen");
    if (!screen) return;
    const trimOuterBand = () => {
      terminalBottomAlignTrimFrame = null;
      if (!terminalBottomAlignEnabled()) return;
      if (terminalImeHold) return;             // 组字期不动几何
      if ($("terminalView")?.hidden) return;  // 隐藏期不量不动
      const gap = screen.scrollHeight - screen.clientHeight;
      if (gap <= TERMINAL_BOTTOM_ALIGN_BAND_MIN_PX) return;  // 无带/行高取整残余不动
      if (screen.scrollTop <= 0) return;                     // 幂等闸：已在停靠位零写
      screen.dataset.bottomAlignTrim = String(gap);          // 调试属性（取证用）
      screen.scrollTop = 0;
    };
    const scheduleTrim = () => {
      if (terminalBottomAlignTrimFrame !== null) return;
      terminalBottomAlignTrimFrame = requestAnimationFrame(trimOuterBand);
    };
    const noteUpIntent = () => {
      terminalBottomAlignIntentAt = Date.now();
      scheduleTrim();
    };
    root.addEventListener("wheel", (event) => { if (event.deltaY < 0) noteUpIntent(); }, { capture: true, passive: true });
    root.addEventListener("keydown", (event) => {
      if (event.shiftKey && event.key === "PageUp") noteUpIntent();
    }, { capture: true, passive: true });
    // 滚动事件流内逐步收：带内滚动（滚轮到底后链入外层）在意图时效窗内即收——
    // 任何滚速下带子随滚动逐拍消失，视口内容不跳。
    screen.addEventListener("scroll", () => {
      if (Date.now() - terminalBottomAlignIntentAt <= TERMINAL_SCROLL_INTENT_MS) scheduleTrim();
    }, { passive: true });
  }

  function ensureTerminalXterm() {
    const host = $("terminalXtermHost");
    if (!host || terminalXterm || !window.Terminal) return terminalXterm;
    // 隐藏期不创建：open 进 display:none 的宿主后，任何 fit 量到的都是兜底尺寸，
    // xterm 一出厂就是错的列宽（见 fitTerminalXterm 的闸）；建流前的同步 fit 同样
    // 经该闸拦下。
    if ($("terminalView")?.hidden) return terminalXterm;
    const term = new window.Terminal({
      allowProposedApi: true,
      convertEol: true,
      cursorBlink: true,
      // 输入不再把视口写回真尾：跟随态的合法停靠位是内容底（见
      // terminalEffectiveBottomBase），两者冲突时每次按键都会把视口下跳一条
      // 空白带再被护栏折回。用户上翻后打字也停在历史，这是确认过的行为变化。
      scrollOnUserInput: false,
      fontFamily: 'ui-monospace, "Cascadia Mono", "Cascadia Code", SFMono-Regular, Consolas, "Liberation Mono", Menlo, "Noto Sans SC", monospace',
      fontSize: terminalFontSize,
      scrollback: 5000,
      theme: terminalXtermTheme(),
    });
    terminalXterm = term;
    // 剪贴板键位收口：xterm 内核对裸 Ctrl+V 会改发不可见控制字节并阻止浏览器
    // 粘贴（剪贴板内容永远进不了 PTY），对裸 Ctrl+C 恒发中断且同样阻止复制。
    // 自定义键位处理器先于 xterm 求值，返回 false 即把该键整体交还浏览器：
    //   Ctrl+V——原生粘贴落进 xterm 既有的 paste 监听（换行归一与 bracketed
    //     paste 包装不变），内容直达 PTY，不依赖剪贴板权限；
    //   Ctrl+C——有选中时交还浏览器 copy 事件，由 xterm 元素级 copy 监听把终端
    //     选中写进剪贴板（与 Ctrl+Shift+C 同一条通路）；无选中则交回 xterm
    //     照旧发中断。
    term.attachCustomKeyEventHandler((event) => {
      const intent = terminalClipboardKeyIntent(event);
      if (intent === "paste") return false;
      if (intent === "copy" && term.hasSelection()) return false;
      // 修饰 Enter 接管为换行：见 terminalNewlineEnterKey 的语义注释。return
      // false 把键从 xterm 内核求值中摘出（keydown 会被折叠成 "\r" 触发提交，
      // keypress 同样会补折叠一次），换行字节只在 keydown 那一次走与键入定投同一条
      // input POST 通路，字节内容按会话端点分派（terminalNewlineData）；组字态与
      // 已被兜底转发处理过的那一条按 terminalNewlineDeliveryBlocked 只拦不发，无
      // 定投会话（预览态）同样只拦不发。定投目标读建连时固化的会话 id，不读活动会话。
      if (terminalNewlineEnterKey(event)) {
        if (event.type === "keydown" && !terminalNewlineDeliveryBlocked(event) && terminalBoundSessionId !== null) {
          // 与键入同一条口径：换行也是用户动作，攒着的历史先落屏。
          flushTerminalBurst();
          sendTerminalInput(terminalBoundSessionId, terminalNewlineData(terminalSessionFor(terminalBoundSessionId)));
        }
        return false;
      }
      return true;
    });
    if (window.FitAddon?.FitAddon) {
      terminalFitAddon = new window.FitAddon.FitAddon();
      terminalXterm.loadAddon(terminalFitAddon);
    }
    if (window.Unicode11Addon?.Unicode11Addon) {
      terminalXterm.loadAddon(new window.Unicode11Addon.Unicode11Addon());
      terminalXterm.unicode.activeVersion = "11";
    }
    term.open(host);
    installTerminalFollowBottomGuard(term);
    installTerminalBottomAlign(term);
    if (window.WebglAddon?.WebglAddon) {
      try {
        terminalWebglAddon = new window.WebglAddon.WebglAddon();
        terminalWebglAddon.onContextLoss(() => {
          terminalWebglAddon?.dispose();
          terminalWebglAddon = null;
        });
        terminalXterm.loadAddon(terminalWebglAddon);
      } catch (error) {
        terminalWebglAddon = null;
        console.warn("[terminal] WebGL renderer unavailable, using DOM renderer:", error);
      }
    }
    installTerminalImeAnchor(term);
    // 宿主尺寸观察：inspector 收放（约 ±292px）、字号变化等任何改变终端区宽度
    // 的动作都不触发 window resize，只挂窗口监听会漏掉——直接观察宿主元素，
    // 变动走与窗口 resize 同一条防抖入口。首次回调是 observe 的即时机，跳过
    // （建流前的同步 fit 已量准，避免同尺寸重复 POST）。
    if (typeof ResizeObserver === "function") {
      let hostObserverPrimed = false;
      terminalHostResizeObserver = new ResizeObserver(() => {
        if (!hostObserverPrimed) {
          hostObserverPrimed = true;
          return;
        }
        debounceTerminalFit();
      });
      terminalHostResizeObserver.observe(host);
    }
    // 像素密度监视与宿主 RO 同生命周期：建连挂上、拆流摘除（见 closeTerminalStream）。
    armTerminalDprWatch();
    return terminalXterm;
  }

  // 输入法只认焦点输入框。xterm 的隐藏框平时停在屏幕外，组字时再按光标拉回；
  // 组字未结束时内核每次渲染都把它改写到实时光标格（含一条 setTimeout 帧间递归），
  // 高频输出下候选框被拽着跳。组字开始落位后把位置写成 CSS 自定义属性并挂
  // ime-hold 类——样式表 !important 让内核的内联改写视觉失效，不逐帧抢写；
  // 结束前不动，结束后摘类清属性放开。
  function terminalImeAnchorReady(textarea) {
    const left = Number.parseFloat(textarea.style.left);
    const top = Number.parseFloat(textarea.style.top);
    const width = Number.parseFloat(textarea.style.width);
    const height = Number.parseFloat(textarea.style.height);
    return Number.isFinite(left) && left >= 0
      && Number.isFinite(top) && top >= 0
      && Number.isFinite(width) && width > 0
      && Number.isFinite(height) && height > 0;
  }

  function armTerminalImeAnchor() {
    terminalImeHoldFrame = null;
    const textarea = terminalImeAnchorTextarea;
    if (!textarea || terminalImeHold) return;
    if (!terminalImeAnchorReady(textarea)) {
      terminalImeHoldFrame = requestAnimationFrame(() => armTerminalImeAnchor());
      return;
    }
    // 折叠补正（2026-10-20 定案）：xterm 的组字定位按「光标屏内行 × 行高」算，缺
    // viewportY 偏移（CompositionHelper.updateCompositionElements）——底部自动对齐
    // 把视口锚到真尾之上时，组字窗与隐藏输入框恒偏高「折起行数」行。按公开缓冲读数
    // 把 (baseY − viewportY) × cellHeight 补回；光标不在视口内（翻历史中的组字）不
    // 冻结，交回 xterm 原生行为，也不排重试帧空转。
    const buffer = terminalImeAnchorTerm?.buffer.active;
    const cellHeight = Number.parseFloat(textarea.style.lineHeight) || Number.parseFloat(textarea.style.height);
    if (!buffer || !Number.isFinite(cellHeight)) {
      terminalImeHoldFrame = requestAnimationFrame(() => armTerminalImeAnchor());
      return;
    }
    const cursorViewportRow = buffer.baseY + buffer.cursorY - buffer.viewportY;
    if (cursorViewportRow < 0 || cursorViewportRow >= terminalImeAnchorTerm.rows) return;
    const correctedTop = `${Number.parseFloat(textarea.style.top) + (buffer.baseY - buffer.viewportY) * cellHeight}px`;
    textarea.style.setProperty("--ime-hold-left", textarea.style.left);
    textarea.style.setProperty("--ime-hold-top", correctedTop);
    textarea.style.setProperty("--ime-hold-height", textarea.style.height);
    textarea.style.setProperty("--ime-hold-lineheight", textarea.style.lineHeight);
    textarea.classList.add("ime-hold");
    // 可见的组字预览块与输入框同被内核逐帧改写到活光标格，用同一组钉住值冻结。
    const compositionView = textarea.parentElement?.querySelector(".composition-view") ?? null;
    if (compositionView) {
      compositionView.style.setProperty("--ime-hold-left", textarea.style.left);
      compositionView.style.setProperty("--ime-hold-top", correctedTop);
      compositionView.classList.add("ime-hold");
    }
    terminalImeHold = { textarea, compositionView };
  }

  function releaseTerminalImeAnchor() {
    const pendingFit = terminalImeFitPending;
    const hold = terminalImeHold;
    terminalImeHold = null;
    terminalImeFitPending = false;
    if (terminalImeHoldFrame !== null) {
      cancelAnimationFrame(terminalImeHoldFrame);
      terminalImeHoldFrame = null;
    }
    if (hold) {
      hold.textarea.classList.remove("ime-hold");
      hold.textarea.style.removeProperty("--ime-hold-left");
      hold.textarea.style.removeProperty("--ime-hold-top");
      hold.textarea.style.removeProperty("--ime-hold-height");
      hold.textarea.style.removeProperty("--ime-hold-lineheight");
      if (hold.compositionView) {
        hold.compositionView.classList.remove("ime-hold");
        hold.compositionView.style.removeProperty("--ime-hold-left");
        hold.compositionView.style.removeProperty("--ime-hold-top");
      }
    }
    if (pendingFit) fitTerminalXterm();
  }

  function installTerminalImeAnchor(term) {
    const textarea = term?.element?.querySelector(".xterm-helper-textarea");
    if (!textarea) return;
    terminalImeAnchorTextarea = textarea;
    terminalImeAnchorTerm = term;
    // 监听回调按引用成对摘除（见 closeTerminalStream）。
    terminalImeArmHandler = () => armTerminalImeAnchor();
    terminalImeReleaseHandler = () => releaseTerminalImeAnchor();
    textarea.addEventListener("compositionstart", terminalImeArmHandler);
    textarea.addEventListener("compositionend", terminalImeReleaseHandler);
  }

  // 复活一条已退出的会话：走服务端 /revive，由它按当前安装与设置重新组装
  // 启动参数与凭据（env 从不落盘，宿主自己重启拿不到这些值，起来的就是
  // agent 的原生实例）。同一会话的并发复活合并成一次——输入触发的复活与
  // 页签点击可能同时发生，重复打只会多起一个进程。
  const terminalReviveInflight = new Map();
  function reviveTerminalSession(session) {
    if (!session?.backend) return Promise.resolve(null);
    const existing = terminalReviveInflight.get(session.id);
    if (existing) return existing;
    const run = api("POST", `/api/terminal/sessions/${encodeURIComponent(session.id)}/revive`)
      .then((revived) => {
        if (revived) session.backendState = revived;
        return revived;
      })
      .catch((error) => {
        console.warn(`[terminal] session revive failed (${session.id}):`, error);
        return null;
      })
      .finally(() => terminalReviveInflight.delete(session.id));
    terminalReviveInflight.set(session.id, run);
    return run;
  }

  // 键入的唯一出口。进程已退（服务端 409 session_exited）时不把这次输入丢掉：
  // 标记该会话已结束、复活一次、再把这次输入补发过去——用户不该为一次重开
  // 再敲一遍。复活失败则放弃这次输入，由调用方保持沉默（终端上没有新增提示）。
  function sendTerminalInput(sessionId, data) {
    if (sessionId === null || sessionId === undefined) return Promise.resolve(false);
    // 键入即读：往这个终端打字＝看着它，done（跑完未读）标记当场清。
    terminalDoneUnread.delete(sessionId);
    const path = `/api/terminal/sessions/${encodeURIComponent(sessionId)}/input`;
    const session = terminalSessionFor(sessionId);
    return api("POST", path, { data })
      .then(() => true)
      .catch((error) => {
        if (error?.code !== "session_exited") {
          console.warn("[terminal] input delivery failed:", error);
          return false;
        }
        if (session?.backendState) session.backendState = { ...session.backendState, status: "exited" };
        return reviveTerminalSession(session).then((revived) => {
          if (!revived) return false;
          return api("POST", path, { data }).then(() => true).catch((retryError) => {
            console.warn("[terminal] input delivery failed after revive:", retryError);
            return false;
          });
        });
      });
  }

  // 回放突发合并器：一段「一次性重放的历史」必须以一次写入落屏。
  //
  // 病灶（2026-10-19 实测）：[CC] resume 会把整段历史一次性重放出来（实测 271KB /
  // 14 块 / 13ms 吐完）。宿主侧的 SSE 合帧器有一条「待发超 32KB 立即冲刷」的规则，
  // 于是每块 60KB 上下的历史各自成一帧；客户端收到一帧写一帧、xterm 写一次画一次、
  // 视口跟一次——真实面板逐帧实测视口 309→669→1002→1424→1718→2028→2816→3039，
  // 就是用户看到的「从对话头部出现、随后飞速滚到底」。同一段字节攒成一次写只落
  // 两帧且一次到底，两者的差别只在这里。
  //
  // 判据与边界：单帧 ≥16KB 才进入突发模式（正常流式输出是几十到几百字节的碎块，
  // 零延迟直通，手感不变）。突发内继续累积，三种情况落屏——静默 80ms（合并后帧间
  // 间隔塌缩到毫秒级，这个窗口只用来兜住主线程抖动）、从突发开始算 700ms（持续
  // 洪峰不能无限期不画）、累计 2MB（再大就不是「一次重放」而是长任务，先落屏）。
  //
  // 为什么在客户端而不是服务端：服务端不知道渲染节奏。把服务端合帧窗口从 16ms 拉到
  // 50ms 实测只能把 7 帧降到 2 帧、仍然会跳，而且拖慢所有实时输出。
  //
  // 与同步合帧（writeStreamChunk）的层次：本层在外、合帧层在内，冲刷与小帧都经
  // terminalStreamWrite 进合帧层、由它唯一写 term——若本层直写 term，80ms 冲刷会
  // 抢在合帧层 400ms 兜底之前落屏，攒着的旧字节反排到新字节后面写花屏。连接关闭
  // 后 streamWrite 为空，冲刷回退直写（此时写的是已 dispose 的旧 term，本就该兜底）。
  //
  // 落屏不自己调 scrollToBottom：跟随底只有一个写者（installTerminalFollowBottomGuard
  // 的 onWriteParsed 锚定），这里再加一个就是两个写者打架。
  const TERMINAL_BURST_ENTER_BYTES = 16 * 1024;
  const TERMINAL_BURST_QUIET_MS = 80;
  const TERMINAL_BURST_MAX_HOLD_MS = 700;
  const TERMINAL_BURST_MAX_BYTES = 2 * 1024 * 1024;

  function flushTerminalBurst() {
    const burst = terminalWriteBurst;
    if (!burst) return;
    terminalWriteBurst = null;
    if (burst.quietTimer !== null) clearTimeout(burst.quietTimer);
    if (burst.capTimer !== null) clearTimeout(burst.capTimer);
    const write = terminalStreamWrite;
    const text = burst.chunks.join("");
    if (write) write(text);
    else burst.term.write(text);
  }

  function discardTerminalBurst() {
    const burst = terminalWriteBurst;
    if (!burst) return;
    terminalWriteBurst = null;
    if (burst.quietTimer !== null) clearTimeout(burst.quietTimer);
    if (burst.capTimer !== null) clearTimeout(burst.capTimer);
  }

  // 收帧入口：小帧直通，大帧起突发、后续帧并进同一次落屏。
  function queueTerminalChunk(term, text) {
    if (!text) return;
    const burst = terminalWriteBurst;
    if (burst) {
      burst.chunks.push(text);
      burst.bytes += text.length;
      if (burst.quietTimer !== null) clearTimeout(burst.quietTimer);
      if (burst.bytes >= TERMINAL_BURST_MAX_BYTES) {
        flushTerminalBurst();
        return;
      }
      burst.quietTimer = setTimeout(() => flushTerminalBurst(), TERMINAL_BURST_QUIET_MS);
      return;
    }
    if (text.length < TERMINAL_BURST_ENTER_BYTES) {
      const write = terminalStreamWrite;
      if (write) write(text);
      else term.write(text);
      return;
    }
    terminalWriteBurst = {
      term,
      chunks: [text],
      bytes: text.length,
      quietTimer: setTimeout(() => flushTerminalBurst(), TERMINAL_BURST_QUIET_MS),
      capTimer: setTimeout(() => flushTerminalBurst(), TERMINAL_BURST_MAX_HOLD_MS),
    };
  }

  // 终端流是一次性回放重放流：后端（terminal-host.mjs stream()）对每次建立
  // 的连接——包括 SSE 断线后浏览器自动发起的重连——都先发一个 snapshot 帧、
  // 再把全量缓冲以 data 帧从头回放到当前。所以处理 snapshot 之前必须把屏幕
  // 清空，否则重连后旧内容与新回放的缓冲叠加成双份。稳态连接只在建连时收一
  // 次 snapshot、心跳是注释帧，不会因此误清屏。reset-on-snapshot 也是浏览器
  // 侧唯一可靠的重连信号（onerror 之后浏览器自动重连，前端没有钩子）。
  function absorbTerminalSnapshot(term, session, state) {
    // 攒着未落屏的突发属于上一条连接：新连接的整屏重绘会把同样的内容重发一遍，
    // 落屏反而画成双份，直接丢弃。
    discardTerminalBurst();
    term.reset();
    // reset() 后的回放是整段重写：闩到写入静默，期间的滚动与逐块写入都不参与
    // 跟随判定（见 installTerminalFollowBottomGuard）。护栏未装上（无宿主/无
    // viewport）时不置闩，避免闩住后无人清理。
    if (terminalReplayRestoreArm) {
      terminalReplayRestoring = true;
      terminalReplayRestoreArm();
    }
    // 紧随 snapshot 的第一帧是宿主的自足整屏重绘（stream() 只发一帧 replay，镜像
    // 与原始字节两条路径都是单帧），它本身就是一次完整落屏——走合并器只会平白多
    // 等一个静默窗口。标记出来让 data 监听直写。
    terminalReplayFramePending = true;
    session.backendState = state;
    session.shell.pid = state.pid || "—";
  }

  async function connectTerminalStream(session, { revive = true } = {}) {
    // 隐藏期不建流：流连着 xterm 实例，隐藏期建流等于把首帧回放任进错误列宽里
    // 折行（见 fitTerminalXterm 的闸）。闸放在 closeTerminalStream 之前——离开
    // 终端页后活着的那条流，不能被隐藏期的重渲染路径（fetch 完成、轮询）关掉。
    if ($("terminalView")?.hidden) return;
    closeTerminalStream();
    const term = ensureTerminalXterm();
    if (!term) return;
    // 应答定投：每条连接的 xterm 实例只服务本次连接的会话，键入与 TUI 查询的自动应答
    // 一律发往建连时固化的会话 id，不读页级活动会话——切换后旧会话迟到的字节
    // 与其回调不可能经此实例打进别的 PTY。预览会话无后端，定投为空，键入直接
    // 落空（与旧行为一致）。定投先于建流前 fit 固化：fit 的 resize POST 也走
    // 定投的会话（见 fitTerminalXterm）。
    const boundSessionId = session?.backend ? session.id : null;
    terminalBoundSessionId = boundSessionId;
    // 建流前先同步 fit：SSE 首帧回放与 rAF 谁先到达是竞速，回放若按 xterm 出厂
    // 默认列宽（80）落进缓冲区，之后加大列宽不会重排已折行内容——先量准列宽、
    // 把真实尺寸 POST 进 PTY，再开流收首帧。
    fitTerminalXterm();
    term.reset();
    // 回放闩：reset() 把 ydisp/ybase 归零，回放逐块写入也会改写视口——两者都
    // 不是用户滚动，闩住到写入静默后再锚定（见 installTerminalFollowBottomGuard）。
    if (terminalReplayRestoreArm) {
      terminalReplayRestoring = true;
      terminalReplayRestoreArm();
    }
    // 建流即焦点回守：进页、切签、新建、降级重试都经此处，终端的隐藏输入框
    // 重新拿到焦点，其后的键入与 Ctrl+C/V 才不会静默落空。
    term.focus();
    terminalInputDisposable = term.onData((data) => {
      // 用户开始键入即落屏：攒着的历史不能排在输入回显后面。
      flushTerminalBurst();
      if (boundSessionId === null) return;
      sendTerminalInput(boundSessionId, data);
    });
    if (!session?.backend) {
      for (const [, text] of session?.output || []) term.write(`${text}\r\n`);
      return;
    }
    // 从上次中断继续回来的会话进程已死（快照 status: exited）：点开页签先在原
    // cwd/壳上重启它再建流——一次点击就是新壳，否则键入只会落进 409。
    // revive:false 是被动重挂（切回前台、回终端页补挂），不等于用户挑了这条会话：
    // 进程已退就只回放宿主镜像里的最后一屏，绝不替用户重开（挂流并不要求进程还在；
    // revive 走的重开路由保史——历史归页签，新进程续写在旧画面下方）。
    // 复活走 /revive 而不是裸 restart：agent 会话的凭据只在内存里，裸 restart 起来
    // 的是没有 relay 地址与 token 的原生实例（也就是一次空白新对话）。
    if (revive && session.backendState?.status === "exited") {
      await reviveTerminalSession(session);
    }
    // 同步输出合帧（`\e[?2026h` … `\e[?2026l`）：Kimi 等 TUI 用这对标记声明「这一整屏
    // 要原子提交」。宿主 SSE 的 32KB 冲刷会把一次整屏重绘拆成两帧送达，先到的那半帧
    // 只有清屏和半屏内容——帧首的 2J/3J 已把视口打到顶部——后到的半帧才补齐内容底，
    // 视口于是按重绘节奏在头尾之间来回跳（实测 8 次/秒）。这里在标记之间攒住字节、
    // 闭合时一次写入：一次 write 只解析一遍、只渲染一次，中间态永远不落到屏上。
    // 不带标记的输出（增量刷新的 agent）零延迟直通，行为不变。标记被劈在两帧之间时
    // 扣住尾部前缀，下一帧拼回再判；标记迟迟不闭合按上限兜底冲刷，不把画面锁死。
    const TERMINAL_SYNC_OPEN = "\u001b[?2026h";
    const TERMINAL_SYNC_CLOSE = "\u001b[?2026l";
    const TERMINAL_SYNC_HOLD_MAX_MS = 400;
    const TERMINAL_SYNC_HOLD_MAX_BYTES = 2 * 1024 * 1024;
    let syncHolding = false;
    let syncBlock = "";
    let syncCarry = "";
    let syncTimer = null;
    const flushSyncBlock = () => {
      if (syncTimer !== null) {
        clearTimeout(syncTimer);
        syncTimer = null;
      }
      if (!syncHolding) return;
      const block = syncBlock;
      syncHolding = false;
      syncBlock = "";
      if (block) term.write(block);
    };
    const armSyncTimer = () => {
      if (syncTimer !== null) return;
      syncTimer = setTimeout(() => { syncTimer = null; flushSyncBlock(); }, TERMINAL_SYNC_HOLD_MAX_MS);
    };
    // 尾部是标记前缀的长度：只有真正劈开的标记才扣住，其余字节照常当拍落屏。
    const syncMarkerPrefixLength = (text, marker) => {
      for (let n = Math.min(marker.length - 1, text.length); n >= 2; n -= 1) {
        if (text.endsWith(marker.slice(0, n))) return n;
      }
      return 0;
    };
    const writeStreamChunk = (chunkText) => {
      let text = syncCarry + chunkText;
      syncCarry = "";
      while (text) {
        if (syncHolding) {
          const closeAt = text.indexOf(TERMINAL_SYNC_CLOSE);
          if (closeAt < 0) {
            const keep = syncMarkerPrefixLength(text, TERMINAL_SYNC_CLOSE);
            syncBlock += keep > 0 ? text.slice(0, text.length - keep) : text;
            syncCarry = keep > 0 ? text.slice(text.length - keep) : "";
            if (syncBlock.length > TERMINAL_SYNC_HOLD_MAX_BYTES) flushSyncBlock();
            return;
          }
          syncBlock += text.slice(0, closeAt + TERMINAL_SYNC_CLOSE.length);
          text = text.slice(closeAt + TERMINAL_SYNC_CLOSE.length);
          flushSyncBlock();
          continue;
        }
        const openAt = text.indexOf(TERMINAL_SYNC_OPEN);
        if (openAt < 0) {
          const keep = syncMarkerPrefixLength(text, TERMINAL_SYNC_OPEN);
          const body = keep > 0 ? text.slice(0, text.length - keep) : text;
          if (body) term.write(body);
          syncCarry = keep > 0 ? text.slice(text.length - keep) : "";
          return;
        }
        if (openAt > 0) term.write(text.slice(0, openAt));
        text = text.slice(openAt);
        syncHolding = true;
        syncBlock = "";
        armSyncTimer();
        // 不 return：开标记所在的那一段可能在同一帧里就闭合了。
      }
    };
    // 流关闭 / 重连 snapshot 时未闭合的块一律作废：它属于上一段画面，不能写进新屏。
    terminalStreamSyncCancel = () => {
      if (syncTimer !== null) {
        clearTimeout(syncTimer);
        syncTimer = null;
      }
      syncHolding = false;
      syncBlock = "";
      syncCarry = "";
    };
    // burst 冲刷与小帧都经这里进合帧层（见 queueTerminalChunk 层次注释）：
    // 本连接存续期间有效，closeTerminalStream 摘除。
    terminalStreamWrite = writeStreamChunk;
    terminalEventSource = new EventSource(`${API_BASE}/api/terminal/sessions/${encodeURIComponent(session.id)}/stream`);
    terminalEventSource.addEventListener("snapshot", (event) => {
      terminalStreamSyncCancel?.();
      try {
        absorbTerminalSnapshot(term, session, JSON.parse(event.data));
      } catch {}
    });
    terminalEventSource.addEventListener("data", (event) => {
      try {
        const text = JSON.parse(event.data);
        // 建连后的第一帧是自足整屏重绘（见 absorbTerminalSnapshot），直写——此刻
        // 合帧层刚被 snapshot 清空、burst 也刚被丢弃，两层都干净，直写不乱序；
        // 它自带完整画面，进合并器只会平白多等一个静默窗口。
        if (terminalReplayFramePending) {
          terminalReplayFramePending = false;
          // 首帧回放落地即记一拍（垫片观察者的就绪判据 b，见 watchTerminalStaleScreen）。
          // 必须在这里记而不是让观察循环逐帧看 terminalReplayFramePending：snapshot 与
          // 首帧 data 实测只隔 0.6ms、同帧到达，rAF 采样永远看不见那个中间态。
          // typeof 闸护单测桩环境（同 renderTerminalRail）：那些沙箱把本函数整段切出真跑，
          // 没有这条计数设施。
          if (typeof terminalReplayEpoch === "number") terminalReplayEpoch += 1;
          term.write(text);
          return;
        }
        // 其后的帧走突发合并器（见 queueTerminalChunk）：小帧经合帧层零延迟直通，
        // 大段历史攒成一次写入，逐块写就是「飞速滚到底」。
        queueTerminalChunk(term, text);
      } catch {}
    });
    terminalEventSource.onerror = () => {
    };
  }

  // 同拍同步执行：五个调用方（页签条收展 / inspector 收放 / 空壳塌缩 / 会话
  // 切换 / 进终端页）都在同一任务里刚改完布局再调它，同步 fit 经强制重排当场
  // 量到新几何，容器与画布的变化落进同一帧。旧双 rAF 把适配推迟两帧、又依赖
  // rAF 排队，主线程被会话输出占住时排到一百多毫秒后，其间画布停在旧尺寸，
  // 收展瞬间画布与宿主错开整条页签高度——收起露 65px 空白条、展开溢出裁切
  // 37px（2026-10-17 逐帧实测），这就是页签收展「抽搐」的主体来源。
  function scheduleTerminalFit() {
    if (currentView === "terminal") fitTerminalXterm();
  }

  // 页签条收展（页头「隐藏页签/展示页签」钮）：整排收起会话页签给终端屏让高。
  // 收放只走 scheduleTerminalFit——与 inspector 收放同一先例：它改变终端区高度
  // 却不经 window resize；fit 仍在 fitTerminalXterm 体内过既有全部闸门（视图闸 /
  // 窗口级尺寸闸 / 组字挂起 / 同尺寸不 POST），本功能不另起 resize 通路。
  // apply 只落 DOM 与文案不触发 fit：初始化恢复时终端流未建，进页既有通路按
  // 含本态的布局量准；隐藏态本身不改变「宿主量不量得到可信尺寸」的判定。
  const TERMINAL_TABS_HIDDEN_KEY = "panel-terminal-tabs-hidden";
  let terminalTabsHidden = false;
  function applyTerminalTabsHidden(hidden) {
    terminalTabsHidden = !!hidden;
    $("terminalTabsBar")?.classList.toggle("is-hidden", terminalTabsHidden);
    const button = $("terminalTabsToggleBtn");
    if (!button) return;
    const label = terminalTabsHidden ? "展示页签" : "隐藏页签";
    button.textContent = label;
    button.title = label;
    button.setAttribute("aria-label", label);
    button.setAttribute("aria-expanded", String(!terminalTabsHidden));
  }
  function setTerminalTabsHidden(hidden) {
    applyTerminalTabsHidden(hidden);
    try { localStorage.setItem(TERMINAL_TABS_HIDDEN_KEY, terminalTabsHidden ? "1" : "0"); } catch {}
    scheduleTerminalFit();
  }
  function terminalPreviewLineHtml([kind, text]) {
    return `<div class="terminal-line${kind ? ` ${kind}` : ""}">${escapeHtml(text)}</div>`;
  }

  // 两处每拍重建的 innerHTML 指纹（页签栏 / 请求行列表）：存「上次实际写进 DOM 的
  // 整串」。1s 轮询稳态下这两块内容大多没变，逐拍赋值 innerHTML 是纯浪费的 DOM
  // 解析与整子树替换（主线程固定开销）；渲染函数改为先拼完整串、与指纹逐字比对，
  // 相同即跳过赋值（DOM 零写）。active 态、请求行展开态都已在串里，比对天然覆盖，
  // 不需要单独失效逻辑。页签栏另有三处直写 innerHTML="" 的退场路径（首连在飞 /
  // 降级 / 关停清场），直写处必须同步重置指纹，保住「指纹 = DOM 现值」这条不变式
  // ——否则退场后的下一次同串渲染会被误跳过，页签栏留在空态。
  let terminalTabsRenderedHtml = "";
  let terminalRequestListRenderedHtml = "";

  function renderTerminalPreviewTabs() {
    const tabs = $("terminalTabs");
    if (!tabs) return;
    const sessions = terminalSessionMap();
    const activeId = activeTerminalPreviewId;
    const html = Object.entries(sessions).map(([id, session]) => {
      // 标签副行：一键启动的会话优先显示 agent 名（快照自带，不等归属轮询），
      // 其后才是归属注入的 agent.name，最后回落外壳名。
      const tabAgent = session.agentName || (session.agent ? session.agent.name : session.shell.name);
      const shellBadge = `<span class="terminal-tab-shell${session.shell.name === "PowerShell" ? "" : " terminal-tab-shell-cmd"}">${session.shell.name === "PowerShell" ? "PS" : ">_"}</span>`;
      // 页签左图标：身份已知（实时归属的 endpointId，或一键启动快照自带的 agentId）
      // 改挂看板品牌头像槽位——串里只留槽，头像在 innerHTML 后克隆填入（与常驻保活
      // 图标、路由瓦片同一来源同一手法）；槽位默认内容就是外壳徽标，品牌 id 不在
      // 看板时克隆落空、徽标原样兜底。id 过白名单字符：它同时进 HTML 属性与 CSS 选择器。
      const rawBrandId = session.agent?.endpointId || session.agentId || "";
      const brandId = /^[\w-]+$/.test(rawBrandId) ? rawBrandId : "";
      const tabIcon = brandId ? `<span class="terminal-tab-brand" data-terminal-brand="${brandId}">${shellBadge}</span>` : shellBadge;
      // 页签指示位（dsh 四态机的行内子集）：槽内容与会话栏行首槽同一判定
      // （terminalRailStateSlotHtml——working 转圈／非聚焦的 done 绿点／空，勿写
      // 两份口径）；idle 不画任何图标（灰点退役）。指示位是常驻定宽槽（沿用会话
      // 栏行首槽原则），转圈出现/消失不推挤页签文字；title 只在工作态挂「进行中」
      //（绿点自带 title「已完成」），idle 无悬停提示。
      const tabState = terminalRailStateSlotHtml(session, activeId);
      return `
      <button type="button" class="terminal-tab${id === activeId ? " active" : ""}" role="tab"
        aria-selected="${id === activeId ? "true" : "false"}" data-terminal-tab="${escapeHtml(id)}">
        ${tabIcon}
        <span class="terminal-tab-copy"><strong>${escapeHtml(session.label)}</strong><small>${escapeHtml(tabAgent)}</small></span>
        <span class="terminal-tab-state"${session.status === "working" ? ' title="进行中"' : ""}>${tabState}</span>
        <span class="terminal-tab-close" aria-hidden="true">×</span>
      </button>
    `;
    }).join("");
    // 指纹门控（缓存声明处的注释）：整串与上次相同即跳过赋值。
    if (html === terminalTabsRenderedHtml) return;
    terminalTabsRenderedHtml = html;
    tabs.innerHTML = html;
    // 品牌头像后填：克隆看板 .agent-avatar 整体（各家底衬/描边/圆角都是内联样式，
    // 只取字形会糊）。品牌 id 已编进指纹串，身份变化必然触发重渲染+重填，不会
    // 滞留旧身份。typeof 双闸门：单测桩环境没有 document/querySelectorAll，跳过
    // 后填不影响串断言。
    if (typeof document !== "undefined" && typeof tabs.querySelectorAll === "function") {
      for (const slot of tabs.querySelectorAll("[data-terminal-brand]")) {
        const avatar = document.querySelector(`.agent-cards-container .panel-card[data-agent-id="${slot.getAttribute("data-terminal-brand")}"] .agent-avatar`);
        if (avatar) slot.replaceChildren(avatar.cloneNode(true));
      }
    }
  }

  // ---- 归属数据轮询（虚拟终端接真实 Agent 流量） ----
  // 每拍：拉会话列表（panel 已按 shell pid 归属注好 agent）→ 拉 agents 负载
  // → 按 instanceId 找实例行，套看板口径的指标 / 状态 / 服务归属（实例身份
  // 优先、路由当前跳后备）；最近请求只查活动标签的那一个实例。普通终端
  //（无归属）session.agent 恒为 null，监测区按规范整列隐藏。

  function enrichTerminalSessions(agentsPayload) {
    const chains = boardRoutingChains();
    const runtime = routeRuntimeState === "ok" ? routeRuntimeCache : null;
    for (const session of Object.values(terminalBackendSessions)) {
      if (!session?.backend) continue;
      const agent = session.agent || null;
      const instance = terminalInstanceRow(agentsPayload, agent);
      // 状态口径与活跃真值流同源：请求在途，或输出活跃窗内且本回合已入闸
      // （terminalSessionBusyFromSignals）。
      // 算完过 noteTerminalWorkingStatus（done 未读标记的翻转观测，同 SSE 写点）。
      const activeRequests = instance && Number(instance.activeRequests) > 0 ? Math.trunc(instance.activeRequests) : 0;
      session.status = terminalSessionBusyFromSignals(session, activeRequests) ? "working" : "idle";
      noteTerminalWorkingStatus(session, session.status);
      session.metrics = instance ? terminalMetricsFromInstance(instance) : null;
      const { route, routeCurrent } = agent
        ? terminalRouteForEndpoint(agent.endpointId, chains, runtime)
        : { route: [], routeCurrent: 0 };
      session.route = route;
      session.routeCurrent = routeCurrent;
    }
  }

  async function refreshActiveTerminalRequests() {
    const session = terminalSessionFor(activeTerminalPreviewId);
    if (!session?.backend || !session.agent?.instanceId) {
      if (session?.backend) session.requests = [];
      return;
    }
    const query = new URLSearchParams({ agentId: session.agent.endpointId, instanceId: session.agent.instanceId });
    const data = await api("GET", `/api/terminal/requests?${query.toString()}`).catch(() => null);
    if (!data || !Array.isArray(data.requests)) return; // 失败帧保留上一帧
    session.requests = terminalRequestsFromRows(data.requests);
  }

  async function pollTerminalSessions() {
    if (!terminalBackendReady || terminalPollInFlight) return;
    terminalPollInFlight = true;
    try {
      const data = await api("GET", "/api/terminal/sessions");
      rebuildTerminalBackendSessions(data.sessions);
      await refreshRouteRuntimeCache();
      const agentsData = await api("GET", "/api/agents").catch(() => null);
      enrichTerminalSessions(agentsData?.agents ?? null);
      await refreshActiveTerminalRequests();
      renderTerminalPreviewTabs();
      // 归属轮询同拍同步终端会话栏：「打开的终端」读归属，慢一拍就会「页签已显示
      // agent、左栏还列着空槽」。异常不打断本轮轮询的其余收尾。
      try {
        if (typeof renderTerminalRail === "function") renderTerminalRail();
      } catch (error) {
        console.warn("[terminal] rail render failed:", error);
      }
      if (Object.keys(terminalBackendSessions).length === 0) {
        // 会话在别处被关光（另一个面板窗口、服务端重建后的空列表）：与关最后
        // 一个标签同路落空态，不挂上一会话的残留数据。
        renderTerminalEmptyState();
        return;
      }
      renderTerminalSessionData();
    } catch {
      // 归属面任何一环失败都不清屏：上一帧继续显示，下一拍自然重试。
    } finally {
      terminalPollInFlight = false;
    }
  }

  function renderTerminalSessionData() {
    const session = terminalSessionFor(activeTerminalPreviewId);
    if (!session) return;
    $("terminalSessionName").textContent = session.label;
    $("terminalSessionPath").textContent = session.cwd;
    $("terminalSessionBranch").textContent = session.branch || "未设置分支";
    $("terminalShellLabel").textContent = session.shell.name;
    $("terminalInspectorTitle").textContent = session.label;
    // 空壳侧栏：无归属会话没有 Agent 监测数据可展示——不再整列 display:none
    //（收放开关在列内，藏列即藏唯一拉回入口，刷新落到无归属页签后侧栏就无痕
    // 消失），改自动收成 48px 细条：开关保留可随时拉回，展开后指标照实显「—」。
    // 收放都改变终端区宽度（340↔48px）且不经 window resize，须补一次重排。
    const inspector = $("terminalInspector");
    const workspace = $("terminalWorkspace");
    if (inspector && workspace) {
      const hollow = !session.agent;
      const wasEmpty = workspace.classList.contains("is-empty");
      const wasCollapsed = inspector.classList.contains("is-collapsed");
      let collapsed = wasCollapsed;
      if (hollow) {
        // 防抖计数由归属数据拍维护（rebuildTerminalBackendSessions 重建时推进，见
        // 其注释），渲染只读阈值：未到阈值的空壳拍不动当前形态——归属闪断一帧就
        // 收拢再展开的抽搐从这里断根。渲染自身不递增计数。
        if (terminalInspectorUserPinned.has(session.id)) {
          // 用户在此会话空壳态拉回过：保持展开，换页签回来也不缩回
          collapsed = false;
          terminalInspectorHollowCollapsed = false;
        } else if ((terminalHollowStreak.get(session.id) || 0) >= TERMINAL_HOLLOW_COLLAPSE_STREAK) {
          // 连续 3 拍归属观测都空壳才认「真丢了归属」，系统收拢标记也只在此时落
          collapsed = true;
          terminalInspectorHollowCollapsed = true;
        }
        // 计数未到阈值且未被钉住：保持当前形态，等归属数据落定
      } else {
        // 归属恢复清零防抖计数：rebuild 观测到归属的拍已清，此处兜底保证恢复当拍生效
        terminalHollowStreak.delete(session.id);
        terminalInspectorUserPinned.delete(session.id);
        if (terminalInspectorHollowCollapsed) {
          // 归属恢复只展开「系统收拢」的那次；用户自己收起的不动
          collapsed = false;
        }
        terminalInspectorHollowCollapsed = false;
      }
      inspector.classList.toggle("is-collapsed", collapsed);
      workspace.classList.toggle("is-inspector-collapsed", collapsed);
      if (wasCollapsed !== collapsed) {
        // 细条形态随归属自动切换，开关的悬停/读屏口径必须同拍跟上，否则收拢
        // 态的按钮还挂着「收起状态面板」，悬停说反话。
        const button = $("terminalInspectorToggle");
        if (button) {
          button.setAttribute("aria-expanded", String(!collapsed));
          button.title = collapsed ? "展开状态面板" : "收起状态面板";
          button.setAttribute("aria-label", button.title);
        }
      }
      // 可见性归本函数管的只剩「从退场态回来」：poll 直达不经 clearTerminalEmpty-
      // State，is-empty 单列只属零会话/未连接两态的退场机制，在此摘掉。
      inspector.style.display = "";
      workspace.classList.remove("is-empty");
      if (wasEmpty || wasCollapsed !== collapsed) scheduleTerminalFit();
    }
    // 实况行同时答「忙不忙 + 谁在服务」：归属段实例身份优先、路由当前跳后备，
    // 没有可说的服务方（普通终端/身份未上报）就不出模型段。
    const serving = terminalServingLabel(session);
    $("terminalLiveTitle").textContent = session.status === "working" ? "进行中" : "空闲";
    const metrics = session.metrics || null;
    $("terminalLiveDetail").textContent = session.status === "working" && metrics
      ? [serving, `${metrics.activeRequests} 个请求进行中`].filter(Boolean).join(" · ")
      : serving
        ? `最近由 ${serving} 服务`
        : "当前没有进行中的请求";
    $("terminalLiveStatus").classList.toggle("is-idle", session.status !== "working");
    const metricsSection = $("terminalMetricsSection");
    metricsSection.hidden = !metrics;
    $("terminalFootStats").hidden = !metrics;
    if (metrics) {
      $("terminalTtftVal").textContent = metrics.ttft;
      $("terminalTtftLamp").className = `lamp lamp-${metrics.ttftLamp}`;
      $("terminalTpsVal").textContent = metrics.tps;
      $("terminalCacheVal").textContent = metrics.cache;
      $("terminalWorkTimeVal").textContent = metrics.workTime;
      $("terminalWorkTimeUnit").textContent = metrics.workTimeUnit;
      $("terminalFootRequests").textContent = `${metrics.requestCount} 次请求`;
      $("terminalFootTokens").textContent = metrics.tokens;
      $("terminalFootTokensTip").textContent = metrics.tokens;
      updateSparkline("terminalSparkTtft", metrics.sparkTtft, undefined, undefined, TERMINAL_SPARK_SIZE);
      updateSparkline("terminalSparkTps", metrics.sparkTps, undefined, undefined, TERMINAL_SPARK_SIZE);
      updateSparkline("terminalSparkCache", metrics.sparkCache, undefined, undefined, TERMINAL_SPARK_SIZE);
    }
    // 「最近请求」标题行右侧的缓存命中率：与监测区四宫格同源（metrics.cache，
    // prompt 加权口径），无指标或零请求时隐藏——普通终端没有命中率可说。
    $("terminalRequestCount").hidden = !metrics || metrics.requestCount === 0;
    $("terminalRequestCount").textContent = metrics ? `缓存命中 ${metrics.cache}%` : "";
    // 来源显示名走 routeNodeName 口径（未命中回落原始 id）；失败行展开态按行键
    // 跨轮询保留（与请求日志大板 logsExpanded 同模式）。
    // 请求行同款指纹门控（缓存声明处的注释）：整串与上次写入相同即跳过赋值，
    // 展开态本就在串里，比对天然覆盖。
    const requestListHtml = session.requests.map((req) => terminalRequestItemHtml(req, {
      label: routeNodeName(req.provider),
      expanded: terminalRequestExpanded.has(req.key),
    })).join("");
    if (requestListHtml !== terminalRequestListRenderedHtml) {
      terminalRequestListRenderedHtml = requestListHtml;
      $("terminalRequestList").innerHTML = requestListHtml;
    }
    // 底栏失败语义色：只跟随最近一条请求的结果——requests[0] 即最新（服务端
    // 从 journal 尾部倒序取回），最近一条失败「N 次请求」pill 转 danger，
    // 最近一条正常即恢复常色；历史失败行留在列表里不再把字串粘红（与列表
    // 红点同源，数据即轮询面的 per-request ok 标志）。
    $("terminalFootRequests").classList.toggle("is-failed", session.requests[0]?.state === "failed");
  }

  // 会话级静态种子的退场动作，零会话空态与首连在飞两态共用：没有当前会话时，
  // 页签栏、会话名/路径/分支那条、底栏左段（本地终端）、右侧监测区
  // 都是设计稿遗留，一帧都不能露；监测区退场后工作区收成全宽，否则右侧空一列、
  // 空背景被切成半幅。
  function setTerminalSessionChromeVisible(visible) {
    const mode = visible ? "" : "none";
    const sessionBar = document.querySelector(".terminal-session-bar");
    if (sessionBar) sessionBar.style.display = mode;
    const footStatus = document.querySelector(".terminal-foot-status");
    if (footStatus) footStatus.style.display = mode;
    const inspector = $("terminalInspector");
    if (inspector) inspector.style.display = mode;
    const workspace = $("terminalWorkspace");
    if (workspace) workspace.classList.toggle("is-empty", !visible);
  }

  // 零会话空态：终端页一个终端都没有时（关掉最后一个标签、或回归时本就是零
  // 会话），盖一层空背景 + 文字提示，不退出终端页——退出后再进入只会挂一个
  // 没有会话的空页；也不伪装会话。
  function renderTerminalEmptyState() {
    const overlay = $("terminalEmpty");
    if (overlay) overlay.hidden = false;
    setTerminalSessionChromeVisible(false);
  }

  function clearTerminalEmptyState() {
    const overlay = $("terminalEmpty");
    if (overlay) overlay.hidden = true;
    setTerminalSessionChromeVisible(true);
  }

  // 首连在飞那一帧：与降级空态同一套种子退场，只是不盖「服务未运行」那层文字——
  // 此刻还没拿到任何证据，说服务不在是编造。新建键按就绪位保持禁用，画面等首连
  // 定性后由就绪/降级两条路各自重绘。
  function renderTerminalPendingState() {
    const unavailable = $("terminalUnavailable");
    if (unavailable) unavailable.hidden = true;
    const empty = $("terminalEmpty");
    if (empty) empty.hidden = true;
    const metricsSection = $("terminalMetricsSection");
    if (metricsSection) metricsSection.hidden = true;
    const footStats = $("terminalFootStats");
    if (footStats) footStats.hidden = true;
    const tabs = $("terminalTabs");
    if (tabs) {
      tabs.innerHTML = "";
      // 直写清空同步重置指纹（保住「指纹 = DOM 现值」，见指纹缓存声明注释）
      terminalTabsRenderedHtml = "";
    }
    setTerminalSessionChromeVisible(false);
    syncTerminalAddBtn();
  }

  // 降级空态：terminal-host 不在（面板路由回 503 terminal_host_unavailable）时，
  // 终端页只给「服务未运行 + 重试」，不再把 mock 假会话端给用户。xterm 区盖
  // 空态覆盖层、不建流；监测区与底栏统计沿用既有 hidden 通路；新建键
  // 随降级禁用。
  function renderTerminalUnavailableState() {
    const overlay = $("terminalUnavailable");
    // 「已停止 / 启动中」两态改写过同一覆盖层的文案与动作钮：回到未运行态先填回定稿
    const titleEl = $("terminalUnavailableTitle");
    if (titleEl) titleEl.textContent = "终端服务未运行";
    const descEl = $("terminalUnavailableDesc");
    if (descEl) {
      descEl.hidden = false;
      descEl.textContent = "终端服务当前未在运行，点击下方按钮即可启动。";
    }
    const retryBtn = $("terminalRetryBtn");
    if (retryBtn) {
      retryBtn.hidden = false;
      retryBtn.textContent = "启动服务";
      retryBtn.onclick = () => dispatchTerminalUnavailableAction();
    }
    if (overlay) overlay.hidden = false;
    // 降级空态优先于零会话空态：服务不在时没有什么可新建的，「+」一并禁用。
    const empty = $("terminalEmpty");
    if (empty) empty.hidden = true;
    const metricsSection = $("terminalMetricsSection");
    if (metricsSection) metricsSection.hidden = true;
    const footStats = $("terminalFootStats");
    if (footStats) footStats.hidden = true;
    const addBtn = $("terminalAddBtn");
    if (addBtn) addBtn.disabled = true;
    // 静态种子里还有设计稿遗留的假页签/假会话栏/假底栏/假监测区（demo-service/portal、
    // PID 23140、Codex CLI 等）——降级下也必须一并退场，否则空态旁边仍挂着以假乱真的名字。
    // 会话级那几条与零会话共用同一套退场动作（含工作区整体收走，不留空壳）。
    const tabs = $("terminalTabs");
    if (tabs) {
      tabs.innerHTML = "";
      // 直写清空同步重置指纹（保住「指纹 = DOM 现值」，见指纹缓存声明注释）
      terminalTabsRenderedHtml = "";
    }
    setTerminalSessionChromeVisible(false);
  }

  // 「未运行」空态动作钮分派：先现取宿主状态（host/status 路由在 relay 不可达时回
  // state:"unknown" 而非报错）——running 说明 host 活着只是面板没连上，重连即可；
  // stopped / exited 走启动通路；unknown 是 relay 没起，启动 relay 归侧栏按钮，
  // 本钮只给可执行提示。
  function dispatchTerminalUnavailableAction() {
    return api("GET", "/api/terminal/host/status").then((d) => {
      const state = normalizeTerminalHostState(d && typeof d.state === "string" ? d.state : "");
      if (state === "running") connectTerminalBackend();
      else if (state === "stopped" || state === "exited") startTerminalHost();
      else toast("Relay 未在运行，请先在左侧栏点「▶ 启动」", true);
    }).catch(() => {
      toast("Relay 未在运行，请先在左侧栏点「▶ 启动」", true);
    });
  }

  // 新建键与就绪位同拍：降级态禁用（「+」不再产假会话），就绪态放开。
  function syncTerminalAddBtn() {
    const addBtn = $("terminalAddBtn");
    if (addBtn) addBtn.disabled = !terminalBackendReady;
    // 左栏「新建终端」与页签栏加号同一就绪闸：禁用位与就绪位同拍（栏体顺带重渲，
    // 归属/会话表的每一次变化都经这里落到左栏）。
    // 必须 try 包住：本函数在 connectTerminalBackend 的成功链里，栏体渲染一旦抛错
    // 就会被 Promise 链吞成「连接失败」——就绪位翻回 false 并落「终端服务未运行」，
    // 之后每次补连都栽在同一处，页面恒停在停态（刷新落回终端视图正是这条路径）。
    // 栏体是旁挂渲染，它的异常不该决定连接成败。
    try {
      if (typeof renderTerminalRail === "function") renderTerminalRail();
    } catch (error) {
      console.warn("[terminal] rail render failed:", error);
    }
  }

  // ── 终端宿主（terminal-host）生命周期 ──
  // 状态真值在 relay，随 /api/status 每秒下发（refreshStatus → applyTerminalHostState）；
  // 起停走 /api/terminal/host/start|stop，relay 不可达时这两个端点回 503（api() 抛出）。
  // 状态词表即定稿四态：running / stopped（手动关停）/ exited（异常退出）/ unknown。
  // 面板路由透传 relay 的细分词（stopped-manual / crashed），入前端前一律先归一，
  // 分支与徽标只认归一后的词。
  let terminalHostState = "unknown";
  // 起停在飞标志：一轮起停未落地前按住页头起停钮（轮询每拍重算可用态，不压住会重复
  // 触发），同时挡住「重新运行」迁移里的自动补连（它会与启动通路的连接重复发起）。
  let terminalHostOpInFlight = false;

  function normalizeTerminalHostState(raw) {
    if (raw === "running") return "running";
    if (raw === "stopped" || raw === "stopped-manual") return "stopped";
    if (raw === "exited" || raw === "crashed") return "exited";
    return "unknown";
  }

  const TERMINAL_HOST_BADGE_MAP = {
    running: ["badge badge-ok", "运行中"],
    stopped: ["badge badge-neutral", "已停止"],
    exited: ["badge badge-danger", "异常"],
  };

  function syncTerminalHostControls() {
    const [cls, label] = TERMINAL_HOST_BADGE_MAP[terminalHostState] || ["badge badge-neutral", "状态未知"];
    // 同态异词：入口卡（看板侧）在服务从未启动过的冷态也会出现，「未运行」是
    // 中性事实；终端页头徽标多在关停动作后看到，「已停止」承接动作语境。
    const entryLabel = terminalHostState === "stopped" ? "未运行" : label;
    for (const el of [$("terminalHostBadge"), $("terminalHostHeadBadge")]) {
      if (!el) continue;
      el.className = cls;
      // 文案写在 .badge-text 内层：窄屏档只藏内层留圆点，外层类名与底色不动
      (el.firstElementChild || el).textContent = el.id === "terminalHostBadge" ? entryLabel : label;
    }
    // 起停二合一钮：运行中呈关停、已停止/异常呈启动，状态未知按住不动
    const toggleBtn = $("terminalHostToggleBtn");
    if (!toggleBtn) return;
    const canStop = terminalHostState === "running";
    const canStart = terminalHostState === "stopped" || terminalHostState === "exited";
    toggleBtn.disabled = terminalHostOpInFlight || (!canStop && !canStart);
    toggleBtn.textContent = canStop ? "关停终端服务" : "启动终端服务";
    toggleBtn.classList.toggle("btn-danger", canStop);
    const action = canStop ? "关停终端服务" : "启动终端服务";
    toggleBtn.title = action;
    toggleBtn.setAttribute("aria-label", action);
  }

  function applyTerminalHostState(state, { reconnect = true } = {}) {
    const prev = terminalHostState;
    terminalHostState = state;
    syncTerminalHostControls();
    if (prev === state) {
      // 稳态兜底补连：状态没变的轮询帧原本直接返回，启动后首次连接失败就再无
      // 重试——running 稳态、本地未就绪、人在终端页且起停不在飞时每拍补一次
      // （1s 轮询自然节流）。
      if (state === "running" && reconnect && !terminalBackendReady && currentView === "terminal" && !terminalHostOpInFlight) {
        connectTerminalBackend();
      }
      return;
    }
    if (state === "stopped") {
      // 手动关停（含在别的窗口操作）：本地会话只是服务端真值的缓存，host 一停即失效，
      // 清空后落「已停止」页；保留与否由关停时带的 clearSessions 交给服务端记。
      clearTerminalLocalSessions();
      if (currentView === "terminal") renderTerminalStoppedState();
    } else if (reconnect && state === "running" && prev !== "unknown" && currentView === "terminal" && !terminalBackendReady && !terminalHostOpInFlight) {
      // 停在终端页期间宿主重新运行（别处拉起）：本地未就绪就补连一次。prev 为
      // "unknown" 的帧排除掉——那是面板初载，初装连接已在飞，再补一次即重复连接。
      connectTerminalBackend();
    }
    // exited：页签保留不动（停在最后一帧），只转徽标（syncTerminalHostControls 已做），
    // 不收现场、不自动拉起——拉起只发生在进页时。
  }

  // 「从上次中断的地方继续」开关：settings.json 键 terminalRestoreSessions，缺省视为开。
  // 面板加载时随 loadSettingsState 从 GET /api/settings 回填；读不到一律视为开。
  let terminalRestoreSessions = true;
  // 保存中守卫：一次切换未落库前再切换先翻回，也挡住设置回灌盖掉刚选的值。
  let terminalRestoreSaving = false;

  function terminalRestoreEnabled() {
    return terminalRestoreSessions;
  }

  // 「底部自动对齐」开关：settings.json 键 terminalBottomAutoAlign，缺省视为关（opt-in）。
  // 面板加载时随 loadSettingsState 从 GET /api/settings 回填；读不到一律视为关。
  let terminalBottomAutoAlign = false;
  // 保存中守卫：一次切换未落库前再切换先翻回，也挡住设置回灌盖掉刚选的值。
  let terminalBottomAlignSaving = false;

  function terminalBottomAlignEnabled() {
    return terminalBottomAutoAlign;
  }

  // 关停后清空本地会话状态：页签、流、活动 id 一并走，下次启动从服务端清单重建。
  // 页签栏直接清空，不走 renderTerminalPreviewTabs——未就绪时它读的是预览稿种子会话。
  function clearTerminalLocalSessions() {
    closeAllTerminalStreams();
    terminalBackendReady = false;
    terminalBackendSessions = {};
    activeTerminalPreviewId = null;
    rememberTerminalSessionId(null);
    const tabs = $("terminalTabs");
    if (tabs) {
      tabs.innerHTML = "";
      // 直写清空同步重置指纹（保住「指纹 = DOM 现值」，见指纹缓存声明注释）
      terminalTabsRenderedHtml = "";
    }
    // 关停清场 = 后端会话全数失效：空壳防抖计数与 done 未读表一并清（预览稿会话不动）
    pruneTerminalHollowStreak();
    pruneTerminalDoneState();
  }

  // 「已停止」状态页：与「未运行」同一覆盖层、同一套退场动作，文案与动作钮随即改写。
  function renderTerminalStoppedState() {
    renderTerminalUnavailableState();
    const titleEl = $("terminalUnavailableTitle");
    if (titleEl) titleEl.textContent = "终端服务已停止";
    const descEl = $("terminalUnavailableDesc");
    if (descEl) {
      descEl.hidden = false;
      descEl.textContent = "终端服务当前未在运行，点击下方按钮即可启动。";
    }
    const btn = $("terminalRetryBtn");
    if (btn) {
      btn.hidden = false;
      btn.textContent = "启动终端服务";
      btn.onclick = () => startTerminalHost();
    }
  }

  // 「启动中」状态页：同一覆盖层，只给标题，不给自己打断自己的动作钮。
  function renderTerminalStartingState() {
    renderTerminalUnavailableState();
    const titleEl = $("terminalUnavailableTitle");
    if (titleEl) titleEl.textContent = "正在启动终端服务…";
    const descEl = $("terminalUnavailableDesc");
    if (descEl) descEl.hidden = true;
    const btn = $("terminalRetryBtn");
    if (btn) btn.hidden = true;
  }

  // 启动通路：起手先盖「启动中」进行态（start 等 host 就绪才返回，最长数秒），
  // 拉起成功后立即落地返回的宿主状态（徽标/起停钮不等多 1s 轮询帧），
  // 再走既有连接通路（其失败分支自落「未运行」空态）。
  async function startTerminalHost() {
    if (terminalHostOpInFlight) return;
    terminalHostOpInFlight = true;
    syncTerminalHostControls();
    renderTerminalStartingState();
    try {
      const d = await api("POST", "/api/terminal/host/start");
      applyTerminalHostState(d && typeof d.state === "string" ? normalizeTerminalHostState(d.state) : "running", { reconnect: false });
      await connectTerminalBackend();
    } catch (e) {
      toast(panelError(e, "无法启动终端服务"), true);
      if (terminalHostState === "stopped") renderTerminalStoppedState();
      else renderTerminalUnavailableState();
    } finally {
      terminalHostOpInFlight = false;
      syncTerminalHostControls();
    }
  }

  // 异常退出与非手动未运行的自动拉起（只在进页时发生，无开关）：拉起期间盖住
  // 画区，失败落带启动动作的「已停止」页（状态不可知才落「未运行」页）。
  async function autoStartTerminalHost() {
    if (terminalHostOpInFlight) return;
    terminalHostOpInFlight = true;
    renderTerminalStartingState();
    try {
      const d = await api("POST", "/api/terminal/host/start");
      applyTerminalHostState(d && typeof d.state === "string" ? normalizeTerminalHostState(d.state) : "running", { reconnect: false });
      await connectTerminalBackend();
    } catch {
      terminalBackendReady = false;
      if (terminalHostState === "stopped" || terminalHostState === "exited") renderTerminalStoppedState();
      else renderTerminalUnavailableState();
    } finally {
      terminalHostOpInFlight = false;
      syncTerminalHostControls();
    }
  }

  // 关停入口：零会话直接停；有会话先弹确认，正文写清未退出会话数与保留/移除后果。
  function requestStopTerminalHost() {
    if (terminalHostOpInFlight) return;
    const clearSessions = !terminalRestoreEnabled();
    const sessions = Object.values(terminalBackendSessions);
    if (!sessions.length) {
      executeStopTerminalHost(clearSessions);
      return;
    }
    const liveCount = sessions.filter((s) => (s?.backendState?.status ?? s?.status) !== "exited").length;
    showSkillsModal({
      title: "关停终端服务",
      danger: clearSessions,
      bodyHtml: (liveCount > 0
          ? `<p style="margin:0 0 8px;">${liveCount} 个会话中的终端进程将全部终止，进行中的命令与输出将无法保留。</p>`
          : "")
        + (clearSessions
          ? `<p style="margin:0;">页面将被永久移除，下次启动为空白。</p>`
          : `<p style="margin:0;">页面将在服务下次启动时恢复，可从上次中断的地方继续。</p>`),
      confirmText: "关停",
      onConfirm: () => executeStopTerminalHost(clearSessions),
    });
  }

  async function executeStopTerminalHost(clearSessions) {
    if (terminalHostOpInFlight) return;
    terminalHostOpInFlight = true;
    syncTerminalHostControls();
    try {
      await api("POST", "/api/terminal/host/stop", { clearSessions });
      // host 已停：页签本地直接清（不逐条打 close），徽标立即转「已停止」不等轮询帧
      clearTerminalLocalSessions();
      applyTerminalHostState("stopped");
      if (currentView === "terminal") renderTerminalStoppedState();
    } catch (e) {
      toast(panelError(e, "无法关停终端服务"), true);
    } finally {
      terminalHostOpInFlight = false;
      syncTerminalHostControls();
    }
  }

  // 宿主生命周期控件装配：页头起停二合一钮 + 设置小窗（遮罩/✕关闭，开关即改即存）。
  // 独立于 initTerminalPreview：键盘兜底测试把 initTerminalPreview 抽进桩环境真跑，
  // 生命周期函数不在那份环境里，装配放自己的入口。
  function initTerminalHostControls() {
    syncTerminalHostControls();
    const toggleBtn = $("terminalHostToggleBtn");
    if (toggleBtn) toggleBtn.onclick = () => {
      if (terminalHostState === "running") requestStopTerminalHost();
      else startTerminalHost();
    };
    const settingsModal = $("terminalSettingsModal");
    const restoreToggle = $("terminalRestoreToggle");
    const bottomAlignToggle = $("terminalBottomAlignToggle");
    const closeTerminalSettings = () => { if (settingsModal) settingsModal.classList.remove("show"); };
    const settingsGear = $("terminalSettingsBtn");
    if (settingsGear) settingsGear.onclick = () => {
      if (restoreToggle) restoreToggle.checked = terminalRestoreEnabled();
      if (bottomAlignToggle) bottomAlignToggle.checked = terminalBottomAlignEnabled();
      if (settingsModal) settingsModal.classList.add("show");
    };
    const closeBtn = $("terminalSettingsCloseBtn");
    if (closeBtn) closeBtn.onclick = closeTerminalSettings;
    if (settingsModal) settingsModal.onclick = (e) => {
      if (e.target === settingsModal) closeTerminalSettings();
    };
    if (restoreToggle) restoreToggle.onchange = async () => {
      if (terminalRestoreSaving) {
        restoreToggle.checked = !restoreToggle.checked;
        return;
      }
      const next = restoreToggle.checked;
      terminalRestoreSaving = true;
      terminalRestoreSessions = next;
      restoreToggle.setAttribute("aria-busy", "true");
      try {
        const d = await api("POST", "/api/settings", { terminalRestoreSessions: next });
        if (!d.ok) {
          terminalRestoreSessions = !next;
          restoreToggle.checked = !next;
          toast("设置保存失败", true);
        } else {
          const saved = d.settings?.terminalRestoreSessions;
          if (typeof saved === "boolean") {
            terminalRestoreSessions = saved;
            restoreToggle.checked = saved;
          }
        }
      } catch (e) {
        terminalRestoreSessions = !next;
        restoreToggle.checked = !next;
        toast(panelError(e, "请求失败"), true);
      } finally {
        terminalRestoreSaving = false;
        restoreToggle.removeAttribute("aria-busy");
      }
    };
    if (bottomAlignToggle) bottomAlignToggle.onchange = async () => {
      if (terminalBottomAlignSaving) {
        bottomAlignToggle.checked = !bottomAlignToggle.checked;
        return;
      }
      const next = bottomAlignToggle.checked;
      terminalBottomAlignSaving = true;
      terminalBottomAutoAlign = next;
      bottomAlignToggle.setAttribute("aria-busy", "true");
      try {
        const d = await api("POST", "/api/settings", { terminalBottomAutoAlign: next });
        if (!d.ok) {
          terminalBottomAutoAlign = !next;
          bottomAlignToggle.checked = !next;
          toast("设置保存失败", true);
        } else {
          const saved = d.settings?.terminalBottomAutoAlign;
          if (typeof saved === "boolean") {
            terminalBottomAutoAlign = saved;
            bottomAlignToggle.checked = saved;
          }
        }
      } catch (e) {
        terminalBottomAutoAlign = !next;
        bottomAlignToggle.checked = !next;
        toast(panelError(e, "请求失败"), true);
      } finally {
        terminalBottomAlignSaving = false;
        bottomAlignToggle.removeAttribute("aria-busy");
      }
    };
  }

  // 「+」新建菜单：先选一个已安装的 CLI Agent（或空白终端），再填工作目录。
  // agent 清单取自环境检测（60s 缓存）；拉取失败只留空白终端，不挡住新建。
  const TERMINAL_ADD_MENU_AGENT_IDS = ["claude", "codex", "kimi", "pi", "dsh", "opencode", "grok", "qoder", "zcode"];
  let terminalAddMenuAgents = [];
  let terminalAddMenuAgentsAt = 0;
  let terminalAddMenuSelection = "";

  function closeTerminalAddMenu() {
    const menu = $("terminalAddMenu");
    if (menu) menu.hidden = true;
  }

  function loadInstalledTerminalAgents() {
    if (terminalAddMenuAgentsAt && Date.now() - terminalAddMenuAgentsAt < 60000) {
      return Promise.resolve(terminalAddMenuAgents);
    }
    return api("GET", "/api/environment")
      .then((state) => {
        const clients = Array.isArray(state.clients) ? state.clients : [];
        const agents = [];
        for (const client of clients) {
          if (!client || !TERMINAL_ADD_MENU_AGENT_IDS.includes(client.id)) continue;
          const installations = Array.isArray(client.installations) ? client.installations : [];
          const installed = installations.find((item) => item && item.status === "found" && item.kind === "cli");
          if (installed) agents.push({ id: client.id, name: client.name || client.id });
        }
        terminalAddMenuAgents = agents;
        terminalAddMenuAgentsAt = Date.now();
        return agents;
      })
      .catch(() => null); // 失败不进缓存：下次开菜单再试，当前只留空白终端
  }

  function renderTerminalAddMenuList(agents) {
    const list = $("terminalAddMenuList");
    if (!list) return;
    const items = [{ id: "", name: "空白终端" }, ...(Array.isArray(agents) ? agents : [])];
    list.innerHTML = items.map((agent) => `
      <button type="button" class="terminal-add-menu-item${agent.id === terminalAddMenuSelection ? " is-selected" : ""}" role="radio"
        aria-checked="${agent.id === terminalAddMenuSelection ? "true" : "false"}" data-terminal-add-agent="${escapeHtml(agent.id)}">
        <span class="terminal-add-menu-radio" aria-hidden="true"></span>
        <span class="terminal-add-menu-name">${escapeHtml(agent.name)}</span>
      </button>
    `).join("");
    const note = $("terminalAddMenuNote");
    if (note) {
      if (Array.isArray(agents) && agents.length > 0) {
        note.hidden = true;
      } else {
        note.hidden = false;
        note.textContent = agents === null
          ? "暂时读不到已安装的 CLI Agent，可以先建空白终端"
          : "尚未安装可用的 CLI Agent，可以先建空白终端";
      }
    }
  }

  // 菜单挂「+」右侧：左缘贴加号右缘；右侧放不下就翻到加号左侧（右缘贴加号
  // 左缘），始终紧邻加号、不出血。顶缘贴加号底缘，页签栏高度变化也不漂。
  // 定位祖先是 .terminal-tabs-bar（position: relative）。
  function positionTerminalAddMenu() {
    const menu = $("terminalAddMenu");
    const btn = $("terminalAddBtn");
    if (!menu || !btn || typeof menu.closest !== "function" || typeof btn.getBoundingClientRect !== "function") return;
    const bar = menu.closest(".terminal-tabs-bar");
    if (!bar || typeof bar.getBoundingClientRect !== "function") return;
    const barRect = bar.getBoundingClientRect();
    const btnRect = btn.getBoundingClientRect();
    const gap = 8;
    const width = menu.offsetWidth || 0;
    let left = btnRect.right - barRect.left + gap;
    if (left + width > barRect.width - 12) {
      left = btnRect.left - barRect.left - gap - width;
    }
    menu.style.left = `${Math.max(12, left)}px`;
    menu.style.top = `${Math.max(0, btnRect.bottom - barRect.top + 6)}px`;
  }

  function openTerminalAddMenu() {
    const menu = $("terminalAddMenu");
    if (!menu) return;
    menu.hidden = false;
    positionTerminalAddMenu();
    const cwdInput = $("terminalAddMenuCwd");
    if (cwdInput) cwdInput.value = terminalCwdInitial();
    loadInstalledTerminalAgents().then((agents) => renderTerminalAddMenuList(agents));
  }

  function selectTerminalAddAgent(agentId) {
    terminalAddMenuSelection = agentId;
    const list = $("terminalAddMenuList");
    if (!list) return;
    for (const item of list.querySelectorAll("[data-terminal-add-agent]")) {
      const selected = item.getAttribute("data-terminal-add-agent") === agentId;
      item.classList.toggle("is-selected", selected);
      item.setAttribute("aria-checked", selected ? "true" : "false");
    }
  }

  // 一键启动：凭证只走环境变量注入（服务端组装），这里只递 agentId 与工作目录。
  // resume 可选（M3 契约）：历史会话续接把 { endpoint, id, file } 原样带上，服务端判
  // 不可续接时回 400 resume-unsupported——前端落同一句提示，不暴露短码。
  function createAgentTerminal({ agentId, cwd, resume }) {
    const body = { agentId, cwd, ...terminalCreateSize() };
    if (resume) body.resume = resume;
    return api("POST", "/api/terminal/agent-sessions", body)
      .then((created) => {
        terminalBackendSessions[created.id] = terminalBackendSession(created);
        activeTerminalPreviewId = created.id;
        rememberTerminalSessionId(created.id);
        renderTerminalPreviewSession();
      })
      .catch((error) => {
        // 失败清点（M5）：续接新建失败即撤乐观高亮——点亮的那行没换成，继续说它
        // 选中就是说谎。不带 resume 的新建（⊕/新建终端）不碰 pending：没有哪一次
        // 点击预测过它，别误伤别人在飞的选中。
        if (resume) terminalRailEndSelect(null);
        // 续接类失败（M3 契约的 resume-unsupported，以及同族的 resume-invalid 等）
        // 一律落批准句：后端原文是给开发者看的短码/细节，不能上屏。
        const code = error && (error.serverCode || error.code);
        if (typeof code === "string" && code.startsWith("resume-")) {
          toast("这个 Agent 的会话暂时不能在终端里续接", true);
          return;
        }
        toast(panelError(error, "无法启动这个终端"), true);
      });
  }

  function confirmTerminalAddMenu() {
    const cwdInput = $("terminalAddMenuCwd");
    const cwd = (cwdInput && cwdInput.value ? cwdInput.value : "").trim() || terminalCwdInitial();
    rememberTerminalCwd(cwd);
    closeTerminalAddMenu();
    if (!terminalAddMenuSelection) {
      api("POST", "/api/terminal/sessions", { label: "Anyswitch", cwd, shell: "powershell", ...terminalCreateSize() })
        .then((created) => {
          terminalBackendSessions[created.id] = terminalBackendSession(created);
          activeTerminalPreviewId = created.id;
          rememberTerminalSessionId(created.id);
          renderTerminalPreviewSession();
        })
        .catch((error) => toast(panelError(error, "无法新建终端"), true));
      return;
    }
    createAgentTerminal({ agentId: terminalAddMenuSelection, cwd });
  }

  // 连接 terminal-host 的成功链路：就绪后重渲会话、立即补拍归属轮询、同步活跃
  // 真值流；失败即置回未就绪并按宿主现态落对应空态。初装、空态动作钮 running
  // 分派、进页自动重试共用同一通路，三处复用防止再漏改。
  // 单飞：进页时「上一帧宿主态已知在跑就先补连」与「现取状态后按 running 补连」
  // 会并发落到这里，而成功链各跑一次 renderTerminalPreviewSession/connectTerminalStream
  // （xterm 重建两遍），后发失败还会把就绪位翻回 false——正是要消除的停态。进行中
  // 直接返回同一条 Promise，四条调用路径（点击/刷新恢复/归属轮询/启动）一并去重。
  // 缓存只在落定时清（成功失败都清），所以失败后可重试、稳态下后续调用照常发起。
  // 状态挂在函数自身上而非模块级 let：connectTerminalBackend 会被单测按函数体抽进
  // 桩环境真跑，那些桩不会声明模块级变量——挂函数属性则零依赖成立（也不污染
  // 那些桩的词法作用域）。
  function connectTerminalBackend() {
    const self = connectTerminalBackend;
    if (self.inFlight) return self.inFlight;
    self.inFlight = fetchTerminalSessions().then(() => {
      terminalFirstConnectSettled = true;
      syncTerminalAddBtn();
      // 首连是被动挂载：进程已退只回放最后一屏，不替用户重开。页面加载时
      // 静默起一个新 agent 会让「历史还在」的会话看起来一切正常，实际已经
      // 换成一个空白新对话；要新壳由用户点页签或点重开决定。
      renderTerminalPreviewSession({ revive: false });
      pollTerminalSessions();
      syncTerminalActivityStream();
      // 首连/重连补报一次亮暗：宿主重启会忘掉上报值（回落暗色默认），此处
      // 强制重发把真值追平——刚被 fetch 证明可用，上报不会空转。
      reportTerminalThemeToBackend(true);
    }).catch((error) => {
      terminalFirstConnectSettled = true;
      terminalBackendReady = false;
      console.warn("[terminal] backend unavailable:", error);
      // 兜底页按宿主现态分派：宿主已停时落「已停止」页（带启动动作），不拿「未运行」页顶掉
      if (terminalHostState === "stopped") renderTerminalStoppedState();
      else renderTerminalUnavailableState();
    }).finally(() => {
      // 落定即放行：成功后可再连（重连/降级重试），失败后也可重试。
      self.inFlight = null;
    });
    return self.inFlight;
  }

  // revive:false —— 被动重挂（切回前台、回终端页补挂）专用口径：进程已退的会话只
  // 回放最后一屏，不替用户重开空壳。点页签、新建、降级重试等主动通路照旧走默认。
  // deferScreen:true —— live 行快路径（terminalRailActivateSession）专用口径：
  // 停放/建流/fit 整组延后双 rAF，让栏体高亮当拍先渲（见下方分支内注释）。
  function renderTerminalPreviewSession({ revive = true, deferScreen = false } = {}) {
    // 左栏终端会话栏先渲：它与终端屏的就绪三态无关（降级/零会话时栏体照常可用——
    // 「新建终端」自带就绪闸，历史会话按当前 agent 取）。切页签 / 新建 / 关闭 /
    // 归属恢复都经本函数，栏体不必另设触发点。typeof 闸护单测桩环境；try 护连接
    // 成败——本函数在 connectTerminalBackend 的成功链里，栏体异常不许翻成连接失败。
    try {
      if (typeof renderTerminalRail === "function") renderTerminalRail();
    } catch (error) {
      console.warn("[terminal] rail render failed:", error);
    }
    // 降级闸：判定键是就绪位本身，不是会话数——零会话是就绪下的合法空态（走下方
    // 零会话分支），不能当降级处理；backend 中途死掉的轮询不动就绪位，仍保上一帧。
    if (terminalBackendReady === false) {
      // 首连还在飞：这一帧什么都不知道，既不冒充降级也不冒充零会话，只把静态
      // 种子收走（见 renderTerminalPendingState）。定性失败才落降级空态。
      if (!terminalFirstConnectSettled) renderTerminalPendingState();
      else renderTerminalUnavailableState();
      return;
    }
    const unavailable = $("terminalUnavailable");
    if (unavailable) unavailable.hidden = true;
    const session = terminalSessionFor(activeTerminalPreviewId);
    if (!session) {
      // 零会话：关掉最后一个标签后，或退出再回归时本就是零会话——留在终端页
      // 落空态（空背景 + 文字提示），不退出、也不挂静态占位数据。
      renderTerminalEmptyState();
      return;
    }
    clearTerminalEmptyState();
    const sessionBar = document.querySelector(".terminal-session-bar");
    if (sessionBar) sessionBar.style.display = "";
    const footStatus = document.querySelector(".terminal-foot-status");
    if (footStatus) footStatus.style.display = "";
    renderTerminalSessionData();
    renderTerminalPreviewTabs();
    if (deferScreen) {
      // live 行快路径让帧（M5）：左栏点已开着的会话行时，这一帧先让栏体当拍重渲
      // （高亮即刻点亮），停放＋建流＋fit 三步整组延后到双 rAF 之后——同步任务里
      // 先跑完栏渲染，xterm 重建的耗时不再挡首绘。三步必须成对延后：次序即
      // 「旧画面停放成像素垫片、新画面就绪再揭幕」（92f6ced/b285e3d 立下的机制），
      // 拆开就会有一帧没有垫片的空屏。令牌保连点：醒来发现已不是自己这一帧
      // （用户又点了别的），旧帧整组退场不执行。
      terminalScreenSeq += 1;
      const screenSeq = terminalScreenSeq;
      const runDeferredScreen = () => {
        if (terminalScreenSeq !== screenSeq) return;
        if (typeof parkTerminalScreen === "function") parkTerminalScreen();
        connectTerminalStream(session, { revive });
        if (currentView === "terminal") scheduleTerminalFit();
      };
      if (typeof requestAnimationFrame === "function") {
        requestAnimationFrame(() => requestAnimationFrame(runDeferredScreen));
      } else {
        runDeferredScreen();
      }
      return;
    }
    // 切签/切回都经这里重建流：先把旧画面停成垫片（见 parkTerminalScreen），新画面
    // 首帧落绘后由观察循环撤走——切换期间屏上始终有内容，不再是纯底色。停放与建流
    // 之间没有 await，旧画面不会在这一拍消失。typeof 闸护单测桩环境（同 renderTerminalRail）。
    if (typeof parkTerminalScreen === "function") parkTerminalScreen();
    connectTerminalStream(session, { revive });
    if (currentView === "terminal") scheduleTerminalFit();
  }

  // 挂后台时的会话字节流闸门。终端页其余数据源（1s 归属轮询、看板活跃真值流、统计
  // 页 30s）早就都带 document.hidden 闸，唯独这条字节流没有：隐藏期浏览器照旧投递
  // （实测 5 分钟 7673 帧 / 1.24MB），而 xterm 的解析被钳成每秒只有一个 12ms 时间片
  // （实测灌 2MB：4 片、片间隔 989–999ms）、渲染挂在 rAF 上而隐藏页 rAF 零帧——整段
  // 输出只进不出地挂在页面的 xterm 实例上；浏览器把标签页冻结时更狠，恢复一刻成吨
  // 回灌。切回即卡一阵、只有终端区卡，就是这么来的。
  //
  // 拆流不丢任何东西：PTY 归宿主进程所有，宿主对每段输出都无条件喂回放窗与镜像，
  // 有没有观众都一样画（实测断开流 9 秒，pid、尺寸、产出全不变）。切回时重建，画面
  // 来自镜像的自足重绘（实测跑了 3 小时的会话回放才 22KB，上限 2MB 约合 50ms 工作量）。
  // 顺带一并清掉的还有：错列宽折行、组字锚点悬挂、以及连接已死却无人重建的死角。
  function syncTerminalDataStream() {
    if (!document.hidden) return;
    // 隐藏拆流：切回时按镜像重建（见 switchView / renderTerminalPreviewSession 的补挂通路）。
    if (terminalEventSource || terminalXterm) closeTerminalStream();
  }

  // 活跃真值流的活性门控与轮询完全一致：terminal-backend 就绪、窗口可见、
  // 当前在终端页或看板页才连，缺一即断。断线交给 EventSource 自动重连；重连服务端会
  // 重发快照帧，前端按整帧对齐恢复，不需要补偿逻辑。看板与终端页共用同一条流：
  // 帧按当前视图分流（见 onmessage），离开这两页即断开，不占中继一条空转连接。
  function activityStreamWanted() {
    return terminalBackendReady && !document.hidden && (currentView === "terminal" || currentView === "board");
  }

  function syncTerminalActivityStream() {
    if (activityStreamWanted()) {
      if (terminalActivitySource) return;
      const source = new EventSource(`${API_BASE}/api/agents-activity`);
      terminalActivitySource = source;
      source.onmessage = (event) => {
        let frame = null;
        try { frame = JSON.parse(event.data); } catch { return; }
        if (currentView === "board") {
          // 看板侧：帧改数据不改 DOM，命中端点交其自身渲染器整卡重渲（口径与轮询同源）。
          // claude 是已知边界：其权威行是折叠后的 claude-desktop，而流身份是壳内引擎
          // 会话（claude-<pid>）与端点级，两侧对不上——帧对该卡既不写数也不重渲，
          // 由 1s 轮询单独承载，这是刻意保留（宁可不加速，不把不可比的值写上卡）。
          for (const id of boardActivityApplyFrame(frame, lastBoardAgents)) {
            const target = lastBoardAgents.find((a) => a && a.id === id);
            const render = BOARD_RENDERERS[id];
            if (target && render) render(target);
          }
          return;
        }
        // working 翻转（agent 开跑/回合结束）同拍重渲会话栏：转圈的出现/消失
        // 不等 1s 归属轮询（该轮询本就每拍重渲栏，这里只是把活动流的低延迟接到
        // 栏上）。翻转未发生时不动栏——避免每帧重写 DOM 打断 FLIP/滚动。
        const statusBefore = new Map(Object.values(terminalSessionMap()).map((s) => [s.id, s.status]));
        if (terminalActivityApplyFrame(frame, terminalSessionMap())) {
          renderTerminalSessionData();
          renderTerminalPreviewTabs();
          const flipped = Object.values(terminalSessionMap()).some((s) => statusBefore.get(s.id) !== s.status);
          if (flipped && typeof renderTerminalRail === "function") {
            try {
              renderTerminalRail();
            } catch (error) {
              console.warn("[terminal] rail render failed:", error);
            }
          }
        }
      };
      source.onerror = () => {};
    } else if (terminalActivitySource) {
      terminalActivitySource.close();
      terminalActivitySource = null;
    }
  }

  function initTerminalPreview() {
    const tabs = $("terminalTabs");
    if (!tabs) return;
    // xterm 逐连接重建（见 closeTerminalStream），resize 监听只能在此一次性绑定：
    // 挂在 ensureTerminalXterm 会随每次重建重复注册。fit 入口本身对空实例空操作。
    window.addEventListener("resize", debounceTerminalFit);
    // 新建菜单开着的状态下改窗口大小：加号随页签栏移动，菜单跟着重挂，不脱节。
    window.addEventListener("resize", () => {
      const menu = $("terminalAddMenu");
      if (menu && !menu.hidden) positionTerminalAddMenu();
    });
    restoreTerminalFontSize();
    // 不再先渲 mock：降级态只给真空态（renderTerminalUnavailableState），就绪
    // 与否由连接通路的成功/失败分支落定——失败分支会重落空态，不再静默。
    // 首连发出前先同步落一次 pending 态：静态 HTML 已按骨架直出，这一道是缓存
    // 错位保险——浏览器拿到旧缓存 HTML（自更新窗口）时，脚本运行一刻也会收走
    // 设计稿种子，首连飞行期画面不依赖任何网络时序。
    renderTerminalPendingState();
    syncTerminalAddBtn();
    fetchTerminalDefaultCwd();
    connectTerminalBackend();
    loadInstalledTerminalAgents(); // 启动即预热新建菜单的启动方式列表，点「+」即弹不等探测
    if (!terminalPollTimer) {
      // 初值按"当下"起步：常驻隐藏的环境里这不是转折，兜底拍不该把终端页拆成空白。
      terminalVisibilityWasHidden = document.hidden;
      terminalPollTimer = setInterval(() => {
        syncTerminalActivityStream();
        // 拆流的兜底一拍：只在「本该已进后台但那次转折没送达」时收流。开局就是 hidden
        // 不算转折（terminalVisibilityWasHidden 按初值认），所以常驻隐藏的环境里终端页
        // 照常能建流，不把可验证性一起拆掉。回前台那一侧重建有天然退路——回终端页时
        // 实例为空就补挂（见 switchView）。
        if (document.hidden && !terminalVisibilityWasHidden) {
          terminalVisibilityWasHidden = true;
          syncTerminalDataStream();
        }
        if (document.hidden) return;
        if (currentView !== "terminal") return;
        pollTerminalSessions();
      }, 1000);
    }
    syncTerminalActivityStream();
    tabs.addEventListener("click", (event) => {
      const tab = event.target.closest("[data-terminal-tab]");
      if (!tab) return;
      const id = tab.dataset.terminalTab;
      if (!terminalSessionFor(id)) return;
      if (event.target.closest(".terminal-tab-close")) {
        const session = terminalSessionFor(id);
        if (session.status === "working" && !window.confirm("当前终端仍在运行，关闭后将中断任务。确定继续吗？")) return;
        if (session.backend) {
          api("POST", `/api/terminal/sessions/${encodeURIComponent(id)}/close`).catch(() => {});
          delete terminalBackendSessions[id];
        } else delete terminalPreviewSessions[id];
        // 关标签即会话关闭：空壳防抖计数同步清零，不留陈旧计数
        terminalHollowStreak.delete(id);
        // done（跑完未读）标记与上一拍状态一并清：会话没了，未读态随之失效
        terminalDoneUnread.delete(id);
        terminalPrevWorking.delete(id);
        terminalTurnArmed.delete(id);
        const remaining = Object.keys(terminalSessionMap());
        if (activeTerminalPreviewId === id) activeTerminalPreviewId = remaining[0] || null;
        rememberTerminalSessionId(activeTerminalPreviewId);
        if (remaining.length === 0) {
          // 预览期的「至少保留一个终端标签」遗规已随真实 PTY 失效：最后一个
          // 标签照常可关，但关掉后不退出终端页——退出再回归只会挂一个没有会话
          // 的空页。留在页内落空态（空背景 + 文字提示），「+」留在原处直接新建。
          closeAllTerminalStreams();
          renderTerminalPreviewTabs();
          renderTerminalEmptyState();
          // 会话栏同拍回落中性空树（不等 1s 轮询）：终端都没了，栏不该再挂已关
          // agent 的会话表——空态保持终端页的正常形态（用户 2026-10-24 裁决）。
          renderTerminalRail();
          return;
        }
        renderTerminalPreviewSession();
        return;
      }
      activeTerminalPreviewId = id;
      rememberTerminalSessionId(id);
      renderTerminalPreviewSession();
    });
    $("terminalReturnBtn").onclick = () => closeTerminalPreview();
    $("terminalInspectorToggle").onclick = () => {
      const inspector = $("terminalInspector");
      const workspace = $("terminalWorkspace");
      const button = $("terminalInspectorToggle");
      const collapsed = inspector.classList.toggle("is-collapsed");
      workspace?.classList.toggle("is-inspector-collapsed", collapsed);
      button.setAttribute("aria-expanded", String(!collapsed));
      button.title = collapsed ? "展开状态面板" : "收起状态面板";
      button.setAttribute("aria-label", button.title);
      // 手动收放即接管：清系统收拢标记；空壳态拉回再按会话锁存，1s 轮询的
      // 空壳自动收拢不再与之打架（归属恢复时锁存一并出集合，回默认形态）。
      terminalInspectorHollowCollapsed = false;
      const session = terminalSessionFor(activeTerminalPreviewId);
      if (session && !collapsed && !session.agent) terminalInspectorUserPinned.add(session.id);
      else if (session) terminalInspectorUserPinned.delete(session.id);
      // inspector 收放直接改变终端区宽度（约 292px）却不触发 window resize：
      // 不补一次 fit，xterm 列数与可见区错位、PTY 停在旧列宽，TUI 按旧列宽排版
      // 时右侧会溢出到可见区外（kimi 输入框满行甩行即此形态）。
      scheduleTerminalFit();
    };
    // 页签条收展偏好恢复：只落 DOM/文案（apply 不触发 fit，终端流未建，进页时
    // scheduleTerminalFit 会按含本态的布局量准）；点击翻转走 setTerminalTabsHidden
    //（持久化 + 补一次尺寸适配）。
    try { applyTerminalTabsHidden(localStorage.getItem(TERMINAL_TABS_HIDDEN_KEY) === "1"); } catch { applyTerminalTabsHidden(false); }
    $("terminalTabsToggleBtn").onclick = () => {
      setTerminalTabsHidden(!terminalTabsHidden);
      terminalXterm?.focus();
    };
    $("terminalRedrawBtn").onclick = () => {
      redrawTerminalScreen();
      terminalXterm?.focus();
    };
    $("terminalFontDecBtn").onclick = () => { nudgeTerminalFontSize(-1); terminalXterm?.focus(); };
    $("terminalFontIncBtn").onclick = () => { nudgeTerminalFontSize(1); terminalXterm?.focus(); };
    // 最近请求：失败行点击就地展开/收起错误详情（与请求日志大板行展开同模式）；
    // 列表每拍轮询重建，展开态由 terminalRequestExpanded 行键集合承载。
    $("terminalRequestList")?.addEventListener("click", (e) => {
      const item = e.target.closest(".terminal-request-item.is-expandable");
      if (!item) return;
      const key = item.getAttribute("data-req-key") || "";
      if (!key) return;
      if (terminalRequestExpanded.has(key)) terminalRequestExpanded.delete(key);
      else terminalRequestExpanded.add(key);
      renderTerminalSessionData();
    });
    $("terminalScreen").addEventListener("wheel", (event) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      nudgeTerminalFontSize(event.deltaY < 0 ? 1 : -1);
    }, { passive: false });
    // 点终端屏（含 xterm 四周留白）也聚焦：留白区的点击不会触发 xterm 自身的
    // 聚焦，其后的键入会静默落空。
    $("terminalScreen").addEventListener("mousedown", () => terminalXterm?.focus());
    document.addEventListener("keydown", (event) => {
      if (currentView !== "terminal") return;
      const delta = isTerminalFontZoomKey(event);
      if (!delta) return;
      event.preventDefault();
      nudgeTerminalFontSize(delta);
    });
    // 键盘兜底转发：xterm 靠隐藏输入框收键，首开未就绪/未聚焦的窗口里按键落到
    // 页面主体直接丢失。捕获阶段把可打印键与回车/退格转投活跃会话；方向键、
    // F 键、Tab 等不劫持，宁缺毋错。这里读活跃会话是刻意的：兜底只在焦点不在
    // xterm 时触发，不存在 onData 定投机制所防的跨会话误投问题。
    document.addEventListener("keydown", (event) => {
      if (currentView !== "terminal") return;
      // IME 组字态（isComposing / keyCode 229）最终字节未定，不转发。
      if (event.isComposing || event.keyCode === 229) return;
      // 修饰 Enter 与内核通路共用同一道闸门：这条路径把 Ctrl/Shift+Enter 也发成
      // "\r" 就等于替用户按下提交；Ctrl/Meta/Alt 的放行只针对其余键。
      const newlineEnter = terminalNewlineEnterKey(event);
      if (!newlineEnter && (event.ctrlKey || event.metaKey || event.altKey)) return;
      let data = null;
      if (newlineEnter) data = terminalNewlineData(terminalSessionFor(activeTerminalPreviewId));
      else if (event.key && event.key.length === 1) data = event.key;
      else if (event.key === "Enter") data = "\r";
      else if (event.key === "Backspace") data = "\x7f";
      else return;
      // 焦点守卫：xterm 自持输入时不劫持；其它输入控件（新建菜单 cwd 框等）不劫持。
      const active = document.activeElement;
      if (active?.classList?.contains("xterm-helper-textarea")) return;
      if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.isContentEditable)) return;
      const session = terminalSessionFor(activeTerminalPreviewId);
      if (!session?.backend) return;
      event.preventDefault();
      terminalXterm?.focus();
      sendTerminalInput(session.id, data);
    }, true);
    $("terminalRetryBtn").onclick = () => dispatchTerminalUnavailableAction();
    $("terminalAddBtn").onclick = () => {
      if (terminalBackendReady) {
        const menu = $("terminalAddMenu");
        if (menu && !menu.hidden) {
          closeTerminalAddMenu();
          return;
        }
        openTerminalAddMenu();
        return;
      }
      const id = `preview-${Object.keys(terminalPreviewSessions).length + 1}`;
      terminalPreviewSessions[id] = {
        label: "新终端", cwd: "D:\\dev", branch: "",
        shell: { name: "PowerShell", pid: 24100 + Object.keys(terminalPreviewSessions).length * 37 }, agent: null,
        status: "idle", metrics: null,
        requests: [], output: [["dim", "Windows PowerShell"], ["", ""], ["prompt-line", "PS D:\\dev> "], ["dim", "等待输入…"]],
      };
      activeTerminalPreviewId = id;
      renderTerminalPreviewSession();
    };
    $("terminalAddMenuCancel").onclick = () => closeTerminalAddMenu();
    $("terminalAddMenuConfirm").onclick = () => confirmTerminalAddMenu();
    $("terminalAddMenuList").addEventListener("click", (event) => {
      const item = event.target.closest("[data-terminal-add-agent]");
      if (item) selectTerminalAddAgent(item.getAttribute("data-terminal-add-agent") || "");
    });
    $("terminalAddMenuCwd").addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        confirmTerminalAddMenu();
      }
    });
    // 点菜单外面或按 Esc 收起；点「+」自身不收起（交给 onclick 的切换）。
    document.addEventListener("pointerdown", (event) => {
      const menu = $("terminalAddMenu");
      if (!menu || menu.hidden) return;
      if (menu.contains(event.target)) return;
      if (event.target && typeof event.target.closest === "function" && event.target.closest("#terminalAddBtn")) return;
      closeTerminalAddMenu();
    });
    document.addEventListener("keydown", (event) => {
      if (currentView === "terminal" && event.key === "Escape") closeTerminalAddMenu();
    });
  }

  // 进终端页的宿主状态分派：现取宿主状态再按四态落位，返回归一后的状态。
  // 点击进入（openTerminalPreview）与刷新落回（restoreView）共用这一条——两条路
  // 若各写一份，就会出现「点击能补连、刷新卡在停态」这种只有一条路被修到的分叉。
  // 现取而非用 1s 轮询的上一帧：轮询帧可能停在进页前的旧态。
  async function dispatchTerminalEntry() {
    let hostState = terminalHostState;
    // manualStop 缺省视为 true（手动）：读不到时维持停止态空态，不擅自拉起。
    let manualStop = true;
    try {
      const d = await api("GET", "/api/terminal/host/status");
      if (d && typeof d.state === "string") hostState = normalizeTerminalHostState(d.state);
      if (d && typeof d.manualStop === "boolean") manualStop = d.manualStop;
    } catch {
      hostState = "unknown";
    }
    // reconnect:false——running 的补连由调用方发，不经 applyTerminalHostState
    // 的迁移分支，两处同发即重复连接。
    applyTerminalHostState(hostState, { reconnect: false });
    if (hostState === "stopped" && manualStop) {
      // 手动关停后回归：本地缓存已失效，清空后落「已停止」页
      clearTerminalLocalSessions();
      renderTerminalStoppedState();
    } else if (hostState === "stopped" || hostState === "exited") {
      // 异常退出或非手动原因的未运行：进页自动拉起一次（无开关），拉起期间盖「启动中」
      autoStartTerminalHost();
    } else if (hostState !== "running") {
      // unknown：宿主状态不可知（面板初载或 relay 不可达）——落既有不可用空态
      terminalBackendReady = false;
      terminalFirstConnectSettled = true;
      renderTerminalUnavailableState();
    }
    return hostState;
  }

  // 进终端页的补连口径（点击进入与刷新落回共用）：宿主在跑而本地未就绪就重连一次。
  // 这正是刷新恢复原先缺的那一步——恢复那条只做 switchView，首连失败过的页刷新回来
  // 就恒停在「终端服务未运行」停态（1s 状态轮询的补连分支把初载的 unknown→running
  // 排除在外，指望不上它兜底）。
  function resumeTerminalBackendAfterEntry(hostState) {
    if (hostState === "running" && !terminalBackendReady) connectTerminalBackend();
  }

  async function openTerminalPreview() {
    terminalReturnView = currentView;
    terminalReturnScrollTop = window.scrollY || document.documentElement.scrollTop || 0;
    switchView("terminal");
    // 降级重试：宿主在跑而本地未就绪时进页自动再连一次。判据取上一帧宿主态（1s
    // 轮询维护）——权威判定在下面的分派里，它现取真值再补一次；两处并发由
    // connectTerminalBackend 的单飞合并成一条请求。宿主已停/不可知时不发这一发
    // （那是注定失败的拉取，拉起与空态由分派处理）。
    if (terminalHostState === "running") {
      if (!terminalBackendReady) connectTerminalBackend();
    }
    resumeTerminalBackendAfterEntry(await dispatchTerminalEntry());
  }

  function closeTerminalPreview() {
    switchView(terminalReturnView);
    requestAnimationFrame(() => {
      window.scrollTo(0, terminalReturnScrollTop);
      document.documentElement.scrollTop = terminalReturnScrollTop;
      $("openTerminalPreviewBtn")?.focus();
    });
  }

  // 服务控制（启动 / 停止 / 重启）—— 按钮随 relay 状态动态切换
  // 运行中 → ⏹ 停止（红 btn-danger），停止 → ▶ 启动（蓝 btn-primary）。
  let currentRelayState = { status: "stopped" };

  // 面板服务（panel-host, 47820）自身的重启窗口：true = 已请求它退出、正在等新
  // 进程接管 47820。这个窗口里页面的服务端整个没了，徽标和按钮的每秒重算全部
  // 来自失败请求，不显式压住就会把「面板重启中」误报成「Relay 已停止」。
  let panelRestarting = false;
  // 上一次成功 /api/status 看到的进程身份；pid 或 startTime 变了 = 新进程已接管。
  let lastPanelIdentity = { pid: null, startTime: null };
  const PANEL_RESTART_POLL_MS = 200;
  const PANEL_RESTART_RECOVERY_TIMEOUT_MS = 20_000;

  // ═══ 自更新页面级观察者（关于页之外的状态面）══════════════════════
  // 数据源是 /api/status 的 selfUpdate 捎带字段（refreshStatus 每帧喂进来），
  // 不新增轮询请求。两条职责：
  //   1. 终态提示：关于页没在跟踪这条 run 时就地弹结论（切换页签、刷新后落在
  //      其他视图、任务在后台自行收场都覆盖）；已读标记与关于页同键
  //      （anyswitch:self-update-shown:<runId>），谁先提示谁写，全局恰好一次。
  //   2. 换装接管：「已更新」终态必然经过面板换代（worker 复活验证通过才写）。
  //      无论换装相位有没有被看到（页签隐藏期、捎带缓存压缩都会错过），统一派发
  //      anyswitch:self-update-swap——开屏盖窗+自动刷新到新版因此在任何页签都
  //      成立；同一 run 只派一次，恢复失败也不反复重派。
  // 归属让位：关于页正在跟踪（aboutProbe，initSettingsView 接线）或换装恢复在途
  // （panelRestarting）/ 本页就是换装产物（panelStartupRestart）时，提示与编排
  // 归既有路径，这里只读不写。
  function createSelfUpdateFrameWatcher({ toast, dispatchSwap, isPanelRestarting, isStartupRestartPage, storage = localStorage }) {
    let aboutProbe = null;
    let swapDispatchedFor = null;
    return {
      // 关于页控制器建好后接线：() => Boolean(selfUpdateRun)
      setAboutProbe: (probe) => { aboutProbe = probe; },
      // refreshStatus 每帧喂入的捎带载荷；null = 无任务（含旧版服务端无此字段）
      frame(run) {
        const current = run && run.runId ? run : null;
        if (!current) return;
        if (current.state === "running") return;
        const outcome = current.outcome;
        if (!outcome || outcome === "downloaded") return; // 停在「已下载待应用」不算收场：关于页按 staged 呈现
        let shown = false;
        try { shown = storage.getItem(`anyswitch:self-update-shown:${current.runId}`) === "1"; } catch { shown = false; }
        if (shown) return;
        if (typeof aboutProbe === "function" && aboutProbe()) return;
        if (isPanelRestarting() || isStartupRestartPage()) return;
        if (outcome === "updated") {
          if (swapDispatchedFor === current.runId) return;
          swapDispatchedFor = current.runId;
          dispatchSwap();
          return;
        }
        // 无刷新终态（待重启生效 / 失败 / 回滚）：就地提示并落已读。
        try { storage.setItem(`anyswitch:self-update-shown:${current.runId}`, "1"); } catch { /* 存档不可写：可能重复提示一次，可接受 */ }
        toast(current.message || "更新已结束", outcome === "failed" || outcome === "rolled_back");
      },
    };
  }
  const selfUpdateWatcher = createSelfUpdateFrameWatcher({
    toast,
    dispatchSwap: () => document.dispatchEvent(new CustomEvent("anyswitch:self-update-swap")),
    isPanelRestarting: () => panelRestarting,
    isStartupRestartPage: () => window.panelStartupRestart === true,
  });

  function updateRelayControls(relay) {
    currentRelayState = relay || { status: "stopped" };
    const toggleBtn = $("sbRelayToggleBtn");
    const restartBtn = $("sbRelayRestartBtn");
    if (!toggleBtn) return;

    // 重启窗口内两个按钮一律按住：relay 一回来本函数就会被 1s 轮询再次调用，
    // 不在这里拦住，恢复期间重启键会重新可点，能再触发一次重启。
    if (panelRestarting) {
      toggleBtn.disabled = true;
      if (restartBtn) restartBtn.disabled = true;
      return;
    }

    if (currentRelayState.status === "running") {
      toggleBtn.className = "btn btn-mini btn-danger";
      toggleBtn.textContent = "⏹ 停止";
      toggleBtn.disabled = false;
      if (restartBtn) restartBtn.disabled = false;
    } else if (currentRelayState.status === "starting") {
      toggleBtn.className = "btn btn-mini";
      toggleBtn.textContent = "启动中…";
      toggleBtn.disabled = true;
      if (restartBtn) restartBtn.disabled = true;
    } else {
      toggleBtn.className = "btn btn-mini btn-primary";
      toggleBtn.textContent = "▶ 启动";
      toggleBtn.disabled = false;
      if (restartBtn) restartBtn.disabled = true;
    }
  }

  function initRelayControls() {
    const toggleBtn = $("sbRelayToggleBtn");
    const restartBtn = $("sbRelayRestartBtn");
    const stopModal = $("stopRelayModal");
    const stopCloseBtn = $("stopRelayCloseBtn");
    const stopCancelBtn = $("stopRelayCancelBtn");
    const stopConfirmBtn = $("stopRelayConfirmBtn");
    const stopBody = $("stopRelayBody");
    const titleText = $("relayLifecycleTitleText");
    let pendingLifecycleAction = "stop";

    function closeStopModal() {
      stopModal.classList.remove("show");
    }

    if (stopCloseBtn) stopCloseBtn.onclick = closeStopModal;
    if (stopCancelBtn) stopCancelBtn.onclick = closeStopModal;
    stopModal.onclick = (e) => {
      if (e.target === stopModal) closeStopModal();
    };

    if (toggleBtn) {
      toggleBtn.onclick = () => {
        if (currentRelayState.status === "running") {
          openLifecycleModal("stop");
        } else if (currentRelayState.status === "stopped") {
          executeStartRelay();
        }
      };
    }

    async function openLifecycleModal(action) {
      pendingLifecycleAction = action;
      const isRestart = action === "restart";
      if (titleText) titleText.textContent = isRestart ? "重启 Relay 与面板服务" : "停止 Relay 服务";
      if (stopConfirmBtn) stopConfirmBtn.textContent = isRestart ? "确认重启" : "确认停止";
      let summary = isRestart
        ? `<p style="margin:0 0 8px;">确定要重启 Relay 代理服务与面板服务吗？重启期间所有指向 <code>127.0.0.1:47821</code> 的本地 Agent 请求将中断。</p>`
        : `<p style="margin:0 0 8px;">确定要停止 Relay 代理服务吗？停止后所有指向 <code>127.0.0.1:47821</code> 的本地 Agent 请求将中断。</p>`;
      try {
        const data = await api("GET", "/api/agents");
        const agents = (data && data.agents) || [];
        const labels = { zcode: "ZCode", claude: "Claude Code", dsh: "DeepSeek Harness", opencode: "OpenCode", pi: "Pi", kimi: "Kimi Code", qoder: "Qoder", codex: "Codex", grok: "Grok Build" };
        const busy = agents.filter((a) => {
          const generating = (a.metrics && a.metrics.activeRequests > 0) || a.activeRequests > 0;
          return generating || a.status === "running";
        });
        if (busy.length) {
          const names = busy.map((a) => labels[a.id] || a.name || a.id).join("、");
          summary += `<p style="margin:0 0 8px;">将会打断：${names}</p>`;
        } else {
          summary += `<p style="margin:0 0 8px;">当前没有进行中的请求，但仍会断开中继连接。</p>`;
        }
      } catch {
        summary += `<p style="margin:0 0 8px;">无法读取当前会话，仍可能打断正在进行的请求。</p>`;
      }
      // 停止 = 只动数据面、控制台保活（拆分架构的承诺）；重启 = 两个都换，页面
      // 会短暂断开并由本页自动刷新恢复。
      summary += isRestart
        ? `<p style="margin:0; font-size:11.5px; color:var(--text-3);">注：控制面板服务一并重启，本页面会短暂断开、几秒后自动刷新；实时输出窗口的历史会随之清空。</p>`
        : `<p style="margin:0; font-size:11.5px; color:var(--text-3);">注：仅影响中继转发，当前控制面板保持在线。</p>`;
      if (stopBody) stopBody.innerHTML = summary;
      stopModal.classList.add("show");
    }

    async function executeStartRelay() {
      toggleBtn.disabled = true;
      try {
        const res = await api("POST", "/api/relay/start");
        if (res.ok) {
          toast("Relay 启动成功");
        } else {
          toast("启动失败: " + (res.error || "未知错误"), true);
        }
      } catch (e) {
        toast(panelError(e, "请求失败"), true);
      } finally {
        toggleBtn.disabled = false;
      }
    }

    async function executeStopRelay() {
      toggleBtn.disabled = true;
      try {
        const res = await api("POST", "/api/relay/stop");
        if (res.ok) {
          toast("Relay 已安全停止");
        } else {
          toast("停止失败: " + (res.error || "未知错误"), true);
        }
      } catch (e) {
        toast(panelError(e, "请求失败"), true);
      } finally {
        toggleBtn.disabled = false;
      }
    }

    // 重启窗口复播开屏：确认重启即整屏盖住，动画停在定格画面直到换新进程接管
    // 触发 location.reload() 收尾；relay 换新失败、面板换新被拒、恢复超时三类
    // 失败路径显式收回，把页面还给用户。兜底时限取恢复超时外加余量。
    // 显式传 true：这是用户主动点重启触发的播放，无论本页是不是上次重启恢复来的，
    // 都该完整播一遍脉冲。不传的话，停在上次恢复页上再点重启会被静默吞成定格。
    // 现读存档而不是沿用本页加载时那份判定：用户刚在这页上关掉开屏动画就点重启，
    // 不该看到开屏——三条失败收回路径都用可选链，图层不在场时 dropStartupSplash 自然空转。
    const playStartupSplash = () => {
      if (!startupAnimationEnabled()) return;
      window.panelStartupBegin?.(PANEL_RESTART_RECOVERY_TIMEOUT_MS + 5_000);
      window.panelStartupPlay?.(true);
    };
    const dropStartupSplash = () => window.panelStartupController?.release?.();

    async function executeRestartRelay() {
      restartBtn.disabled = true;
      playStartupSplash();
      // ① relay 先换：这一步由面板进程转手执行，页面不断线。失败到此为止，
      //    绝不在 relay 没起来的情况下去动面板自己。
      try {
        await api("POST", "/api/relay/restart");
      } catch (e) {
        toast(panelError(e, "重启失败"), true);
        restartBtn.disabled = false;
        dropStartupSplash();
        return;
      }
      // ② 面板服务再换自己。这个请求的「失败」有两种完全不同的含义：连接被退出
      //    掐断（预期内，重启确实开始了）vs 服务端明确拒绝（403/409/500，面板还
      //    活着且没动）。api() 把两者都抛成 Error，所以这里用裸 fetch 分清。
      let restartStarted;
      let refusal = "";
      try {
        const r = await fetch(API_BASE + "/api/panel-host/restart", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-AnySwitch-Panel": "1" },
        });
        restartStarted = r.ok;
        if (!r.ok) {
          try { refusal = ((await r.json()).error) || `HTTP ${r.status}`; } catch { refusal = `HTTP ${r.status}`; }
        }
      } catch {
        restartStarted = true; // 连接中断：多半是进程已经退出，交给恢复轮询验证
      }
      if (!restartStarted) {
        toast(`Relay 已重启；面板服务未重启（${refusal}）`, true);
        restartBtn.disabled = false;
        dropStartupSplash();
        return;
      }
      watchPanelHostComeBack();
    }

    // 等 panel-host 换新进程。刻意不复用 1s 状态轮询：那条链带 document.hidden
    // 门控，用户点完重启切去别的标签页就再也检测不到换新，页面会一直停在已死的
    // 旧面板上。检测到新身份即 location.reload()——页面 JS 也随磁盘上的新版对齐。
    function watchPanelHostComeBack() {
      panelRestarting = true;
      const before = { ...lastPanelIdentity };
      const dot = $("topDot");
      const statusText = $("topRelayStatus");
      const sbState = $("sbStateBadge");
      if (dot) dot.className = "pulse-dot starting";
      if (statusText) statusText.textContent = "面板服务重启中…";
      if (sbState) { sbState.className = "badge badge-warn"; sbState.textContent = "重启中"; }
      if (toggleBtn) toggleBtn.disabled = true;
      if (restartBtn) restartBtn.disabled = true;

      const deadline = Date.now() + PANEL_RESTART_RECOVERY_TIMEOUT_MS;
      let aliveIdentity = null; // 窗口内最后一次「仍在应答」的身份，用于超时时说清是哪种失败
      const timer = setInterval(async () => {
        let identity = null;
        try {
          const r = await fetch(API_BASE + "/api/status", { cache: "no-store" });
          if (r.ok) {
            const d = await r.json();
            identity = { pid: d?.pid ?? null, startTime: d?.startTime ?? null };
          }
        } catch {
          /* 47820 还没人应答：旧进程已退出或新进程还在绑端口，继续等 */
        }
        if (identity) aliveIdentity = identity;
        if (identity && (identity.pid !== before.pid || identity.startTime !== before.startTime)) {
          clearInterval(timer);
          // 带 startup=restart 跳转而非裸 reload：新页面首绘即接力开屏层，恢复的视图
          // 播入场动画，连接处平滑（bootstrap 识别该标记并置 panelStartupRestart）。
          // assign 而非 replace：与 launcher 首开同一条 navigate 路径，bootstrap 的
          // navigation.type 门控才能放行。
          const next = new URL(location.href);
          next.searchParams.set("startup", "restart");
          location.assign(next.href);
          return;
        }
        if (Date.now() >= deadline) {
          clearInterval(timer);
          panelRestarting = false;
          if (aliveIdentity && aliveIdentity.pid === before.pid) {
            // 面板从头到尾没退出过：助手没能把它送走，页面一切照常，别谎称掉线。
            toast("面板服务未退出，重启没生效；详见 logs/panel-host-restart.log", true);
          } else {
            toast("面板服务未能自动恢复，请用桌面快捷方式重新打开 Anyswitch 面板", true);
          }
          refreshStatus(); // 徽标与按钮回到真实状态
          dropStartupSplash();
        }
      }, PANEL_RESTART_POLL_MS);
    }

    // 关于页一键自更新进入换装阶段（worker 就绪、panel-host 即将自杀换新）：
    // 由这里接管页面恢复监视，与手动「重启」走同一套 watchPanelHostComeBack 编排水。
    // 同时拉起开屏层：脉冲播完定格盖住换装窗口，新页面（startup=restart）的定格
    // 才有「旧页面刚播过」的接力语义——旧页面不播，新页面就只剩一张无动画的闪屏。
    document.addEventListener("anyswitch:self-update-swap", () => {
      if (!panelRestarting) {
        playStartupSplash();
        watchPanelHostComeBack();
      }
    });

    if (stopConfirmBtn) {
      stopConfirmBtn.onclick = async () => {
        closeStopModal();
        if (pendingLifecycleAction === "restart") await executeRestartRelay();
        else await executeStopRelay();
      };
    }

    if (restartBtn) {
      restartBtn.onclick = () => openLifecycleModal("restart");
    }
  }

  // 主题切换
  function initTheme() {
    // 主头行、设置头行、终端页、新版左栏各有一颗亮暗钮：同一状态源
    // （data-theme + panel-theme），同一套日/月图标逻辑，任一侧切换各侧同步刷新
    const toggles = [
      { btn: $("themeToggle"), sun: $("icoSun"), moon: $("icoMoon") },
      { btn: $("settingsThemeToggle"), sun: $("settingsIcoSun"), moon: $("settingsIcoMoon") },
      { btn: $("terminalThemeToggle"), sun: $("terminalIcoSun"), moon: $("terminalIcoMoon") },
      { btn: $("railThemeToggle"), sun: $("railIcoSun"), moon: $("railIcoMoon") },
    ].filter((t) => t.btn);
    function currentTheme() {
      const t = document.documentElement.getAttribute("data-theme");
      if (t === "light" || t === "dark") return t;
      return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    }
    function syncBtns() {
      const dark = currentTheme() === "dark";
      const label = dark ? "切换到亮色模式" : "切换到暗色模式";
      for (const t of toggles) {
        // 日/月是 SVG 元素：hidden 是 HTMLElement 的 IDL 反射属性，SVGElement 上没有——
        // `.hidden =` 只写 expando 不落 attribute，UA 的 [hidden] 规则永不生效，图标永远
        // 停在 HTML 初态。必须落 attribute（与 syncRailCollapseBtn 的收展图标同一修法）。
        // 图标画当前态（暗态挂月亮、亮态挂太阳），aria/title 的「切换到…模式」是目标态
        // 动作（PANEL-COPY-SPEC：状态用图形，动作归文案）。
        if (t.sun) t.sun.toggleAttribute("hidden", dark);
        if (t.moon) t.moon.toggleAttribute("hidden", !dark);
        t.btn.setAttribute("aria-label", label); t.btn.title = label;
      }
    }
    function setTheme(mode) {
      if (mode === "light" || mode === "dark") document.documentElement.setAttribute("data-theme", mode);
      else document.documentElement.removeAttribute("data-theme");
      try { localStorage.setItem("panel-theme", mode); } catch {}
      syncBtns();
      applyTerminalXtermTheme();
    }
    // 系统亮暗变化（用户未显式选定主题时）：同步图标，并重刷终端屏配色
    if (window.matchMedia) {
      window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
        syncBtns();
        applyTerminalXtermTheme();
      });
    }
    const saved = localStorage.getItem("panel-theme");
    setTheme(saved === "light" || saved === "dark" ? saved : "auto");
    for (const t of toggles) t.btn.onclick = () => setTheme(currentTheme() === "dark" ? "light" : "dark");
  }

  // 面板主题（设置视图「主题」子 tab 左栏列表，点选即全局生效）
  function initStylePicker() {
    const picker = $("stylePicker");
    if (!picker) return;
    // 「赛博」(neon)、「工业+」(industrial)、「极简」(editorial)、「Anthropic」(anthropic)
    // 等历史主题均已退役，CSS 片段已随退役删除；历史 localStorage 存档的退役样式
    // 由 <head> 恢复脚本兜底回落默认主题（saas）。
    // 与 panel.html 头部恢复脚本的 PANEL_STYLES 同一份清单，改动需两侧同步（panel.test.mjs 有同值断言）
    const STYLES = ["saas", "aurora", "sepia"];
    function currentStyle() {
      const s = document.documentElement.getAttribute("data-style") || "";
      return STYLES.includes(s) ? s : "saas";
    }
    function syncBtns() {
      const cur = currentStyle();
      for (const b of picker.querySelectorAll(".settings-theme-item")) {
        b.setAttribute("aria-checked", b.dataset.style === cur ? "true" : "false");
      }
    }
    function setStyle(s) {
      document.documentElement.setAttribute("data-style", s);
      try { localStorage.setItem("panel-style", s); } catch {}
      syncBtns();
      applyTerminalXtermTheme();
    }
    picker.addEventListener("click", (e) => {
      const b = e.target.closest(".settings-theme-item");
      if (!b || !STYLES.includes(b.dataset.style)) return;
      setStyle(b.dataset.style);
    });
    syncBtns();
  }

  // ═══════════════════════════════════════════════
  // Skills 管理 Tab
  // ═══════════════════════════════════════════════
  // 部署状态完全由后端从文件系统实时推导；前端不缓存任何权威状态，
  // 每次变更后重新拉一次 /api/skills/state 全量渲染。布局为 skill 中心
  // 主从：左列列表选中驱动右侧详情卡（部署 toggle / 删除），本地条目与
  // 异常跨端点聚合在右下卡片，确认类操作走 skillsModal。
  let skillsState = null;
  let skillsModalConfirm = null;
  let skillsModalBusy = false;   // 确认处理中：抑制遮罩/关闭，防重复点击
  let skillsModalGen = 0;        // showSkillsModal 代际：确认回调内可能改开新弹窗
  // 「高光即选中」：选中集合（relPath，dirName 可能重复而 relPath 唯一）= 所有高亮行
  // = 一切操作的作用对象；焦点键是集合内最后加入的一员，驱动右侧详情卡。
  let skillsSelection = new Set();
  let skillsFocusKey = null;
  let skillsBatchBusy = false;   // 批量操作进行中标志（防重入）
  let skillsFilter = "";
  // 异常聚合卡 matching/unique 两组默认收起；折叠态必须外置——
  // renderSkillsAnomalies 每次刷新重建 innerHTML，挂在 DOM 上会被冲掉
  let anomalyFold = { matching: true, unique: true };

  // 整卡折叠（卡头那颗钮）：默认收起，panel.html 里卡身就带 hidden，JS 之前也不闪。
  // 同样外置 + 跨刷新记住，理由与分组折叠一致：这张卡每次刷新都重建 innerHTML。
  let anomalyCardOpen = readAnomalyCardOpen();
  function readAnomalyCardOpen() {
    try { return localStorage.getItem("panel-skills-anomaly-open") === "1"; } catch { return false; }
  }
  // 折叠态落到 DOM：卡身显隐、卡头去掉那道悬空底边、钮上文案与 aria-expanded。
  // 文案沿用遥测卡那套「展开 ▾ / 收起 ▴」，不另造一套符号。
  function applyAnomalyCardFold() {
    const card = $("skillsAnomalyCard");
    const body = $("skillsAnomalyBody");
    const btn = $("skillsAnomalyFold");
    if (!card || !body || !btn) return;
    card.classList.toggle("folded", !anomalyCardOpen);
    body.hidden = !anomalyCardOpen;
    btn.setAttribute("aria-expanded", anomalyCardOpen ? "true" : "false");
    btn.textContent = anomalyCardOpen ? "收起 ▴" : "展开 ▾";
  }
  function toggleAnomalyCardFold() {
    anomalyCardOpen = !anomalyCardOpen;
    try { localStorage.setItem("panel-skills-anomaly-open", anomalyCardOpen ? "1" : "0"); } catch {}
    applyAnomalyCardFold();
  }

  // ── 收藏（迭代3 起，v2 分桶）：按主仓库路径分桶的 relPath 集合，localStorage 持久化。
  // 收藏与选中正交：选中是高光/操作对象，收藏只是标记，跨刷新保留。
  // 分桶是切换仓库教训的产物：v1 是单张全局 relPath 列表，仓库一切换，reconcile 的
  // 同步清理就把新仓库里不存在的 relPath 全部删掉——收藏当场蒸发且不可恢复。v2 里
  // 每个仓库一个桶，切换时换桶、切回即恢复；同一仓库内删掉的 skill 仍会从桶里清掉。
  let skillsFavorites = new Set();   // 当前仓库桶的内存态（装载前为空）
  let favoritesRepoPath = null;      // skillsFavorites 对应的仓库；null = 尚未装载
  function loadFavoriteBuckets() {
    // v2 结构损坏按无数据处理；v1 旧键（单张数组）由首次装载整表收编当前仓库后删除
    try {
      const obj = JSON.parse(localStorage.getItem("skills-favorites-v2") || "null");
      if (obj && typeof obj === "object" && !Array.isArray(obj)) return { buckets: obj, legacy: null };
    } catch {}
    try {
      const arr = JSON.parse(localStorage.getItem("skills-favorites") || "null");
      if (Array.isArray(arr)) return { buckets: {}, legacy: arr.filter((x) => typeof x === "string") };
    } catch {}
    return { buckets: {}, legacy: null };
  }
  // 每次拿到 Skills 状态后调用：首次装载 / 仓库切换时换桶。装载前对收藏的任何改动
  // 都不落盘（saveSkillsFavorites 的 null 守卫），防止空集合把某个桶抹掉。
  function ensureFavoritesForRepo(repoPath) {
    if (!repoPath || favoritesRepoPath === repoPath) return;
    if (favoritesRepoPath !== null) saveSkillsFavorites();
    const { buckets, legacy } = loadFavoriteBuckets();
    const own = legacy !== null ? legacy : (Array.isArray(buckets[repoPath]) ? buckets[repoPath] : []);
    if (legacy !== null) {
      buckets[repoPath] = legacy;
      try {
        localStorage.setItem("skills-favorites-v2", JSON.stringify(buckets));
        localStorage.removeItem("skills-favorites");
      } catch {}
    }
    favoritesRepoPath = repoPath;
    skillsFavorites = new Set(own);
  }
  function saveSkillsFavorites() {
    if (favoritesRepoPath === null) return;
    try {
      const { buckets } = loadFavoriteBuckets();
      buckets[favoritesRepoPath] = [...skillsFavorites];
      localStorage.setItem("skills-favorites-v2", JSON.stringify(buckets));
    } catch {}
  }
  function toggleSkillFavorite(relPath) {
    if (skillsFavorites.has(relPath)) skillsFavorites.delete(relPath);
    else skillsFavorites.add(relPath);
    saveSkillsFavorites();
    renderSkillsList();
    renderSkillDetail();
  }
  // 多选菜单批量：对选中集合统一加/去收藏
  function setFavoritesForSelection(on) {
    for (const k of skillsSelection) {
      if (on) skillsFavorites.add(k); else skillsFavorites.delete(k);
    }
    saveSkillsFavorites();
    renderSkillsList();
    renderSkillDetail();
  }

  // ── 异常卡 matching/unique 两组勾选式多选（待处理清单语义） ──
  // 键为 ep.id\x01entry.name 复合键（\x01 不可能出现在路径里），与左侧
  // relPath 选中互不影响、不驱动详情卡。选中态仅由各行 checkbox 表达，
  // 不做行高光；集合必须外置——renderSkillsAnomalies 每次刷新重建 innerHTML。
  let anomalyChecked = { matching: new Set(), unique: new Set() };

  // Set 保持插入序：最后一员即"最后加入且仍在集合中的"成员（焦点回退用）
  function lastSelectionKey() {
    let last = null;
    for (const k of skillsSelection) last = k;
    return last;
  }

  // ── 栏手动收/展（栏顶收起钮 + Ctrl/Cmd+\）────────────────────────────
  // 手动态优先于宽度自动档——<html> data-rail 是唯一状态源（head 脚本绘制前从
  // localStorage「panel-rail-manual」读回，首帧即手动态；CSS 全部挂这个属性），这里只
  // 管点击写档+写属性、图标与文案随有效栏态换向、切换那一次挂上滑动开关。
  // 有效栏态 = 手动态 ?? 宽度自动档（≥1200 自动 216 全栏 / 其余宽度自动 72 图标栏）；
  // 栏在任何宽度常驻、无抽屉形态，收起钮与快捷键全档在管。文案常量制。
  const RAIL_COLLAPSE_LABEL = "收起侧栏";
  const RAIL_EXPAND_LABEL = "展开侧栏";
  // 手动切换的边缘滑动：CSS 那条 width 过渡只挂在 <html> data-rail-anim 上（见 panel.css
  // 阶段 2 收展段），开关在这里写、到点撤。撤除余量 20ms 是让过渡跑完再断；宽度本就没
  // 变化的场合（同宽来回切）等不到过渡也无妨，定时器照样撤。自动档跨档与
  // prefers-reduced-motion 一律不挂开关——拖窗口不是用户在「看收展手法」，不该跟着滑。
  const RAIL_ANIM_ATTR = "data-rail-anim";
  const RAIL_ANIM_MS = 220;
  // ── 收展交叉淡化（dsh SidebarRoot「Collapse is a slide plus crossfade」）──
  // 收起向不是一键落终态：先挂 data-rail-collapsing 让宽内容定宽原地淡出（150ms；
  // CSS 镜像段同时把栏宽与让位照终态值滑收），到点才落 data-rail="collapsed"——
  // display:none 的段头/树此刻才隐，硬切被淡出掩掉；随后 data-rail-railin 让收起态
  // 图标行从右侧 49px 滑入进场，掩掉落态一瞬的布局换装（dsh rail-in 同款）。展开向
  // 无落态延迟，data-rail-widein 整体淡入（dsh wide-in 同款）。三个都是手动收展
  // 那一次的瞬态开关；自动档跨档不经 toggleRailManual，reduced-motion 在两侧都不挂。
  const RAIL_COLLAPSING_ATTR = "data-rail-collapsing";
  const RAIL_WIDEIN_ATTR = "data-rail-widein";
  const RAIL_RAILIN_ATTR = "data-rail-railin";
  const RAIL_SETTLE_MS = 150; // dsh COLLAPSE_SETTLE_MS：宽内容淡出时长＝落态延迟
  const RAIL_RAILIN_MS = 200; // rail-in 动画 150ms＋到点摘除余量
  let railAnimTimer = null;
  let railSettleTimer = null;
  let railWideinTimer = null;
  let railRailinTimer = null;
  let railCollapseInFlight = false;
  function requestRailSlide() {
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const root = document.documentElement;
    root.setAttribute(RAIL_ANIM_ATTR, "1");
    if (railAnimTimer) clearTimeout(railAnimTimer);
    railAnimTimer = setTimeout(() => {
      railAnimTimer = null;
      root.removeAttribute(RAIL_ANIM_ATTR);
    }, RAIL_ANIM_MS);
  }
  function railEffectivelyCollapsed() {
    // 收起淡出的 150ms 里 data-rail 还没落位，但用户已按「收起」——有效态按最终
    // 意图先行（钮的图标/文案即刻换向，落态回调再按真值重同步，幂等）。
    if (railCollapseInFlight) return true;
    const manual = document.documentElement.getAttribute("data-rail");
    if (manual === "collapsed") return true;
    if (manual === "expanded") return false;
    return !window.matchMedia("(min-width: 1200px)").matches;
  }
  // 展开态不挂重复提示：各 tab 的 title 与可见标签逐字相同，鼠标扫过一排等于把同一句
  // 话念七遍。ccswitch 是靠自家 tooltip 组件做「文字可见即不提示」，原生 title 没法条件
  // 抑制，这里按有效栏态摘挂——收起态标签不渲染，title 是唯一的名字来源，必须留。
  // 只动运行期属性，HTML 里写死的初值不删（v1 整栏不出，摘挂对它不可见）。
  function syncRailTabTitles(collapsed) {
    const rail = $("v2Rail");
    if (!rail) return;
    for (const tab of rail.querySelectorAll(".rail-tab")) {
      const label = tab.querySelector(".rail-tab-label");
      if (!label) continue;
      if (collapsed) tab.setAttribute("title", label.textContent.trim());
      else tab.removeAttribute("title");
    }
  }
  function syncRailCollapseBtn() {
    const btn = $("railCollapseBtn");
    if (!btn) return;
    const collapsed = railEffectivelyCollapsed();
    const label = collapsed ? RAIL_EXPAND_LABEL : RAIL_COLLAPSE_LABEL;
    btn.setAttribute("aria-expanded", collapsed ? "false" : "true");
    btn.setAttribute("aria-label", label);
    btn.title = label;
    const icoCollapse = $("railIcoCollapse"), icoExpand = $("railIcoExpand");
    // 这两颗是 SVG 元素：hidden 是 HTMLElement 的 IDL 反射属性，SVGElement 上没有——
    // `.hidden =` 只写出一个普通自有属性，attribute 不动，两颗图标永远不切换（收起态
    // 实测仍是「收起」图标）。必须落 attribute，UA 的 [hidden] 规则才会摘挂显示。
    if (icoCollapse) icoCollapse.toggleAttribute("hidden", collapsed);
    if (icoExpand) icoExpand.toggleAttribute("hidden", !collapsed);
    syncRailTabTitles(collapsed);
  }
  // 手动态的出口：窗口拖回宽档即解除，栏回到「跟随窗口宽度」。手动态原本永久压制自动档
  // 且没有回退口（ccswitch 同款毛病），而拖窗口多半只是用户换个地方看东西，不该替他
  // 把栏态钉死。解除属自动态变化，不挂滑动开关；重同步由调用方收尾。
  function releaseRailManual() {
    const root = document.documentElement;
    if (!root.hasAttribute("data-rail")) return false;
    root.removeAttribute("data-rail");
    try { localStorage.removeItem("panel-rail-manual"); } catch {}
    return true;
  }
  // 收起序的中断收口：淡出窗口内反悔再点、跨档自动变化，都先撤瞬态属性与定时器——
  // 半程的 collapsing 态若不撤，落位后会残一条 72px 镜像压着手动态的展开值。
  function railClearCollapseSequence() {
    if (railSettleTimer) { clearTimeout(railSettleTimer); railSettleTimer = null; }
    if (railWideinTimer) { clearTimeout(railWideinTimer); railWideinTimer = null; }
    if (railRailinTimer) { clearTimeout(railRailinTimer); railRailinTimer = null; }
    railCollapseInFlight = false;
    const root = document.documentElement;
    root.removeAttribute(RAIL_COLLAPSING_ATTR);
    root.removeAttribute(RAIL_WIDEIN_ATTR);
    root.removeAttribute(RAIL_RAILIN_ATTR);
  }
  function railReducedMotion() {
    return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }
  function toggleRailManual() {
    // 淡出窗口内再点＝反悔收起：railEffectivelyCollapsed 在飞时按最终意图返真，
    // 这里自然反转成 expanded。
    const next = railEffectivelyCollapsed() ? "expanded" : "collapsed";
    try { localStorage.setItem("panel-rail-manual", next); } catch {}
    railClearCollapseSequence();
    const root = document.documentElement;
    requestRailSlide(); // reduced-motion 下自身不挂开关；先挂开关再写栏宽（同一帧起算过渡）
    if (railReducedMotion() || next !== "collapsed") {
      root.setAttribute("data-rail", next);
      if (next === "expanded") {
        root.setAttribute(RAIL_WIDEIN_ATTR, "1");
        railWideinTimer = setTimeout(() => {
          railWideinTimer = null;
          root.removeAttribute(RAIL_WIDEIN_ATTR);
        }, RAIL_ANIM_MS);
      }
      syncRailCollapseBtn();
      return;
    }
    // 收起序：淡出窗口（150ms）内 data-rail 不动——栏体按宽态渲染、内容定宽淡出，
    // 到点一次性落终态并放 rail-in 进场。
    railCollapseInFlight = true;
    root.setAttribute(RAIL_COLLAPSING_ATTR, "1");
    syncRailCollapseBtn();
    railSettleTimer = setTimeout(() => {
      railSettleTimer = null;
      railCollapseInFlight = false;
      root.removeAttribute(RAIL_COLLAPSING_ATTR);
      root.setAttribute("data-rail", next);
      syncRailCollapseBtn();
      root.setAttribute(RAIL_RAILIN_ATTR, "1");
      railRailinTimer = setTimeout(() => {
        railRailinTimer = null;
        root.removeAttribute(RAIL_RAILIN_ATTR);
      }, RAIL_RAILIN_MS);
    }, RAIL_SETTLE_MS);
  }
  function initRailCollapse() {
    const btn = $("railCollapseBtn");
    if (!btn) return;
    btn.onclick = () => toggleRailManual();
    // 自动档下窗口跨过 1200 档界会改变有效栏态：图标与文案重同步（手动态下
    // 有效态不随宽度变，重同步是幂等空转）；跨进宽档顺带解除手动态（出口）。
    const wideMq = window.matchMedia("(min-width: 1200px)");
    wideMq.addEventListener("change", () => {
      railClearCollapseSequence(); // 跨档属自动态变化：手动收起的半程序先撤干净
      if (wideMq.matches) releaseRailManual();
      syncRailCollapseBtn();
    });
    // Ctrl/Cmd+\ 与收起钮同一条链。四处豁免：旧版（v2 属性不在册时整栏不出、收起钮
    // display:none 本也点不到，快捷键是这条链唯一能凭空触达的入口）、IME 组字态（最终
    // 字节未定，见终端转发闸门先例）、输入控件与可编辑区（全站有搜索框、路径框、编号
    // 框）、终端视图（内核把 Ctrl 组合原样转发给 PTY，不能被界面快捷键抢走）。
    document.addEventListener("keydown", (event) => {
      if (event.key !== "\\" || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
      if (!document.documentElement.hasAttribute("data-ui-version")) return;
      if (event.isComposing || event.keyCode === 229) return;
      const active = document.activeElement;
      if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.tagName === "SELECT" || active.isContentEditable)) return;
      if (currentView === "terminal") return;
      event.preventDefault();
      toggleRailManual();
    });
    syncRailCollapseBtn();
  }

  /* ============================================================
     终端会话栏（M4 + M7 + M8）：终端视图下的左栏换血内容
     ============================================================ */
  // 栏体自上而下（M8 T1 两段合并）：「新建终端」钮 →「工作区」段头（T7 三钮）→
  // 目录分组树 → 栏底。「打开的终端」段已整段拆除——live 不再单列，而是树里行的
  // 属性：一条会话行有开着终端替它续接（resume 两键映射，M7-S5）即是 live，带状态
  // 点/选中态/关闭叉。全新终端在会话文件落盘前按 cwd 在组顶插「新会话」兜底行
  // （渲染时从后端真值表现推导，不另记状态）。原左上角 agent 身份行已拆（M7-S0）。
  // 观感按 dsh 左栏实测（unpack/sidebar-motion-spec.md）：行 hover/选中、行内动作
  // 按钮一律 0ms 硬切（加过渡就错），栏内只有组箭头 .15s 旋转与组展开的 FLIP 行位
  // 移有运动。
  const TERMINAL_RAIL_WATERMARK = 5;
  // 组折叠态：跨视图进出与页面重载都要保持（用户手动收起的组不该每次进来都弹开）。
  // 键一律过 terminalRailNormDir——组键是「稳定代表拼写」（最短优先），会话数据里
  // 同一目录的大小写/斜杠拼写可能换形态，拿原始拼写当存储键会在重载后对不上。
  const terminalRailCollapsedGroups = new Set();
  const terminalRailWatermarks = new Map();
  // 历史会话缓存：{ endpoint, sessions, fetchedAt, error }。只装当前 agent 那一份——
  // 换 agent 即整份作废重拉，不做多端点缓存（用户拍板「跟随」而非「浏览」）。
  let terminalRailHistory = { endpoint: "", sessions: [], fetchedAt: 0, error: null };
  // 视图状态（M7）：归档清单 + 已移除分组目录清单。进终端视图时从面板后端拉一次
  // （GET /api/terminal/rail/prefs），之后的动作本地先生效、POST 落盘。落在面板侧，
  // 与 terminal-host 就绪与否无关——降级/未就绪时归档照样可用（dsh 同口径：归档
  // 是 workspace domain 的持久化集合，不是宿主能力）。
  let terminalRailPrefs = { archived: [], removedGroups: [] };
  // 移除时刻（M14）：目录归一化键 → 移除时的毫秒时间戳，落 localStorage。后端清单
  // 只存目录拼写，没有时间轴；而「移除持久＋新会话自愈」必须知道移除发生在哪一刻，
  // 才能判「这条会话是移除之后新来的」。纯视图状态（与视图偏好同层），不进面板后端。
  const TERMINAL_RAIL_REMOVED_AT_KEY = "panel-terminal-rail-removed-at";
  let terminalRailRemovedAt = {};
  // 视图偏好（M8 T7b）：分组方式 / 排序方式 / 归档筛选三组，落 localStorage（dsh
  // 的 dsh.workspace.view.v5 同层——纯视图偏好，不进面板后端）。手序按 agent 键存
  // （手动排序的唯一来源）。默认值即 dsh 出厂默认。
  const TERMINAL_RAIL_VIEW_KEY = "panel-terminal-rail-view";
  let terminalRailViewPrefs = { groupBy: "workspace", orderBy: "updated", archivedFilter: "default", sessionOrder: {} };
  // 组折叠态（与视图偏好同层）：归一化目录键的数组。纯视图状态，不进面板后端
  // （归档/已移除分组才是 workspace domain 的持久化集合）。先例：会话页的
  // SESS_LS.collapsed 与栏内 removed-at 都走 localStorage。
  const TERMINAL_RAIL_COLLAPSED_KEY = "panel-terminal-rail-collapsed";
  // 树的 innerHTML 指纹（与页签栏同一条不变式：指纹 = DOM 现值）。
  let terminalRailRendered = { history: null };
  // 乐观选中态（M5）：点会话行当拍点亮的高亮。is-active 的 live 派生判据要等
  // POST /switch（或 /agent-sessions）成功才成立，而宿主侧一次切换是进程探测＋
  // PTY 重启的 1~2s——那段时间栏上没有选中行，点击像丢了。pending 让高亮在
  // 点击当拍成立，切换落定后由 live/active 派生自然接管（成功路径不清：两条
  // 判据点亮的是同一行）。
  // pending 必须进渲染消费的状态而不是 DOM-only 切类名：pollTerminalSessions
  // 每 1s 全树重铺栏（renderTerminalRailHistory 整块 innerHTML），DOM-only 的
  // 类名切换会被下一拍轮询冲掉——这是选状态位的决定性理由。
  let terminalRailSelectPending = null; // { endpoint, id, terminalId, cwd, token, timer }
  // id/endpoint＝历史行身份（续接内切）；terminalId＋cwd＝全新内切的身份（活跃记录
  // 不换，按终端 id 认「新会话」兜底行，cwd 记下目标目录让兜底行落在目标组顶）。
  // 两者只占一种：有历史 id 就不带 terminalId，反之亦然（一个 pending 点亮一行）。
  let terminalRailSelectSeq = 0;
  // TTL 兜底：api() 没有超时，切换请求万一长年挂起（宿主卡死）时假高亮不能
  // 常驻——到点撤 pending 重回 live 派生（那一行没换成，点亮它就是说谎）。
  // 取值 10~15s 档：远大于一次正常切换（1~2s），远小于用户对「亮点着却什么
  // 都没发生」的忍耐。
  const TERMINAL_RAIL_SELECT_TTL_MS = 12 * 1000;
  let terminalRailFetchInFlight = false;
  // 历史会话快照的复用窗口。服务端把这份列表缓存成短 TTL 快照（panel.mjs
  // createSessionsListSnapshot，同为 30s），过期先交旧值、后台补一拍——也就是说
  // 客户端这里没必要每次进页都发一次请求：进页发出的请求排在画面之前，那才是
  // 「进终端页先白一下」的一半（S2 取证：进页必拉，且拉在飞时 SSE 握手排队）。
  // 取值与服务端对齐：比它更短只会多打无谓的请求，比它更长则会让别处新建的会话
  // 在左栏里更晚出现——左栏是粗粒度清单，30s 是两边都无感的窗口。
  const TERMINAL_RAIL_HISTORY_TTL_MS = 30 * 1000;
  // 失败后的短退避：下次自然触发点（进页/换身份）只要过了这么久就允许重取。取值远小于
  // TTL（失败不该让左栏空半分钟）、远大于 1s（不跟每秒轮询绑在一起变成重试风暴）。
  const TERMINAL_RAIL_HISTORY_RETRY_MS = 5 * 1000;
  // 补拉只排一次：进页、换身份、轮询都经同一个门，重复排队没有意义。
  let terminalRailFetchQueued = false;
  // FLIP 门控：首次指针/键盘输入前不播（dsh AnimatedRows 的 armed 同口径）；
  // flipMode 一帧用完即复位，组展开/收起与归档/撤销（M13）会置 "flip"。
  let terminalRailMotionArmed = false;
  let terminalRailFlipMode = "instant";
  // 活跃终端所在组的自动展开与滚入只做一次：换活跃终端才重做，用户手动收起不被
  // 下一次归属轮询顶回来。
  let terminalRailAutoExpandedFor = "";
  let terminalRailScrolledFor = "";
  // 最近一帧渲染出来的组表（过滤/改组后的终态）：hover 卡的「N 个会话」按它取数，
  // 不重新扫 DOM。
  let terminalRailLastGroups = [];
  // 兜底行生命周期动效（2026-10-25）的 diff 门状态：换 agent 与搜索退出两族渲染
  // 沿 M13 的 resetKey 口径保持瞬时落位——换 agent 时 DOM 里是旧 agent 的兜底行，
  // 搜索退出时树从结果平铺换回，两者的「行集合变化」都不是兜底行的真实离开，
  // 不播幽灵。首帧（无记录）同样按 reset 处理。
  let terminalRailLastDiffAgent = null;
  let terminalRailLastDiffSearch = false;

  // 组头两枚图标与开合箭头：数据逐字符照抄 dsh（m14 附录，净室提取自 dsh-desktop
  // 0.2.1-rc.2 bundle，chevron 以附录勘误后的 C5.95242 为准）。闭合态是 1px 描边空心
  // 轮廓＋一条中线（两条 path 都不填）；展开态是三层实心（背板 16% 透明＋盒体＋
  // 前舌）——两者构造方式不同，不是同一轮廓的改线，别把闭合态也填实。
  const TERMINAL_RAIL_ICON_CHEVRON = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" stroke-width="1"><path d="M5.5 4.5C5.5 4.40714 5.52586 4.31612 5.57467 4.23713C5.62349 4.15815 5.69334 4.09431 5.77639 4.05279C5.85945 4.01126 5.95242 3.99368 6.0449 4.00202C6.13738 4.01036 6.22572 4.04429 6.3 4.1L10.967 7.6C11.0291 7.64657 11.0795 7.70697 11.1142 7.77639C11.1489 7.84582 11.167 7.92238 11.167 8C11.167 8.07762 11.1489 8.15418 11.1142 8.22361C11.0795 8.29303 11.0291 8.35343 10.967 8.4L6.3 11.9C6.22572 11.9557 6.13738 11.9896 6.0449 11.998C5.95242 12.0063 5.85945 11.9887 5.77639 11.9472C5.69334 11.9057 5.62349 11.8419 5.57467 11.7629C5.52586 11.6839 5.5 11.5929 5.5 11.5V4.5Z" fill="currentColor"></path></svg>';
  const TERMINAL_RAIL_ICON_FOLDER_OPEN = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" stroke-width="1"><path d="M2.55912 7.93683C2.67584 7.49906 3.0723 7.19446 3.52536 7.19446H13.6491C14.3061 7.19446 14.7846 7.81725 14.6153 8.45209L13.4411 12.856C13.3244 13.2938 12.9279 13.5984 12.4748 13.5984H2.35113C1.69411 13.5984 1.21562 12.9756 1.38489 12.3407L2.55912 7.93683Z" fill="currentColor" opacity="0.16"></path><path d="M13.6491 6.69446C14.6346 6.69453 15.3522 7.62895 15.0983 8.58118L13.9245 12.9845C13.7494 13.6412 13.1539 14.0988 12.4743 14.0988H2.35126C1.36574 14.0988 0.648153 13.1643 0.902044 12.212L2.07587 7.80774C2.25102 7.15128 2.84567 6.69455 3.52509 6.69446H13.6491ZM3.52509 7.69446C3.29865 7.69455 3.10004 7.84674 3.04169 8.06555L1.86786 12.4698C1.78345 12.7872 2.02285 13.0988 2.35126 13.0988H12.4743C12.7007 13.0988 12.8992 12.9463 12.9577 12.7277L14.1325 8.32336C14.2171 8.00598 13.9776 7.69453 13.6491 7.69446H3.52509Z" fill="currentColor"></path><path d="M4.7666 1.90137C5.13227 1.90144 5.48571 2.03525 5.75977 2.27734L7.27246 3.61328C7.36379 3.69382 7.48174 3.73828 7.60352 3.73828H12.3994C13.2276 3.73841 13.8993 4.41005 13.8994 5.23828V6.7168C13.8183 6.70327 13.735 6.69436 13.6494 6.69434H12.8994V5.23828C13.8993 4.96233 13.8994 4.73841 12.3994 4.73828H7.60352C7.23781 4.73828 6.88446 4.60438 6.61035 4.3623L5.09766 3.02637C5.00636 2.94576 4.88838 2.90144 4.7666 2.90137H2.0498C1.77366 2.90137 1.5498 3.12523 1.5498 3.40137V9.78223L0.902344 12.2119C0.648452 13.1642 1.36604 14.0986 2.35156 14.0986H2.0498C1.2214 14.0986 0.549838 13.427 0.549805 12.5986V3.40137C0.549805 2.57294 1.22138 1.90137 2.0498 1.90137H4.7666Z" fill="currentColor"></path></svg>';
  const TERMINAL_RAIL_ICON_FOLDER_CLOSED = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" stroke-width="1"><path d="M1.50439 3.11059C1.50439 2.55831 1.95211 2.1106 2.50439 2.1106H5.43389C5.67773 2.1106 5.91318 2.19969 6.09593 2.36113L7.71649 3.79265C7.89924 3.95409 8.1347 4.04319 8.3785 4.04319H13.4958C14.0481 4.04319 14.4958 4.4909 14.4958 5.04319V12.8894C14.4958 13.4417 14.0481 13.8894 13.4958 13.8894H2.50439C1.95211 13.8894 1.50439 13.4417 1.50439 12.8894V4.04319V3.11059Z" stroke="currentColor"></path><path d="M3.63501 7.66614H12.3647" stroke="currentColor"></path></svg>';
  const TERMINAL_RAIL_ICON_ARCHIVE = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg>';
  // 取消归档钮（M8 T7a，归档行的第三恢复入口）：归档盒 + 向上的箭头（出盒即还原）
  const TERMINAL_RAIL_ICON_UNARCHIVE = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/><polyline points="12 11 12 7"/><polyline points="9 10 12 7 15 10"/></svg>';
  // 组头 ⋯ 钮与 ⊕ 钮（feather more-horizontal / plus）：16px 槽，与行内归档/关闭叉
  // 同一描边风。⋯ 不设 title/aria-label——批准文案清单里没有它的标签，按栏内关闭
  // 叉的既有形制（aria-hidden 装饰图标）处理，标签文案留待清单补录。
  const TERMINAL_RAIL_ICON_ELLIPSIS = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg>';
  const TERMINAL_RAIL_ICON_PLUS = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';
  // 视图选项菜单的选中 ✓（feather check）：居项最右，不换文字色不铺底（m6c §B2）
  const TERMINAL_RAIL_ICON_CHECK = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
  // M12-B 运行中转圈（dsh 实测规格逐项照抄）：行首 16×20 前导槽内的 14×14 SVG——
  // 轨道圆 r=9.5 静态（opacity .25），弧线圆同描边 dasharray 12 150 呼吸（1.5s
  // ease-in-out：0% 12 150/offset 0 → 50% 24 150/offset -6 → 100% 12 150/offset 0），
  // 外层 g 匀速转 360°（1.5s linear）——两动画同周期成稳定加载环。currentColor 吃
  // 三级文字色（不造新色值）；prefers-reduced-motion 下降级静态（CSS 侧两动画全
  // none）。槽内挂读屏文本「进行中」（本规格批准的唯一新增 aria 文本）。
  const TERMINAL_RAIL_SPINNER = '<span class="rail-term-spinner"><svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle class="rail-term-spinner-track" cx="12" cy="12" r="9.5" opacity=".25"></circle><g class="rail-term-spinner-rot"><circle class="rail-term-spinner-arc" cx="12" cy="12" r="9.5" stroke-dasharray="12 150"></circle></g></svg><span class="rail-term-spinner-sr">进行中</span></span>';
  // done（跑完未读）绿点（dsh 状态点规格）：10×10 槽、:after inset 20%（视觉 6px
  // 圆）、色走既有 --ok（dsh success 档）。挂在 16×20 常驻槽内居中（.rail-term-done
  // 自身不另起布局）；tooltip「已完成」（本笔唯一新增文案）随 markup 走，会话栏行
  // 与页签指示位同一份。
  const TERMINAL_RAIL_DONE_DOT = '<span class="rail-term-done" title="已完成"></span>';

  // 状态槽内容判定（三面同一口径，勿写两份）：会话栏 live 行、搜索结果行（同一
  // terminalRailRowHtml 的两态）与页签指示位（renderTerminalPreviewTabs）都取本
  // 函数——优先级 working 转圈 ＞ 非聚焦的 doneUnread 绿点 ＞ 空。聚焦终端不画
  // 绿点：看着＝已读（标记本身也每拍即清，这里是渲染面的同语义兜底，聚焦切换后
  // 首次重渲即消点，不等下一拍轮询）。pending「新会话」兜底行不取本口径——方案
  // 定死 pending 行不涉及 done 态，维持 working 转圈/留空两态。
  function terminalRailStateSlotHtml(session, activeId) {
    if (!session) return "";
    if (session.status === "working") return TERMINAL_RAIL_SPINNER;
    if (session.id !== activeId && terminalDoneUnread.has(session.id)) return TERMINAL_RAIL_DONE_DOT;
    return "";
  }

  // 栏体只认后端真值：未就绪时 terminalSessionMap() 会回落到设计稿的预览种子表
  // （demo-service 等假会话），照单全收就是「以假乱真」。所以这两个入口先看就绪位，
  // 未就绪一律当空——「打开的终端」如实空缺；历史会话段是真实磁盘数据，不经过这里，
  // 照常渲染。
  function terminalRailSessionMap() {
    return terminalBackendReady ? terminalBackendSessions : {};
  }

  function terminalRailActiveSession() {
    return terminalRailSessionMap()[activeTerminalPreviewId] || null;
  }

  // 会话的 agent 身份：与页签左图标同一取值口径（实时归属 endpointId 优先，一键启动
  // 快照的 agentId 次之）。白名单字符过滤——这个 id 同时进 HTML 属性与克隆头像的
  // 选择器。空串 = 纯外壳终端（无 agent）。缺省参数读活跃终端：栏体跟随的 agent 就是它。
  function terminalRailAgentId(session) {
    const target = session === undefined ? terminalRailActiveSession() : session;
    if (!target) return "";
    const raw = (target.agent && target.agent.endpointId) || target.agentId || "";
    return /^[\w-]+$/.test(raw) ? raw : "";
  }

  // 栏内局部时间格式（M8 T3，dsh 式无前缀）：刚刚 / N分钟 / N小时 / 昨天 / N天 /
  // M月D日（跨年 YYYY年M月D日）。**栏内局部实现**——会话页共用的 sessRelTime 带
  // 「前」缀且被别的视图用着，不动它。
  function terminalRailRelTime(ts) {
    const diff = Date.now() - ts;
    if (diff < 0) return "刚刚"; // 时钟回拨防御
    if (diff < SESS_MIN) return "刚刚";
    if (diff < SESS_HOUR) return Math.floor(diff / SESS_MIN) + "分钟";
    if (diff < 24 * SESS_HOUR) return Math.floor(diff / SESS_HOUR) + "小时";
    const d = new Date(ts), now = new Date();
    const yest = new Date(now); yest.setDate(now.getDate() - 1);
    if (d.toDateString() === yest.toDateString()) return "昨天";
    if (diff < 7 * SESS_DAY) return Math.floor(diff / SESS_DAY) + "天";
    const sameYear = d.getFullYear() === now.getFullYear();
    return sameYear ? `${d.getMonth() + 1}月${d.getDate()}日` : `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
  }

  // 目录归一化：栏内唯一一把尺——分组键、移除清单比较、祖先判定、自愈时间戳都过
  // 它。与后端 terminal-rail-store 的 normalizeRailDir 同一口径（小写、统一分隔符、
  // 去尾斜杠）：前端拿 project 路径、后端存用户点选时的原始拼写，两侧必须对齐。
  function terminalRailNormDir(value) {
    return String(value || "").replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
  }

  // 历史会话分组：按 project 归组（组头取目录短名），无 project 归「未分组」并沉底；
  // 组序与组内序都按最近活跃倒序。纯函数。
  // 同一目录的不同拼写（大小写/斜杠/尾斜杠）必须落进同一组，所以 Map 键走归一化
  // 口径；组键（组态、水位线、data 属性都按它存）取一个稳定代表——最短者优先，
  // 等长按原串字典序。不用「首见拼写」：会话数组的顺序随活跃度变，组名会跟着漂。
  function terminalRailGroupSessions(sessions) {
    const groups = new Map();
    for (const session of Array.isArray(sessions) ? sessions : []) {
      if (!session) continue;
      const raw = typeof session.project === "string" ? session.project : "";
      const key = terminalRailNormDir(raw);
      if (!groups.has(key)) groups.set(key, { key: key ? raw : "", rows: [] });
      const bucket = groups.get(key);
      if (key && raw && (!bucket.key || raw.length < bucket.key.length
        || (raw.length === bucket.key.length && raw < bucket.key))) {
        bucket.key = raw;
      }
      bucket.rows.push(session);
    }
    const out = [];
    for (const bucket of groups.values()) {
      const rows = bucket.rows;
      rows.sort((a, b) => (b.lastActive || 0) - (a.lastActive || 0));
      out.push({ key: bucket.key, label: bucket.key ? sessDirName(bucket.key) : "未分组", rows, latest: rows[0].lastActive || 0 });
    }
    out.sort((a, b) => {
      if ((a.key === "") !== (b.key === "")) return a.key === "" ? 1 : -1;
      return (b.latest - a.latest) || String(a.label).localeCompare(String(b.label));
    });
    return out;
  }

  // 水位线（dsh 实测口径）：每组先露 5 条，点一次 +5，剩余不足一档即一次全展开；
  // 全展开后再点是「收起」（回基线）。水位只活在内存，不持久化。
  function terminalRailWatermarkView(total, watermark) {
    const limit = Math.max(TERMINAL_RAIL_WATERMARK, Number(watermark) || 0);
    const visible = Math.min(total, limit);
    return { visible, hidden: Math.max(0, total - visible), expanded: visible >= total };
  }

  function terminalRailNextWatermark(total, watermark) {
    const current = Math.max(TERMINAL_RAIL_WATERMARK, Number(watermark) || 0);
    if (current >= total) return TERMINAL_RAIL_WATERMARK;
    const next = current + TERMINAL_RAIL_WATERMARK;
    return next >= total ? total : next;
  }

  function terminalRailMoreLabel(view) {
    return view.expanded ? "收起" : `展开其余 ${view.hidden} 个会话`;
  }

  function terminalRailSameDir(a, b) {
    const left = terminalRailNormDir(a);
    return left !== "" && left === terminalRailNormDir(b);
  }

  function terminalRailGroupForDir(groups, cwd) {
    for (const group of groups) {
      if (group.key && terminalRailSameDir(cwd, group.key)) return group.key;
    }
    return "";
  }

  // 移除清单自愈（M14）：恢复区砍掉之后，组重新出现的唯一路径就是
  // 这条——该目录在移除之后来了新会话，组自动重现。判据：目录下存在 createdAt（缺
  // 省退化为 lastActive）晚于移除时刻的会话。自愈即把目录从清单摘掉并 POST 落盘；
  // 落盘失败静默回退，且本会话内不再自动重试（1s 归属轮询每拍都走这里，重试会变成
  // 请求风暴）。没有移除时刻的条目（M14 之前落盘的老数据）不自愈——没有时间轴就
  // 无从判断哪条会话是「新」的，由 loadTerminalRailPrefs 在拉回时补记当下。
  const terminalRailSelfHealFailed = new Set();

  function terminalRailSelfHealRemovedGroups(sessions) {
    if (!terminalRailPrefs.removedGroups.length) return false;
    const list = Array.isArray(sessions) ? sessions : [];
    let healed = false;
    for (const dir of [...terminalRailPrefs.removedGroups]) {
      const key = terminalRailNormDir(dir);
      if (!key || terminalRailSelfHealFailed.has(key)) continue;
      const removedAt = Number(terminalRailRemovedAt[key]) || 0;
      if (!removedAt) continue;
      const fresh = list.some((session) => session
        && typeof session.project === "string"
        && terminalRailSameDir(session.project, dir)
        && (Number(session.createdAt) || Number(session.lastActive) || 0) > removedAt);
      if (!fresh) continue;
      terminalRailPrefs.removedGroups = terminalRailPrefs.removedGroups.filter((row) => !terminalRailSameDir(row, dir));
      healed = true;
      api("POST", "/api/terminal/rail/restore-group", { dir })
        .then(() => {
          // 落盘成功才清时间轴：失败时保留原移除时刻，重载后仍能据它自愈。
          delete terminalRailRemovedAt[key];
          saveTerminalRailRemovedAt();
        })
        .catch(() => {
          terminalRailSelfHealFailed.add(key);
          terminalRailPrefs.removedGroups.push(dir);
          renderTerminalRailHistory(terminalRailAgentId());
        });
    }
    return healed;
  }

  // 分组移除（dsh §2.4 / m6 §2）：只从视图里摘掉目录身份——被移除目录的会话落
  // 「未分组」，会话记录与磁盘文件夹都不动。全局生效（不分 agent，dsh 工作区清单
  // 同为全局）。归一化比较口径同 store（terminalRailSameDir）：前端拿 project 路径、
  // 后端存用户点选时的原始拼写，必须是同一把尺。未分组组没有目录身份，天然不被
  // 移除（循环里 key 为空的组直接跳过）。
  function terminalRailRegroupRemoved(groups) {
    if (!terminalRailPrefs.removedGroups.length) return groups;
    for (const group of groups) {
      if (!group.key) continue;
      if (!terminalRailPrefs.removedGroups.some((dir) => terminalRailSameDir(dir, group.key))) continue;
      let ungrouped = groups.find((row) => row.key === "");
      if (!ungrouped) {
        ungrouped = { key: "", label: "未分组", rows: [], latest: 0 };
        groups.push(ungrouped);
      }
      ungrouped.rows.push(...group.rows);
      group.rows = [];
    }
    const ungrouped = groups.find((row) => row.key === "");
    if (ungrouped) {
      // 迁进来的行按最近活跃重排（恢复分组时同样按最近活跃归组，不记原索引——
      // dsh 的 sessionIds 槽位在我们这儿没有对应物，派生分组本就该按活跃序）
      ungrouped.rows.sort((a, b) => (b.lastActive || 0) - (a.lastActive || 0));
      ungrouped.latest = ungrouped.rows.length ? ungrouped.rows[0].lastActive || 0 : 0;
    }
    return groups.filter((group) => group.key === "" || group.rows.length > 0);
  }

  // 归档键＝endpoint＋session id：同一会话 id 在不同 agent 端点的存档里是不同
  // 对话，单键会误伤（与后端 terminal-rail-store 同一把尺）。
  function terminalRailArchivedKey(session) {
    const endpoint = session && typeof session.endpoint === "string" ? session.endpoint : "";
    const id = session && typeof session.id === "string" ? session.id : "";
    return endpoint && id ? `${endpoint}\u0000${id}` : "";
  }

  function terminalRailIsArchived(session) {
    const key = terminalRailArchivedKey(session);
    return !!key && terminalRailPrefs.archived.some((row) => terminalRailArchivedKey(row) === key);
  }

  // 归档＝视图过滤（dsh §1.4）：底层列表一个字节都不动，过滤放在分组之前——
  // 组内序、水位线、「展开其余 N」计数自然都按过滤后的行算（m6b §A6 实测口径：
  // 归档即计数减一，取消即加一）。M8 T7b 起筛选三态：default 隐藏 / show 内联灰显 /
  // only 只留归档（无归档的组整组丢弃，见渲染层的组过滤）。
  function terminalRailVisibleSessions() {
    const all = terminalRailHistory.sessions;
    if (terminalRailViewPrefs.archivedFilter === "only") return all.filter(terminalRailIsArchived);
    if (terminalRailViewPrefs.archivedFilter === "show") return all;
    return all.filter((session) => !terminalRailIsArchived(session));
  }

  // ── 全新终端兜底行（M8 T1）──
  // 新建终端后会话文件可能还没生成（agent 未发消息、列表里没有这条历史）——此时在
  // 它 cwd 所属组的组顶插一条 live 行，标签「新会话」、无时间；会话文件出现后自然
  // 被真行接替（dsh 的「新会话」行正是这个形态）。**渲染时从后端真值表现推导**，
  // 不另记 pending 状态：终端关了（不在会话表里）行即消失，同目录出现建终端之后
  // 活跃的会话即算被接替。判据＝该终端带 agent、无 resume 记录（续接创建的真行
  // 已在列表里，不需要兜底）、同目录没有比它更晚活跃的会话。
  function terminalRailPendingNewTerminals() {
    const agentId = terminalRailAgentId();
    if (!agentId) return [];
    const out = [];
    for (const session of Object.values(terminalRailSessionMap())) {
      if (terminalRailAgentId(session) !== agentId) continue;
      // 全新内切刚武装（POST /switch 未回）：这条终端正在变成「新会话」，兜底行
      // 必须当拍出现——旧 resume 还在、spawnedAt 还旧都是宿主侧未落定的表象，
      // 不能拿它们把用户此刻点击的目标行扣下（那一扣就是半秒空窗）。
      // 例外：目标目录的会话列表还没落地（历史未取回）时，兜底行无处安放；这种
      // 情况不用豁免，等列表回来按既有推导走（此时 POST 通常已落定）。
      const armed = terminalRailPendingFreshArmed(session);
      if (!armed && session.resume) continue;
      // 锚＝最近进程出生（spawnedAt 优先，回退 createdAt；与闲置判定同款）：
      // 内切/复活换进程时 createdAt 不动，拿它当锚会让同目录旧会话
      // （lastActive ≥ createdAt）把换新进程的兜底行误判成「已被接替」——
      // 全新内切后「新会话」行就出不来。旧记录无 spawnedAt 回退 createdAt。
      const state = session.backendState;
      const born = state && Number.isFinite(state.spawnedAt) ? state.spawnedAt
        : state && Number.isFinite(state.createdAt) ? state.createdAt
        : Date.now();
      // 武装中的全新内切跳过「已被接替」判定：同目录旧会话的 lastActive 必然
      // ≥ 旧出生时刻，按它判这条会被立刻扣掉——而这正是本次点击要接替的那批行。
      if (!armed) {
        const taken = terminalRailHistory.sessions.some((row) =>
          terminalRailSameDir(row.project, session.cwd) && (row.lastActive || 0) >= born);
        if (taken) continue;
      }
      out.push({ id: session.id, cwd: session.cwd, createdAt: born });
    }
    return out;
  }

  // ── 段头搜索（M8 T7a，照搬 m6c §A 裁剪后） ──
  // 行内展开不是浮层：点搜索钮＝展开＋自动聚焦；已展开再点不退出（非 toggle，只
  // 重新聚焦）。退出手势：Esc／清空钮／点开结果行＝清空＋收起；点搜索区外**仅当
  // 查询为空**才收起（有查询只失焦）。退出后列表滚动回顶、分组展开态保留。
  // 范围＝会话标题＋目录短名的大小写不敏感子串——dsh 出厂配置把 Host 内容搜索整个
  // 关了（m6c §A3 重大发现），侧栏实际就只有这个口径；照搬的就是它，不做全文。
  // 防抖 250ms（窗口内出「正在搜索会话历史…」骨架位）。不挂任何键盘加速入口
  // （显式不做清单既有口径）。
  const TERMINAL_RAIL_SEARCH_DEBOUNCE_MS = 250;
  const TERMINAL_RAIL_SEARCH_LIMIT = 20;
  let terminalRailSearch = { open: false, query: "", timer: null, searching: false };

  function terminalRailSearchMatches(query, sessions) {
    const q = String(query || "").trim().toLowerCase();
    if (!q) return [];
    return (Array.isArray(sessions) ? sessions : []).filter((session) => {
      if (!session) return false;
      const title = sessTitle(session).toLowerCase();
      const dir = typeof session.project === "string" ? sessDirName(session.project).toLowerCase() : "";
      return title.includes(q) || dir.includes(q);
    }).sort((a, b) => (b.lastActive || 0) - (a.lastActive || 0));
  }

  function openTerminalRailSearch() {
    const head = $("railTermSectionHead");
    const input = $("railTermSearchInput");
    if (head && head.classList) head.classList.add("is-searching");
    if (input) {
      input.tabIndex = 0;
      if (typeof input.focus === "function") input.focus();
    }
    terminalRailSearch.open = true;
    renderTerminalRailHistory(terminalRailAgentId());
  }

  function closeTerminalRailSearch() {
    const head = $("railTermSectionHead");
    const input = $("railTermSearchInput");
    if (terminalRailSearch.timer) { clearTimeout(terminalRailSearch.timer); terminalRailSearch.timer = null; }
    if (head && head.classList) head.classList.remove("is-searching");
    if (input) {
      input.tabIndex = -1;
      input.value = "";
      if (typeof input.blur === "function") input.blur();
    }
    terminalRailSearch.open = false;
    terminalRailSearch.query = "";
    terminalRailSearch.searching = false;
    // 退出后列表滚动回顶（m6c §A6：滚动位不保留；分组展开态在 collapsedGroups 里，
    // 与搜索无关，天然保留）
    const scroll = document.querySelector(".rail-term-scroll");
    if (scroll) scroll.scrollTop = 0;
    renderTerminalRailHistory(terminalRailAgentId());
  }

  // 搜索ing态输入：空查询当场回树；非空立即出「正在搜索会话历史…」，250ms 后落结果。
  function onTerminalRailSearchInput() {
    const input = $("railTermSearchInput");
    terminalRailSearch.query = input ? input.value : "";
    if (terminalRailSearch.timer) { clearTimeout(terminalRailSearch.timer); terminalRailSearch.timer = null; }
    if (!terminalRailSearch.query.trim()) {
      terminalRailSearch.searching = false;
      renderTerminalRailHistory(terminalRailAgentId());
      return;
    }
    terminalRailSearch.searching = true;
    renderTerminalRailHistory(terminalRailAgentId());
    terminalRailSearch.timer = setTimeout(() => {
      terminalRailSearch.timer = null;
      terminalRailSearch.searching = false;
      renderTerminalRailHistory(terminalRailAgentId());
    }, TERMINAL_RAIL_SEARCH_DEBOUNCE_MS);
  }

  // 搜索结果＝替换式平铺列表（无组头）：行＝标题＋目录短名，无命中高亮；live/归档
  // 行的形态与树里同一套（terminalRailRowHtml 的 result 变体）。归档会话也进结果
  // （跟随归档筛选，m6c §A3）——灰字、点击落「这条会话已归档，取消归档后才能续接」、
  // hover 出「取消归档」钮（m6b §A2 第三恢复入口）。
  function renderTerminalRailSearchResults(list) {
    const hits = terminalRailSearchMatches(terminalRailSearch.query, terminalRailVisibleSessions());
    const shown = hits.slice(0, TERMINAL_RAIL_SEARCH_LIMIT);
    const parts = [];
    if (terminalRailSearch.searching) {
      parts.push(`<div class="rail-term-search-status" role="status">正在搜索会话历史…</div>`);
    } else if (shown.length === 0) {
      parts.push(`<div class="rail-term-search-status">无匹配会话</div>`);
    } else {
      for (const session of shown) {
        const live = terminalRailFindOpenSession(session.endpoint, session.id);
        parts.push(terminalRailRowHtml(session, live, activeTerminalPreviewId, { result: true }));
      }
      if (hits.length > TERMINAL_RAIL_SEARCH_LIMIT) {
        // 截断句逐字（文案清单）；条数与上限同值，写字面量不改写文案
        parts.push(`<div class="rail-term-search-note">仅显示前 20 条结果，请缩小搜索范围。</div>`);
      }
    }
    const html = parts.join("");
    if (html !== terminalRailRendered.history) {
      terminalRailRendered.history = html;
      list.innerHTML = html;
    }
  }

  // ── 视图选项（M8 T7b，照搬 m6c §B 全集） ──
  // 三组互斥单选：分组方式（按工作区/按工作区树/单列表）、排序方式（最近更新/
  // 手动排序）、筛选会话（隐藏已归档/全部会话/仅显示已归档）。偏好落 localStorage
  // 一个键（dsh 的 dsh.workspace.view.v5 同层——纯视图偏好，不进面板后端）；
  // 手序按 agent 键存（手动排序的唯一来源＝会话行拖拽；组行不拖——我们的组是目录
  // 派生、无清单可持久化）。菜单右对齐锚定、dense 30px、✓ 居项最右、点选即关。
  const TERMINAL_RAIL_VIEW_GROUPS = [
    {
      label: "分组方式", field: "groupBy",
      items: [
        { value: "workspace", label: "按工作区" },
        { value: "workspace-tree", label: "按工作区树" },
        { value: "flat", label: "单列表" },
      ],
    },
    {
      label: "排序方式", field: "orderBy",
      items: [
        { value: "updated", label: "最近更新" },
        { value: "manual", label: "手动排序" },
      ],
    },
    {
      label: "筛选会话", field: "archivedFilter",
      items: [
        { value: "default", label: "隐藏已归档" },
        { value: "show", label: "全部会话（显示已归档）" },
        { value: "only", label: "仅显示已归档" },
      ],
    },
  ];

  function loadTerminalRailViewPrefs() {
    try {
      const raw = JSON.parse(localStorage.getItem(TERMINAL_RAIL_VIEW_KEY) || "null");
      if (!raw || typeof raw !== "object") return;
      const pick = (field, allowed) => {
        if (allowed.includes(raw[field])) terminalRailViewPrefs[field] = raw[field];
      };
      pick("groupBy", ["workspace", "workspace-tree", "flat"]);
      pick("orderBy", ["updated", "manual"]);
      pick("archivedFilter", ["default", "show", "only"]);
      if (raw.sessionOrder && typeof raw.sessionOrder === "object" && !Array.isArray(raw.sessionOrder)) {
        terminalRailViewPrefs.sessionOrder = raw.sessionOrder;
      }
    } catch { /* 读不懂/被禁用：用默认值 */ }
  }

  function saveTerminalRailViewPrefs() {
    try {
      localStorage.setItem(TERMINAL_RAIL_VIEW_KEY, JSON.stringify(terminalRailViewPrefs));
    } catch { /* 隐私模式等：偏好不持久化，本次会话内仍生效 */ }
  }

  // 组折叠态读写：只认字符串键；坏 JSON / 非数组 / 存储被禁时保留内存现值（首次为
  // 空表）——最坏表现为全展开，不挡栏体渲染。归一化在读、写两侧都过：组键是「稳定
  // 代表拼写」，同一目录的大小写/斜杠形态可能变，落盘口径必须与分组归并同一把尺。
  function loadTerminalRailCollapsedGroups() {
    let raw = null;
    try {
      raw = JSON.parse(localStorage.getItem(TERMINAL_RAIL_COLLAPSED_KEY) || "[]");
    } catch { return; }
    if (!Array.isArray(raw)) return;
    terminalRailCollapsedGroups.clear();
    for (const value of raw) {
      if (typeof value === "string") terminalRailCollapsedGroups.add(terminalRailNormDir(value));
    }
  }

  function saveTerminalRailCollapsedGroups() {
    try {
      localStorage.setItem(TERMINAL_RAIL_COLLAPSED_KEY, JSON.stringify([...terminalRailCollapsedGroups]));
    } catch { /* 隐私模式等：本次会话内仍生效 */ }
  }

  // 移除时刻表的读写（M14 自愈用）：键一律过 terminalRailNormDir，与移除清单同一把
  // 尺——大小写/斜杠/尾斜杠不同的拼写必须落到同一条。读不懂/被禁用就从空表开始：
  // 最坏是这次会话不自愈，组保持隐藏，不会误把已移除的组放出来。
  function loadTerminalRailRemovedAt() {
    let raw = {};
    try {
      const parsed = JSON.parse(localStorage.getItem(TERMINAL_RAIL_REMOVED_AT_KEY) || "{}");
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) raw = parsed;
    } catch { /* 读不懂：从空表开始 */ }
    const out = {};
    for (const [key, value] of Object.entries(raw)) {
      const dir = terminalRailNormDir(key);
      const at = Number(value);
      if (dir && Number.isFinite(at) && at > 0) out[dir] = at;
    }
    terminalRailRemovedAt = out;
  }

  function saveTerminalRailRemovedAt() {
    try {
      localStorage.setItem(TERMINAL_RAIL_REMOVED_AT_KEY, JSON.stringify(terminalRailRemovedAt));
    } catch { /* 隐私模式等：本次会话内仍生效 */ }
  }

  // 目录祖先判定：b 在 a 底下（a 是 b 的祖先目录）。归一化口径同 terminalRailNormDir。
  function terminalRailIsAncestorDir(a, b) {
    const na = terminalRailNormDir(a), nb = terminalRailNormDir(b);
    return na !== "" && nb.startsWith(na + "\\");
  }

  // 按工作区树：组按目录祖先关系嵌套（m6c §B3 的 owningParentFolder：逐级找最近
  // 已注册祖先）。给每组打 depth；祖先组自动展开（切进树模式时一次性解除折叠，
  // 之后尊重用户手动收起——与 dsh 的 expandedGroups 含全部 ancestorKeys 同效果）。
  function terminalRailNestGroups(groups) {
    const keys = groups.map((group) => group.key).filter(Boolean);
    for (const group of groups) {
      if (!group.key) { group.depth = 0; continue; }
      let parent = "";
      for (const other of keys) {
        if (other === group.key) continue;
        if (!terminalRailIsAncestorDir(other, group.key)) continue;
        if (parent === "" || other.length > parent.length) parent = other;
      }
      group.depth = parent === "" ? 0 : (groups.find((row) => row.key === parent).depth || 0) + 1;
    }
    // 祖先在前、子孙随后（同层内保持原派生序）
    const out = [];
    const placed = new Set();
    const emit = (key) => {
      for (const group of groups) {
        if (placed.has(group)) continue;
        if (group.key && key !== "" && !terminalRailIsAncestorDir(key, group.key) && group.key !== key) continue;
        if (group.key === "" && key !== "") continue;
        placed.add(group);
        out.push(group);
        if (group.key) emit(group.key);
      }
    };
    for (const group of groups) {
      if (!group.key || group.depth !== 0) continue;
      if (placed.has(group)) continue;
      placed.add(group);
      out.push(group);
      emit(group.key);
    }
    for (const group of groups) if (!placed.has(group)) { placed.add(group); out.push(group); }
    return out;
  }

  // 手动排序渲染：组内行按 sessionOrder[agentId] 的名次排，榜上无名回落到最近活跃。
  function terminalRailApplyManualOrder(groups) {
    const order = terminalRailViewPrefs.sessionOrder[terminalRailAgentId()];
    if (!Array.isArray(order)) return groups;
    const rank = new Map(order.map((id, index) => [id, index]));
    for (const group of groups) {
      group.rows.sort((a, b) => {
        const ra = rank.has(a.id) ? rank.get(a.id) : Number.MAX_SAFE_INTEGER;
        const rb = rank.has(b.id) ? rank.get(b.id) : Number.MAX_SAFE_INTEGER;
        return (ra - rb) || (b.lastActive || 0) - (a.lastActive || 0);
      });
    }
    return groups;
  }

  // 切入手动排序：把当前派生序（渲染序）快照进该 agent 的手序（dsh setOrderBy 的
  // initialOrders 同语义——切换瞬间视觉序不变）。
  function terminalRailSnapshotManualOrder() {
    const agentId = terminalRailAgentId();
    if (!agentId) return;
    const ids = [];
    for (const group of terminalRailLastGroups) {
      for (const row of group.rows) if (!ids.includes(row.id)) ids.push(row.id);
    }
    terminalRailViewPrefs.sessionOrder[agentId] = ids;
    saveTerminalRailViewPrefs();
  }

  // 拖拽落点：把 fromId 移到 toId 之前（dsh workspaces.insertBefore 同语义）。
  // 先快照（从 updated 拖进来时）再改写，切回 updated 会清空该 agent 手序。
  function terminalRailMoveInManualOrder(agentId, fromId, toId) {
    if (!agentId || !fromId || fromId === toId) return;
    if (terminalRailViewPrefs.orderBy !== "manual") {
      terminalRailSnapshotManualOrder();
      terminalRailViewPrefs.orderBy = "manual";
    }
    const order = Array.isArray(terminalRailViewPrefs.sessionOrder[agentId])
      ? terminalRailViewPrefs.sessionOrder[agentId].slice()
      : [];
    const from = order.indexOf(fromId);
    if (from >= 0) order.splice(from, 1);
    const to = toId ? order.indexOf(toId) : -1;
    if (to >= 0) order.splice(to, 0, fromId);
    else order.push(fromId);
    terminalRailViewPrefs.sessionOrder[agentId] = order;
    saveTerminalRailViewPrefs();
  }

  // 视图选项菜单：栏内单例（同组头 ⋯ 菜单形制），右对齐锚定、点选即关。
  let terminalRailViewMenuEl = null;

  function closeTerminalRailViewMenu() {
    if (terminalRailViewMenuEl && typeof terminalRailViewMenuEl.remove === "function") terminalRailViewMenuEl.remove();
    terminalRailViewMenuEl = null;
  }

  function openTerminalRailViewMenu() {
    const dir = $("railTerminalDir");
    const btn = $("railTermViewOptionsBtn");
    if (!dir || !btn) return;
    closeTerminalRailViewMenu();
    closeTerminalRailGroupMenu();
    closeTerminalRailHoverCard();
    const menu = document.createElement("div");
    menu.className = "rail-term-menu rail-term-view-menu";
    for (const group of TERMINAL_RAIL_VIEW_GROUPS) {
      const label = document.createElement("div");
      label.className = "rail-term-view-label";
      label.textContent = group.label;
      menu.append(label);
      for (const item of group.items) {
        const el = document.createElement("button");
        el.type = "button";
        el.className = "rail-term-menu-item rail-term-view-item";
        if (terminalRailViewPrefs[group.field] === item.value) el.classList.add("is-selected");
        el.setAttribute("data-rail-term-view", `${group.field}:${item.value}`);
        const text = document.createElement("span");
        text.className = "rail-term-view-text";
        text.textContent = item.label;
        const check = document.createElement("span");
        check.className = "rail-term-view-check";
        check.innerHTML = TERMINAL_RAIL_ICON_CHECK;
        el.append(text, check);
        menu.append(el);
      }
    }
    // M9-D1：portal 到 body 下 position:fixed（栏体 overflow:hidden 会裁栏内浮层，
    // dsh 的 portal:true 同款）；右对齐锚定＝菜单右缘贴钮右缘（m6c §B2 align:end）。
    document.body.append(menu);
    const btnRect = btn.getBoundingClientRect();
    const width = menu.offsetWidth || 200;
    menu.style.top = `${Math.max(8, btnRect.bottom + 4)}px`;
    menu.style.left = `${Math.max(8, Math.min(btnRect.right - width, window.innerWidth - width - 8))}px`;
    // 滚动收场（对称组头菜单）：portal 到 body 后菜单不随树滚，树一滚就飘——挂个
    // 一次性 capture scroll 监听跟着关。
    dir.addEventListener("scroll", closeTerminalRailViewMenu, { capture: true, once: true });
    terminalRailViewMenuEl = menu;
  }
  // 点选：写偏好 → 落盘 → 连带动作（切 manual 快照/切 updated 清序/树模式解折叠）
  // → 重渲 → 关菜单。
  function applyTerminalRailViewChoice(field, value) {
    if (!TERMINAL_RAIL_VIEW_GROUPS.some((group) => group.field === field)) return;
    if (terminalRailViewPrefs[field] === value) { closeTerminalRailViewMenu(); return; }
    if (field === "orderBy" && value === "manual") terminalRailSnapshotManualOrder();
    if (field === "orderBy" && value === "updated") delete terminalRailViewPrefs.sessionOrder[terminalRailAgentId()];
    if (field === "groupBy" && value === "workspace-tree") {
      // 树模式：祖先组自动展开（一次性；之后尊重用户手动收起）
      for (const group of terminalRailLastGroups) {
        if (group.key && group.depth > 0) terminalRailCollapsedGroups.delete(terminalRailNormDir(group.key));
      }
      saveTerminalRailCollapsedGroups();
    }
    terminalRailViewPrefs[field] = value;
    saveTerminalRailViewPrefs();
    terminalRailFlipMode = "instant"; // 视图切换是 resetKey：瞬时跳变（dsh 同口径）
    renderTerminalRailHistory(terminalRailAgentId());
    closeTerminalRailViewMenu();
  }

  // ---- 渲染 ----
  function renderTerminalRail() {
    if (currentView !== "terminal") return; // 栏只在终端视图露出，别处不白跑渲染
    const dir = $("railTerminalDir");
    if (!dir) return;
    const agentId = terminalRailAgentId();
    const newBtn = $("railTermNewBtn");
    // 就绪闸与页签栏加号同拍：未就绪时新建不可点（禁用位由 syncTerminalAddBtn 同拍刷新）。
    if (newBtn) {
      newBtn.disabled = !terminalBackendReady;
      // 文案随聚焦分态（M8 T3，用户 2026-10-21 指示）：有 agent 聚焦时起的是该
      // agent 的会话，叫「新建会话」；无 agent 聚焦时起空白终端，叫「新建终端」。
      // 行为不变，仅文案；aria/title 同步换。标签在子 span 里（钮上还有图标），
      // 不能直接写 textContent。
      const label = agentId ? "新建会话" : "新建终端";
      const labelEl = typeof newBtn.querySelector === "function" ? newBtn.querySelector(".rail-term-new-label") : null;
      if (labelEl && labelEl.textContent !== label) labelEl.textContent = label;
      if (newBtn.title !== label) newBtn.title = label;
      if (typeof newBtn.setAttribute === "function") newBtn.setAttribute("aria-label", label);
    }
    renderTerminalRailHistory(agentId);
    syncTerminalRailHistory(agentId);
  }

  // 树行 HTML（M8 T1/T2/T5）：live 行带状态点 + 关闭叉 + 归档钮；非 live 行只带
  // 归档钮；归档行（筛选 show 态内联）灰字 + 取消归档钮。live 属性带终端 id——
  // 点击委托据此分支（聚焦终端 vs 走续接两分支）。
  function terminalRailRowHtml(session, live, activeId, opts) {
    const title = sessTitle(session);
    const time = session.lastActive ? terminalRailRelTime(session.lastActive) : "";
    const archived = terminalRailIsArchived(session);
    const result = !!(opts && opts.result);
    const cls = ["rail-term-row", "rail-term-row-history"];
    if (result) cls.push("rail-term-row-result");
    if (live) cls.push("is-live");
    if (archived) cls.push("is-archived");
    // 选中判据（M5）：pending 存在时只看 pending 是否命中本行——点下一条的瞬间
    // 旧活跃行立刻失亮（pending 优先于 live 派生，一屏至多一条选中）；无 pending
    // 维持原 live 派生。读模块状态位而非 DOM-only 切类名：1s 轮询全树重铺会冲掉
    // 类名（见 terminalRailSelectPending 处注释）。
    if (terminalRailSelectPending
      ? session.id === terminalRailSelectPending.id && session.endpoint === terminalRailSelectPending.endpoint
      : live && live.id === activeId) cls.push("is-active");
    // 行首常驻槽（dsh sessionRow 同构）：所有会话行（历史/pending/搜索结果）都渲染
    // 16×20 前导槽——槽内容取 terminalRailStateSlotHtml（与页签指示位同一判定）：
    // working 行填转圈（14×14 SVG，读屏文本「进行中」）、非聚焦的 done（跑完未读）
    // live 行填绿点（title「已完成」，dsh completed）、其余一律留空（dsh 四态机
    // pendingInteraction＞running＞completed＞idle，行内只画最高优先级一态、idle 不画
    // 任何图标；exited 无专门呈现，随空槽自然成立，行点击续接/复活语义不变）。槽宽
    // 恒定，图标出现/消失/互换都不动标题文字起点；行 8+16+8 与组头 8+16+8 同式，
    // 标题与组头文字严格同 x。
    const dot = terminalRailStateSlotHtml(live, activeId);
    const closeBtn = live
      ? `<span class="rail-term-row-close" data-rail-term-close="${esc(live.id)}" aria-hidden="true">×</span>`
      : "";
    const dirMeta = result && typeof session.project === "string" && session.project
      ? `<span class="rail-term-row-dir">${escapeHtml(sessDirName(session.project))}</span>`
      : "";
    const action = archived
      ? `<span class="rail-term-row-unarchive" data-rail-term-unarchive="${esc(session.id)}" title="取消归档" aria-label="取消归档">${TERMINAL_RAIL_ICON_UNARCHIVE}</span>`
      : `<span class="rail-term-row-archive" data-rail-term-archive="${esc(session.id)}" title="归档会话" aria-label="归档会话">${TERMINAL_RAIL_ICON_ARCHIVE}</span>`;
    // 会话行可拖（M8 T7b：手序的唯一来源）；归档行不可拖（m6c：draggable＝非空白且
    // 非归档行）。组行不拖——组是目录派生、无清单可持久化。
    const draggable = archived ? "" : ` draggable="true"`;
    return `
      <button type="button" class="${cls.join(" ")}" data-rail-term-resume="${esc(session.id)}"${live ? ` data-rail-term-live="${esc(live.id)}"` : ""}${draggable} title="${esc(title)}">
        <span class="rail-term-slot">${dot}</span>
        <span class="rail-term-row-title">${escapeHtml(title)}</span>
        ${dirMeta}
        <span class="rail-term-row-time">${escapeHtml(time)}</span>
        ${closeBtn}
        ${action}
      </button>`;
  }

  // 「新会话」兜底行（M8 T1）：组顶 live 行，无时间、无归档钮（还没有会话身份可
  // 归档），点击走聚焦、hover 出关闭叉。
  function terminalRailPendingRowHtml(entry, activeId) {
    const session = terminalRailSessionMap()[entry.id];
    const working = !!session && session.status === "working";
    // 同 terminalRailRowHtml 的选中判据（M5）：pending 存在时按终端 id 认行——
    // 这枚 pending 就是这条终端的全新内切时，兜底行是这次点击的目标行，当拍亮；
    // 其余情况不亮（pending 命中的历史行才是被选中的那条，一屏至多一条）。
    const active = terminalRailPendingFreshActive(entry, activeId);
    return `
      <button type="button" class="rail-term-row rail-term-row-history is-live${active ? " is-active" : ""}" data-rail-term-session="${esc(entry.id)}" title="新会话">
        <span class="rail-term-slot">${working ? TERMINAL_RAIL_SPINNER : ""}</span>
        <span class="rail-term-row-title">新会话</span>
        <span class="rail-term-row-close" data-rail-term-close="${esc(entry.id)}" aria-hidden="true">×</span>
      </button>`;
  }

  function renderTerminalRailHistory(agentId) {
    const list = $("railTermHistoryList");
    if (!list) return;
    // 搜索态：结果平铺列表整块替换树（m6c §A4），树渲染全旁路。退出搜索后的首帧
    // 树渲染也按 reset 处理（兜底行 diff 门，见下方）——树从结果平铺换回，行集合
    // 变化不是兜底行的真实离开。
    if (terminalRailSearch.open && terminalRailSearch.query.trim()) {
      terminalRailLastDiffSearch = true;
      renderTerminalRailSearchResults(list);
      return;
    }
    // 「落地」= 这个 agent 的列表已成功取回。抓取失败也写着同一个 endpoint，但那份
    // 空表不是事实——按失败态消费掉自动展开，用户之后手动刷新成功就再也不会展开。
    const loaded = !agentId || (terminalRailHistory.endpoint === agentId && !terminalRailHistory.error);
    const sessions = loaded ? terminalRailVisibleSessions() : [];
    // 移除自愈（M14）先于分组：该目录在移除之后来了新会话，就先把它从移除清单摘掉，
    // 下面的分组与「移除摘牌」照常按最新清单算。用未过滤的会话全集判定——归档只是
    // 视图过滤，不该影响「这目录有没有新会话」。
    if (loaded) terminalRailSelfHealRemovedGroups(terminalRailHistory.sessions);
    // 先归档过滤（visible）再分组，最后把被移除目录的会话改组进「未分组」——
    // 顺序即语义：过滤 → 目录身份 → 移除摘牌。
    let groups = terminalRailRegroupRemoved(terminalRailGroupSessions(sessions));
    // 「仅显示已归档」：无归档会话的组整组丢弃（dsh groupByWorkspace 同口径）
    if (terminalRailViewPrefs.archivedFilter === "only") {
      groups = groups.filter((group) => group.key === "" || group.rows.length > 0);
    }
    // 分组方式三态（M8 T7b）：单列表＝无组平铺（key 空串的伪组，不渲组头）；
    // 按工作区树＝目录祖先嵌套＋缩进；按工作区＝平铺目录组（默认）。
    const flat = terminalRailViewPrefs.groupBy === "flat";
    if (flat) {
      const rows = [];
      for (const group of groups) rows.push(...group.rows);
      rows.sort((a, b) => (b.lastActive || 0) - (a.lastActive || 0));
      groups = [{ key: "", label: "会话", rows, latest: rows.length ? rows[0].lastActive || 0 : 0, flat: true }];
    } else if (terminalRailViewPrefs.groupBy === "workspace-tree") {
      groups = terminalRailNestGroups(groups);
    }
    // 手动排序：组内行按手序排（榜上无名回落到最近活跃）
    if (terminalRailViewPrefs.orderBy === "manual") terminalRailApplyManualOrder(groups);
    // 全新终端兜底行（M8 T1）：按 cwd 找所属组，没有就为它建组（目录被用户移除过
    // 的除外——那种目录的会话都进「未分组」，兜底行同命运）。
    const pending = terminalRailPendingNewTerminals();
    for (const entry of pending) {
      const removed = terminalRailPrefs.removedGroups.some((dir) => terminalRailSameDir(dir, entry.cwd));
      // M10-F1：flat 模式只有 key "" 的平铺伪组——兜底行挂伪组，不新建真组
      // （否则单列表平铺行之外会多出一个真组头，刚拉起全新 agent 终端即撞见）。
      let group = flat
        ? groups.find((row) => row.flat)
        : groups.find((row) => row.key && terminalRailSameDir(row.key, entry.cwd));
      if (!group && !removed && !flat) {
        group = { key: entry.cwd, label: sessDirName(entry.cwd), rows: [], latest: entry.createdAt, depth: 0 };
        groups.push(group);
        groups.sort((a, b) => {
          if ((a.key === "") !== (b.key === "")) return a.key === "" ? 1 : -1;
          return (b.latest - a.latest) || String(a.label).localeCompare(String(b.label));
        });
      }
      if (!group) continue;
      if (!group.pending) group.pending = [];
      group.pending.push(entry);
    }
    // live 映射：行 → 开着终端（resume 两键，M7-S5）。selected 由渲染时的活跃终端定。
    for (const group of groups) {
      if (!group.live) group.live = new Map();
      for (const row of group.rows) {
        const live = terminalRailFindOpenSession(row.endpoint, row.id);
        if (live) group.live.set(row.id, live);
      }
    }
    terminalRailLastGroups = groups;
    // 活跃终端所在组自动展开并滚到可见：只在「活跃终端换了」这一刻做一次，而且必须
    // 等这个 agent 的列表真落地、且真的找到了活跃终端所在组——首帧渲染时历史还没
    // 拉回来（组表为空），那时就认下「已自动展开」会让这次展开永远不发生。
    // 同上：活跃终端只读后端真值，未就绪时不拿预览种子的 cwd 去展开组。
    const activeSession = terminalRailActiveSession();
    const activeGroup = activeSession ? terminalRailGroupForDir(groups, activeSession.cwd) : "";
    const autoKey = `${agentId}\u0000${activeSession ? activeSession.id : ""}`;
    let scrollKey = "";
    if (activeGroup && autoKey !== terminalRailAutoExpandedFor) {
      terminalRailAutoExpandedFor = autoKey;
      if (terminalRailCollapsedGroups.delete(terminalRailNormDir(activeGroup))) saveTerminalRailCollapsedGroups();
      scrollKey = activeGroup;
    }
    const parts = [];
    // 「仅显示已归档」且一条归档都没有：空态（m6c §A1）——24px 归档图标 + 两句，
    // 「查看其他会话」点了切回「隐藏已归档」。
    if (terminalRailViewPrefs.archivedFilter === "only" && sessions.length === 0) {
      parts.push(`
      <div class="rail-term-empty">
        <span class="rail-term-empty-icon">${TERMINAL_RAIL_ICON_ARCHIVE}</span>
        <span class="rail-term-empty-text">暂无已归档会话</span>
        <button type="button" class="rail-term-empty-action" data-rail-term-view-reset="1">查看其他会话</button>
      </div>`);
    }
    for (const group of groups) {
      const collapsed = terminalRailCollapsedGroups.has(terminalRailNormDir(group.key));
      // 组头三件（M7 S3 / M8 T7）：非 hover 是文件夹图标（开/关两枚），hover 同槽位
      // 换成箭头（0ms 硬切，CSS 管）；含当前聚焦会话的组图标变主题色（T4）；右侧
      // hover 出 ⊕（在此目录新建终端）与 ⋯（菜单，现仅「移除分组」）。「未分组」组
      // 没有目录身份，这些都不给（dsh 同口径）。组头本身仍是整行可点的折叠开关。
      // 树模式缩进 8+depth×12px（m6c §B3）；单列表模式不渲组头。
      const current = group.key !== "" && group.key === activeGroup;
      const indent = group.depth ? ` style="padding-inline-start: ${8 + group.depth * 12}px"` : "";
      const headActions = group.key
        ? `<span class="rail-term-group-actions">
          <span class="rail-term-group-btn" data-rail-term-group-new="${esc(group.key)}" title="在此目录新建终端" aria-label="在此目录新建终端">${TERMINAL_RAIL_ICON_PLUS}</span>
          <span class="rail-term-group-btn" data-rail-term-group-menu="${esc(group.key)}" aria-label="分组操作">${TERMINAL_RAIL_ICON_ELLIPSIS}</span>
        </span>`
        : "";
      if (!group.flat) {
        parts.push(`
      <div class="rail-term-group${collapsed ? "" : " is-open"}">
        <div class="rail-term-group-head" data-rail-term-group-head="${esc(group.key || TERMINAL_RAIL_UNGROUPED_HEAD)}"${indent}>
          <button type="button" class="rail-term-group-toggle" data-rail-term-group="${esc(group.key)}" aria-expanded="${collapsed ? "false" : "true"}" title="${esc(group.label)}">
            <span class="rail-term-group-slot">
              <span class="rail-term-group-arrow">${TERMINAL_RAIL_ICON_CHEVRON}</span>
              <span class="rail-term-group-icon${current ? " is-current" : ""}">${collapsed ? TERMINAL_RAIL_ICON_FOLDER_CLOSED : TERMINAL_RAIL_ICON_FOLDER_OPEN}</span>
            </span>
            <span class="rail-term-group-name">${escapeHtml(group.label)}</span>
          </button>
          ${headActions}
        </div>`);
      }
      if (!collapsed) {
        // 兜底行固定组顶（不看 lastActive）；水位线只数真实历史行（单列表模式不设
        // 水位——dsh 平铺同样一次露全）
        for (const entry of group.pending || []) parts.push(terminalRailPendingRowHtml(entry, activeTerminalPreviewId));
        if (group.flat) {
          for (const row of group.rows) {
            parts.push(terminalRailRowHtml(row, group.live.get(row.id) || null, activeTerminalPreviewId));
          }
        } else {
          const view = terminalRailWatermarkView(group.rows.length, terminalRailWatermarks.get(group.key));
          // M12-B 水位线联动（dsh requiredWatermark 同构）：运行中＋当前会话两档
          // 强制入可见段——永远不被藏进「展开其余 N 个会话」。我们只有 running＋
          // current 两个信号（无 pendingInteraction/completed，范围声明）。flat
          // 模式不设水位（整组平铺全露），走不到这条分支。
          let required = view.visible;
          for (let i = 0; i < group.rows.length; i += 1) {
            const live = group.live.get(group.rows[i].id) || null;
            if (!live) continue;
            if (live.status === "working" || live.id === activeTerminalPreviewId) required = Math.max(required, i + 1);
          }
          const shown = Math.min(group.rows.length, required);
          for (const row of group.rows.slice(0, shown)) {
            parts.push(terminalRailRowHtml(row, group.live.get(row.id) || null, activeTerminalPreviewId));
          }
          if (group.rows.length > TERMINAL_RAIL_WATERMARK) {
            const label = terminalRailMoreLabel({ visible: shown, hidden: group.rows.length - shown, expanded: shown >= group.rows.length });
            parts.push(`<button type="button" class="rail-term-more" data-rail-term-more="${esc(group.key)}">${label}</button>`);
          }
        }
      }
      if (!group.flat) parts.push(`</div>`);
    }
    const html = parts.join("");
    // 兜底行生命周期动效（2026-10-25，与归档 M13 同观感）：本帧兜底集与 DOM 现存
    // 集比对，有增删且动效可用时本帧按归档同款处理——量旧位＋快照→换写→FLIP
    // （下方元素位移 200ms/新元素淡入 100ms）＋消失元素挂幽灵淡出 100ms。新会话行的
    // 出现（新建/全新内切）与消失（内切换走/被真行接替/关闭终端）都走这一条；
    // 快照含历史行，同帧被水位线挤出可见段的行随之幽灵淡出，与真实离开同观感。
    // 量测集自 2026-10-26 起含组头与水位线钮：兜底行增删推动的是整棵树，只让行滑、
    // 组头按布局瞬跳会让组头在 200ms 里压在自己那行身上（两种缓动同屏）。
    // 门：无人为 FLIP 在途（组折叠/归档已置 flip——组折叠整组藏行不是离开）；换
    // agent/搜索退出/首帧沿 resetKey 口径瞬时落位；未武装或 reduced-motion 不量。
    let pendingExitSnapshot = null;
    const pendingDiffReset = agentId !== terminalRailLastDiffAgent || terminalRailLastDiffSearch;
    terminalRailLastDiffAgent = agentId;
    terminalRailLastDiffSearch = false;
    if (!pendingDiffReset && terminalRailFlipMode === "instant" && terminalRailMotionEnabled() && html !== terminalRailRendered.history) {
      const present = terminalRailPendingRowKeys(list);
      let pendingChanged = present.size !== pending.length;
      for (let i = 0; !pendingChanged && i < pending.length; i += 1) pendingChanged = !present.has(pending[i].id);
      if (pendingChanged) {
        terminalRailFlipMode = "flip";
        pendingExitSnapshot = terminalRailSnapshotMotion(list);
      }
    }
    // 旧位置只在真要播 FLIP 时才量：1s 归属轮询每拍都走本函数，无条件逐元素
    // getBoundingClientRect 等于每秒一次强制布局（dsh 也只量参与动画的元素）。
    const before = terminalRailFlipMode === "flip" ? terminalRailMotionTops(list) : null;
    if (html !== terminalRailRendered.history) {
      terminalRailRendered.history = html;
      list.innerHTML = html;
      if (before) playTerminalRailFlip(list, before);
      if (pendingExitSnapshot && pendingExitSnapshot.size && list.parentElement) {
        terminalRailMountExitGhosts(list, list.parentElement, pendingExitSnapshot);
      }
    }
    terminalRailFlipMode = "instant";
    if (scrollKey && terminalRailScrolledFor !== autoKey) {
      terminalRailScrolledFor = autoKey;
      terminalRailScrollGroupIntoView(scrollKey);
    }
  }

  // 动效参与者与身份键（2026-10-26 扩到全树）：会话行（data-rail-term-resume）、
  // 「新会话」兜底行（data-rail-term-session）、组头（data-rail-term-group-head）与
  // 水位线钮（data-rail-term-more）共用同一套量测/播放口径。此前只量行——兜底行
  // 增删会把整棵树纵向推动（新组出现、整组消失、跨组位移），行滑 200ms 而组头按
  // 布局瞬间落位，动画期间组头就压在自己那行身上：同一段位移两种缓动，观感即
  // 「表观缓动不一致」。键按类别加前缀，四属不互撞（组头与水位线钮同吃组键）。
  const TERMINAL_RAIL_MOTION_SELECTOR = "[data-rail-term-resume], [data-rail-term-session], [data-rail-term-group-head], [data-rail-term-more]";
  // 「未分组」组没有目录键，但组序变化时它照样被推动——用固定哨兵当键，不用空串
  // （空串＝该元素不进动效集）。
  const TERMINAL_RAIL_UNGROUPED_HEAD = "~ungrouped";
  function terminalRailMotionKey(el) {
    if (!el || typeof el.getAttribute !== "function") return "";
    const resume = el.getAttribute("data-rail-term-resume");
    if (resume) return `resume:${resume}`;
    const pending = el.getAttribute("data-rail-term-session");
    if (pending) return `pending:${pending}`;
    const head = el.getAttribute("data-rail-term-group-head");
    if (head) return `head:${head}`;
    // 水位线钮的 data 值就是组键本身（点击处理要用它），「未分组」组为空串——
    // 空串键与「没量到」不可区分，故空值补哨兵后仍进动效集。
    if (el.hasAttribute && el.hasAttribute("data-rail-term-more")) {
      return `more:${el.getAttribute("data-rail-term-more") || TERMINAL_RAIL_UNGROUPED_HEAD}`;
    }
    return "";
  }

  // 动效身份键的唯一枚举入口（2026-10-26）：同一份会话列表里可能出现同 id 的两行
  // （同一段对话被复制到另一个项目目录，扫描按文件各出一行）。身份键只按 id 拼，旧位
  // 表按 id 索引会让后一行覆盖前一行——靠前那行读到的是靠后那行的位置，算出一个行距
  // 的假位移（30~32px，200ms ease-out）；收起下方组时整组位移把同组其它行的运动盖住，
  // 只有它单行「向下抽搐再弹回」。这里按文档序给同键的第 n 个出现补序号后缀，
  // 量测／播放／退场快照／幽灵存活四处共用同一份枚举，四者键序必然一致。
  function terminalRailMotionEntries(list) {
    const entries = [];
    if (!list || typeof list.querySelectorAll !== "function") return entries;
    const seen = new Map();
    for (const el of list.querySelectorAll(TERMINAL_RAIL_MOTION_SELECTOR)) {
      const base = terminalRailMotionKey(el);
      if (!base) continue;
      const count = (seen.get(base) || 0) + 1;
      seen.set(base, count);
      entries.push({ el, key: count === 1 ? base : `${base}#${count}` });
    }
    return entries;
  }

  function terminalRailMotionTops(list) {
    const tops = new Map();
    for (const { el, key } of terminalRailMotionEntries(list)) {
      if (typeof el.getBoundingClientRect !== "function") continue;
      tops.set(key, el.getBoundingClientRect().top);
    }
    return tops;
  }

  function terminalRailScrollGroupIntoView(key) {
    const list = $("railTermHistoryList");
    if (!list || typeof list.querySelectorAll !== "function") return;
    for (const head of list.querySelectorAll("[data-rail-term-group]")) {
      if (head.getAttribute("data-rail-term-group") !== key) continue;
      if (typeof head.scrollIntoView === "function") head.scrollIntoView({ block: "nearest" });
      return;
    }
  }

  // 简版 FLIP（dsh AnimatedRows 实测：位移 200ms ease-out、新元素 100ms ease-out）。
  // 组展开/收起与归档/撤销（M13）置 flip；兜底行增删（2026-10-25）同样置 flip。
  // 量测集＝TERMINAL_RAIL_MOTION_SELECTOR（行＋组头＋水位线钮，2026-10-26 扩全）：
  // 同一段位移里所有元素同缓动，不再出现组头瞬跳压在行上。
  // 水位线增减、刷新、换 agent 是 resetKey，直接落位；首次输入前、首次挂载（没有
  // 旧位置可比）、prefers-reduced-motion 都不动。空集 before（换写前栏里一行都没
  // 量到）不整体跳过——新元素淡入仍然成立（撤销归档让唯一行归组、空栏里第一条
  // 兜底行出现），只是没有可位移的旧位。
  function playTerminalRailFlip(list, before) {
    if (!before) return;
    if (terminalRailFlipMode !== "flip") return;
    if (!terminalRailMotionArmed) return;
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (!list || typeof list.querySelectorAll !== "function") return;
    for (const { el, key } of terminalRailMotionEntries(list)) {
      if (typeof el.animate !== "function" || typeof el.getBoundingClientRect !== "function") continue;
      const previous = before.get(key);
      if (previous === undefined) {
        el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 100, easing: "ease-out" });
        continue;
      }
      const delta = previous - el.getBoundingClientRect().top;
      if (!delta) continue;
      el.animate([{ transform: `translateY(${delta}px)` }, { transform: "none" }], { duration: 200, easing: "ease-out" });
    }
  }

  // ── 退场动效（M13 归档/撤销；2026-10-25 起兜底行增删同路，dsh AnimatedRows
  // FLIP 路径）── 归档/撤销不再是 resetKey 瞬时消失：动作前给在册元素拍快照（克隆＋
  // 视口位），重渲后离开布局的元素以幽灵克隆补进滚动层 100ms 淡出——下方元素上移/
  // 落回 200ms、回填/归位元素淡入 100ms 由上面的 FLIP（flip 门）承担。量测集自
  // 2026-10-26 起含组头与水位线钮（整组消失时组头随之幽灵淡出，不再瞬跳）。
  // show 筛选下行不出布局（只是改观感），「活着」判定让幽灵只挂真离开的那一元素，
  // 不误伤。
  function terminalRailMotionEnabled() {
    if (!terminalRailMotionArmed) return false;
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
    return !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  function terminalRailSnapshotMotion(list) {
    const snapshot = new Map();
    if (!list || typeof list.querySelectorAll !== "function") return snapshot;
    for (const { el, key } of terminalRailMotionEntries(list)) {
      if (typeof el.getBoundingClientRect !== "function" || typeof el.cloneNode !== "function") continue;
      const rect = el.getBoundingClientRect();
      snapshot.set(key, { node: el.cloneNode(true), top: rect.top, left: rect.left, width: rect.width });
    }
    return snapshot;
  }

  // DOM 里现存兜底行的键集（data-rail-term-session）：供渲染 diff 判「本帧兜底集
  // 是否有增删」。历史行不进这个集——水位线截断（DOM 只挂可见段）造成的行增减
  // 不是真实离开，混进来会把展开/收拢误判成生命周期变化。
  function terminalRailPendingRowKeys(list) {
    const keys = new Set();
    if (!list || typeof list.querySelectorAll !== "function") return keys;
    for (const row of list.querySelectorAll("[data-rail-term-session]")) {
      const key = row.getAttribute("data-rail-term-session");
      if (key) keys.add(key);
    }
    return keys;
  }

  function terminalRailMountExitGhosts(list, host, snapshot) {
    const alive = new Set();
    for (const { key } of terminalRailMotionEntries(list)) alive.add(key);
    const hostRect = typeof host.getBoundingClientRect === "function" ? host.getBoundingClientRect() : null;
    if (!hostRect) return;
    for (const [key, snap] of snapshot) {
      if (alive.has(key)) continue;
      const ghost = snap.node;
      if (!ghost || !ghost.style || typeof ghost.animate !== "function" || typeof host.append !== "function") continue;
      if (ghost.classList && typeof ghost.classList.add === "function") ghost.classList.add("rail-term-ghost");
      if (typeof ghost.setAttribute === "function") ghost.setAttribute("inert", "");
      ghost.style.top = `${snap.top - hostRect.top + (host.scrollTop || 0)}px`;
      ghost.style.left = `${snap.left - hostRect.left}px`;
      ghost.style.width = `${snap.width}px`;
      host.append(ghost);
      ghost.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 100, easing: "ease-out", fill: "forwards" });
      setTimeout(() => { if (typeof ghost.remove === "function") ghost.remove(); }, 110);
    }
  }

  // 归档/撤销的统一重渲入口：快照→置 flip（下方元素位移＋新元素淡入）→重渲→给离开
  // 布局的元素挂幽灵。未武装（首次真实交互前）或 reduced-motion 时快照为空，只落位。
  // 渲染后显式复位 flip：搜索态走旁路早退不经过 render 尾部的复位，这里统一收口
  // 防止 flip 串到下一帧非动作渲染。
  function terminalRailRerenderExitFlip() {
    const list = $("railTermHistoryList");
    const host = list && list.parentElement ? list.parentElement : null;
    const snapshot = list && host && terminalRailMotionEnabled() ? terminalRailSnapshotMotion(list) : null;
    terminalRailFlipMode = "flip";
    renderTerminalRailHistory(terminalRailAgentId());
    terminalRailFlipMode = "instant";
    if (snapshot && snapshot.size && host) terminalRailMountExitGhosts(list, host, snapshot);
  }

  // ---- 数据 ----
  // 历史会话只在进终端视图时拉一次（全量扫盘实测 6.7s、无缓存——禁挂轮询）；身份
  // 换人时补拉一次。M9-D4 起段头刷新钮已砍（用户拍板只留搜索/视图选项），手动重取
  // 入口随之消失——重取只剩这两条自动路径，要手动刷新可退出终端视图再进。
  //
  // M4 起「进页」这条路径不再把请求排在首帧上：进页先拿缓存渲一帧，TTL 内一次都
  // 不发；过期才由 scheduleTerminalRailHistoryFetch 排到首帧之后补一拍。原来的写法
  // 是进页第一件事把缓存清成空表再同步重取——请求与首帧抢同一条链路，左栏在这几秒
  // 里也是空的（S2 场景②③④的共同来源）。「身份换人」那条仍是同步重拉（既有契约，
  // 见 syncTerminalRailHistory 尾部注释），它命中的是换 agent，不是每次进页。
  function terminalRailHistoryFresh(endpoint) {
    // 判据只认时间窗，不认 error：失败也记时间戳，于是不会退化成每秒重试（旧写法靠
    // 「身份没变就早退」隐式免掉重试，这里必须显式钉住）。成功走 TTL，失败走短退避。
    if (!endpoint || terminalRailHistory.endpoint !== endpoint) return false;
    const now = Date.now();
    if (terminalRailHistory.retryAt) return now < terminalRailHistory.retryAt;
    return (now - (terminalRailHistory.fetchedAt || 0)) < TERMINAL_RAIL_HISTORY_TTL_MS;
  }

  // 补拉的唯一排队点：rAF 让出进页这一拍渲染，setTimeout(0) 再把请求排到其后一个
  // 任务里——rAF 回调仍排在渲染之前，光靠它发请求还是跟首帧抢。
  function scheduleTerminalRailHistoryFetch() {
    if (terminalRailFetchQueued) return;
    terminalRailFetchQueued = true;
    const run = () => {
      terminalRailFetchQueued = false;
      // 排队期间可能已经离开终端页、已经没有 agent 焦点、或别的路径刚拉回一份：
      // 落地前逐条复核，命中任何一条就不发（补拉是背景动作，不值得为它补一次校验
      // 请求）。
      if (currentView !== "terminal") return;
      const endpoint = terminalRailAgentId();
      if (!endpoint || terminalRailFetchInFlight) return;
      if (terminalRailHistoryFresh(endpoint)) return;
      refreshTerminalRailHistory({ endpoint });
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => setTimeout(run, 0));
    else setTimeout(run, 0);
  }

  function syncTerminalRailHistory(agentId) {
    if (agentId === terminalRailHistory.endpoint) return;
    if (!agentId) {
      // 两种无 agent 焦点，处置不同（空态回落中性空树＝用户 2026-10-24 裁决）：
      // ①空白外壳页签还开着——保留上次加载的历史，用户才点得到行、把空白壳
      //   内切接管（M12-A 判定矩阵空白壳行，f2a60f0；真机验收发现旧行为在此
      //   清空 history 会让矩阵那一行永远不可达）。
      // ②一个终端都没了（关光最后一个页签/远端关光/进程自退）——栏回落中性
      //   空树，不再挂已关 agent 的会话表：会话栏是壳的资产，空态保持终端页
      //   的正常形态。切回 agent 上下文时 endpoint 对不上自然走重拉。
      if (Object.keys(terminalRailSessionMap()).length === 0) {
        terminalRailHistory = { endpoint: "", sessions: [], fetchedAt: 0, error: null };
      } else {
        terminalRailHistory = { ...terminalRailHistory, endpoint: "" };
      }
      terminalRailFlipMode = "instant";
      renderTerminalRailHistory("");
      return;
    }
    // 身份换人：旧身份的行挂在新身份下就是错行，先清再拉。这一条保持既有同步契约
    // （panel-terminal-rail.test.mjs 的两个 vm 沙箱钉着「切回 agent 上下文才走重拉」
    // 且是当场发生）；T2 动的是**进页那条路径**——身份没变的重复进入不再重拉。
    refreshTerminalRailHistory({ endpoint: agentId });
  }

  async function refreshTerminalRailHistory({ endpoint = terminalRailAgentId(), manual = false } = {}) {
    if (!endpoint || terminalRailFetchInFlight) return;
    terminalRailFetchInFlight = true;
    // 在飞期间就把 endpoint 认下来：全量扫盘一次实测 6.7s，这段时间里每次归属轮询都会
    // 走到 syncTerminalRailHistory——不认的话它每一拍都判「身份还没拉过」，同一份列表
    // 被反复排队重取。认下后组列表暂时为空，落地即替换。
    //
    // 但「认下来」不等于「清成空表」：同身份复取（TTL 过期后的补拉、手动刷新）把屏上
    // 已有的行留着，等新值落地再替换——清空了就是左栏在这段网络上开天窗，而这份复取
    // 本来只是把粗粒度清单对齐一拍。换身份才必须清：旧身份的行挂在新身份下就是错行。
    if (terminalRailHistory.endpoint !== endpoint) {
      terminalRailHistory = { endpoint, sessions: [], fetchedAt: 0, error: null };
    }
    try {
      const data = await api("GET", "/api/sessions/list");
      const rows = (Array.isArray(data && data.sessions) ? data.sessions : []).filter((row) => row && row.endpoint === endpoint);
      terminalRailHistory = { endpoint, sessions: rows, fetchedAt: Date.now(), error: null, retryAt: 0 };
    } catch (error) {
      // 失败不清行：同身份复取本来只是把粗粒度清单对齐一拍，失败就把屏上已有的行清掉
      // 等于自己制造一次空栏——而这正是这条路径要避免的观感。有行就照常挂着（错误只
      // 进控制台与下面的重试闸）；一行都没有（首拉失败）才记 error，让上层按失败处置。
      const kept = terminalRailHistory.endpoint === endpoint && Array.isArray(terminalRailHistory.sessions)
        ? terminalRailHistory.sessions
        : [];
      terminalRailHistory = {
        endpoint,
        sessions: kept,
        fetchedAt: Date.now(),
        error: kept.length ? null : error,
        // 短退避：失败不能死等 TTL（左栏没有手动刷新入口，半个空栏只能靠下次进页），
        // 也不能按秒重试（那是另一种骚扰）。
        retryAt: Date.now() + TERMINAL_RAIL_HISTORY_RETRY_MS,
      };
      if (manual) toast(panelError(error, "会话列表加载失败"), true);
    } finally {
      terminalRailFetchInFlight = false;
      terminalRailFlipMode = "instant";
      renderTerminalRail();
    }
  }

  // ---- 交互 ----
  // 在飞闸提为谓词（原 terminalSwitchInFlight 的静默吞击判断）：一次内切
  // （含补读）期间栏内其他会话点击被判定门忽略——此刻点亮乐观高亮，点击会被
  // 静默吞掉，高亮说谎比慢更糟。
  function terminalRailSwitchBusy() {
    return terminalSwitchInFlight;
  }

  // 乐观选中起点（M5）：领令牌、写 pending、起 TTL 兜底，然后只重渲栏——
  // 高亮当拍成立，不等宿主侧 1~2s 的进程探测与 PTY 重启。在飞闸前置：在飞时
  // 点亮了也兑现不了（点击会被判定门吞掉），直接返回不亮。
  // 入参两形：历史会话行 { endpoint, id }（续接内切/新开都用它认行）；全新内切
  // { endpoint, terminalId, cwd }（没有历史身份可亮，按终端 id 认「新会话」兜底行，
  // cwd 让兜底行落在目标目录组顶）。识别键互不串扰：pending 一次只点亮一行。
  function terminalRailBeginSelect(session) {
    if (!session || (!session.id && !session.terminalId)) return;
    if (terminalRailSwitchBusy()) return;
    terminalRailArmSelect(session);
  }

  // 领令牌＋写 pending＋TTL 兜底（无在飞闸）。两处调用：BeginSelect（用户点击当拍）
  // 与判定门内（全新内切确定要换之后）——后者本身就在闸里，闸已由它持有，再过
  // BeginSelect 的闸门会被自己挡掉。
  function terminalRailArmSelect(session) {
    if (!session || (!session.id && !session.terminalId)) return;
    terminalRailSelectSeq += 1;
    const token = terminalRailSelectSeq;
    if (terminalRailSelectPending && terminalRailSelectPending.timer !== null) {
      clearTimeout(terminalRailSelectPending.timer);
    }
    const timer = setTimeout(() => {
      // TTL 兜底：切换请求没有超时机制，挂死了不能让假高亮常驻。
      if (terminalRailSelectPending && terminalRailSelectPending.token === token) {
        terminalRailSelectPending = null;
        renderTerminalRail();
      }
    }, TERMINAL_RAIL_SELECT_TTL_MS);
    // 兜底定时器不拖住单测进程退出（浏览器无此 API，条件调用不改变行为——
    // 与全文件「typeof 闸护桩环境」同一条惯例）。
    if (timer && typeof timer.unref === "function") timer.unref();
    terminalRailSelectPending = {
      endpoint: session.endpoint || "",
      id: session.id || null,
      terminalId: session.terminalId || null,
      cwd: session.cwd || null,
      token,
      timer,
    };
    renderTerminalRail();
  }

  // 兜底行选中判据的两条通道（行渲染与兜底行推导共用同一口径）：默认＝活跃终端
  // id；有 pending 时历史行由 pending 占选中，兜底行只在「这枚 pending 就是这条
  // 终端的全新内切」（pending.terminalId 命中）时亮——否则不亮（pending 命中的
  // 历史行才是被选中的那条，一屏至多一条）。
  function terminalRailPendingFreshActive(entry, activeId) {
    return terminalRailSelectPending
      ? entry.id === terminalRailSelectPending.terminalId
      : entry.id === activeId;
  }

  // 全新内切的武装判定（兜底行推导用它豁免时序闸门）：pending 按终端 id 命中、
  // 目标目录与这条终端的 cwd 同组——此时即使 spawnedAt 还旧（POST /switch 未回）、
  // resume 还在（宿主还没清身份），也把这条终端视作「正在内切成全新会话」，
  // 让兜底行立刻出现在目标目录组顶。
  function terminalRailPendingFreshArmed(session) {
    const pending = terminalRailSelectPending;
    return !!pending && pending.terminalId === session.id
      && !!pending.cwd && terminalRailSameDir(pending.cwd, session.cwd);
  }

  // 乐观选中收尾：令牌不匹配 no-op（迟到的旧切换清不掉新点击的高亮）；匹配则
  // 清 pending、清定时器、重渲栏。传 null＝无条件作废并推进 seq（用户改主意
  // 点了别的，在飞旧令牌同时失效）。
  function terminalRailEndSelect(token) {
    const pending = terminalRailSelectPending;
    const unconditional = token === null || token === undefined;
    if (!unconditional && (!pending || pending.token !== token)) return;
    if (pending && pending.timer !== null) clearTimeout(pending.timer);
    terminalRailSelectPending = null;
    if (unconditional) terminalRailSelectSeq += 1;
    renderTerminalRail();
  }

  function terminalRailActivateSession(id) {
    // 点它的会话栏行即读：done（跑完未读）标记当场清（聚焦清是每拍兜底，这里
    // 是点行这一拍的即时清——两路同一语义）。
    terminalDoneUnread.delete(id);
    // 改主意清点（M5）：无条件作废旧选中令牌再置活跃——activate 是 live 行快
    // 路径，置活跃即由 live 派生接管高亮；旧 pending 继续压着会把别的行说成选中。
    terminalRailEndSelect(null);
    if (!id || !terminalSessionFor(id) || id === activeTerminalPreviewId) return;
    activeTerminalPreviewId = id;
    rememberTerminalSessionId(id);
    renderTerminalPreviewSession({ deferScreen: true });
  }

  // 关闭走页签同一条处理：找到页签条里那颗 × 真点一下——运行中确认、POST、空壳计数、
  // 活跃 id 回落全部由那一处承担，不复制第二份。
  function terminalRailCloseSession(id) {
    const tabs = $("terminalTabs");
    if (!tabs || typeof tabs.querySelectorAll !== "function") return;
    for (const tab of tabs.querySelectorAll("[data-terminal-tab]")) {
      if (tab.getAttribute("data-terminal-tab") !== id) continue;
      const closeEl = typeof tab.querySelector === "function" ? tab.querySelector(".terminal-tab-close") : null;
      if (closeEl && typeof closeEl.click === "function") closeEl.click();
      return;
    }
  }

  // 新建终端：一键对当前 agent 建终端（cwd 沿用既有「记住上次」），无 agent 时建空白
  // 终端；就绪闸与页签栏加号同拍。有 agent 走与点历史行同一道内切判定门
  // （2026-10-25 用户拍板对齐超实例）：当前页签 idle/空白壳/exited 就地换新会话、
  // working/无从内切新开页签；一键启动同一通路（createAgentTerminal）仍是全部新开
  // 落点。空白终端不在矩阵内（不是 agent 会话），维持新开。
  function terminalRailCreateTerminal() {
    if (!terminalBackendReady) return;
    const cwd = terminalCwdInitial();
    rememberTerminalCwd(cwd);
    const agentId = terminalRailAgentId();
    if (agentId) {
      return terminalRailSwitchOrCreateCore({ agentId, cwd });
    }
    const size = terminalCreateSize();
    return api("POST", "/api/terminal/sessions", { label: "Anyswitch", cwd, shell: "powershell", cols: size.cols, rows: size.rows })
      .then((created) => {
        terminalBackendSessions[created.id] = terminalBackendSession(created);
        activeTerminalPreviewId = created.id;
        rememberTerminalSessionId(created.id);
        renderTerminalPreviewSession();
      })
      .catch((error) => toast(panelError(error, "无法新建终端"), true));
  }

  // 历史会话点击两分支：resumeCommand 非空 → 按 M3 契约带 resume 建会话（与一键启动
  // 同一条创建通路，续接失败的提示也由它统一落）；为空 → 只提示，不做复制命令。
  // 续接的 cwd 必须用会话自己的 project：claude 这类 agent 的存档按项目目录分，
  // 在别的目录下 --resume 找不到那条会话，还会触发不该有的目录信任提示。所以
  // project 拿不到（空/非字符串）时不发起请求——「记住上次」只属于全新终端。
  // 提示沿用批准清单里那句：缺路径与不可续接对用户是同一件事（现在没法接着这个
  // 会话），不为它新造文案。
  function terminalRailResumeSession(session) {
    if (!session) return;
    // 去重聚焦（M7 S5，用户选甲）：先查打开中的终端有没有同 endpoint＋同会话 id
    // 的——有就直接聚焦（terminalRailActivateSession 同路：置活跃、写存档、重渲），
    // 不再带 resume 新建。点已续接开的会话不该再开一条一模一样的新终端。
    // 覆盖率只保「续接创建的终端」：全新终端里聊出来的会话，宿主没记过它的对话
    // id（面板的绑定库在后端，没往前端曝），不在去重范围——要扩得先给绑定库开
    // 口子，那是另一条 mission 的事，不勉强。
    const open = terminalRailFindOpenSession(session.endpoint, session.id);
    if (open) {
      terminalRailActivateSession(open.id);
      return;
    }
    // 归档会话点不开（M8 T7a，dsh notifyArchivedNotOpenable 同口径）：恢复链是
    // 行内取消归档钮 + toast 撤销，续接要先取消归档。live 终端已开着的走上面聚焦，
    // 到这儿的就是没开着终端的归档行。
    if (terminalRailIsArchived(session)) {
      toast("这条会话已归档，取消归档后才能续接", true);
      return;
    }
    if (!session.resumeCommand) {
      toast("这个 Agent 的会话暂时不能在终端里续接", true);
      return;
    }
    const cwd = typeof session.project === "string" ? session.project.trim() : "";
    if (!cwd) {
      toast("这个 Agent 的会话暂时不能在终端里续接", true);
      return;
    }
    const resume = { endpoint: session.endpoint, id: session.id };
    if (typeof session.file === "string" && session.file) resume.file = session.file;
    // 乐观选中（M5）：过完全部拦截（去重命中/归档/不可续接/无 project）之后、
    // 调判定门之前点亮——点击当拍高亮成立，不等宿主侧 1~2s 的进程探测与 PTY 重启。
    // 在飞闸在 BeginSelect 内前置：在飞时不亮（亮也会被判定门吞掉，说谎比慢更糟）。
    terminalRailBeginSelect(session);
    return terminalRailSwitchOrCreate({ session, resume, cwd });
  }

  // M12-A 内切判定（规格矩阵）：点栏内历史会话、去重未命中后，对当前聚焦页签的
  // 会话 A 做判定——空白壳/idle/exited 就地换内容（宿主同记录 terminate+spawn+
  // 身份换绑，页签不新增，dsh 单槽 replaceMain 的我们侧同构）；working/补读失败
  // 走现状新开页签（保护在跑任务——dsh 被切走继续跑的我们侧等价物；宁多开勿错杀）。
  // 在飞闸（规格「偏离声明」）：dsh 是 last-wins 因换视图免费；我们要杀起进程、
  // 有秒级窗口，last-wins 要取消在飞 spawn，复杂度不值——一次内切（含补读）期间
  // 忽略栏内其他会话点击，记录在案。
  let terminalSwitchInFlight = false;
  // 判定门通用核：目标可以是某条历史会话（带 resume 身份）或一个全新会话
  // （resume 缺省＝全新目标，agentId 仍必须传给服务端）。「新建会话」与组头 ⊕
  // 两个入口同门（2026-10-25 用户拍板对齐）：
  // idle/空白壳/exited 就地换新会话、working 新开页签，与点历史行共用同一矩阵、
  // 同一在飞闸与降级路径）。新开的落点都是 createAgentTerminal（全新路径带
  // agentId＋cwd、不带 resume 键，服务端 /switch 据此走全新分支）。
  async function terminalRailSwitchOrCreateCore({ agentId, cwd, resume = null }) {
    if (terminalSwitchInFlight) return;
    const active = terminalSessionFor(activeTerminalPreviewId);
    // 无从内切：没有活跃页签、或活跃是设计稿预览会话（没有宿主记录可换）。
    if (!active || !active.backend) {
      return createAgentTerminal({ agentId, cwd, resume });
    }
    terminalSwitchInFlight = true;
    try {
      // 补读两拍（规格时序防线）：活跃面即时取（防 SSE 活跃流一拍延迟误杀在跑
      // 任务）＋宿主单读（PTY 现态，顺带确认记录还在）。任一失败降级新开。
      let agents = null;
      let hostRead = null;
      try {
        agents = await api("GET", "/api/agents");
        hostRead = await api("GET", `/api/terminal/sessions/${encodeURIComponent(active.id)}`);
      } catch {
        return createAgentTerminal({ agentId, cwd, resume });
      }
      if (!agents || !Array.isArray(agents.agents) || !hostRead || !hostRead.id) {
        return createAgentTerminal({ agentId, cwd, resume });
      }
      enrichTerminalSessions(agents.agents);
      // 已退出不是 working：迟到的请求/输出信号不能把它重新判忙，否则切走会
      // 错走保护性新开（原页签的新会话行也随之残留）。宿主现态优先于缓存信号。
      const exited = hostRead.status === "exited" || active.backendState?.status === "exited";
      const working = !exited && (active.status === "working" || (active.metrics && active.metrics.activeRequests > 0));
      if (working) return createAgentTerminal({ agentId, cwd, resume });
      // 全新内切乐观选中（M5 补口）：没有历史身份可亮，activeTerminalPreviewId 又不
      // 换（同记录换内容）——不武装的话，高亮要等 POST 返回、spawnedAt 刷新、兜底行
      // 出现才挪过去（实测小半秒）。确定要内切（过了 working 门）后、POST 之前点亮：
      // 兜底行当拍出现在目标目录组顶。working/无从内切落点都是别的页签，不许亮本页
      // 签——武装点必须在这两个 return 之后。
      if (!resume) terminalRailArmSelect({ endpoint: agentId, terminalId: active.id, cwd });
      // 内切：宿主同记录 terminate+spawn+身份换绑；响应快照换写本页签记录。
      const switched = await api("POST", `/api/terminal/sessions/${encodeURIComponent(active.id)}/switch`, resume ? { resume, cwd } : { agentId, cwd });
      terminalBackendSessions[active.id] = terminalBackendSession(switched);
      renderTerminalPreviewSession();
    } catch (error) {
      // 失败不删本地状态、维持现状、不静默吞（× 路径 catch(()=>{}) 的教训）：
      // 本地记录原样，页签还是原来那条，只给一句提示。
      const code = error && (error.serverCode || error.code);
      if (code === "switch_busy") {
        // 服务端杀前复核拒换（会话树里有活着的命令进程）：静默转新开保护。新开
        // 本就是点击历史会话的合法落点之一，这里再提示反而是噪声；原页签不动，
        // 在跑的命令继续。
        // 失败清点不含这条（M5 原口径）：续接内切点亮的是历史行，转新开后那枚
        // 高亮仍兑现（新页签会亮），此处清会让高亮先弹回旧行再亮新行。全新内切
        // 不同——兜底行锚在**本页签**上，转新开后本页签没换内容，留着它就是说
        // 这条页签换了会话，必须显式撤；新页签自己的兜底行由新建链路自然带出。
        if (!resume) terminalRailEndSelect(null);
        return createAgentTerminal({ agentId, cwd, resume });
      }
      // 失败清点（M5）：这一拍点击被宿主判死——撤乐观高亮，点亮的行没换成，
      // 继续说它选中就是说谎。不放 finally 清：working 转新开等落点经 finally
      // 会让高亮弹回旧行。
      terminalRailEndSelect(null);
      if (typeof code === "string" && code.startsWith("resume-")) {
        toast("这个 Agent 的会话暂时不能在终端里续接", true);
        return;
      }
      toast(panelError(error, "无法启动这个终端"), true);
    } finally {
      terminalSwitchInFlight = false;
    }
  }

  async function terminalRailSwitchOrCreate({ session, resume, cwd }) {
    return terminalRailSwitchOrCreateCore({ agentId: session.endpoint, cwd, resume });
  }

  function terminalRailResumeHistoryRow(id) {
    const session = terminalRailHistory.sessions.find((row) => row && row.id === id);
    if (session) terminalRailResumeSession(session);
  }

  // 打开中的终端里找「替这条会话续接建的那个」：resume 身份两键（endpoint＋会话
  // id）都对上才算。同会话 id 在不同端点的存档里是不同对话，单键会误聚焦。
  function terminalRailFindOpenSession(endpoint, id) {
    if (!endpoint || !id) return null;
    for (const session of Object.values(terminalRailSessionMap())) {
      if (!session || !session.resume) continue;
      if (session.resume.endpoint === endpoint && session.resume.id === id) return session;
    }
    return null;
  }

  // 归档（dsh §1.4 / m6b §A）：持久化标记 + 视图过滤，磁盘会话文件一概不动；
  // 平静会话单击即归档，无确认。本地先生效再落盘——POST 是本机回环，等它往返再
  // 动列表会出现「点了没反应」的半个节拍；落盘失败回退本地态并提示，不假装成功
  // （刷新回来还在，比假成功更难理解）。归档与续接无关：不可续接的会话照样可归档；
  // 打开中的终端在另一段，不受影响。动效（M13）走 AnimatedRows 同款：行克隆淡出、
  // 下方行上移、隐藏池回填行淡入（terminalRailRerenderExitFlip）。恢复入口三件：
  // toast「撤销」＋行内取消归档钮＋段头「视图选项」筛选（m6b §A2 三入口齐备）。
  function terminalRailArchiveSession(id) {
    const session = terminalRailHistory.sessions.find((row) => row && row.id === id);
    if (!session) return;
    const entry = { endpoint: session.endpoint, id: session.id };
    const key = terminalRailArchivedKey(session);
    if (!key) return;
    if (terminalRailPrefs.archived.some((row) => terminalRailArchivedKey(row) === key)) return;
    terminalRailPrefs.archived.push(entry);
    terminalRailRerenderExitFlip();
    api("POST", "/api/terminal/rail/archive", entry)
      .then(() => {
        // 6s 撤销窗（dsh holdMs 同值）：tone 走成功（不传 isErr），撤销＝取消归档；
        // 当前筛选＝隐藏已归档时追加筛选引导钮（dsh ArchiveToastEntry 的条件性第二
        // 动作），点了切到「仅显示已归档」看归档去向。
        toast("会话已归档。", false, {
          durationMs: 6000,
          actions: [
            { label: "撤销", onClick: () => terminalRailUnarchiveSession(entry.endpoint, entry.id) },
            ...(terminalRailViewPrefs.archivedFilter === "default"
              ? [{ label: "筛选已归档会话", onClick: () => applyTerminalRailViewChoice("archivedFilter", "only") }]
              : []),
          ],
        });
      })
      .catch((error) => {
        terminalRailPrefs.archived = terminalRailPrefs.archived.filter((row) => terminalRailArchivedKey(row) !== key);
        renderTerminalRailHistory(terminalRailAgentId());
        toast(panelError(error, "归档未能保存，请重试"), true);
      });
  }

  // 取消归档：从清单移除即回到原分组原位置——底层列表从没被改动，组内按最近活跃
  // 的排序天然还原（dsh 的 sessionIds 槽位保留是同一种思路）。无 toast（m6b §A6
  // 实测口径：unarchive 成功路径从不 notify）；落盘失败回退并提示。动效（M13）＝
  // 归档的镜像：行淡入回槽、下方行落回、水位线让位的回填行克隆淡出。
  function terminalRailUnarchiveSession(endpoint, id) {
    const key = `${endpoint}\u0000${id}`;
    if (!terminalRailPrefs.archived.some((row) => `${row.endpoint}\u0000${row.id}` === key)) return;
    terminalRailPrefs.archived = terminalRailPrefs.archived.filter((row) => `${row.endpoint}\u0000${row.id}` !== key);
    terminalRailRerenderExitFlip();
    api("POST", "/api/terminal/rail/unarchive", { endpoint, id })
      .catch((error) => {
        terminalRailPrefs.archived.push({ endpoint, id });
        renderTerminalRailHistory(terminalRailAgentId());
        toast(panelError(error, "取消归档未能保存，请重试"), true);
      });
  }

  function toggleTerminalRailGroup(key) {
    const stateKey = terminalRailNormDir(key);
    if (terminalRailCollapsedGroups.has(stateKey)) terminalRailCollapsedGroups.delete(stateKey);
    else terminalRailCollapsedGroups.add(stateKey);
    saveTerminalRailCollapsedGroups();
    terminalRailFlipMode = "flip";
    renderTerminalRailHistory(terminalRailAgentId());
  }

  // ⊕ 新建（dsh B1 的 onCreate）：先展开该组（若收起），再以该组目录为 cwd 给当前
  // agent 建终端。历史会话段只在有 agent 聚焦时才有内容——组头天然带着 agentId
  // （terminalRailAgentId），不写无 agent 分支：没有 agent 时列表为空、组头不存在，
  // ⊕ 根本不会露面。就绪闸与页签栏加号同拍。与「新建会话」同门（2026-10-25 用户
  // 拍板对齐超实例）：idle/空白壳/exited 就地换新会话、working/无从内切新开页签，
  // cwd 用组目录。
  function terminalRailCreateTerminalInDir(key) {
    if (!terminalBackendReady || !key) return;
    if (terminalRailCollapsedGroups.delete(terminalRailNormDir(key))) {
      saveTerminalRailCollapsedGroups();
      terminalRailFlipMode = "flip";
      renderTerminalRailHistory(terminalRailAgentId());
    }
    return terminalRailSwitchOrCreateCore({ agentId: terminalRailAgentId(), cwd: key });
  }

  // ── 组头 hover 卡（M7 S3，dsh B4） ──
  // 800ms 延迟（dsh 同值）；三行＝目录短名／完整路径／「N 个会话」；整卡可点，
  // 点击复制完整路径并短暂显示「已复制」（复用既有 sessCopyText 复制反馈手法）。
  // 挂 body 下 position:fixed（dsh 同款 portal——栏体 overflow-x:hidden 会切掉贴
  // 右缘展开的卡）。⋯ 菜单打开期间抑制（dsh 的 disabled: menuOpen 同口径）。
  const TERMINAL_RAIL_HOVER_DELAY_MS = 800;
  let terminalRailHoverTimer = null;
  let terminalRailHoverEl = null;
  let terminalRailHoverHead = null;

  function closeTerminalRailHoverCard() {
    if (terminalRailHoverTimer) { clearTimeout(terminalRailHoverTimer); terminalRailHoverTimer = null; }
    if (terminalRailHoverEl && typeof terminalRailHoverEl.remove === "function") terminalRailHoverEl.remove();
    terminalRailHoverEl = null;
    terminalRailHoverHead = null;
  }

  // 组键从 toggle 钮上读（不拼选择器：组键是 Windows 路径）。空键 = 未分组，
  // 不出卡（dsh 同口径：未分组组没有 hover 卡）。
  function terminalRailHeadKey(head) {
    if (!head || typeof head.querySelector !== "function") return "";
    const toggle = head.querySelector("[data-rail-term-group]");
    return toggle ? toggle.getAttribute("data-rail-term-group") || "" : "";
  }

  function scheduleTerminalRailHoverCard(head, key) {
    closeTerminalRailHoverCard();
    // 菜单开着不排卡：菜单自己就是悬停出来的浮层，两张卡叠着是噪声
    if (!head || !key || terminalRailMenuKey) return;
    terminalRailHoverHead = head;
    terminalRailHoverTimer = setTimeout(() => {
      terminalRailHoverTimer = null;
      showTerminalRailHoverCard(head, key);
    }, TERMINAL_RAIL_HOVER_DELAY_MS);
  }

  function showTerminalRailHoverCard(head, key) {
    if (!head || typeof head.getBoundingClientRect !== "function") return;
    const group = terminalRailLastGroups.find((row) => row.key && terminalRailSameDir(row.key, key));
    // 计数＝组里看得见的行数（真实历史行 + 兜底「新会话」行）
    const count = group ? group.rows.length + ((group.pending && group.pending.length) || 0) : 0;
    const card = document.createElement("div");
    card.className = "rail-term-hover-card";
    const name = document.createElement("div");
    name.className = "rail-term-hover-name";
    name.textContent = sessDirName(key);
    const path = document.createElement("div");
    path.className = "rail-term-hover-path";
    path.textContent = key;
    const countLine = document.createElement("div");
    countLine.className = "rail-term-hover-count";
    countLine.textContent = `${count} 个会话`;
    card.append(name, path, countLine);
    // 整卡可点：复制完整路径，「已复制」的短暂反馈由 sessCopyText 的 toast 承担
    card.onclick = () => sessCopyText(key, "已复制");
    document.body.append(card);
    const rect = head.getBoundingClientRect();
    const width = card.offsetWidth || 220;
    card.style.top = `${Math.max(8, rect.bottom + 4)}px`;
    card.style.left = `${Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8))}px`;
    terminalRailHoverEl = card;
    // 指针从组头直接挪进卡里：卡接着活（不然刚出现就没了，根本点不到）
    card.addEventListener("pointerout", (event) => {
      const to = event.relatedTarget;
      if (to && typeof to.closest === "function" && to.closest(".rail-term-group-head")) return;
      closeTerminalRailHoverCard();
    });
  }

  // ── 组头 ⋯ 菜单（M7 S2/S3） ──
  // 栏内单例：同一时刻只开一个，换目标即换主。容器做成可扩的——M8 往段头「视图
  // 选项」加项时若还要组级菜单，只在这里 append，不开第二套浮层。挂在栏体下而
  // 不在列表里：列表整体 innerHTML 重渲（1s 轮询每拍都可能），挂进去会被抹掉。
  let terminalRailMenuKey = "";
  let terminalRailMenuEl = null;

  function closeTerminalRailGroupMenu() {
    if (terminalRailMenuEl && typeof terminalRailMenuEl.remove === "function") terminalRailMenuEl.remove();
    terminalRailMenuEl = null;
    terminalRailMenuKey = "";
  }

  // 组头元素查找：按 data 属性逐个比（组键是 Windows 路径，直接拼选择器会被反
  // 斜杠/引号咬，不干）。
  function terminalRailGroupHeadEl(key) {
    const list = $("railTermHistoryList");
    if (!list || typeof list.querySelectorAll !== "function") return null;
    for (const head of list.querySelectorAll("[data-rail-term-group]")) {
      if (head.getAttribute("data-rail-term-group") === key) return head;
    }
    return null;
  }

  function openTerminalRailGroupMenu(key) {
    const dir = $("railTerminalDir");
    if (!dir || !key) { closeTerminalRailGroupMenu(); return; }
    const head = terminalRailGroupHeadEl(key);
    if (!head) { closeTerminalRailGroupMenu(); return; }
    closeTerminalRailGroupMenu();
    closeTerminalRailHoverCard(); // 菜单后开：悬停卡让位（dsh 的 menuOpen 抑制同口径）
    terminalRailMenuKey = key;
    const menu = document.createElement("div");
    menu.className = "rail-term-menu";
    const item = document.createElement("button");
    item.type = "button";
    item.className = "rail-term-menu-item is-danger";
    item.setAttribute("data-rail-term-remove-group", key);
    item.textContent = "移除分组";
    menu.append(item);
    // M9-D1：portal 到 body 下 position:fixed——栏体 overflow:hidden 会裁掉栏内
    // 浮层（dsh 的 portal:true 同款）。坐标直接按视口 rect 算，不再换算到栏体。
    document.body.append(menu);
    const headRect = head.getBoundingClientRect();
    const width = menu.offsetWidth || 120;
    menu.style.top = `${Math.max(8, headRect.bottom + 4)}px`;
    menu.style.left = `${Math.max(8, Math.min(headRect.right - width, window.innerWidth - width - 8))}px`;
    // 栏体滚动会带偏菜单（它不再跟着内容走），挂个一次性 capture scroll 监听跟着关
    dir.addEventListener("scroll", closeTerminalRailGroupMenu, { capture: true, once: true });
    terminalRailMenuEl = menu;
  }

  function toggleTerminalRailGroupMenu(key) {
    if (terminalRailMenuKey === key) closeTerminalRailGroupMenu();
    else openTerminalRailGroupMenu(key);
  }

  // 分组移除（dsh §2 / m6 §2）：红色确认弹窗（复用共用确认件），只从清单移除，
  // 磁盘文件夹与会话记录不动，会话落「未分组」。
  function terminalRailRemoveGroup(key) {
    // 先收场组头菜单再开弹窗（M10-F2）：菜单 z-index 1200 高于弹窗 overlay 300，
    // 不收场会滞留 DOM 压住弹窗（窄窗/靠中组头下尤其明显）。
    closeTerminalRailGroupMenu();
    showSkillsModal({
      title: "移除分组",
      bodyHtml: `把“${escapeHtml(sessDirName(key))}”从会话栏移除。文件夹和会话记录都会保留，里面的会话会显示在“未分组”下。`,
      confirmText: "移除分组",
      danger: true,
      onConfirm: () => terminalRailCommitRemoveGroup(key),
    });
  }

  // 确认后执行：本地先生效再落盘（与归档同一拍节——POST 是本机回环，等它往返
  // 再动列表会出现「点了没反应」的半个节拍）；失败回退并提示。已经移除过的目录
  // 幂等跳过（用户连点两次菜单不该发两次请求）。
  function terminalRailCommitRemoveGroup(key) {
    if (terminalRailPrefs.removedGroups.some((dir) => terminalRailSameDir(dir, key))) return;
    terminalRailPrefs.removedGroups.push(key);
    // 记移除时刻（M14 自愈的判据）：该目录此后新到的会话会把组重新放出来。
    // 顺手清掉自愈失败标记：用户重新移除＝重新起算，上一轮落盘失败不该压死这一轮。
    terminalRailRemovedAt[terminalRailNormDir(key)] = Date.now();
    terminalRailSelfHealFailed.delete(terminalRailNormDir(key));
    saveTerminalRailRemovedAt();
    // 组都移除了，折叠存档里对应的键一并清掉（自愈回来时按默认展开）。
    if (terminalRailCollapsedGroups.delete(terminalRailNormDir(key))) saveTerminalRailCollapsedGroups();
    closeTerminalRailGroupMenu();
    terminalRailFlipMode = "instant"; // 移除是 resetKey：瞬时重排，不播 FLIP
    renderTerminalRailHistory(terminalRailAgentId());
    api("POST", "/api/terminal/rail/remove-group", { dir: key })
      .catch((error) => {
        terminalRailPrefs.removedGroups = terminalRailPrefs.removedGroups.filter((dir) => !terminalRailSameDir(dir, key));
        delete terminalRailRemovedAt[terminalRailNormDir(key)];
        saveTerminalRailRemovedAt();
        renderTerminalRailHistory(terminalRailAgentId());
        toast(panelError(error, "分组移除未能保存，请重试"), true);
      });
  }

  function toggleTerminalRailWatermark(key) {
    const group = terminalRailGroupSessions(terminalRailHistory.sessions).find((row) => row.key === key);
    if (!group) return;
    const next = terminalRailNextWatermark(group.rows.length, terminalRailWatermarks.get(key));
    if (next === TERMINAL_RAIL_WATERMARK) terminalRailWatermarks.delete(key);
    else terminalRailWatermarks.set(key, next);
    terminalRailFlipMode = "instant"; // 水位线增减是 resetKey：瞬时跳变（dsh 实测）
    renderTerminalRailHistory(terminalRailAgentId());
  }

  // 进终端视图：历史会话**不再**在这里抛掉重取。视图内的其他渲染都不触发扫盘；
  // 水位线随列表卸载即重置（dsh 实测同口径：水位不持久化，分组树卸载即丢），组折叠态
  // 落 localStorage、跨视图进出与页面重载保持（用户手动收起的组不该每次进来都弹开）。
  // 视图状态（归档/已移除分组）同样在这里拉一次——落盘在面板侧，与 terminal-host
  // 就绪与否无关。
  //
  // 缓存留着的三个理由：①进页首帧左栏就有内容（原写法是先清空再等扫描）；②本页
  // 已经拉过的那份没有理由因为「用户切出去又切回来」再赌一次网络；③这条请求排在
  // 进页这一拍上，就必然抢在终端画面之前（S2 场景②：进页扫描在飞期间整块面板停摆）。
  // 过期（TTL）由 scheduleTerminalRailHistoryFetch 在首帧之后补拉。
  function enterTerminalRail() {
    terminalRailRendered = { history: null };
    terminalRailWatermarks.clear();
    terminalRailAutoExpandedFor = "";
    terminalRailScrolledFor = "";
    terminalRailFlipMode = "instant";
    // 进视图＝ fresh  entry：搜索态重置（展开态/查询都不跨进出保留）
    closeTerminalRailSearch();
    loadTerminalRailRemovedAt();
    loadTerminalRailPrefs();
    renderTerminalRail();
    scheduleTerminalRailHistoryFetch();
  }

  // 视图状态全量拉取（GET /panel/api/terminal/rail/prefs）。失败按空表处理：最坏
  // 回到「没归档过/没移除过」，不挡栏体渲染；随后动作若也落盘失败，走动作自己的
  // 错误提示。落地后补渲一帧——过滤要等这份清单真回来才生效。
  function loadTerminalRailPrefs() {
    return api("GET", "/api/terminal/rail/prefs")
      .then((data) => {
        terminalRailPrefs = {
          archived: Array.isArray(data && data.archived) ? data.archived : [],
          removedGroups: Array.isArray(data && data.removedGroups) ? data.removedGroups : [],
        };
        // M14 自愈的时间轴补齐：盘上有清单条目、本地却没有移除时刻的（M14 之前
        // 落盘的老数据，或换了浏览器 profile），按「此刻」记一笔——此后该目录再来的
        // 会话才算新的。不补的话这些条目永远不自愈，而恢复区已经砍掉了。
        const now = Date.now();
        let touched = false;
        for (const dir of terminalRailPrefs.removedGroups) {
          const key = terminalRailNormDir(dir);
          if (!key || terminalRailRemovedAt[key]) continue;
          terminalRailRemovedAt[key] = now;
          touched = true;
        }
        if (touched) saveTerminalRailRemovedAt();
      })
      .catch(() => {})
      .finally(() => {
        if (currentView === "terminal") renderTerminalRailHistory(terminalRailAgentId());
      });
  }

  // 滚动条指针感知的自动隐退（dsh §3.5）：指针在列内 thumb 可见，离开 2s 后隐退
  // ——变量替换瞬时消失，无淡出（写了 transition 就错）。挂栏体（#v2Rail）而不是
  // 滚动层：整列都算「在列内」，指针挪到底栏那排钮时 thumb 照旧可见。初态即隐退：
  // 进终端视图时指针多半不在列内，不先隐就会常亮一条thumb。
  const TERMINAL_RAIL_SCROLLBAR_LINGER_MS = 2000;
  let terminalRailQuietTimer = null;
  function setTerminalRailQuiet(quiet) {
    const dir = $("railTerminalDir");
    if (dir && typeof dir.toggleAttribute === "function") dir.toggleAttribute("data-quiet", !!quiet);
  }

  function initTerminalRailScrollbarQuiet() {
    const rail = $("v2Rail");
    if (!rail || typeof rail.addEventListener !== "function") return;
    setTerminalRailQuiet(true);
    rail.addEventListener("pointerenter", () => {
      if (terminalRailQuietTimer) { clearTimeout(terminalRailQuietTimer); terminalRailQuietTimer = null; }
      setTerminalRailQuiet(false);
    });
    rail.addEventListener("pointerleave", () => {
      if (terminalRailQuietTimer) clearTimeout(terminalRailQuietTimer);
      terminalRailQuietTimer = setTimeout(() => {
        terminalRailQuietTimer = null;
        setTerminalRailQuiet(true);
      }, TERMINAL_RAIL_SCROLLBAR_LINGER_MS);
    });
  }

  function initTerminalRail() {
    const dir = $("railTerminalDir");
    if (!dir) return;
    loadTerminalRailViewPrefs(); // 视图偏好先进状态再首渲（localStorage 读回）
    loadTerminalRailCollapsedGroups(); // 组折叠态同层读回：首帧就是存档形态，不先全展开再跳
    initTerminalRailScrollbarQuiet();
    // 首次真实指针/键盘交互才武装 FLIP（dsh AnimatedRows 的 armed 门，M13 走捕获相）：
    // 合成点击（element.click()）不派发 pointerdown——进页首帧、自动化测量都瞬时
    // 落位。监听挂整个会话栏而非仅历史列表：新建按钮也在列内，它的首次点击同样
    // 会让兜底行出现，不能等到下一次操作才有动画。
    const armMotion = () => { terminalRailMotionArmed = true; };
    dir.addEventListener("pointerdown", armMotion, { once: true, capture: true });
    dir.addEventListener("keydown", armMotion, { once: true, capture: true });
    // 一处委托：关闭叉 / 历史行归档 / 取消归档 / 组头菜单 / 组头新建 / 空态复位 /
    // 切换终端 / 历史行续接 / 组折叠 / 水位线。关闭叉、归档与取消归档钮先判，否则会
    // 被行点击抢走；组头 ⋯ 与 ⊕ 要抢在「历史行续接」与「组折叠」之前——它们同在
    // 那一片区域里，判序错了点⋯ 就会折叠组、点⊕ 就会折叠组。
    dir.addEventListener("click", (event) => {
      const target = event.target;
      if (!target || typeof target.closest !== "function") return;
      const close = target.closest("[data-rail-term-close]");
      if (close) {
        terminalRailCloseSession(close.getAttribute("data-rail-term-close"));
        return;
      }
      const archive = target.closest("[data-rail-term-archive]");
      if (archive) {
        terminalRailArchiveSession(archive.getAttribute("data-rail-term-archive"));
        return;
      }
      // 取消归档钮（M8 T7a，m6b §A2 第三恢复入口）：必须排在行点击（resume）分支
      // 之前——钮是行按钮的子元素，排在后面会被行点击整个抢走（断链：点了没反应）。
      // 无 toast（m6b §A6：取消归档成功路径从不 notify）。
      const unarchive = target.closest("[data-rail-term-unarchive]");
      if (unarchive) {
        const id = unarchive.getAttribute("data-rail-term-unarchive");
        const session = terminalRailHistory.sessions.find((row) => row && row.id === id);
        if (session) terminalRailUnarchiveSession(session.endpoint, session.id);
        return;
      }
      const menuBtn = target.closest("[data-rail-term-group-menu]");
      if (menuBtn) {
        toggleTerminalRailGroupMenu(menuBtn.getAttribute("data-rail-term-group-menu"));
        return;
      }
      const newBtn = target.closest("[data-rail-term-group-new]");
      if (newBtn) {
        terminalRailCreateTerminalInDir(newBtn.getAttribute("data-rail-term-group-new"));
        return;
      }
      // 注：⋯ 菜单项（data-rail-term-remove-group）与视图选项菜单项
      // （data-rail-term-view）不在本委托里——两个菜单已 portal 到 body（M9-D1），
      // 不是 #railTerminalDir 后代，它们的处理入口在 document 级委托（见
      // initTerminalRail 尾部，先判菜单项后走收场）。
      // 「仅显示已归档」空态动作（在树内，留在本委托）：切回「隐藏已归档」
      const viewReset = target.closest("[data-rail-term-view-reset]");
      if (viewReset) {
        applyTerminalRailViewChoice("archivedFilter", "default");
        return;
      }
      const sessionRow = target.closest("[data-rail-term-session]");
      if (sessionRow) {
        terminalRailActivateSession(sessionRow.getAttribute("data-rail-term-session"));
        return;
      }
      const resumeRow = target.closest("[data-rail-term-resume]");
      if (resumeRow) {
        // live 行点击＝聚焦其终端（M8 T2）；非 live 行才走去重/续接两分支
        const liveId = resumeRow.getAttribute("data-rail-term-live");
        if (liveId) {
          terminalRailActivateSession(liveId);
          if (terminalRailSearch.open) closeTerminalRailSearch(); // 点开结果行＝清空＋收起
          return;
        }
        terminalRailResumeHistoryRow(resumeRow.getAttribute("data-rail-term-resume"));
        if (terminalRailSearch.open) closeTerminalRailSearch();
        return;
      }
      const groupHead = target.closest("[data-rail-term-group]");
      if (groupHead) {
        toggleTerminalRailGroup(groupHead.getAttribute("data-rail-term-group"));
        return;
      }
      const more = target.closest("[data-rail-term-more]");
      if (more) toggleTerminalRailWatermark(more.getAttribute("data-rail-term-more"));
    });
    $("railTermNewBtn").onclick = () => terminalRailCreateTerminal();
    // 段头搜索（M8 T7a）：钮＝展开/重新聚焦（非 toggle）；输入＝防抖 250ms；清空钮
    // 与 Esc＝清空＋收起。外点收起逻辑挂在下面的 document 委托里（仅空查询）。
    const searchBtn = $("railTermSearchBtn");
    const searchInput = $("railTermSearchInput");
    const searchClear = $("railTermSearchClear");
    if (searchBtn) {
      searchBtn.addEventListener("click", (event) => {
        if (event && typeof event.stopPropagation === "function") event.stopPropagation();
        if (terminalRailSearch.open) {
          if (searchInput && typeof searchInput.focus === "function") searchInput.focus();
          return; // 已展开再点＝重新聚焦，不退出（m6c 实测#32）
        }
        openTerminalRailSearch();
      });
    }
    if (searchInput) {
      searchInput.addEventListener("input", onTerminalRailSearchInput);
      searchInput.addEventListener("keydown", (event) => {
        if (event && event.key === "Escape") closeTerminalRailSearch();
      });
    }
    if (searchClear) {
      searchClear.addEventListener("click", (event) => {
        if (event && typeof event.stopPropagation === "function") event.stopPropagation();
        closeTerminalRailSearch();
      });
    }
    // 视图选项钮（M8 T7b）：菜单开关
    const viewBtn = $("railTermViewOptionsBtn");
    if (viewBtn) {
      viewBtn.addEventListener("click", (event) => {
        if (event && typeof event.stopPropagation === "function") event.stopPropagation();
        if (terminalRailViewMenuEl) closeTerminalRailViewMenu();
        else openTerminalRailViewMenu();
      });
    }
    // 会话行拖拽（M8 T7b，手序的唯一来源）：draggable 只在非归档行上；同列表内
    // 移动（dsh 只允许同父级兄弟，我们的组/平铺都是一个父）。落点＝目标行之前。
    let railDragId = "";
    dir.addEventListener("dragstart", (event) => {
      const row = event.target && typeof event.target.closest === "function"
        ? event.target.closest('[data-rail-term-resume][draggable="true"]')
        : null;
      if (!row) return;
      railDragId = row.getAttribute("data-rail-term-resume") || "";
      if (event.dataTransfer && typeof event.dataTransfer.setData === "function") {
        event.dataTransfer.setData("text/plain", railDragId);
      }
      if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
    });
    dir.addEventListener("dragover", (event) => {
      const row = event.target && typeof event.target.closest === "function"
        ? event.target.closest('[data-rail-term-resume][draggable="true"]')
        : null;
      if (!row || !railDragId) return;
      event.preventDefault(); // 允许落在非归档行上
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    });
    dir.addEventListener("drop", (event) => {
      const row = event.target && typeof event.target.closest === "function"
        ? event.target.closest('[data-rail-term-resume][draggable="true"]')
        : null;
      if (!row || !railDragId) return;
      event.preventDefault();
      const toId = row.getAttribute("data-rail-term-resume") || "";
      terminalRailMoveInManualOrder(terminalRailAgentId(), railDragId, toId);
      railDragId = "";
      terminalRailFlipMode = "instant"; // 拖拽落位是 resetKey：瞬时跳变
      renderTerminalRailHistory(terminalRailAgentId());
    });
    dir.addEventListener("dragend", () => { railDragId = ""; });
    // 栏底「返回」一颗钮两态共用（设置态与终端态互斥）：终端态回进入终端前的视图，
    // 设置态仍由 initSettingsView 绑的 exitSettings 承担。
    const back = $("railBackBtn");
    if (back) {
      back.onclick = () => (document.body.classList.contains("terminal-mode") ? closeTerminalPreview() : switchView(settingsReturnView));
    }
    // 组头 hover 卡：指针进组头排 800ms 卡，出组头（且没进卡里）收卡。同一组头内
    // 的子元素掠过连发 pointerover，用 terminalRailHoverHead 去重（不重新排计时）。
    dir.addEventListener("pointerover", (event) => {
      const target = event.target;
      if (!target || typeof target.closest !== "function") return;
      const head = target.closest(".rail-term-group-head");
      if (!head) return;
      if (terminalRailHoverHead === head) return;
      terminalRailHoverHead = head;
      scheduleTerminalRailHoverCard(head, terminalRailHeadKey(head));
    });
    dir.addEventListener("pointerout", (event) => {
      const target = event.target;
      if (!target || typeof target.closest !== "function") return;
      const head = target.closest(".rail-term-group-head");
      if (!head) return;
      const to = event.relatedTarget;
      // 还在同一组头内（含挪进卡里——卡有自己的 pointerout 收场）：不动
      if (to && typeof to.closest === "function") {
        if (to.closest(".rail-term-group-head") === head) return;
        if (terminalRailHoverEl && terminalRailHoverEl.contains(to)) return;
      }
      terminalRailHoverHead = null;
      closeTerminalRailHoverCard();
    });
    // 组头 ⋯ 菜单的兜底收场：点菜单外（委托分支已判的 ⋯ 钮与菜单项除外）与 Esc。
    // document 级监听在委托之后触发（冒泡从内到外），分工不冲突。
    document.addEventListener("click", (event) => {
      const target = event.target;
      const hasClosest = !!(target && typeof target.closest === "function");
      // 菜单项分支（M9 复审必修 1）：两个菜单 portal 到 body 后不是 #railTerminalDir
      // 后代，dir 委托接不到——菜单项的唯一处理入口搬到这里，**先判菜单项、后走
      // 下面的收场逻辑**（点选即关由 applyTerminalRailViewChoice 自己承担）。
      if (hasClosest) {
        const viewItem = target.closest("[data-rail-term-view]");
        if (viewItem) {
          const [field, value] = (viewItem.getAttribute("data-rail-term-view") || "").split(":");
          applyTerminalRailViewChoice(field, value);
          return;
        }
        const removeItem = target.closest("[data-rail-term-remove-group]");
        if (removeItem) {
          // 移除分组必须走带确认弹窗的入口（M7 复审必修 1 钉住的链：直接调 commit
          // 版会把红色确认弹窗整个绕过）。
          terminalRailRemoveGroup(removeItem.getAttribute("data-rail-term-remove-group"));
          return;
        }
      }
      if (terminalRailMenuEl) {
        if (!terminalRailMenuEl.contains(target)) {
          if (!(hasClosest && target.closest("[data-rail-term-group-menu]"))) {
            closeTerminalRailGroupMenu();
          }
        }
      }
      // 视图选项菜单兜底：点菜单外即关（点选分支在上面已关）
      if (terminalRailViewMenuEl) {
        if (!terminalRailViewMenuEl.contains(target)) {
          if (!(hasClosest && target.closest("#railTermViewOptionsBtn"))) {
            closeTerminalRailViewMenu();
          }
        }
      }
      // 搜索外点：仅当查询为空才收起（有查询只失焦、保持展开，m6c §A6）
      if (terminalRailSearch.open) {
        const head = $("railTermSectionHead");
        if (!head || !head.contains(target)) {
          if (!terminalRailSearch.query.trim()) closeTerminalRailSearch();
        }
      }
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        closeTerminalRailGroupMenu();
        closeTerminalRailViewMenu();
        if (terminalRailSearch.open) closeTerminalRailSearch();
      }
    });
  }

  function initSkillsTab() {
    $("tabBoard").onclick = () => switchView("board");
    $("tabSkills").onclick = () => switchView("skills");
    // 新版左栏 tab：与头行走同一条 switchView 路径；激活态镜像在 switchView 内同步
    for (const [railId, view] of [["railTabBoard", "board"], ["railTabSkills", "skills"], ["railTabPresets", "presets"], ["railTabSessions", "sessions"], ["railTabStore", "store"], ["railTabStats", "stats"]]) {
      const railTab = $(railId);
      if (railTab) railTab.onclick = () => switchView(view);
    }
    // 「终端」tab 与看板「虚拟终端」入口卡同一条链（openTerminalPreview：记忆返回视图
    // 与滚动位后进终端页），不另写一套
    const railTerminalTab = $("railTabTerminal");
    if (railTerminalTab) railTerminalTab.onclick = () => openTerminalPreview();
    $("skillsPickRepoBtn").onclick = pickSkillsRepo;
    $("skillsImportBtn").onclick = () => importSkillViaPicker("skillsImportBtn", "/api/skills/repo/import-pick");
    $("skillsImportZipBtn").onclick = () => importSkillViaPicker("skillsImportZipBtn", "/api/skills/repo/import-pick-zip");
    $("skillsRefreshBtn").onclick = runSkillsRefreshWithFeedback;
    // 卡片 D：整卡折叠钮（默认收起，点一下展开；展开态跨刷新记住）
    $("skillsAnomalyFold").onclick = toggleAnomalyCardFold;
    applyAnomalyCardFold();
    // 卡片 B：过滤 + 主从列表选中
    $("skillsFilterInput").oninput = (e) => {
      skillsFilter = e.target.value.trim().toLowerCase();
      renderSkillsList();
    };
    $("skillsList").addEventListener("click", (e) => {
      const row = e.target.closest("[data-skill]");
      if (!row) {
        // 资源管理器惯例：左键点列表空白处清空选中与焦点
        if (skillsSelection.size) {
          skillsSelection.clear();
          skillsFocusKey = null;
          renderSkillsList();
          renderSkillDetail();
        }
        return;
      }
      const key = row.getAttribute("data-skill");
      if (e.ctrlKey || e.metaKey) {
        // Ctrl+左键：切换成员资格；加入时焦点跟随，移除焦点行则回退到集合剩余最后一员
        if (skillsSelection.has(key)) {
          skillsSelection.delete(key);
          if (skillsFocusKey === key) skillsFocusKey = lastSelectionKey();
        } else {
          skillsSelection.add(key);
          skillsFocusKey = key;
        }
      } else if (skillsSelection.size === 1 && skillsSelection.has(key)) {
        // 再点当前唯一选中行：取消选中（详情卡随之收起）
        skillsSelection.clear();
        skillsFocusKey = null;
      } else {
        // 普通左键：集合 = {该行}，焦点 = 该行
        skillsSelection.clear();
        skillsSelection.add(key);
        skillsFocusKey = key;
      }
      renderSkillsList();
      renderSkillDetail();
    });
    // 右键菜单（伪资源管理器）：按目标行是否在选中集合中分流
    $("skillsList").addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const row = e.target.closest("[data-skill]");
      if (!row) {
        showSkillsContextMenu(e.clientX, e.clientY, "blank", null);
        return;
      }
      const key = row.getAttribute("data-skill");
      if (skillsSelection.has(key)) {
        // 集合内：集合不变；单成员弹单选菜单，多成员弹多选菜单
        showSkillsContextMenu(e.clientX, e.clientY, skillsSelection.size > 1 ? "multi" : "single", key);
      } else {
        // 集合外：集合 = {该行}、焦点 = 该行，弹单选菜单
        skillsSelection.clear();
        skillsSelection.add(key);
        skillsFocusKey = key;
        renderSkillsList();
        renderSkillDetail();
        showSkillsContextMenu(e.clientX, e.clientY, "single", key);
      }
    });
    $("skillsList").addEventListener("scroll", hideSkillsContextMenu);
    // 异常卡 matching/unique 的勾选/行内按钮/批量入口在 renderSkillsAnomalies
    // 内于 innerHTML 重建后重新绑定（这两组是待处理清单，无伪资源管理器交互）
    // 键盘：Ctrl+A 全选可见项；Esc 关菜单，否则清空选中。输入框内不劫持 Ctrl+A。
    document.addEventListener("keydown", (e) => {
      // Store 视图的右键菜单同样用 Esc 收起（skills 守卫之前先处理菜单）
      if (e.key === "Escape" && $("skillsCtxMenu") && !$("storeView").hidden) {
        hideSkillsContextMenu();
        e.preventDefault();
        return;
      }
      // Store 视图：Esc 清空选中；Ctrl+A 全选可见行。输入框内不劫持 Ctrl+A。
      if (!$("storeView").hidden) {
        if ($("skillsModal").classList.contains("show")) return;
        if ($("poolBuildModal").classList.contains("show")) return;
        if (e.key === "Escape") {
          if (storeSelection.size) {
            storeSelection.clear();
            requestStoreFocus(null);
            renderStoreList();
          }
        } else if ((e.ctrlKey || e.metaKey) && (e.key === "a" || e.key === "A")) {
          const tag = e.target && e.target.tagName;
          if (tag === "INPUT" || tag === "TEXTAREA") return;
          e.preventDefault();
          selectAllVisibleStoreRows();
        }
        return;
      }
      if ($("skillsView").hidden) return;
      if ($("skillsModal").classList.contains("show")) return;
      if (e.key === "Escape") {
        if ($("skillsCtxMenu")) {
          hideSkillsContextMenu();
          e.preventDefault();
        } else if (skillsSelection.size) {
          skillsSelection.clear();
          skillsFocusKey = null;
          renderSkillsList();
          renderSkillDetail();
        }
      } else if ((e.ctrlKey || e.metaKey) && (e.key === "a" || e.key === "A")) {
        const tag = e.target && e.target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA") return;
        e.preventDefault();
        selectAllVisibleSkills();
      }
    });
    // 点菜单外任意处关闭
    document.addEventListener("click", (e) => {
      const menu = $("skillsCtxMenu");
      if (menu && !menu.contains(e.target)) hideSkillsContextMenu();
    });
    // 共用确认 modal（冲突差异 / 删除确认）
    $("skillsModalCloseBtn").onclick = hideSkillsModal;
    $("skillsModalCancelBtn").onclick = hideSkillsModal;
    $("skillsModalConfirmBtn").onclick = async () => {
      const fn = skillsModalConfirm;
      if (!fn) { hideSkillsModal(); return; }
      // 长操作（如回收站删除每条约 1-3s）：先禁用确认按钮并改文案，
      // 处理中抑制遮罩/关闭，完成后再关弹窗，避免确认后界面数秒无反馈
      const btn = $("skillsModalConfirmBtn");
      const label = btn.textContent;
      const gen = skillsModalGen;
      skillsModalBusy = true;
      btn.disabled = true;
      btn.textContent = "处理中…";
      try {
        await fn();
      } finally {
        skillsModalBusy = false;
        // 回调内改开了新弹窗（如 merge-local 的 conflict 兜底）：
        // 按钮态与新弹窗归属它，不再恢复/关闭
        if (skillsModalGen === gen) {
          btn.disabled = false;
          btn.textContent = label;
          hideSkillsModal();
        }
      }
    };
    $("skillsModal").addEventListener("click", (e) => {
      if (e.target === $("skillsModal")) hideSkillsModal();
    });
    restoreView();
    if ($("skillsView").hidden) refreshSkillsState(); // skills 视图时 switchView 已触发刷新
  }

  // view-enter 重播：remove → 冲刷样式 → add → animationend 一次性清类。switchView 的视图
  // 入场与设置子 tab 面板切换共用同一套。
  // 冲刷读 animationName 而不是 offsetWidth：两者都能让浏览器认定动画已中断、下次 add 从 0
  // 起播，但 offsetWidth 会连布局一起逼出来。视图刚被 unhide、或刚塞进上千行列表时，一次
  // 布局要把整棵子树重排（实测 0.6–1s），只为重播一段 300ms 动画不值得。类名本来就不在时
  // 连冲刷都省掉——那时没有进行中的动画需要中断。
  function replayViewEnter(el) {
    if (el.classList.contains("view-enter")) {
      el.classList.remove("view-enter");
      void getComputedStyle(el).animationName;
    }
    el.classList.add("view-enter");
    el.addEventListener("animationend", () => el.classList.remove("view-enter"), { once: true });
  }

  function resetPageScroll() {
    window.scrollTo(0, 0);
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
  }

  function switchView(name) {
    // 点的就是当前这一页：高亮已经在、内容也在，再走一遍只会把整棵列表重建一次、
    // 再发一轮请求、再回一次顶——用户看到的是一次闪动。设置子 tab 那边是同款先例
    // （activateSettingsSubTab 开头的 active 守卫）。
    if (name === currentView) return;
    const board = name === "board";
    const store = name === "store";
    const stats = name === "stats";
    const presets = name === "presets";
    const sessions = name === "sessions";
    const settings = name === "settings";
    const terminal = name === "terminal";
    resetPageScroll();
    currentView = name;
    document.querySelector(".telemetry-view").hidden = !board;
    $("skillsView").hidden = !(name === "skills");
    $("presetsView").hidden = !presets;
    $("storeView").hidden = !store;
    $("statsView").hidden = !stats;
    $("sessionsView").hidden = !sessions;
    $("settingsView").hidden = !settings;
    $("terminalView").hidden = !terminal;
    document.body.classList.toggle("terminal-mode", terminal);
    // 目录的窄屏入口（☰ 与弹层）挂在 </main> 之外，不随视图 hidden 一起消失；
    // 用同一个 body 类把它收进会话页，离开即不可见也不可达。
    document.body.classList.toggle("sessions-mode", sessions);
    // 设置态栏换血标记：左栏主 tab 组换设置目录、栏底齿轮换「返回」（CSS 收权，与
    // terminal-mode 同型；首帧由 data-prepaint-view="settings" 那四条同值规则承担）。
    document.body.classList.toggle("settings-mode", settings);
    if (terminal) {
      // 进页才建流：xterm 只在可见容器里创建、按实测尺寸收全量回放，首帧即正确
      // 列宽（隐藏期建流会把回放按 12 列折行，见 fitTerminalXterm 的闸）。流在
      // 离开本页后保持存活——已有实例的再次进入只补一次 fit，不重建不重放。
      // 例外是挂过后台：那条流连同实例已被可见性闸拆掉，这里就是它的重挂点。补挂
      // 属被动重挂、不是用户挑了这条会话，所以按 revive:false 走——进程已退只回放
      // 最后一屏，要新壳仍然点页签。
      if (!terminalXterm) renderTerminalPreviewSession({ revive: false });
      else terminalXterm.focus();
      // 兜底：字号变更等路径改的是已存实例，进入时补一次 fit 对齐当前视口。
      scheduleTerminalFit();
      loadInstalledTerminalAgents(); // 进页补热：60s TTL 内近零成本，过期才真实探测
      // 终端会话栏：进页即渲一帧，历史会话先吃缓存（TTL 见 enterTerminalRail）；
      // 过期才在首帧之后补拉，绝不把这条请求排在画面之前。
      enterTerminalRail();
    }
    // 设置是全页视图：主头行（品牌 + 六个主 tab + 状态条）与设置专用头行互斥
    $("mainHeadInner").hidden = settings || terminal;
    $("settingsHeadInner").hidden = !settings;
    $("tabBoard").classList.toggle("active", board);
    $("tabSkills").classList.toggle("active", name === "skills");
    $("tabPresets").classList.toggle("active", presets);
    $("tabStore").classList.toggle("active", store);
    $("tabStats").classList.toggle("active", stats);
    $("tabSessions").classList.toggle("active", sessions);
    // tablist 语义：aria-selected 与 active class 同步（屏幕阅读器按 tab 读选中态）
    for (const [id, on] of [["tabBoard", board], ["tabSkills", name === "skills"], ["tabPresets", presets], ["tabStore", store], ["tabStats", stats], ["tabSessions", sessions]]) {
      $(id).setAttribute("aria-selected", on ? "true" : "false");
    }
    // 新版左栏 tab 的镜像态：与头行 tab 同一状态源、同一收口点（含 restoreView 恢复
    // 与设置/终端进出——进设置时六主 tab 全熄、栏底设置钮点亮；进终端时「终端」tab
    // 亮，栏内第七枚就是它）。高亮即挂 aria-current="page"，熄灭即摘；轻页头页题与
    // 点亮 tab 的标签同源（现取 .rail-tab-label 的文字，不复制字符串）。取标签而非
    // tab 整段 textContent：预设/会话两枚栏图标是裸 Unicode 字形（❑/☰）而非 svg，
    // svg 无文本内容、整段取不会带出图标，裸字形会——整段取就把「❑ 」「☰ 」混进
    // 页面左上角页题，那处只该是纯标题文字。
    const v2PageTitle = $("v2PageTitle");
    for (const [railId, on] of [["railTabBoard", board], ["railTabSkills", name === "skills"], ["railTabPresets", presets], ["railTabSessions", sessions], ["railTabStore", store], ["railTabStats", stats], ["railTabTerminal", terminal]]) {
      const railTab = $(railId);
      if (!railTab) continue;
      railTab.classList.toggle("active", on);
      railTab.setAttribute("aria-selected", on ? "true" : "false");
      if (on) railTab.setAttribute("aria-current", "page"); else railTab.removeAttribute("aria-current");
      const railLabel = railTab.querySelector(".rail-tab-label");
      if (on && v2PageTitle) v2PageTitle.textContent = (railLabel || railTab).textContent.trim();
    }
    const railSettings = $("railSettingsBtn");
    if (railSettings) {
      railSettings.classList.toggle("active", settings);
      if (settings) railSettings.setAttribute("aria-current", "page"); else railSettings.removeAttribute("aria-current");
    }
    // 首帧落位属性在此交棒：panel.html 的 panelViewPrepaint 于绘制前把目标屏写在
    // <html> 上，显隐由 panel.css 的「首帧视图落位」段承担；上面那批 hidden 赋值
    // 已把同一状态落到真实 DOM，摘掉属性后运行时显隐就只剩 hidden 一个来源。
    // 位置在 hidden 赋值之后、下面进入钩子之前是硬要求：enterSettingsView 会激活
    // 归档子 tab 并拍看板镜像快照，属性还挂着会让快照连收起规则一起拍进去。
    document.documentElement.removeAttribute("data-prepaint-view");
    document.documentElement.removeAttribute("data-prepaint-subtab");
    // 内容区入场动效：仅主动切换播放；恢复/首屏由 suppressViewEnter 置位跳过。
    // 看板走变体阶梯入场（playBoardEnter），其余视图走通用 view-enter。
    if (suppressViewEnter) {
      suppressViewEnter = false;
    } else if (board) {
      playBoardEnter(document.querySelector(".telemetry-view"));
    } else {
      const enteredView = name === "skills" ? $("skillsView")
        : presets ? $("presetsView")
        : store ? $("storeView")
        : stats ? $("statsView")
        : settings ? $("settingsView")
        : terminal ? $("terminalView")
        : $("sessionsView");
      replayViewEnter(enteredView);
    }
    // panel-view 只存主视图（设置视图不覆盖它，那份留着当「←退出」的目标）；
    // 是否停在设置页由 panel-settings-open 单独记，restoreView 按这两个键恢复。
    // 终端页与设置页同形：它也是从主视图切出去的全页视图，不占 panel-view，
    // 「停在终端页」由 panel-terminal-open 自己记（刷新恢复按它落回终端页）。
    if (!settings && !terminal) try { localStorage.setItem("panel-view", name); } catch {}
    try { localStorage.setItem("panel-settings-open", settings ? "1" : "0"); } catch {}
    try { localStorage.setItem("panel-terminal-open", terminal ? "1" : "0"); } catch {}
    // 进入工作整段让到高亮之后：上面的高亮、显隐与入场动效仍留在本次任务里，浏览器
    // 画完这一帧 tab 就亮了；各视图的首次渲染（会话列表铺行、看板补刷、设置取数……）
    // 排到高亮上屏之后再做，不再和它抢同一帧——否则点击到高亮之间还隔着整份视图的
    // 渲染耗时（实测会话页 1.5–3.3s）。
    const runViewEntry = () => {
      let viewReady;
      if (name === "skills") viewReady = refreshSkillsState();
      if (presets) viewReady = refreshPresetsState();
      if (store) viewReady = refreshStoreState();
      if (stats) viewReady = enterStatsView(); else leaveStatsView();
      if (sessions) viewReady = enterSessionsView(); else leaveSessionsView();
      if (settings) viewReady = enterSettingsView(); else leaveSettingsView();
      // 刷新终态在离开期间落的小字暂停了淡出计时，切回渠道 tab 即消费「等切回」标记、
      // 重新计一个完整 10s（与差异弹窗关闭重计同款先例）；此后再切走不再暂停
      if (store && storeStatusAwaitReturn) {
        storeStatusAwaitReturn = false;
        if ($("storeRefreshStatus") && $("storeRefreshStatus").classList.contains("show")) armStoreStatusTimer();
      }
      // 切回看板：清卡片指纹表并立即补刷，离开期间的缓存/链配置变化即刻生效
      if (board) {
        resetAgentRenderFingerprints();
        refreshAgents();
        refreshModelStability();
        // 左侧栏常驻预设总开关，切回看板时补刷一次保证状态最新
        refreshPresetsState();
      }
      return viewReady;
    };
    // 开屏台等的是「本视图首帧就绪」：进入工作延后之后，就绪时刻也跟着挪到延后的那段，
    // 不能再拿同步返回的那个 promise（它此刻还没开工）。被后续切换作废的按已兑现处理，
    // 不吊住开屏层的退场判据。
    const entryReady = scheduleViewEntry(runViewEntry);
    if (window.panelStartupController) startupViewReady = entryReady;
  }

  // 看板变体入场（移植 CC Switch 设置页「关于」tab 的 mount 阶梯动画）：容器整体淡入
  // 上浮 10px 立即开始；可见 .panel-card 按视觉顺序逐张阶梯——首卡（服务状态）用 scale
  // 变奏、延迟 100ms，其余淡入+上浮、延迟 150ms+i×40ms。隐藏卡（如无链时的路由链卡）
  // 跳过不占延迟位；播完即清，1s 轮询只更新卡片内容不重建节点，不会打断动画。
  function playBoardEnter(view) {
    view.classList.remove("board-enter");
    // 只冲样式不冲布局：连切时让动画从 0 重播，代价不该是整块看板重排一遍
    void getComputedStyle(view).animationName;
    view.classList.add("board-enter");
    view.addEventListener("animationend", () => view.classList.remove("board-enter"), { once: true });
    const cards = [...view.querySelectorAll(".panel-card")].filter((el) => !el.hidden);
    // 首帧卡序接管（panel.html 的 data-prepaint-card-order）生效期间，端点卡的视觉序是
    // 存档序而非 DOM 序——CSS order 只改绘制不改文档。可信首帧落地前（reorderAgentCards
    // 尚未摘属性重排）播这段阶梯，按 DOM 序发延迟会把浮入次序画乱（2026-10-08 报障：
    // 加载态窗口期切回看板，卡片浮出顺序与屏上卡序对不上）。这里把端点卡占的槽位按
    // 存档序填回；侧栏卡不携 data-agent-id，槽位与延迟天然不动。
    const prepaintOrder = document.documentElement.getAttribute("data-prepaint-card-order");
    if (prepaintOrder) {
      const rank = new Map(prepaintOrder.split(",").map((id, idx) => [id, idx]));
      const agentCards = cards
        .filter((el) => rank.has(el.getAttribute("data-agent-id")))
        .sort((a, b) => rank.get(a.getAttribute("data-agent-id")) - rank.get(b.getAttribute("data-agent-id")));
      let nextAgent = 0;
      for (let i = 0; i < cards.length; i++) {
        if (rank.has(cards[i].getAttribute("data-agent-id"))) cards[i] = agentCards[nextAgent++];
      }
    }
    cards.forEach((el, i) => {
      const hero = i === 0;
      el.style.setProperty("--board-delay", hero ? "100ms" : `${150 + (i - 1) * 40}ms`);
      el.classList.remove("board-card-enter", "board-card-enter-scale");
      void getComputedStyle(el).animationName; // 同上：只冲样式，卡片不逐张重排
      el.classList.add(hero ? "board-card-enter-scale" : "board-card-enter");
      el.addEventListener("animationend", () => el.classList.remove("board-card-enter", "board-card-enter-scale"), { once: true });
    });
  }

  // 视图进入工作的让位调度：把目标视图的首次渲染排到「点击已画出高亮」之后。
  // 浏览器要等当前 JS 任务结束才绘制，所以高亮要多久上屏，取决于 switchView 这一段
  // 同步代码跑多久；把重活留在同步段里，就是让高亮陪着会话列表一起等（实测 1.5–3.3s）。
  // 双 rAF：第一个回调仍在本帧绘制之前，第二个才落到下一帧，那时高亮已经上屏。
  // 连点时只认最后一次：seq 对不上就直接按已兑现返回，不让旧视图的迟到渲染盖掉新视图；
  // 各视图的进入/离开成对写在同一个闭包里，最新那次会把该收的收干净，状态不会错位。
  let viewEntrySeq = 0;
  function scheduleViewEntry(work) {
    const seq = ++viewEntrySeq;
    return new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (seq !== viewEntrySeq) { resolve(); return; }
        try { resolve(work()); }
        catch (err) { console.warn("[panel] 视图进入失败：", err); resolve(); }
      }));
    });
  }

  // 刷新页面后留在原 tab（默认看板）；launcher 启动的那一次固定落看板，
  // 刷新与普通访问不受影响，仍按 panel-view 恢复。设置页由 panel-settings-open
  // 独立标记恢复，「←退出」的目标就是 panel-view 里那份主视图；终端页由
  // panel-terminal-open 独立标记恢复，优先级排在设置页之前。
  function restoreView() {
    if (window.panelStartupLaunch) {
      // 首开这一跳不算「回来」，可标记是上一次会话留下的：不就地清掉，本页之后第一次
      // 刷新就会跳进设置页——「固定落看板」只剩首屏那一下管用。终端页同一回事。
      try {
        localStorage.setItem("panel-settings-open", "0");
        localStorage.setItem("panel-terminal-open", "0");
      } catch {}
      return;
    }
    let saved = null;
    let settingsOpen = false;
    let terminalOpen = false;
    try {
      saved = localStorage.getItem("panel-view");
      settingsOpen = localStorage.getItem("panel-settings-open") === "1";
      terminalOpen = localStorage.getItem("panel-terminal-open") === "1";
    } catch {}
    // 刷新恢复落位不播入场动画；仅命中分支时置位——saved 为 "board"/无效值时不调
    // switchView，无条件置位会让标志残留，顺延吞掉下一次主动切换的动画。
    // 重启恢复（panelStartupRestart）同样先置位静默：此刻开屏层还盖着，立即播会在
    // 底下播完；改为记 restartEnterView，init() 末尾在开屏 ready() 之后、与淡出同步起播。
    if (saved === "skills" || saved === "presets" || saved === "store" || saved === "stats" || saved === "sessions") suppressViewEnter = true;
    if (saved === "skills") switchView("skills");
    else if (saved === "presets") switchView("presets");
    else if (saved === "store") switchView("store");
    else if (saved === "stats") switchView("stats");
    else if (saved === "sessions") switchView("sessions");
    if (terminalOpen) {
      // 终端页排在设置页之前：进终端页那一刻 panel-settings-open 已被写成 "0"，两把键
      // 同时为真只可能是存档被手改，按终端页走。上面 saved 链刚落好的主视图仍是设置页
      // 「←退出」的目标；终端页的返回上下文用声明处的默认值（看板——入口就在左栏那张卡
      // 上），与点卡上按钮进来那条路同一套，不必另存。
      settingsReturnView = currentView;
      suppressViewEnter = true;
      switchView("terminal");
      // 刷新落回终端页要走与点击进入同一条宿主状态分派：点击那条会现取
      // /api/terminal/host/status 并在宿主 running 时补连，恢复这条原先只做
      // switchView——首连失败过的页刷新回来就恒停在「终端服务未运行」停态，再也
      // 回不到就绪（1s 状态轮询的补连分支把初载的 unknown→running 排除在外）。
      // 不 await：恢复落位不该等一次网络往返，补连本身是异步的。typeof 闸护
      // restoreView 的桩环境（那份桩只关心落位目标，不装网络侧分派）。
      if (typeof dispatchTerminalEntry === "function") {
        dispatchTerminalEntry().then(resumeTerminalBackendAfterEntry).catch(() => {});
      }
    } else if (settingsOpen) {
      // 上面那条链落好的就是进设置前的主视图（没命中则为看板），直接拿来当返回目标；
      // 子 tab 存档交给 enterSettingsView 消费。置位口径同主视图恢复：落位不播动画。
      settingsReturnView = currentView;
      try { settingsSubTabToRestore = localStorage.getItem("panel-settings-subtab"); } catch {}
      suppressViewEnter = true;
      switchView("settings");
    }
    if (window.panelStartupRestart) {
      // saved 为 "board"/null/无效值时看板是 HTML 默认显示的、不经 switchView，同样
      // 靠这个标记补播。
      restartEnterView = (saved === "skills" || saved === "presets" || saved === "store" || saved === "stats" || saved === "sessions") ? saved : "board";
      if (settingsOpen && !terminalOpen) restartEnterView = "settings";
      if (terminalOpen) restartEnterView = "terminal";
    }
  }

  // reconcile（每次刷新后）：prune 集合中已消失的 relPath；焦点不在集合内则回退
  // （非空取最后一员，否则 null）。空集合不自动选中——用户清空后刷新不能复活。
  function reconcileSkillsSelection() {
    const skills = (skillsState && skillsState.skills) || [];
    const relPaths = new Set(skills.map((s) => s.relPath));
    for (const k of [...skillsSelection]) if (!relPaths.has(k)) skillsSelection.delete(k);
    if (!skillsSelection.has(skillsFocusKey)) skillsFocusKey = lastSelectionKey();
    // 收藏同步 prune：仓库中已消失的 relPath 不再保留（与选中集合同思路）。
    // 安全性依赖 ensureFavoritesForRepo：内存集合保证对应当前仓库的桶，仓库
    // 切换发生在装载之前，这里清掉的只会是本仓库内已删除的 skill。
    let favPruned = false;
    for (const k of [...skillsFavorites]) {
      if (!relPaths.has(k)) { skillsFavorites.delete(k); favPruned = true; }
    }
    if (favPruned) saveSkillsFavorites();
  }

  // 串行化刷新：所有刷新排进 promise 链依次执行，await 返回时那次刷新的 GET
  // 一定是在调用之后才发出的（旧「在飞则记一笔」模式下 await 会立即返回，
  // 调用方拿到的是操作前发出的旧状态渲染——删除后条目不立即消失就是这么来的）。
  // 单次失败不断链（doRefreshSkillsState 内部已 catch，catch 仅兜底）。
  let skillsRefreshChain = Promise.resolve();
  function refreshSkillsState() {
    const p = skillsRefreshChain.then(doRefreshSkillsState);
    skillsRefreshChain = p.catch(() => {});
    return p;
  }

  // 手动刷新的视觉反馈：按钮走 .btn:disabled 的 45% 变暗（与看板「重启」键同源，
  // 暗着即「还没好」），持续到整列 cascade 播完才亮起。等待串在刷新之后而不是与请求
  // 并行取最大值：cascade 只能在数据落地那次渲染起跑，从点击起算会让亮起早于动画收尾
  // 一个请求耗时。请求慢于 320ms 时总暗时长就是「请求 + cascade」，语义仍然对。
  const SKILLS_CASCADE_TOTAL_MS = 320;
  const SKILLS_CASCADE_ROW_MS = 150; // 与 CSS .row-cascade 的单行时长同值，步长公式要用
  let skillsCascadePending = false;

  async function runSkillsRefreshWithFeedback() {
    const btn = $("skillsRefreshBtn");
    if (btn.disabled) return;
    btn.disabled = true;
    $("skillsList").classList.add("is-blank");
    skillsCascadePending = true;
    try {
      await refreshSkillsState();
      await new Promise((r) => setTimeout(r, SKILLS_CASCADE_TOTAL_MS));
    } finally {
      // 请求失败时 doRefreshSkillsState 走 catch 不渲染，is-blank 与标记都得在这里兜底：
      // 前者不清列表永久隐形，后者不清会在下次无关渲染（过滤输入逐键）白播一次。
      skillsCascadePending = false;
      $("skillsList").classList.remove("is-blank");
      btn.disabled = false;
    }
  }

  // ── 变动差分高亮 ──
  // 列表每次渲染全量重建 innerHTML，变动标记不能挂在 DOM 上（与选中集合同一约定）。
  // skillsFlashNew 驱动新行底色渐隐，只在差分后的那次渲染消费，之后的普通重渲染不重播；
  // skillsFlashCount 驱动计数徽标闪烁，renderSkillsRepo 读、最后渲染的 renderSkillsList 消费。
  let skillsFlashNew = new Set();
  let skillsFlashCount = false;

  function diffSkillsState(prev, next) {
    skillsFlashNew = new Set();
    skillsFlashCount = false;
    const skills = next.skills || [];
    // 首次加载 / 仓库未设置 / 换了仓库：重建基线，不把整仓库标成「新」
    if (!prev || !prev.repoConfigured || prev.repoPath !== next.repoPath) return;
    const prevById = new Map((prev.skills || []).map((s) => [s.relPath, s]));
    for (const s of skills) {
      if (!prevById.has(s.relPath)) skillsFlashNew.add(s.relPath);
    }
    skillsFlashCount = (prev.skills || []).length !== skills.length;
  }

  async function doRefreshSkillsState() {
    try {
      const res = await api("GET", "/api/skills/state");
      const firstLoad = skillsState === null;
      const prev = skillsState;
      skillsState = res;
      // 收藏桶必须赶在 reconcile 之前对齐本次状态里的仓库：换仓即换桶，
      // reconcile 的收藏清理才只作用于当前仓库自己的桶
      ensureFavoritesForRepo(res.repoPath);
      diffSkillsState(prev, res);
      // 唯一自动选中：首次加载（skillsState 由 null 变非 null）且集合为空时
      // 集合 = {第一行}、焦点 = 第一行，保持"打开 tab 即见详情"；此后不再复活空选中。
      if (firstLoad && !skillsSelection.size) {
        const first = (res.skills || [])[0];
        if (first) {
          skillsSelection.add(first.relPath);
          skillsFocusKey = first.relPath;
        }
      }
      reconcileSkillsSelection();
      renderSkillsRepo();
      renderSkillsList();
      renderSkillDetail();
      renderSkillsAnomalies();
    } catch (e) {
      toast(panelError(e, "Skills 状态加载失败"), true);
    }
  }

  // ── 卡片 A：主仓库 ──
  // 候选区生命周期：未设置主仓库时默认展开（新用户靠它一键上手），设置后默认
  // 收起、只留一行弱化入口——按钮常驻显眼处时误触即换仓库，而老手基本用不上。
  // 显式点过展开/收起后以存档为准，默认不再介入。
  const SKILLS_CANDIDATES_OPEN_KEY = "skills-candidates-open";
  function skillsCandidatesOpen() {
    try {
      const saved = localStorage.getItem(SKILLS_CANDIDATES_OPEN_KEY);
      if (saved === "1") return true;
      if (saved === "0") return false;
    } catch {}
    return !(skillsState && skillsState.repoConfigured);
  }
  function setCandidatesOpen(open) {
    try { localStorage.setItem(SKILLS_CANDIDATES_OPEN_KEY, open ? "1" : "0"); } catch {}
    renderSkillsRepo();
  }
  function renderSkillsRepo() {
    const badge = $("skillsRepoBadge");
    const pathEl = $("skillsRepoPath");
    const candEl = $("skillsRepoCandidates");
    if (!skillsState || !skillsState.repoConfigured) {
      badge.className = "badge badge-neutral";
      badge.textContent = "未设置";
      pathEl.textContent = "尚未选择主仓库目录";
    } else if (!skillsState.repoValid) {
      badge.className = "badge badge-danger";
      badge.textContent = "路径无效";
      pathEl.textContent = skillsState.repoPath + "（目录不存在或已被移走）";
    } else {
      const count = (skillsState.skills || []).length;
      badge.className = "badge " + (count ? "badge-ok" : "badge-neutral");
      badge.textContent = count + " 个 skill";
      pathEl.textContent = skillsState.repoPath;
    }
    // 仓库计数变化时闪一下（只读不消费；最后渲染的 renderSkillsList 负责消费）
    if (skillsFlashCount) { badge.classList.remove("badge-flash"); void badge.offsetWidth; badge.classList.add("badge-flash"); }
    const candidates = (skillsState && skillsState.candidates) || [];
    const usable = candidates.filter((c) => c.exists && c.path !== (skillsState && skillsState.repoPath));
    const candOpen = skillsCandidatesOpen();
    candEl.innerHTML = !usable.length
      ? ""
      : candOpen
        ? usable.map((c) => `<button class="btn btn-mini" data-cand="${escapeHtml(c.path)}" title="${escapeHtml(c.path)}">使用 ${escapeHtml(shortHomePath(c.path))}</button>`).join("") +
          `<button class="skills-cand-toggle" title="收起候选仓库，需要时再展开">收起 ▴</button>`
        : `<button class="skills-cand-toggle" title="展开候选仓库目录，可一键切换主仓库">候选仓库（${usable.length}）▾</button>`;
    candEl.querySelectorAll("button[data-cand]").forEach((btn) => {
      btn.onclick = () => setSkillsRepo(btn.getAttribute("data-cand"));
    });
    candEl.querySelectorAll(".skills-cand-toggle").forEach((btn) => {
      btn.onclick = () => setCandidatesOpen(!candOpen);
    });
  }

  // 把 home 前缀缩成 ~ 让候选按钮更短。
  function shortHomePath(p) {
    const paths = ((skillsState && skillsState.candidates) || []).map((c) => c.path);
    let home = "";
    // 优先用候选里的 .agents 段定位 home 前缀。
    for (const q of paths) {
      const idx = q.search(/\.agents(?=[\\/]|$)/);
      if (idx > 0) { home = q.slice(0, idx); break; }
    }
    // 否则候选都是同一 home 拼出的路径，取公共前缀（截到目录边界）。
    if (!home && paths.length) {
      home = paths[0];
      for (const q of paths.slice(1)) {
        while (home && !q.startsWith(home)) home = home.slice(0, -1);
      }
      home = home.replace(/[^\\/]*$/, "");
    }
    if (home && p.startsWith(home)) return "~/" + p.slice(home.length).replace(/\\/g, "/");
    return p;
  }

  // ── 弹窗/回执里指代「来源」的共用措辞 ─────────────────────────────
  // 识别面把全局目录（~/.agents/skills）也扫进来，但它「不是任何 Agent」：状态里
  // 单列在 globalEndpoint（部署名单 endpoints 不含它）。所以一律经这里取名——
  // Agent 用显示名（Claude Code…，取名池与「查看差异」同源），全局目录写全
  // 「全局目录 + ~ 路径」；查不到显示名才退回内部 id（状态未就绪的极端路径）。
  function skillsGlobalEndpoint() {
    return (skillsState && skillsState.globalEndpoint) || null;
  }
  function skillsSourceIsGlobal(endpointId) {
    const globalEp = skillsGlobalEndpoint();
    return Boolean(globalEp && endpointId === globalEp.id);
  }
  function skillsSourceName(endpointId) {
    if (skillsSourceIsGlobal(endpointId)) return "全局目录";
    const globalEp = skillsGlobalEndpoint();
    const pool = [...((skillsState && skillsState.endpoints) || []), ...(globalEp ? [globalEp] : [])];
    return pool.find((e) => e.id === endpointId)?.label || endpointId;
  }
  // 正文短语：Agent →「Agent <b>Claude Code</b> 上」；全局目录 →「全局目录 <b>~/.agents/skills</b> 中」。
  // 方位词收进短语，句子直接接「的目录 / 的内容 / 指向…」，两类来源共用一套句式。
  function skillsSourcePhrase(endpointId) {
    const globalEp = skillsGlobalEndpoint();
    if (globalEp && endpointId === globalEp.id) {
      return `全局目录 <b>${escapeHtml(shortHomePath(globalEp.skillsDir))}</b> 中`;
    }
    return `Agent <b>${escapeHtml(skillsSourceName(endpointId))}</b> 上`;
  }

  // 已有主仓库且换到不同路径时先过确认弹窗：候选按钮是一键直切，没有这道闸，
  // 误点一下主仓库就换了。首次设置（含尚未设置、路径失效后的重设）不设闸，
  // 那是用户本来就要走完的流程。
  function setSkillsRepo(path) {
    const switching = Boolean(skillsState && skillsState.repoConfigured && skillsState.repoPath !== path);
    const apply = async (allowEmpty = false) => {
      try {
        const d = await api("POST", "/api/skills/repo", { repoPath: path, ...(allowEmpty ? { allowEmpty: true } : {}) });
        toast(`主仓库已设置（${d.skillCount} 个 skill）`);
      } catch (e) {
        // 空目录不直接拒死：经用户确认后带 allowEmpty 重试，防手滑的闸仍在第一道口子上
        if (!allowEmpty && e.serverCode === "skills_repo_empty") {
          showSkillsModal({
            title: "用作空主仓库？",
            bodyHtml: `<b>${escapeHtml(path)}</b> 里还没有任何 skill。` +
              "可以把它作为空的主仓库使用，之后用「导入 skill…」往里添加；如果是选错了目录，请取消后重新选择。",
            confirmText: "仍要使用",
            onConfirm: () => apply(true),
          });
          return;
        }
        toast(panelError(e, "设置主仓库失败"), true);
      }
      refreshSkillsState();
    };
    if (!switching) { apply(); return; }
    showSkillsModal({
      title: "切换主仓库",
      bodyHtml: `将把 Skills 主仓库切换到 <b>${escapeHtml(path)}</b>。` +
        "当前仓库的收藏会保留，切回即恢复；已部署到各 Agent 的 skill 目录不会移动。",
      confirmText: "切换",
      onConfirm: apply,
    });
  }

  async function pickSkillsRepo() {
    try {
      const d = await api("POST", "/api/skills/repo/pick", {});
      if (d.cancelled || !d.path) return;
      await setSkillsRepo(d.path);
    } catch (e) {
      toast(panelError(e, "打开目录选择框失败"), true);
    }
  }

  // 「导入 skill 目录…」/「导入 skill（zip）…」：两个按钮各走一条后端选择框链路
  // （目录框 / .zip 文件框——系统对话框无法一框通吃两者），校验 SKILL.md 后拷入主仓库，
  // zip 解压后同样以目录形式入库。取消选择框则静默返回。
  // 一次 POST 覆盖「弹原生框 → 挑目录 → 校验 → 拷贝」，后端 pickFolder 超时 120s；
  // 原生框弹在桌面上，页面里只剩一个暗按钮，所以暗态要有名字，禁用同时防重复弹框。
  async function importSkillViaPicker(btnId, endpoint) {
    const btn = $(btnId);
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = "导入中…";
    try {
      const d = await api("POST", endpoint, {});
      if (d.cancelled) return;
      toast(`已导入 ${d.skill.name}`);
      // 等新行真的上屏再恢复按钮：与刷新同一套「暗到结果可见」语义
      // （旧写法不 await，按钮先亮、列表后到，完成信号早于结果）
      await revealSkillsInsert([d.skill.relPath]);
    } catch (e) {
      toast(panelError(e, "导入失败"), true);
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  }

  // ── 卡片 B：仓库 skills 主从列表（选中驱动右侧详情卡） ──
  // 每个 skill 的部署端点：各端点上 repoSkill 指向它的正常 junction。
  // state 参数供差分对比旧状态用，缺省取当前 skillsState。
  function deployedEndpointsFor(skill, state = skillsState) {
    if (!state) return [];
    const out = [];
    for (const ep of state.endpoints || []) {
      for (const entry of ep.entries || []) {
        if (entry.kind === "junction" && !entry.broken && entry.repoSkill === skill.dirName) {
          out.push(ep.id);
          break;
        }
      }
    }
    return out;
  }

  // 名称/目录名命中排前，仅描述命中排后（sort 稳定，同级保持仓库原顺序）。
  // 否则搜 "spec" 时描述里含 spec 的 code-review 会排在 speckit-* 前面。
  // 收藏置顶是更高优先级的排序键：被收藏的 skill 始终排在未收藏之前，
  // 收藏内部/未收藏内部再按命中 rank（无过滤时按仓库原顺序）排。
  // 「全选」也以此为准（只作用于当前过滤后可见的项）。
  function visibleSkills() {
    const skills = (skillsState && skillsState.skills) || [];
    const favRank = (s) => (skillsFavorites.has(s.relPath) ? 0 : 1);
    if (!skillsFilter) return [...skills].sort((a, b) => favRank(a) - favRank(b));
    return skills.map((s) => {
      const hit = (v) => (v || "").toLowerCase().includes(skillsFilter);
      const rank = hit(s.name) || hit(s.dirName) ? 0 : hit(s.description) ? 1 : -1;
      return { s, rank };
    }).filter((x) => x.rank >= 0)
      .sort((a, b) => (favRank(a.s) - favRank(b.s)) || (a.rank - b.rank))
      .map((x) => x.s);
  }

  function renderSkillsList() {
    const listEl = $("skillsList");
    const badge = $("skillsListBadge");
    const skills = (skillsState && skillsState.skills) || [];
    badge.textContent = String(skills.length);
    // 消费差分标记：只有差分后的那次渲染重播动画，之后过滤/选中等重渲染拿到空集合。
    // 提前 return 的空列表路径同样消费，避免标记滞留到下一次无关渲染。
    const flashNew = skillsFlashNew; skillsFlashNew = new Set();
    const flashCount = skillsFlashCount; skillsFlashCount = false;
    // cascade / FLIP / 入场标记同样在提前 return 之前消费：空列表路径没有行可动画，
    // 但容器必须解除隐形、标记不能滞留到下一次无关渲染（过滤输入逐键会白播）。
    const cascade = skillsCascadePending; skillsCascadePending = false;
    const prevScrollTop = cascade ? listEl.scrollTop : 0;
    const flipTops = skillsFlipTops; skillsFlipTops = null;
    const flipMs = skillsFlipMs; skillsFlipMs = 0;
    const revealKeys = skillsRevealKeys; skillsRevealKeys = null;
    listEl.classList.remove("is-blank");
    if (flashCount) { badge.classList.remove("badge-flash"); void badge.offsetWidth; badge.classList.add("badge-flash"); }
    if (!skillsState || !skillsState.repoConfigured) {
      listEl.innerHTML = '<div class="empty-hint">先设置主仓库</div>';
      return;
    }
    if (!skills.length) {
      listEl.innerHTML = '<div class="empty-hint">仓库中还没有 skill，用主仓库卡的「导入 skill…」添加</div>';
      return;
    }
    const filtered = visibleSkills();
    if (!filtered.length) {
      listEl.innerHTML = '<div class="empty-hint">没有匹配的 skill</div>';
      return;
    }
    const endpoints = skillsState.endpoints || [];
    // 分母 = 服务端返回的全部端点（已按「装在本机」过滤）。目录是否存在不进
    // 口径：装好但从未部署过的 Agent 首次部署时会自建目录，「未部署」就是它的
    // 准确状态。
    const enabledEps = endpoints;
    const epLabelById = new Map(endpoints.map((ep) => [ep.id, ep.label]));
    // 仓库内可能有多个同名目录的 skill（如 vendor 副本）；dirName 是部署匹配的键，
    // 重名时部署状态会互相沾染，需要在列表里标出来。
    const dirNameCounts = new Map();
    for (const s of skills) dirNameCounts.set(s.dirName, (dirNameCounts.get(s.dirName) || 0) + 1);
    listEl.innerHTML = filtered.map((s, i) => {
      const eps = deployedEndpointsFor(s);
      const epCount = !enabledEps.length
        ? ""
        : `<span class="skills-ep-count${eps.length >= enabledEps.length ? " full" : eps.length ? " some" : ""}" title="${escapeHtml(
            `已部署 ${eps.length}/${enabledEps.length} 个 Agent`
            + (eps.length ? `：${eps.map((id) => epLabelById.get(id) || id).join("、")}` : "")
          )}">${eps.length}/${enabledEps.length}</span>`;
      const dupBadge = dirNameCounts.get(s.dirName) > 1
        ? `<span class="badge badge-warn" title="仓库中有多个目录名为 ${escapeHtml(s.dirName)} 的 skill，此条位于 ${escapeHtml(s.relPath)}">同名</span>`
        : "";
      const favStar = skillsFavorites.has(s.relPath)
        ? '<span class="skills-fav-star" title="已收藏">★</span>'
        : "";
      // 新行底色动画只在差分后的那次渲染挂类，防过滤输入逐键重播动画。
      // cascade 那次渲染让位：同元素同特异性的 animation 简写是整条覆盖而非叠加，
      // 两个动画会互吃一个；且 2s 底色渐隐混进 300ms cascade 里只是噪声。
      const flashCls = cascade
        ? ""
        : flashNew.has(s.relPath) ? " row-new" : "";
      return `<div class="skills-list-row${skillsSelection.has(s.relPath) ? " selected" : ""}${flashCls}" data-skill="${escapeHtml(s.relPath)}" style="--i:${i}">
        <div class="skills-list-line1">
          <span class="skills-list-name" title="${escapeHtml(s.relPath)}">${escapeHtml(s.name)}</span>${dupBadge}
          <span class="skills-ep-dots">${favStar}${epCount}</span>
        </div>
        <div class="skills-list-desc">${escapeHtml(s.description || "（无描述）")}</div>
      </div>`;
    }).join("");
    if (cascade) { listEl.scrollTop = prevScrollTop; playSkillsListCascade(listEl, prevScrollTop); }
    // 入场类先挂、FLIP 后跑：FLIP 每行都强制一次回流，顺序反了入场动画会晚一帧起跑
    if (revealKeys) {
      for (const row of listEl.children) {
        if (revealKeys.has(row.getAttribute("data-skill"))) row.classList.add("row-reveal");
      }
    }
    if (flipTops) skillsListFlipFrom(flipTops, flipMs);
  }

  // 视口锚定的整列 cascade：取当前可见窗口 [i0,i1] 而非恒为「前 K 行」，并在刷新后
  // 还原 scrollTop（与 sessions 的 keepScroll 同源）。翻到非最上刷新时，波在用户当前
  // 视口里自上而下流、位置不丢；到顶时 prevScrollTop=0、i0=0，与旧「前 K 行」逐字节等价。
  // --i 重基为窗口内位次 (j-i0)：绝对行号会让中后段行的延迟溢出 450ms 预算；--i 走内联
  // setProperty 覆盖模板里的绝对 --i。步长仍由窗口行数反推，使「末行延迟+单行时长≡总时长」
  // 不变式继续成立，总时长不随仓库条数漂。行高均匀（名称/描述两行都 nowrap+ellipsis），
  // 首行 offsetHeight 即代表全体，不用逐行量。
  function playSkillsListCascade(listEl, prevScrollTop) {
    const rows = listEl.children;
    if (!rows.length) return;
    prevScrollTop = prevScrollTop || 0;
    const rowH = rows[0].offsetHeight || 1;
    const i0 = Math.floor(prevScrollTop / rowH);
    const i1 = Math.min(rows.length - 1, Math.ceil((prevScrollTop + listEl.clientHeight) / rowH));
    const k = i1 - i0 + 1;
    const step = k > 1 ? (SKILLS_CASCADE_TOTAL_MS - SKILLS_CASCADE_ROW_MS) / (k - 1) : 0;
    listEl.style.setProperty("--csc-step", step.toFixed(1) + "ms");
    for (let j = i0; j <= i1; j++) {
      const row = rows[j];
      if (row.style && row.style.setProperty) row.style.setProperty("--i", String(j - i0));
      row.classList.add("row-cascade");
    }
  }

  // ── 列表增删的位移反馈（FLIP 让位/吸合 + 单行入场/退场）──
  // 导入与删除都只动一条数据，但整列 innerHTML 重建后其余行会瞬间跳到新位置：
  // 没有位移反馈时新行像凭空出现、删除像整列抖一下。这里照 routeChainFlipFrom
  // 的范式补上——重渲前快照行位置，重渲后把仍在的行平移回旧位置再 transition 归零。
  // 快照走内容坐标系（相对列表内容原点，不是视口），容器滚动与页面滚动都自动抵消，
  // 所以「重渲 → 滚到新行 → FLIP」这个顺序不会把滚动量算进位移里。
  const SKILLS_INSERT_MS = 600;      // 导入：新行入场与邻行让位同拍同缓动
  const SKILLS_DISSOLVE_MS = 200;    // 删除：行退场
  const SKILLS_DELETE_FLIP_MS = 300; // 删除：缺口两侧吸合
  let skillsFlipTops = null;         // Map<relPath, 内容坐标 top> | null
  let skillsFlipMs = 0;
  let skillsRevealKeys = null;       // Set<relPath> | null：本次渲染要挂入场动画的行

  function skillsRowByKey(relPath) {
    const listEl = $("skillsList");
    if (!listEl) return null;
    for (const row of listEl.children) {
      if (row.getAttribute("data-skill") === relPath) return row;
    }
    return null;
  }

  function skillsListTops() {
    const listEl = $("skillsList");
    const m = new Map();
    if (!listEl) return m;
    const origin = listEl.getBoundingClientRect().top - listEl.scrollTop;
    for (const row of listEl.children) {
      const key = row.getAttribute("data-skill");
      if (key) m.set(key, row.getBoundingClientRect().top - origin);
    }
    return m;
  }

  function skillsListFlipFrom(tops, ms) {
    const listEl = $("skillsList");
    if (!listEl || !tops || !tops.size) return;
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const origin = listEl.getBoundingClientRect().top - listEl.scrollTop;
    for (const row of listEl.children) {
      const prev = tops.get(row.getAttribute("data-skill"));
      if (prev === undefined) continue;
      const dy = prev - (row.getBoundingClientRect().top - origin);
      if (!dy) continue;
      row.style.transition = "none";
      row.style.transform = `translateY(${dy}px)`;
      void row.offsetWidth;
      // 缓动必须与入场动画同一条：插入时让位行的上缘要正好贴着揭开前沿走，
      // 换成别的曲线两者会错开几像素，透明背景的行就会看到文字重叠
      row.style.transition = `transform ${ms}ms var(--ease-out)`;
      row.style.transform = "";
      setTimeout(() => { row.style.transition = ""; }, ms + 30);
    }
  }

  // 退场只动 opacity/transform，不动高度——高度变化交给重渲后的 FLIP 吸合，
  // 两处同时做会让邻行位移两次。fill forwards 防退场结束到重渲之间闪回一帧。
  function dissolveSkillsRows(relPaths) {
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return Promise.resolve();
    const rows = relPaths.map(skillsRowByKey).filter(Boolean);
    if (!rows.length || !rows[0].animate) return Promise.resolve();
    return Promise.all(rows.map((row) => row.animate(
      [{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateX(-8px)" }],
      { duration: SKILLS_DISSOLVE_MS, easing: "ease-in", fill: "forwards" },
    ).finished)).then(() => {}, () => {});
  }

  // 滚到新行（居中）。手动改容器 scrollTop 而不用 scrollIntoView：后者会连带滚动
  // 页面级滚动容器，导入一条 skill 不该把整个面板推走。
  function centerSkillsRow(relPath) {
    const listEl = $("skillsList");
    const row = skillsRowByKey(relPath);
    if (!listEl || !row) return;
    const origin = listEl.getBoundingClientRect().top - listEl.scrollTop;
    const top = row.getBoundingClientRect().top - origin;
    listEl.scrollTop = Math.max(0, top - (listEl.clientHeight - row.offsetHeight) / 2);
  }

  // 插入落位：让位快照 → 选中新行（照普通左键语义：集合={新行}、焦点=首条，详情卡
  // 随之切过去）→ 重渲时 FLIP + 入场 → 滚到视野中央。新行按仓库序落在字母序中间，
  // 不定位的话动画就发生在折叠区外。收数组是为批量导入（一次插多行）；空集即
  // 「本次没有新行」，退化为朴素刷新，与 refreshAfterSkillsRemove 的失败路径对称。
  async function revealSkillsInsert(relPaths) {
    if (!relPaths.length) {
      await refreshSkillsState();
      return;
    }
    skillsFlipTops = skillsListTops();
    skillsFlipMs = SKILLS_INSERT_MS;
    skillsRevealKeys = new Set(relPaths);
    skillsSelection.clear();
    for (const key of relPaths) skillsSelection.add(key);
    skillsFocusKey = relPaths[0];
    await refreshSkillsState();
    // 批量时新行散落在字母序各处，居中最靠上的那条，其余顺着往下就在视野里
    const listEl = $("skillsList");
    const topmost = listEl
      ? [...listEl.children].find((row) => relPaths.includes(row.getAttribute("data-skill")))
      : null;
    centerSkillsRow(topmost ? topmost.getAttribute("data-skill") : relPaths[0]);
  }

  // 删除抽出：退场 → 重渲 → 缺口吸合。传空集即失败路径——行还在服务端，
  // 不退场，直接重渲与真实状态对齐。
  async function refreshAfterSkillsRemove(relPaths) {
    if (!relPaths.length) {
      await refreshSkillsState();
      return;
    }
    const tops = skillsListTops();
    await dissolveSkillsRows(relPaths);
    skillsFlipTops = tops;
    skillsFlipMs = SKILLS_DELETE_FLIP_MS;
    await refreshSkillsState();
  }

  // 形参收整个 skill 而不是 dirName：删除接口按 dirName 定位，行按 relPath 定位，
  // 嵌套 skill（relPath = relative(repoPath, dir)）下两者不相等。
  function confirmDeleteSkill(skill) {
    showSkillsModal({
      title: "删除仓库 Skill",
      danger: true,
      bodyHtml: `将把 <b>${escapeHtml(skill.dirName)}</b> 从主仓库移入回收站，并清除所有 Agent 上指向它的链接。Agent 上的真实目录不受影响。`,
      confirmText: "移入回收站",
      onConfirm: async () => {
        let removed = [];
        try {
          const d = await api("POST", "/api/skills/repo/delete", { skillName: skill.dirName });
          toast(d.unlinked && d.unlinked.length ? `已删除，并清除 ${d.unlinked.length} 处 Agent 链接` : "已删除");
          removed = [skill.relPath];
        } catch (e) {
          toast(panelError(e, "删除失败"), true);
        }
        await refreshAfterSkillsRemove(removed);
      },
    });
  }

  // ── 卡片 C：选中 skill 的详情与部署（右列上） ──
  function renderSkillDetail() {
    const body = $("skillsDetailBody");
    const skills = (skillsState && skillsState.skills) || [];
    const skill = skills.find((s) => s.relPath === skillsFocusKey) || null;
    // 无选中时整卡收起；下方 empty-hint 仅作结构兜底（正常不可见）
    const card = body.closest(".panel-card");
    if (card) card.hidden = !skill;
    if (!skill) {
      body.innerHTML = '<div class="empty-hint">从左侧列表选择一个 skill，查看详情并管理 Agent 部署</div>';
      return;
    }
    const endpoints = (skillsState && skillsState.endpoints) || [];
    const rows = endpoints.map((ep) => {
      const junctions = (ep.entries || []).filter((e) => e.kind === "junction");
      const deployed = junctions.some((e) => !e.broken && e.repoSkill === skill.dirName);
      // 只有两种状态：已部署 / 未部署。目录还不存在的（Agent 装好但从未部署过）
      // 首次部署会自建目录，就是「未部署」；未安装的 Agent 由服务端从清单里滤掉，
      // 不再出现在这里。
      const stateBadge = deployed
        ? '<span class="badge badge-ok">已部署</span>'
        : '<span class="badge badge-neutral">未部署</span>';
      return `<div class="skills-skill-row">
        <span class="skills-skill-name">${escapeHtml(ep.label)} ${stateBadge}</span>
        <label class="toggle"><input type="checkbox" data-deploy="${escapeHtml(ep.id)}"${deployed ? " checked" : ""}><span class="slider"></span></label>
      </div>`;
    }).join("");
    // 同名目录的 skill 共用部署键（junction 按 dirName 匹配），无法区分部署的是哪一份
    const dupCount = skills.filter((s) => s.dirName === skill.dirName).length;
    const dupWarn = dupCount > 1
      ? `<div class="skills-dup-warn">⚠ 仓库中有 ${dupCount} 个目录名为 <b>${escapeHtml(skill.dirName)}</b> 的 skill；部署与状态按目录名匹配，对这些条目无法区分彼此，建议删除或重命名多余副本。</div>`
      : "";
    body.innerHTML = `
      <div class="skills-detail-head">
        <div class="skills-detail-name">${escapeHtml(skill.name)}</div>
        <div class="skills-detail-actions">
          <button class="btn skills-fav-btn${skillsFavorites.has(skill.relPath) ? " on" : ""}" id="skillsDetailFavBtn"
            title="${skillsFavorites.has(skill.relPath) ? "取消收藏" : "收藏"}">${skillsFavorites.has(skill.relPath) ? "★ 已收藏" : "☆ 收藏"}</button>
          <button class="btn btn-danger" id="skillsDetailDeleteBtn">删除 skill</button>
        </div>
      </div>
      <div class="skills-detail-relpath">${escapeHtml(skill.relPath)}</div>
      <div class="skills-detail-desc">${escapeHtml(skill.description || "（无描述）")}</div>
      ${dupWarn}
      <div class="skills-group-title skills-group-title-row" style="margin-top:0; padding-top:0; border-top:none;">
        <span>部署到 Agent</span>
        <span class="skills-batch-actions">
          <button class="btn btn-mini btn-accent" id="skillsDeployAllBtn">全部部署</button>
          <button class="btn btn-mini btn-warn" id="skillsUndeployAllBtn">全部解除</button>
        </span>
      </div>
      ${rows}`;
    body.querySelectorAll("input[data-deploy]").forEach((input) => {
      input.onchange = () => {
        // 请求未完成前禁用，避免连点造成并发部署/乱序刷新（表现为开关"回抽"）
        input.disabled = true;
        toggleDeploy(input.getAttribute("data-deploy"), skill.dirName, input.checked, input);
      };
    });
    $("skillsDetailDeleteBtn").onclick = () => confirmDeleteSkill(skill);
    $("skillsDetailFavBtn").onclick = () => toggleSkillFavorite(skill.relPath);
    $("skillsDeployAllBtn").onclick = (e) => setAllDeployments(skill, true, e.target);
    $("skillsUndeployAllBtn").onclick = (e) => setAllDeployments(skill, false, e.target);
  }

  // 部署/解除的共用核心：对 skills × 各自目标 Agent 串行调单点接口。
  // 端点清单由服务端按「装在本机」过滤（未安装的 Agent 不在列），这里不再看
  // 目录是否存在——装好但没部署过的 Agent 首次部署会自建目录。已是目标状态
  // 跳过；部署遇本地冲突不强制、计数跳过留给用户逐条处理（与单点 toggle 的
  // 冲突语义一致）。返回计数由调用方包装 toast。
  async function runDeployBatch(skills, on) {
    let okCount = 0, conflictCount = 0, failCount = 0, targetCount = 0;
    for (const skill of skills) {
      const endpoints = (skillsState && skillsState.endpoints) || [];
      const targets = endpoints.filter((ep) => {
        const junctions = (ep.entries || []).filter((e) => e.kind === "junction");
        const deployed = junctions.some((e) => !e.broken && e.repoSkill === skill.dirName);
        return on ? !deployed : deployed;
      });
      targetCount += targets.length;
      for (const ep of targets) {
        try {
          const d = await api("POST", on ? "/api/skills/deploy" : "/api/skills/undeploy",
            { endpointId: ep.id, skillName: skill.dirName });
          if (on && d && d.conflict) conflictCount++;
          else okCount++;
        } catch {
          failCount++;
        }
      }
    }
    return { okCount, conflictCount, failCount, targetCount };
  }

  // 一键全开/关：单 skill × 所有已安装的 Agent，复用 runDeployBatch。
  async function setAllDeployments(skill, on, btn) {
    if (btn) btn.disabled = true;
    const { okCount, conflictCount, failCount, targetCount } = await runDeployBatch([skill], on);
    if (!targetCount) {
      toast(on ? "已安装的 Agent 都已部署" : "没有已部署的 Agent");
    } else {
      const parts = [on ? `已部署到 ${okCount} 个 Agent` : `已解除 ${okCount} 个 Agent`];
      if (conflictCount) parts.push(`${conflictCount} 个因本地冲突跳过`);
      if (failCount) parts.push(`${failCount} 个失败`);
      toast(parts.join("，"), failCount > 0);
      await refreshSkillsState();
    }
    if (btn && btn.isConnected) btn.disabled = false;
  }

  // ── 伪资源管理器：右键菜单 + 多选批量操作 ──
  // 菜单是挂到 body 的绝对定位 div（非浏览器默认菜单）；点击项执行并关闭，
  // 点菜单外 / Esc / 列表滚动时关闭（监听挂在 initSkillsTab）。

  function hideSkillsContextMenu() {
    const menu = $("skillsCtxMenu");
    if (menu) menu.remove();
  }

  // 全选：集合 = 过滤后全部可见行；焦点不变（只要它还存在，即使当前不可见）
  function selectAllVisibleSkills() {
    skillsSelection.clear();
    visibleSkills().forEach((s) => skillsSelection.add(s.relPath));
    renderSkillsList();
  }

  function showSkillsContextMenu(x, y, mode, key) {
    hideSkillsContextMenu();
    const skill = key
      ? ((skillsState && skillsState.skills) || []).find((s) => s.relPath === key)
      : null;
    const items = [];
    let title = "";
    if (mode === "multi") {
      title = `已选 ${skillsSelection.size} 项`;
      items.push(
        { label: "部署选中项到所有 Agent", fn: () => batchSetDeployments(true) },
        { label: "解除选中项的所有部署", fn: () => batchSetDeployments(false) },
        { label: "全选", fn: selectAllVisibleSkills },
        { label: "取消选择", fn: () => { skillsSelection.clear(); skillsFocusKey = null; renderSkillsList(); renderSkillDetail(); } },
        // harness 按固定索引点前面几项，前面的项不要增删或换序；「删除选中项」固定在最末尾
        { label: "收藏全部", fn: () => setFavoritesForSelection(true) },
        { label: "取消收藏全部", fn: () => setFavoritesForSelection(false) },
        { label: "删除选中项", danger: true, fn: confirmDeleteSelectedSkills },
      );
    } else if (mode === "single" && skill) {
      items.push(
        { label: "查阅 skill 正文", fn: () => viewSkillBody(skill.relPath) },
        { label: "部署到所有 Agent", fn: () => setAllDeployments(skill, true, null) },
        { label: "从所有 Agent 解除", fn: () => setAllDeployments(skill, false, null) },
        { label: "全选", fn: selectAllVisibleSkills },
        // 同上：前面的项索引不要变；收藏项按当前行收藏态二选一，「删除 skill」固定在最末尾
        skillsFavorites.has(skill.relPath)
          ? { label: "取消收藏", fn: () => toggleSkillFavorite(skill.relPath) }
          : { label: "收藏", fn: () => toggleSkillFavorite(skill.relPath) },
        { label: "删除 skill", danger: true, fn: () => confirmDeleteSkill(skill) },
      );
    } else {
      // 列表空白处：只给「全选」
      items.push({ label: "全选", fn: selectAllVisibleSkills });
    }
    popSkillsContextMenu(x, y, title, items);
  }

  // 菜单 DOM 构建：挂到 body 的 fixed div，点击项执行并关闭（两侧列表共用）
  function popSkillsContextMenu(x, y, title, items) {
    const menu = document.createElement("div");
    menu.id = "skillsCtxMenu";
    menu.className = "skills-ctx-menu";
    menu.innerHTML = (title ? `<div class="skills-ctx-title">${escapeHtml(title)}</div>` : "") +
      items.map((it, i) =>
        `<div class="skills-ctx-item${it.danger ? " danger" : ""}${it.disabled ? " disabled" : ""}" data-idx="${i}"${it.disabled ? ` title="${escapeHtml(it.disabled)}"` : ""}>${escapeHtml(it.label)}</div>`
      ).join("");
    menu.querySelectorAll(".skills-ctx-item").forEach((el) => {
      el.onclick = () => {
        const it = items[Number(el.getAttribute("data-idx"))];
        hideSkillsContextMenu();
        if (it.disabled) { toast(it.disabled, true); return; }
        it.fn();
      };
    });
    document.body.appendChild(menu);
    // 防止菜单超出视口右/下边缘
    menu.style.left = Math.min(x, window.innerWidth - menu.offsetWidth - 8) + "px";
    menu.style.top = Math.min(y, window.innerHeight - menu.offsetHeight - 8) + "px";
  }

  // 批量转托管/导入：对同组选中项串行走既有 merge-local（单项确认语义
  // 合并为一个列表弹窗）；分叉冲突项后端会回 conflict，计数跳过留给
  // 「分叉冲突」分组处理。
  function confirmBatchMergeLocal(items, kind) {
    const isMatching = kind === "matching";
    const listHtml = items.map((it) =>
      `<div>· <b>${escapeHtml(it.entry.name)}</b>（${escapeHtml(it.ep.label)}）</div>`).join("");
    showSkillsModal({
      title: isMatching ? `批量转为主仓库托管（${items.length} 项）` : `批量导入主仓库（${items.length} 项）`,
      danger: false,
      bodyHtml: (isMatching
        ? "以下目录与主仓库内容一致，不复制文件：原目录将移入回收站（可恢复），原位改为指向主仓库副本的链接。"
        : "以下目录将逐项复制到主仓库（.git 除外）；随后原目录移入回收站（可恢复），原位改为链接指向主仓库副本。")
        + `<div style="margin-top:8px;">${listHtml}</div>`,
      confirmText: isMatching ? "转为托管" : "导入",
      onConfirm: async () => {
        let okCount = 0, conflictCount = 0, failCount = 0;
        let firstError = "";
        const inserted = [];
        for (const it of items) {
          try {
            const d = await api("POST", "/api/skills/merge-local", { endpointId: it.ep.id, skillName: it.entry.name });
            // 转托管（reusedRepoCopy）复用仓库既有副本、只把本地目录换成 junction，
            // 没有新行；只有导入才真的往仓库里插一条
            if (d.conflict) conflictCount++;
            else { okCount++; if (!d.reusedRepoCopy) inserted.push(it.entry.name); }
          } catch (e) { failCount++; if (!firstError) firstError = panelError(e, "详见面板日志"); }
        }
        const parts = [`成功 ${okCount}`];
        if (conflictCount) parts.push(`${conflictCount} 个分叉冲突跳过（请到分叉冲突分组处理）`);
        if (failCount) parts.push(`失败 ${failCount}`);
        // 失败必须显式报错：数量之外给出首个失败原因
        if (failCount) parts.push(`操作失败：${firstError}`);
        toast(parts.join("、"), failCount > 0);
        anomalyChecked[kind].clear();
        // 批量导入的新行散落在字母序各处：一次 FLIP 让位 + 逐行入场；
        // 空集（批量转托管 / 全失败）退化为朴素刷新
        await revealSkillsInsert(inserted);
      },
    });
  }

  // 删除 Agent 本地实体目录（回收站语义，禁止硬删，走 /api/skills/local/delete）。
  // unique 组是该 skill 唯一副本，提示仅从回收站可恢复；matching 组仓库仍有副本。
  function confirmDeleteAnomalyItems(items) {
    if (!items.length) return;
    const uniqCount = items.filter((it) => it.group === "unique").length;
    const listHtml = items.map((it) =>
      `<div>· <b>${escapeHtml(it.entry.name)}</b>（${escapeHtml(it.ep.label)}${it.group === "unique" ? "，唯一副本" : "，仓库仍有副本"}）</div>`).join("");
    const notes = [];
    if (uniqCount) {
      notes.push(items.length === 1
        ? "这是该 skill 唯一副本，删除后仅从回收站可恢复。"
        : `其中 ${uniqCount} 项是该 skill 唯一副本，删除后仅从回收站可恢复。`);
    }
    if (uniqCount < items.length) notes.push("一致可迁移项主仓库仍有副本，删除本地目录不影响仓库内容。");
    showSkillsModal({
      title: items.length === 1 ? "删除本地目录" : `删除选中的 ${items.length} 个本地目录`,
      danger: true,
      bodyHtml: `将把以下真实目录移入回收站：<div style="margin-top:8px;">${listHtml}</div><div style="margin-top:8px; color:var(--danger);">${notes.join("<br>")}</div>`,
      confirmText: "移入回收站",
      onConfirm: async () => {
        let okCount = 0, failCount = 0;
        let firstError = "";
        const okItems = [];
        for (const it of items) {
          try {
            await api("POST", "/api/skills/local/delete", { endpointId: it.ep.id, skillName: it.entry.name });
            okCount++;
            okItems.push(it);
          } catch (e) { failCount++; if (!firstError) firstError = panelError(e, "详见面板日志"); }
        }
        // 失败必须显式报错：数量之外给出首个失败原因
        toast(failCount
          ? `删除完成：成功 ${okCount}、失败 ${failCount}。首个失败原因：${firstError}`
          : `已删除 ${okCount} 个本地目录`, failCount > 0);
        anomalyChecked.matching.clear();
        anomalyChecked.unique.clear();
        // 乐观更新：回收站删除每条约 1-3s，先把成功项从本地 state 移除并立即
        // 重渲染让列表即时反映，随后 refreshSkillsState 与服务端真实状态对齐
        if (okItems.length && skillsState && skillsState.endpoints) {
          const removed = new Set(okItems.map((it) => `${it.ep.id}\x01${it.entry.name}`));
          const epTargets = [
            ...skillsState.endpoints,
            ...(skillsState.globalEndpoint ? [skillsState.globalEndpoint] : []),
          ];
          for (const ep of epTargets) {
            ep.entries = (ep.entries || []).filter((entry) => !removed.has(`${ep.id}\x01${entry.name}`));
          }
          renderSkillsAnomalies();
        }
        await refreshSkillsState();
      },
    });
  }

  // 查阅 SKILL.md 正文（契约：POST /api/skills/body { relPath } → { ok, name, content }）
  async function viewSkillBody(relPath) {
    try {
      const d = await api("POST", "/api/skills/body", { relPath });
      showSkillsModal({
        title: `Skill 正文：${d.name}`,
        danger: false,
        wide: true, // 长文加宽弹窗
        bodyHtml: `<div class="skills-body-view">${renderSkillMarkdown(d.content)}</div>`,
        confirmText: "关闭",
        onConfirm: null,
      });
    } catch (e) {
      toast(panelError(e, "读取 skill 正文失败"), true);
    }
  }

  // ── 极简 markdown 渲染（零依赖，仅供 SKILL.md 正文查阅） ──
  // 安全管线：静默剥 frontmatter → 全文 escapeHtml → 提取代码块/行内代码为占位符
  // → 块级（标题/列表/段落）与行内（链接/加粗/斜体）变换 → 还原占位符。
  function renderSkillMarkdown(md) {
    // SKILL.md 开头的 YAML frontmatter 静默剥掉（modal 标题已显示 skill 名）
    let text = String(md || "").replace(/^\ufeff?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, "");
    // 先全文转义：md 里的 <script> / <img onerror> 等只会渲染成无害文本
    text = escapeHtml(text);
    // 代码块 / 行内代码先提取为占位符，行内格式做完再还原，避免代码内容被加粗等规则误伤
    const stashed = [];
    const stash = (html) => `\x00${stashed.push(html) - 1}\x00`;
    text = text
      .replace(/```[^\n\r]*\r?\n([\s\S]*?)\r?\n?```/g, (m, code) =>
        stash(`<pre class="md-code"><code>${code}</code></pre>`))
      .replace(/`([^`\r\n]+)`/g, (m, code) =>
        stash(`<code class="md-inline">${code}</code>`));
    const inline = (s) => s
      .replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, (m, label, url) => {
        // href 只放行 http/https；javascript: 等其他协议降级为纯文本
        if (!/^https?:\/\//i.test(url)) return label;
        // escapeHtml 不转引号，进入 href 属性前另防引号逃逸
        const safeUrl = url.replace(/"/g, "%22").replace(/'/g, "%27");
        return `<a href="${safeUrl}" target="_blank" rel="noopener">${label}</a>`;
      })
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
    // 块级：逐行扫描，标题 #~####、无序/有序列表、空行分段
    const blocks = [];
    let para = [];
    let list = null;
    const flushPara = () => {
      if (para.length) { blocks.push(`<p>${para.map(inline).join("<br>")}</p>`); para = []; }
    };
    const flushList = () => {
      if (list) {
        blocks.push(`<${list.type}>${list.items.map((it) => `<li>${inline(it)}</li>`).join("")}</${list.type}>`);
        list = null;
      }
    };
    for (const line of text.split(/\r?\n/)) {
      if (/^\x00\d+\x00$/.test(line)) { // 代码块占位符独占一行，原样放行
        flushPara(); flushList(); blocks.push(line); continue;
      }
      const h = line.match(/^(#{1,4})\s+(.*)$/);
      if (h) {
        flushPara(); flushList();
        blocks.push(`<h${h[1].length} class="md-h">${inline(h[2])}</h${h[1].length}>`);
        continue;
      }
      const ul = line.match(/^\s*[-*+]\s+(.*)$/);
      if (ul) {
        flushPara();
        if (!list || list.type !== "ul") { flushList(); list = { type: "ul", items: [] }; }
        list.items.push(ul[1]);
        continue;
      }
      const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
      if (ol) {
        flushPara();
        if (!list || list.type !== "ol") { flushList(); list = { type: "ol", items: [] }; }
        list.items.push(ol[1]);
        continue;
      }
      if (!line.trim()) { flushPara(); flushList(); continue; }
      flushList();
      para.push(line);
    }
    flushPara();
    flushList();
    return blocks.join("\n").replace(/\x00(\d+)\x00/g, (m, i) => stashed[Number(i)]);
  }

  // 批量部署/解除：选中 skills × 所有已启用端点，复用 runDeployBatch。
  async function batchSetDeployments(on) {
    if (skillsBatchBusy) return;
    const skills = ((skillsState && skillsState.skills) || []).filter((s) => skillsSelection.has(s.relPath));
    if (!skills.length) return;
    skillsBatchBusy = true;
    let result;
    try {
      result = await runDeployBatch(skills, on);
    } finally {
      skillsBatchBusy = false;
    }
    toast(`${skills.length} 个 skill：成功 ${result.okCount}、冲突跳过 ${result.conflictCount}、失败 ${result.failCount}`, result.failCount > 0);
    await refreshSkillsState();
  }

  // 多选删除：红色确认列出将删除的 skill，确认后逐个走既有 repo/delete（回收站语义）。
  // 删除接口按 dirName 定位，同名目录的 skill 无法区分目标——歧义项跳过不删
  // （防选中一份误删另一份 / 选中两份同名发重复请求），留详情卡逐条处理。
  function confirmDeleteSelectedSkills() {
    const all = (skillsState && skillsState.skills) || [];
    const selected = all.filter((s) => skillsSelection.has(s.relPath));
    if (!selected.length) return;
    const dirNameCounts = new Map();
    for (const s of all) dirNameCounts.set(s.dirName, (dirNameCounts.get(s.dirName) || 0) + 1);
    const deletable = selected.filter((s) => dirNameCounts.get(s.dirName) === 1);
    const skippedCount = selected.length - deletable.length;
    if (!deletable.length) {
      // 全部选中项都歧义：不发任何请求
      toast(`${skippedCount} 个同名条目因无法区分已跳过，未删除任何 skill；请在详情卡单独处理`, true);
      return;
    }
    const listHtml = deletable.map((s) =>
      `<div>· <b>${escapeHtml(s.name)}</b>（${escapeHtml(s.relPath)}）</div>`).join("");
    const skippedNote = skippedCount
      ? `<div style="margin-top:8px; color:var(--danger);">${skippedCount} 个同名条目因无法区分已跳过，请在详情卡单独处理。</div>`
      : "";
    showSkillsModal({
      title: `删除选中的 ${deletable.length} 个 Skill`,
      danger: true,
      bodyHtml: `将把以下 skill 从主仓库移入回收站，并清除所有 Agent 上指向它们的链接。Agent 上的真实目录不受影响。<div style="margin-top:8px;">${listHtml}</div>${skippedNote}`,
      confirmText: "移入回收站",
      onConfirm: async () => {
        let failCount = 0;
        const removed = [];
        for (const s of deletable) {
          try {
            await api("POST", "/api/skills/repo/delete", { skillName: s.dirName });
            removed.push(s.relPath);
          } catch {
            failCount++;
          }
        }
        toast(failCount ? `删除完成：成功 ${removed.length}、失败 ${failCount}` : `已删除 ${removed.length} 个 skill`, failCount > 0);
        // 多行一起退场，随后一次 FLIP 把所有缺口吸合（每行的位移已含其上方全部删除量）
        await refreshAfterSkillsRemove(removed);
      },
    });
  }

  // ── 卡片 D：Agent 条目与异常（跨 Agent 全局聚合，右列下） ──
  function renderSkillsAnomalies() {
    const body = $("skillsAnomalyBody");
    const badge = $("skillsAnomalyBadge");
    // Agent 端点之外并入全局目录（globalEndpoint 单列字段）：这里的职责是
    // 识别与治理各目录里的本地技能/失效链接，全局目录属于这一面——它不进
    // 部署名单（endpoints），只进这里。
    const agentEps = (skillsState && skillsState.endpoints) || [];
    const globalEp = skillsState && skillsState.globalEndpoint;
    const endpoints = globalEp ? [globalEp, ...agentEps] : agentEps;
    const broken = [];   // 失效链接（指向主仓库的链接已断）
    const diverged = []; // 分叉冲突（matchesRepo === false）
    const matching = []; // 一致可迁移（matchesRepo === true）
    const unique = [];   // 本地独有（matchesRepo === null）
    for (const ep of endpoints) {
      for (const entry of ep.entries || []) {
        if (entry.kind === "junction" && entry.broken) broken.push({ ep, entry });
        if (entry.kind !== "local") continue;
        if (entry.matchesRepo === false) diverged.push({ ep, entry });
        else if (entry.matchesRepo === true) matching.push({ ep, entry });
        else unique.push({ ep, entry });
      }
    }
    const total = broken.length + diverged.length + matching.length + unique.length;
    badge.hidden = total === 0;
    badge.textContent = `${total} 项`;
    badge.className = "badge " + (broken.length + diverged.length ? "badge-warn" : "badge-neutral");
    if (!total) {
      body.innerHTML = '<div class="empty-hint">没有异常或 Agent 条目</div>';
      return;
    }

    // 键用 SOH(\x01) 分隔端点 id 与条目名（两端都可能含空格，\x01 不可能出现）
    const SEP = "\x01";
    const key = (ep, entry) => escapeHtml(`${ep.id}${SEP}${entry.name}`);
    // 勾选集合 prune：matching/unique 已消失的复合键不再保留
    // （与左侧 reconcileSkillsSelection 同思路）；itemByKey 供行内按钮与批量操作查找
    const itemByKey = new Map();
    const validKeys = new Set();
    for (const [group, arr] of [["matching", matching], ["unique", unique]]) {
      for (const { ep, entry } of arr) {
        const k = `${ep.id}${SEP}${entry.name}`;
        validKeys.add(k);
        itemByKey.set(k, { ep, entry, group });
      }
    }
    for (const group of ["matching", "unique"]) {
      for (const k of [...anomalyChecked[group]]) if (!validKeys.has(k)) anomalyChecked[group].delete(k);
    }

    const rowHtml = (ep, entry, badgeHtml, actionsHtml) => `<div class="skills-anomaly-row">
      <span class="skills-anomaly-label">
        <span class="skills-anomaly-ep">${escapeHtml(ep.label)}</span>
        <span class="skills-anomaly-name" title="${escapeHtml(entry.name)}">${escapeHtml(entry.name)}</span>
        ${badgeHtml}
      </span>
      <span class="skills-anomaly-actions">${actionsHtml}</span>
    </div>`;
    // matching/unique 条目行：点主体即选中的待处理清单（行高光 + 行内操作按钮），
    // 无右键菜单——这两组是待处理项，不做伪资源管理器交互
    const taskRow = (ep, entry, group) => {
      const k = `${ep.id}${SEP}${entry.name}`;
      const adoptBtn = group === "matching"
        ? `<button class="btn btn-mini" data-adopt="${escapeHtml(k)}" data-kind="matching">转为主仓库托管</button>`
        : `<button class="btn btn-mini" data-adopt="${escapeHtml(k)}" data-kind="unique">导入主仓库</button>`;
      return `<div class="skills-anomaly-row skills-anomaly-task${anomalyChecked[group].has(k) ? " selected" : ""}" data-atask="${group}" data-key="${escapeHtml(k)}">
        <span class="skills-anomaly-label">
          <span class="skills-anomaly-ep">${escapeHtml(ep.label)}</span>
          <span class="skills-anomaly-name" title="${escapeHtml(entry.name)}">${escapeHtml(entry.name)}</span>
        </span>
        <span class="skills-anomaly-actions">${adoptBtn}<button class="btn btn-danger btn-mini" data-del="${escapeHtml(k)}">删除</button></span>
      </div>`;
    };
    const firstStyle = ' style="margin-top:0; padding-top:0; border-top:none;"';
    // matching/unique 两组可折叠：标题行可点击翻转 anomalyFold 并重渲染，
    // 条目包进 fold body 按状态显隐；首-section 清零样式仍落在标题元素上。
    // 标题行右侧放本组「全选」文本按钮；有勾选时显示批量操作条（均不触发折叠）。
    // 收起时隐藏全选按钮与批量条，且勾选等中间状态在收起动作中清回默认
    const foldSection = (foldKey, title, count, rowsHtml) => {
      const folded = anomalyFold[foldKey];
      const checkedCount = anomalyChecked[foldKey].size;
      const batchBar = !folded && checkedCount
        ? `<span class="skills-anomaly-batch">已选 ${checkedCount} 项` +
          `<button class="btn btn-mini" data-batch-merge="${foldKey}">${foldKey === "matching" ? "批量转托管" : "批量导入"}</button>` +
          `<button class="btn btn-danger btn-mini" data-batch-del="${foldKey}">删除</button></span>`
        : "";
      // 全选做成文本按钮放标题行右侧：勾选框语义不明显。全选后变「取消全选」
      const allSelected = count > 0 && checkedCount === count;
      const selectAllBtn = folded ? "" :
        `<button type="button" class="skills-anomaly-selectall${allSelected ? " on" : ""}" data-aselect-all="${foldKey}" title="${allSelected ? "取消本组全选" : "选中本组全部条目"}">${allSelected ? "取消全选" : "全选"}</button>`;
      return `<div class="skills-group-title skills-anomaly-fold"${sections.length ? "" : firstStyle} data-fold="${foldKey}">` +
        `<span>${title}</span>` +
        `<span class="skills-anomaly-fold-side">${batchBar}${selectAllBtn}` +
        `<span class="skills-anomaly-fold-hint">${folded ? `▸ 展开 · ${count} 项` : "▾ 收起"}</span></span></div>` +
        `<div class="skills-anomaly-fold-body"${folded ? " hidden" : ""}>${rowsHtml}</div>`;
    };
    const sections = [];
    if (broken.length) {
      sections.push(
        `<div class="skills-group-title"${sections.length ? "" : firstStyle}>失效链接</div>` +
        broken.map(({ ep, entry }) => rowHtml(ep, entry,
          '<span class="badge badge-warn">失效</span>',
          `<button class="btn btn-mini" data-remove-broken="${key(ep, entry)}">移除</button>`)).join(""),
      );
    }
    if (diverged.length) {
      sections.push(
        `<div class="skills-group-title"${sections.length ? "" : firstStyle}>分叉冲突（与仓库同名但内容不同）</div>` +
        diverged.map(({ ep, entry }) => rowHtml(ep, entry,
          '<span class="badge badge-danger">分叉冲突</span>',
          `<button class="btn btn-mini" data-diff="${key(ep, entry)}">查看差异</button>` +
          `<button class="btn btn-mini" data-resolve-repo="${key(ep, entry)}">以主仓库覆盖${skillsSourceIsGlobal(ep.id) ? "全局目录" : " Agent"}</button>` +
          `<button class="btn btn-danger btn-mini" data-resolve-local="${key(ep, entry)}">以${skillsSourceIsGlobal(ep.id) ? "全局目录" : " Agent"}覆盖主仓库</button>`)).join(""),
      );
    }
    if (matching.length) {
      sections.push(foldSection("matching", "一致可迁移（内容与仓库相同）", matching.length,
        matching.map(({ ep, entry }) => taskRow(ep, entry, "matching")).join(""),
      ));
    }
    if (unique.length) {
      sections.push(foldSection("unique", "本地独有（仓库中没有同名 skill）", unique.length,
        unique.map(({ ep, entry }) => taskRow(ep, entry, "unique")).join(""),
      ));
    }
    body.innerHTML = sections.join("");
    applyAnomalyCardFold(); // 重建卡身时把折叠态再压一遍，展开/收起不随刷新回落

    body.querySelectorAll("button[data-remove-broken]").forEach((btn) => {
      btn.onclick = () => removeBrokenJunction(...btn.getAttribute("data-remove-broken").split(SEP));
    });
    body.querySelectorAll("button[data-diff]").forEach((btn) => {
      // 弹窗右栏要写目录的显示名（ZCode / Kimi Code…），不写 claude 那种内部 id；
      // 全局目录不在 endpoints 名单里，查名时把 globalEndpoint 一并纳入
      btn.onclick = () => {
        const [endpointId, skillName] = btn.getAttribute("data-diff").split(SEP);
        const pool = [
          ...(skillsState.endpoints || []),
          ...(skillsState.globalEndpoint ? [skillsState.globalEndpoint] : []),
        ];
        const label = pool.find((e) => e.id === endpointId)?.label;
        showLocalDiff(endpointId, skillName, label);
      };
    });
    body.querySelectorAll("button[data-resolve-repo]").forEach((btn) => {
      const [endpointId, skillName] = btn.getAttribute("data-resolve-repo").split(SEP);
      btn.onclick = () => resolveConflict(endpointId, skillName, "repo");
    });
    body.querySelectorAll("button[data-resolve-local]").forEach((btn) => {
      const [endpointId, skillName] = btn.getAttribute("data-resolve-local").split(SEP);
      btn.onclick = () => resolveConflict(endpointId, skillName, "local");
    });
    // 折叠标题：翻转外置状态并重渲染（innerHTML 重建后需重新绑定）；
    // 点击标题内的全选/批量按钮不触发折叠。收起时清掉该组勾选等中间状态，
    // 下次展开回到默认（收起后全选按钮与批量条也不再渲染）
    body.querySelectorAll(".skills-anomaly-fold[data-fold]").forEach((titleEl) => {
      titleEl.onclick = (e) => {
        if (e.target.closest("button")) return;
        const k = titleEl.getAttribute("data-fold");
        anomalyFold[k] = !anomalyFold[k];
        if (anomalyFold[k]) anomalyChecked[k].clear();
        renderSkillsAnomalies();
      };
    });
    // matching/unique 行级点选与行内操作（同样需在 innerHTML 重建后重新绑定）
    body.querySelectorAll(".skills-anomaly-task").forEach((rowEl) => {
      rowEl.onclick = (e) => {
        if (e.target.closest("button")) return; // 行内「转为主仓库托管/导入/删除」按钮不触发选中
        const group = rowEl.getAttribute("data-atask");
        const k = rowEl.getAttribute("data-key");
        if (anomalyChecked[group].has(k)) anomalyChecked[group].delete(k); else anomalyChecked[group].add(k);
        renderSkillsAnomalies(); // 批量入口显隐/计数与全选按钮状态依赖重渲染；折叠态外置不受影响
      };
    });
    body.querySelectorAll("button[data-aselect-all]").forEach((btn) => {
      const group = btn.getAttribute("data-aselect-all");
      btn.onclick = () => {
        const groupKeys = [...validKeys].filter((k) => itemByKey.get(k).group === group);
        // 已全选则全部取消，否则选中本组全部条目
        const wasAllSelected = groupKeys.length > 0 && anomalyChecked[group].size === groupKeys.length;
        anomalyChecked[group].clear();
        if (!wasAllSelected) for (const k of groupKeys) anomalyChecked[group].add(k);
        renderSkillsAnomalies();
      };
    });
    body.querySelectorAll("button[data-adopt]").forEach((btn) => {
      const [endpointId, skillName] = btn.getAttribute("data-adopt").split(SEP);
      btn.onclick = () => mergeLocal(endpointId, skillName, btn.getAttribute("data-kind"));
    });
    body.querySelectorAll("button[data-del]").forEach((btn) => {
      btn.onclick = () => {
        const it = itemByKey.get(btn.getAttribute("data-del"));
        if (it) confirmDeleteAnomalyItems([it]);
      };
    });
    body.querySelectorAll("button[data-batch-merge]").forEach((btn) => {
      const group = btn.getAttribute("data-batch-merge");
      btn.onclick = () => confirmBatchMergeLocal(
        [...anomalyChecked[group]].map((k) => itemByKey.get(k)).filter(Boolean), group);
    });
    body.querySelectorAll("button[data-batch-del]").forEach((btn) => {
      const group = btn.getAttribute("data-batch-del");
      btn.onclick = () => confirmDeleteAnomalyItems(
        [...anomalyChecked[group]].map((k) => itemByKey.get(k)).filter(Boolean));
    });
  }

  // 失效链接只删链接；undeploy 的 rmdir 语义对 broken 目标同样成立。
  function removeBrokenJunction(endpointId, skillName) {
    showSkillsModal({
      title: "移除失效链接",
      danger: true,
      bodyHtml: `将移除 ${skillsSourcePhrase(endpointId)}指向 <b>${escapeHtml(skillName)}</b> 的失效链接（只删链接，不影响任何真实目录）。`,
      confirmText: "移除",
      onConfirm: async () => {
        try {
          await api("POST", "/api/skills/undeploy", { endpointId, skillName });
          toast("已移除失效链接");
        } catch (e) {
          toast(panelError(e, "移除失败"), true);
        }
        refreshSkillsState();
      },
    });
  }

  async function fetchLocalDiffs(endpointId, skillName) {
    const d = await api("POST", "/api/skills/diff", { endpointId, skillName });
    return d.diffs || [];
  }

  // 「查看差异」两栏对照弹窗的正文，一个自包含函数（只依赖 escapeHtml）：
  // panel-skills.test.mjs 会把它从主脚本里抠出来直接执行，用后端真实形状的
  // payload 验两侧行号与着色类——光看源码结构的断言看不见这一层。
  // 左＝主仓库、右＝该 Agent。二进制 / 超限这些"没比"的文件同样进清单并写明原因，
  // 否则用户看到的是一份悄悄缩水过的差异。
  function skillDiffHtml(endpointId, skillName, files, epLabel) {
    const STATE_LABEL = {
      different: "内容不同",
      "only-repo": "仅仓库有",
      "only-endpoint": "仅 Agent 有",
      "eol-only": "只有换行符不同",
      binary: "未比对：二进制文件",
      oversize: "未比对：文件过大",
      "too-many": "未比对：本次要对照的文件太多",
      unreadable: "未比对：读不到文件",
    };
    const stateLabel = (f) => STATE_LABEL[f.state] || "未比对";
    // 四格：左行号 左正文 | 右行号 右正文。缺一侧的那格留空、由 CSS 铺底，
    // 两栏同处一行才不会对不上。
    const cell = (no, text, side) =>
      `<span class="sd-no sd-${side}">${no ?? ""}</span>` +
      `<span class="sd-tx sd-${side}">${text == null ? "" : escapeHtml(text)}</span>`;
    const rowHtml = (row) => {
      if (row.op === "gap") return `<div class="sd-gap">⋮ 中间 ${row.hidden} 行两侧一致，已折叠</div>`;
      const op = row.op === "mod" ? "mod" : row.op === "del" ? "del" : row.op === "ins" ? "ins" : "equal";
      return `<div class="sd-row sd-${op}">` +
        cell(row.aNo, row.aText, "a") + cell(row.bNo, row.bText, "b") + "</div>";
    };
    const fileHtml = (f) => {
      const stat = f.state === "different" ? `+${f.added ?? 0} −${f.removed ?? 0}` : "";
      const head = `<div class="sd-file-head"><code>${escapeHtml(f.path)}</code>` +
        `<span class="badge ${f.state === "different" ? "badge-neutral" : "badge-warn"}">${escapeHtml(stateLabel(f))}</span>` +
        (stat ? `<span class="sd-stat">${stat}</span>` : "") + "</div>";
      if (f.state !== "different") return `<section class="sd-file sd-file-flat">${head}</section>`;
      return `<section class="sd-file">${head}<div class="sd-body">${(f.rows || []).map(rowHtml).join("")}</div></section>`;
    };
    const diffFiles = files.filter((f) => f.state === "different");
    const changed = diffFiles.reduce((n, f) => n + (f.changed || 0), 0);
    const legend = `<div class="sd-legend">` +
      `<span class="sd-side">左 · 主仓库</span>` +
      `<span class="sd-side">右 · ${escapeHtml(epLabel || endpointId)}</span>` +
      `<span class="sd-stat">${files.length} 个文件不一致 · ${diffFiles.length} 个逐行对照 · 改动 ${changed} 行</span></div>`;
    if (!files.length) return `${legend}<div class="empty-hint">两侧内容一致，没有需要对照的文件</div>`;
    return `<div class="skills-diff">${legend}${files.map(fileHtml).join("")}</div>`;
  }

  // 差异弹窗：逐行左右对照由后端算好（后端知道两侧到底哪边是哪个目录），
  // 前端只负责把每一行摆进两栏里。
  async function showLocalDiff(endpointId, skillName, epLabel) {
    try {
      const d = await api("POST", "/api/skills/diff/content", { endpointId, skillName });
      showSkillsModal({
        title: `差异：${skillName}`,
        danger: false,
        diff: true,
        bodyHtml: skillDiffHtml(endpointId, skillName, d.files || [], epLabel),
        confirmText: "知道了",
        onConfirm: null,
      });
    } catch (e) {
      toast(panelError(e, "获取差异失败"), true);
    }
  }

  // 分叉冲突的两个显式方向；两个方向的终态都是 Agent 侧目录变 junction 指向主仓库。
  async function resolveConflict(endpointId, skillName, direction) {
    const isRepo = direction === "repo";
    const globalSrc = skillsSourceIsGlobal(endpointId);
    const src = skillsSourcePhrase(endpointId);
    let diffs = [];
    try {
      diffs = await fetchLocalDiffs(endpointId, skillName);
    } catch { /* 差异取不到也允许继续，确认框少一份清单而已 */ }
    showSkillsModal({
      title: isRepo
        ? (globalSrc ? "以主仓库覆盖全局目录" : "以主仓库覆盖 Agent")
        : (globalSrc ? "以全局目录覆盖主仓库" : "以 Agent 覆盖主仓库"),
      danger: true,
      bodyHtml: isRepo
        ? `${src}的真实目录 <b>${escapeHtml(skillName)}</b> 将移入回收站，并改为链接指向主仓库版本。${diffListHtml(diffs)}`
        : `主仓库中的 <b>${escapeHtml(skillName)}</b> 旧版本将先移入回收站（可恢复），再以 ${src}的内容覆盖；各端点上指向该 skill 的链接会自动跟到新内容。${diffListHtml(diffs)}`,
      confirmText: isRepo ? (globalSrc ? "覆盖全局目录" : "覆盖 Agent") : "覆盖主仓库",
      onConfirm: async () => {
        try {
          await api("POST", "/api/skills/resolve-conflict", { endpointId, skillName, direction });
          toast(isRepo
            ? `已以主仓库版本覆盖 ${skillsSourceName(endpointId)}`
            : globalSrc
              ? "已用全局目录中的版本覆盖主仓库（旧版在回收站）"
              : `已用 ${skillsSourceName(endpointId)} 上的版本覆盖主仓库（旧版在回收站）`);
        } catch (e) {
          toast(panelError(e, "覆盖失败"), true);
        }
        await refreshSkillsState();
      },
    });
  }

  // input 传入时负责其视觉回退：冲突/失败都把勾选态退回去（此时服务器没有改动），
  // 成功路径由随后的整体刷新重建 DOM，无需手动恢复。
  async function toggleDeploy(endpointId, skillName, on, input) {
    const revert = () => {
      if (input && input.isConnected) { input.checked = !on; input.disabled = false; }
    };
    try {
      if (on) {
        const d = await api("POST", "/api/skills/deploy", { endpointId, skillName });
        if (d.conflict) {
          revert(); // 未部署，退回未勾选再等用户决定
          showDeployConflict(endpointId, skillName, d.diffs || []);
          return; // 不刷新：等待用户在 modal 中决定
        }
        toast(`已部署到 ${skillsSourceName(endpointId)}`);
      } else {
        await api("POST", "/api/skills/undeploy", { endpointId, skillName });
        toast("已解除部署");
      }
    } catch (e) {
      revert();
      toast(panelError(e, on ? "部署失败" : "解除部署失败"), true);
      return; // 已回退勾选态，无需再刷新
    }
    await refreshSkillsState();
    // 刷新失败时旧 DOM 仍在（成功时元素已被重建，isConnected 为 false）
    if (input && input.isConnected) input.disabled = false;
  }

  function diffKindLabel(kind) {
    return kind === "only-a" ? "仅仓库有" : kind === "only-b" ? "仅 Agent 有" : "内容不同";
  }

  function diffListHtml(diffs) {
    if (!diffs.length) return "";
    return `<div class="skills-diff-list">${diffs.map((d) =>
      `<div class="skills-diff-row"><span>${escapeHtml(d.path)}</span><span>${diffKindLabel(d.kind)}</span></div>`
    ).join("")}</div>`;
  }

  function showDeployConflict(endpointId, skillName, diffs) {
    showSkillsModal({
      title: "Agent 目录与仓库不一致",
      danger: true,
      bodyHtml: `${skillsSourcePhrase(endpointId)}已存在同名的真实目录 <b>${escapeHtml(skillName)}</b>，内容与仓库不同。确认替换会将该目录移入回收站，并改为链接指向仓库版本。${diffListHtml(diffs)}`,
      confirmText: "替换为仓库版本",
      onConfirm: async () => {
        try {
          await api("POST", "/api/skills/deploy", { endpointId, skillName, force: true });
          toast(`已替换并部署到 ${skillsSourceName(endpointId)}`);
        } catch (e) {
          toast(panelError(e, "替换失败"), true);
        }
        refreshSkillsState();
      },
    });
  }

  // 转托管/导入前二次确认（danger=false：本地实体目录进回收站可恢复，无内容丢失）。
  // matching：内容一致不复制文件，本地实体目录回收后原位建指向主仓库副本的 junction；
  // unique：先复制进主仓库（过滤 .git），再回收本地建 junction。分叉冲突由前端分流到
  // resolve-conflict，正常走不到这里；后端 conflict 响应仍留兜底弹窗。
  function mergeLocal(endpointId, skillName, kind) {
    const isMatching = kind === "matching";
    const src = skillsSourcePhrase(endpointId);
    showSkillsModal({
      title: isMatching ? "转为主仓库托管" : "导入主仓库",
      danger: false,
      bodyHtml: isMatching
        ? `${src}的目录 <b>${escapeHtml(skillName)}</b> 与主仓库内容一致，不会复制文件：该目录将移入回收站（可恢复），原位改为链接指向主仓库副本，此后以主仓库为唯一来源。`
        : `将把 ${src}的目录 <b>${escapeHtml(skillName)}</b> 复制到主仓库（.git 除外）；随后该目录移入回收站（可恢复），原位改为链接指向主仓库副本，此后可部署到任意 Agent。`,
      confirmText: isMatching ? "转为托管" : "导入",
      onConfirm: async () => {
        // null = 请求失败；[] = 走通了但没有新行（转托管复用仓库既有副本）
        let inserted = null;
        try {
          const d = await api("POST", "/api/skills/merge-local", { endpointId, skillName });
          if (d.conflict) {
            // 前端已按分类分流（分叉走 resolve-conflict），正常不会到这里；留兜底
            showSkillsModal({
              title: "仓库已有同名 skill",
              danger: false,
              bodyHtml: `仓库中的 <b>${escapeHtml(skillName)}</b> 与 ${src}的版本内容不同，未做任何改动。请用「分叉冲突」分区的两个方向按钮处理。${diffListHtml(d.diffs || [])}`,
              confirmText: "知道了",
              onConfirm: null,
            });
            await refreshSkillsState();
            return;
          }
          toast(d.reusedRepoCopy ? "已转为主仓库托管" : `已导入 ${skillName} 到主仓库`);
          // 只有导入才产生新行：转托管复用仓库既有副本，本地目录只是换成链接。
          // relPath 即 skillName——后端拷进仓库根目录，且 assertPlainSkillDirName
          // 保证它是不含分隔符的纯目录名
          inserted = d.reusedRepoCopy ? [] : [skillName];
        } catch (e) {
          toast(panelError(e, "操作失败"), true);
        }
        // 空集即朴素刷新：失败路径行没动、转托管没有新行，都不该演入场动画
        await revealSkillsInsert(inserted || []);
      },
    });
  }

  // ── 共用确认 modal ──
  // wide = 正文查阅那一档宽度；diff = 再宽一档并允许更高，两栏逐行对照需要横向空间
  function showSkillsModal({ title, bodyHtml, confirmText, danger, wide, diff, onConfirm }) {
    $("storeAddPoolCtl")?.remove(); // 新增渠道弹窗注入标题的建池控件，防跨弹窗残留
    $("skillsModalTitle").textContent = title;
    $("skillsModalBody").innerHTML = bodyHtml;
    const btn = $("skillsModalConfirmBtn");
    btn.textContent = confirmText || "确认";
    btn.disabled = false; // 上一弹窗可能停在「处理中…」禁用态（回调内改开新弹窗的路径）
    btn.className = "btn" + (danger ? " btn-danger" : " btn-primary");
    skillsModalConfirm = onConfirm || null;
    skillsModalGen++;
    $("skillsModal").classList.toggle("skills-modal-wide", !!wide || !!diff); // 仅正文查阅加宽
    $("skillsModal").classList.toggle("skills-modal-diff", !!diff);
    $("skillsModal").classList.add("show");
  }

  function hideSkillsModal() {
    if (skillsModalBusy) return; // 确认处理中：忽略遮罩点击与关闭按钮
    $("skillsModal").classList.remove("show");
    skillsModalConfirm = null;
  }

  // ══════════════════════════════════════════════════════════════════
  // 预设管理 tab（预设 = 预注入到各端点全局指令文件的 prompt 文本）
  // 完全照 skills 范式：多选集合（Ctrl+点击切换成员）+ 焦点驱动右侧详情卡，行内
  // 不放操作按钮，编辑/删除走详情卡按钮 + 右键菜单（多选时只留「删除选中项」批量
  // 入口）；端点注入开关在详情卡内逐端点 toggle。
  // 布局/样式零新增类，全量复用 skills-*/store-form-* 既有类（皮肤自动生效）。
  // ══════════════════════════════════════════════════════════════════
  let presetsState = null;       // GET /panel/api/prompts/state 最近一次结果
  let presetsSelection = new Set(); // 选中预设 id 集合（高亮即选中，照 skills）
  let presetsFocusId = null;     // 焦点 = 集合中最后加入且仍在的成员，驱动详情卡
  let presetsFilter = "";

  // Set 保持插入序：最后一员即「最后加入且仍在集合中的」成员（焦点回退用，照 skills）
  function presetsLastSelectionId() {
    let last = null;
    for (const id of presetsSelection) last = id;
    return last;
  }

  // 全选（照 skills）：集合 = 过滤后全部可见行；焦点若不在新集合内，回退到集合
  // 最后一员（与 reconcilePresetsSelection 同口径），详情卡随之换内容。
  function selectAllVisiblePresets() {
    presetsSelection.clear();
    visiblePresets().forEach((p) => presetsSelection.add(p.id));
    if (!presetsSelection.has(presetsFocusId)) presetsFocusId = presetsLastSelectionId();
    renderPresetsList();
    renderPresetDetail();
  }

  // 注入计数口径：预设 enabled 且不在该端点 off 列表 = 计 1（总开关不影响计数）。
  // 详情卡「已注入」徽标更严格：还需总开关 enabled。
  function presetOffOn(preset, epId) {
    const off = (((presetsState || {}).endpointOverrides || {})[epId] || {}).off || [];
    return off.includes(preset.id);
  }
  function presetCountedOn(preset, epId) {
    return !!preset.enabled && !presetOffOn(preset, epId);
  }
  function presetInjectedOn(preset, epId) {
    return !!(presetsState && presetsState.enabled) && presetCountedOn(preset, epId);
  }

  function fmtPresetTime(ts) {
    if (!ts) return "—";
    const d = new Date(ts);
    if (isNaN(d.getTime())) return String(ts);
    const p = (x) => (x < 10 ? "0" : "") + x;
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  // 串行化刷新（与 skills 同模式）：刷新排进 promise 链依次执行，await 返回时
  // 那次刷新的 GET 一定在调用之后才发出；单次失败不断链。
  let presetsRefreshChain = Promise.resolve();
  let presetsCascadePending = false;   // 仅点击刷新键那次渲染重播 cascade（与 skills 同源）
  function refreshPresetsState() {
    const p = presetsRefreshChain.then(doRefreshPresetsState);
    presetsRefreshChain = p.catch(() => {});
    return p;
  }
  async function doRefreshPresetsState() {
    try {
      const res = await api("GET", "/api/prompts/state");
      const firstLoad = presetsState === null;
      presetsState = res;
      // 唯一自动选中：首次加载且未选中时落首项，保持「打开 tab 即见详情」；
      // 此后用户清空的选中不被刷新复活。
      if (firstLoad && !presetsSelection.size) {
        const first = (res.presets || [])[0];
        if (first) { presetsSelection.add(first.id); presetsFocusId = first.id; }
      }
      reconcilePresetsSelection();
      renderPresetsMaster();
      renderPresetsList();
      renderPresetDetail();
    } catch (e) {
      toast(panelError(e, "预设状态加载失败"), true);
    }
  }

  // 预设刷新键的视觉反馈：与 skills 同源——按钮走 .btn:disabled 的 45% 变暗（亮着即「还没好」），
  // 点击瞬间整列隐去（is-blank）、cascade 待播，持续到整列 cascade 收帧才亮起；等待串在刷新之后
  // 而非与请求并行取最大值，否则亮起早于动画收尾一个请求耗时。请求失败时 doRefreshPresetsState
  // 走 catch 不渲染，is-blank 与标记都在 finally 兜底（前者不清列表永久隐形、后者不清会下次白播）。
  async function runPresetsRefreshWithFeedback() {
    const btn = $("presetsRefreshBtn");
    if (btn.disabled) return;
    btn.disabled = true;
    $("presetsList").classList.add("is-blank");
    presetsCascadePending = true;
    try {
      await refreshPresetsState();
      await new Promise((r) => setTimeout(r, SKILLS_CASCADE_TOTAL_MS));
    } finally {
      presetsCascadePending = false;
      $("presetsList").classList.remove("is-blank");
      btn.disabled = false;
    }
  }

  // reconcile（每次刷新后）：prune 集合中已消失的 id；全部消失则回落首项（无条目
  // 则清空，与单选时代同语义）；焦点不在集合内则回退最后一员
  function reconcilePresetsSelection() {
    if (!presetsSelection.size) return;
    const presets = (presetsState && presetsState.presets) || [];
    const ids = new Set(presets.map((p) => p.id));
    for (const id of [...presetsSelection]) if (!ids.has(id)) presetsSelection.delete(id);
    if (!presetsSelection.size) {
      const first = presets[0];
      if (first) presetsSelection.add(first.id);
      presetsFocusId = first ? first.id : null;
      return;
    }
    if (!presetsSelection.has(presetsFocusId)) presetsFocusId = presetsLastSelectionId();
  }

  function initPresetsTab() {
    $("tabPresets").onclick = () => switchView("presets");
    $("presetsAddBtn").onclick = () => showPresetFormModal(null);
    $("presetsRefreshBtn").onclick = runPresetsRefreshWithFeedback;
    $("presetsFilterInput").oninput = (e) => {
      presetsFilter = e.target.value.trim().toLowerCase();
      renderPresetsList();
    };
    initPresetsListDrag();
    // 多选（照 skills）：Ctrl/⌘+点击切换成员资格，普通左键集合={该行}，再点唯一
    // 选中行取消；点列表空白处清空选中与焦点
    $("presetsList").addEventListener("click", (e) => {
      // 拖拽重排落位后的合成 click：吞掉，不当成选中操作
      if (suppressPresetClick) { suppressPresetClick = false; return; }
      const row = e.target.closest("[data-preset]");
      if (!row) {
        if (presetsSelection.size) {
          presetsSelection.clear();
          presetsFocusId = null;
          renderPresetsList();
          renderPresetDetail();
        }
        return;
      }
      const id = row.getAttribute("data-preset");
      if (e.ctrlKey || e.metaKey) {
        // Ctrl+左键：切换成员资格；加入时焦点跟随，移除焦点行则回退到集合剩余最后一员
        if (presetsSelection.has(id)) {
          presetsSelection.delete(id);
          if (presetsFocusId === id) presetsFocusId = presetsLastSelectionId();
        } else {
          presetsSelection.add(id);
          presetsFocusId = id;
        }
      } else if (presetsSelection.size === 1 && presetsSelection.has(id)) {
        // 再点当前唯一选中行：取消选中（详情卡随之收起）
        presetsSelection.clear();
        presetsFocusId = null;
      } else {
        // 普通左键：集合 = {该行}，焦点 = 该行
        presetsSelection.clear();
        presetsSelection.add(id);
        presetsFocusId = id;
      }
      renderPresetsList();
      renderPresetDetail();
    });
    // 右键菜单（复用 skills 菜单基建 popSkillsContextMenu）：按目标行是否在选中
    // 集合分流——集合外行重置为单选弹单选菜单；集合内行集合不变，多成员弹多选
    // 菜单（只留「删除选中项」批量入口），单成员弹单选菜单
    $("presetsList").addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const row = e.target.closest("[data-preset]");
      if (!row) return;
      const id = row.getAttribute("data-preset");
      const preset = ((presetsState && presetsState.presets) || []).find((p) => p.id === id);
      if (!preset) return;
      if (presetsSelection.has(id)) {
        if (presetsSelection.size > 1) {
          popSkillsContextMenu(e.clientX, e.clientY, `已选 ${presetsSelection.size} 项`, [
            { label: "删除选中项", danger: true, fn: confirmDeleteSelectedPresets },
          ]);
          return;
        }
      } else {
        presetsSelection.clear();
        presetsSelection.add(id);
        presetsFocusId = id;
        renderPresetsList();
        renderPresetDetail();
      }
      popSkillsContextMenu(e.clientX, e.clientY, preset.title, [
        { label: "编辑", fn: () => showPresetFormModal(preset) },
        { label: preset.enabled ? "停用" : "启用", fn: () => setPresetEnabled(preset, !preset.enabled) },
        { label: "删除", danger: true, fn: () => confirmDeletePreset(preset) },
      ]);
    });
    $("presetsList").addEventListener("scroll", hideSkillsContextMenu);
    // 键盘（照 skills/store 范式）：Esc 先收右键菜单、多选时清空选中；Ctrl/⌘+A
    // 全选可见行。表单与确认弹窗都复用 skillsModal，弹窗开着时不劫持；输入框内
    // 不劫持 Ctrl+A（过滤框要正常打字选词）。
    document.addEventListener("keydown", (e) => {
      if ($("presetsView").hidden) return;
      if ($("skillsModal").classList.contains("show")) return;
      if (e.key === "Escape") {
        if ($("skillsCtxMenu")) {
          hideSkillsContextMenu();
          e.preventDefault();
        } else if (presetsSelection.size) {
          presetsSelection.clear();
          presetsFocusId = null;
          renderPresetsList();
          renderPresetDetail();
        }
      } else if ((e.ctrlKey || e.metaKey) && (e.key === "a" || e.key === "A")) {
        const tag = e.target && e.target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA") return;
        e.preventDefault();
        selectAllVisiblePresets();
      }
    });
    // 全局设置卡：总开关（预设功能 enabled）
    $("presetsMasterToggle").onchange = async (e) => {
      const input = e.target;
      const enabled = input.checked;
      input.disabled = true;
      try {
        await api("POST", "/api/prompts/master", { enabled });
        toast(enabled ? "预设注入已开启" : "预设注入已关闭");
      } catch (err) {
        toast(panelError(err, "设置失败"), true);
      } finally {
        input.disabled = false;
      }
      await refreshPresetsState();
    };
    if ($("presetsView").hidden) refreshPresetsState(); // presets 视图时 switchView 已触发刷新
  }

  // ── 卡片 B：预设列表 ──
  function visiblePresets() {
    const presets = (presetsState && presetsState.presets) || [];
    if (!presetsFilter) return presets;
    const hit = (v) => (v || "").toLowerCase().includes(presetsFilter);
    return presets.filter((p) => hit(p.title) || hit(p.tag) || hit(p.content));
  }

  // ── 预设文本长度可视化：卡片头占用条 + 行内单预设徽标 ──
  const CTX_BUDGET = 4000;          // 占用条 100% 参考值（仅提示，不熔断）
  const PRESET_GREEN_MAX = 200;      // 单预设：≤200 绿
  const PRESET_YELLOW_MAX = 500;     // 201–500 黄，>500 红
  const CTX_TIER_NAME = { empty: "空", low: "少", mid: "中", high: "多", over: "超过 100%" };
  function presetCharCount(p) { return ((p && p.content) || "").length; }
  function formatChars(n) {
    if (n < 1000) return n + " 字";
    if (n < 1e6) return (n / 1000).toFixed(1) + "k 字";
    return (n / 1e6).toFixed(1) + "M 字";
  }
  function formatCharsCompact(n) {
    if (n < 1000) return n + "字";
    if (n < 1e6) return (n / 1000).toFixed(1) + "k字";
    return (n / 1e6).toFixed(1) + "M字";
  }
  function presetBadgeClass(n) {
    if (n <= PRESET_GREEN_MAX) return "badge-ok";
    if (n <= PRESET_YELLOW_MAX) return "badge-warn";
    return "badge-danger";
  }
  function ctxTierOf(pct) {
    if (pct <= 0) return "empty";
    if (pct <= 0.30) return "low";
    if (pct <= 0.60) return "mid";
    if (pct <= 1.00) return "high";
    return "over";
  }
  // 用「至少在 1 个端点注入中」的预设正文总长给卡片头占用条上色/出数（与过滤集无关）：
  // 被停用、或在全部端点都解除注入的预设不计入。判定复用列表行 n/epTotal 的 presetCountedOn 口径。
  function paintCtxMeter(presets) {
    const meter = $("ctxMeter");
    if (!meter) return;
    const endpoints = (presetsState && presetsState.endpoints) || [];
    const total = (presets || [])
      .filter((p) => endpoints.some((ep) => presetCountedOn(p, ep.id)))
      .reduce((s, p) => s + presetCharCount(p), 0);
    const pct = total / CTX_BUDGET;
    const tier = ctxTierOf(pct);
    meter.setAttribute("data-tier", tier);
    const fill = $("ctxFill");
    if (fill) fill.style.width = (tier === "empty" ? 0 : Math.min(pct, 1) * 100) + "%";
    const totalEl = $("ctxTotal"), pctEl = $("ctxPct"), bar = $("ctxBar");
    if (totalEl) totalEl.textContent = formatChars(total);
    if (pctEl) pctEl.textContent = Math.round(pct * 100) + "%";
    if (bar) bar.setAttribute("title",
      `注入中的预设正文合计 ${total.toLocaleString()} 字，约为建议上限 ${CTX_BUDGET.toLocaleString()} 字的 ${Math.round(pct * 100)}%；超出仍可正常注入（${CTX_TIER_NAME[tier]}）`);
  }

  function renderPresetsList() {
    const listEl = $("presetsList");
    const presets = (presetsState && presetsState.presets) || [];
    paintCtxMeter(presets);
    // 消费 cascade 标记（与 skills 同源）：仅刷新那次渲染重播，提前 return 的空列表也消费，
    // 否则标记滞留到下一次无关渲染（过滤输入逐键会白播）。cascade 时先抓 scrollTop，重渲后
    // 还原——翻到非最上刷新不丢位置（sessions 的 keepScroll 同思路）。
    const cascade = presetsCascadePending; presetsCascadePending = false;
    const prevScrollTop = cascade ? listEl.scrollTop : 0;
    listEl.classList.remove("is-blank");
    if (!presets.length) {
      listEl.innerHTML = '<div class="empty-hint">还没有预设，点「新增预设」创建</div>';
      return;
    }
    const filtered = visiblePresets();
    if (!filtered.length) {
      listEl.innerHTML = '<div class="empty-hint">没有匹配的预设</div>';
      return;
    }
    const epTotal = ((presetsState && presetsState.endpoints) || []).length;
    // 仅非过滤态可拖拽重排：过滤态行序 ≠ 预设顺序，无法映射新顺序
    const drag = presetsListDraggable() ? ` draggable="true"` : "";
    listEl.innerHTML = filtered.map((p, i) => {
      const n = epTotal
        ? ((presetsState.endpoints || []).filter((ep) => presetCountedOn(p, ep.id))).length
        : 0;
      const epCount = !epTotal
        ? ""
        : `<span class="skills-ep-count${n >= epTotal ? " full" : n ? " some" : ""}" title="注入 ${n}/${epTotal} 个 Agent">${n}/${epTotal}</span>`;
      const chars = presetCharCount(p);
      const lenBadge = `<span class="badge ctx-preset-badge ${presetBadgeClass(chars)}" title="正文 ${chars} 字">${formatCharsCompact(chars)}</span>`;
      const tagBadge = p.tag ? `<span class="badge badge-neutral">${escapeHtml(p.tag)}</span>` : "";
      const firstLine = (p.content || "").split("\n").find((l) => l.trim()) || "（无内容）";
      // 未启用的预设行整体压暗（内联透明度）；--i 供 cascade 交错（窗口内重基见 playSkillsListCascade）
      const rowStyle = (p.enabled ? "" : "opacity:0.55;") + "--i:" + i;
      return `<div class="skills-list-row${presetsSelection.has(p.id) ? " selected" : ""}" style="${rowStyle}" data-preset="${escapeHtml(p.id)}" data-preset-index="${i}"${drag}>
        <div class="skills-list-line1">
          <span class="skills-list-name">${escapeHtml(p.title)}</span>${tagBadge}
          <span class="skills-ep-dots">${lenBadge}${epCount}</span>
        </div>
        <div class="skills-list-desc">${escapeHtml(firstLine)}</div>
      </div>`;
    }).join("");
    if (cascade) { listEl.scrollTop = prevScrollTop; playSkillsListCascade(listEl, prevScrollTop); }
  }

  // ── 预设列表拖拽重排（与渠道列表同款：HTML5 DnD + 槽位指示线 + drop 一次性 FLIP） ──
  // 预设顺序同时决定列表顺序与各端点指令文件托管块内的正文顺序，故与渠道顺序一样
  // 落盘（prompts.json 的 presetOrder）。拖动中列表完全静止：被拖行原地做空位占位，
  // dragover 只算插入槽、指示线瞬移到位；drop 才按槽位算新顺序、DOM 一次性重排 +
  // 全列表 FLIP，提交后端后 refresh。过滤态行序 ≠ 预设顺序，渲染时不加 draggable，
  // 拖拽逻辑也直接忽略。
  let presetDragId = null;         // 拖动中行 id
  let presetDragSlot = null;       // 当前插入槽索引（相对 DOM 现序，含被拖行）
  let suppressPresetClick = false; // dragend 后吞掉紧随的合成 click，避免误改选中

  function presetsListDraggable() {
    return !$("presetsFilterInput").value.trim();
  }
  function presetDragReducedMotion() {
    return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  // 槽位 Y（相对容器内容区，用 offsetTop 系换算，滚动下仍正确）：
  // slot 0 → 首行 top 减半间隙；slot i → 第 i-1 行 bottom 与第 i 行 top 的中点；末尾同理加半间隙
  function presetDragSlotY(rows, slot) {
    const gapBetween = (a, b) => (a && b ? b.offsetTop - (a.offsetTop + a.offsetHeight) : 0);
    if (slot <= 0) return rows[0].offsetTop - gapBetween(rows[0], rows[1]) / 2;
    if (slot >= rows.length) {
      const last = rows[rows.length - 1];
      return last.offsetTop + last.offsetHeight + gapBetween(rows[rows.length - 2], last) / 2;
    }
    const prev = rows[slot - 1];
    return (prev.offsetTop + prev.offsetHeight + rows[slot].offsetTop) / 2;
  }

  function initPresetsListDrag() {
    const list = $("presetsList");
    // 事件委托挂容器：行由 innerHTML 整批重建，绑行会丢
    list.addEventListener("dragstart", (e) => {
      if (!presetsListDraggable()) return;
      const row = e.target.closest("[data-preset]");
      if (!row) return;
      presetDragId = row.getAttribute("data-preset");
      presetDragSlot = null;
      row.classList.add("preset-row-dragging");
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", presetDragId);
    });
    list.addEventListener("dragover", (e) => {
      if (!presetDragId) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      // 列表静止：不挪行、不让位，只按指针中线算插入槽，指示线瞬移到槽位
      const rows = [...list.querySelectorAll("[data-preset]")];
      if (!rows.length) return;
      let slot = rows.length;
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i].getBoundingClientRect();
        if (e.clientY < r.top + r.height / 2) { slot = i; break; }
      }
      presetDragSlot = slot;
      let indicator = list.querySelector(".preset-drop-indicator");
      if (!indicator) {
        indicator = document.createElement("div");
        indicator.className = "preset-drop-indicator";
        list.appendChild(indicator);
      }
      // 拖动中列表静止，槽位不再随滚动漂移，故指示线关掉过渡直接落位
      // （渠道列表的指示线由面板的 reduced-motion 规则强制关过渡，这里显式声明一次）
      indicator.style.transition = "none";
      indicator.style.transform = `translateY(${presetDragSlotY(rows, slot)}px)`;
      // 边缘自动滚动：指针进入列表可视区上/下缘 48px 带内，按贴近程度加速滚动，
      // 让隐藏在上/下方的槽位可达；dragover 在拖拽中持续触发，滚动即连续
      const EDGE = 48, MAX_STEP = 18;
      const lr = list.getBoundingClientRect();
      const dTop = e.clientY - lr.top, dBottom = lr.bottom - e.clientY;
      if (dTop < EDGE && list.scrollTop > 0) {
        list.scrollTop -= Math.ceil(MAX_STEP * (1 - Math.max(dTop, 0) / EDGE));
      } else if (dBottom < EDGE && list.scrollTop + list.clientHeight < list.scrollHeight) {
        list.scrollTop += Math.ceil(MAX_STEP * (1 - Math.max(dBottom, 0) / EDGE));
      }
    });
    list.addEventListener("drop", (e) => {
      if (!presetDragId) return;
      e.preventDefault();
      const landedId = presetDragId;
      const rows = [...list.querySelectorAll("[data-preset]")];
      const dragEl = rows.find((el) => el.getAttribute("data-preset") === landedId);
      if (!dragEl) return;
      // 槽位相对「移除被拖行后」的序列换算：槽在被拖行之后则前移一位
      const from = rows.indexOf(dragEl);
      let slot = presetDragSlot == null ? from : presetDragSlot;
      if (slot > from) slot -= 1;
      const restEls = rows.filter((el) => el !== dragEl);
      slot = Math.max(0, Math.min(slot, restEls.length));
      const nextIds = restEls.map((el) => el.getAttribute("data-preset"));
      nextIds.splice(slot, 0, landedId);
      // 一次性重排：snapshot → DOM 应用新顺序 → 位移行 FLIP 归零
      const rects = new Map(rows.map((el) => [el, el.getBoundingClientRect()]));
      const reordered = nextIds
        .map((id) => rows.find((el) => el.getAttribute("data-preset") === id))
        .filter(Boolean);
      reordered.forEach((el) => list.insertBefore(el, null));
      // 行序即注入序，行内 index 需同步改名，否则同一次渲染里的过滤/重排会读错行
      reordered.forEach((el, i) => el.setAttribute("data-preset-index", String(i)));
      dragEl.classList.remove("preset-row-dragging");
      if (!presetDragReducedMotion()) {
        reordered.forEach((el) => {
          const dy = rects.get(el).top - el.getBoundingClientRect().top;
          if (!dy) return;
          el.style.transition = "none";
          el.style.transform = `translateY(${dy}px)`;
          void el.offsetWidth;
          el.style.transition = `transform 260ms var(--store-drag-ease)`;
          el.style.transform = "";
          setTimeout(() => { el.style.transition = ""; }, 290);
        });
      }
      dragEl.classList.add("preset-row-landed");
      setTimeout(() => dragEl.classList.remove("preset-row-landed"), 300);
      (async () => {
        try {
          await api("POST", "/api/prompts/preset/reorder", { order: nextIds });
          // 等 FLIP 收尾再重渲，避免动画中的行被 innerHTML 替换
          setTimeout(() => { refreshPresetsState(); }, 300);
        } catch (err) {
          renderPresetsList();
          toast(panelError(err, "预设顺序保存失败"), true);
        }
      })();
    });
    list.addEventListener("dragend", () => {
      if (!presetDragId) return;
      presetDragId = null;
      presetDragSlot = null;
      // 拖动中 DOM 未变，未落位也无需重渲，只清理占位态与指示线
      const dragging = list.querySelector(".preset-row-dragging");
      if (dragging) dragging.classList.remove("preset-row-dragging");
      const indicator = list.querySelector(".preset-drop-indicator");
      if (indicator) indicator.remove();
      // 拖拽结束后浏览器会补发一次 click，吞掉以免误触选中
      suppressPresetClick = true;
      setTimeout(() => { suppressPresetClick = false; }, 0);
    });
  }

  // ── 卡片 A：全局设置（总开关） ──
  function renderPresetsMaster() {
    $("presetsMasterToggle").checked = !!(presetsState && presetsState.enabled);
  }

  // ── 卡片 C：选中预设的详情与逐端点注入 ──
  function renderPresetDetail() {
    const body = $("presetsDetailBody");
    const presets = (presetsState && presetsState.presets) || [];
    const preset = presets.find((p) => p.id === presetsFocusId) || null;
    // 无选中时整卡收起；empty-hint 仅作结构兜底（与 skills 详情卡同手法）
    const card = body.closest(".panel-card");
    if (card) card.hidden = !preset;
    if (!preset) {
      body.innerHTML = '<div class="empty-hint">从左侧列表选择一个预设，查看详情并管理 Agent 注入</div>';
      return;
    }
    const endpoints = (presetsState && presetsState.endpoints) || [];
    const sync = (presetsState && presetsState.sync) || {};
    const rows = endpoints.map((ep) => {
      const injected = presetInjectedOn(preset, ep.id);
      const syncErr = sync[ep.id] && sync[ep.id].ok === false ? (sync[ep.id].error || "同步失败") : "";
      const stateBadge = syncErr
        ? `<span class="badge badge-warn" title="${escapeHtml(syncErr)}">同步失败</span>`
        : injected
          ? '<span class="badge badge-ok">已注入</span>'
          : '<span class="badge badge-neutral">未注入</span>';
      // hotReload=false 的端点（claude/zcode/dsh/pi/codex）：写盘即生效于新会话，
      // 运行中会话需重开才加载新的全局指令文件
      const hotNote = ep.hotReload ? "" : "（运行中会话需重开生效）";
      return `<div class="skills-skill-row"${ep.hotReload ? "" : ' title="运行中会话需重开生效"'}>
        <span style="min-width:0;">
          <span class="skills-skill-name">${escapeHtml(ep.label)} ${stateBadge}</span>
          <div class="skills-detail-relpath">${escapeHtml(ep.targetRel || "")}${escapeHtml(hotNote)}</div>
        </span>
        <label class="toggle"><input type="checkbox" data-inject="${escapeHtml(ep.id)}"${presetOffOn(preset, ep.id) ? "" : " checked"}><span class="slider"></span></label>
      </div>`;
    }).join("");
    const tagBadge = preset.tag ? `<span class="badge badge-neutral">${escapeHtml(preset.tag)}</span> ` : "";
    const enabledBadge = preset.enabled
      ? '<span class="badge badge-ok">已启用</span>'
      : '<span class="badge badge-neutral">已停用</span>';
    body.innerHTML = `
      <div class="skills-detail-head">
        <div class="skills-detail-name">${escapeHtml(preset.title)}</div>
        <div class="skills-detail-actions">
          <button class="btn" id="presetDetailEditBtn">编辑</button>
          <button class="btn btn-danger" id="presetDetailDeleteBtn">删除</button>
        </div>
      </div>
      <div class="skills-detail-relpath">${tagBadge}${enabledBadge} 更新于 ${escapeHtml(fmtPresetTime(preset.updatedAt))}</div>
      <div class="skills-detail-desc" style="white-space:pre-wrap;">${escapeHtml(preset.content || "（无内容）")}</div>
      <div class="skills-group-title skills-group-title-row" style="margin-top:0; padding-top:0; border-top:none;">
        <span>注入到 Agent</span>
        <span class="skills-batch-actions">
          <button class="btn btn-mini btn-accent" id="presetsInjectAllBtn">全部注入</button>
          <button class="btn btn-mini btn-warn" id="presetsUninjectAllBtn">全部解除</button>
        </span>
      </div>
      ${rows}`;
    body.querySelectorAll("input[data-inject]").forEach((input) => {
      input.onchange = () => {
        // 请求未完成前禁用，防连点并发/乱序刷新（开关回抽），与 skills 部署 toggle 同手法
        input.disabled = true;
        togglePresetInject(input.getAttribute("data-inject"), preset, input.checked);
      };
    });
    $("presetDetailEditBtn").onclick = () => showPresetFormModal(preset);
    $("presetDetailDeleteBtn").onclick = () => confirmDeletePreset(preset);
    $("presetsInjectAllBtn").onclick = (e) => setAllPresetInjects(preset, true, e.target);
    $("presetsUninjectAllBtn").onclick = (e) => setAllPresetInjects(preset, false, e.target);
  }

  // 单端点注入开关：checked = 注入（从 off 列表移除），unchecked = 解除（加入 off 列表）
  async function togglePresetInject(endpointId, preset, on) {
    try {
      await api("POST", "/api/prompts/override", { endpointId, presetId: preset.id, off: !on });
      toast(on ? `已注入到 ${endpointId}` : `已解除 ${endpointId} 的注入`);
    } catch (e) {
      toast(panelError(e, "操作失败"), true);
    }
    await refreshPresetsState();
  }

  // 全部注入/全部解除：对清单里的 Agent（服务端已按「装在本机」过滤）串行走
  // override，已是目标状态的跳过
  async function setAllPresetInjects(preset, on, btn) {
    if (btn) btn.disabled = true;
    const endpoints = (presetsState && presetsState.endpoints) || [];
    let changed = 0, failed = 0;
    try {
      for (const ep of endpoints) {
        if (presetOffOn(preset, ep.id) === !on) continue;
        try {
          await api("POST", "/api/prompts/override", { endpointId: ep.id, presetId: preset.id, off: !on });
          changed++;
        } catch { failed++; }
      }
      toast(failed ? `完成 ${changed} 个 Agent，失败 ${failed} 个` : (on ? "已全部注入" : "已全部解除"), failed > 0);
    } finally {
      if (btn) btn.disabled = false;
    }
    await refreshPresetsState();
  }

  async function setPresetEnabled(preset, enabled) {
    try {
      await api("POST", "/api/prompts/preset/enable", { id: preset.id, enabled });
      toast(enabled ? `已启用「${preset.title}」` : `已停用「${preset.title}」`);
    } catch (e) {
      toast(panelError(e, "操作失败"), true);
    }
    await refreshPresetsState();
  }

  function confirmDeletePreset(preset) {
    showSkillsModal({
      title: "删除预设",
      danger: true,
      bodyHtml: `将删除预设 <b>${escapeHtml(preset.title)}</b>，并从所有 Agent 的全局指令文件中移除其注入内容。`,
      confirmText: "删除",
      onConfirm: async () => {
        try {
          await api("POST", "/api/prompts/preset/delete", { id: preset.id });
          toast("预设已删除");
        } catch (e) {
          toast(panelError(e, "删除失败"), true);
        }
        await refreshPresetsState();
      },
    });
  }

  // 多选删除（照 skills confirmDeleteSelectedSkills）：红色确认列出将删除的预设，
  // 确认后逐个走既有 preset/delete（服务端级联清除各端点注入内容），计数收尾一次刷新
  function confirmDeleteSelectedPresets() {
    const presets = (presetsState && presetsState.presets) || [];
    const selected = presets.filter((p) => presetsSelection.has(p.id));
    if (!selected.length) return;
    const listHtml = selected.map((p) => `<div>· <b>${escapeHtml(p.title)}</b></div>`).join("");
    showSkillsModal({
      title: `删除选中的 ${selected.length} 个预设`,
      danger: true,
      bodyHtml: `将删除以下预设，并从所有 Agent 的全局指令文件中移除其注入内容。<div style="margin-top:8px;">${listHtml}</div>`,
      confirmText: "删除",
      onConfirm: async () => {
        let failCount = 0;
        const removed = [];
        for (const p of selected) {
          try {
            await api("POST", "/api/prompts/preset/delete", { id: p.id });
            removed.push(p.id);
          } catch {
            failCount++;
          }
        }
        toast(failCount ? `删除完成：成功 ${removed.length}、失败 ${failCount}` : `已删除 ${removed.length} 个预设`, failCount > 0);
        await refreshPresetsState();
      },
    });
  }

  // ── 新增/编辑预设表单弹窗（store showAddModal 范式：showSkillsModal wide +
  // 表单 HTML 注入 + store-form-error 错误条，校验/提交失败保留已填内容重开）──
  function showPresetFormModal(preset, values, errorMsg) {
    const v = values || {
      title: preset ? preset.title : "",
      tag: preset ? (preset.tag || "") : "",
      content: preset ? (preset.content || "") : "",
    };
    const editing = !!preset;
    const bodyHtml = `
      <div class="store-form-row"><label class="store-form-label">标题</label>
        <input class="store-form-input" id="presetFormTitle" value="${escapeHtml(v.title)}" placeholder="如 代码风格约定"></div>
      <div class="store-form-row"><label class="store-form-label">Tag（可选，列表徽标展示）</label>
        <input class="store-form-input" id="presetFormTag" value="${escapeHtml(v.tag)}" placeholder="如 style"></div>
      <div class="store-form-row"><label class="store-form-label">正文（预注入到各 Agent 的全局指令文件）</label>
        <textarea class="store-form-textarea" id="presetFormContent" style="min-height:160px;">${escapeHtml(v.content)}</textarea></div>
      <div class="store-form-error" id="presetFormError"${errorMsg ? "" : " hidden"}>${escapeHtml(errorMsg || "")}</div>`;
    showSkillsModal({
      title: editing ? "编辑预设" : "新增预设",
      wide: true,
      confirmText: editing ? "保存" : "创建",
      bodyHtml,
      onConfirm: async () => {
        const title = $("presetFormTitle").value.trim();
        const tag = $("presetFormTag").value.trim();
        const content = $("presetFormContent").value;
        // 失败重开：showSkillsModal 递增 skillsModalGen 后，旧确认回调不再关新弹窗
        const reopen = (msg) => showPresetFormModal(preset, { title, tag, content }, msg);
        if (!title) return reopen("标题不能为空");
        if (!content.trim()) return reopen("正文不能为空");
        try {
          if (editing) {
            await api("POST", "/api/prompts/preset/update", { id: preset.id, title, tag, content });
            toast("预设已保存");
          } else {
            const created = await api("POST", "/api/prompts/preset/create", { title, tag, content });
            if (created?.preset?.id) { presetsSelection = new Set([created.preset.id]); presetsFocusId = created.preset.id; }
            toast("预设已创建");
          }
        } catch (e) {
          return reopen(panelError(e, "预设保存失败"));
        }
        await refreshPresetsState();
      },
    });
  }

  // ══════════════════════════════════════════════════════════════════
  // Store 管理 tab（CLI store 功能的面板迁移：增删改渠道/探活/刷新/模型过滤）
  // 复用 skills 范式的部件：api()/toast()/showSkillsModal/右键菜单/串行刷新链。
  // 多选与 skills 同范式（Selection Set + 焦点驱动详情）；号池（pools）：
  // 池行合并展示、池详情成员 tab、组建/解除号池，数据由 getState 的 pools 下发。
  // ══════════════════════════════════════════════════════════════════
  let storeState = null;          // GET /panel/api/store/state 最近一次结果
  // 渠道列表行右侧可用性信号灯的数据：行 id（渠道/号池）→ { rate, status, nodes }，
  // 随 refreshStoreState 拉取（口径见 buildStoreAvailability）
  let storeAvailability = new Map();
  // 「高光即选中」（与 skills 同范式）：选中集合（渠道 id 或号池 id，同命名空间不撞）
  // = 所有高亮行 = 一切操作的作用对象；焦点是集合内最后加入的一员，驱动右侧详情卡。
  let storeSelection = new Set();
  let storeFocusId = null;        // 焦点行 id（渠道 id 或号池 id）
  let storePoolTab = null;        // 池详情当前成员 tab 的 provider id
  let storeFilterChecked = null;  // 详情卡模型勾选集（Set<modelId>），null = 未初始化
  let storeFilterDirty = false;
  let storeFilterProviderId = null; // 勾选集所属渠道（脏确认只在「详情渠道将变化」时触发）

  function storeProviders() {
    return (storeState && storeState.providers) || [];
  }
  function storePools() {
    return (storeState && storeState.pools) || [];
  }

  // 可见行模型：未入池渠道各行 + 每号池一合并行（位置 = 首个成员在 providers 中出现处）。
  // 成员行不单独渲染；池数据缺失时兜底按普通渠道渲染。
  function storeRows() {
    const rows = [];
    const poolById = new Map(storePools().map((pl) => [pl.id, pl]));
    const byId = new Map(storeProviders().map((p) => [p.id, p]));
    const emittedPools = new Set();
    for (const p of storeProviders()) {
      const pool = p.poolId ? poolById.get(p.poolId) : null;
      if (pool) {
        if (emittedPools.has(pool.id)) continue;
        emittedPools.add(pool.id);
        const members = (pool.members || []).map((id) => byId.get(id)).filter(Boolean);
        rows.push({ kind: "pool", id: pool.id, displayName: pool.displayName, pool, members });
      } else {
        rows.push({ kind: "provider", id: p.id, p });
      }
    }
    return rows;
  }
  function storeFocusRow() {
    return storeRows().find((r) => r.id === storeFocusId) || null;
  }
  function storeLastSelectionId() {
    let last = null;
    for (const k of storeSelection) last = k;
    return last;
  }
  // 选中集展开为渠道 id 列表（池行 → 成员，保序去重）
  function storeSelectionProviders() {
    const ids = [];
    const rows = storeRows();
    for (const selId of storeSelection) {
      const row = rows.find((r) => r.id === selId);
      if (!row) continue;
      if (row.kind === "pool") for (const m of row.members) ids.push(m.id);
      else ids.push(row.id);
    }
    return [...new Set(ids)];
  }
  // 当前详情卡正在展示的渠道对象（池焦点 = 当前成员 tab 的渠道）
  function storeDetailProvider() {
    const row = storeFocusRow();
    if (!row) return null;
    if (row.kind === "provider") return row.p;
    const tab = storePoolTab && row.members.some((m) => m.id === storePoolTab)
      ? storePoolTab
      : (row.members[0] || {}).id;
    return row.members.find((m) => m.id === tab) || null;
  }
  // 某焦点下详情卡会展示的渠道 id（脏过滤确认的判断基准）
  function storeDetailProviderIdFor(focusId, poolTab) {
    const row = storeRows().find((r) => r.id === focusId);
    if (!row) return null;
    if (row.kind === "provider") return row.id;
    const tab = poolTab && row.members.some((m) => m.id === poolTab)
      ? poolTab
      : (row.members[0] || {}).id || null;
    return tab;
  }
  // 池内重复模型（号池 tag 判定）：当前渠道的 discovered 模型中，
  // 同一池内 ≥1 个其他成员的 discovered（含 manual 补录）也有的 id 集合。
  function storePoolDuplicateModels(p) {
    if (!p.poolId) return null;
    const pool = storePools().find((pl) => pl.id === p.poolId);
    if (!pool) return null;
    const others = (pool.members || [])
      .filter((id) => id !== p.id)
      .map((id) => storeProviders().find((x) => x.id === id))
      .filter(Boolean);
    const dup = new Set();
    for (const mid of Object.keys(p.discovered || {})) {
      if (others.some((o) => o.discovered && Object.hasOwn(o.discovered, mid))) dup.add(mid);
    }
    return dup;
  }

  // 串行化刷新（同 skillsRefreshChain 的理由：await 返回时拿到的一定是操作后的状态）
  let storeRefreshChain = Promise.resolve();
  function refreshStoreState() {
    const p = storeRefreshChain.then(doRefreshStoreState);
    storeRefreshChain = p.catch(() => {});
    return p;
  }
  // 新状态落库 + 选中/焦点/过滤基准 reconcile。两条取状态路径（整轮全量、逐渠道
  // 上屏）共用，保证「选中行还在不在、详情看的是哪个渠道」在两处口径一致。
  function applyStoreState(res) {
    const firstLoad = storeState === null;
    storeState = res;
    if (firstLoad && !storeSelection.size) {
      const first = storeRows()[0];
      if (first) {
        storeSelection.add(first.id);
        storeFocusId = first.id;
      }
    }
    // reconcile：剔除已消失的行；焦点不在集合内则回退到集合最后一员；
    // 详情渠道因此变化时重置过滤勾选（与焦点切换同语义）
    const validIds = new Set(storeRows().map((r) => r.id));
    for (const id of [...storeSelection]) {
      if (!validIds.has(id)) storeSelection.delete(id);
    }
    if (storeFocusId && !storeSelection.has(storeFocusId)) {
      storeFocusId = storeLastSelectionId();
    }
    const pid = storeDetailProviderIdFor(storeFocusId, storePoolTab);
    if (pid !== storeFilterProviderId) {
      storeFilterChecked = null;
      storeFilterDirty = false;
      storeFilterProviderId = pid;
    }
  }

  async function doRefreshStoreState() {
    try {
      const [res, stab] = await Promise.all([
        api("GET", "/api/store/state"),
        api("GET", "/api/model-stability").catch(() => null), // 稳定性拉取失败不挡渠道配置加载
      ]);
      if (stab) storeAvailability = buildStoreAvailability(stab.models);
      applyStoreState(res);
      renderStoreOverview();
      renderRouteChains();
      renderStoreList();
      renderStoreDetail();
    } catch (e) {
      toast(panelError(e, "渠道配置加载失败"), true);
    }
  }

  // 逐渠道刷完即时上屏：只取渠道状态，只重渲与模型缓存有关的两处（总览计数、
  // 详情卡模型列表）。列表行只含显示名/凭据徽标/可用性与 TTFT、路由链与模型缓存
  // 无关，都不重渲——省掉整列表重建和一次用不上的稳定性拉取。仍走同一条串行链，
  // 免得与整轮全量重渲交错时旧响应盖新状态。
  function refreshStoreModelsView() {
    const p = storeRefreshChain.then(doRefreshStoreModelsView);
    storeRefreshChain = p.catch(() => {});
    return p;
  }
  async function doRefreshStoreModelsView() {
    try {
      const res = await api("GET", "/api/store/state");
      applyStoreState(res);
      renderStoreOverview();
      renderStoreDetail();
    } catch (e) {
      toast(panelError(e, "渠道配置加载失败"), true);
    }
  }

  // 渠道配置读不出来时的四种情形，各给一句用户看得懂的话。
  // 键是 /api/store/state 的 storeError 短码，取值随 store-io.mjs 的 LOAD_REASON。
  const STORE_LOAD_COPY = {
    "store-absent": "还没有添加任何渠道",
    "store-unreadable": "渠道配置文件读不到",
    "store-unparsable": "渠道配置文件格式损坏",
    "store-schema-invalid": "渠道配置文件内容不合法",
  };

  // ── 卡片 A：渠道总览 ──
  function renderStoreOverview() {
    const badge = $("storeHealthBadge");
    const summary = $("storeSummary");
    const note = $("storeResumeNote");
    if (!storeState || !storeState.storeOk) {
      badge.className = "badge badge-warn";
      badge.textContent = "不可用";
      summary.textContent = "渠道配置不可用：" + (STORE_LOAD_COPY[storeState && storeState.storeError] || "状态未知");
    } else {
      const providers = storeProviders();
      const models = providers.reduce((n, p) => n + (p.modelCount || 0), 0);
      const noCred = providers.filter((p) => !p.hasCredential).length;
      badge.className = "badge " + (noCred ? "badge-warn" : "badge-ok");
      badge.textContent = noCred ? `${noCred} 个缺凭据` : "正常";
      const poolCount = storePools().length;
      summary.textContent = `${providers.length} 个渠道${poolCount ? ` · ${poolCount} 个号池` : ""} · 有效模型共 ${models} 个`;
    }
    const rr = storeState && storeState.resumeResult;
    const resumed = (rr && rr.resumed) || [];
    // failed 项是 { providerId, reason }；只上屏渠道 id（原因属服务日志，长英文句
    // 不该出现在这里），旧格式（纯 id）照旧兼容。
    const failed = ((rr && rr.failed) || []).map((item) =>
      typeof item === "string" ? item : (item && item.providerId) || "未知渠道");
    if (rr && rr.error) {
      note.hidden = false;
      note.textContent = panelCopy(rr.error, "无法确认是否有未完成的删除，请稍后重试");
    } else if (resumed.length || failed.length) {
      note.hidden = false;
      note.textContent =
        (resumed.length ? `已恢复挂起删除：${resumed.join("、")}。` : "") +
        (failed.length ? `删除恢复失败：${failed.join("、")}（凭据已保留）。` : "");
    } else {
      note.hidden = true;
      note.textContent = "";
    }
  }

  // ── 卡片 B：渠道列表（过滤分级排序：名称/ID 命中优先，与 skills 同款） ──
  // 行 = 未入池渠道 + 号池合并行；多选高亮 = storeSelection，焦点行即详情驱动。
  function storeVisibleRows() {
    const q = $("storeFilterInput").value.trim().toLowerCase();
    const rows = storeRows()
      .map((row) => {
        let rank = 1;
        if (!q) rank = 0;
        else if (row.id.toLowerCase().includes(q) || (row.displayName || row.p.displayName || "").toLowerCase().includes(q)) rank = 0;
        else return null;
        return { row, rank };
      })
      .filter(Boolean);
    rows.sort((a, b) => a.rank - b.rank);
    return rows.map(({ row }) => row);
  }

  // 渠道列表右侧可用性（与看板「状态检测」同口径）：近 8h 滚动窗、尝试级
  // successRate；每行可用性 = 该行名下有流量的节点（渠道×模型行）successRate
  // 的简单平均；TTFT 同取节点简单平均，ttftMs 为 null（无样本）的节点不参与。
  // 号池行已由后端把成员渠道合并为 provider=池 id 的行，故渠道与号池都按行 id
  // 直接查。灯色阈值同 statusOf：≥85 绿 / ≥70 黄 / 其余红；窗口内无流量的节点
  // 不参与平均，整行无流量时该行无记录（行尾什么都不渲染）。
  function buildStoreAvailability(models) {
    const map = new Map();
    for (const m of models || []) {
      if (!m || typeof m.provider !== "string" || !(Number(m.total) > 0)) continue;
      let agg = map.get(m.provider);
      if (!agg) { agg = { sum: 0, nodes: 0, ttftSum: 0, ttftNodes: 0 }; map.set(m.provider, agg); }
      agg.sum += Number(m.successRate) || 0;
      agg.nodes += 1;
      if (typeof m.ttftMs === "number" && Number.isFinite(m.ttftMs)) {
        agg.ttftSum += m.ttftMs;
        agg.ttftNodes += 1;
      }
    }
    for (const [id, agg] of map) {
      const rate = agg.sum / agg.nodes;
      map.set(id, {
        rate,
        status: rate >= 85 ? "green" : rate >= 70 ? "yellow" : "red",
        nodes: agg.nodes,
        ttftMs: agg.ttftNodes > 0 ? Math.round(agg.ttftSum / agg.ttftNodes) : null,
        ttftNodes: agg.ttftNodes,
      });
    }
    return map;
  }

  // 行尾两段指示的 HTML：avail = 可用性（灯+百分比，行1 右侧）；
  // ttft = TTFT 均值（行2 右侧空位，无样本则空）。窗口内无流量时两段皆空。
  function storeAvailabilityHtml(id) {
    const a = storeAvailability.get(id);
    if (!a) return { avail: "", ttft: "" };
    const cls = a.status === "green" ? "g" : a.status === "yellow" ? "y" : "r";
    const avail = `<span class="store-avail" title="近 8h 可用性 · ${a.nodes} 个节点平均"><i class="lamp lamp-${a.status}"></i> <span class="ms-rate ${cls}">${a.rate.toFixed(1)}%</span></span>`;
    const ttft = a.ttftMs == null
      ? ""
      : `<span class="store-ttft" title="近 8h TTFT 均值 · ${a.ttftNodes} 个节点平均">平均 TTFT ${fmtLatency(a.ttftMs)}</span>`;
    return { avail, ttft };
  }

  function renderStoreList() {
    const visible = storeVisibleRows();
    $("storeListBadge").textContent = String(storeRows().length);
    const list = $("storeList");
    if (!visible.length) {
      list.innerHTML = `<div class="skills-list-row" style="cursor:default;"><div class="skills-list-desc">${storeRows().length ? "无匹配渠道" : "尚无渠道，点上方「新增渠道」"}</div></div>`;
      return;
    }
    list.innerHTML = visible.map((row) => {
      const selected = storeSelection.has(row.id) ? " selected" : "";
      // 仅非过滤态可拖拽重排：过滤态行序 ≠ providers 顺序，无法映射新顺序
      const drag = storeListDraggable() ? ` draggable="true"` : "";
      if (row.kind === "pool") {
        const noCred = row.members.some((m) => !m.hasCredential);
        const { avail, ttft } = storeAvailabilityHtml(row.id);
        return `
      <div class="skills-list-row${selected}" data-store="${escapeHtml(row.id)}"${drag}>
        <div class="skills-list-line1">
          <span class="skills-list-name">${escapeHtml(row.displayName)} <span class="badge badge-pool">号池</span></span>
          <span class="store-list-meta">
            ${noCred ? `<span class="badge badge-warn">有成员缺凭据</span>` : ""}
            ${avail}
          </span>
        </div>
        <div class="store-list-line2">
          <span class="skills-list-desc">${escapeHtml(row.id)}</span>
          ${ttft}
        </div>
      </div>`;
      }
      const p = row.p;
      const { avail, ttft } = storeAvailabilityHtml(p.id);
      return `
      <div class="skills-list-row${selected}" data-store="${escapeHtml(p.id)}"${drag}>
        <div class="skills-list-line1">
          <span class="skills-list-name">${escapeHtml(p.displayName)}</span>
          <span class="store-list-meta">
            ${p.hasCredential ? "" : `<span class="badge badge-warn">无凭据</span>`}
            ${avail}
          </span>
        </div>
        <div class="store-list-line2">
          <span class="skills-list-desc">${escapeHtml(p.id)}</span>
          ${ttft}
        </div>
      </div>`;
    }).join("");
  }

  // ── 渠道列表拖拽重排（HTML5 DnD + 槽位指示线 + drop 一次性 FLIP） ──
  // 拖动中列表完全静止：被拖行原地做空位占位，dragover 只算插入槽、指示线瞬移到位；
  // drop 才按槽位算新顺序、DOM 一次性重排 + 全列表 FLIP，提交后端后 refresh。
  // 过滤态行序 ≠ providers 顺序，渲染时不加 draggable，拖拽逻辑也直接忽略。
  let storeDragId = null;         // 拖动中行 id（渠道 id 或号池 id）
  let storeDragSlot = null;       // 当前插入槽索引（相对 DOM 现序，含被拖行）
  let suppressStoreClick = false; // dragend 后吞掉紧随的合成 click，避免误改选中集

  function storeListDraggable() {
    return !$("storeFilterInput").value.trim();
  }
  function storeDragReducedMotion() {
    return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  // 槽位 Y（相对容器内容区，用 offsetTop 系换算，滚动下仍正确）：
  // slot 0 → 首行 top 减半间隙；slot i → 第 i-1 行 bottom 与第 i 行 top 的中点；末尾同理加半间隙
  function storeDragSlotY(rows, slot) {
    const gapBetween = (a, b) => (a && b ? b.offsetTop - (a.offsetTop + a.offsetHeight) : 0);
    if (slot <= 0) return rows[0].offsetTop - gapBetween(rows[0], rows[1]) / 2;
    if (slot >= rows.length) {
      const last = rows[rows.length - 1];
      return last.offsetTop + last.offsetHeight + gapBetween(rows[rows.length - 2], last) / 2;
    }
    const prev = rows[slot - 1];
    return (prev.offsetTop + prev.offsetHeight + rows[slot].offsetTop) / 2;
  }

  function initStoreListDrag() {
    const list = $("storeList");
    // 事件委托挂容器：行由 innerHTML 整批重建，绑行会丢
    list.addEventListener("dragstart", (e) => {
      if (!storeListDraggable()) return;
      const row = e.target.closest("[data-store]");
      if (!row) return;
      storeDragId = row.getAttribute("data-store");
      storeDragSlot = null;
      row.classList.add("store-row-dragging");
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", storeDragId);
    });
    list.addEventListener("dragover", (e) => {
      if (!storeDragId) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      // 列表静止：不挪行、不让位，只按指针中线算插入槽，指示线瞬移到槽位
      const rows = [...list.querySelectorAll("[data-store]")];
      if (!rows.length) return;
      let slot = rows.length;
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i].getBoundingClientRect();
        if (e.clientY < r.top + r.height / 2) { slot = i; break; }
      }
      storeDragSlot = slot;
      let indicator = list.querySelector(".store-drop-indicator");
      if (!indicator) {
        indicator = document.createElement("div");
        indicator.className = "store-drop-indicator";
        list.appendChild(indicator);
      }
      indicator.style.transform = `translateY(${storeDragSlotY(rows, slot)}px)`;
      // 边缘自动滚动：指针进入列表可视区上/下缘 48px 带内，按贴近程度加速滚动，
      // 让隐藏在上/下方的槽位可达；dragover 在拖拽中持续触发，滚动即连续
      const EDGE = 48, MAX_STEP = 18;
      const lr = list.getBoundingClientRect();
      const dTop = e.clientY - lr.top, dBottom = lr.bottom - e.clientY;
      if (dTop < EDGE && list.scrollTop > 0) {
        list.scrollTop -= Math.ceil(MAX_STEP * (1 - Math.max(dTop, 0) / EDGE));
      } else if (dBottom < EDGE && list.scrollTop + list.clientHeight < list.scrollHeight) {
        list.scrollTop += Math.ceil(MAX_STEP * (1 - Math.max(dBottom, 0) / EDGE));
      }
    });
    list.addEventListener("drop", (e) => {
      if (!storeDragId) return;
      e.preventDefault();
      const landedId = storeDragId;
      const rows = [...list.querySelectorAll("[data-store]")];
      const dragEl = rows.find((el) => el.getAttribute("data-store") === landedId);
      if (!dragEl) return;
      // 槽位相对「移除被拖行后」的序列换算：槽在被拖行之后则前移一位
      const from = rows.indexOf(dragEl);
      let slot = storeDragSlot == null ? from : storeDragSlot;
      if (slot > from) slot -= 1;
      const restEls = rows.filter((el) => el !== dragEl);
      slot = Math.max(0, Math.min(slot, restEls.length));
      const nextIds = restEls.map((el) => el.getAttribute("data-store"));
      nextIds.splice(slot, 0, landedId);
      // 展开为新 provider id 顺序（池行 → 成员保序）
      const byId = new Map(storeRows().map((r) => [r.id, r]));
      const order = [];
      for (const id of nextIds) {
        const row = byId.get(id);
        if (!row) continue;
        if (row.kind === "pool") for (const m of row.members) order.push(m.id);
        else order.push(id);
      }
      // 一次性重排：snapshot → DOM 应用新顺序 → 位移行 FLIP 归零
      const rects = new Map(rows.map((el) => [el, el.getBoundingClientRect()]));
      const reordered = nextIds
        .map((id) => rows.find((el) => el.getAttribute("data-store") === id))
        .filter(Boolean);
      reordered.forEach((el) => list.insertBefore(el, null));
      dragEl.classList.remove("store-row-dragging");
      if (!storeDragReducedMotion()) {
        reordered.forEach((el) => {
          const dy = rects.get(el).top - el.getBoundingClientRect().top;
          if (!dy) return;
          el.style.transition = "none";
          el.style.transform = `translateY(${dy}px)`;
          void el.offsetWidth;
          el.style.transition = `transform 260ms var(--store-drag-ease)`;
          el.style.transform = "";
          setTimeout(() => { el.style.transition = ""; }, 290);
        });
      }
      dragEl.classList.add("store-row-landed");
      setTimeout(() => dragEl.classList.remove("store-row-landed"), 300);
      (async () => {
        try {
          await api("POST", "/api/store/reorder", { order });
          // 等 FLIP 收尾再重渲，避免动画中的行被 innerHTML 替换
          setTimeout(() => { refreshStoreState(); }, 300);
        } catch (err) {
          renderStoreList();
          toast(panelError(err, "渠道顺序保存失败"), true);
        }
      })();
    });
    list.addEventListener("dragend", () => {
      if (!storeDragId) return;
      storeDragId = null;
      storeDragSlot = null;
      // 拖动中 DOM 未变，未落位也无需重渲，只清理占位态与指示线
      const dragging = list.querySelector(".store-row-dragging");
      if (dragging) dragging.classList.remove("store-row-dragging");
      const indicator = list.querySelector(".store-drop-indicator");
      if (indicator) indicator.remove();
      // 拖拽结束后浏览器会补发一次 click，吞掉以免误触单选/多选
      suppressStoreClick = true;
      setTimeout(() => { suppressStoreClick = false; }, 0);
    });
  }

  // ── 卡片 C：渠道详情 / 号池详情 + 模型管理 ──
  function formatCtx(n) {
    if (!Number.isFinite(n) || n <= 0) return "";
    return n >= 1000 ? (n / 1000).toFixed(n % 1000 ? 1 : 0) + "K" : String(n);
  }

  // 过滤勾选基线 = 已保存 modelFilter；旧条目（null filter）基线为全选 discovered，
  // 与下方勾选集初始化语义一致。脏判定 = 当前勾选集与基线不全等（改回原点不算脏）。
  function storeFilterBaseline(p) {
    return new Set(Array.isArray(p.modelFilter) ? p.modelFilter : Object.keys(p.discovered || {}));
  }

  function syncStoreFilterDirty(p) {
    const base = storeFilterBaseline(p);
    storeFilterDirty =
      storeFilterChecked.size !== base.size ||
      [...storeFilterChecked].some((mid) => !base.has(mid));
  }

  // 详情卡当前渲染的渠道（草稿归属判定用，见 captureStoreManualDraft）
  let storeDetailRenderedId = null;
  // 「手动添加」框是详情卡里唯一的裸 DOM 输入：逐渠道刷完即时上屏会反复重建这张卡，
  // 草稿会在重建时被吞掉。渲染是同步的，同一 task 内先存后取不丢键击。草稿记所属
  // 渠道，换渠道渲染时按原语义丢弃——不把 A 的草稿搬进 B 的框。
  function captureStoreManualDraft() {
    const el = $("storeManualAddInput");
    if (!el || !el.value) return null;
    return {
      providerId: storeDetailRenderedId,
      value: el.value,
      start: el.selectionStart,
      end: el.selectionEnd,
      focused: document.activeElement === el,
    };
  }
  function restoreStoreManualDraft(draft, renderedId) {
    if (!draft || draft.providerId !== renderedId) return;
    const el = $("storeManualAddInput");
    if (!el) return;
    el.value = draft.value;
    if (draft.focused) {
      el.focus();
      try { el.setSelectionRange(draft.start, draft.end); } catch {}
    }
  }

  function renderStoreDetail() {
    const draft = captureStoreManualDraft();
    const body = $("storeDetailBody");
    const row = storeFocusRow();
    $("storeDetailTitle").textContent = row && row.kind === "pool" ? "号池详情" : "渠道详情";
    if (!row) {
      body.innerHTML = `<div class="skills-list-desc" style="padding:8px 0;">选择左侧渠道查看详情</div>`;
      storeDetailRenderedId = null;
      return;
    }
    if (row.kind === "pool") {
      renderPoolDetail(row);
    } else {
      renderProviderDetail(row.p, body);
    }
    const cur = storeDetailProvider();
    storeDetailRenderedId = cur ? cur.id : null;
    restoreStoreManualDraft(draft, storeDetailRenderedId);
  }

  // 池详情：摘要行 + 成员 tab；tab 下方即该成员渠道的完整详情
  // （模型管理/补录/探活/刷新/更改配置/删除全部按 tab 渠道生效）。
  function renderPoolDetail(row) {
    const body = $("storeDetailBody");
    if (!storePoolTab || !row.members.some((m) => m.id === storePoolTab)) {
      storePoolTab = row.members.length ? row.members[0].id : null;
    }
    const union = new Set();
    const dup = new Set();
    for (const m of row.members) {
      for (const mid of Object.keys(m.models || {})) {
        if (union.has(mid)) dup.add(mid);
        else union.add(mid);
      }
    }
    const tabs = row.members.map((m) =>
      `<button class="seg-btn store-pool-tab" data-tab="${escapeHtml(m.id)}" role="radio" aria-checked="${m.id === storePoolTab}">${escapeHtml(m.displayName)}</button>`
    ).join("");
    body.innerHTML = `
      <div class="skills-detail-head">
        <div>
          <div class="skills-detail-name">${escapeHtml(row.displayName)} <span class="badge badge-pool">号池</span></div>
          <div class="skills-detail-relpath">${escapeHtml(row.id)} · 成员 ${row.members.length} 个 · 模型并集 ${union.size} · 重复 ${dup.size}</div>
        </div>
        <div class="skills-detail-actions">
          <button class="btn btn-mini" id="storePoolTestBtn">测试连接</button>
          <button class="btn btn-mini" id="storePoolRefreshBtn">刷新模型</button>
          <button class="btn btn-mini" id="storePoolRenameBtn">重命名</button>
          <button class="btn btn-mini btn-warn" id="storePoolDissolveBtn">解除号池</button>
          <button class="btn btn-mini btn-danger" id="storePoolDeleteBtn">删除</button>
        </div>
      </div>
      <div class="store-pool-tabs-row">
        <div class="seg-control store-pool-tabs" role="radiogroup">${tabs}</div>
        <button class="btn btn-mini" id="storePoolReorderBtn" title="调整成员调用顺序">调整顺序</button>
      </div>
      <div id="storePoolMemberDetail"></div>
    `;
    $("storePoolTestBtn").onclick = () => runStoreTest(row.members.map((m) => m.id), { btn: $("storePoolTestBtn") });
    $("storePoolRefreshBtn").onclick = () => storeRefresh(row.members.map((m) => m.id), { wholeLabel: row.displayName || row.id });
    $("storePoolRenameBtn").onclick = () => showRenamePoolModal(row);
    $("storePoolReorderBtn").onclick = () => openPoolReorderModal(row);
    $("storePoolDissolveBtn").onclick = () => confirmDissolvePool(row);
    $("storePoolDeleteBtn").onclick = () => confirmDeletePool(row);
    body.querySelectorAll(".store-pool-tab").forEach((tabBtn) => {
      tabBtn.onclick = () => {
        const id = tabBtn.getAttribute("data-tab");
        if (id !== storePoolTab) requestStoreFocus(row.id, id);
      };
    });
    const member = row.members.find((m) => m.id === storePoolTab);
    if (member) renderProviderDetail(member, $("storePoolMemberDetail"));
  }

  function renderProviderDetail(p, body) {
    const discoveredIds = Object.keys(p.discovered || {});
    // 勾选集初始化/同步：null（新选中或首次）或所属渠道变化时取 modelFilter；
    // 旧条目（null filter）初始全选 discovered——与懒迁移语义一致。
    if (!storeFilterChecked || storeFilterProviderId !== p.id) {
      storeFilterChecked = new Set(Array.isArray(p.modelFilter) ? p.modelFilter : discoveredIds);
      storeFilterProviderId = p.id;
      storeFilterDirty = false;
    }
    const poolDup = storePoolDuplicateModels(p);
    // 新增待读：本帧若有待读新增则置顶+高光呈现，渲染末尾立即消耗（这一帧即「看过」），
    // 之后任何重渲染都放回原位、撤下高光。以 render 为权威消耗点，避免刷新后自动重渲染
    // 抢在用户点击前白消耗——那一帧本身就是合法的「看过」。
    // 例外：本轮刷新在途（storeRefreshInFlight）时不消耗——逐渠道上屏会对同一张卡反复
    // 渲染，若第一帧就消耗，焦点渠道的高光会被后面渠道的上屏重渲抹掉；消费留给收尾那次
    // 全量重渲，可见语义与逐渠道上屏前一致。
    const newIds = storeNewIdsFor(p.id);
    const newSet = new Set(newIds);
    const highlight = newIds.length > 0;
    const orderedIds = highlight ? orderStoreModelIds(discoveredIds, newIds) : discoveredIds;
    const modelRows = orderedIds.map((mid) => {
      const meta = p.discovered[mid] || {};
      const checked = storeFilterChecked.has(mid);
      const effective = !!(p.models && p.models[mid]);
      const isNew = highlight && newSet.has(mid);
      const badges = [];
      if (poolDup && poolDup.has(mid)) badges.push(`<span class="badge badge-pool">号池</span>`);
      // 补录 = 该 id 目前只靠手动补录存着；某次刷新若发现上游已列出它，后端会清掉
      // 这个标记，徽标随之下线，此后再按普通探测模型对待（含被未探测到时的剪枝）。
      if (meta.manual === true) badges.push(`<span class="badge badge-accent">补录</span>`);
      if (meta.contextWindow) badges.push(`<span class="badge badge-neutral">${formatCtx(meta.contextWindow)}</span>`);
      if (meta.supportsReasoning) badges.push(`<span class="badge badge-neutral">推理</span>`);
      const mods = [...(meta.inputModalities || []), ...(meta.outputModalities || [])].filter((m) => m && m !== "text");
      if (mods.length) badges.push(`<span class="badge badge-neutral">${escapeHtml([...new Set(mods)].join("/"))}</span>`);
      if (effective) badges.push(`<span class="badge badge-ok">有效</span>`);
      return `
        <label class="store-model-row${isNew ? " store-model-row-new" : ""}" data-mid="${escapeHtml(mid)}">
          <input type="checkbox" data-mid="${escapeHtml(mid)}"${checked ? " checked" : ""}>
          <span class="store-model-id">${escapeHtml(mid)}</span>
          <span class="store-model-badges">${badges.join("")}</span>
        </label>`;
    }).join("");
    body.innerHTML = `
      <div class="skills-detail-head">
        <div>
          <div class="skills-detail-name">${escapeHtml(p.displayName)}</div>
          <div class="skills-detail-relpath">${escapeHtml(p.id)}</div>
        </div>
        <div class="skills-detail-actions">
          <button class="btn btn-mini" id="storeTestBtn">测试连接</button>
          <button class="btn btn-mini" id="storeRefreshOneBtn">刷新模型</button>
          <button class="btn btn-mini" id="storeRenameBtn">重命名</button>
          <button class="btn btn-mini" id="storeRotateBtn">更改配置</button>
          <button class="btn btn-mini btn-danger" id="storeDeleteBtn">删除</button>
        </div>
      </div>
      <dl class="store-detail-grid">
        <dt>Base URL</dt><dd>${escapeHtml(p.baseURL)}${p.fallbackURLs?.length ? `<span class="store-url-note">${p.fallbackURLs.length}个备用</span>` : ""}</dd>
      </dl>
      <div class="skills-group-title-row">
        <div class="skills-group-title" style="margin:0; padding-top:0; border-top:none;">模型管理</div>
      </div>
      <div class="store-model-toolbar">
        <button class="skills-anomaly-selectall" id="storeModelAllBtn">全选</button>
        <button class="skills-anomaly-selectall" id="storeModelNoneBtn">全不选</button>
        <span>已选 <b id="storeModelCheckedCount">${storeFilterChecked.size}</b> / ${discoveredIds.length}</span>
        <span style="flex:1"></span>
        <button class="btn btn-primary btn-mini" id="storeFilterSaveBtn"${storeFilterDirty ? "" : " disabled"}>保存过滤</button>
      </div>
      ${discoveredIds.length
        ? `<div class="store-model-list">${modelRows}</div>`
        : `<div class="skills-list-desc" style="padding:8px 0;">还没有模型，先点「刷新模型」。</div>`}
      <div class="store-manual-add">
        <textarea class="store-form-textarea" id="storeManualAddInput" rows="1"
          placeholder="手动添加在线发现没列出的模型 id，多个用逗号/空格/换行分隔"></textarea>
        <button class="btn btn-mini" id="storeManualAddBtn">手动添加</button>
      </div>
    `;
    bindStoreDetail(p);
    // 本帧已把待读新增置顶+高光呈现给用户 → 立即消耗，下次渲染放回原位
    // （本轮刷新在途时不消耗，见上方说明）
    if (highlight && !storeRefreshInFlight) consumeStoreNewModels(p.id);
  }

  function bindStoreDetail(p) {
    $("storeTestBtn").onclick = () => runStoreTest([p.id], { btn: $("storeTestBtn") });
    $("storeRefreshOneBtn").onclick = () => storeRefresh([p.id]);
    $("storeRenameBtn").onclick = () => showRenameProviderModal(p);
    $("storeRotateBtn").onclick = () => showRotateModal(p);
    // 池内渠道可直接删除：后端先摘池籍（池剩 1 人时解池）再走删除事务
    $("storeDeleteBtn").onclick = p.poolId
      ? () => confirmDeletePoolMember(p)
      : () => confirmDeleteProvider(p);
    $("storeModelAllBtn").onclick = () => {
      storeFilterChecked = new Set(Object.keys(p.discovered || {}));
      syncStoreFilterDirty(p);
      renderStoreDetail();
    };
    $("storeModelNoneBtn").onclick = () => {
      storeFilterChecked = new Set();
      syncStoreFilterDirty(p);
      renderStoreDetail();
    };
    const saveBtn = $("storeFilterSaveBtn");
    if (saveBtn) saveBtn.onclick = () => saveModelFilter(p);
    $("storeManualAddBtn").onclick = () => addManualModels(p);
    $("storeDetailBody").querySelectorAll('input[type="checkbox"][data-mid]').forEach((cb) => {
      cb.onchange = () => {
        const mid = cb.getAttribute("data-mid");
        if (cb.checked) storeFilterChecked.add(mid);
        else storeFilterChecked.delete(mid);
        syncStoreFilterDirty(p);
        $("storeModelCheckedCount").textContent = String(storeFilterChecked.size);
        saveBtn.disabled = !storeFilterDirty;
      };
    });
  }

  async function saveModelFilter(p) {
    const btn = $("storeFilterSaveBtn");
    btn.disabled = true;
    btn.textContent = "保存中…";
    try {
      const r = await api("POST", "/api/store/filter", { id: p.id, modelFilter: [...storeFilterChecked] });
      if (r.noop) toast("有效集无变化");
      else toast(`过滤已保存：有效模型 ${Array.isArray(r.effective) ? r.effective.length : "?"} 个`);
      storeFilterChecked = null; // 用刷新后的最新 modelFilter 重建勾选集
      storeFilterDirty = false;
      await refreshStoreState();
    } catch (e) {
      toast(panelError(e, "模型过滤保存失败"), true);
      btn.disabled = false;
    } finally {
      const b = $("storeFilterSaveBtn");
      if (b) b.textContent = "保存过滤";
    }
  }

  // 手动添加：在线发现漏报可调用模型时由用户补登。成功后勾选集重建
  // （新补录项已在 modelFilter 中，自动勾选）；失败 toast 后端 message/reason。
  async function addManualModels(p) {
    const input = $("storeManualAddInput");
    const btn = $("storeManualAddBtn");
    const modelIds = input.value.split(/[\s,，]+/).map((s) => s.trim()).filter(Boolean);
    if (!modelIds.length) {
      toast("请输入要补录的模型 id", true);
      return;
    }
    btn.disabled = true;
    try {
      const r = await api("POST", "/api/store/models/add", { providerId: p.id, modelIds });
      const added = Array.isArray(r.added) ? r.added : [];
      toast(`已补录 ${added.length} 个模型：${added.join("、")}`);
      storeFilterChecked = null; // 用刷新后的最新 modelFilter 重建勾选集
      storeFilterDirty = false;
      await refreshStoreState();
    } catch (e) {
      toast(panelError(e, "模型添加失败"), true);
      const b = $("storeManualAddBtn");
      if (b) b.disabled = false;
    }
  }

  // 删除模型：补录与探测缓存条目均可删。探测模型删除后若 refresh 上游仍报它会
  // 回到 discovered（但不在 modelFilter，呈未勾选）；补录模型删除后彻底消失。
  // 成功后从勾选集剔除该 id 并刷新重建；失败 toast 后端 message。
  async function removeStoreModel(p, mid) {
    try {
      await api("POST", "/api/store/models/remove", { providerId: p.id, modelIds: [mid] });
      toast(`已删除模型：${mid}`);
      if (storeFilterChecked) storeFilterChecked.delete(mid);
      await refreshStoreState();
    } catch (e) {
      toast(panelError(e, "删除失败"), true);
    }
  }

  // 通用动作：成功后 toast 自定义文案并刷新；cas-conflict 自动重拉状态
  async function storeAction(path, body, okText) {
    try {
      const r = await api("POST", path, body);
      toast(typeof okText === "function" ? okText(r) : okText);
      await refreshStoreState();
      return r;
    } catch (e) {
      if (e.code === "cas-conflict") {
        toast("渠道配置已被其他操作改动，已重新拉取最新状态", true);
        await refreshStoreState();
      } else {
        toast(panelError(e, "操作失败"), true);
      }
      return null;
    }
  }

  // ── 测试连接在途/结果反馈：复用刷新状态小字（busy 逐字波 → done/err 收尾） ──
  // 三入口（单渠道详情钮、号池详情钮、右键菜单）共用；storeTestBusy 防并发重入
  // （详情钮还会自身 disabled，菜单无可禁用元素，全靠这个标志挡第二轮）。
  let storeTestBusy = false;
  // ids：按可见行展开后的渠道 id 序列；labelMap 解析显示名（池行取池名）。
  // opts：{ btn } 仅详情钮传——按下即禁用改文案，finally 复位；右键菜单不传。
  // 测试失败原因上屏：后端 /api/store/test 的 error 是英文技术语，界面只出产品
  // 语言、原文进控制台（panelError 既有契约），这里按已知模式翻成用户语义，
  // 翻不出走 panelError 兜底。HTTP 200 例外：它只出现在 api() 给 message 拼的
  // 「HTTP <状态>：」前缀里（后端 error 缺失落到 message 时），不是渠道返回的状态码
  function storeTestErrorText(e) {
    const raw = String((e && e.code) || (e && e.message) || "");
    const m = raw.match(/HTTP (\d{3})/);
    if (m && m[1] !== "200") {
      const s = m[1];
      if (s === "401" || s === "403") return `渠道拒绝了测试请求（HTTP ${s}），请检查密钥是否有效`;
      if (s === "404") return "接口地址不存在（HTTP 404），请检查 Base URL";
      if (s.startsWith("5")) return `渠道服务端异常（HTTP ${s}）`;
      return `渠道返回 HTTP ${s}`;
    }
    if (/timed out/i.test(raw)) return "测试请求超时，渠道长时间未响应";
    if (/request failed/i.test(raw)) return "无法发出网络请求，请检查网络连接与接口地址";
    if (/not managed by Anyswitch/.test(raw)) return "该渠道已不存在，请刷新渠道列表";
    if (/store is unavailable/.test(raw)) return "渠道配置库暂不可用，请稍后再试";
    return panelError(e, "连接测试未通过");
  }
  async function runStoreTest(ids, opts) {
    if (storeTestBusy) return null;
    storeTestBusy = true;
    const btn = opts && opts.btn;
    if (btn) { btn.disabled = true; btn.textContent = "测试中…"; }
    const rows = storeRows();
    const labelMap = new Map();
    for (const r of rows) {
      if (r.kind === "pool") for (const m of r.members) labelMap.set(m.id, r.displayName || m.displayName || m.id);
      else labelMap.set(r.p.id, r.p.displayName || r.p.id);
    }
    const multi = ids.length > 1;
    let ok = 0;
    const failed = []; // { label, reason }
    try {
      for (let i = 0; i < ids.length; i++) {
        const id = ids[i];
        const prog = multi ? ` · ${i + 1}/${ids.length}` : "";
        const label = labelMap.get(id) || id;
        setStoreRefreshStatus("正在测试连接..", "busy", `${escapeHtml(label)}${prog}`);
        try {
          const r = await api("POST", "/api/store/test", { id });
          ok++;
          setStoreRefreshStatus("正在测试连接..", "busy",
            `<span class="srs-pos">${escapeHtml(label)} 可用（${r.modelCount} 个模型）</span>${prog}`);
        } catch (e) {
          const reason = storeTestErrorText(e);
          failed.push({ label, reason });
          setStoreRefreshStatus("正在测试连接..", "busy",
            `<span class="srs-neg">${escapeHtml(label)} 连接失败：${escapeHtml(reason)}</span>${prog}`);
        }
      }
      const last = labelMap.get(ids[ids.length - 1]) || ids[ids.length - 1];
      if (!failed.length) {
        const tail = multi
          ? `<span class="srs-pos">${ok} 个渠道全部可用</span>`
          : `<span class="srs-pos">${escapeHtml(last)} 可用</span>`;
        setStoreRefreshStatus("测试完成", "done", tail);
        toast(multi ? `${ok} 个渠道全部可用` : `${last} 可用`);
      } else if (multi) {
        // 号池/多选才上汇总结构；单渠道直接一句结论带原因
        const detail = failed.map((f) => `${f.label}：${f.reason}`).join("；");
        setStoreRefreshStatus("测试完成", "err",
          `<span class="srs-neg">${ok} 个可用、${failed.length} 个连接失败（${escapeHtml(detail)}）</span>`);
        toast(`${ok} 个渠道可用、${failed.length} 个连接失败（${detail}）`, true);
      } else {
        const f = failed[0];
        setStoreRefreshStatus("测试完成", "err",
          `<span class="srs-neg">${escapeHtml(f.label)} 连接失败：${escapeHtml(f.reason)}</span>`);
        toast(`${f.label} 连接失败：${f.reason}`, true);
      }
      return { ok, failed };
    } finally {
      storeTestBusy = false;
      if (btn) { btn.disabled = false; btn.textContent = "测试连接"; }
    }
  }

  // ── 新增模型待读态：刷新后把本轮 added 记入 localStorage；该渠道详情第一次带着
  // 新增态渲染出来时置顶 + 高光（这一帧即「看过」），渲染末尾立即消耗，之后任何
  // 重渲染都放回原位、撤下高光。纯前端机制，不动 store 落盘。
  // 数据形状：{ [providerId]: { ids: [modelId...], ts: epochMs } }，ts 仅作老化兜底。
  const STORE_NEW_MODELS_KEY = "store-new-models";
  const STORE_NEW_MODELS_TTL_MS = 7 * 24 * 3600 * 1000; // 7 天未看自动老化，防永久残留
  let storeNewModels = null;      // 惰性从 localStorage 载入的待读表
  // 本轮刷新在途标记：在途期间详情卡只渲染新增高光、不消费待读表——逐渠道上屏会对
  // 同一张卡反复重渲，首帧就消费会让焦点渠道的高光被后续渠道的上屏抹掉。消费留给
  // 收尾那次全量重渲（见 storeRefresh），可见语义与逐渠道上屏前一致。
  let storeRefreshInFlight = false;

  function loadStoreNewModels() {
    if (storeNewModels) return storeNewModels;
    storeNewModels = {};
    try {
      const raw = localStorage.getItem(STORE_NEW_MODELS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) storeNewModels = parsed;
      }
    } catch { storeNewModels = {}; }
    return storeNewModels;
  }
  function saveStoreNewModels() {
    try { localStorage.setItem(STORE_NEW_MODELS_KEY, JSON.stringify(storeNewModels || {})); } catch {}
  }
  // 刷新后登记：added 并入该渠道待读集（去重、保序），ts 刷新
  function markStoreNewModels(providerId, addedIds) {
    if (!Array.isArray(addedIds) || !addedIds.length) return;
    const map = loadStoreNewModels();
    const cur = map[providerId] && Array.isArray(map[providerId].ids) ? map[providerId].ids : [];
    const seen = new Set(cur);
    for (const id of addedIds) if (typeof id === "string" && id && !seen.has(id)) { seen.add(id); cur.push(id); }
    map[providerId] = { ids: cur, ts: Date.now() };
    saveStoreNewModels();
  }
  // 该渠道当前待读的新增 id（过滤已失效/已老化项；有清理时回写）
  function storeNewIdsFor(providerId) {
    const map = loadStoreNewModels();
    const entry = map[providerId];
    if (!entry || !Array.isArray(entry.ids) || !entry.ids.length) return [];
    if (typeof entry.ts === "number" && Date.now() - entry.ts > STORE_NEW_MODELS_TTL_MS) {
      delete map[providerId]; saveStoreNewModels(); return [];
    }
    const p = storeProviders().find((x) => x.id === providerId);
    const valid = p ? new Set(Object.keys(p.discovered || {})) : null;
    const ids = valid ? entry.ids.filter((id) => valid.has(id)) : entry.ids;
    if (ids.length !== entry.ids.length) {
      if (ids.length) map[providerId] = { ids, ts: entry.ts };
      else delete map[providerId];
      saveStoreNewModels();
    }
    return ids;
  }
  // 消耗：该渠道待读集清空（看过之后调用）
  function consumeStoreNewModels(providerId) {
    const map = loadStoreNewModels();
    if (map[providerId]) { delete map[providerId]; saveStoreNewModels(); }
  }
  // 模型 id 排序：待读新增置顶（组内保原相对序），其余保原序
  function orderStoreModelIds(discoveredIds, newIds) {
    if (!newIds || !newIds.length) return discoveredIds;
    const newSet = new Set(newIds);
    const fresh = discoveredIds.filter((id) => newSet.has(id));
    const rest = discoveredIds.filter((id) => !newSet.has(id));
    return [...fresh, ...rest];
  }

  // ── 「全部刷新」右侧的刷新状态小字（替代 toast）：每次写入重置 10s 存活计时 ──
  // mode：busy = text 逐字窄波；done = text 整体高光（「刷新完成」）；ok/err = 纯文本。
  //      中途单渠道失败只红该渠道 tail 分段，完成态永不整行染红；
  //      err 仅用于 cas-conflict 或整次异常。
  let storeStatusTimer = null;
  // 当前小字模式：busy 整段在途只有开头一次写入，淡出兜底要长过最长在途时长
  // （后端探测 30s 超时硬顶），结论态维持 10s
  let storeStatusMode = null;
  // 「等切回」一次性标记：刷新终态落小字那一刻人不在渠道 tab → 置位并暂停 10s
  // 淡出计时，直到用户切回（switchView 消费、重新计一个完整 10s）；此后再切走
  // 不再暂停。完成时人就在 tab、之后才走的不置位——结果已被亲眼看到
  let storeStatusAwaitReturn = false;
  function srsWaveHtml(text) {
    // 逐字窄波：每字一个 span，延迟 120ms 依次点亮；亮窗由 keyframe 压在周期
    // 前段 50% 内，同一时刻至多相邻五六字柔和叠亮，波峰扫过随周期尾部停顿重来
    return [...text].map((ch, i) =>
      `<span class="srs-ch" style="animation-delay:${i * 120}ms">${escapeHtml(ch)}</span>`).join("");
  }
  // 元素内固定 prefix/tail/diff 三个子 span：prefix 按指纹比对只在变化时重建
  // innerHTML，tail（HTML，分段着色）独立更新——逐渠道刷新只换 tail，
  // 窄波动画不重启；diff（「查看差异」高光小字）仅完成态挂出
  function setStoreRefreshStatus(text, mode, tailHtml, showDiff) {
    const el = $("storeRefreshStatus");
    if (!el) return;
    let prefix = el.querySelector(".srs-prefix");
    let tail = el.querySelector(".srs-tail");
    let diff = el.querySelector(".srs-diff-link");
    if (!prefix || !tail || !diff) {
      el.innerHTML = '<span class="srs-prefix"></span><span class="srs-tail"></span><span class="srs-diff-link" hidden>查看差异</span>';
      prefix = el.querySelector(".srs-prefix");
      tail = el.querySelector(".srs-tail");
      diff = el.querySelector(".srs-diff-link");
      diff.onclick = () => { openStoreDiffModal(); };
    }
    el.classList.toggle("err", mode === "err");
    storeStatusMode = mode;
    const key = `${mode}:${text}`;
    if (prefix.dataset.key !== key) {
      prefix.dataset.key = key;
      if (mode === "busy") prefix.innerHTML = srsWaveHtml(text);
      else if (mode === "done") prefix.innerHTML = `<span class="srs-done">${escapeHtml(text)}</span>`;
      else prefix.textContent = text;
    }
    tail.innerHTML = tailHtml || "";
    diff.hidden = !showDiff;
    el.classList.add("show");
    armStoreStatusTimer();
  }
  // 淡出计时：结论态 10s；busy 态 60s——在途整段只有开头一次写入，兜底要长过
  // 最长在途时长（后端探测 30s 超时硬顶）。弹窗打开期间暂停（计时器清掉、不
  // 重新武装），关闭弹窗时若状态小字仍可见则按当前模式重新武装一个完整周期
  function armStoreStatusTimer() {
    const el = $("storeRefreshStatus");
    if (storeStatusTimer) { clearTimeout(storeStatusTimer); storeStatusTimer = null; }
    storeStatusTimer = setTimeout(() => {
      el.classList.remove("show");
      storeStatusTimer = null;
    }, storeStatusMode === "busy" ? 60000 : 10000);
  }
  function disarmStoreStatusTimer() {
    if (storeStatusTimer) { clearTimeout(storeStatusTimer); storeStatusTimer = null; }
  }

  // ── 自动同步失败上屏 ──
  // 每次同步（relay 启动、渠道改动自动触发、推理强度切换）后结果落在服务端，
  // 这里每 3s 轮询一次：失败时把「上次同步未成功」持久挂在「全部刷新」按钮旁
  // （状态而非一次性回执——前置条件还在就该在；成功或「无从报告」时清空隐藏），
  // 且 at 变化（＝发生了一次新的失败）时无论人在哪个页签都弹一次 toast。
  // 首帧拉到的历史失败只渲染不弹，避免进面板就被旧失败轰炸。
  let syncStatusLastAt = undefined; // undefined = 首帧尚未拉到
  function formatSyncStatusAt(at) {
    const d = new Date(at);
    if (isNaN(d.getTime())) return String(at);
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }
  function syncStatusFailureText(status) {
    const failed = Array.isArray(status.failed) ? status.failed : [];
    return failed.length
      ? `上次同步未成功：${failed.map((id) => statsEndpointLabel(id)).join("、")}`
      : "上次同步未成功：端点配置未更新";
  }
  function renderSyncStatus(status) {
    const el = $("storeSyncStatus");
    if (!el) return;
    if (!status || status.at == null || status.ok !== false) {
      el.textContent = "";
      el.removeAttribute("title");
      el.classList.remove("show", "err");
      return;
    }
    el.textContent = syncStatusFailureText(status);
    el.title = `发生时间：${formatSyncStatusAt(status.at)}`;
    el.classList.add("show", "err");
  }
  async function pollSyncStatus() {
    let status;
    try {
      status = await api("GET", "/api/sync-status");
    } catch {
      return; // 拉不到保持现状，下轮再试
    }
    const isNewFailure =
      syncStatusLastAt !== undefined && status && status.ok === false &&
      status.at != null && status.at !== syncStatusLastAt;
    renderSyncStatus(status);
    if (status && status.at != null) syncStatusLastAt = status.at;
    if (isNewFailure) toast(syncStatusFailureText(status), true);
  }
  function startSyncStatusPolling() {
    pollSyncStatus();
    setInterval(() => {
      if (document.hidden) return;
      pollSyncStatus();
    }, 3000);
  }

  // 刷新终态远离通报：人不在渠道 tab 时弹结果 toast（8s 驻留，比常规 3s 长——
  // 要留点击窗口；持久载体是暂停的小字，toast 只是即时报信），本轮确有增减/失败
  // 时附可点「查看差异」，点中原地开差异弹窗、不切 tab；同时置「等切回」标记并
  // 停掉小字淡出计时，让结果留到用户切回。人在渠道 tab 时一切照旧
  function notifyStoreRefreshAway(text, isErr, hasDiff) {
    if (currentView === "store") return;
    storeStatusAwaitReturn = true;
    disarmStoreStatusTimer();
    toast(text, isErr, {
      durationMs: 8000,
      action: hasDiff ? { label: "查看差异", onClick: () => openStoreDiffModal() } : null,
    });
  }

  // 渠道 diff 只摆增减数字，不列具体模型 id（长列表会爆格）；分段着色：
  // 失败整段红，updated 增绿减红，unchanged 中性色；label = 按可见行解析的
  // 显示名（池行取池名），缺失时兜底裸 providerId
  function storeReportHtml(rep, label) {
    const id = escapeHtml(label || rep.providerId);
    if (rep.status === "failed") {
      return `<span class="srs-neg">${id} 失败（${escapeHtml(rep.reason || "unknown")}）</span>`;
    }
    if (rep.status === "unchanged") return `${id} 无变化`;
    return `${id} <span class="srs-pos">+${(rep.added || []).length}</span>` +
      ` <span class="srs-neg">−${(rep.pruned || []).length}</span>`;
  }

  // 聚合 diff 总览（号池整体刷新用）：增绿/减红/失败红按需拼接，全零且无失败 = 无变化
  function storeAggregateHtml(totAdded, totPruned, failCount) {
    const parts = [];
    if (totAdded) parts.push(`<span class="srs-pos">+${totAdded}</span>`);
    if (totPruned) parts.push(`<span class="srs-neg">−${totPruned}</span>`);
    if (failCount) parts.push(`<span class="srs-neg">${failCount} 个失败</span>`);
    return parts.length ? parts.join(" ") : "无变化";
  }

  // ── 「查看差异」弹窗：本轮刷新的完整增减明细（状态小字只摆数字，这里列模型 id） ──
  // refreshDiffUnits 由 storeRefresh 每轮重填；弹窗打开期间暂停状态小字的 10s
  // 淡出计时，关闭时若状态小字仍可见则重新武装一个完整 10s
  let refreshDiffUnits = [];
  function storeDiffGroupHtml(units, key, rowClass) {
    const parts = [];
    for (const u of units) {
      const ids = u[key] || [];
      if (!ids.length) continue;
      parts.push(`<div class="diff-modal-group-title">${escapeHtml(u.label)}</div>`);
      for (const id of ids) {
        parts.push(`<div class="diff-modal-row ${rowClass}">${escapeHtml(id)}</div>`);
      }
    }
    return parts.length ? parts.join("") : `<div class="diff-modal-empty">无</div>`;
  }
  function openStoreDiffModal() {
    const fails = refreshDiffUnits.filter((u) => u.failed);
    const failEl = $("storeDiffFails");
    if (fails.length) {
      failEl.innerHTML = fails.map((u) =>
        `<div class="diff-modal-fail-row">${escapeHtml(u.label)} 失败（${escapeHtml(panelCopy(u.reason, "原因见面板日志"))}）</div>`).join("");
      failEl.hidden = false;
    } else {
      failEl.innerHTML = "";
      failEl.hidden = true;
    }
    const totAdded = refreshDiffUnits.reduce((n, u) => n + (u.added || []).length, 0);
    const totPruned = refreshDiffUnits.reduce((n, u) => n + (u.pruned || []).length, 0);
    $("storeDiffAddedTitle").textContent = `新增 +${totAdded}`;
    $("storeDiffPrunedTitle").textContent = `移除 −${totPruned}`;
    $("storeDiffAddedBody").innerHTML = storeDiffGroupHtml(refreshDiffUnits, "added", "diff-added");
    $("storeDiffPrunedBody").innerHTML = storeDiffGroupHtml(refreshDiffUnits, "pruned", "diff-pruned");
    $("storeDiffMask").classList.add("show");
    // 弹窗打开期间暂停状态小字淡出计时（点开即视为用户正在查看，不该淡出）
    disarmStoreStatusTimer();
  }
  function closeStoreDiffModal() {
    $("storeDiffMask").classList.remove("show");
    // 关闭时状态小字仍可见则重新武装 10s（用户看完 diff，状态小字继续正常淡出）；
    // 「等切回」标记未消费时不武装——弹窗可能是在别的 tab 从 toast 点开的，人还没
    // 回过渠道 tab，小字要继续暂停等他切回
    if (!storeStatusAwaitReturn && $("storeRefreshStatus") && $("storeRefreshStatus").classList.contains("show")) armStoreStatusTimer();
  }

  // 刷新：全部刷新/多选刷新按可见行分组——号池行整行一个单元（成员逐个刷，
  // 显示池名 + 聚合 diff，与号池详情「刷新模型」同语义），独立渠道各一单元；
  // 进行中：状态小字 = 窄波的「正在刷新..」前缀 + 单元结果（结构化着色，只摆增减
  // 数字），窄波效果贯穿长时程刷新全程；整池单元（aggregate）刷期间小字保持池粒度
  // （不逐成员替换，池名持续到本单元收尾），池聚合结果落单元收尾；全部完成后 =
  // 整体高光「刷新完成」+ tail 保留最后一个单元结果，完成态不整行染红。
  // 刷完一个展现一个：每个渠道的请求返回后立刻取其最新状态上屏（详情卡模型列表、
  // 新增高光、号池并集/重复计数、总览模型计数），不等整轮跑完——后端本就是
  // 一渠道一请求、发现完即落盘，取回来就是最新态；逐渠道上屏只走数据面，状态
  // 小字不随之逐成员替换。
  async function storeRefresh(ids, opts) {
    const all = !ids;
    const wholeLabel = (opts && opts.wholeLabel) || "";
    const btn = all ? $("storeRefreshAllBtn") : $("storeRefreshOneBtn");
    // 单元 = 列表里一行：{ ids: [渠道id...], label: 显示名, aggregate: 池聚合 }
    let units;
    if (wholeLabel) {
      units = [{ ids, label: wholeLabel, aggregate: true }];
    } else {
      const idSet = all ? null : new Set(ids);
      units = [];
      for (const row of storeRows()) {
        if (row.kind === "pool") {
          const memberIds = row.members.map((m) => m.id).filter((id) => all || idSet.has(id));
          if (memberIds.length) units.push({ ids: memberIds, label: row.displayName || row.id, aggregate: memberIds.length > 1 });
        } else if (all || idSet.has(row.id)) {
          units.push({ ids: [row.id], label: row.p.displayName || row.id });
        }
      }
    }
    const multi = units.length > 1;                                   // 进度按可见行计数
    const batch = units.reduce((n, u) => n + u.ids.length, 0) > 1;    // 多渠道尽力而为：单点失败不中断
    if (btn) { btn.disabled = true; btn.textContent = "刷新中…"; }
    let lastTail = "";
    // 本轮 diff 明细快照：每单元一条 {label, added[], pruned[], failed, reason}，
    // 供「查看差异」弹窗按单元分组渲染；池聚合单元合并成员数组为池级
    refreshDiffUnits = [];
    try {
      if (!units.length) {
        setStoreRefreshStatus("无可刷新渠道", "ok");
        return;
      }
      // 在途标记：期间详情卡只渲染新增高光、不消费待读表（逐渠道上屏会对同一张卡
      // 反复重渲，首帧就消费会让焦点渠道的高光被后续渠道的上屏抹掉）
      storeRefreshInFlight = true;
      for (let i = 0; i < units.length; i++) {
        const unit = units[i];
        const prog = multi ? ` · ${i + 1}/${units.length}` : "";
        // 仅首个单元先亮「正在刷新.. 行名」；其后循环开头不覆盖 tail——上一单元
        // 的结果保留显示到本单元刷完。结果一到就被下一单元的 busy 提示同步覆盖，
        // 浏览器来不及绘制，那一段 diff 等于没显示过。
        if (i === 0) setStoreRefreshStatus("正在刷新..", "busy", `${escapeHtml(unit.label)}${prog}`);
        let uAdded = 0, uPruned = 0, uFail = 0, uRep = null, uErr = "";
        const uAddedIds = [], uPrunedIds = [];
        for (const id of unit.ids) {
          try {
            const r = await api("POST", "/api/store/refresh", { id });
            const rep = (r.reports || [])[0];
            if (rep) {
              if (rep.status === "failed") {
                uFail++;
                if (!uErr) uErr = rep.reason || "unknown";
              } else if (rep.status === "updated") {
                uAdded += (rep.added || []).length;
                uPruned += (rep.pruned || []).length;
                uAddedIds.push(...(rep.added || []));
                uPrunedIds.push(...(rep.pruned || []));
                markStoreNewModels(id, rep.added || []);
              }
              if (!unit.aggregate) uRep = rep;
            }
          } catch (e) {
            if (e.code === "cas-conflict" || !batch) throw e;
            // 批量刷新：单点失败只计入本单元，不中断后续渠道
            uFail++;
            uErr = panelError(e, "原因见面板日志");
          }
          // 刷完一个展现一个：本渠道最新状态取回来上屏（新增高光上一步已登记）；
          // 状态小字不逐成员替换——整池单元进行中保持池名，结果落单元收尾
          await refreshStoreModelsView();
        }
        refreshDiffUnits.push({
          label: unit.label,
          added: uAddedIds,
          pruned: uPrunedIds,
          failed: uFail > 0,
          reason: uErr,
        });
        const resHtml = unit.aggregate
          ? `${escapeHtml(unit.label)} ${storeAggregateHtml(uAdded, uPruned, uFail)}`
          : uErr ? `<span class="srs-neg">${escapeHtml(unit.label)} 刷新失败：${escapeHtml(panelCopy(uErr, "原因见面板日志"))}</span>`
          : uRep ? storeReportHtml(uRep, unit.label)
          : `${escapeHtml(unit.label)} 无结果`;
        lastTail = `${resHtml}${prog}`;
        if (!wholeLabel) setStoreRefreshStatus("正在刷新..", "busy", lastTail);
      }
      // 收尾：先撤在途标记，这次全量重渲负责消费本轮新增高光，并让列表行/路由链归位
      storeRefreshInFlight = false;
      await refreshStoreState();
      // 本轮确有增减或失败时才挂「查看差异」小字；全零无变化不显示（没东西可看）
      const hasDiff = refreshDiffUnits.some((u) => u.failed || u.added.length > 0 || u.pruned.length > 0);
      setStoreRefreshStatus("刷新完成", "done", lastTail, hasDiff);
      // 人不在渠道 tab：弹结果 toast 并暂停小字淡出等切回。toast 用聚合口径
      // （小字 tail 只摆最后一个单元，toast 报全轮合计才完整）
      const totAdded = refreshDiffUnits.reduce((n, u) => n + u.added.length, 0);
      const totPruned = refreshDiffUnits.reduce((n, u) => n + u.pruned.length, 0);
      const totFailed = refreshDiffUnits.filter((u) => u.failed).length;
      const totParts = [];
      if (totAdded) totParts.push(`+${totAdded}`);
      if (totPruned) totParts.push(`−${totPruned}`);
      if (totFailed) totParts.push(`${totFailed} 个失败`);
      notifyStoreRefreshAway(`刷新完成：${totParts.length ? totParts.join(" ") : "无变化"}`, false, hasDiff);
    } catch (e) {
      // 中断也要撤在途标记，否则新增高光一直不消费（下一次渲染就补上消费）
      storeRefreshInFlight = false;
      if (e.code === "cas-conflict") {
        setStoreRefreshStatus("渠道配置已被其他操作改动，正在刷新", "err");
        await refreshStoreState();
        notifyStoreRefreshAway("渠道配置已被其他操作改动，本次刷新未完成", true, false);
      } else {
        const errText = panelError(e, "刷新失败");
        setStoreRefreshStatus(errText, "err");
        notifyStoreRefreshAway(errText, true, false);
      }
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = all ? "全部刷新" : "刷新模型"; }
    }
  }

  // ── 新增渠道 modal（发现失败时保留内容，提示手填模型 IDs 重试） ──
  // 「创建号池」开关在弹窗标题右侧：开启后出现「渠道数量」数字框（2-5 默认 2，
  // 复用 modal-number + clamp 模式），正文渲染对应份数的资料栏位组；
  // 第 2 份起 Base URL 留空 = 与资料 1 一致。全成功才建池，中途失败整体回滚。
  const STORE_ADD_POOL_MIN = 2;
  const STORE_ADD_POOL_MAX = 5;
  function clampStoreAddCount(value) {
    const n = parseInt(value, 10);
    if (!Number.isInteger(n) || n < STORE_ADD_POOL_MIN) return STORE_ADD_POOL_MIN;
    return Math.min(STORE_ADD_POOL_MAX, n);
  }

  // 从弹窗 DOM 收集当前已填内容（密钥不回填），供开关/数量变化与错误重开时恢复
  function collectAddModalValues() {
    const body = $("skillsModalBody");
    const v = {
      poolOn: !!$("storeAddPoolToggle")?.checked,
      poolCount: clampStoreAddCount($("storeAddPoolCount")?.value ?? STORE_ADD_POOL_MIN),
      poolName: $("storeAddPoolName")?.value ?? "",
      poolId: $("storeAddPoolId")?.value ?? "",
      poolIdTouched: ($("storeAddPoolId")?.dataset.touched || "") === "1",
      id: $("storeAddId")?.value.trim() ?? "",
      idTouched: ($("storeAddId")?.dataset.touched || "") === "1",
      displayName: $("storeAddName")?.value.trim() ?? "",
      baseURLs: $("storeAddUrls")?.value.trim() ?? "",
      modelIdsText: $("storeAddModels")?.value ?? "",
      sets: [],
    };
    body.querySelectorAll(".store-add-set").forEach((setEl) => {
      v.sets.push({
        id: setEl.querySelector(".set-id").value.trim(),
        idTouched: (setEl.querySelector(".set-id").dataset.touched || "") === "1",
        displayName: setEl.querySelector(".set-name").value.trim(),
        baseURLs: setEl.querySelector(".set-urls").value.trim(),
        modelIdsText: setEl.querySelector(".set-models").value,
      });
    });
    return v;
  }

  function addSetHtml(k, s) {
    return `
      <div class="store-add-set">
        <div class="store-add-set-title">资料 ${k + 1}</div>
        <div class="store-form-row"><label class="store-form-label">显示名</label>
          <input class="store-form-input set-name" value="${escapeHtml(s.displayName || "")}"></div>
        <div class="store-form-row"><label class="store-form-label">渠道 ID（字母数字 . _ -，不可含 /）</label>
          <input class="store-form-input set-id" value="${escapeHtml(s.id || "")}" data-touched="${s.idTouched ? "1" : "0"}" placeholder="如 myprovider-${k + 1}"></div>
        <div class="store-form-row"><label class="store-form-label">Base URL${k === 0 ? "（逗号分隔，首个为主、其余为回退；不写协议默认 https，需要 http 时显式以 http:// 开头）" : "（留空 = 与资料 1 一致）"}</label>
          <input class="store-form-input set-urls" value="${escapeHtml(s.baseURLs || "")}" placeholder="${k === 0 ? "https://api.example.com/v1" : "留空 = 与资料 1 一致"}"></div>
        <div class="store-form-row"><label class="store-form-label">API 密钥（仅本机加密保存，保存后不再显示）</label>
          <input class="store-form-input set-key" type="password" autocomplete="new-password"></div>
        <div class="store-form-row"><label class="store-form-label">模型 IDs（可选，每行一个；留空则在线发现）</label>
          <textarea class="store-form-textarea set-models">${escapeHtml(s.modelIdsText || "")}</textarea></div>
      </div>`;
  }

  // 显示名 → 渠道 ID 的联动合法化：小写化、非法字符段折叠为 -、剥离开头非字母
  // 数字、上限 127（沿用 poolSlugify 那套规则再截长）；纯中文等合法化结果为空
  // 的场景留空不硬造。
  function storeAddIdFromName(name) {
    return poolSlugify(name).slice(0, 127);
  }

  // 显示名输入时 id 行实时联动自动填；用户手动改过 id 行后联动即断，
  // 再清空 id 行可恢复联动（data-touched 是唯一真相，随 collectAddModalValues 跨重开留存）
  function wireStoreAddNameIdLinkage(nameInput, idInput) {
    nameInput.oninput = () => {
      if (idInput.dataset.touched !== "1") idInput.value = storeAddIdFromName(nameInput.value);
    };
    idInput.oninput = () => {
      idInput.dataset.touched = idInput.value.trim() ? "1" : "0";
    };
  }

  function showAddModal(prefill) {
    const v = prefill || {};
    const poolOn = !!v.poolOn;
    const poolCount = clampStoreAddCount(v.poolCount ?? STORE_ADD_POOL_MIN);
    const sets = [];
    for (let k = 0; k < poolCount; k++) sets.push(v.sets && v.sets[k] ? v.sets[k] : {});
    const bodyHtml = poolOn
      ? `
        <div class="store-add-scroll">
        <div class="store-form-row"><label class="store-form-label">号池名（展示用，与渠道名独立）</label>
          <input class="store-form-input" id="storeAddPoolName" value="${escapeHtml(v.poolName || "")}" placeholder="如 主力号池"></div>
        <div class="store-form-row"><label class="store-form-label">号池 ID（字母数字 . _ -，不可含 /；留空自动由号池名生成）</label>
          <input class="store-form-input" id="storeAddPoolId" value="${escapeHtml(v.poolId || "")}" data-touched="${v.poolIdTouched ? "1" : "0"}" placeholder="如 main-pool"></div>
        ${sets.map((s, k) => addSetHtml(k, s)).join("")}
        </div>
        <div class="store-form-error" id="storeAddError" hidden></div>`
      : `
        <div class="store-form-row"><label class="store-form-label">显示名</label>
          <input class="store-form-input" id="storeAddName" value="${escapeHtml(v.displayName || "")}" placeholder="如 My Provider"></div>
        <div class="store-form-row"><label class="store-form-label">渠道 ID（字母数字 . _ -，不可含 /）</label>
          <input class="store-form-input" id="storeAddId" value="${escapeHtml(v.id || "")}" data-touched="${v.idTouched ? "1" : "0"}" placeholder="如 myprovider"></div>
        <div class="store-form-row"><label class="store-form-label">Base URL（逗号分隔，首个为主、其余为回退；不写协议默认 https，需要 http 时显式以 http:// 开头）</label>
          <input class="store-form-input" id="storeAddUrls" value="${escapeHtml(v.baseURLs || "")}" placeholder="https://api.example.com/v1"></div>
        <div class="store-form-row"><label class="store-form-label">API 密钥（仅本机加密保存，保存后不再显示）</label>
          <input class="store-form-input" type="password" id="storeAddKey" autocomplete="new-password"></div>
        <div class="store-form-row"><label class="store-form-label">模型 IDs（可选，每行一个；留空则在线发现，发现失败时必须手填）</label>
          <textarea class="store-form-textarea" id="storeAddModels" placeholder="gpt-5&#10;claude-sonnet-4">${escapeHtml(v.modelIdsText || "")}</textarea></div>
        <div class="store-form-error" id="storeAddError" hidden></div>`;
    showSkillsModal({
      title: "新增渠道",
      wide: true,
      confirmText: poolOn ? "创建并组建号池" : "添加",
      bodyHtml,
      onConfirm: async () => {
        if (poolOn) {
          await submitAddPoolModal();
        } else {
          await submitAddSingleModal();
        }
      },
    });
    // 标题右侧注入「创建号池」开关 + 「渠道数量」数字框（开启后显示）
    $("skillsModalTitle").insertAdjacentHTML("beforeend",
      `<span class="store-add-pool-ctl" id="storeAddPoolCtl">
        <span>创建号池</span>
        <label class="toggle"><input type="checkbox" id="storeAddPoolToggle"${poolOn ? " checked" : ""}><span class="slider"></span></label>
        <span id="storeAddPoolCountWrap"${poolOn ? "" : " hidden"}>渠道数量
          <input class="modal-number" id="storeAddPoolCount" type="number" min="${STORE_ADD_POOL_MIN}" max="${STORE_ADD_POOL_MAX}" step="1" value="${poolCount}"></span>
      </span>`);
    const reopen = (mutate) => {
      const values = collectAddModalValues();
      mutate(values);
      showAddModal(values);
    };
    $("storeAddPoolToggle").onchange = (e) => reopen((values) => { values.poolOn = e.target.checked; });
    $("storeAddPoolCount").onchange = (e) => reopen((values) => { values.poolCount = clampStoreAddCount(e.target.value); });
    if (poolOn) {
      const nameInput = $("storeAddPoolName");
      const idInput = $("storeAddPoolId");
      nameInput.oninput = () => {
        if (idInput.dataset.touched !== "1") idInput.value = poolSlugify(nameInput.value);
      };
      idInput.oninput = () => {
        idInput.dataset.touched = idInput.value.trim() ? "1" : "0";
      };
      // 每份资料同规则：显示名联动渠道 ID，手动改过即断、清空恢复
      $("skillsModalBody").querySelectorAll(".store-add-set").forEach((setEl) => {
        wireStoreAddNameIdLinkage(setEl.querySelector(".set-name"), setEl.querySelector(".set-id"));
      });
    } else {
      wireStoreAddNameIdLinkage($("storeAddName"), $("storeAddId"));
    }
  }

  async function submitAddSingleModal() {
    const id = $("storeAddId").value.trim();
    const displayName = $("storeAddName").value.trim();
    const baseURLs = $("storeAddUrls").value.trim();
    const apiKey = $("storeAddKey").value;
    const modelIdsText = $("storeAddModels").value.trim();
    const modelIds = modelIdsText ? modelIdsText.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : undefined;
    try {
      const r = await api("POST", "/api/store/add", { id, displayName, baseURLs, apiKey, modelIds });
      toast(`渠道 ${r.id} 已添加（${r.modelCount} 个模型）`);
      storeSelection = new Set([r.id]);
      storeFilterChecked = null;
      await refreshStoreState();
      storeFocusId = r.id;
      renderStoreList();
      renderStoreDetail();
    } catch (e) {
      // 校验/发现失败：保留已填内容重开弹窗并展示错误（密钥不回填；id 联动态随回填恢复）
      showAddModal({ id, displayName, baseURLs, modelIdsText, idTouched: $("storeAddId")?.dataset.touched === "1" });
      const err = $("storeAddError");
      err.hidden = false;
      err.textContent = /provide modelIds/.test(e.code || "")
        ? "在线发现没拿到模型列表，请在「模型 IDs」里手填后重试"
        : panelError(e, "渠道添加失败");
      if (e.code === "cas-conflict") await refreshStoreState();
    }
  }

  // 回滚子句：删除失败的渠道带着密钥残留，「已回滚 N 个」说满了就是在撒谎——
  // 只有全删干净才报全数回滚，有残留就如实列出渠道 id 指引手动清理。
  function poolRollbackClause(createdCount, failedRollbacks) {
    if (!failedRollbacks.length) return `已回滚 ${createdCount} 个已建渠道`;
    return `已回滚 ${createdCount - failedRollbacks.length} 个已建渠道，${failedRollbacks.length} 个删除失败：${failedRollbacks.join("、")}，请到渠道列表手动删除`;
  }
  // 建池模式提交：串行创建 N 个渠道，任一失败回滚已建渠道（删除事务会清凭据），
  // 全部成功才调 pool/create；pool/create 失败同样回滚。错误指明第几份资料。
  async function submitAddPoolModal() {
    const values = collectAddModalValues();
    const displayName = values.poolName.trim();
    const poolId = (values.poolId.trim() || poolSlugify(displayName)).trim();
    // 校验/中途失败：保留已填内容重开弹窗展示错误（重开顶掉自动关闭；密钥不回填）
    const fail = (msg) => {
      showAddModal(values);
      const err2 = $("storeAddError");
      err2.hidden = false;
      err2.textContent = msg;
    };
    if (!displayName) return fail("请填写号池名");
    if (!poolId) return fail("号池 ID 为空且无法由号池名生成，请手填");
    const setInputs = [...$("skillsModalBody").querySelectorAll(".store-add-set")];
    const sets = setInputs.map((setEl, k) => ({
      k: k + 1,
      id: setEl.querySelector(".set-id").value.trim(),
      displayName: setEl.querySelector(".set-name").value.trim(),
      baseURLs: setEl.querySelector(".set-urls").value.trim(),
      apiKey: setEl.querySelector(".set-key").value,
      modelIdsText: setEl.querySelector(".set-models").value.trim(),
    }));
    for (const s of sets) {
      if (!s.id) return fail(`资料 ${s.k}：请填写渠道 ID`);
      if (!s.baseURLs && s.k === 1) return fail("第 1 份资料：请填写 Base URL");
      if (!s.apiKey) return fail(`资料 ${s.k}：请填写 API 密钥`);
    }
    const created = [];
    const rollback = async () => {
      const failedRollbacks = [];
      for (const createdId of created) {
        try {
          await api("POST", "/api/store/delete", { id: createdId });
        } catch { failedRollbacks.push(createdId); }
      }
      return failedRollbacks;
    };
    for (const s of sets) {
      const baseURLs = s.baseURLs || sets[0].baseURLs;
      const modelIds = s.modelIdsText ? s.modelIdsText.split(/\r?\n/).map((x) => x.trim()).filter(Boolean) : undefined;
      try {
        const r = await api("POST", "/api/store/add", {
          id: s.id,
          displayName: s.displayName,
          baseURLs,
          apiKey: s.apiKey,
          modelIds,
        });
        created.push(r.id);
      } catch (e) {
        const failedRollbacks = await rollback();
        fail(`第 ${s.k} 份资料：${/provide modelIds/.test(e.code || "") ? "在线发现没拿到模型列表，请在「模型 IDs」里手填后重试" : panelError(e, "渠道创建失败")}（${poolRollbackClause(created.length, failedRollbacks)}）`);
        await refreshStoreState();
        return;
      }
    }
    try {
      await api("POST", "/api/store/pool/create", { poolId, displayName, members: created });
    } catch (e) {
      const failedRollbacks = await rollback();
      fail(`${panelError(e, "号池创建失败")}（${poolRollbackClause(created.length, failedRollbacks)}）`);
      await refreshStoreState();
      return;
    }
    toast(`号池 ${displayName} 已组建（${created.length} 个渠道）`);
    storeSelection = new Set([poolId]);
    storeFilterChecked = null;
    storeFilterDirty = false;
    await refreshStoreState();
    storeFocusId = poolId;
    renderStoreList();
    renderStoreDetail();
  }
  // ── 「导入本地配置」弹窗（渠道总览按钮行入口）─────────────────────────────
  // 扫各端点本地手配渠道 → 弹窗勾选 → 入库并随同步分发全端点。票据制：scan 发
  // 15 分钟内存票据 + 分组候选（密钥明文只留在票据里，绝不进 DOM），apply 按勾选
  // keys 落库；业务失败一律 200 + ok:false，由 api() 统一抛出。回执落渠道总览
  // 状态小字 + toast，生命周期与刷新小字同款：结论 10s 淡出；人不在渠道 tab 则
  // 置「等切回」暂停计时，切回看过再计一个完整周期。
  let byokImportTicket = null;  // scan 给的票据（内存态）
  let byokImportEntries = [];   // 摊平的候选行；勾选框只带下标，key 不序列化进 DOM

  // 回执拼装：导入计数打底，部分失败/本地移除失败追加；纯函数便于摘出单测
  function byokImportReceiptText(result, deleteLocal) {
    const parts = [
      deleteLocal
        ? `已导入 ${result.imported} 条渠道，本地原始配置已移除（原文件已备份）`
        : `已导入 ${result.imported} 条渠道，本地配置原样保留`,
    ];
    const failedCount = (result.failed || []).length;
    if (failedCount) parts.push(`${failedCount} 条失败（详情见面板日志）`);
    const removeFailedCount = (result.removeFailed || []).length;
    if (removeFailedCount) parts.push(`${removeFailedCount} 处本地配置移除失败（详情见面板日志）`);
    return parts.join("，");
  }

  // 每条渠道一行：勾选框 + 「渠道名 · 上游地址 · N 个模型」；status 决定是否可选
  // 及其右侧标注（duplicate 置灰徽标，密钥类不可选给原因）
  function byokImportRowHtml(entry, idx) {
    const selectable = entry.status === "ok";
    const main = `${escapeHtml(entry.displayName || "")} · ${escapeHtml(entry.baseURL || "")} · ${Number(entry.modelCount) || 0} 个模型`;
    let side = "";
    if (entry.status === "duplicate") side = `<span class="badge badge-neutral">已在库</span>`;
    else if (entry.status === "unresolved-key") side = `<span class="byok-import-skip">密钥无法读取，跳过</span>`;
    else if (entry.status === "no-key") side = `<span class="byok-import-skip">未配置密钥，跳过</span>`;
    return `<label class="byok-import-row${selectable ? "" : " is-disabled"}">` +
      `<input type="checkbox" data-byok-idx="${idx}"${selectable ? " checked" : " disabled"}>` +
      `<span class="byok-import-row-main">${main}</span>${side}</label>`;
  }

  // 回执落点：渠道总览状态小字（结论 10s 淡出）+ toast；人不在渠道 tab 置
  // 「等切回」标记并暂停淡出计时，切回看过再复位（与刷新终态同一惯例）
  function landByokImportReceipt(text, isErr) {
    setStoreRefreshStatus(text, isErr ? "err" : "done");
    if (currentView !== "store") {
      storeStatusAwaitReturn = true;
      disarmStoreStatusTimer();
    }
    toast(text, isErr);
  }

  function byokImportSelectedKeys() {
    const box = $("byokImportGroups");
    if (!box) return [];
    return [...box.querySelectorAll('input[type="checkbox"][data-byok-idx]:checked')]
      .map((cb) => (byokImportEntries[Number(cb.dataset.byokIdx)] || {}).key)
      .filter(Boolean);
  }

  function updateByokImportConfirm() {
    const btn = $("skillsModalConfirmBtn");
    if (!btn) return;
    const n = byokImportSelectedKeys().length;
    btn.textContent = `导入所选（${n}）`;
    btn.disabled = n === 0;
  }

  function renderByokImportGroups(result) {
    const box = $("byokImportGroups");
    if (!box) return;
    byokImportTicket = result.ticket || null;
    byokImportEntries = [];
    const groups = Array.isArray(result.groups) ? result.groups : [];
    if (!groups.length) {
      box.innerHTML = `<div class="byok-import-empty">未检出可导入的本地渠道配置</div>`;
      updateByokImportConfirm();
      return;
    }
    box.innerHTML = groups.map((g) => {
      const rows = (g.entries || []).map((entry) => {
        const idx = byokImportEntries.length;
        byokImportEntries.push(entry);
        return byokImportRowHtml(entry, idx);
      }).join("");
      return `<div class="byok-import-group">` +
        `<div class="byok-import-group-title">${escapeHtml(statsEndpointLabel(g.agentId))}</div>${rows}</div>`;
    }).join("");
    box.querySelectorAll('input[type="checkbox"][data-byok-idx]').forEach((cb) => {
      cb.onchange = updateByokImportConfirm;
    });
    updateByokImportConfirm();
  }

  async function runByokImportScan() {
    const gen = skillsModalGen;
    try {
      const r = await api("POST", "/api/byok-import/scan", {});
      if (gen !== skillsModalGen) return; // 弹窗已换主/已重开，旧扫描结果作废
      renderByokImportGroups(r);
    } catch (e) {
      if (gen !== skillsModalGen) return;
      const box = $("byokImportGroups");
      if (box) box.innerHTML = `<div class="store-form-error">${escapeHtml(panelError(e, "导入未完成"))}</div>`;
    }
  }

  function openByokImportModal() {
    byokImportTicket = null;
    byokImportEntries = [];
    showSkillsModal({
      title: "从本地配置导入",
      wide: true,
      confirmText: "导入所选（0）",
      bodyHtml: `
        <div class="byok-import-lead">以下是各端点本地配置中检出、尚未入库的渠道。勾选后导入中央库，并随同步分发到所有端点。</div>
        <div class="byok-import-groups" id="byokImportGroups"><div class="byok-import-empty">加载中…</div></div>
        <label class="byok-import-delete"><input type="checkbox" id="byokImportDeleteLocal" checked>导入后移除端点本地的原始配置</label>
        <div class="byok-import-note">移除前自动备份原文件；取消勾选则仅入库，本地原样保留。</div>
        <div class="byok-import-footnote">Claude Code 没有可读取的本地渠道配置，不在其列</div>`,
      onConfirm: applyByokImportSelection,
    });
    $("skillsModalConfirmBtn").disabled = true; // 扫描回话且确有勾选前不给确认
    runByokImportScan();
  }

  async function applyByokImportSelection() {
    const keys = byokImportSelectedKeys();
    if (!keys.length || !byokImportTicket) return;
    const deleteLocal = !!$("byokImportDeleteLocal")?.checked;
    try {
      const r = await api("POST", "/api/byok-import/apply", { ticket: byokImportTicket, keys, deleteLocal });
      byokImportTicket = null;
      // 被折叠的服务端原文一律并送面板日志（与 panelError 同一通道）
      for (const f of r.failed || []) reportMaskedPanelError("导入本地配置：条目入库失败", `${f.key}：${f.error}`);
      for (const f of r.removeFailed || []) reportMaskedPanelError("导入本地配置：本地原始配置移除失败", `${f.key}：${f.error}`);
      const hasFailure = (r.failed || []).length > 0 || (r.removeFailed || []).length > 0;
      landByokImportReceipt(byokImportReceiptText(r, deleteLocal), hasFailure);
      await refreshStoreState();
    } catch (e) {
      if (e.code === "ticket-expired") {
        // 票据 15 分钟有效，过期只能重新扫描，不做静默重试
        byokImportTicket = null;
        landByokImportReceipt("导入票据已过期，请重新扫描", true);
      } else {
        landByokImportReceipt(panelError(e, "导入未完成"), true);
      }
    }
  }

  // 重命名：只改显示名，渠道 id / 池 id 是 wire 身份不可改。预填不走 value
  // 属性（escapeHtml 不转义双引号，显示名含引号会破属性），渲染后由 JS 赋值。
  function showRenameProviderModal(p) {
    showSkillsModal({
      title: `重命名渠道 — ${p.displayName}`,
      confirmText: "重命名",
      bodyHtml: `
        <div class="store-form-row"><label class="store-form-label">显示名（id ${escapeHtml(p.id)} 不变，仅改面板展示名）</label>
          <input class="store-form-input" id="storeRenameInput"></div>`,
      onConfirm: async () => {
        const displayName = $("storeRenameInput").value.trim();
        if (!displayName) { toast("显示名不能为空", true); return; }
        await storeAction("/api/store/rename", { id: p.id, displayName }, `已重命名：${p.id} → ${displayName}`);
      },
    });
    const input = $("storeRenameInput");
    input.value = p.displayName;
    input.focus();
    input.select();
  }

  function showRenamePoolModal(row) {
    showSkillsModal({
      title: `重命名号池 — ${row.displayName}`,
      confirmText: "重命名",
      bodyHtml: `
        <div class="store-form-row"><label class="store-form-label">显示名（池 id ${escapeHtml(row.id)} 不变，仅改面板展示名）</label>
          <input class="store-form-input" id="storeRenameInput"></div>`,
      onConfirm: async () => {
        const displayName = $("storeRenameInput").value.trim();
        if (!displayName) { toast("显示名不能为空", true); return; }
        await storeAction("/api/store/pool/rename", { poolId: row.id, displayName }, `已重命名号池：${row.id} → ${displayName}`);
      },
    });
    const input = $("storeRenameInput");
    input.value = row.displayName;
    input.focus();
    input.select();
  }

  // 「更改配置」（原「轮换密钥」）：换 API 密钥和/或 Base URL。
  // 备用 Base URL 用按钮增量添加入口（不再逗号分隔）：点「添加备用 Base URL」出现
  // 「备用 Base URL」标题 + 一个输入窗，再点则在标题下继续加输入窗；备用输入窗
  // 位于主 URL 栏与添加按钮之间，添加按钮置于弹窗最下方（细字重），数量上限
  // （含主最多 5 个）不占正文，放按钮悬浮 title，达上限禁用按钮，提交时二次防护。
  // 主 Base URL 留空 = 保留原值；主留空但填了备用时，主按原值兜底。
  // 后端契约不变（仍是逗号分隔串经 parseBaseURLs 解析）。
  const ROTATE_URL_MAX = 5;
  function showRotateModal(p) {
    const isBuiltin = p.id === "opencode";
    showSkillsModal({
      title: `更改配置 — ${p.displayName}`,
      confirmText: "应用",
      bodyHtml: `
        <div class="store-form-row"><label class="store-form-label">新 API 密钥（留空 = 不换密钥）</label>
          <input class="store-form-input" type="password" id="storeRotateKey" autocomplete="new-password"></div>
        <div class="store-form-row"><label class="store-form-label">Base URL（留空 = 保留原值：${escapeHtml(p.baseURL)}）</label>
          <input class="store-form-input" id="storeRotateUrls"${isBuiltin ? " disabled" : ""} placeholder="主 Base URL"></div>
        <div id="storeRotateFallbacks"></div>
        <div class="store-rotate-add-row">
          <button class="btn btn-mini store-rotate-add-btn" type="button" id="storeRotateAddFallback"${isBuiltin ? " disabled" : ""}
            title="添加一个备用 Base URL（与主地址合计最多 ${ROTATE_URL_MAX} 个）">添加备用 Base URL</button>
        </div>
        ${isBuiltin ? `<div class="store-form-error">内建 OpenCode 渠道的端点由 OpenCode 自己管理，Anyswitch 不修改</div>` : ""}`,
      onConfirm: async () => {
        const apiKey = $("storeRotateKey").value;
        const main = $("storeRotateUrls").value.trim();
        const backups = [...$("storeRotateFallbacks").querySelectorAll(".store-rotate-fallback-input")]
          .map((el) => el.value.trim()).filter(Boolean);
        const urls = backups.length ? [main || p.baseURL, ...backups] : (main ? [main] : []);
        if (urls.length > ROTATE_URL_MAX) {
          toast(`Base URL 与主地址合计最多 ${ROTATE_URL_MAX} 个`, true);
          return;
        }
        const baseURLs = urls.join(", ");
        await storeAction("/api/store/rotate",
          { id: p.id, ...(apiKey ? { apiKey } : {}), ...(baseURLs ? { baseURLs } : {}) },
          `已更新配置：${p.id}`);
      },
    });
    const addBtn = $("storeRotateAddFallback");
    const box = $("storeRotateFallbacks");
    if (addBtn && box && !isBuiltin) {
      addBtn.onclick = () => {
        // 首次点击才长出「备用 Base URL」标题，其后每次只在标题下追加输入窗
        if (!box.querySelector(".store-form-label")) {
          const labelEl = document.createElement("label");
          labelEl.className = "store-form-label";
          labelEl.textContent = "备用 Base URL";
          box.appendChild(labelEl);
        }
        const input = document.createElement("input");
        input.className = "store-form-input store-rotate-fallback-input";
        input.placeholder = "备用 Base URL";
        box.appendChild(input);
        // 防护：含主 ≤ ROTATE_URL_MAX（主 1 + 备用 ≤ 4），达上限禁用添加入口
        if (box.querySelectorAll(".store-rotate-fallback-input").length >= ROTATE_URL_MAX - 1) addBtn.disabled = true;
        input.focus();
      };
    }
  }

  function confirmDeleteProvider(p) {
    const routed = endpointsRoutingThroughNodes(p.id);
    showSkillsModal({
      title: `删除渠道 ${p.displayName}`,
      danger: true,
      confirmText: "确认删除",
      bodyHtml: `<div style="font-size:12.5px; line-height:1.7;">
        将从渠道管理删除渠道 <b>${escapeHtml(p.id)}</b>（${p.modelCount} 个有效模型），
        并删除它在主机上的加密凭据。<br>
        ${routed.length ? `以下端点的自动路由包含该渠道：${escapeHtml(routed.join("、"))}。删除后会从这些自动路由中移除对应节点。<br>` : ""}
        凭据删除是唯一不可恢复的步骤；渠道删除失败时凭据会原样保留。</div>`,
      onConfirm: async () => {
        await storeAction("/api/store/delete", { id: p.id },
          (r) => `已删除 ${p.id}（${r.modelCount} 个模型）${routeChainPrunedNote(r.prunedChains)}`);
        storeSelection.delete(p.id);
        if (storeFocusId === p.id) storeFocusId = storeLastSelectionId();
        storeFilterChecked = null;
        storeFilterDirty = false;
        storeFilterProviderId = null;
      },
    });
  }

  // 池成员删除：与 confirmDeleteProvider 同一删除事务，多一段摘池/解池后果说明；
  // 池还在则保留池焦点（成员 tab 渲染时自动回退到首个成员），池被一并解除才回退焦点
  function confirmDeletePoolMember(p) {
    const pool = storePools().find((pl) => pl.id === p.poolId);
    const poolName = pool?.displayName || p.poolId;
    const dissolving = (pool?.members?.length ?? 2) <= 2;
    const routed = endpointsRoutingThroughNodes(dissolving ? [p.id, p.poolId] : [p.id]);
    showSkillsModal({
      title: `删除渠道 ${p.displayName}`,
      danger: true,
      confirmText: "确认删除",
      bodyHtml: `<div style="font-size:12.5px; line-height:1.7;">
        将从渠道管理删除渠道 <b>${escapeHtml(p.id)}</b>（${p.modelCount} 个有效模型），
        并删除它在主机上的加密凭据。<br>
        该渠道属于号池 <b>${escapeHtml(poolName)}</b>，删除后会自动移出号池${dissolving ? "；号池只剩 1 个成员，将一并解除" : ""}。<br>
        ${routed.length ? `以下端点的自动路由包含${dissolving ? "该渠道与所在号池" : "该渠道"}：${escapeHtml(routed.join("、"))}。删除后会从这些自动路由中移除对应节点。<br>` : ""}
        凭据删除是唯一不可恢复的步骤；渠道删除失败时凭据会原样保留。</div>`,
      onConfirm: async () => {
        await storeAction("/api/store/delete", { id: p.id },
          (r) => `已删除 ${p.id}（${r.modelCount} 个模型）${routeChainPrunedNote(r.prunedChains)}`);
        storeSelection.delete(p.id);
        const poolGone = !storePools().some((pl) => pl.id === p.poolId);
        if (poolGone) {
          storeSelection.delete(p.poolId);
          if (storeFocusId === p.poolId) storeFocusId = storeLastSelectionId();
        }
        storeFilterChecked = null;
        storeFilterDirty = false;
        storeFilterProviderId = null;
      },
    });
  }

  // ── 焦点切换（含脏过滤确认）：详情渠道将变化且有未保存勾选改动时先确认 ──
  let storePendingFocus = null;
  function applyStoreFocus(focusId, poolTab) {
    storeFocusId = focusId;
    if (poolTab !== undefined) storePoolTab = poolTab;
    const pid = storeDetailProviderIdFor(focusId, storePoolTab);
    if (pid !== storeFilterProviderId) {
      storeFilterChecked = null;
      storeFilterDirty = false;
      storeFilterProviderId = pid;
    }
    renderStoreList();
    renderStoreDetail();
  }
  function requestStoreFocus(focusId, poolTab) {
    const pid = storeDetailProviderIdFor(focusId, poolTab === undefined ? storePoolTab : poolTab);
    if (storeFilterDirty && pid !== storeFilterProviderId) {
      storePendingFocus = { focusId, poolTab };
      showSkillsModal({
        title: "放弃未保存的过滤改动？",
        confirmText: "放弃并切换",
        bodyHtml: `<div style="font-size:12.5px;">当前渠道的模型勾选有未保存改动，切换将丢弃这些改动。</div>`,
        onConfirm: async () => {
          const pending = storePendingFocus;
          storePendingFocus = null;
          if (pending) applyStoreFocus(pending.focusId, pending.poolTab);
        },
      });
      return;
    }
    applyStoreFocus(focusId, poolTab);
  }


  // 解除号池：仅删 pools 条目，成员渠道与凭据原样保留
  function confirmDissolvePool(row) {
    const routed = endpointsRoutingThroughNodes(row.id);
    showSkillsModal({
      title: `解除号池 ${row.displayName}`,
      confirmText: "解除号池",
      bodyHtml: `<div style="font-size:12.5px; line-height:1.7;">
        号池 <b>${escapeHtml(row.id)}</b> 解除后，成员渠道 ${row.members.map((m) => `<b>${escapeHtml(m.id)}</b>`).join("、")}
        退回各自独立渠道状态；渠道、模型与凭据均保留。<br>
        ${routed.length ? `以下端点的自动路由包含该号池：${escapeHtml(routed.join("、"))}。解除后会从这些自动路由中移除该号池节点。` : ""}</div>`,
      onConfirm: async () => {
        await storeAction("/api/store/pool/delete", { poolId: row.id },
          (r) => `已解除号池：${row.displayName}${routeChainPrunedNote(r.prunedChains)}`);
      },
    });
  }

  // 删除号池（两步语义）：先解除号池，再逐个删除成员渠道及凭据
  function confirmDeletePool(row) {
    const routed = endpointsRoutingThroughNodes([row.id, ...row.members.map((m) => m.id)]);
    showSkillsModal({
      title: `删除号池 ${row.displayName}`,
      danger: true,
      confirmText: "确认删除",
      bodyHtml: `<div style="font-size:12.5px; line-height:1.7;">
        将<b>先解除号池</b> ${escapeHtml(row.id)}，再逐个删除 ${row.members.length} 个成员渠道及其凭据文件：<br>
        ${row.members.map((m) => `· ${escapeHtml(m.id)}（${m.modelCount} 个有效模型）`).join("<br>")}<br>
        ${routed.length ? `以下端点的自动路由包含其中的渠道或号池：${escapeHtml(routed.join("、"))}。删除后会从这些自动路由中移除对应节点。<br>` : ""}
        凭据删除是唯一不可恢复的步骤。</div>`,
      onConfirm: async () => {
        await deletePoolAndMembers(row);
      },
    });
  }
  async function deletePoolAndMembers(row) {
    const failed = [];
    const pruned = [];
    const collectPruned = (r) => { if (Array.isArray(r?.prunedChains)) pruned.push(...r.prunedChains); };
    try {
      collectPruned(await api("POST", "/api/store/pool/delete", { poolId: row.id }));
    } catch (e) {
      failed.push(`号池 ${row.id} 解除失败：${panelError(e, "操作未完成")}`);
    }
    let deleted = 0;
    for (const m of row.members) {
      try {
        collectPruned(await api("POST", "/api/store/delete", { id: m.id }));
        deleted++;
      } catch (e) {
        failed.push(`${m.id}：${panelError(e, "删除未完成")}`);
      }
    }
    const note = routeChainPrunedNote(dedupePrunedChains(pruned));
    if (failed.length) toast(`部分删除失败（已删 ${deleted}/${row.members.length}）：${failed.join("；")}`, true);
    else toast(`已删除号池 ${row.displayName} 及 ${deleted} 个成员渠道${note}`);
    storeSelection.clear();
    storeFocusId = null;
    storeFilterChecked = null;
    storeFilterDirty = false;
    storeFilterProviderId = null;
    await refreshStoreState();
  }

  // 多选删除：池行同样走「先解池再删成员」两步；普通渠道行直接删
  function confirmDeleteStoreSelection() {
    const rows = [...storeSelection].map((id) => storeRows().find((r) => r.id === id)).filter(Boolean);
    const poolRows = rows.filter((r) => r.kind === "pool");
    const providerIds = storeSelectionProviders();
    const routed = endpointsRoutingThroughNodes([...new Set(rows.flatMap((r) => r.kind === "pool" ? [r.id, ...r.members.map((m) => m.id)] : [r.id]))]);
    const lines = rows.map((r) => r.kind === "pool"
      ? `· 号池 ${escapeHtml(r.displayName)}（${r.members.length} 个成员渠道将一并删除）`
      : `· 渠道 ${escapeHtml(r.id)}`);
    showSkillsModal({
      title: `删除选中项（${rows.length} 项）`,
      danger: true,
      confirmText: "确认删除",
      bodyHtml: `<div style="font-size:12.5px; line-height:1.7;">
        ${lines.join("<br>")}<br>
        ${poolRows.length ? "号池将先解除再逐个删除成员渠道；" : ""}共删除 ${providerIds.length} 个渠道及其凭据文件，
        ${routed.length ? `<br>以下端点的自动路由包含其中的渠道或号池：${escapeHtml(routed.join("、"))}。删除后会从这些自动路由中移除对应节点。` : ""}
        凭据删除是唯一不可恢复的步骤。</div>`,
      onConfirm: async () => {
        const failed = [];
        const pruned = [];
        const collectPruned = (r) => { if (Array.isArray(r?.prunedChains)) pruned.push(...r.prunedChains); };
        for (const row of poolRows) {
          try {
            collectPruned(await api("POST", "/api/store/pool/delete", { poolId: row.id }));
          } catch (e) {
            failed.push(`号池 ${row.id} 解除失败：${panelError(e, "操作未完成")}`);
          }
        }
        let deleted = 0;
        for (const id of providerIds) {
          try {
            collectPruned(await api("POST", "/api/store/delete", { id }));
            deleted++;
          } catch (e) {
            failed.push(`${id}：${panelError(e, "操作未完成")}`);
          }
        }
        const note = routeChainPrunedNote(dedupePrunedChains(pruned));
        if (failed.length) toast(`部分删除失败（已删 ${deleted}/${providerIds.length}）：${failed.join("；")}`, true);
        else toast(`已删除 ${deleted} 个渠道${poolRows.length ? `（含 ${poolRows.length} 个号池）` : ""}${note}`);
        storeSelection.clear();
        storeFocusId = null;
        storeFilterChecked = null;
        storeFilterDirty = false;
        storeFilterProviderId = null;
        await refreshStoreState();
      },
    });
  }

  // ── 号池弹窗（模型行×渠道列矩阵；重复模型行打「号池」tag 前置） ──
  // 三模式：create=组建新池 / add=加入已存在池（目标池下拉 + diff 高亮）/ reorder=池内调序
  let poolBuildMembers = [];     // 弹窗内成员顺序（= 点选顺序，可上下移调序）
  let poolBuildName = "";
  let poolBuildId = "";
  let poolBuildIdTouched = false;
  let poolBuildBusy = false;
  let poolBuildMode = "create";
  let poolBuildTargetPoolId = null; // add/reorder 的目标池 id
  let poolBuildNewMembers = [];     // add：本次新加入的渠道 id（切换目标池时保留）
  let poolBuildExisting = [];       // add/reorder：目标池现有成员 id（容量校验与 diff 高亮用）

  function poolSlugify(name) {
    return (name || "").toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^[^a-z0-9]+/, "")
      .replace(/-+$/, "");
  }

  function poolBuildConfirmLabel() {
    return poolBuildMode === "add" ? "加入号池" : poolBuildMode === "reorder" ? "保存顺序" : "组建号池";
  }

  function openPoolBuildModal() {
    const memberIds = storeSelectionProviders();
    if (memberIds.length < 2) {
      toast("组建号池至少需要 2 个渠道", true);
      return;
    }
    if (memberIds.length > 5) {
      toast(`一个号池最多联立 5 个渠道；当前选中展开为 ${memberIds.length} 个`, true);
      return;
    }
    const pooled = memberIds.filter((id) => (storeProviders().find((p) => p.id === id) || {}).poolId);
    if (pooled.length) {
      toast(`渠道已属于其他号池：${pooled.join("、")}（请先解除对应号池）`, true);
      return;
    }
    poolBuildMode = "create";
    poolBuildTargetPoolId = null;
    poolBuildNewMembers = [];
    poolBuildExisting = [];
    poolBuildMembers = memberIds.slice();
    poolBuildName = "";
    poolBuildId = "";
    poolBuildIdTouched = false;
    renderPoolBuildBody();
    $("poolBuildModal").classList.add("show");
  }

  // 加入已存在号池：候选 = 当前选中展开的渠道（已入池的拒绝）；目标池经顶部下拉选择
  function openPoolAddToPoolModal() {
    const memberIds = storeSelectionProviders();
    if (!memberIds.length) {
      toast("请先选中要加入号池的渠道", true);
      return;
    }
    const pooled = memberIds.filter((id) => (storeProviders().find((p) => p.id === id) || {}).poolId);
    if (pooled.length) {
      toast(`渠道已属于其他号池：${pooled.join("、")}（请先解除对应号池）`, true);
      return;
    }
    const pools = storePools();
    if (!pools.length) {
      toast("暂无号池，请先组建号池", true);
      return;
    }
    // 只有一个池且未满时预选；否则留空由用户在下拉里选择
    const only = pools.length === 1 && (pools[0].members || []).length < 5 ? pools[0] : null;
    poolBuildMode = "add";
    poolBuildTargetPoolId = only ? only.id : null;
    poolBuildNewMembers = memberIds.slice();
    poolBuildExisting = only ? (only.members || []).slice() : [];
    poolBuildMembers = poolBuildExisting.concat(poolBuildNewMembers);
    poolBuildName = "";
    poolBuildId = "";
    poolBuildIdTouched = false;
    renderPoolBuildBody();
    $("poolBuildModal").classList.add("show");
  }

  // 池内调序：仅现有成员，全列可 ◀▶（入口 = 池详情成员 tab 右侧「调整顺序」）
  function openPoolReorderModal(row) {
    poolBuildMode = "reorder";
    poolBuildTargetPoolId = row.id;
    poolBuildNewMembers = [];
    poolBuildExisting = (row.members || []).map((m) => m.id);
    poolBuildMembers = poolBuildExisting.slice();
    poolBuildName = "";
    poolBuildId = "";
    poolBuildIdTouched = false;
    renderPoolBuildBody();
    $("poolBuildModal").classList.add("show");
  }

  // add 模式容量守卫：目标池现有 + 新加入 > 5 → 报错并禁确认（切换目标池时重验）
  function poolBuildCapacityError() {
    if (poolBuildMode !== "add") return null;
    if (!poolBuildTargetPoolId) return "请选择目标号池";
    const target = storePools().find((pl) => pl.id === poolBuildTargetPoolId);
    if (!target) return "目标号池已不存在，请关闭弹窗后重试";
    const total = poolBuildExisting.length + poolBuildNewMembers.length;
    if (total > 5) return `一个号池最多联立 5 个渠道；目标池现有 ${poolBuildExisting.length} 个，新加入 ${poolBuildNewMembers.length} 个，合计 ${total} 个`;
    return null;
  }

  function hidePoolBuildModal() {
    if (poolBuildBusy) return;
    $("poolBuildModal").classList.remove("show");
  }

  function renderPoolBuildBody() {
    const isCreate = poolBuildMode === "create";
    const isAdd = poolBuildMode === "add";
    const pools = storePools();
    const targetPool = poolBuildTargetPoolId ? pools.find((pl) => pl.id === poolBuildTargetPoolId) : null;
    const targetName = targetPool ? (targetPool.displayName || targetPool.id) : "";
    $("poolBuildTitle").textContent = isCreate
      ? "组建号池"
      : isAdd
        ? `加入号池${targetName ? ` — ${targetName}` : ""}`
        : `调整顺序 — ${targetName || poolBuildTargetPoolId}`;
    $("poolBuildConfirmBtn").textContent = poolBuildConfirmLabel();
    const members = poolBuildMembers
      .map((id) => storeProviders().find((p) => p.id === id))
      .filter(Boolean);
    // 模型行 = 成员 discovered 并集；≥2 成员拥有（含补录）为重复行，前置并打 tag
    const counts = new Map();
    const countsNew = new Map(); // add 模式：仅统计新加入成员持有数，用于 diff 高亮
    const newSet = new Set(isAdd ? poolBuildNewMembers : []);
    for (const m of members) {
      for (const mid of Object.keys(m.discovered || {})) {
        counts.set(mid, (counts.get(mid) || 0) + 1);
        if (newSet.has(m.id)) countsNew.set(mid, (countsNew.get(mid) || 0) + 1);
      }
    }
    const mids = [...counts.keys()].sort((a, b) => {
      const dupDiff = (counts.get(b) >= 2 ? 1 : 0) - (counts.get(a) >= 2 ? 1 : 0);
      return dupDiff || a.localeCompare(b);
    });
    const headCells = members.map((m, i) => `
      <th>
        <button class="pool-move" data-move="${i}:-1" title="前移"${i === 0 ? " disabled" : ""}>◀</button>
        ${escapeHtml(m.displayName)}${newSet.has(m.id) ? ` <span class="badge badge-accent">新</span>` : ""}
        <button class="pool-move" data-move="${i}:1" title="后移"${i === members.length - 1 ? " disabled" : ""}>▶</button>
        <div style="font-weight:400; color:var(--text-3); font-size:11px;">${escapeHtml(m.id)}</div>
      </th>`).join("");
    const rowsHtml = mids.length ? mids.map((mid) => {
      const dup = counts.get(mid) >= 2;
      // diff 高亮：该行仅由新加入成员带入（现有成员均无此模型）
      const isNew = isAdd && (countsNew.get(mid) || 0) > 0 && counts.get(mid) === countsNew.get(mid);
      const cls = [dup && "pool-dup", isNew && "pool-new"].filter(Boolean).join(" ");
      const cells = members.map((m) => {
        const meta = (m.discovered || {})[mid];
        if (!meta) return `<td class="pool-cell-empty">—</td>`;
        const bits = [];
        if (meta.manual === true) bits.push(`<span class="badge badge-accent">补录</span>`);
        if (meta.contextWindow) bits.push(`<span class="badge badge-neutral">${formatCtx(meta.contextWindow)}</span>`);
        return `<td>${bits.join("") || "✓"}</td>`;
      }).join("");
      return `<tr${cls ? ` class="${cls}"` : ""}>
        <td class="pool-mid">${escapeHtml(mid)}${dup ? ` <span class="badge badge-pool">号池</span>` : ""}${isNew ? ` <span class="badge badge-accent">新增</span>` : ""}</td>${cells}</tr>`;
    }).join("") : `<tr><td colspan="${members.length + 1}" class="pool-cell-empty">成员渠道均无模型缓存，可先各自「刷新模型」再组建。</td></tr>`;
    // 名称/ID 输入区仅 create；目标池下拉仅 add（已满 5 个的池置灰不可选）
    const formHtml = isCreate ? `
      <div class="store-form-row"><label class="store-form-label">号池名（展示用，与渠道名独立）</label>
        <input class="store-form-input" id="poolBuildName" value="${escapeHtml(poolBuildName)}" placeholder="如 主力号池"></div>
      <div class="store-form-row"><label class="store-form-label">号池 ID（字母数字 . _ -，不可含 /；留空自动由号池名生成）</label>
        <input class="store-form-input" id="poolBuildId" value="${escapeHtml(poolBuildId)}" placeholder="如 main-pool"></div>` : "";
    const targetHtml = isAdd ? `
      <div class="store-form-row"><label class="store-form-label">目标号池（已满 5 个的不可选）</label>
        <select class="store-form-input" id="poolBuildTarget">
          ${poolBuildTargetPoolId ? "" : `<option value="" selected disabled>请选择目标号池</option>`}
          ${pools.map((pl) => {
            const n = (pl.members || []).length;
            const full = n >= 5;
            return `<option value="${escapeHtml(pl.id)}"${pl.id === poolBuildTargetPoolId ? " selected" : ""}${full ? " disabled" : ""}>${escapeHtml(pl.displayName || pl.id)} · ${n}/5${full ? "（已满）" : ""}</option>`;
          }).join("")}
        </select></div>` : "";
    const hint = isCreate
      ? `${members.length} 个成员渠道，顺序 = 未来调用顺序（◀ ▶ 调整）；标「号池」的行为 ≥2 个成员共有的模型。矩阵仅作对比展示，不影响各渠道自身的模型过滤。`
      : isAdd
        ? `现有 ${poolBuildExisting.length} 个成员 + 新加入 ${poolBuildNewMembers.length} 个（默认追加末尾），全部列可 ◀ ▶ 调序；标「新增」的行为仅由新成员带入的模型。矩阵仅作对比展示，不影响各渠道自身的模型过滤。`
        : `${members.length} 个成员渠道，◀ ▶ 调整顺序 = 未来调用顺序；标「号池」的行为 ≥2 个成员共有的模型。`;
    $("poolBuildBody").innerHTML = `
      ${formHtml}${targetHtml}
      <div style="font-size:11.5px; color:var(--text-3);">
        ${hint}</div>
      <div class="pool-matrix-wrap"><table class="pool-matrix">
        <thead><tr><th>模型</th>${headCells}</tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table></div>
      <div class="store-form-error" id="poolBuildError" hidden></div>
    `;
    const nameInput = isCreate ? $("poolBuildName") : null;
    const idInput = isCreate ? $("poolBuildId") : null;
    if (isCreate) {
      nameInput.oninput = () => {
        poolBuildName = nameInput.value;
        if (!poolBuildIdTouched) {
          poolBuildId = poolSlugify(poolBuildName);
          idInput.value = poolBuildId;
        }
      };
      idInput.oninput = () => {
        poolBuildId = idInput.value;
        poolBuildIdTouched = poolBuildId.trim().length > 0;
      };
    }
    if (isAdd) {
      // 切换目标池：现有成员列换成新目标成员（新成员保留、仍默认追加末尾），容量守卫随渲染重验
      $("poolBuildTarget").onchange = (e) => {
        poolBuildTargetPoolId = e.target.value;
        const target = storePools().find((pl) => pl.id === poolBuildTargetPoolId);
        poolBuildExisting = target ? (target.members || []).slice() : [];
        poolBuildMembers = poolBuildExisting.concat(poolBuildNewMembers);
        renderPoolBuildBody();
      };
    }
    // add 模式容量守卫即时反馈：报错 + 禁确认
    const capErr = poolBuildCapacityError();
    if (capErr) {
      const errEl = $("poolBuildError");
      errEl.hidden = false;
      errEl.textContent = capErr;
    }
    $("poolBuildConfirmBtn").disabled = !!capErr;
    $("poolBuildBody").querySelectorAll(".pool-move").forEach((btn) => {
      btn.onclick = () => {
        const [iStr, dStr] = btn.getAttribute("data-move").split(":");
        const i = Number(iStr);
        const j = i + Number(dStr);
        if (j < 0 || j >= poolBuildMembers.length) return;
        if (isCreate) {
          poolBuildName = nameInput.value;
          poolBuildId = idInput.value;
        }
        [poolBuildMembers[i], poolBuildMembers[j]] = [poolBuildMembers[j], poolBuildMembers[i]];
        renderPoolBuildBody();
      };
    });
  }

  async function confirmPoolBuild() {
    const err = $("poolBuildError");
    const fail = (msg) => {
      err.hidden = false;
      err.textContent = msg;
    };
    const btn = $("poolBuildConfirmBtn");
    const isCreate = poolBuildMode === "create";
    let poolId;
    let apiPath;
    let payload;
    let okMsg;
    if (isCreate) {
      const displayName = ($("poolBuildName").value || "").trim();
      poolId = (($("poolBuildId").value || "").trim() || poolSlugify(displayName)).trim();
      if (!displayName) return fail("请填写号池名");
      if (!poolId) return fail("号池 ID 为空且无法由号池名生成，请手填");
      apiPath = "/api/store/pool/create";
      payload = { poolId, displayName, members: poolBuildMembers };
      okMsg = `号池 ${displayName} 已组建（${poolBuildMembers.length} 个渠道）`;
    } else {
      // add / reorder：完整新成员列表（含顺序）整体替换目标池 members
      const capErr = poolBuildCapacityError();
      if (capErr) return fail(capErr);
      poolId = poolBuildTargetPoolId;
      apiPath = "/api/store/pool/members/update";
      payload = { poolId, members: poolBuildMembers };
      okMsg = poolBuildMode === "add" ? "已加入号池" : "已更新顺序";
    }
    poolBuildBusy = true;
    btn.disabled = true;
    btn.textContent = isCreate ? "组建中…" : poolBuildMode === "add" ? "加入中…" : "保存中…";
    try {
      const r = await api("POST", apiPath, payload);
      $("poolBuildModal").classList.remove("show");
      toast(okMsg + routeChainMigratedNote(r.migratedChains));
      storeSelection = new Set([poolId]);
      storeFilterChecked = null;
      storeFilterDirty = false;
      await refreshStoreState();
      storeFocusId = poolId;
      renderStoreList();
      renderStoreDetail();
    } catch (e) {
      if (e.code === "cas-conflict") {
        fail("渠道配置已被其他操作改动，请稍后重试");
        await refreshStoreState();
      } else {
        fail(panelError(e, "操作失败"));
      }
    } finally {
      poolBuildBusy = false;
      btn.disabled = !isCreate && !!poolBuildCapacityError();
      btn.textContent = poolBuildConfirmLabel();
    }
  }

  // ── 路由链（自动路由）：设置页「自动路由」子 tab 瓦片墙 + 链编辑器弹窗 ──
  // 数据 = getState 下发的 routingChains: [{endpointId, chain:[{node,model}...]}]；
  // node 为渠道或号池 id（池优先），model 为绑定上游模型。保存/删除走
  // /api/store/route-chain/save|delete，校验口径与 store-schema 对齐（1-8 节点、
  // node+model 组合不重复——同节点可绑定不同模型分别入链）。
  const ROUTE_CHAIN_ENDPOINTS = ["claude", "zcode", "opencode", "pi", "kimi", "dsh", "qoder", "codex", "grok"];
  const ROUTE_CHAIN_MAX_NODES = 8;
  const routeChainEndpointLabel = (id) => STATS_ENDPOINT_LABELS[id] || id;

  // 删除渠道 / 解散号池会顺势剪掉指向它们的路由链节点（服务端在同一笔写入里完成），
  // 删除结果带回 prunedChains: [{endpointId, remaining}] / [{virtualModel, remaining}]
  // （虚拟模型链同口径修剪）。删除成功提示据此附一句「已从自动路由移除对应节点」；
  // remaining = 0（整条链被剪空）时不带括号，只报端点名或虚拟模型名。
  function routeChainPrunedNote(prunedChains) {
    if (!Array.isArray(prunedChains) || !prunedChains.length) return "";
    const labels = prunedChains.map((item) => {
      const name = routeChainEndpointLabel(item.endpointId ?? item.virtualModel);
      return item.remaining > 0 ? `${name}（剩 ${item.remaining} 个节点）` : name;
    });
    return `；已从自动路由移除对应节点：${labels.join("、")}`;
  }

  // 入池迁移回报（组建/改组号池的结果带 migratedChains）：与剪除回报同一句式、
  // 同一命名口径（端点显示名 / 虚拟模型名），migrated = 该链改写到号池的节点数。
  // 文案已按 PANEL-COPY-SPEC 流程报批。
  function routeChainMigratedNote(migratedChains) {
    if (!Array.isArray(migratedChains) || !migratedChains.length) return "";
    const labels = migratedChains.map((item) =>
      `${routeChainEndpointLabel(item.endpointId ?? item.virtualModel)}（${item.migrated} 处）`);
    return `；已把自动路由中指向成员渠道的节点改为该号池：${labels.join("、")}`;
  }

  // 哪些端点的自动路由链引用了给定节点（渠道/号池 id）。删除前预告与删除确认
  // 共用：只列真正会被剪到的端点，未被引用的不出现。
  function endpointsRoutingThroughNodes(nodeIds) {
    const set = new Set(Array.isArray(nodeIds) ? nodeIds : [nodeIds]);
    return storeRoutingChains()
      .filter((c) => Array.isArray(c.chain) && c.chain.some((it) => set.has(it.node)))
      .map((c) => routeChainEndpointLabel(c.endpointId));
  }

  // 批量删除会把多次删除结果的 prunedChains 汇总；同一端点（或同一虚拟模型）
  // 可能被剪多次（成员逐个删），取各次里剩余最少的一条作为最终跳数。
  function dedupePrunedChains(items) {
    const byKey = new Map();
    for (const item of items || []) {
      if (!item) continue;
      const key = item.endpointId ?? item.virtualModel;
      const prev = byKey.get(key);
      if (prev === undefined || item.remaining < prev.remaining) byKey.set(key, item);
    }
    return [...byKey.values()];
  }

  // 编辑器目标：{kind:"endpoint", id} = 端点自动路由链；{kind:"virtual", id} = 虚拟模型。
  // 两种目标共用同一弹窗与同一份草稿，差别只在标题/入口桩标签/保存去向。
  let routeChainTarget = null;
  let routeChainDraft = [];          // 编辑中的链 [{node, model}]
  let routeChainCandModels = {};     // 候选区模型下拉选择（nodeId -> modelId），重渲染后保留
  let routeChainBusy = false;
  let virtualModelCreating = false;  // 编辑器处于「新建虚拟模型」流（目标 kind:"virtual" 且 id 未定）
  let virtualModelNameDraft = "";    // 名字草稿（新建流起始为空、编辑流起始为当前名）

  // 虚拟模型名取值口径：草稿是唯一来源——新建流由输入驱动，编辑流打开即填入当前名。
  // 桩标签、编辑器标题、链路标签、名字校验、保存去向五处共用这一个取值，
  // 避免再出现「编辑流读目标名、校验读草稿」这种两套口径对不上的情况。
  function virtualModelNameValue() {
    return virtualModelNameDraft.trim();
  }

  function storeRoutingChains() {
    return (storeState && storeState.routingChains) || [];
  }
  function storeRoutingChainFor(endpointId) {
    const entry = storeRoutingChains().find((c) => c.endpointId === endpointId);
    return entry && Array.isArray(entry.chain) ? entry.chain : null;
  }
  function storeVirtualModels() {
    return (storeState && storeState.virtualModels) || [];
  }
  function storeVirtualModelFor(name) {
    const entry = storeVirtualModels().find((v) => v.name === name);
    return entry && Array.isArray(entry.chain) ? entry.chain : null;
  }
  function routeNodeIsPool(nodeId) {
    if (storePools().some((pl) => pl.id === nodeId)) return true;
    // 看板侧无 storeState：退回链配置缓存携带的节点信息映射
    return !!(routeNodeInfoCache && routeNodeInfoCache.pools.has(nodeId));
  }
  function routeNodeName(nodeId) {
    const pool = storePools().find((pl) => pl.id === nodeId);
    if (pool) return pool.displayName || pool.id;
    const p = storeProviders().find((x) => x.id === nodeId);
    if (p) return p.displayName || p.id;
    if (routeNodeInfoCache) {
      if (routeNodeInfoCache.pools.has(nodeId)) return routeNodeInfoCache.pools.get(nodeId);
      if (routeNodeInfoCache.providers.has(nodeId)) return routeNodeInfoCache.providers.get(nodeId);
    }
    return nodeId;
  }
  // 节点可绑定的模型清单：渠道 = 其 models 键（空则退回 discovered 键）；
  // 号池 = 成员并集（同口径）。已保存但目录里消失的模型由调用方另行补入选项。
  function routeNodeModels(nodeId) {
    const keysOf = (p) => {
      const a = Object.keys((p && p.models) || {});
      return a.length ? a : Object.keys((p && p.discovered) || {});
    };
    const pool = storePools().find((pl) => pl.id === nodeId);
    if (pool) {
      const union = new Set();
      for (const mid of pool.members || []) {
        for (const k of keysOf(storeProviders().find((p) => p.id === mid))) union.add(k);
      }
      return [...union].sort();
    }
    const p = storeProviders().find((x) => x.id === nodeId);
    return p ? keysOf(p).sort() : [];
  }
  // 候选区行 = 可见行模型（storeRows：未入池渠道 + 号池合并行；被池吸收的成员不单列）
  function routeChainCandidates() {
    return storeRows().map((row) => row.kind === "pool"
      ? { id: row.id, name: row.displayName || row.id, isPool: true }
      : { id: row.id, name: row.p.displayName || row.id, isPool: false });
  }

  // ── 看板路由链状态（左栏「路由链」卡 + 胶囊 auto 标记共用口径） ──
  // 节点灯色判定：数据 = relay 进程内链状态（runtime API 的 lamps 字段，每次
  // 启动重新统计，与 model-stability 的持久 8h 口径刻意拆开）——green=可用 /
  // red=不可用（连续失败已降级退避）/ gray=本次启动尚无数据。不设基于 TTFT 的
  // 警示档：慢但能应答的节点仍算可用。runtime 缺失（relay 停机/旧码）
  // 时退化为同款默认：链首绿（它是下一跳）、其余灰。
  function routeRailLights(items, rt) {
    if (rt && Array.isArray(rt.lamps) && rt.lamps.length === items.length) return rt.lamps;
    return items.map((_, i) => (i === 0 ? "green" : "gray"));
  }

  // 当前服务跳定位：runtime 的 current.node+current.model 匹配链中第几跳；
  // 匹配不到（runtime 未覆盖该端点/链配置已改）默认首跳
  function routeRailCurrentIndex(chain, rt) {
    if (rt && rt.current) {
      const i = chain.findIndex((it) => it.node === rt.current.node && it.model === rt.current.model);
      if (i >= 0) return i;
    }
    return 0;
  }

  // 共享可变 st / 悬浮层重建入口，均按端点记忆（链行结构指纹命中时每秒改写
  // st，悬浮层闭包引用同一对象，重开即读到新鲜 remainMs/状态）
  const routeRailState = {};
  const routeRailShowPop = {};

  // ── 左栏「路由链」状态卡 ──
  // 每行 = 一条已启用链：端点名 + 缩略灯串（纯圆点，复用 lamp 色，无连接线/动画）
  // + 位次 N/M + 当前跳模型名；退避时行尾小倒计时（runtime since/retryIntervalMs，
  // 随 1s 轮询按秒刷新）。hover 行复用 .route-rail-pop 整链概览，点击行跳
  // 「渠道管理」开该链编辑器。数据复用 boardRoutingChains()/routeRuntimeCache
  // 现有 60s/15s 缓存，不新增请求。仅当存在已启用链时整卡显示，否则隐藏不占位。
  // 行态口径：runtime 缺失（relay 停机/旧码）退化为纯灯色串（位次落首跳、无倒计时）；
  // 退避 = 有退避起始点且当前跳不在链首。结构指纹刻意不含倒计时秒数（否则活跃
  // 退避时每秒重建 DOM、悬浮层随 hover 目标销毁而闪断）；命中时只刷倒计时文本、
  // 改写共享可变 st、刷新打开中的悬浮层。
  let routeSideFp = "";

  // 左栏「路由链」卡暂缓展示：false 时渲染入口直接返回，卡片
  // HTML 保持 hidden；下方行渲染/hover 浮层/点击跳转逻辑全部保留，置 true
  // 即一键恢复。
  const ROUTE_SIDE_CARD_ENABLED = false;

  function renderRouteChainBoard() {
    if (!ROUTE_SIDE_CARD_ENABLED) return;
    const card = $("routeRailCard");
    const list = $("routeRailList");
    if (!card || !list) return;
    const entries = boardRoutingChains().filter((e) =>
      e && Array.isArray(e.chain) && e.chain.length && e.enabled !== false);
    card.hidden = entries.length === 0;
    if (!entries.length) {
      routeSideFp = "";
      list.innerHTML = "";
      hideRouteRailPop();
      return;
    }
    const rows = entries.map((entry) => {
      const items = entry.chain;
      const rt = routeRuntimeCache ? routeRuntimeCache[entry.endpointId] : null;
      const live = !!(rt && rt.current);
      const lights = routeRailLights(items, rt);
      const allRed = lights.every((l) => l === "red"); // 全链炸：位次显示 ✕/M
      const cur = routeRailCurrentIndex(items, rt);
      const interval = (rt && rt.retryIntervalMs) || 300000;
      const backoff = live && rt.since != null && cur > 0;
      const remainMs = backoff ? Math.max(0, interval - (Date.now() - rt.since)) : 0;
      return { ep: entry.endpointId, items, lights, st: { cur, live, backoff, remainMs, allRed } };
    });
    const fp = rows.map((r) =>
      r.ep + ":" + r.items.map((it) => it.node + " " + it.model).join(">")
      + "|" + r.lights.join(",") + "|" + r.st.cur + "|" + r.st.live + "|" + r.st.backoff + "|" + r.st.allRed
    ).join(";");
    if (fp === routeSideFp && list.childElementCount === rows.length) {
      // 结构不变 → 只刷倒计时文本/共享 st/打开中的悬浮层，不重建 DOM
      rows.forEach((r, i) => {
        const rowEl = list.children[i];
        const cdEl = rowEl.querySelector(".rc-side-cd");
        if (cdEl) cdEl.textContent = r.st.backoff ? fmtMinSec(r.st.remainMs) : "";
        const st = routeRailState[r.ep];
        if (st) {
          st.cur = r.st.cur;
          st.live = r.st.live;
          st.backoff = r.st.backoff;
          st.remainMs = r.st.remainMs;
          st.allRed = r.st.allRed;
        }
        if (routeRailPop && routeRailPopEp === r.ep) {
          const show = routeRailShowPop[r.ep];
          if (show && rowEl.matches(":hover")) show(); else hideRouteRailPop();
        }
      });
      return;
    }
    routeSideFp = fp;
    list.innerHTML = "";
    rows.forEach((r) => {
      const rowEl = document.createElement("div");
      rowEl.className = "rc-side-row";
      const lamps = r.lights.map((l) => `<i class="lamp lamp-${l}"></i>`).join("");
      const curModel = (r.items[r.st.cur] && r.items[r.st.cur].model) || "";
      rowEl.innerHTML =
        `<span class="rc-side-ep">${escapeHtml(routeChainEndpointLabel(r.ep))}</span>`
        + `<span class="rc-side-lamps" aria-hidden="true">${lamps}</span>`
        + `<span class="rc-side-pos">${r.st.allRed ? `✕/${r.items.length}` : `${r.st.cur + 1}/${r.items.length}`}</span>`
        + `<span class="rc-side-model" title="${escapeHtml(curModel)}">${escapeHtml(curModel)}</span>`
        + `<span class="rc-side-cd">${r.st.backoff ? fmtMinSec(r.st.remainMs) : ""}</span>`;
      rowEl.addEventListener("click", () => openRouteChainFromBoard(r.ep));
      routeRailState[r.ep] = r.st; // 共享可变 st：结构指纹命中时每秒改写，悬浮层闭包引用同对象
      bindRouteRailPop(rowEl, r.ep, r.items, r.lights, r.st);
      list.appendChild(rowEl);
    });
  }

  // 左栏链行点击：跳「渠道管理」并打开该端点的链编辑器；storeState 未拉过时
  // 先等首刷（openRouteChainModal 要求 storeState.storeOk，否则 toast 拒绝）
  function openRouteChainFromBoard(ep) {
    hideRouteRailPop();
    switchView("store");
    refreshStoreState().then(() => openRouteChainModal(ep));
  }

  function fmtMinSec(ms) {
    const t = Math.max(0, Math.round(ms / 1000));
    return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
  }

  // 链行悬浮层（整链概览）：hover 左栏路由链卡的链行弹出，点击其他处 / Esc / 移出关闭。
  // 面板风格对齐 .skills-ctx-menu；全局关闭监听在弹出时挂载、关闭时摘除。
  let routeRailPop = null;
  let routeRailPopEp = null; // 悬浮层归属的端点（重建时只刷自己那份）

  function hideRouteRailPop() {
    if (routeRailPop) { routeRailPop.remove(); routeRailPop = null; routeRailPopEp = null; }
    document.removeEventListener("click", onRouteRailPopDoc, true);
    document.removeEventListener("keydown", onRouteRailPopKey, true);
  }
  function onRouteRailPopDoc(e) { if (routeRailPop && !routeRailPop.contains(e.target)) hideRouteRailPop(); }
  function onRouteRailPopKey(e) { if (e.key === "Escape") hideRouteRailPop(); }

  function bindRouteRailPop(rail, ep, items, lights, st) {
    if (!rail) return;
    const showPop = () => {
      hideRouteRailPop();
      const pop = document.createElement("div");
      pop.className = "route-rail-pop";
      const stateText = st.allRed ? "全链不可用" : (st.backoff ? "退避中" : "服务中");
      const rows = items.map((it, i) => {
        const isCur = !st.allRed && i === st.cur;
        const sym = `<i class="route-rail-dot lamp-${lights[i]}${isCur ? " is-current is-stale" : ""}"></i>`;
        // 行首已有灯色图形，文字只说状态语义，不复述灯色名称；
        // TTFT 亦随 stability 口径拆开，不在此展示。
        const statusText = isCur
          ? (st.backoff ? "冷却中" : "服务中")
          : lights[i] === "red" ? "不可用" : (lights[i] === "gray" ? "无数据" : "可用");
        return `<div class="route-rail-pop-row"><span class="route-rail-pop-sym">${sym}</span><span class="route-rail-pop-model" title="${escapeHtml(it.model || "")}">${escapeHtml(it.model || "")}</span><span class="route-rail-pop-provider">${escapeHtml(routeNodeName(it.node))}</span><span class="route-rail-pop-status">${statusText}</span></div>`;
      }).join("");
      pop.innerHTML = `<div class="route-rail-pop-title"><span>自动路由 · ${stateText}</span>${st.backoff ? `<span class="route-rail-pop-cd">${fmtMinSec(st.remainMs)}</span>` : ""}</div>${rows}`;
      document.body.appendChild(pop);
      const r = rail.getBoundingClientRect();
      pop.style.left = Math.min(r.left, window.innerWidth - pop.offsetWidth - 8) + "px";
      pop.style.top = Math.min(r.bottom + 6, window.innerHeight - pop.offsetHeight - 8) + "px";
      routeRailPop = pop;
      routeRailPopEp = ep;
      document.addEventListener("click", onRouteRailPopDoc, true);
      document.addEventListener("keydown", onRouteRailPopKey, true);
    };
    if (ep) routeRailShowPop[ep] = showPop; // R10：轻量分支重建打开中悬浮层的入口
    rail.addEventListener("mouseenter", showPop);
    rail.addEventListener("mouseleave", hideRouteRailPop);
    // 链行随 1s 轮询重建：悬浮层属于本端点且指针仍悬停时刷新内容，否则关掉
    if (routeRailPop && routeRailPopEp === ep) {
      if (rail.matches(":hover")) showPop(); else hideRouteRailPop();
    }
  }

  // ── 设置「自动路由」tab：Agent 瓦片墙（每个已安装的 Agent 一枚瓦片，三列网格）──
  // 未安装的 Agent 不出瓦片（其链配置在服务端原样保留，装回来即恢复显示与生效，
  // 与瓦片上「停用=链配置保留」同一哲学）；installedAgentIds 为 null（检测未知/
  // 失败）时全部照画（fail-open）。
  function renderRouteChains() {
    const grid = $("routeChainGrid");
    if (!grid) return;
    const byEp = new Map(storeRoutingChains().map((c) => [c.endpointId, c]));
    const visibleEndpoints = ROUTE_CHAIN_ENDPOINTS.filter(
      (ep) => installedAgentIds === null || installedAgentIds.has(ep),
    );
    let configured = 0;
    grid.innerHTML = visibleEndpoints.map((ep) => {
      const entry = byEp.get(ep);
      const chain = (entry && Array.isArray(entry.chain)) ? entry.chain : [];
      const label = routeChainEndpointLabel(ep);
      if (chain.length) {
        configured++;
        // per-endpoint 启用开关（getState 显式下发布尔，缺省=开）：开 = 暴露
        // auto 模型 + 监测页路由链卡显示；关 = 链配置保留但 auto 不暴露。
        const enabled = !entry || entry.enabled !== false;
        return `<div class="route-ep-tile" data-agent-id="${ep}">
          <div class="route-ep-tile-top"><div class="route-ep-id"><span class="route-ep-avatar" data-route-avatar="${ep}"></span><span class="route-ep-name">${escapeHtml(label)}</span></div><span class="badge ${enabled ? "badge-accent" : "badge-neutral"}">${enabled ? `${chain.length} 节点` : "已停用"}</span></div>
          <div class="route-ep-tile-actions">
            <label class="toggle" title="启用自动路由：开 = 该 Agent 暴露虚拟模型 auto 并按链退避；关 = 链配置保留但 auto 不暴露"><input type="checkbox" data-route-enabled="${ep}"${enabled ? " checked" : ""}><span class="slider"></span></label>
            <button class="btn" data-route-edit="${ep}">编辑</button>
            <button class="btn btn-danger" data-route-del-chain="${ep}">删除</button>
          </div>
        </div>`;
      }
      return `<div class="route-ep-tile route-ep-tile--empty" data-agent-id="${ep}">
        <div class="route-ep-tile-top"><div class="route-ep-id"><span class="route-ep-avatar" data-route-avatar="${ep}"></span><span class="route-ep-name">${escapeHtml(label)}</span></div><span class="badge badge-neutral">未配置</span></div>
        <div class="route-ep-tile-actions">
          <button class="btn" data-route-edit="${ep}">配置路由链</button>
        </div>
      </div>`;
    }).join("");
    $("routeChainBadge").textContent = String(configured);
    // 瓦片图标 = 看板 .agent-avatar 的克隆（与抗截断端点钮、关于页同一来源；
    // 克隆在三处间保持一致，亮暗/主题 token 自动跟随）
    grid.querySelectorAll("[data-route-avatar]").forEach((slot) => {
      const avatar = document.querySelector(`.agent-cards-container .panel-card[data-agent-id="${slot.getAttribute("data-route-avatar")}"] .agent-avatar`);
      if (avatar) slot.appendChild(avatar.cloneNode(true));
    });
    grid.querySelectorAll("[data-route-edit]").forEach((btn) => {
      btn.onclick = () => openRouteChainModal(btn.getAttribute("data-route-edit"));
    });
    grid.querySelectorAll("[data-route-del-chain]").forEach((btn) => {
      btn.onclick = () => confirmRouteChainDelete(btn.getAttribute("data-route-del-chain"));
    });
    grid.querySelectorAll("[data-route-enabled]").forEach((input) => {
      input.onchange = () => {
        const ep = input.getAttribute("data-route-enabled");
        const label = routeChainEndpointLabel(ep);
        storeAction("/api/store/route-chain/enabled", { endpointId: ep, enabled: input.checked },
          input.checked ? `已启用自动路由：${label}` : `已停用自动路由：${label}（链配置保留）`);
      };
    });
    renderVirtualModels();
  }

  // ── 虚拟模型瓦片墙：与端点瓦片同一套 route-ep-tile 质感/网格，头部是模型名
  // （即客户端模型选择器里看到的名字）而非端点图标；徽标/编辑/删除/启用与端点瓦片同语义。
  // 「新建虚拟模型」瓦片固定在网格末位，打开编辑器的新建流（输入模型名 + 配链一起保存）。
  function renderVirtualModels() {
    const grid = $("virtualModelGrid");
    if (!grid) return;
    const list = storeVirtualModels();
    let configured = 0;
    grid.innerHTML = list.map((v) => {
      const chain = Array.isArray(v.chain) ? v.chain : [];
      if (!chain.length) return "";
      configured++;
      const enabled = v.enabled !== false;
      return `<div class="route-ep-tile" data-virtual-model="${escapeHtml(v.name)}">
        <div class="route-ep-tile-top"><div class="route-ep-id"><span class="route-ep-name" style="font-family:var(--font-mono);">${escapeHtml(v.name)}</span></div><span class="badge ${enabled ? "badge-accent" : "badge-neutral"}">${enabled ? `${chain.length} 节点` : "已停用"}</span></div>
        <div class="route-ep-tile-actions">
          <label class="toggle" title="启用虚拟模型：开 = 该模型出现在各 Agent 的 Anyswitch 分组下并按链路由；关 = 链配置保留但模型不再出现"><input type="checkbox" data-vm-enabled="${escapeHtml(v.name)}"${enabled ? " checked" : ""}><span class="slider"></span></label>
          <button class="btn" data-vm-edit="${escapeHtml(v.name)}">编辑</button>
          <button class="btn btn-danger" data-vm-del="${escapeHtml(v.name)}">删除</button>
        </div>
      </div>`;
    }).join("") + `<div class="route-ep-tile route-ep-tile--empty">
      <div class="route-ep-tile-top"><div class="route-ep-id"><span class="route-ep-name">新建虚拟模型</span></div><span class="badge badge-neutral">一条命名路由链</span></div>
      <div class="route-ep-tile-actions">
        <button class="btn" id="virtualModelAddBtn">＋ 新建</button>
      </div>
    </div>`;
    $("virtualModelBadge").textContent = String(configured);
    grid.querySelectorAll("[data-vm-edit]").forEach((btn) => {
      btn.onclick = () => openVirtualModelModal(btn.getAttribute("data-vm-edit"));
    });
    grid.querySelectorAll("[data-vm-del]").forEach((btn) => {
      btn.onclick = () => confirmVirtualModelDelete(btn.getAttribute("data-vm-del"));
    });
    grid.querySelectorAll("[data-vm-enabled]").forEach((input) => {
      input.onchange = () => {
        const name = input.getAttribute("data-vm-enabled");
        storeAction("/api/store/virtual-model/enabled", { name, enabled: input.checked },
          input.checked ? `已启用虚拟模型：${name}` : `已停用虚拟模型：${name}（链配置保留）`);
      };
    });
    const addBtn = $("virtualModelAddBtn");
    if (addBtn) addBtn.onclick = () => openVirtualModelModal(null);
  }

  function confirmVirtualModelDelete(name) {
    showSkillsModal({
      title: `删除虚拟模型 — ${name}`,
      danger: true,
      confirmText: "确认删除",
      bodyHtml: `<div style="font-size:12.5px; line-height:1.7;">
        删除后模型 <b>${escapeHtml(name)}</b> 将从各 Agent 的 Anyswitch 分组中移除，请求它的调用会失败；渠道与号池本身不受影响。</div>`,
      onConfirm: async () => {
        await storeAction("/api/store/virtual-model/delete", { name }, `已删除虚拟模型：${name}`);
      },
    });
  }

  function confirmRouteChainDelete(endpointId) {
    const label = routeChainEndpointLabel(endpointId);
    showSkillsModal({
      title: `删除路由链 — ${label}`,
      danger: true,
      confirmText: "确认删除",
      bodyHtml: `<div style="font-size:12.5px; line-height:1.7;">
        删除后 Agent <b>${escapeHtml(label)}</b> 请求模型 <b>auto</b> 将不再走链式路由（回退到常规渠道解析）；渠道与号池本身不受影响。</div>`,
      onConfirm: async () => {
        await storeAction("/api/store/route-chain/delete", { endpointId }, `已删除路由链：${label}`);
      },
    });
  }

  // ── 链编辑器弹窗 ──
  function openRouteChainModal(endpointId) {
    if (!storeState || !storeState.storeOk) {
      toast("store 不可用，无法编辑路由链", true);
      return;
    }
    routeChainTarget = { kind: "endpoint", id: endpointId };
    virtualModelCreating = false;
    virtualModelNameDraft = "";
    const saved = storeRoutingChainFor(endpointId);
    routeChainDraft = saved ? saved.map((it) => ({ node: it.node, model: it.model })) : [];
    routeChainCandModels = {};
    renderRouteChainBody();
    $("routeChainModal").classList.add("show");
  }

  // 虚拟模型：name 为 null 时进入新建流——目标先占位 kind:"virtual"、id 未定，
  // 模型名输入框放在编辑器正文顶部（初始聚焦），入口桩标签随输入即时更新；
  // 名字与链一起在保存时提交。名字可改：编辑流把当前名填进草稿（输入框可编辑），
  // 保存时带原名走改名分支；改名换掉的是对外模型 id，故保存前过一次确认。
  function openVirtualModelModal(name) {
    if (!storeState || !storeState.storeOk) {
      toast("store 不可用，无法编辑虚拟模型", true);
      return;
    }
    if (name != null) {
      routeChainTarget = { kind: "virtual", id: name };
      virtualModelCreating = false;
      virtualModelNameDraft = name;   // 草稿 = 当前名：名字可编辑，校验/保存都读它
      const saved = storeVirtualModelFor(name);
      routeChainDraft = saved ? saved.map((it) => ({ node: it.node, model: it.model })) : [];
    } else {
      routeChainTarget = { kind: "virtual", id: null };
      virtualModelCreating = true;
      virtualModelNameDraft = "";
      routeChainDraft = [];
    }
    routeChainCandModels = {};
    renderRouteChainBody();
    $("routeChainModal").classList.add("show");
    const nameInput = $("virtualModelNameInput");
    if (nameInput) nameInput.focus();
  }

  function hideRouteChainModal() {
    if (routeChainBusy) return;
    $("routeChainModal").classList.remove("show");
  }

  // 与 store-schema 同口径的前端先行校验（行内报错，不打到后端才失败）
  function routeChainValidate(chain) {
    if (!chain.length) return "路由链为空：请先从右侧候选列表添加至少 1 个渠道或号池";
    if (chain.length > ROUTE_CHAIN_MAX_NODES) return `一条路由链最多 ${ROUTE_CHAIN_MAX_NODES} 个节点`;
    const seen = new Set();
    for (const it of chain) {
      const key = `${it.node} ${it.model}`;
      if (seen.has(key)) return `节点与模型组合重复：${routeNodeName(it.node)}（${it.model}）`;
      seen.add(key);
      if (!it.model || !String(it.model).trim()) return `节点 ${routeNodeName(it.node)} 未绑定模型`;
    }
    return null;
  }

  // 位次标签：首跳「主力」，其后「退避N」（与底部摘要 E10 共用口径）
  function routeHopLabel(i) {
    return i === 0 ? "主力" : `退避${i}`;
  }

  // 底部一行文本摘要（E10）：`主力: 模型A · provider甲 → 退避1: 模型B · provider乙 → …`
  function routeChainSummaryText() {
    if (!routeChainDraft.length) return "尚未配置：从右侧候选列表选择渠道或号池接入";
    return routeChainDraft.map((it, i) => `${routeHopLabel(i)}: ${it.model} · ${routeNodeName(it.node)}`).join(" → ");
  }

  // 链舞台 HTML（E1 纵向阶梯，自上而下 = 降级方向；编辑器无运行时状态数据，
  // 连接线一律按「冷备」基态渲染，is-active/is-down 等状态类为监测页预备）。
  // opts.enterAnim = 末跳「从链尾生长」入场动画标记（E5 添加成功时传入）
  // 入口桩标签 = 编辑目标：端点链恒为 auto；虚拟模型 = 名字草稿（新建与编辑同一口径）。
  function renderRouteStageHtml(opts) {
    const enterAnim = !!(opts && opts.enterAnim);
    const items = routeChainDraft;
    const isVirtual = !!routeChainTarget && routeChainTarget.kind === "virtual";
    const entryTag = isVirtual ? (virtualModelNameValue() || "模型名") : "auto";
    const parts = [`<div class="route-entry" aria-hidden="true"><span class="route-entry-tag">${escapeHtml(entryTag)}</span></div>`];
    if (!items.length) {
      // 空链：入口桩下垂虚线 → 虚线空槽
      parts.push(`<div class="route-seg is-dangling" style="--i:0" aria-hidden="true"></div>`);
      parts.push(`<div class="route-node-card empty-slot" style="--k:0">从右侧选择渠道，接到这里</div>`);
      return parts.join("");
    }
    items.forEach((it, i) => {
      const last = i === items.length - 1;
      const enter = enterAnim && last ? " enter" : "";
      parts.push(`<div class="route-seg${enter}" style="--i:${i}" aria-hidden="true"></div>`);
      parts.push(`
      <div class="route-node-card${enter}" style="--k:${i}" draggable="true" data-route-node="${i}"
        data-route-key="${escapeHtml(it.node)} ${escapeHtml(it.model)}" title="拖拽调序 · 右键删除">
        <div class="route-node-card-model">${escapeHtml(it.model || "")}</div>
        <div class="route-node-card-sub">${escapeHtml(routeNodeName(it.node))}${routeNodeIsPool(it.node) ? ` <span class="badge badge-pool">号池</span>` : ""} · ${escapeHtml(it.node)}</div>
      </div>`);
    });
    return parts.join("");
  }

  // 幽灵节点（E5 添加预告）：hover 候选行时在链尾插虚线卡（含当前下拉模型值），
  // 不整树重渲，直接向舞台 append/remove
  function routeChainHideGhost() {
    const stage = $("routeChainStage");
    if (stage) stage.querySelectorAll("[data-ghost]").forEach((el) => el.remove());
  }
  function routeChainShowGhost(id, model) {
    const stage = $("routeChainStage");
    if (!stage || !model) return;
    routeChainHideGhost();
    const k = routeChainDraft.length;
    const seg = document.createElement("div");
    seg.className = "route-seg ghost";
    seg.style.setProperty("--i", String(k));
    seg.dataset.ghost = "1";
    seg.setAttribute("aria-hidden", "true");
    const card = document.createElement("div");
    card.className = "route-node-card ghost";
    card.style.setProperty("--k", String(k));
    card.dataset.ghost = "1";
    card.innerHTML = `<div class="route-node-card-model">${escapeHtml(model)}</div>
      <div class="route-node-card-sub">${escapeHtml(routeNodeName(id))} · ${escapeHtml(id)}</div>`;
    stage.appendChild(seg);
    stage.appendChild(card);
  }

  // 舞台节点矩形快照（key = node+model，去重口径保证唯一）：供删除吸合 / 拖拽让位
  // 的 FLIP 近似补间使用
  function routeChainStageRects() {
    const m = new Map();
    const stage = $("routeChainStage");
    if (stage) stage.querySelectorAll("[data-route-key]").forEach((el) => m.set(el.getAttribute("data-route-key"), el.getBoundingClientRect()));
    return m;
  }
  // FLIP：重渲后把仍存在旧位置的节点从新位置平移回旧位置，再 transition 归零
  function routeChainFlipFrom(rects, ms) {
    const stage = $("routeChainStage");
    if (!stage || !rects.size) return;
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    stage.querySelectorAll("[data-route-key]").forEach((el) => {
      const prev = rects.get(el.getAttribute("data-route-key"));
      if (!prev) return;
      const dy = prev.top - el.getBoundingClientRect().top;
      if (!dy) return;
      el.style.transition = "none";
      el.style.transform = `translateY(${dy}px)`;
      void el.offsetWidth;
      el.style.transition = `transform ${ms}ms ease`;
      el.style.transform = "";
      setTimeout(() => { el.style.transition = ""; }, ms + 30);
    });
  }

  // 删除（E8）：节点溶解（~200ms WAAPI）→ splice 重渲 → 缺口两侧吸合（~250ms FLIP）
  function routeChainRemoveNode(i, card) {
    const rects = routeChainStageRects();
    const done = () => {
      routeChainDraft.splice(i, 1);
      renderRouteChainBody();
      routeChainFlipFrom(rects, 250);
    };
    if (card && card.animate) {
      card.animate([{ opacity: 1 }, { opacity: 0, transform: "scale(0.92)" }], { duration: 200, easing: "ease-in" })
        .finished.then(done, done);
    } else {
      done();
    }
  }

  function renderRouteChainBody(opts) {
    const isVirtual = !!routeChainTarget && routeChainTarget.kind === "virtual";
    // 虚拟模型的名字一律取草稿（编辑流打开时草稿 = 当前名）：标题、桩标签、
    // 链路标签与保存去向都跟着草稿走，不再分「新建读草稿 / 编辑读目标名」两套。
    const vmName = virtualModelNameValue();
    const entryLabel = isVirtual ? (vmName || routeChainTarget.id || "") : routeChainEndpointLabel(routeChainTarget.id);
    $("routeChainTitle").textContent = isVirtual
      ? (virtualModelCreating ? "新建虚拟模型" : `编辑虚拟模型 — ${entryLabel}`)
      : `编辑路由链 — ${entryLabel}`;
    // 底部按钮随目标分叉：虚拟模型编辑器里不该写「保存路由链」
    $("routeChainConfirmBtn").textContent = isVirtual ? "保存虚拟模型" : "保存路由链";
    // 重渲会重建 innerHTML，先记住候选列表滚动位置，渲染后原地恢复（选择后列表不跳顶）
    const prevWrap = $("routeCandWrap");
    const prevScroll = prevWrap ? prevWrap.scrollTop : 0;
    // 去重口径 = node+model 组合：同节点换模型可再次入链，同节点同模型才拒绝
    const inChain = new Set(routeChainDraft.map((it) => `${it.node} ${it.model}`));
    const cands = routeChainCandidates();
    const full = routeChainDraft.length >= ROUTE_CHAIN_MAX_NODES;
    const candRows = cands.length ? cands.map((c) => {
      const models = routeNodeModels(c.id);
      // 下拉选中值：记忆值优先，否则首个模型；记忆值已不在目录则回落首个
      let sel = routeChainCandModels[c.id];
      if (!sel || !models.includes(sel)) sel = models[0] || "";
      routeChainCandModels[c.id] = sel;
      const added = inChain.has(`${c.id} ${sel}`);
      return `<div class="route-cand-row${added ? " is-added" : ""}" data-route-add="${escapeHtml(c.id)}"
          title="${added ? "该节点+模型已在链中" : !models.length ? "无模型可绑定" : `接到第 ${routeChainDraft.length + 1} 跳`}">
        <span class="route-cand-name">${escapeHtml(c.name)}${c.isPool ? ` <span class="badge badge-pool">号池</span>` : ""}</span>
        <span class="route-cand-id">${escapeHtml(c.id)}</span>
        ${models.length
          ? `<select class="store-form-input" data-route-cand-model="${escapeHtml(c.id)}">
              ${models.map((m) => `<option value="${escapeHtml(m)}"${m === sel ? " selected" : ""}>${escapeHtml(m)}</option>`).join("")}
            </select>`
          : `<select class="store-form-input" disabled><option>无模型缓存</option></select>`}
      </div>`;
    }).join("") : `<div class="route-cand-row" style="cursor:default;"><span class="route-cand-name" style="color:var(--text-4);">暂无渠道/号池，请先在「渠道管理」新增渠道</span></div>`;
    const summary = routeChainSummaryText();
    // 名字输入框：新建与编辑同一形态（可编辑）。编辑流的初值就是当前名，
    // 改名与改链一起在保存时提交，改名前过一次确认。
    const nameRow = isVirtual
      ? `<div class="store-form-row virtual-add-row"><label class="store-form-label">模型名（字母、数字、. _ -；改名后旧名字立即失效）</label>
          <input class="store-form-input" id="virtualModelNameInput" value="${escapeHtml(vmName)}" placeholder="如 DeepSeek-Pro" autocomplete="off" spellcheck="false"></div>`
      : "";
    $("routeChainBody").innerHTML = `
      ${nameRow}
      <div style="font-size:11.5px; color:var(--text-3);${isVirtual ? "" : " margin-top:8px;"}">
        链路自上而下按序路由，失败自动退避下一跳；节点卡可拖拽调序、右键移除。一条链最多 ${ROUTE_CHAIN_MAX_NODES} 跳，同一渠道/号池可绑定不同模型各占一跳。</div>
      <div class="route-editor">
        <div class="route-stage-col">
          <div class="store-form-label">链路（${escapeHtml(isVirtual ? (vmName || "模型名") : entryLabel)} → 逐跳退避）</div>
          <div class="route-stage" id="routeChainStage">${renderRouteStageHtml(opts)}</div>
        </div>
        <div class="route-cand-col${full ? " is-full" : ""}">
          <div class="route-cands-tip">${full
            ? `链已满（${ROUTE_CHAIN_MAX_NODES} 跳），右键删除节点后可继续添加`
            : `点击任意候选 → 接到第 ${routeChainDraft.length + 1} 跳`}</div>
          <div class="route-cand-wrap" id="routeCandWrap">${candRows}</div>
        </div>
      </div>
      <div class="store-form-error" id="routeChainError" hidden></div>
      <div class="route-chain-summary" title="${escapeHtml(summary)}">${escapeHtml(summary)}</div>
    `;
    const body = $("routeChainBody");
    const stage = $("routeChainStage");
    const nameInput = $("virtualModelNameInput");
    if (nameInput) {
      // 模型名输入驱动入口桩标签/链路标签/编辑器标题即时更新（renderRouteChainBody
      // 全量重建会清输入值与焦点，故只改这几处文本，不整渲）。编辑流同样走这条：
      // 改名时标题跟着草稿走，保存后才真正换 id。
      nameInput.addEventListener("input", () => {
        virtualModelNameDraft = nameInput.value;
        const label = virtualModelNameValue() || "模型名";
        const tag = stage.querySelector(".route-entry-tag");
        if (tag) tag.textContent = label;
        const stageLabel = stage.previousElementSibling;
        if (stageLabel && stageLabel.classList.contains("store-form-label")) {
          stageLabel.textContent = `链路（${label} → 逐跳退避）`;
        }
        if (!virtualModelCreating) $("routeChainTitle").textContent = `编辑虚拟模型 — ${label}`;
        const err = $("routeChainError");
        if (err && !err.hidden) { err.hidden = true; err.textContent = ""; }
      });
    }
    body.querySelectorAll("[data-route-cand-model]").forEach((sel) => {
      // 切换模型后「已入链」判定随 node+model 口径变化，重渲候选区
      sel.onchange = () => {
        routeChainCandModels[sel.getAttribute("data-route-cand-model")] = sel.value;
        renderRouteChainBody();
      };
    });
    const wrap = $("routeCandWrap");
    wrap.scrollTop = prevScroll;
    // 添加（E5）：点击候选行 = 接到链尾；hover 行时链尾出虚线幽灵节点预告
    wrap.addEventListener("mouseover", (e) => {
      const row = e.target.closest("[data-route-add]");
      if (!row || row.classList.contains("is-added") || full) return;
      routeChainShowGhost(row.getAttribute("data-route-add"), routeChainCandModels[row.getAttribute("data-route-add")]);
    });
    wrap.addEventListener("mouseleave", routeChainHideGhost);
    wrap.querySelectorAll("[data-route-add]").forEach((row) => {
      row.onclick = (e) => {
        if (e.target.closest("select")) return;
        const id = row.getAttribute("data-route-add");
        const model = routeChainCandModels[id];
        if (!model) return;
        if (routeChainDraft.length >= ROUTE_CHAIN_MAX_NODES) return;
        if (routeChainDraft.some((it) => it.node === id && it.model === model)) return;
        routeChainDraft.push({ node: id, model });
        renderRouteChainBody({ enterAnim: true });
      };
    });
    // 节点卡右键菜单（复用 skills 菜单样式/弹层；点外/Esc/滚动关闭由既有全局
    // 监听保证）：单项「删除」，直接移除不二次确认
    stage.oncontextmenu = (e) => {
      const card = e.target.closest("[data-route-node]");
      if (!card) return;
      e.preventDefault();
      const i = Number(card.getAttribute("data-route-node"));
      const it = routeChainDraft[i];
      if (!it) return;
      popSkillsContextMenu(e.clientX, e.clientY, `${it.model} · ${routeNodeName(it.node)}`, [
        { label: "删除", danger: true, fn: () => routeChainRemoveNode(i, card) },
      ]);
    };
    // hover 某节点 →「入口→该节点」区段连接段加亮（E4，复用 is-active 活跃态）
    stage.addEventListener("mouseover", (e) => {
      stage.querySelectorAll(".route-seg.is-active").forEach((s) => s.classList.remove("is-active"));
      const card = e.target.closest("[data-route-node]");
      if (!card) return;
      const upto = Number(card.getAttribute("data-route-node"));
      stage.querySelectorAll(".route-seg").forEach((s) => {
        if (Number(s.style.getPropertyValue("--i") || 0) <= upto) s.classList.add("is-active");
      });
    });
    stage.addEventListener("mouseleave", () => {
      stage.querySelectorAll(".route-seg.is-active").forEach((s) => s.classList.remove("is-active"));
    });
    // 调序（E6）：HTML5 拖拽。拖动中把被拖卡（连同其上方连接段）按指针位置在
    // DOM 里移动，其余节点经 FLIP 补间让位；drop 后按 DOM 现序重排草稿并重渲，
    // 落位节点宽度/透明度经 transition 渐变迁移到新位次规格
    let dragIndex = null;
    const segOf = (card) => {
      const prev = card.previousElementSibling;
      return prev && prev.classList.contains("route-seg") ? prev : null;
    };
    stage.querySelectorAll("[data-route-node]").forEach((card) => {
      card.addEventListener("dragstart", (e) => {
        dragIndex = Number(card.getAttribute("data-route-node"));
        card.classList.add("dragging");
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", String(dragIndex));
      });
      card.addEventListener("dragend", () => {
        // 未落位（Esc/拖出）时 DOM 已被挪动，重渲恢复与草稿一致
        if (dragIndex != null) { dragIndex = null; renderRouteChainBody(); }
      });
    });
    stage.addEventListener("dragover", (e) => {
      if (dragIndex == null) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const dragging = stage.querySelector(".route-node-card.dragging");
      if (!dragging) return;
      const others = [...stage.querySelectorAll("[data-route-node]")].filter((c) => c !== dragging);
      let beforeCard = null;
      for (const c of others) {
        const r = c.getBoundingClientRect();
        if (e.clientY < r.top + r.height / 2) { beforeCard = c; break; }
      }
      const seg = segOf(dragging);
      // ref = 插入参照（下一槽位的连接段；拖到链尾时为 null = append 到末尾）
      const ref = beforeCard ? segOf(beforeCard) : null;
      if (ref && (ref === seg || ref === dragging)) return;
      const rects = new Map(others.map((c) => [c, c.getBoundingClientRect()]));
      if (seg) stage.insertBefore(seg, ref);
      stage.insertBefore(dragging, ref);
      // 让位补间：仅对位移的其余卡片做 FLIP
      others.forEach((c) => {
        const dy = rects.get(c).top - c.getBoundingClientRect().top;
        if (!dy) return;
        c.style.transition = "none";
        c.style.transform = `translateY(${dy}px)`;
        void c.offsetWidth;
        c.style.transition = "transform 0.2s ease";
        c.style.transform = "";
      });
    });
    stage.addEventListener("drop", (e) => {
      if (dragIndex == null) return;
      e.preventDefault();
      const movedKey = `${routeChainDraft[dragIndex].node} ${routeChainDraft[dragIndex].model}`;
      const dropRect = (stage.querySelector(".route-node-card.dragging") || {}).getBoundingClientRect
        ? stage.querySelector(".route-node-card.dragging").getBoundingClientRect() : null;
      dragIndex = null;
      // 按 DOM 现序重排草稿（key = node+model，去重口径保证一一对应）
      const byKey = new Map(routeChainDraft.map((it) => [`${it.node} ${it.model}`, it]));
      const next = [...stage.querySelectorAll("[data-route-key]")].map((c) => byKey.get(c.getAttribute("data-route-key"))).filter(Boolean);
      if (next.length !== routeChainDraft.length) { renderRouteChainBody(); return; }
      routeChainDraft = next;
      renderRouteChainBody();
      // 落位迁移：先按拖动末态矩形还原位置/宽度/透明度，再交回 CSS 位次规格
      if (!dropRect) return;
      const el = [...stage.querySelectorAll("[data-route-key]")].find((c) => c.getAttribute("data-route-key") === movedKey);
      if (!el) return;
      const now = el.getBoundingClientRect();
      el.style.transition = "none";
      el.style.transform = `translateY(${dropRect.top - now.top}px)`;
      el.style.width = `${dropRect.width}px`;
      void el.offsetWidth;
      el.style.transition = "transform 0.25s ease, width 0.25s ease, opacity 0.25s ease";
      el.style.transform = "";
      el.style.width = "";
      setTimeout(() => { el.style.transition = ""; }, 280);
    });
  }

  // 行内报错出口（校验与写盘失败共用一处，避免两个函数各持一份 fail 闭包）
  function routeChainErrorShow(msg) {
    const err = $("routeChainError");
    if (!err) return;
    err.hidden = false;
    err.textContent = msg;
  }

  async function confirmRouteChainSave() {
    const err = $("routeChainError");
    err.hidden = true;
    const isVirtual = !!routeChainTarget && routeChainTarget.kind === "virtual";
    const nameErr = isVirtual ? virtualModelNameError() : null;
    if (nameErr) return routeChainErrorShow(nameErr);
    const validErr = routeChainValidate(routeChainDraft);
    if (validErr) return routeChainErrorShow(validErr);
    // 虚拟模型改名：换掉的是对外模型 id，各 agent 里选过旧名的调用会失效，
    // 故写盘前先过一次确认（取消即什么都不发生）。
    if (isVirtual && !virtualModelCreating && routeChainTarget.id !== virtualModelNameValue()) {
      const prev = routeChainTarget.id;
      const next = virtualModelNameValue();
      showSkillsModal({
        title: `改名虚拟模型 — ${prev} → ${next}`,
        confirmText: "确认改名",
        bodyHtml: `<div style="font-size:12.5px; line-height:1.7;">
          改名后 <b>${escapeHtml(prev)}</b> 立即失效、<b>${escapeHtml(next)}</b> 立刻生效：链、启用开关与位次都不变。
          各 agent 里选过 <b>${escapeHtml(prev)}</b> 的地方需要重新选一次。</div>`,
        onConfirm: () => commitRouteChainSave(),
      });
      return;
    }
    await commitRouteChainSave();
  }

  // 写盘：端点链与虚拟模型共用一条 CAS 路径；虚拟模型改名与改链在同一次请求里落，
  // 要么都成、要么都不动（不会留下「改了一半」的两条记录）。
  async function commitRouteChainSave() {
    const isVirtual = !!routeChainTarget && routeChainTarget.kind === "virtual";
    const btn = $("routeChainConfirmBtn");
    routeChainBusy = true;
    btn.disabled = true;
    btn.textContent = "保存中…";
    try {
      if (isVirtual) {
        const name = virtualModelNameValue();
        const previousName = virtualModelCreating ? null : routeChainTarget.id;
        const renamed = !!previousName && previousName !== name;
        await api("POST", "/api/store/virtual-model/save", {
          name,
          chain: routeChainDraft.map((it) => ({ node: it.node, model: it.model })),
          ...(renamed ? { previousName } : {}),
        });
        $("routeChainModal").classList.remove("show");
        toast(renamed
          ? `虚拟模型已改名：${previousName} → ${name}（${routeChainDraft.length} 个节点）`
          : `虚拟模型已保存：${name}（${routeChainDraft.length} 个节点）`);
        await refreshStoreState();
      } else {
        const label = routeChainEndpointLabel(routeChainTarget.id);
        await api("POST", "/api/store/route-chain/save", {
          endpointId: routeChainTarget.id,
          chain: routeChainDraft.map((it) => ({ node: it.node, model: it.model })),
        });
        $("routeChainModal").classList.remove("show");
        toast(`路由链已保存：${label}（${routeChainDraft.length} 个节点）`);
        await refreshStoreState();
      }
    } catch (e) {
      if (e.code === "cas-conflict") {
        routeChainErrorShow("渠道配置已被其他操作改动，请稍后重试");
        await refreshStoreState();
      } else {
        routeChainErrorShow(panelError(e, "操作失败"));
      }
    } finally {
      routeChainBusy = false;
      btn.disabled = false;
      btn.textContent = isVirtual ? "保存虚拟模型" : "保存路由链";
    }
  }

  // 虚拟模型名字符集（store-schema VIRTUAL_MODEL_ID 口径）：字母开头（大小写均可），
  // 其余为字母/数字/. _ -；它同时充当链查找键与客户端模型 id。占用判定不区分大小写
  // ——仅大小写不同的两个名字会互相顶掉对外 id，与保存入口同口径拦在写盘前。
  // 名字取自草稿（编辑流打开即填入当前名），故编辑已有虚拟模型时不会误报缺名。
  function virtualModelNameError() {
    const name = virtualModelNameValue();
    if (!name) return "请填写模型名";
    if (!/^[A-Za-z][A-Za-z0-9._-]*$/.test(name)) return "模型名格式不对：字母开头，只能含字母、数字、. _ -";
    if (name.length > 64) return "模型名最长 64 字符";
    if (routeChainDraft.some((it) => it.model === name)) {
      return `模型名不能与链内模型重名（${name}）`;
    }
    // 占用校验：与别的虚拟模型同名（或仅大小写不同）一律拦在保存之前——新建撞名
    // 会静默换掉那条模型的链，改名撞名会顶掉别人的对外 id。编辑流按目标 id 排除自己。
    const self = virtualModelCreating ? null : routeChainTarget.id;
    const taken = storeVirtualModels().find(
      (v) => v && v.name !== self && v.name.toLowerCase() === name.toLowerCase(),
    );
    if (taken) {
      return taken.name === name
        ? `这个名字已被占用：${name}`
        : `这个名字与已有的 ${taken.name} 仅大小写不同`;
    }
    return null;
  }

  // ── 右键菜单（复用 skills 菜单样式与弹层函数；多选菜单追加「组建号池」） ──
  function showStoreContextMenu(x, y, id) {
    hideSkillsContextMenu();
    const row = storeRows().find((r) => r.id === id);
    if (!row) return;
    if (storeSelection.has(id) && storeSelection.size > 1) {
      // 多选菜单：基础项 + 组建/加入号池（置于删除之前）；无池时「加入号池」置灰
      const items = [
        { label: "测试连接", fn: () => runStoreTest(storeSelectionProviders()) },
        { label: "刷新模型", fn: () => storeRefresh(storeSelectionProviders()) },
        { label: "全选", fn: selectAllVisibleStoreRows },
        { label: "取消选择", fn: () => { storeSelection.clear(); requestStoreFocus(null); renderStoreList(); } },
        { label: "组建号池", fn: openPoolBuildModal },
        { label: "加入号池…", disabled: storePools().length ? null : "暂无号池，请先组建号池", fn: openPoolAddToPoolModal },
        { label: "删除选中项", danger: true, fn: confirmDeleteStoreSelection },
      ];
      popSkillsContextMenu(x, y, `已选 ${storeSelection.size} 项`, items);
      return;
    }
    if (row.kind === "pool") {
      popSkillsContextMenu(x, y, row.displayName, [
        { label: "测试连接", fn: () => runStoreTest(row.members.map((m) => m.id)) },
        { label: "刷新模型", fn: () => storeRefresh(row.members.map((m) => m.id), { wholeLabel: row.displayName || row.id }) },
        { label: "重命名", fn: () => showRenamePoolModal(row) },
        { label: "解除号池", fn: () => confirmDissolvePool(row) },
        { label: "全选", fn: selectAllVisibleStoreRows },
        { label: "取消选择", fn: () => { storeSelection.clear(); requestStoreFocus(null); renderStoreList(); } },
        { label: "删除号池及成员", danger: true, fn: () => confirmDeletePool(row) },
      ]);
      return;
    }
    const p = row.p;
    popSkillsContextMenu(x, y, p.displayName, [
      { label: "测试连接", fn: () => runStoreTest([p.id]) },
      { label: "刷新模型", fn: () => storeRefresh([p.id]) },
      { label: "重命名", fn: () => showRenameProviderModal(p) },
      { label: "加入号池…", disabled: storePools().length ? null : "暂无号池，请先组建号池", fn: openPoolAddToPoolModal },
      { label: "更改配置", fn: () => showRotateModal(p) },
      { label: "全选", fn: selectAllVisibleStoreRows },
      { label: "取消选择", fn: () => { storeSelection.clear(); requestStoreFocus(null); renderStoreList(); } },
      { label: "删除渠道", danger: true, fn: () => confirmDeleteProvider(p) },
    ]);
  }

  // 全选：集合 = 过滤后全部可见行；焦点不变（只要它还在集合内）
  function selectAllVisibleStoreRows() {
    storeSelection = new Set(storeVisibleRows().map((r) => r.id));
    if (storeFocusId && !storeSelection.has(storeFocusId)) storeFocusId = storeLastSelectionId();
    renderStoreList();
  }

  function initStoreTab() {
    $("tabStore").onclick = () => switchView("store");
    $("storeAddBtn").onclick = () => showAddModal();
    $("storeImportLocalBtn").onclick = () => openByokImportModal();
    $("storeRefreshAllBtn").onclick = () => storeRefresh(null);
    // 「查看差异」弹窗关闭：关闭钮 / 点遮罩 / Esc（与会话删除确认弹窗同模式）
    $("storeDiffCloseBtn").addEventListener("click", closeStoreDiffModal);
    $("storeDiffMask").addEventListener("click", (e) => { if (e.target === $("storeDiffMask")) closeStoreDiffModal(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && $("storeDiffMask").classList.contains("show")) closeStoreDiffModal(); });
    $("storeFilterInput").addEventListener("input", renderStoreList);
    initStoreListDrag();

    $("storeList").addEventListener("click", (e) => {
      hideSkillsContextMenu();
      // 拖拽重排落位后的合成 click：吞掉，不当成选中操作
      if (suppressStoreClick) { suppressStoreClick = false; return; }
      const row = e.target.closest("[data-store]");
      if (!row) {
        // 资源管理器惯例：左键点列表空白处清空选中与焦点
        if (storeSelection.size) {
          storeSelection.clear();
          requestStoreFocus(null);
          renderStoreList();
        }
        return;
      }
      const id = row.getAttribute("data-store");
      if (e.ctrlKey || e.metaKey) {
        // Ctrl+左键：切换成员资格；加入时焦点跟随，移除焦点行则回退到集合剩余最后一员
        if (storeSelection.has(id)) {
          storeSelection.delete(id);
          if (storeFocusId === id) requestStoreFocus(storeLastSelectionId());
          else renderStoreList();
        } else {
          storeSelection.add(id);
          requestStoreFocus(id);
        }
        return;
      }
      if (storeSelection.size === 1 && storeSelection.has(id) && storeFocusId === id) {
        // 再点当前唯一选中行：取消选中（详情卡随之收起）
        storeSelection.clear();
        requestStoreFocus(null);
        renderStoreList();
        return;
      }
      // 普通左键：集合 = {该行}，焦点 = 该行
      storeSelection.clear();
      storeSelection.add(id);
      requestStoreFocus(id);
    });
    $("storeList").addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const row = e.target.closest("[data-store]");
      if (!row) {
        // 空白处：仅全选/取消选择
        const items = [{ label: "全选", fn: selectAllVisibleStoreRows }];
        if (storeSelection.size) {
          items.push({ label: "取消选择", fn: () => { storeSelection.clear(); requestStoreFocus(null); renderStoreList(); } });
        }
        hideSkillsContextMenu();
        popSkillsContextMenu(e.clientX, e.clientY, "", items);
        return;
      }
      const id = row.getAttribute("data-store");
      if (!storeSelection.has(id)) {
        // 右键集合外行：集合 = {该行}、焦点 = 该行（脏过滤确认未过则不弹菜单，确认后重右键）
        const pid = storeDetailProviderIdFor(id, storePoolTab);
        if (storeFilterDirty && pid !== storeFilterProviderId) {
          requestStoreFocus(id);
          return;
        }
        storeSelection.clear();
        storeSelection.add(id);
        applyStoreFocus(id);
      }
      showStoreContextMenu(e.clientX, e.clientY, id);
    });
    $("storeList").addEventListener("scroll", hideSkillsContextMenu);
    // 模型行右键菜单：删除入口收进菜单，不设显性删除按钮。委托绑定在详情卡
    // 容器上（行由 innerHTML 重建，绑行会丢）。菜单暂只含「删除模型」一项。
    $("storeDetailBody").addEventListener("contextmenu", (e) => {
      const row = e.target.closest(".store-model-row");
      if (!row) return;
      e.preventDefault();
      const p = storeDetailProvider();
      const mid = row.getAttribute("data-mid");
      if (!p || !mid) return;
      hideSkillsContextMenu();
      popSkillsContextMenu(e.clientX, e.clientY, mid, [
        { label: "删除模型", danger: true, fn: () => removeStoreModel(p, mid) },
      ]);
    });
    // scroll 不冒泡：捕获阶段监听，模型列表滚动时收起菜单
    $("storeDetailBody").addEventListener("scroll", hideSkillsContextMenu, true);

    // 组建号池弹窗：关闭/取消/确认/遮罩点击
    $("poolBuildCloseBtn").onclick = hidePoolBuildModal;
    $("poolBuildCancelBtn").onclick = hidePoolBuildModal;
    $("poolBuildConfirmBtn").onclick = confirmPoolBuild;
    $("poolBuildModal").addEventListener("click", (e) => {
      if (e.target === $("poolBuildModal")) hidePoolBuildModal();
    });

    // 路由链编辑器弹窗：关闭/取消/确认/遮罩点击（编辑器状态为模块级，
    // refreshStoreState 只重建链卡区、不重渲弹窗正文，编辑内容不被轮询重置）
    $("routeChainCloseBtn").onclick = hideRouteChainModal;
    $("routeChainCancelBtn").onclick = hideRouteChainModal;
    $("routeChainConfirmBtn").onclick = confirmRouteChainSave;
    $("routeChainModal").addEventListener("click", (e) => {
      if (e.target === $("routeChainModal")) hideRouteChainModal();
    });
    // scroll 不冒泡：捕获阶段监听，候选区滚动时收起节点右键菜单
    $("routeChainBody").addEventListener("scroll", hideSkillsContextMenu, true);

    if ($("storeView").hidden === false) {
      refreshStoreState();
    }
  }

  // ═══════════════════════════════════════════════
  // 使用统计视图
  // ═══════════════════════════════════════════════
  // 多线配色：全部从既有语义 token 派生，后段加虚线变化保证可区分（暗色主题可读）
  const STATS_PALETTE = [
    { color: "var(--accent)", dash: "" },
    { color: "var(--ok)", dash: "" },
    { color: "var(--warn)", dash: "" },
    { color: "var(--danger)", dash: "" },
    { color: "var(--pool)", dash: "6,3" },
    { color: "var(--spark-line)", dash: "6,3" },
    { color: "var(--text-2)", dash: "6,3" },
  ];
  const STATS_OTHER_STYLE = { color: "var(--text-4)", dash: "3,3" };
  // 「按端点」口径的端点 = 客户端 agent（与监测页卡片同名）；journal 落的是
  // 小写 agentId，展示层映射为端点显示名，未知 id 原样兜底。
  const STATS_ENDPOINT_LABELS = {
    zcode: "ZCode", claude: "Claude Code", dsh: "DeepSeek Harness",
    opencode: "OpenCode", pi: "Pi", kimi: "Kimi Code",
    qoder: "Qoder", codex: "Codex", grok: "Grok Build",
  };
  const statsEndpointLabel = (id) => STATS_ENDPOINT_LABELS[id] || id || "未知端点";

  let statsData = null; // 最近一次成功响应（ok:false / 网络失败时保持旧值，首次失败则渲染空态）
  let statsTimer = null;
  const statsPrefs = { scope: "channel", days: 7, usageDim: "channel", usageDays: 7 };
  // 图例显隐（localStorage 持久化，按粒度分桶；数据里已消失的 key 由渲染前 prune 清掉）
  const statsLegendHidden = { channel: new Set(), endpoint: new Set(), model: new Set() };
  // 模型用量卡图例显隐（三粒度各自记忆，同上落盘 + prune）
  const statsUsageHidden = { channel: new Set(), endpoint: new Set(), model: new Set() };
  // 趋势图动画标记：null=下次渲染走 reveal 生长（进 tab 首张/空态恢复/切口径 seg）；
  // true=走 morph 形变，基线像素帧由渲染器从容器状态（_statsAnim/_statsCommit）自取
  let statsTrendPrev = null;
  // resize 重渲的一次性 snap 标记（阶段 3）：置位后下一次 renderStatsTrend 不播动画
  // 直落终态。用标记而非给 renderStatsTrend 加参——既有断言逐字钉着它的函数签名
  let statsTrendSnapOnce = false;
  // 取数竞态守卫：单调递增的请求序号。快速切 days seg / 手动刷新 / 30s 轮询并发时，
  // 慢的旧响应后到会被丢弃，避免覆盖新选择的窗口数据。
  let statsReqSeq = 0;

  // prefs 只从 localStorage 读一次；refreshStatsState 可能先于 initStatsTab 被
  // restoreView→switchView 触发（initSkillsTab 在前），故首次取数前必须兜底加载，
  // 否则刷新后 seg 显示已存选择、数据却按默认 days=7 拉取（UI 与数据错位）。
  let statsPrefsLoaded = false;
  function loadStatsPrefs() {
    if (statsPrefsLoaded) return;
    statsPrefsLoaded = true;
    try {
      const raw = localStorage.getItem("panel-stats-prefs");
      if (raw) {
        const p = JSON.parse(raw);
        if (["channel", "endpoint", "model"].includes(p.scope)) statsPrefs.scope = p.scope;
        if (["channel", "endpoint", "model"].includes(p.usageDim)) statsPrefs.usageDim = p.usageDim;
        if (p.days === 1 || p.days === 7) statsPrefs.days = p.days; // 旧值 30 等一律回落默认 7
        if (p.usageDays === 1 || p.usageDays === 7) statsPrefs.usageDays = p.usageDays;
      }
    } catch {}
    try {
      const raw = localStorage.getItem("panel-stats-legend");
      if (raw) {
        const p = JSON.parse(raw);
        // { legend:{dim:[key]}, usage:{dim:[key]} }；非法形状静默忽略，回落全显
        for (const [store, key] of [[statsLegendHidden, "legend"], [statsUsageHidden, "usage"]]) {
          const src = p && p[key] && typeof p[key] === "object" ? p[key] : null;
          if (!src) continue;
          for (const dim of ["channel", "endpoint", "model"]) {
            if (Array.isArray(src[dim])) src[dim].forEach((k) => { if (typeof k === "string") store[dim].add(k); });
          }
        }
      }
    } catch {}
  }

  function saveStatsPrefs() {
    try { localStorage.setItem("panel-stats-prefs", JSON.stringify(statsPrefs)); } catch {}
  }

  // 图例显隐落盘（与 panel-stats-prefs 并列键；Set 序列化为数组）
  function saveStatsLegend() {
    const ser = (m) => ({ channel: [...m.channel], endpoint: [...m.endpoint], model: [...m.model] });
    try { localStorage.setItem("panel-stats-legend", JSON.stringify({ legend: ser(statsLegendHidden), usage: ser(statsUsageHidden) })); } catch {}
  }

  function wireStatsSeg(id, cb) {
    const el = $(id);
    if (!el) return;
    el.querySelectorAll(".seg-btn").forEach((btn) => {
      btn.onclick = () => {
        el.querySelectorAll(".seg-btn").forEach((b) =>
          b.setAttribute("aria-checked", b === btn ? "true" : "false"));
        cb(btn.getAttribute("data-v"));
      };
    });
  }

  function syncStatsSegs() {
    const map = {
      statsSegScope: statsPrefs.scope,
      statsSegDays: String(statsPrefs.days),
      statsSegUsageDim: statsPrefs.usageDim,
      statsSegUsageDays: String(statsPrefs.usageDays),
    };
    for (const [id, v] of Object.entries(map)) {
      const el = $(id);
      if (!el) continue;
      el.querySelectorAll(".seg-btn").forEach((b) =>
        b.setAttribute("aria-checked", b.getAttribute("data-v") === v ? "true" : "false"));
    }
  }

  function initStatsTab() {
    $("tabStats").onclick = () => switchView("stats");
    loadStatsPrefs();
    // 切口径：清屏重绘 + 左至右线生长（重置 reveal 标记走首绘机制），不走 morph 插值；
    // days seg/图例显隐/30s 轮询仍维持 morph 平滑形变
    wireStatsSeg("statsSegScope", (v) => { statsPrefs.scope = v; saveStatsPrefs(); statsTrendPrev = null; renderStatsTrend(); });
    wireStatsSeg("statsSegDays", (v) => { statsPrefs.days = Number(v); saveStatsPrefs(); refreshStatsState(); });
    wireStatsSeg("statsSegUsageDim", (v) => { statsPrefs.usageDim = v; saveStatsPrefs(); renderStatsUsage({ replay: true }); });
    wireStatsSeg("statsSegUsageDays", (v) => { statsPrefs.usageDays = Number(v); saveStatsPrefs(); renderStatsUsage({ replay: true }); });
    syncStatsSegs();
    // 手动刷新键：立即重拉一次（非静默——失败弹 toast；30s 自动轮询不受影响），
    // 反馈与重播由 runStatsRefreshWithFeedback 承担
    $("statsRefreshBtn").onclick = () => runStatsRefreshWithFeedback();
    // 子 tab：总览 / 请求日志
    $("statsTabOverview").onclick = () => activateStatsSubTab("overview");
    $("statsTabLogs").onclick = () => activateStatsSubTab("logs");
    initLogsPane();
    bindStatsChartResize();
    // F/G1 全量弹窗：榜区双击一卡一窗（空态无数据不開窗）；关闭走 ✕/按钮/遮罩/Esc
    const ttftBarsEl = $("statsTtftBars");
    if (ttftBarsEl && !ttftBarsEl._rankDbl) {
      ttftBarsEl._rankDbl = true;
      ttftBarsEl.addEventListener("dblclick", () => openStatsRankModal("ttft"));
    }
    const tpsBarsEl = $("statsTpsBars");
    if (tpsBarsEl && !tpsBarsEl._rankDbl) {
      tpsBarsEl._rankDbl = true;
      tpsBarsEl.addEventListener("dblclick", () => openStatsRankModal("tps"));
    }
    const rankCloseBtn = $("statsRankCloseBtn");
    if (rankCloseBtn) rankCloseBtn.onclick = hideStatsRankModal;
    const rankCancelBtn = $("statsRankCancelBtn");
    if (rankCancelBtn) rankCancelBtn.onclick = hideStatsRankModal;
    const rankModal = $("statsRankModal");
    if (rankModal && !rankModal._rankWired) {
      rankModal._rankWired = true;
      rankModal.addEventListener("click", (e) => { if (e.target === rankModal) hideStatsRankModal(); });
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && rankModal.classList.contains("show")) hideStatsRankModal();
      });
    }
  }

  // 阶段 3：折线图画布宽=容器实测（renderStatsLineChart 内 statsChartWidth），容器宽度
  // 变化（窗口缩放 / 栏收展 / 栅格塌折）需按新宽重渲，否则旧宽 viewBox 被 CSS 等比拉伸、
  // 字号线宽失真。观察两个折线图容器，尺寸实变才防抖重渲（观察注册即有一帧回调）；
  // 趋势图高由宽按 760:220 派生（statsTrendChartHeight），宽变即高变，宽度单键即够。
  // 重渲瞬时落地（snap），不重播 reveal/morph。藏态量到 0 跳过——
  // 可见时的下一帧回调或既有取数渲染会按新尺寸补画。
  let statsChartResizeRO = null;
  function bindStatsChartResize() {
    if (statsChartResizeRO || typeof ResizeObserver !== "function") return;
    const lastSize = new Map();
    let timer = null;
    statsChartResizeRO = new ResizeObserver((entries) => {
      let changed = false;
      for (const en of entries) {
        const w = Math.round(en.contentRect.width);
        if (!w) continue; // 藏态（统计页未出）量到 0：不重渲
        if (lastSize.get(en.target.id) === w) continue;
        lastSize.set(en.target.id, w);
        changed = true;
      }
      if (!changed) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        if ($("statsView").hidden || statsSubTab !== "overview") return;
        statsTrendSnapOnce = true;
        try { renderStatsTrend(); } finally { statsTrendSnapOnce = false; }
        renderStatsTtft();
      }, 160);
    });
    for (const id of ["statsTrendChart", "statsTtftChart"]) {
      const el = $(id);
      if (el) statsChartResizeRO.observe(el);
    }
  }

  // 手动刷新的视觉反馈：按钮走 .btn:disabled 的 45% 变暗（与看板「重启」键、
  // skills 刷新键同源，暗着即「还没好」），持续到数据落地后各栏目生长动画
  // 播完才亮起。重播=进 tab 首渲同款：趋势图清屏 reveal 左至右生长（重置
  // statsTrendPrev）+ 用量环/柱状图一笔画生长（重置 statsUsageRevealed）；
  // TTFT 小图无动画参数（渲染器收到 undefined anim 直接画终态），随本次重渲
  // 自然刷新。等待串在刷新之后而不是与请求并行取最大值：reveal 只能在数据
  // 落地那次渲染起跑，从点击起算会让亮起早于动画收尾一个请求耗时。
  async function runStatsRefreshWithFeedback() {
    // 请求日志子 tab 激活时，同一颗键改驱动日志刷新（同款 disabled 变暗反馈）
    if (statsSubTab === "logs") return runLogsRefreshWithFeedback();
    const btn = $("statsRefreshBtn");
    if (btn.disabled) return;
    btn.disabled = true;
    try {
      await refreshStatsState({ replay: true });
      await new Promise((r) => setTimeout(r, STATS_MORPH_MS));
    } finally {
      btn.disabled = false;
    }
  }

  // 日志刷新的变暗反馈：暗着即「还没好」，连点被挡；无动画要等，数据落地即亮
  async function runLogsRefreshWithFeedback() {
    const btn = $("statsRefreshBtn");
    if (btn.disabled) return;
    btn.disabled = true;
    try {
      await loadLogs();
    } finally {
      btn.disabled = false;
    }
  }

  // 进入 tab 拉一次；停留期间 30s 轮询（页面隐藏时暂停，离开 tab 停止）
  function enterStatsView() {
    statsTrendPrev = null; // 进 tab 首张图走 reveal 揭示动画
    statsUsageRevealed = false; // 环形图揭示同理：每次进 tab 重播（与趋势图一致）
    loadStatsPrefs(); // 兜底：restoreView 可能先于 initStatsTab 到达
    // 子 tab 恢复：默认「总览」，存档为 logs 时激活请求日志。两侧子页各自负责
    // 自己的取数与渲染（总览=缓存热渲染+refreshStatsState，日志=enterLogsPane
    // 挂 5s 轮询，均见 activateStatsSubTab）——不可见的一侧不取数也不渲染，
    // 不会出现在日志子页前台时总览图表还在后台跑动画/重渲的情况。
    let statsSubTabSaved = "overview";
    try { if (localStorage.getItem("panel-stats-subtab") === "logs") statsSubTabSaved = "logs"; } catch {}
    const firstReady = activateStatsSubTab(statsSubTabSaved, { enter: true });
    if (!statsTimer) {
      statsTimer = setInterval(() => {
        if (document.hidden) return;
        if (statsSubTab !== "overview") return; // 日志子页前台：总览停取停渲
        refreshStatsState({ silent: true });
      }, 30000);
    }
    return firstReady;
  }

  function leaveStatsView() {
    if (statsTimer) { clearInterval(statsTimer); statsTimer = null; }
    leaveLogsPane(); // 请求日志子 tab 的 5s 轮询随统计页离开即停
    // 统一取消在飞动画 rAF：趋势 morph/reveal 与环形图揭示，离开 tab 后不再
    // 对着已隐藏的容器提交帧；进 tab 重播由 enterStatsView 重置标记负责。
    const chartEl = $("statsTrendChart");
    if (chartEl && chartEl._statsAnim) {
      cancelAnimationFrame(chartEl._statsAnim.raf);
      chartEl._statsAnim = null;
    }
    const donutEl = $("statsUsageDonut");
    if (donutEl && donutEl._usageRaf) {
      cancelAnimationFrame(donutEl._usageRaf);
      donutEl._usageRaf = null;
    }
  }

  async function refreshStatsState(opts) {
    const silent = !!(opts && opts.silent);
    const replay = !!(opts && opts.replay); // 手动刷新：数据落地后重播各栏目生长动画
    loadStatsPrefs(); // 兜底：restoreView 可能在 initStatsTab 之前触发首次取数
    const seq = ++statsReqSeq;
    const reqDays = statsPrefs.days; // 发起时刻的窗口；响应落地前用户可能又切了 seg
    try {
      const res = await api("GET", "/api/stats/state?days=" + reqDays);
      // 竞态守卫：非最新请求，或响应窗口已不是当前选择 → 丢弃（慢的旧响应
      // 后到会覆盖新选择的窗口数据）。days 由后端回显（clampStatDays）。
      if (seq !== statsReqSeq || res.days !== statsPrefs.days) return;
      statsData = res;
      // 重播标记必须在 renderStatsAll 之前重置：趋势图据此走 reveal 清屏生长
      // （否则沿用上一帧走 morph 形变），用量环据此重播一笔画揭示
      if (replay) { statsTrendPrev = null; statsUsageRevealed = false; }
      renderStatsAll();
    } catch (err) {
      if (seq !== statsReqSeq) return; // 已有更新请求在飞：旧失败不弹 toast
      if (!silent) toast(panelError(err, "使用统计加载失败"), true);
      if (!statsData) renderStatsAll(); // 首次失败：各卡渲染「暂无数据」空态
    }
  }

  function renderStatsAll() {
    // 不可见不渲染的硬闸：切走统计页（视图 hidden）或日志子页前台时，迟落地
    // 的在飞响应到这里丢弃——含图表 reveal/morph 的 rAF 也不会再起。回到可见
    // 时由 activateStatsSubTab 的进入路径补一次完整取数+渲染。
    if ($("statsView").hidden || statsSubTab !== "overview") return;
    renderStatsOverview();
    renderStatsHeatmap();
    renderStatsTrend();
    renderStatsUsage();
    renderStatsTtft();
    renderStatsTps();
    renderStatsEndpoints();
  }

  // ── 数字格式化 ──
  function statsFmtPct(v) { return v == null ? "—" : (v * 100).toFixed(1) + "%"; }
  function statsFmtTtft(ms) {
    if (ms == null) return "—";
    return ms >= 1000 ? (ms / 1000).toFixed(2) + "s" : Math.round(ms) + "ms";
  }
  function statsFmtHours(ms) {
    // 空值统一「—」（方案内已定展示格式，同 pct/ttft/int 口径）；0 工时是真实零值，仍 0h
    if (ms == null) return "—";
    if (!ms || ms <= 0) return "0h";
    const h = ms / 3600000;
    return (h >= 100 ? Math.round(h) : h.toFixed(1)) + "h";
  }
  function statsFmtInt(v) { return v == null ? "—" : Number(v).toLocaleString("en-US"); }

  // ── A：今日概览 ──
  function renderStatsOverview() {
    const ov = statsData && statsData.overview;
    const set = (id, txt) => { const el = $(id); if (el) el.textContent = txt; };
    if (!ov) {
      set("statsOvRequests", "—");
      set("statsOvTokens", "—");
      set("statsOvCache", "—");
      set("statsOvTtft", "—");
      set("statsOvSuccess", "—");
      return;
    }
    set("statsOvRequests", statsFmtInt(ov.requests));
    const total = (ov.prompt || 0) + (ov.completion || 0);
    set("statsOvTokens", formatTokensCn(total));
    set("statsOvCache", statsFmtPct(ov.cacheHitRate));
    set("statsOvTtft", statsFmtTtft(ov.avgTtftMs));
    set("statsOvSuccess", statsFmtPct(ov.successRate));
  }

  // ── B：每日 token 活动热力图（GitHub 贡献图式：列=周，行=周日~周六） ──
  // 排版：viewBox 随容器宽度整体缩放填格；月与月之间加 monthGap 分隔间隙，
  // 月份标签与其首个周列严格左对齐，标签用可读色（非弱灰小字）。
  function renderStatsHeatmap() {
    const el = $("statsHeatmap");
    if (!el) return;
    const days = statsData && Array.isArray(statsData.heatmap) ? statsData.heatmap : [];
    if (!days.length) { el.innerHTML = '<div class="empty-hint">暂无数据</div>'; return; }

    const cell = 14, gap = 4, step = cell + gap;
    const monthGap = 10;   // 月与月之间的额外分隔
    const padL = 22, padT = 18;
    const first = new Date(days[0].day + "T00:00:00");
    const offset = isNaN(first.getTime()) ? 0 : first.getDay(); // 0=周日
    const cols = Math.ceil((days.length + offset) / 7);

    // 逐列算 x：列首有效日的月份与上一列不同 → 该列前加 monthGap 并挂月份标签
    const colX = [];
    const parts = [];
    let x = padL, prevMonth = null;
    for (let c = 0; c < cols; c++) {
      let m = null;
      for (let r = 0; r < 7; r++) {
        const i = c * 7 + r - offset;
        if (i >= 0 && i < days.length && days[i].day) { m = days[i].day.slice(0, 7); break; }
      }
      if (m && prevMonth !== null && m !== prevMonth) x += monthGap;
      if (m && m !== prevMonth) {
        parts.push(`<text class="stats-heat-month" x="${x}" y="11">${Number(m.slice(5))}月</text>`);
        prevMonth = m;
      }
      colX.push(x);
      x += step;
    }
    const W = x - gap;
    const H = padT + 7 * step - gap;

    const maxT = days.reduce((m, d) => Math.max(m, d.tokens || 0), 0);
    // 5 档色深：0=空色；>0 按当日值/90 天最大值的线性相对比例分 1~4 档
    // （旧对数分位把同一数量级内的值全压进顶格 lv4，热力拉不开档差；
    // 档位色由 --heat-* token 阶梯渲染，主题可覆盖 token 做差分）
    const level = (t) => {
      if (!t || t <= 0 || maxT <= 0) return 0;
      return Math.max(1, Math.min(4, Math.ceil((t / maxT) * 4)));
    };

    // 左侧行标签（只标 一/三/五 避免拥挤）
    const DOW = ["日", "一", "二", "三", "四", "五", "六"];
    for (let r = 0; r < 7; r++) {
      if (r !== 1 && r !== 3 && r !== 5) continue;
      parts.push(`<text class="stats-heat-text" x="0" y="${padT + r * step + cell - 3}">${DOW[r]}</text>`);
    }
    for (let i = 0; i < days.length; i++) {
      const d = days[i];
      const col = Math.floor((i + offset) / 7);
      const row = (i + offset) % 7;
      const lv = level(d.tokens);
      const title = `${(d.day || "").slice(5)} · ${d.requests || 0} 次请求 · ${formatTokensCn(d.tokens)} tokens`;
      parts.push(
        `<rect class="stats-heat-cell lv${lv}" x="${colX[col]}" y="${padT + row * step}" width="${cell}" height="${cell}" rx="2"><title>${title}</title></rect>`);
    }
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="每日 Token 活动热力图">${parts.join("")}</svg>`;
  }

  // ── 手写 SVG 多线图（单调三次 Hermite 平滑，hover 十字线 + tooltip） ──
  function statsNiceMax(v) {
    if (v <= 0) return 1;
    const pow = Math.pow(10, Math.floor(Math.log10(v)));
    const n = v / pow;
    // 密档取整：旧档 {1,2,2.5,5,10} 档距过大，n 略超 2.5 即跳到 5，曲线峰值只占
    // 纵轴 ~50%。密档下档间最大余量 25%（如 n 刚过 2 取 2.5），峰值利用率 ≥80%。
    const STEPS = [1, 1.2, 1.5, 1.8, 2, 2.5, 3, 3.5, 4, 5, 6, 7, 8, 10];
    for (const s of STEPS) if (n <= s) return s * pow;
    return 10 * pow;
  }

  function statsSmoothPath(pts, clampY) {
    const n = pts.length;
    if (!n) return "";
    // 单调三次 Hermite（Fritsch–Carlson 切线）替代 Catmull-Rom：原实现在「零段→首个非零桶」
    // 节点两侧切线不等——入射段控制点过冲越界被硬钳回基线（入场斜率 0），出射段仍以
    // (后点−前点)/6 的全斜率起步，钳制处即肉眼可见的折角。改按相邻割线定切线：割线异号
    // 或任一为 0（局部极值、零基线/平台边界）→ 切线取 0，曲线水平离地再缓升；同号取加权
    // 调和平均，其绝对值 ≤2·min(|割线|)，故段内不过冲 ⇒ 越界钳制退化为纯兜底、不再造突变。
    const cl = (y) => (clampY ? Math.max(clampY.minY, Math.min(clampY.maxY, y)) : y);
    const tan = new Array(n).fill(0);
    if (n > 1) {
      const sec = new Array(n - 1);
      for (let i = 0; i < n - 1; i++) {
        const dx = pts[i + 1].x - pts[i].x;
        sec[i] = dx ? (pts[i + 1].y - pts[i].y) / dx : 0;
      }
      tan[0] = sec[0];
      tan[n - 1] = sec[n - 2];
      for (let i = 1; i < n - 1; i++) {
        const a = sec[i - 1], b = sec[i];
        if (!(a * b > 0)) continue;
        const h0 = pts[i].x - pts[i - 1].x, h1 = pts[i + 1].x - pts[i].x;
        tan[i] = ((h0 + h1) * a * b) / (h1 * a + h0 * b);
      }
    }
    let d = `M${pts[0].x.toFixed(1)},${pts[0].y.toFixed(1)}`;
    for (let i = 0; i < n - 1; i++) {
      const dx = (pts[i + 1].x - pts[i].x) / 3;
      const c1y = cl(pts[i].y + dx * tan[i]);
      const c2y = cl(pts[i + 1].y - dx * tan[i + 1]);
      d += ` C${(pts[i].x + dx).toFixed(1)},${c1y.toFixed(1)} `
        + `${(pts[i + 1].x - dx).toFixed(1)},${c2y.toFixed(1)} `
        + `${pts[i + 1].x.toFixed(1)},${pts[i + 1].y.toFixed(1)}`;
    }
    return d;
  }

  // cubic-bezier(x1,y1,x2,y2) 缓动求解（Newton–Raphson + 二分兜底），供 morph 使用
  function statsCubicBezier(x1, y1, x2, y2) {
    const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
    const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
    const sx = (t) => ((ax * t + bx) * t + cx) * t;
    const sy = (t) => ((ay * t + by) * t + cy) * t;
    const sdx = (t) => (3 * ax * t + 2 * bx) * t + cx;
    return (x) => {
      let t = x;
      for (let i = 0; i < 8; i++) {
        const err = sx(t) - x;
        if (Math.abs(err) < 1e-6) return sy(t);
        const d = sdx(t);
        if (Math.abs(d) < 1e-6) break;
        t -= err / d;
      }
      let lo = 0, hi = 1;
      t = x;
      while (hi - lo > 1e-6) {
        if (sx(t) > x) hi = t; else lo = t;
        t = (lo + hi) / 2;
      }
      return sy(t);
    };
  }

  // dash 生长期间保留用户自定义虚线图案（recharts 3 Ve 直译）：图案按已画弧长 u 交错
  // 铺开——整周期重复 floor(u/周期) 次，边界处截断到余数，尾部用超长 gap 兜住未画部分。
  // pattern 为原始 dash 串解析出的数组（如 "5,3" → [5,3]），奇数长度补 0 对齐 dash/gap 交替。
  function statsDashPattern(u, D, pattern) {
    const period = pattern.reduce((a, b) => a + b, 0);
    if (!period) return `${u}px ${D}px`;
    const full = Math.floor(u / period);
    const rem = u % period;
    const partial = [];
    let cum = 0;
    for (let i = 0; i < pattern.length; i++) {
      const v = pattern[i];
      if (v != null && cum + v > rem) { partial.push(...pattern.slice(0, i), rem - cum); break; }
      cum += v;
    }
    const pat = pattern.length % 2 === 0 ? pattern : [...pattern, 0];
    const grow = [];
    for (let k = 0; k < full; k++) grow.push(...pat);
    const suffix = (grow.length + partial.length) % 2 === 0 ? [0, D] : [D];
    return [...grow, ...partial, ...suffix].map((v) => `${v}px`).join(", ");
  }

  // morph 参数对齐 ZCode 趋势图（recharts 3 Line 默认）：1500ms + 'ease'
  const STATS_MORPH_MS = 1500;
  const STATS_MORPH_EASE = statsCubicBezier(0.25, 0.1, 0.25, 1);

  // cfg: { labels, series:[{key,label,color,dash,values:[n|null]}], fmt(v), min?, max?, height? }
  // anim: null | { type:"reveal" } | { type:"morph" }
  //   reveal = stroke-dasharray 沿弧长生长（recharts 3 Line 首绘机制）：曲线按终态一次
  //            画好，dash 段从 0 长到 getTotalLength()——笔迹贴曲线走向从左画到右，
  //            1500ms + 'ease' 与 morph 同参数；虚线系列生长期间图案交错保留（Ve 同款）；
  //   morph  = 逐帧插值各系列点的【像素坐标】并重生成路径（1500ms，recharts 'ease'），
  //            基线取在飞动画中间帧或上次提交的像素帧（recharts 3 Line 同款机制）：
  //            桶数变化按索引比例映射 floor(j*旧点数/新点数)，新出现的 key 从 0 线升起，
  //            消失的 key 由调用方不传入即自然不出现；yMax/点距变化随像素插值平滑过渡。
  //   动画进行中再次渲染：取消在飞 rAF，以其中间帧为新 morph 的起点，不闪跳；
  //   reveal 半途被 morph 接管：dash 从已画弧长连续起步、沿用 reveal 原时钟在
  //   原剩余时间内归一续推到全显（速度与不被打断一致、总时长不变），与点插值
  //   并行，不回卷重画。
  function renderStatsLineChart(container, cfg, anim) {
    // 同终点守卫：morph 进行中若新内容与在飞动画的目标完全一致（seg 重击当前 tab、
    // 30s 轮询数据未变、手动刷新返回同值），整体跳过本次渲染——在飞动画按原时序播完，
    // 不重启时间轴（否则曲线顿住后以完整时长慢速重播剩余距离）。签名只看渲染输出
    // （轴刻度 + 系列键/色/虚线/值 + 画布宽），与数据来源无关。
    if (container._statsAnim && container._statsAnim.raf) {
      if (container._statsAnim.targetSig === renderStatsTrendSignature(cfg, statsChartWidth(container))) return;
    }
    // 基线优先级：在飞动画的中间像素帧 > 上次提交的像素帧
    const prevAnim = container._statsAnim || null;
    const baseline = (prevAnim && prevAnim.current) || container._statsCommit || null;
    if (prevAnim) { cancelAnimationFrame(prevAnim.raf); container._statsAnim = null; }
    container.textContent = "";
    // 阶段 3：viewBox 宽按容器实测（1:1 映射像素，字号/线宽不随窗口缩放失真——与
    // sparkline 同手法），取代写死的 760；容器藏态量到 0 时回落 760
    const W = statsChartWidth(container), H = cfg.height || 220;
    const padL = 46, padR = 12, padT = 10, padB = 22;
    const iw = W - padL - padR, ih = H - padT - padB;
    const n = cfg.labels.length;
    let maxV = 0;
    for (const s of cfg.series) for (const v of s.values) if (v != null && v > maxV) maxV = v;
    const yMax = cfg.max != null ? cfg.max : statsNiceMax(maxV);
    const yMin = cfg.min != null ? cfg.min : 0;
    const range = (yMax - yMin) || 1;
    const X = (i) => padL + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw);
    const Y = (v) => padT + ih - ((v - yMin) / range) * ih;

    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    if (cfg.ariaLabel) {
      svg.setAttribute("role", "img");
      svg.setAttribute("aria-label", cfg.ariaLabel);
    }
    // Y 轴网格线 + 刻度（自适应）
    for (let g = 0; g <= 4; g++) {
      const v = yMin + (range * g) / 4;
      const y = Y(v);
      const line = document.createElementNS(NS, "line");
      line.setAttribute("x1", padL); line.setAttribute("x2", W - padR);
      line.setAttribute("y1", y); line.setAttribute("y2", y);
      line.setAttribute("class", "stats-grid-line");
      svg.appendChild(line);
      const t = document.createElementNS(NS, "text");
      t.setAttribute("x", padL - 6); t.setAttribute("y", y + 3);
      t.setAttribute("text-anchor", "end");
      t.setAttribute("class", "stats-axis-text");
      t.textContent = cfg.fmt(v);
      svg.appendChild(t);
    }
    // X 轴日期刻度（稀疏标注）
    const stepX = Math.max(1, Math.ceil(n / 6));
    for (let i = 0; i < n; i += stepX) {
      const t = document.createElementNS(NS, "text");
      t.setAttribute("x", X(i)); t.setAttribute("y", H - 6);
      t.setAttribute("text-anchor", "middle");
      t.setAttribute("class", "stats-axis-text");
      t.textContent = (cfg.labels[i] || "").slice(5);
      svg.appendChild(t);
    }
    // 各系列平滑路径（null 断点拆段）；并记录每段的桶索引，
    // morph 动画每帧按插值结果重生成路径，reveal 动画按段弧长接力画 dash
    const seriesG = document.createElementNS(NS, "g");
    const seriesRecs = [];
    for (const s of cfg.series) {
      const rec = { s, segs: [] };
      let run = [];
      const flush = () => {
        if (!run.length) return;
        const p = document.createElementNS(NS, "path");
        p.setAttribute("d", statsSmoothPath(run.map((i) => ({ x: X(i), y: Y(s.values[i]) })), { minY: padT, maxY: padT + ih }));
        p.setAttribute("fill", "none");
        p.setAttribute("stroke", s.color);
        p.setAttribute("stroke-width", "2");
        p.setAttribute("stroke-linecap", "round");
        if (s.dash) p.setAttribute("stroke-dasharray", s.dash);
        seriesG.appendChild(p);
        rec.segs.push({ el: p, idxs: run });
        run = [];
      };
      for (let i = 0; i < n; i++) {
        if (s.values[i] == null) flush();
        else run.push(i);
      }
      flush();
      seriesRecs.push(rec);
    }
    svg.appendChild(seriesG);

  // ── 动画 ──
  // 渲染输出签名：画布宽 + 轴刻度 + 各系列 key/色/虚线/值。同终点守卫用它判断在飞
  // 动画的目标是否与本次请求渲染的内容一致（与数据来源/调用方无关）。宽入签：阶段 3
  // 起 viewBox 宽随容器实测，resize 重渲（同数据不同宽）不被守卫误跳。
  function renderStatsTrendSignature(cfg, w) {
    return JSON.stringify([
      w, cfg.labels, cfg.min, cfg.max, cfg.height,
      cfg.series.map((s) => [s.key, s.color, s.dash || "", s.values]),
    ]);
  }
  // 折线图画布宽：容器实测（下限 280，藏态量到 0 回落 760——同阶段 3 前的固定宽）
  function statsChartWidth(container) {
    const w = Math.round(container.clientWidth);
    return w > 0 ? Math.max(280, w) : 760;
  }
  const reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    // 提交/在飞状态一律记像素帧：Map<key, [{x,y}|null]>。记像素而非值，跨桶数/yMax
    // 变化时旧帧位置就是曲线上次真实的视觉位置，morph 直接对其插值即可平滑滑动。
    const pixelsOf = (s) => s.values.map((v, j) => (v == null ? null : { x: X(j), y: Y(v) }));
    const commitPixels = () => new Map(cfg.series.map((s) => [s.key, pixelsOf(s)]));
    const finishAnim = (state) => {
      if (container._statsAnim === state) container._statsAnim = null;
      container._statsCommit = commitPixels();
    };
    // 目标签名挂到动画状态上：同终点守卫据此识别"内容未变"的重渲
    const animSig = renderStatsTrendSignature(cfg, W);
    // 弧长测量/上色工具（reveal 与 morph 的 dash 续接共用）：getTotalLength 需元素
    // 已挂 DOM，故都在首帧 rAF（渲染函数同步段已 appendChild）里惰性调用。
    const statsParseDash = (s) => s.split(/[,\s]+/).map((v) => parseFloat(v)).filter((v) => Number.isFinite(v));
    const measureSegs = (rec) => {
      const items = [];
      let total = 0;
      for (const seg of rec.segs) {
        let D = 0;
        try { D = seg.el.getTotalLength() || 0; } catch { D = 0; }
        items.push({ seg, D, pre: total });
        total += D;
      }
      return { rec, items, total };
    };
    // 全局进度 u（系列内一支笔）按前缀弧长落到各段：前段画满、当前段截断、后段为 0
    const paintSegs = (plan, u) => {
      const pat = plan.rec.s.dash ? statsParseDash(plan.rec.s.dash) : null;
      for (const it of plan.items) {
        if (!it.D) continue;
        const su = Math.max(0, Math.min(it.D, u - it.pre));
        it.seg.el.setAttribute("stroke-dasharray", pat
          ? statsDashPattern(su, it.D, pat)
          : `${su.toFixed(1)}px ${it.D.toFixed(1)}px`);
      }
    };
    const restoreSegs = (plan) => {
      for (const it of plan.items) {
        if (plan.rec.s.dash) it.seg.el.setAttribute("stroke-dasharray", plan.rec.s.dash);
        else it.seg.el.removeAttribute("stroke-dasharray");
      }
    };
    if (!reduceMotion && anim && anim.type === "reveal") {
      // recharts 3 Line 首绘机制：曲线按终态一次画好，dash 段从 0 沿弧长生长到总长——
      // 笔迹贴曲线走向从左画到右（非 clip 垂直边擦除），1500ms + 'ease' 与 morph 同参数。
      // 挂载前先置零长 dash 防整图闪现一帧，弧长首帧 rAF 再测。
      for (const rec of seriesRecs) for (const seg of rec.segs) seg.el.setAttribute("stroke-dasharray", "0px 100000px");
      const plans = seriesRecs.map((rec) => ({ rec, items: [], total: 0 }));
      let measured = false;
      // grown：各系列已画弧长，被 morph 接管时作续接成员判定（终态像素帧另记在 current）；
      // t0 记上 state：接管时 dash 续推沿用本时钟（见 morph 分支 dashT0）
      const state = { raf: 0, current: commitPixels(), grown: new Map(), targetSig: animSig, t0: performance.now() };
      const tick = (t) => {
        if (!measured) {
          for (const pl of plans) { const m = measureSegs(pl.rec); pl.items = m.items; pl.total = m.total; }
          measured = true;
        }
        const p = Math.min(1, (t - state.t0) / STATS_MORPH_MS);
        const e = STATS_MORPH_EASE(p);
        for (const plan of plans) {
          if (!plan.total) continue;
          const u = plan.total * e;
          state.grown.set(plan.rec.s.key, u);
          paintSegs(plan, u);
        }
        if (p < 1) state.raf = requestAnimationFrame(tick);
        else { for (const plan of plans) restoreSegs(plan); finishAnim(state); }
      };
      state.raf = requestAnimationFrame(tick);
      container._statsAnim = state;
    } else if (!reduceMotion && anim && anim.type === "morph" && baseline) {
      // t0=自身点插值时钟；dashT0=dash 续接时钟，沿接管链一路继承最初 reveal 的
      // 时钟（链外取自身 t0）；grown=dash 续接系列当前已画弧长，本 morph 再被接管
      // 时作续接成员判定（reveal→morph→morph 链式续推不断链）
      const t0 = performance.now();
      const dashT0 = (prevAnim && (prevAnim.dashT0 ?? prevAnim.t0)) ?? t0;
      // eStart：接管点在原时钟上的缓动进度，续推对剩余段以此为零点归一（见 tick）
      const eStart = STATS_MORPH_EASE(Math.min(1, (t0 - dashT0) / STATS_MORPH_MS));
      const state = { raf: 0, current: null, targetSig: animSig, t0, dashT0, grown: new Map() };
      const zeroY = padT + ih; // 0 线像素（yMin 恒为区间下界）
      const recs = seriesRecs.map((rec) => {
        const dense = rec.s.values.every((v) => v != null) && rec.segs.length > 0;
        const prevPts = baseline.get(rec.s.key) || null;
        // 起点像素：有旧帧按索引比例映射（recharts: floor(j*旧点数/新点数)），
        // 旧帧该位为 null（断点）或无旧帧（新系列/新口径）→ 从新 x 位置的 0 线升起
        const start = dense
          ? rec.s.values.map((_, j) => {
              const src = prevPts && prevPts.length
                ? prevPts[Math.min(prevPts.length - 1, Math.floor((j * prevPts.length) / n))]
                : null;
              return src || { x: X(j), y: zeroY };
            })
          : null;
        return { rec, dense, start };
      });
      // dash 续接成员判定：原动画仍在生长的系列（已画弧长 < 新曲线总长）才续推；
      // 弧长须在首帧 rAF 惰性测（此时 svg 已 appendChild，getTotalLength 才可靠）
      const prevgrown = (prevAnim && prevAnim.grown) || null;
      let dashCarry = null;
      const tick = (t) => {
        if (!dashCarry) {
          dashCarry = seriesRecs.map(measureSegs).filter((pl) => {
            const k = prevgrown && prevgrown.get(pl.rec.s.key);
            return pl.total > 0 && k != null && k < pl.total;
          });
        }
        const p = Math.min(1, (t - t0) / STATS_MORPH_MS);
        const e = STATS_MORPH_EASE(p);
        // dash 续推：从接管点已画弧长 k 连续起步，沿用 dashT0 原时钟，剩余弧长在
        // 原时钟剩余时间内按缓动尾部归一播完——位置与速度都连续（新旧曲线弧长
        // 差异仅体现为同比缩放）、总时长不变、不重启；播满即还原静态 dash
        const pDash = Math.min(1, (t - dashT0) / STATS_MORPH_MS);
        for (const pl of dashCarry) {
          const k = prevgrown.get(pl.rec.s.key);
          const u = eStart >= 1 ? pl.total
            : k + (pl.total - k) * (STATS_MORPH_EASE(pDash) - eStart) / (1 - eStart);
          state.grown.set(pl.rec.s.key, u);
          paintSegs(pl, u);
          if (pDash >= 1) restoreSegs(pl);
        }
        const current = new Map();
        for (const { rec, dense, start } of recs) {
          if (!dense) { current.set(rec.s.key, pixelsOf(rec.s)); continue; }
          const cur = rec.s.values.map((v, j) => ({
            x: start[j].x + (X(j) - start[j].x) * e,
            y: start[j].y + (Y(v) - start[j].y) * e,
          }));
          current.set(rec.s.key, cur);
          for (const seg of rec.segs) {
            seg.el.setAttribute("d", statsSmoothPath(seg.idxs.map((ix) => cur[ix]), { minY: padT, maxY: padT + ih }));
          }
        }
        state.current = current;
        if (p < 1) state.raf = requestAnimationFrame(tick);
        else finishAnim(state);
      };
      state.raf = requestAnimationFrame(tick);
      container._statsAnim = state;
    } else {
      container._statsCommit = commitPixels();
    }
    // hover 十字线 + 数据点 + tooltip
    const cross = document.createElementNS(NS, "line");
    cross.setAttribute("class", "stats-crosshair");
    cross.setAttribute("y1", padT); cross.setAttribute("y2", H - padB);
    cross.style.display = "none";
    svg.appendChild(cross);
    const dots = cfg.series.map((s) => {
      const c = document.createElementNS(NS, "circle");
      c.setAttribute("r", "3.5");
      c.setAttribute("fill", s.color);
      c.setAttribute("stroke", "var(--surface)");
      c.setAttribute("stroke-width", "1.5");
      c.style.display = "none";
      svg.appendChild(c);
      return c;
    });
    const overlay = document.createElementNS(NS, "rect");
    overlay.setAttribute("x", padL); overlay.setAttribute("y", padT);
    overlay.setAttribute("width", iw); overlay.setAttribute("height", ih);
    overlay.setAttribute("fill", "transparent");
    svg.appendChild(overlay);

    const tip = document.createElement("div");
    tip.className = "stats-tooltip";
    container.appendChild(svg);
    container.appendChild(tip);

    overlay.addEventListener("mousemove", (e) => {
      if (n < 1) return;
      // 动画进行中：曲线还在像素插值的中间帧，而这里的十字线/圆点/tooltip 按【终态】
      // 坐标画，两者肉眼错位 → 动画期间干脆隐藏 hover 件，结束后下一次 move 恢复。
      if (container._statsAnim) {
        cross.style.display = "none";
        dots.forEach((d) => { d.style.display = "none"; });
        tip.style.display = "none";
        return;
      }
      const rect = svg.getBoundingClientRect();
      if (!rect.width) return;
      const px = ((e.clientX - rect.left) / rect.width) * W;
      let idx = n <= 1 ? 0 : Math.round(((px - padL) / iw) * (n - 1));
      idx = Math.max(0, Math.min(n - 1, idx));
      cross.setAttribute("x1", X(idx)); cross.setAttribute("x2", X(idx));
      cross.style.display = "";
      let html = `<div class="stt-day">${cfg.labels[idx] || ""}</div>`;
      cfg.series.forEach((s, si) => {
        const v = s.values[idx];
        if (v == null) { dots[si].style.display = "none"; return; }
        dots[si].setAttribute("cx", X(idx)); dots[si].setAttribute("cy", Y(v));
        dots[si].style.display = "";
        html += `<div><span style="color:${s.color}">●</span> ${s.label}：${cfg.fmt(v)}</div>`;
      });
      tip.innerHTML = html;
      tip.style.display = "block";
      const crect = container.getBoundingClientRect();
      const fx = (X(idx) / W) * rect.width + (rect.left - crect.left);
      const tw = tip.offsetWidth || 120;
      tip.style.left = Math.max(0, Math.min(crect.width - tw - 4, fx + 14)) + "px";
    });
    overlay.addEventListener("mouseleave", () => {
      cross.style.display = "none";
      dots.forEach((d) => { d.style.display = "none"; });
      tip.style.display = "none";
    });
  }

  // 趋势图画布高：恢复阶段3前的宽高联动——设计比例 760:220（彼时 viewBox 760×220
  // 经 CSS width:100%/height:auto 随卡宽等比缩放，宽窗口下图自然填满被网格拉伸的
  // 卡体）。阶段3把 viewBox 宽改按容器实测（1:1 像素、字号线宽不缩放）后高度被钉死
  // 220，联动断裂、卡下半截悬空（v1/v2 同发）；此处按同比例由宽派生高，与
  // statsChartWidth 同下限同藏态回落（undefined→220 基线），v1/v2 同效。外层作用域
  // 声明：调用点在 renderStatsTrend（renderStatsLineChart 之外），嵌套声明会让调用处
  // 直接 ReferenceError、整图中止渲染（POLISH02 事故根因）。
  function statsTrendChartHeight(el) {
    const w = Math.round(el.clientWidth);
    if (!w) return undefined;
    return Math.max(160, Math.round((220 * Math.max(280, w)) / 760));
  }

  // ── C：Token 趋势（口径由 seg 驱动；时间范围变化时整表重新拉取） ──
  // 桶起点毫秒时间戳 → 轴标签：近 24h 用 "HH:00"，近 7 日 用 "M/D HH:00"
  function statsFmtBucketLabel(ts) {
    const d = new Date(ts);
    const hh = String(d.getHours()).padStart(2, "0") + ":00";
    return statsPrefs.days === 1 ? hh : `${d.getMonth() + 1}/${d.getDate()} ${hh}`;
  }

  function renderStatsTrend() {
    const chartEl = $("statsTrendChart");
    const legendEl = $("statsTrendLegend");
    if (!chartEl || !legendEl) return;
    const tr = statsData && statsData.trends && statsData.trends[statsPrefs.scope];
    const buckets = tr && Array.isArray(tr.buckets) ? tr.buckets : [];
    const raw = tr && Array.isArray(tr.series) ? tr.series : [];
    const pick = (s) => {
      const p = Array.isArray(s.prompt) ? s.prompt : [];
      const c = Array.isArray(s.completion) ? s.completion : [];
      return buckets.map((_, i) => (p[i] || 0) + (c[i] || 0)); // 合计 = prompt + completion
    };
    const has = raw.some((s) => pick(s).some((v) => v > 0));
    if (!has) {
      if (chartEl._statsAnim) { cancelAnimationFrame(chartEl._statsAnim.raf); chartEl._statsAnim = null; }
      chartEl._statsCommit = null;
      chartEl.innerHTML = '<div class="empty-hint">暂无数据</div>';
      legendEl.textContent = "";
      statsTrendPrev = null; // 空态后首张图重新走揭示动画
      return;
    }
    // 上色 + 图例（__other__ 固定灰色虚线「其他」；按端点口径显示端点名）
    const epLabel = (s) =>
      statsPrefs.scope === "endpoint" && s.key !== "__other__" ? statsEndpointLabel(s.key) : (s.label || s.key);
    const colored = raw.map((s, i) => {
      const st = s.key === "__other__" ? STATS_OTHER_STYLE : STATS_PALETTE[i % STATS_PALETTE.length];
      return { key: s.key, label: epLabel(s), color: st.color, dash: st.dash, values: pick(s) };
    });
    const hidden = statsLegendHidden[statsPrefs.scope];
    // prune：数据里已消失的 key 从隐藏集清掉（只增不减会永久残留已下线的渠道/模型）
    const liveKeys = new Set(colored.map((s) => s.key));
    let pruned = false;
    for (const k of [...hidden]) if (!liveKeys.has(k)) { hidden.delete(k); pruned = true; }
    if (pruned) saveStatsLegend();
    const visible = colored.filter((s) => !hidden.has(s.key));
    // 动画决策：无上一帧（进 tab 首张/空态恢复/切口径——scope seg 点击已重置标记）
    // → reveal 清屏左至右生长；此后一律 morph 平滑形变（图例显隐/轮询微调，以及
    // 桶数变化的 24h↔7日 切换——跨桶数由渲染器按索引比例映射做像素插值，
    // 曲线被"拉伸揉捏"成新形状而非擦掉重画）；statsTrendSnapOnce（resize 重渲）不播
    // 动画直落终态
    const anim = statsTrendSnapOnce ? null : statsTrendPrev ? { type: "morph" } : { type: "reveal" };
    renderStatsLineChart(chartEl, {
      labels: buckets.map((t) => statsFmtBucketLabel(t)),
      series: visible,
      fmt: (v) => formatTokensCn(Math.round(v)),
      ariaLabel: "Token 趋势图",
      height: statsTrendChartHeight(chartEl),
    }, anim);
    statsTrendPrev = true;
    legendEl.textContent = "";
    colored.forEach((s) => {
      // button 而非 span：图例项可点击，需进 tab 序（焦点 + 回车触发），样式由
      // .stats-legend-item 的 button reset 保持与原 span 一致
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "stats-legend-item" + (hidden.has(s.key) ? " off" : "");
      chip.title = "点击显隐该系列";
      const dot = document.createElement("i");
      dot.className = "stats-legend-dot";
      dot.style.background = s.color;
      chip.appendChild(dot);
      const lab = document.createElement("span");
      lab.textContent = s.label;
      chip.appendChild(lab);
      chip.onclick = () => {
        if (hidden.has(s.key)) hidden.delete(s.key); else hidden.add(s.key);
        saveStatsLegend();
        renderStatsTrend();
      };
      legendEl.appendChild(chip);
    });
  }

  // ── 横向条通用渲染 ──
  // 填充上限 85%：最长条不顶到轨道右端，留出呼吸余量
  const STATS_BAR_FILL_MAX = 85;
  function statsRenderBars(el, rows, opts) {
    // rows: [{label, value(0-1 之外任意正数), valText, ok?, rank?}]
    // rank!=null 时首列渲染排名序号（复用看板状态检测卡 .ms-rank/.top，
    // 仅第 1 名挂 .top 走 accent 色，不新造渐变）；
    // opts.placeholders>0 时尾部补虚线占位行（固定榜单行数，配合双卡等高）。
    // 注意：容器是 grid 四列（序号 max-content / 标签 38% / 轨道 1fr / 数值
    // max-content），调用方须保证要么每行都带 rank、要么都不带，否则错列。
    el.textContent = "";
    el.classList.add("stats-bars"); // grid 四列共享列宽，各行轨道右端对齐
    const maxV = rows.reduce((m, r) => Math.max(m, r.value || 0), 0) || 1;
    rows.forEach((r) => {
      const row = document.createElement("div");
      row.className = "stats-bar-row";
      if (r.rank != null) row.appendChild(statsRankEl(r.rank));
      const lab = document.createElement("span");
      lab.className = "stats-bar-label";
      lab.textContent = r.label;
      lab.title = r.label;
      const track = document.createElement("span");
      track.className = "stats-bar-track";
      const fill = document.createElement("span");
      fill.className = "stats-bar-fill" + (r.ok ? " ok" : "");
      fill.style.width = Math.max(0, Math.min(STATS_BAR_FILL_MAX, ((r.value || 0) / maxV) * STATS_BAR_FILL_MAX)).toFixed(1) + "%";
      track.appendChild(fill);
      const val = document.createElement("span");
      val.className = "stats-bar-val";
      val.textContent = r.valText;
      row.appendChild(lab); row.appendChild(track); row.appendChild(val);
      el.appendChild(row);
    });
    const ph = opts && opts.placeholders > 0 ? Math.floor(opts.placeholders) : 0;
    for (let i = 0; i < ph; i += 1) {
      const d = document.createElement("div");
      d.className = "stats-bar-placeholder";
      el.appendChild(d);
    }
  }

  // 排名序号小件（TTFT/TPS 卡内榜与全量弹窗同构）：复用看板状态检测卡
  // .ms-rank/.top（10px mono 灰字，仅第 1 名 accent 色），不新造渐变。
  // 「仅第 1 名」与看板状态检测卡同构——那边是 idx === 0 挂 .top。
  function statsRankEl(n) {
    const rk = document.createElement("span");
    rk.className = "ms-rank" + (n === 1 ? " top" : "");
    rk.textContent = String(n);
    return rk;
  }

  // ── H：模型用量（两栏：左=环形图 zcode 版式 + 图例榜，右=同色生长柱状图） ──
  // 数据源 statsData.usage[usageDays][usageDim]（channel=providerId / model=
  // 裸模型名跨渠道合并），后端已排好序并合并 Top5 之外的「其他」；时间窗口由
  // 本卡 seg 独立选择（近 24h/近 7 日），两个窗口的数据随每次响应一起下发。环形图手绘 SVG：
  // 每段一个 circle stroke-dasharray，沿 -90° 顺时针累积偏移，段间留隙；
  // 环心两行=窗口总 tokens + 单位词。图例点击显隐该节点（环与柱状图联动）。
  const STATS_USAGE_OTHER_KEY = "__other__"; // 与后端 usage.nodes 的「其他」节点 key 对齐
  // 环形几何：viewBox 坐标，半径/线宽留出 hover 提亮余量；间隙用角度近似（约 1.2°）
  const STATS_USAGE_R = 84;
  const STATS_USAGE_STROKE = 26;
  const STATS_USAGE_GAP = 3; // dash 缺口(px)，近似段间留白
  let statsUsageRevealed = false; // 进 tab 首渲播揭示动画；enterStatsView 重置 → 每次进 tab 重播

  function statsUsagePctText(p) {
    return p >= 0.1 ? Math.round(p * 100) + "%" : (p * 100).toFixed(1) + "%";
  }

  // 揭示动画触发语义：进 tab 首渲（enterStatsView 重置标记）、切换本卡的
  // 粒度/时间 seg（opts.replay）、手动刷新（refreshStatsState 重置标记）时播一次；
  // reduced-motion 永远跳过。图例显隐与 30s 轮询走静默重渲（reveal=0 → 环与柱状图直接画满）。
  function revealNow(replay) {
    const reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const reveal = (replay || !statsUsageRevealed) && !reduceMotion;
    statsUsageRevealed = true;
    return reveal;
  }

  function renderStatsUsage(opts) {
    const donutEl = $("statsUsageDonut");
    const legendEl = $("statsUsageLegend");
    const barsEl = $("statsUsageBars");
    if (!donutEl || !legendEl || !barsEl) return;

    const force = !!(opts && opts.force); // 图例显隐点击：揭示进行中也立即重渲
    const replay = !!(opts && opts.replay); // 本卡 seg 点击：揭示进行中也立即重渲并重播
    // 揭示动画进行中（进 tab 预渲触发）只挡静默重渲，否则 30s 轮询/刚落地的
    // fetch 响应会在揭示刚起步时把它掐断，环瞬间跳满，动画观感被破坏；
    // 用户主动操作（seg/图例）始终放行——下方重渲会先取消在飞 rAF 再重建。
    if (!force && !replay && donutEl._usageRaf) return;

    const dim = statsPrefs.usageDim;
    // 双窗口：后端每次响应都带 usage["1"]/["7"]（近 24h/近 7 日），本卡时间 seg
    // 独立于趋势卡的全局 days seg，切换只本地重渲不重新取数。
    const winKey = String(statsPrefs.usageDays);
    const winUsage = statsData && statsData.usage ? statsData.usage[winKey] : null;
    // 窗口对象是 {channel,endpoint,model}，再按当前粒度 dim 下钻一层才是环数据
    const usage = winUsage && winUsage[dim] ? winUsage[dim] : null;
    const allNodes = usage && Array.isArray(usage.nodes) ? usage.nodes : [];
    const total = usage ? usage.total || 0 : 0;
    // 端点口径显示端点名（与趋势图按端点口径一致），其余粒度用后端 label
    const nodeLabel = (n) => dim === "endpoint" && n.key !== STATS_USAGE_OTHER_KEY
      ? statsEndpointLabel(n.key)
      : (n.label || n.key || "未知");

    // 图例显隐（localStorage 持久化，按粒度分桶）；被隐藏的节点只从视觉上剔除，
    // 圆心总数与百分比分母仍是窗口全量，保证占比恒和 100%
    if (!statsUsageHidden[dim]) statsUsageHidden[dim] = new Set();
    const hidden = statsUsageHidden[dim];
    // prune：数据里已消失的 key 清掉，防永久残留（与趋势图图例同款）
    const liveKeys = new Set(allNodes.map((n) => n.key));
    let pruned = false;
    for (const k of [...hidden]) if (!liveKeys.has(k)) { hidden.delete(k); pruned = true; }
    if (pruned) saveStatsLegend();
    const nodes = allNodes.filter((n) => !hidden.has(n.key));
    const visibleSum = nodes.reduce((a, n) => a + (n.tokens || 0), 0);

    if (donutEl._usageRaf) { cancelAnimationFrame(donutEl._usageRaf); donutEl._usageRaf = null; }
    donutEl.textContent = "";
    legendEl.textContent = "";
    barsEl.textContent = "";
    if (!nodes.length || total <= 0) {
      donutEl.innerHTML = '<div class="empty-hint">暂无用量数据</div>';
      statsUsageRevealed = false;
      return; // 空态：右半柱状图区域同样不渲染（上面已清空）
    }

    // 图例（名称/百分比/tokens，点击显隐联动环）；button 进 tab 序，样式由
    // .stats-usage-legend-item 的 button reset 保持与原 div 一致
    allNodes.forEach((n) => {
      const pct = total > 0 ? (n.tokens || 0) / total : 0;
      const item = document.createElement("button");
      item.type = "button";
      item.className = "stats-usage-legend-item" + (hidden.has(n.key) ? " off" : "");
      item.title = "点击显隐该节点";
      const dot = document.createElement("i");
      dot.className = "stats-usage-lg-dot";
      dot.style.background = statsUsageColorOf(n.key, allNodes);
      const main = document.createElement("div");
      main.className = "stats-usage-lg-main";
      const name = document.createElement("div");
      name.className = "stats-usage-lg-name";
      name.textContent = nodeLabel(n);
      const tokens = document.createElement("div");
      tokens.className = "stats-usage-lg-tokens";
      tokens.textContent = `${formatTokensCn(n.tokens || 0)} tokens · ${statsFmtInt(n.requests || 0)} 次请求`;
      main.appendChild(name);
      main.appendChild(tokens);
      const pctEl = document.createElement("span");
      pctEl.className = "stats-usage-lg-pct";
      pctEl.textContent = statsUsagePctText(pct);
      item.appendChild(dot);
      item.appendChild(main);
      item.appendChild(pctEl);
      item.onclick = () => {
        if (hidden.has(n.key)) hidden.delete(n.key); else hidden.add(n.key);
        saveStatsLegend();
        renderStatsUsage({ force: true });
      };
      legendEl.appendChild(item);
    });

    // ── 环形图（SVG circle stroke-dasharray 拼弧） ──
    const NS = "http://www.w3.org/2000/svg";
    const C = 2 * Math.PI * STATS_USAGE_R; // 周长
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 208 208");
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", "模型用量环形图");
    // 一笔画式揭示：rAF 用单一缓动曲线驱动整环——画笔前沿从 12 点截线顺时针
    // 匀滑推进（每帧按前沿位置截出各段可见 dash），没有分段接力，速度全程一致。
    // 触发时机见 revealNow 头注释（进 tab 首渲 / 切本卡 seg 重播；其余静默重渲不播）
    const USAGE_REVEAL_MS = 1400; // 整环画完的总时长（右半柱状图生长同用此时长）
    const reveal = revealNow(!!replay);
    const segs = appendStatsUsageSlices(svg, nodes, visibleSum, allNodes, reveal);
    donutEl.appendChild(svg);
    appendStatsUsageCenter(svg, total);
    // 右半柱状图：与环/图例完全同源——同一批可见节点（hidden 集合过滤后）、同一
    // 排序、statsUsageColorOf 同色（「其他」灰）；触发时机与环严格一致（revealNow
    // 同一判定），生长动画挂在下方同一个 rAF 循环里，共享 _usageRaf 句柄守卫与
    // leaveStatsView 清理，不引入第二处 rAF。
    const bars = appendStatsUsageBars(barsEl, nodes, allNodes, reveal, nodeLabel);
    if (reveal) {
      void donutEl.getBoundingClientRect(); // 提交 dash=0 / 柱高=0 起点
      const t0 = performance.now();
      const draw = (t) => {
        const p = Math.min(1, (t - t0) / USAGE_REVEAL_MS);
        const eased = 1 - Math.pow(1 - p, 3); // easeOutCubic：唯一一次前快后慢
        const front = eased * C;
        for (const { seg, startLen, dash } of segs) {
          const visible = Math.max(0, Math.min(front - startLen, dash));
          seg.setAttribute("stroke-dasharray", `${visible} ${C - visible}`);
        }
        // 柱从地面线向上生长：高度 0→终值，数值标签随柱顶同步上移
        for (const { rect, valEl, fullH, groundY } of bars) {
          const h = fullH * eased;
          rect.setAttribute("y", String(groundY - h));
          rect.setAttribute("height", String(h));
          valEl.setAttribute("y", String(groundY - h - 6));
        }
        if (p < 1) donutEl._usageRaf = requestAnimationFrame(draw);
        else donutEl._usageRaf = null; // 播完必须清句柄：守卫以真值为「在飞」依据，残留旧 id 会永久吞掉后续重渲
      };
      donutEl._usageRaf = requestAnimationFrame(draw);
    } else {
      donutEl._usageRaf = null; // 静默重渲无 rAF；守卫与 leaveStatsView 清理以 null 为准
    }
  }

  function statsUsageColorOf(key, nodes) {
    // 颜色按全量列表的排名索引分配：图例与扇区必须同一来源，否则隐藏
    // 头部节点后扇区会整体换色错位
    if (key === STATS_USAGE_OTHER_KEY) return STATS_OTHER_STYLE.color;
    const idx = nodes.filter((n) => n.key !== STATS_USAGE_OTHER_KEY).findIndex((n) => n.key === key);
    return STATS_PALETTE[idx >= 0 ? idx % STATS_PALETTE.length : 0].color;
  }

  function appendStatsUsageSlices(svg, nodes, visibleSum, allNodes, reveal) {
    const NS = "http://www.w3.org/2000/svg";
    const C = 2 * Math.PI * STATS_USAGE_R;
    const single = nodes.length === 1;
    let acc = 0; // 累积可见 tokens，映射为弧长起点
    const segs = [];
    for (const n of nodes) {
      const frac = visibleSum > 0 ? (n.tokens || 0) / visibleSum : 0;
      // 100% 单段时不留隙（gap 会让首尾重叠闪缝）；多段时尾隙由下一段 offset 覆盖
      const dash = Math.max(0, frac * C - (single ? 0 : STATS_USAGE_GAP));
      const seg = document.createElementNS(NS, "circle");
      seg.setAttribute("cx", "104"); seg.setAttribute("cy", "104");
      seg.setAttribute("r", String(STATS_USAGE_R));
      seg.setAttribute("fill", "none");
      seg.setAttribute("stroke", statsUsageColorOf(n.key, allNodes));
      seg.setAttribute("stroke-width", String(STATS_USAGE_STROKE));
      seg.setAttribute("class", "stats-usage-slice");
      // 生长式揭示：先以 dash=0 挂载（transition 起点在 CSS 里），调用方刷布局后改终值
      seg.setAttribute("stroke-dasharray", reveal ? `0 ${C}` : `${dash} ${C - dash}`);
      // -90° 起、顺时针；偏移量取负等价于正向旋转（SVG stroke 从 3 点钟方向起）
      seg.setAttribute("stroke-dashoffset", String(-(acc * C) + C * 0.25));
      seg.title = `${n.label || n.key} · ${formatTokensCn(n.tokens || 0)} tokens`;
      svg.appendChild(seg);
      segs.push({ seg, dash, startLen: acc * C, frac });
      acc += frac;
    }
    return segs;
  }

  function appendStatsUsageCenter(svg, total) {
    const NS = "http://www.w3.org/2000/svg";
    const t1 = document.createElementNS(NS, "text");
    t1.setAttribute("x", "104"); t1.setAttribute("y", "101");
    t1.setAttribute("text-anchor", "middle");
    t1.setAttribute("class", "stats-usage-center-tokens");
    t1.textContent = formatTokensCn(total);
    const t2 = document.createElementNS(NS, "text");
    t2.setAttribute("x", "104"); t2.setAttribute("y", "121");
    t2.setAttribute("text-anchor", "middle");
    t2.setAttribute("class", "stats-usage-center-unit");
    t2.textContent = "tokens";
    svg.appendChild(t1);
    svg.appendChild(t2);
  }

  // 右半竖直柱状图：节点 tokens 映射柱高（相对可见节点最大值归一），柱子从水平
  // 地面线向上生长；柱顶上方数值标签（formatTokensCn）、柱底名称标签（与图例同名，
  // 过长截断、全名在 title）。viewBox 高 208 与环同源，宽随节点数伸。
  // reveal=true 时柱以 0 高挂载，生长由 renderStatsUsage 的同一 rAF 循环驱动。
  // 槽位常驻 6 个：viewBox 永远按 6 槽起宽，后端最多 Top5+其他 正好填满；成员
  // 不足 6 时空槽不画柱但保留位宽，svg 宽度不随成员数伸缩，右栏不变形。
  const STATS_USAGE_BAR_SLOT = 64; // 每柱槽位宽（柱 + 间距）
  const STATS_USAGE_BAR_SLOTS = 6; // 常驻槽位数（=后端 Top5+其他 上限）
  function appendStatsUsageBars(barsEl, nodes, allNodes, reveal, nodeLabel) {
    const NS = "http://www.w3.org/2000/svg";
    const H = 208; // viewBox 高与环同源（环 CSS 放大至 248px，柱高随右栏宽伸缩）
    const groundY = H - 34; // 地面轴线 y（下方留名称标签行）
    const topPad = 20; // 柱顶上方数值标签空间
    const plotH = groundY - topPad;
    const W = Math.max(200, STATS_USAGE_BAR_SLOTS * STATS_USAGE_BAR_SLOT + 16);
    const barW = Math.min(34, STATS_USAGE_BAR_SLOT - 18);
    const maxTok = nodes.reduce((m, n) => Math.max(m, n.tokens || 0), 0) || 1;
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", "模型用量柱状图");
    const axis = document.createElementNS(NS, "line");
    axis.setAttribute("x1", "8"); axis.setAttribute("x2", String(W - 8));
    axis.setAttribute("y1", String(groundY)); axis.setAttribute("y2", String(groundY));
    axis.setAttribute("class", "stats-usage-bars-axis");
    svg.appendChild(axis);
    const bars = [];
    nodes.forEach((n, i) => {
      const label = nodeLabel(n);
      const cx = 8 + STATS_USAGE_BAR_SLOT * i + STATS_USAGE_BAR_SLOT / 2;
      const fullH = Math.max(2, ((n.tokens || 0) / maxTok) * plotH);
      const rect = document.createElementNS(NS, "rect");
      rect.setAttribute("x", String(cx - barW / 2));
      rect.setAttribute("width", String(barW));
      rect.setAttribute("rx", "2");
      rect.setAttribute("class", "stats-usage-bar");
      rect.setAttribute("fill", statsUsageColorOf(n.key, allNodes));
      // 生长式揭示：reveal 时以 0 高挂地面线（rAF 循环刷布局后逐帧改高），否则画满
      rect.setAttribute("y", String(reveal ? groundY : groundY - fullH));
      rect.setAttribute("height", String(reveal ? 0 : fullH));
      rect.title = `${label} · ${formatTokensCn(n.tokens || 0)} tokens`;
      svg.appendChild(rect);
      const valEl = document.createElementNS(NS, "text");
      valEl.setAttribute("x", String(cx));
      valEl.setAttribute("y", String(reveal ? groundY - 6 : groundY - fullH - 6));
      valEl.setAttribute("class", "stats-usage-bar-val");
      valEl.textContent = formatTokensCn(n.tokens || 0);
      svg.appendChild(valEl);
      const nameEl = document.createElementNS(NS, "text");
      nameEl.setAttribute("x", String(cx));
      nameEl.setAttribute("y", String(groundY + 15));
      nameEl.setAttribute("class", "stats-usage-bar-name");
      nameEl.textContent = label.length > 10 ? label.slice(0, 9) + "…" : label;
      nameEl.title = label;
      svg.appendChild(nameEl);
      bars.push({ rect, valEl, fullH, groundY });
    });
    barsEl.appendChild(svg);
    return bars;
  }

  // ── F：首字响应 TTFT（按桶 avg/p95 双线 + 按模型 Top5 均值条） ──
  // 榜单按 avg 升序（越快越前），并列按 key 字母序；后端 byModel 全量下发
  // （按样本数排），排序纯前端完成。卡内固定 Top5，不足补占位行；空态例外。
  const STATS_TTFT_TOP_N = 5;
  const STATS_TPS_TOP_N = 10;
  function statsTtftRankedAll() {
    const ttft = statsData && statsData.ttft ? statsData.ttft : {};
    const byModel = Array.isArray(ttft.byModel) ? ttft.byModel : [];
    return byModel.filter((r) => r.avg != null)
      .sort((a, b) => (a.avg - b.avg) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }
  function statsTpsRankedAll() {
    const rows = statsData && Array.isArray(statsData.tps) ? statsData.tps : [];
    return rows.filter((r) => r.avgTps != null && r.avgTps > 0)
      .sort((a, b) => (b.avgTps - a.avgTps) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }
  function renderStatsTtft() {
    const chartEl = $("statsTtftChart");
    const barsEl = $("statsTtftBars");
    if (!chartEl || !barsEl) return;
    const ttft = statsData && statsData.ttft ? statsData.ttft : {};
    const daily = Array.isArray(ttft.daily) ? ttft.daily : [];
    if (daily.some((d) => d.avg != null || d.p95 != null)) {
      renderStatsLineChart(chartEl, {
        labels: daily.map((d) => statsFmtBucketLabel(d.start)),
        series: [
          { key: "avg", label: "均值", color: "var(--accent)", dash: "", values: daily.map((d) => d.avg) },
          { key: "p95", label: "P95", color: "var(--warn)", dash: "5,3", values: daily.map((d) => d.p95) },
        ],
        fmt: statsFmtTtft,
        height: 160,
        ariaLabel: "首字响应 TTFT 趋势图",
      });
    } else {
      chartEl.innerHTML = '<div class="empty-hint">暂无数据</div>';
    }
    const rows = statsTtftRankedAll().slice(0, STATS_TTFT_TOP_N);
    if (rows.length) {
      statsRenderBars(barsEl, rows.map((r, i) => ({
        rank: i + 1,
        label: r.key,
        value: r.avg,
        valText: `${statsFmtTtft(r.avg)} · p95 ${statsFmtTtft(r.p95)} · ${statsFmtInt(r.samples)} 次`,
      })), { placeholders: STATS_TTFT_TOP_N - rows.length });
    } else {
      barsEl.textContent = "";
    }
  }

  // ── G1：TPS 生成速度（按模型横条 Top10 + 占位行；空态例外） ──
  function renderStatsTps() {
    const el = $("statsTpsBars");
    if (!el) return;
    const valid = statsTpsRankedAll();
    if (!valid.length) { el.innerHTML = '<div class="empty-hint">暂无数据</div>'; return; }
    const top = valid.slice(0, STATS_TPS_TOP_N);
    statsRenderBars(el, top.map((r, i) => ({
      rank: i + 1,
      label: r.key,
      value: r.avgTps,
      valText: `${Number(r.avgTps).toFixed(1)} tok/s · ${statsFmtInt(r.samples)} 样本`,
    })), { placeholders: STATS_TPS_TOP_N - top.length });
  }

  // ── F/G1 全量排名弹窗（一卡一窗：kind=ttft/tps；窗内两列纵向连续均分，
  // 偶均分/奇左多一；序号 1..N 延续与卡片同构；紧凑文本行无横条） ──
  function hideStatsRankModal() {
    const m = $("statsRankModal");
    if (m) m.classList.remove("show");
  }
  function openStatsRankModal(kind) {
    const modal = $("statsRankModal");
    const titleEl = $("statsRankTitle");
    const bodyEl = $("statsRankBody");
    if (!modal || !titleEl || !bodyEl) return;
    let items;
    if (kind === "ttft") {
      titleEl.textContent = "首字响应 TTFT";
      items = statsTtftRankedAll().map((r) => ({
        label: r.key,
        valText: `${statsFmtTtft(r.avg)} · p95 ${statsFmtTtft(r.p95)} · ${statsFmtInt(r.samples)} 次`,
      }));
    } else {
      titleEl.textContent = "TPS 生成速度";
      items = statsTpsRankedAll().map((r) => ({
        label: r.key,
        valText: `${Number(r.avgTps).toFixed(1)} tok/s · ${statsFmtInt(r.samples)} 样本`,
      }));
    }
    if (!items.length) return; // 空态不開窗（卡内已有「暂无数据」）
    bodyEl.textContent = "";
    const wrap = document.createElement("div");
    wrap.className = "stats-rank-cols";
    const mid = Math.ceil(items.length / 2); // 奇数左多一
    [items.slice(0, mid), items.slice(mid)].forEach((colItems, ci) => {
      const col = document.createElement("div");
      col.className = "stats-rank-col";
      colItems.forEach((it, i) => {
        const n = (ci === 0 ? 0 : mid) + i + 1; // 序号跨列延续
        const row = document.createElement("div");
        row.className = "stats-rank-row";
        row.appendChild(statsRankEl(n));
        const nm = document.createElement("span");
        nm.className = "stats-rank-name";
        nm.textContent = it.label;
        nm.title = it.label;
        const vv = document.createElement("span");
        vv.className = "stats-rank-val";
        vv.textContent = it.valText;
        row.appendChild(nm); row.appendChild(vv);
        col.appendChild(row);
      });
      wrap.appendChild(col);
    });
    bodyEl.appendChild(wrap);
    modal.classList.add("show");
  }

  // ── G2：端点会话 / 工时（整宽表） ──
  function renderStatsEndpoints() {
    const el = $("statsEndpoints");
    if (!el) return;
    const rows = statsData && Array.isArray(statsData.endpoints) ? statsData.endpoints : [];
    if (!rows.length) { el.innerHTML = '<div class="empty-hint">暂无数据</div>'; return; }
    const body = rows.map((r) =>
      `<tr>` +
      `<td class="stats-cell-name" title="${r.agentId || ""}">${statsEndpointLabel(r.agentId)}</td>` +
      `<td>${statsFmtInt(r.requests)}</td>` +
      `<td>入 ${formatTokensCn(r.prompt)} / 出 ${formatTokensCn(r.completion)}</td>` +
      `<td>${statsFmtInt(r.sessions)}</td>` +
      `<td>${statsFmtHours(r.workMs)}</td>` +
      `</tr>`).join("");
    el.innerHTML =
      `<div class="stats-table-wrap"><table class="stats-table">` +
      `<thead><tr><th>端点</th><th>请求数</th><th>Tokens（入/出）</th><th>会话数</th><th>活跃工时</th></tr></thead>` +
      `<tbody>${body}</tbody></table></div>`;
  }

  // ═══════════════════════════════════════════════
  // 统计页「请求日志」子 tab
  // ═══════════════════════════════════════════════
  // 子 tab 切换照设置页模式（hidden + active + aria-selected + tabIndex），
  // 存档键 panel-stats-subtab（overview|logs，默认 overview）。logs 子页激活且
  // 页面可见时 5s 轮询；离开子页或统计页即停（leaveStatsView 统一收）。
  const statsSubTabs = {
    overview: ["statsTabOverview", "statsOverviewPane"],
    logs: ["statsTabLogs", "statsLogsPane"],
  };
  let statsSubTab = "overview";
  let logsTimer = null;

  // opts.enter：从 enterStatsView 来的首次激活（总览侧需要一次取数+渲染）。
  // 返回该子页首个数据落地的 promise，供 enterStatsView 接力 startupViewReady。
  function activateStatsSubTab(which, opts) {
    const enter = !!(opts && opts.enter);
    if (!statsSubTabs[which]) which = "overview";
    const prev = statsSubTab;
    statsSubTab = which === "logs" ? "logs" : "overview";
    for (const [name, [tabId, paneId]] of Object.entries(statsSubTabs)) {
      const on = name === statsSubTab;
      $(tabId).classList.toggle("active", on);
      $(tabId).setAttribute("aria-selected", String(on));
      $(tabId).tabIndex = on ? 0 : -1;
      $(paneId).hidden = !on;
    }
    try { localStorage.setItem("panel-stats-subtab", statsSubTab); } catch {}
    // 日志子页=整页固定布局（页面不滚、表体内部滚动、分页条钉屏底）；总览恢复文档流
    $("statsView").classList.toggle("logs-fixed", statsSubTab === "logs");
    if (statsSubTab === "logs") return enterLogsPane();
    leaveLogsPane();
    // 总览只在可见时取数+渲染：首次进统计页或从日志子页切回时补一次（日志
    // 子页前台期间 30s 轮询对总览停取停渲，切回在这里即刻补齐）。已在总览
    // 上重复点 tab 不触发重取。子 tab 切回 = 进 tab 范式：重置 reveal 标记，
    // 缓存热渲染时趋势图清屏生长、环形图一笔画重播（同 enterStatsView 语义：
    // 切走时 leaveStatsView 只取消 rAF 不清 DOM，先同步用缓存数据重渲，fetch
    // 落地后由同终点签名守卫跳过或 morph 半途接管，均不打断动画）。
    if (enter || prev === "logs") {
      if (prev === "logs") { statsTrendPrev = null; statsUsageRevealed = false; }
      if (statsData) { renderStatsTrend(); renderStatsUsage(); }
      return refreshStatsState();
    }
    return undefined;
  }

  const logsState = { range: "today", agent: "", provider: "", model: "", status: "all", sort: "ts", dir: "desc", page: 1, pageSize: 20, seq: 0 };
  let logsRows = []; // 最近一次成功渲染的行（详情展开的数据源）
  let logsTotal = 0; // 最近一次成功响应的总数（跳页钳制用）
  let logsCorrecting = false; // 深页超界自动回末页的一次性守卫（防循环）
  let logsLastSig = null; // 最近一次落地渲染的签名（loadLogs 同签名跳过重渲）
  const logsExpanded = new Set(); // 展开中的行键：轮询重建 tbody 后按键重新展开
  const logsRowKey = (r) => `${r.ts}|${r.providerId ?? ""}|${r.model ?? ""}`;

  function initLogsPane() {
    // 筛选：任一变更 → 回第 1 页 → 立即重载
    const bindFilter = (id, key) => {
      const el = $(id);
      if (el) el.onchange = () => { logsState[key] = el.value; logsState.page = 1; loadLogs(); };
    };
    bindFilter("logRangeFilter", "range");
    bindFilter("logAgentFilter", "agent");
    bindFilter("logProviderFilter", "provider");
    bindFilter("logModelFilter", "model");
    bindFilter("logStatusFilter", "status");
    // 可排序表头：再点同列翻转方向，换列回落 desc；改排序回第 1 页
    for (const id of ["logsSortTs", "logsSortDuration"]) {
      const btn = $(id);
      if (!btn) continue;
      btn.onclick = () => {
        const field = btn.getAttribute("data-sort");
        if (logsState.sort === field) logsState.dir = logsState.dir === "desc" ? "asc" : "desc";
        else { logsState.sort = field; logsState.dir = "desc"; }
        logsState.page = 1;
        syncLogsSortHeaders();
        loadLogs();
      };
    }
    syncLogsSortHeaders();
    // 分页条
    const prev = $("logsPrevBtn");
    const next = $("logsNextBtn");
    if (prev) prev.onclick = () => { if (logsState.page > 1) { logsState.page -= 1; loadLogs(); } };
    if (next) next.onclick = () => { logsState.page += 1; loadLogs(); };
    const jump = $("logsJump");
    if (jump) jump.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      const pages = Math.max(1, Math.ceil(logsTotal / logsState.pageSize));
      const v = Number.parseInt(jump.value, 10);
      if (!Number.isFinite(v)) { jump.value = ""; return; }
      logsState.page = Math.min(pages, Math.max(1, v)); // 越界钳制
      jump.value = "";
      loadLogs();
    });
    const sizeSel = $("logPageSize");
    if (sizeSel) sizeSel.onchange = () => {
      logsState.pageSize = Number(sizeSel.value) || 20;
      logsState.page = 1;
      loadLogs();
    };
    // 行展开/收起 + 错误态重试：事件委托（tbody 由 innerHTML 整体重建）
    const tbody = $("logsTbody");
    if (tbody) tbody.addEventListener("click", (e) => {
      if (e.target.closest("[data-logs-retry]")) { loadLogs(); return; }
      const tr = e.target.closest("tr.logs-row");
      if (!tr) return;
      toggleLogsDetail(tr);
    });
  }

  // 阶段 3：日志首次加载的骨架行——v2 平铺语义下加载态用 shimmer 底色块暗示行结构
  // （不画框）。只铺首次空表（tbody 已有内容时 5s 轮询是同签名静默范式，不动 DOM）；
  // v2-only 门控：v1 保持原行为（空表等首包）。
  function renderLogsSkeleton() {
    const tbody = $("logsTbody");
    if (!tbody || tbody.children.length) return;
    if (document.documentElement.getAttribute("data-ui-version") !== "v2") return;
    const widths = [95, 88, 97, 82, 93, 78, 90, 85];
    tbody.innerHTML = widths.map((w) =>
      `<tr class="logs-skel-row" aria-hidden="true"><td colspan="7"><div class="sessions-skel logs-skel-bar" style="width:${w}%"></div></td></tr>`).join("");
  }

  function enterLogsPane() {
    syncLogsSortHeaders();
    renderLogsSkeleton();
    const ready = loadLogs();
    if (!logsTimer) {
      logsTimer = setInterval(() => {
        if (document.hidden) return; // 页面隐藏暂停，与统计 30s 轮询同模式
        if (statsSubTab !== "logs") return; // 兜底：子页已切走则空转（leaveLogsPane 已清，双保险）
        loadLogs();
      }, 5000);
    }
    return ready;
  }

  function leaveLogsPane() {
    if (logsTimer) { clearInterval(logsTimer); logsTimer = null; }
  }

  async function loadLogs() {
    // 竞态守卫（同 statsReqSeq 模式）：慢的旧响应后到丢弃，不覆盖新筛选的结果
    const seq = ++logsState.seq;
    const sp = new URLSearchParams({
      range: logsState.range,
      sort: logsState.sort,
      dir: logsState.dir,
      page: String(logsState.page),
      pageSize: String(logsState.pageSize),
    });
    if (logsState.agent) sp.set("agent", logsState.agent);
    if (logsState.provider) sp.set("provider", logsState.provider);
    if (logsState.model) sp.set("model", logsState.model);
    if (logsState.status !== "all") sp.set("status", logsState.status);
    try {
      const res = await api("GET", "/api/stats/logs?" + sp.toString());
      if (seq !== logsState.seq) return;
      // 深页超界（轮询期间总量缩小/跨午夜）：一次性钳回末页重载
      const pages = Math.max(1, Math.ceil((res.total || 0) / logsState.pageSize));
      if ((res.total || 0) > 0 && res.rows.length === 0 && res.page > pages && !logsCorrecting) {
        logsCorrecting = true;
        logsState.page = pages;
        try { await loadLogs(); } finally { logsCorrecting = false; }
        return;
      }
      // 不可见不渲染：切走统计页或切回总览子页后迟落地的响应到此丢弃
      if ($("statsView").hidden || statsSubTab !== "logs") return;
      // 同签名跳过：journal 行只增不改，total+页状态+首尾行键+facets 全同
      // 即画面无变化——5s 轮询空转时 DOM 一概不动（分页条也在签名覆盖内）
      const rows = Array.isArray(res.rows) ? res.rows : [];
      const sig = [
        res.total || 0, res.page, res.pageSize, logsState.sort, logsState.dir,
        rows.length ? logsRowKey(rows[0]) : "",
        rows.length ? logsRowKey(rows[rows.length - 1]) : "",
        (res.facets?.agents || []).map((f) => f.id).join(","),
        (res.facets?.providers || []).map((f) => f.id).join(","),
        (res.facets?.models || []).map((f) => f.raw).join(","),
      ].join("|");
      if (sig === logsLastSig) return;
      logsLastSig = sig;
      renderLogs(res);
      refillLogsFilters(res.facets);
    } catch {
      if (seq !== logsState.seq) return;
      renderLogsError();
    }
  }
  // 筛选下拉回填（facets 只受时间范围影响）：保留当前选中值——选中项恰好不在
  // 新 facets 里（如收窄时间范围后该值无行）时补一项占位，不让筛选静默丢失。
  function refillLogsFilters(facets) {
    if (!facets) return;
    const fill = (id, key, items, toOption) => {
      const sel = $(id);
      if (!sel) return;
      while (sel.options.length > 1) sel.remove(1);
      let hasCurrent = !logsState[key];
      for (const item of items) {
        const [value, label] = toOption(item);
        if (value === logsState[key]) hasCurrent = true;
        const opt = document.createElement("option");
        opt.value = value;
        opt.textContent = label;
        sel.appendChild(opt);
      }
      if (!hasCurrent) {
        const opt = document.createElement("option");
        opt.value = logsState[key];
        opt.textContent = logsOptionLabel(key, logsState[key]);
        sel.appendChild(opt);
      }
      sel.value = logsState[key];
    };
    fill("logAgentFilter", "agent", Array.isArray(facets.agents) ? facets.agents : [],
      (f) => [f.id === null ? "__none__" : String(f.id), logsAgentLabel(f.id)]);
    fill("logProviderFilter", "provider", Array.isArray(facets.providers) ? facets.providers : [],
      (f) => [String(f.id), String(f.label ?? f.id)]);
    fill("logModelFilter", "model", Array.isArray(facets.models) ? facets.models : [],
      (f) => [String(f.raw), String(f.display ?? f.raw)]);
  }

  function logsAgentLabel(id) {
    if (id === null || id === undefined || id === "") return "未知来源";
    return STATS_ENDPOINT_LABELS[id] || String(id);
  }

  function logsOptionLabel(key, value) {
    if (key === "agent") return logsAgentLabel(value === "__none__" ? null : value);
    return value;
  }

  function syncLogsSortHeaders() {
    for (const id of ["logsSortTs", "logsSortDuration"]) {
      const btn = $(id);
      if (!btn) continue;
      const on = btn.getAttribute("data-sort") === logsState.sort;
      const arrow = btn.querySelector(".logs-sort-arrow");
      if (arrow) arrow.textContent = on ? (logsState.dir === "desc" ? "▼" : "▲") : "";
    }
  }

  function logsFmtTime(ts) {
    const d = new Date(Number(ts));
    const p = (n) => String(n).padStart(2, "0");
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  function logsFmtTimeFull(ts) {
    const d = new Date(Number(ts));
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  function logsFmtDur(ms) {
    const n = Number(ms);
    if (!Number.isFinite(n) || n <= 0) return "0.0s";
    return (n / 1000).toFixed(1) + "s";
  }

  function renderLogs(res) {
    const tbody = $("logsTbody");
    if (!tbody) return;
    logsRows = Array.isArray(res.rows) ? res.rows : [];
    logsTotal = res.total || 0;
    if (!logsRows.length) {
      tbody.innerHTML = '<tr class="logs-state-row"><td colspan="7"><div class="empty-hint">该筛选条件下暂无请求记录</div></td></tr>';
      renderLogsPager(res);
      return;
    }
    tbody.innerHTML = logsRows.map((r) => logsRowHtml(r)).join("");
    // 轮询重建后按行键恢复展开中的详情行
    logsRows.forEach((r, i) => {
      if (logsExpanded.has(logsRowKey(r))) appendLogsDetail(tbody.children[i], r);
    });
    renderLogsPager(res);
  }

  function renderLogsError() {
    logsLastSig = null; // 错误态不进签名：恢复后同数据也必须能重渲出来
    const tbody = $("logsTbody");
    if (!tbody) return;
    tbody.innerHTML = '<tr class="logs-state-row"><td colspan="7"><div class="empty-hint">日志加载失败 <button type="button" class="btn btn-mini" data-logs-retry>重试</button></div></td></tr>';
    const pager = $("logsPager");
    if (pager) pager.hidden = true;
  }

  function logsRowHtml(r) {
    const ok = r.ok === true;
    const durMs = Number(r.durationMs) || 0;
    const durCls = durMs < 15000 ? "logs-dur-fast" : durMs < 60000 ? "logs-dur-mid" : "logs-dur-slow";
    const sub = [];
    if (r.ttftMs !== null && r.ttftMs !== undefined) sub.push(`首字 ${statsFmtTtft(Number(r.ttftMs))}`);
    if (ok && Number(r.completion) > 0 && durMs > 0) sub.push(`${(Number(r.completion) / (durMs / 1000)).toFixed(1)} t/s`);
    const statusBadge = ok
      ? '<span class="badge badge-ok">成功</span>'
      : `<span class="badge badge-danger">失败${r.status !== null && r.status !== undefined && r.status !== "" ? " " + esc(r.status) : ""}</span>`;
    return `<tr class="logs-row${ok ? "" : " logs-row-fail"}" data-logs-key="${esc(logsRowKey(r))}">`
      + `<td class="logs-cell-main">${esc(logsFmtTime(r.ts))}</td>`
      + `<td>${esc(logsAgentLabel(r.agentId))}</td>`
      + `<td title="${esc(r.providerId ?? "")}">${esc(r.providerLabel || r.providerId || "—")}</td>`
      + `<td title="${esc(r.model ?? "")}">${esc(r.modelDisplay ?? r.model ?? "—")}${r.stream === true ? '<span class="logs-stream-tag">流</span>' : ""}</td>`
      + `<td>输入 ${esc(formatTokensCn(r.prompt))} / 输出 ${esc(formatTokensCn(r.completion))}${Number(r.cached) > 0 ? `<span class="logs-sub">缓存 ${esc(formatTokensCn(r.cached))}</span>` : ""}</td>`
      + `<td><span class="${durCls}">${esc(logsFmtDur(durMs))}</span>${sub.length ? `<span class="logs-sub">${esc(sub.join(" · "))}</span>` : ""}</td>`
      + `<td>${statusBadge}</td>`
      + `</tr>`;
  }

  function logsDetailHtml(r) {
    const items = [];
    if (r.ok !== true) items.push(["错误信息", typeof r.errMsg === "string" && r.errMsg ? r.errMsg : "—"]);
    items.push(["接口格式", r.path === "openai" ? "OpenAI" : r.path === "anthropic" ? "Anthropic" : "—"]);
    items.push(["流式", r.stream === true ? "流式" : "非流式"]);
    if (r.instanceId) items.push(["实例", String(r.instanceId)]);
    items.push(["请求模型", r.model ?? "—"]);
    items.push(["渠道 ID", r.providerId || "—"]);
    items.push(["结束时间", logsFmtTimeFull(r.ts)]);
    items.push(["首字耗时", r.ttftMs !== null && r.ttftMs !== undefined ? statsFmtTtft(Number(r.ttftMs)) : "—"]);
    items.push(["总耗时", r.durationMs !== null && r.durationMs !== undefined ? logsFmtDur(r.durationMs) : "—"]);
    return `<dl class="logs-detail-grid">${items.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>`;
  }

  function appendLogsDetail(tr, row) {
    const detailTr = document.createElement("tr");
    detailTr.className = "logs-detail-row";
    const td = document.createElement("td");
    td.colSpan = 7;
    td.innerHTML = logsDetailHtml(row);
    detailTr.appendChild(td);
    tr.after(detailTr);
  }

  function toggleLogsDetail(tr) {
    const next = tr.nextElementSibling;
    const key = tr.getAttribute("data-logs-key");
    if (next && next.classList.contains("logs-detail-row")) {
      next.remove();
      if (key) logsExpanded.delete(key);
      return;
    }
    // 按行键找数据：tbody children 里夹着已展开的详情行，DOM 索引不可靠
    const row = logsRows.find((r) => logsRowKey(r) === key);
    if (!row) return;
    appendLogsDetail(tr, row);
    if (key) logsExpanded.add(key);
  }

  // 分页条：total=0 整条隐藏；页码 >9 页时头 3 + 尾 3 + 当前±1，中间 …
  function renderLogsPager(res) {
    const pager = $("logsPager");
    if (!pager) return;
    const total = res.total || 0;
    if (total === 0) { pager.hidden = true; return; }
    pager.hidden = false;
    $("logsTotal").textContent = `共 ${total} 条`;
    const pages = Math.max(1, Math.ceil(total / logsState.pageSize));
    const cur = res.page;
    const nums = [];
    if (pages <= 9) {
      for (let i = 1; i <= pages; i += 1) nums.push(i);
    } else {
      const keep = new Set([1, 2, 3, pages - 2, pages - 1, pages, cur - 1, cur, cur + 1]);
      let prevNum = 0;
      for (let i = 1; i <= pages; i += 1) {
        if (!keep.has(i)) continue;
        if (prevNum && i - prevNum > 1) nums.push("…");
        nums.push(i);
        prevNum = i;
      }
    }
    const host = $("logsPages");
    host.textContent = "";
    for (const n of nums) {
      if (n === "…") {
        const dots = document.createElement("span");
        dots.className = "logs-pages-ellipsis";
        dots.textContent = "…";
        host.appendChild(dots);
        continue;
      }
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "logs-page-btn" + (n === cur ? " active" : "");
      btn.textContent = String(n);
      btn.onclick = () => { if (logsState.page !== n) { logsState.page = n; loadLogs(); } };
      host.appendChild(btn);
    }
    const prev = $("logsPrevBtn");
    const next = $("logsNextBtn");
    if (prev) prev.disabled = cur <= 1;
    if (next) next.disabled = cur >= pages;
  }

  // ═══════════════════════════════════════════════
  // 会话管理视图
  // ═══════════════════════════════════════════════
  // querySelectorAll 快捷方式（panel.html 的 $ 是 getElementById，此处补全 $$）
  function $$(sel) { return Array.from(document.querySelectorAll(sel)); }

  /* HTML 转义（五字符含引号）：会话内容进 DOM/attribute 前必须过这道。
     与 escapeHtml 并存——escapeHtml 不转引号，会话数据的 id/路径/标题要进
     data-id/title 等属性，需引号转义，故保留原型 esc。 */
  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  /* 关键词高亮：先转义再包 <mark>，正则特殊字符转义 */
  function sessHighlight(text, kw) {
    const safe = esc(text);
    if (!kw) return safe;
    const re = new RegExp(kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    return safe.replace(re, (m) => `<mark>${m}</mark>`);
  }

  /* 相对时间格式化：刚刚 / N 分钟前 / N 小时前 / 昨天 / N 天前 / 具体日期 */
  const SESS_MIN = 60 * 1000, SESS_HOUR = 60 * SESS_MIN, SESS_DAY = 24 * SESS_HOUR;
  function sessRelTime(ts) {
    const diff = Date.now() - ts;
    if (diff < 0) return "刚刚";                       // 时钟回拨防御
    if (diff < SESS_MIN) return "刚刚";
    if (diff < SESS_HOUR) return Math.floor(diff / SESS_MIN) + " 分钟前";
    if (diff < 24 * SESS_HOUR) return Math.floor(diff / SESS_HOUR) + " 小时前";
    const d = new Date(ts), now = new Date();
    const yest = new Date(now); yest.setDate(now.getDate() - 1);
    if (d.toDateString() === yest.toDateString()) return "昨天";
    if (diff < 7 * SESS_DAY) return Math.floor(diff / SESS_DAY) + " 天前";
    const sameYear = d.getFullYear() === now.getFullYear();
    return sameYear ? `${d.getMonth() + 1}月${d.getDate()}日` : `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
  }
  /* 绝对时间（title 提示与详情页用） */
  function sessAbsTime(ts) {
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  /* 项目目录短名（无标题会话的回退显示名） */
  function sessDirName(p) { return String(p || "").replace(/\\/g, "/").split("/").filter(Boolean).pop() || p || ""; }
  /* 会话显示标题：标题为空时回退项目目录名，再回退会话 ID 前 8 位 */
  function sessTitle(s) { return s.title || sessDirName(s.project) || String(s.id || "").slice(0, 8); }

  /* 复制到剪贴板 + toast 反馈（panel.html toast(msg, isErr)，成功不传第二参） */
  async function sessCopyText(text, tip) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // 剪贴板 API 不可用（如 file:// 旧环境）时回退 execCommand
      const ta = document.createElement("textarea");
      ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); } catch {}
      ta.remove();
    }
    toast(tip);
  }

  // 端点清单：真实 9 端点，顺序取 AGENT_CARD_ORDER；显示名复用 STATS_ENDPOINT_LABELS。
  // 圆点与徽标色是端点品牌色，取自 --ep-* token（亮暗各一套），与会话/统计
  // 两个视图无关——端点标识不能借用语义色，否则会被读成状态。未登记的新端点
  // 回落中性灰，不占用既有端点的色相。
  const SESS_ENDPOINT_COLORS = {
    zcode: "var(--ep-zcode)", claude: "var(--ep-claude)", dsh: "var(--ep-dsh)",
    pi: "var(--ep-pi)", kimi: "var(--ep-kimi)",
    opencode: "var(--ep-opencode)", qoder: "var(--ep-qoder)",
    codex: "var(--ep-codex)", grok: "var(--ep-grok)",
  };
  const SESSIONS_ENDPOINTS = AGENT_CARD_ORDER.map((id) => ({
    id,
    name: STATS_ENDPOINT_LABELS[id] || id,
    color: SESS_ENDPOINT_COLORS[id] || "var(--text-4)",
  }));
  const SESS_EP = Object.fromEntries(SESSIONS_ENDPOINTS.map((e) => [e.id, e]));
  // 端点筛选下拉的可见项：已安装的 Agent ∪ 当前会话数据里实际出现的端点——
  // 后者保证历史会话（Agent 已卸载但会话文件还在磁盘上）仍可单独筛到。
  // installedAgentIds 为 null（检测未知/失败）时全部按可见（fail-open）。
  // 选项集合没变就不动 DOM：renderSessList 每次渲染都会调，无守卫会打断
  // 展开中的下拉。
  let sessEpOptionsKey = "";
  function refreshSessEndpointOptions() {
    const sel = $("sessEndpointFilter");
    if (!sel) return;
    const inData = new Set();
    for (const s of sessState.sessions || []) if (s && s.endpoint) inData.add(s.endpoint);
    const ids = SESSIONS_ENDPOINTS
      .filter((ep) => installedAgentIds === null || installedAgentIds.has(ep.id) || inData.has(ep.id))
      .map((ep) => ep.id);
    const key = ids.join(",");
    if (key === sessEpOptionsKey) return;
    sessEpOptionsKey = key;
    const current = sel.value;
    sel.innerHTML = '<option value="">全部 Agent</option>' + ids.map((id) => {
      const ep = SESS_EP[id];
      return `<option value="${esc(id)}">${esc(ep ? ep.name : id)}</option>`;
    }).join("");
    // 当前选中项仍在集合里就保住选择；不在（union 口径下基本不会发生）回落「全部」
    if (current && !ids.includes(current)) {
      sel.value = "";
      sessState.endpoint = "";
    } else sel.value = current;
  }
  const sessEpName = (id) => (SESS_EP[id] || {}).name || STATS_ENDPOINT_LABELS[id] || id || "未知端点";
  const sessEpColor = (id) => (SESS_EP[id] || {}).color || "var(--text-4)";
  // 需要描边环的端点：pi 的白与 zcode 的黑（见 --ep-ring 说明）
  const SESS_EP_RINGED = new Set(["pi", "zcode"]);
  const sessEpDotClass = (id) => `ep-dot${SESS_EP_RINGED.has(id) ? " ep-dot--outlined" : ""}`;

  // localStorage 偏好（前缀 anyswitch.sessions.；持久化视图/分组展开状态，搜索与筛选不持久化）
  const SESS_LS = {
    get(k, d) { try { const v = localStorage.getItem("anyswitch.sessions." + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem("anyswitch.sessions." + k, JSON.stringify(v)); } catch {} },
  };

  const sessState = {
    sessions: [],                      // 会话数据（API 拉取）
    endpointErrors: [],                // list 响应包装的端点异常 [{endpoint, reason}]
    loading: false,                    // 列表拉取中（骨架屏）
    view: SESS_LS.get("view", "group"),   // 视图：group 分组 / flat 列表
    collapsed: SESS_LS.get("collapsed", {}), // 分组展开状态：{ 组key: true=收起 }
    endpoint: "",                      // 端点筛选（不持久化）
    search: "",                        // 搜索词（不持久化）
    selectedId: null,                  // 当前选中会话
    batch: false,                      // 批量管理模式
    checked: new Set(),                // 批量已选会话 id
    deleting: false,                   // 删除进行中（遮罩 + 禁止再触发）
    listScrollTop: 0,                  // 离开视图时记下的列表滚动位，回页首铺兑现后清零
  };
  let sessTimer = null;                // 60s 相对时间刷新定时器（enter/leave 管理）
  let sessMsgObserver = null;          // TOC 高亮用的 IntersectionObserver
  let sessInited = false;              // initSessionsTab 一次性事件绑定标记
  let sessListReqSeq = 0;              // 列表取数竞态守卫
  let sessListRenderSeq = 0;           // 列表分帧铺行的作废令牌：新渲染、离开视图即自增
  let sessListLastKey = "";            // 上一次铺进容器的内容指纹，相同则不必重建
  let sessListPumping = false;         // 分帧还没铺完：此时容器里是半份列表，不能直接复用
  let sessDataRev = 0;                 // 会话数据版本：取数回来内容真有变化才自增
  let sessDataSig = "";                // 上一次取数的内容摘要，用来判断「真有变化」
  let sessRenderCursor = 0;            // 消息流分帧：下一条待建的下标
  const SESS_FOLD_LIMIT = 3000, SESS_FOLD_HEAD = 1500; // 超长消息折叠阈值与预览长度
  const SESS_RENDER_CHUNK = 120;       // 消息流每帧条数
  const SESS_LIST_CHUNK = 200;         // 列表每帧铺的行数
  const SESS_TOC_MIN_TURNS = 2;        // 目录起显门槛：一两轮的会话不占栏

  /* ============================================================
     数据拉取
     ============================================================ */
  // 会话数据落位。取数是整份 JSON 重解析，数组和对象每次都是新的，比引用判不出「其实
  // 没变」；这里按列表行用到的字段算一份摘要，真有变化才推进版本号——列表重铺的指纹
  // 靠它决定要不要重建，静默重取带回同一份数据时就不必白清一次再铺一遍。
  function setSessSessions(list) {
    let h = 5381;
    for (const s of list) {
      const row = s.id + "\u0001" + (s.lastActive || 0) + "\u0001" + (s.title || "") + "\u0001" + (s.project || "");
      for (let i = 0; i < row.length; i++) h = ((h << 5) + h + row.charCodeAt(i)) | 0;
    }
    const sig = list.length + ":" + h;
    if (sig !== sessDataSig) { sessDataSig = sig; sessDataRev++; }
    sessState.sessions = list;
  }

  // force：服务端把这份列表缓存成短 TTL 快照（见 panel.mjs createSessionsListSnapshot），
  // 不带 refresh=1 的请求在窗口内只会拿到旧值。只有用户显式点「刷新」才 force——
  // 首次装载、分组重渲这些自动路径必须留在 TTL 内复用，否则每次进页都重排一次真扫描。
  async function refreshSessionsList({ force = false } = {}) {
    const seq = ++sessListReqSeq;
    sessState.loading = true;
    // 手上已经铺着一份列表时不必先重铺一遍：取回结果之后还会再铺一次，静默重取尤其不该让
    // 列表白闪一下。只有容器空着（冷启动，或刚离开视图时节点已被收走）才先拿缓存顶上。
    const scrollEl = $("sessScroll");
    if (!scrollEl || !scrollEl.childElementCount || sessState.sessions.length === 0) renderSessList({ keepScroll: true });
    try {
      const res = await api("GET", `/api/sessions/list${force ? "?refresh=1" : ""}`);
      if (seq !== sessListReqSeq) return; // 已有更新请求在飞，丢弃旧响应
      setSessSessions(Array.isArray(res.sessions) ? res.sessions : []);
      sessState.endpointErrors = Array.isArray(res.endpointErrors) ? res.endpointErrors : [];
      // prune：已消失的会话从 checked/selectedId 清掉
      const ids = new Set(sessState.sessions.map((s) => s.id));
      for (const id of [...sessState.checked]) if (!ids.has(id)) sessState.checked.delete(id);
      if (sessState.selectedId && !ids.has(sessState.selectedId)) sessState.selectedId = null;
    } catch (err) {
      if (seq !== sessListReqSeq) return;
      toast(panelError(err, "会话列表加载失败"), true);
      setSessSessions([]);
      sessState.endpointErrors = [];
    } finally {
      if (seq === sessListReqSeq) sessState.loading = false;
    }
    // 取数回来时视图可能已经切走了：离开会把列表节点收掉，这时再铺一遍等于把刚释放的
    // 整棵树当场重建，白占主线程还挡住下一次进入。数据已经落进 sessState，回来时自然铺。
    if (currentView !== "sessions") return;
    renderSessErrBanner();
    renderSessList({ keepScroll: true });
    renderSessDetail();
    updateSessBatchBar();
  }

  /* ============================================================
     筛选 + 搜索（列表数据无消息正文，全文匹配：标题/项目目录/会话 ID/概要）
     ============================================================ */
  function sessFiltered() {
    const kw = sessState.search.trim().toLowerCase();
    return sessState.sessions.filter((s) => {
      if (sessState.endpoint && s.endpoint !== sessState.endpoint) return false;
      if (!kw) return true;
      const hay = [s.title, s.project, s.id, s.summary].filter(Boolean).join("\n").toLowerCase();
      return hay.includes(kw);
    }).sort((a, b) => (b.lastActive || 0) - (a.lastActive || 0));
  }

  /* 两级分组：端点 → 项目目录 */
  function sessGroup(list) {
    const byEp = new Map();
    for (const s of list) {
      if (!byEp.has(s.endpoint)) byEp.set(s.endpoint, new Map());
      const byProj = byEp.get(s.endpoint);
      if (!byProj.has(s.project)) byProj.set(s.project, []);
      byProj.get(s.project).push(s);
    }
    return byEp;
  }

  /* ============================================================
     左栏渲染
     ============================================================ */
  function renderSessList({ keepScroll = false } = {}) {
    const scrollEl = $("sessScroll");
    if (!scrollEl) return;
    hideSessContextMenu(); // 列表重渲染后旧菜单的目标行可能已消失，直接收起
    refreshSessEndpointOptions(); // 会话数据/可见集变化时同步筛选下拉（自带集合守卫）
    const list = sessFiltered();
    $("sessListCount").textContent = list.length;
    $("sessTotalBadge").textContent = sessState.sessions.length + " 个会话";
    scrollEl.classList.toggle("deleting", sessState.deleting);
    // 滚动位：离开视图时记下的那一份优先兑现（容器已被收空，问它的 scrollTop 只会得到 0）；
    // 记下的位置只在真正落位后才清掉——回来先拿缓存铺一遍、紧接着取数回来再铺时，第一轮
    // 很可能还没铺到那个位置就被作废，清了就再也回不到原处。没得兑现时沿用当前位。
    const restoreTop = keepScroll ? (sessState.listScrollTop || scrollEl.scrollTop) : 0;
    if (!keepScroll) sessState.listScrollTop = 0;

    // 加载态骨架屏只在冷启动演：切走再切回时 sessions 里还留着上一次的数据，
    // 整树换成骨架屏会把「静默重取」显形成为重载。
    if (sessState.loading && sessState.sessions.length === 0) {
      sessListLastKey = "";
      sessListPumping = false;
      scrollEl.innerHTML = Array.from({ length: 6 }, () =>
        `<div style="padding:10px 12px;"><div class="sessions-skel" style="height:14px;width:75%;margin-bottom:6px;"></div><div class="sessions-skel" style="height:11px;width:45%;"></div></div>`
      ).join("");
      return;
    }
    // 空态 / 搜索无结果
    if (sessState.sessions.length === 0) {
      sessListLastKey = "";
      sessListPumping = false;
      scrollEl.innerHTML = `<div class="sessions-list-empty"><div class="le-icon">🗂️</div>还没有可浏览的会话<br><span style="font-size:11.5px;">在任意 Agent 里开始一段对话后，会出现在这里。</span></div>`;
      return;
    }
    if (list.length === 0) {
      sessListLastKey = "";
      sessListPumping = false;
      scrollEl.innerHTML = `<div class="sessions-list-empty"><div class="le-icon">🔍</div>没有匹配的会话<br><span style="font-size:11.5px;">换个关键词试试，或清空搜索查看全部。</span></div>`;
      return;
    }

    // 铺出来的内容与上一次完全相同（典型场景：切回会话页先拿缓存铺一遍，随后的静默
    // 重取带回来同一份数据）就沿用现成的行，不白清一次再重铺。选中态不进指纹：它只是
    // 行上的一个类，校正一下即可；还在铺的那一轮同理，它铺的就是这份内容，让它铺完。
    const key = [
      sessDataRev, sessState.view, sessState.search, sessState.endpoint,
      sessState.batch ? "cb:" + [...sessState.checked].sort().join(",") : "nobatch",
      JSON.stringify(sessState.collapsed), list.length,
    ].join("\u0001");
    if (key === sessListLastKey && scrollEl.childElementCount) {
      syncSessSelection();
      // 行还在逐帧补的话，落位交给那一轮自己收尾；铺完了才在这里兑现——此刻若说明这份
      // 内容比存档位置还矮（数据变少了），就贴到底部为止，别把一份够不着的存档一直留着。
      if (!sessListPumping && restoreTop) {
        scrollEl.scrollTop = Math.min(restoreTop, Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight));
        sessState.listScrollTop = 0;
      }
      return;
    }

    // 行是逐帧铺的：整树一次性重建在三千行的真实数据上实测 0.85s，全程占着主线程；
    // 分帧后第一帧只生成并解析两百行，剩下的在后续帧补齐，期间页面照常响应。
    const renderSeq = ++sessListRenderSeq; // 作废上一轮没铺完的帧
    sessListLastKey = key;
    sessListPumping = true;
    const rows = sessRowSeq(list);
    scrollEl.innerHTML = "";
    let bakedSel = sessState.selectedId; // 已铺行里烘着的选中态
    let exhausted = false;
    let restored = !restoreTop;
    const pump = () => {
      if (renderSeq !== sessListRenderSeq) return; // 已被新一轮渲染或离开视图作废
      const before = scrollEl.childElementCount;
      const parts = [];
      while (parts.length < SESS_LIST_CHUNK) {
        const next = rows.next();
        if (next.done) { exhausted = true; break; }
        parts.push(next.value);
      }
      if (parts.length) {
        scrollEl.insertAdjacentHTML("beforeend", parts.join(""));
        bindSessRows(Array.from(scrollEl.children).slice(before));
      }
      // 行里的选中态是渲染开始时烘进去的；这期间用户点了别的行，就按当前状态校正。
      if (bakedSel !== sessState.selectedId) { bakedSel = sessState.selectedId; syncSessSelection(); }
      // 先铺到能盖住目标位置再把滚动条放回去：一上来就设 scrollTop 会被还没铺出来的
      // 内容挡住，视口只能停在顶部，随着后续帧往下长一路下坠。
      if (!restored && (exhausted || scrollEl.scrollHeight >= restoreTop + scrollEl.clientHeight)) {
        scrollEl.scrollTop = restoreTop;
        restored = true;
        sessState.listScrollTop = 0; // 已落位，这份存档消费掉
      }
      if (!exhausted) requestAnimationFrame(pump);
      else sessListPumping = false;
    };
    pump();
  }

  /* 行内容：一条字符串一层，组头与会话项同序排列；用生成器交出，分帧逐段取用 */
  function* sessRowSeq(list) {
    const kw = sessState.search.trim();
    if (sessState.view !== "group") {
      for (const s of list) yield sessItemHtml(s, kw, 1);
      return;
    }
    /* 分组视图：端点 → 项目目录 */
    const byEp = sessGroup(list);
    for (const [epId, byProj] of byEp) {
      const epCount = [...byProj.values()].reduce((n, arr) => n + arr.length, 0);
      const epKey = "ep:" + epId;
      const epCollapsed = !!sessState.collapsed[epKey];
      yield sessGroupHeadHtml(epKey, sessEpName(epId), epCount, epCollapsed, 1, sessEpColor(epId), byProj, null, SESS_EP_RINGED.has(epId));
      if (epCollapsed) continue;
      for (const [proj, arr] of byProj) {
        const pKey = "proj:" + epId + "|" + String(proj || "").replace(/\\/g, "/").toLowerCase();
        const pCollapsed = !!sessState.collapsed[pKey];
        yield sessGroupHeadHtml(pKey, sessDirName(proj), arr.length, pCollapsed, 2, null, arr, proj);
        if (pCollapsed) continue;
        for (const s of arr) yield sessItemHtml(s, kw, 2);
      }
    }
  }

  /* 组头：含折叠箭头、（批量模式下）组复选框、组内计数 */
  function sessGroupHeadHtml(key, label, count, collapsed, lvl, color, arrOrMap, fullPath, ringed) {
    const cb = sessState.batch ? `<input type="checkbox" class="grp-cb" data-key="${esc(key)}" ${sessGrpCheckState(arrOrMap)}>` : "";
    const dotClass = `ep-dot${ringed ? " ep-dot--outlined" : ""}`;
    const dot = color ? `<span class="${dotClass}" style="background:${color};width:8px;height:8px;border-radius:50%;display:inline-block;"></span>` : "";
    const title = fullPath ? `title="${esc(fullPath)}"` : "";
    return `<div class="sess-group-head ${lvl === 2 ? "lvl2" : ""} ${collapsed ? "collapsed" : ""}" data-key="${esc(key)}" ${title}>
      <span class="caret">▼</span>${cb}${dot}<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(label)}</span>
      <span class="g-count">${count}</span></div>`;
  }

  /* 组复选框状态：全选 checked / 部分选中 data-indeterminate / 未选 */
  function sessGrpCheckState(arrOrMap) {
    let ids;
    if (arrOrMap instanceof Map) ids = [...arrOrMap.values()].flat().map((s) => s.id);
    else ids = arrOrMap.map((s) => s.id);
    const n = ids.filter((id) => sessState.checked.has(id)).length;
    if (n === 0) return "";
    if (n === ids.length) return "checked";
    return `data-indeterminate="1"`; // 半选态在 bindSessRows 里设置（HTML 属性无法表达 indeterminate）
  }

  /* 单个会话列表项：克制三字段（端点圆点 + 标题 + 相对时间） */
  function sessItemHtml(s, kw, lvl) {
    const sel = s.id === sessState.selectedId ? " selected" : "";
    const cb = sessState.batch ? `<input type="checkbox" class="item-cb" data-id="${esc(s.id)}" ${sessState.checked.has(s.id) ? "checked" : ""}>` : "";
    const pad = lvl === 2 && sessState.view === "group" ? "padding-left:38px;" : "";
    return `<div class="sess-item${sel}" data-id="${esc(s.id)}" style="${pad}">
      ${cb}<span class="${sessEpDotClass(s.endpoint)}" style="background:${sessEpColor(s.endpoint)}" title="${esc(sessEpName(s.endpoint))}"></span>
      <div class="si-main">
        <div class="si-title">${sessHighlight(sessTitle(s), kw)}</div>
        <div class="si-sub">${sessHighlight(s.project || "", kw)}</div>
      </div>
      <span class="si-time" title="${sessAbsTime(s.lastActive)}">${sessRelTime(s.lastActive)}</span>
    </div>`;
  }

  /* 列表事件绑定：只绑这一批新插入的顶层节点（分帧铺行时逐段调用，不回首扫全表） */
  function bindSessRows(nodes) {
    for (const node of nodes) {
      if (node.classList.contains("sess-group-head")) {
        // 组头折叠/展开
        node.addEventListener("click", (e) => {
          if (e.target.classList.contains("grp-cb")) return; // 点复选框不折叠
          const key = node.dataset.key;
          sessState.collapsed[key] = !sessState.collapsed[key];
          if (!sessState.collapsed[key]) delete sessState.collapsed[key];
          SESS_LS.set("collapsed", sessState.collapsed);
          renderSessList();
        });
        // 组复选框：全选/取消整组；半选态只能由脚本设置（HTML 属性表达不了 indeterminate）
        const cb = node.querySelector(".grp-cb");
        if (cb) {
          if (cb.dataset.indeterminate) cb.indeterminate = true;
          cb.addEventListener("change", () => {
            const ids = sessCollectGroupIds(cb.dataset.key);
            if (cb.checked) ids.forEach((id) => sessState.checked.add(id));
            else ids.forEach((id) => sessState.checked.delete(id));
            renderSessList(); updateSessBatchBar();
          });
        }
        continue;
      }
      if (node.classList.contains("sess-item")) {
        // 会话项：批量模式下点整行切换勾选；正常模式选中查看
        node.addEventListener("click", (e) => {
          const id = node.dataset.id;
          if (sessState.batch) {
            if (!e.target.classList.contains("item-cb")) {
              const checkbox = node.querySelector(".item-cb");
              if (!checkbox) return;
              checkbox.checked = !checkbox.checked;
            }
            const on = node.querySelector(".item-cb").checked;
            on ? sessState.checked.add(id) : sessState.checked.delete(id);
            renderSessList(); updateSessBatchBar();
            return;
          }
          selectSession(id);
        });
      }
    }
  }

  /* 选中态：只切行上的类，不动 DOM 结构（分帧期间新铺的行会自行校正） */
  function syncSessSelection() {
    const root = $("sessScroll");
    if (!root) return;
    const sel = sessState.selectedId;
    for (const el of root.querySelectorAll(".sess-item")) {
      el.classList.toggle("selected", !!sel && el.dataset.id === sel);
    }
  }

  /* 收集某分组下全部会话 id（按当前筛选结果） */
  function sessCollectGroupIds(key) {
    const list = sessFiltered();
    if (key.startsWith("ep:")) return list.filter((s) => s.endpoint === key.slice(3)).map((s) => s.id);
    const [, rest] = key.split("proj:");
    const [epId, proj] = rest.split("|");
    return list.filter((s) => s.endpoint === epId && String(s.project || "").replace(/\\/g, "/").toLowerCase() === proj).map((s) => s.id);
  }

  /* ============================================================
     端点错误横幅（逐条列出；可关闭，下次进视图仍再现）
     ============================================================ */
  function renderSessErrBanner() {
    const host = $("sessErrHost");
    if (!host) return;
    const errs = sessState.endpointErrors || [];
    host.innerHTML = errs.map((e) =>
      `<div class="sessions-err-banner"><span>⚠</span><span>${esc(sessEpName(e.endpoint))} 的会话目录未配置或不可读，其历史会话暂不可浏览。</span><button class="eb-close" data-eb="${esc(e.endpoint)}" title="关闭提示">×</button></div>`
    ).join("");
    host.querySelectorAll(".eb-close").forEach((b) =>
      b.addEventListener("click", () => b.closest(".sessions-err-banner").remove()));
  }

  /* ============================================================
     右栏：会话详情
     ============================================================ */
  function selectSession(id) {
    sessState.selectedId = id;
    syncSessSelection();   // 刷新选中态：只切行的类，不整树重铺
    renderSessDetail();
    // 移动端：选中后收起抽屉
    $("sessListCard").classList.remove("drawer-open");
    $("sessDrawerMask").classList.remove("show");
  }

  function currentSession() { return sessState.sessions.find((s) => s.id === sessState.selectedId) || null; }

  async function renderSessDetail() {
    const s = currentSession();
    const empty = $("sessDetailEmpty"), body = $("sessDetailBody"), skel = $("sessDetailSkel");
    if (!s) {
      empty.hidden = false; body.hidden = true; skel.hidden = true;
      renderSessToc(null);
      return;
    }
    // 会话头（元数据随列表已在手）
    empty.hidden = true; skel.hidden = true; body.hidden = false;
    const badge = $("sessDEpBadge");
    const color = sessEpColor(s.endpoint);
    // 圆点自带颜色（pi/zcode 另加描边环），文字另用可读色：白/黑端点的文字
    // 若跟着端点色走，在浅/深底上一样会读不出来。整条徽标按端点整体换色，
    // 由 #sessDEpBadge 关掉过渡，避免旧端点的颜色在新名字上停留。
    const ringed = SESS_EP_RINGED.has(s.endpoint);
    badge.innerHTML = `<span class="ep-dot${ringed ? " ep-dot--outlined" : ""}" style="background:${color};width:8px;height:8px;border-radius:50%;display:inline-block;margin-right:5px;vertical-align:middle;"></span>${esc(sessEpName(s.endpoint))}`;
    badge.style.cssText = ringed
      ? "background:color-mix(in srgb, var(--text) 10%, transparent);color:var(--text);border:1px solid var(--ep-ring);"
      : `background:color-mix(in srgb, ${color} 12%, transparent);color:${color};border:1px solid ${color};`;
    $("sessDTitle").innerHTML = sessHighlight(sessTitle(s), sessState.search.trim());
    $("sessDTime").textContent = `${sessRelTime(s.lastActive)} · ${sessAbsTime(s.lastActive)}`;
    $("sessDProject").textContent = s.project || "";
    $("sessDFile").textContent = s.file || "";
    $("sessDSid").textContent = String(s.id || "").slice(0, 8) + "…";
    $("sessDSid").dataset.full = s.id || "";

    // 恢复命令预览条：resumeCommand 由后端随 SessionMeta 下发，前端只复制，为空置灰
    const cmd = s.resumeCommand || "";
    $("sessResumeCmd").textContent = cmd || "该 Agent 暂不支持恢复命令";
    $("sessCopyCmdBtn").disabled = !cmd;
    $("sessResumeBtn").disabled = !cmd;

    // 消息流：点选后拉取详情
    await loadSessMessages(s);
    renderSessToc(s);
  }

  /* 拉取并渲染消息流（角色着色、超长折叠、搜索高亮、hover 复制） */
  async function loadSessMessages(s) {
    const flow = $("sessMsgFlow");
    flow.innerHTML = `<div style="padding:8px 0;"><div class="sessions-skel" style="height:64px;margin-bottom:14px;"></div><div class="sessions-skel" style="height:64px;width:80%;margin-left:auto;"></div></div>`;
    let messages = [];
    let turns = [];
    try {
      const res = await api("GET", "/api/sessions/messages?endpoint=" + encodeURIComponent(s.endpoint) + "&path=" + encodeURIComponent(s.file));
      messages = Array.isArray(res.messages) ? res.messages : [];
      // 目录条目由后端算好下发（session-scan 认「哪一轮是人打的字」）：九种转录格式
      // 的角色写法各不相同，前端按 role==="user" 现算会把工具输出当作用户轮。
      turns = Array.isArray(res.turns) ? res.turns : [];
    } catch (err) {
      // 会话可能已被删/移动：回退空消息流并提示
      s.messages = [];
      s.turns = [];
      flow.innerHTML = `<div class="sessions-list-empty">${esc(panelError(err, "消息加载失败"))}</div>`;
      return;
    }
    // 竞态：拉取期间用户已改选其它会话 → 丢弃
    if (sessState.selectedId !== s.id) return;
    s.messages = messages; // 缓存到会话对象，TOC/复制/折叠共用
    s.turns = turns;
    renderSessMessages(s);
  }

  /* 消息流分帧渲染：一条 2.5k 消息的长会话一次性建满 DOM 会把主线程钉住，而目录
     跳转恰恰要落进那段没画出来的区间 —— 所以首屏只建一帧，滚动接近底部续建，
     跳转前按目标下标补齐缺口。 */
  function sessMessageNode(s, m, i, kw) {
    const div = document.createElement("div");
    div.className = "msg " + m.role;
    div.id = "sess-msg-" + i;
    const roleName = { user: "我", assistant: sessEpName(s.endpoint), system: "系统", tool: "工具调用" }[m.role] || m.role;

    const long = (m.content || "").length > SESS_FOLD_LIMIT;
    // 折叠态消息若含搜索命中，自动展开（临时视图状态，不写回数据）
    const hit = kw && (m.content || "").toLowerCase().includes(kw.toLowerCase());
    const expanded = hit || !long;
    const shown = expanded ? m.content : String(m.content || "").slice(0, SESS_FOLD_HEAD) + "\n…";

    div.innerHTML = `
      <span class="msg-role">${esc(roleName)}</span>
      <div class="msg-body">${sessHighlight(shown, kw)}</div>
      ${long ? `<button class="fold-toggle">${expanded ? "收起" : `展开完整内容（约 ${(m.content.length / 1000).toFixed(1)}k 字符）`}</button>` : ""}
      <span class="msg-copy"><button title="复制该条消息">⧉</button></span>`;

    // 折叠/展开：按钮文案即状态来源，点击后切换本条消息的显示内容
    if (long) {
      div.querySelector(".fold-toggle").addEventListener("click", () => {
        const body = div.querySelector(".msg-body");
        const btn = div.querySelector(".fold-toggle");
        const nowCollapsed = btn.textContent.startsWith("展开");
        if (nowCollapsed) {
          body.innerHTML = sessHighlight(m.content, kw);
          btn.textContent = "收起";
        } else {
          body.innerHTML = sessHighlight(String(m.content || "").slice(0, SESS_FOLD_HEAD) + "\n…", kw);
          btn.textContent = `展开完整内容（约 ${(m.content.length / 1000).toFixed(1)}k 字符）`;
        }
      });
    }
    // 复制该条消息
    div.querySelector(".msg-copy button").addEventListener("click", (e) => {
      e.stopPropagation();
      sessCopyText(m.content, "消息内容已复制");
    });
    return div;
  }

  // 追加一帧消息节点（sessRenderCursor 是下一条待建的下标）。
  function appendSessMessageChunk(s) {
    const messages = s.messages || [];
    if (sessRenderCursor >= messages.length) return;
    const kw = sessState.search.trim();
    const flow = $("sessMsgFlow");
    const stop = Math.min(sessRenderCursor + SESS_RENDER_CHUNK, messages.length);
    for (let i = sessRenderCursor; i < stop; i++) flow.appendChild(sessMessageNode(s, messages[i], i, kw));
    sessRenderCursor = stop;
    observeSessUserTurns(s); // 每补一帧把新出现的用户轮挂上跟随高亮
  }

  // 把目录跳转的目标下标画进 DOM：目标在未渲染区间时逐帧补齐。
  function ensureSessMessageRendered(s, index) {
    let guard = 0;
    while (sessRenderCursor <= index && sessRenderCursor < (s.messages || []).length && guard++ < 5000) {
      appendSessMessageChunk(s);
    }
  }

  function renderSessMessages(s) {
    sessRenderCursor = 0;
    $("sessMsgFlow").innerHTML = "";
    appendSessMessageChunk(s);
  }

  /* ============================================================
     消息目录 TOC
     ============================================================ */
  function renderSessToc(s) {
    // 条目由后端 turns 给（下标指向 messages，预览已按各格式清洗过）
    const turns = s && Array.isArray(s.turns) ? s.turns : [];
    const has = turns.length > SESS_TOC_MIN_TURNS; // 一两轮的会话不值得占一栏
    $("sessTocSide").hidden = !has;
    $("sessTocFab").classList.toggle("has-toc", has);
    if (!has) { $("sessTocPop").hidden = true; return; }

    const html = turns.map((t, n) =>
      `<div class="toc-item" data-msg="${Number(t.index) || 0}"><span class="t-idx">${n + 1}</span><span class="t-text">${esc(t.preview || "")}</span></div>`
    ).join("");
    $("sessTocList").innerHTML = html;
    $("sessTocPopList").innerHTML = html;

    // 点击定位：目标可能落在还没画的帧里，先补齐再滚
    $$(".toc-item").forEach((item) => {
      item.addEventListener("click", () => {
        const idx = Number(item.dataset.msg) || 0;
        const cur = currentSession();
        if (cur) ensureSessMessageRendered(cur, idx);
        const target = document.getElementById("sess-msg-" + idx);
        if (!target) return;
        // 居中对齐：详情区随页面滚动，顶部对齐会把目标行塞到吸顶头行底下。
        target.scrollIntoView({ behavior: "smooth", block: "center" });
        target.classList.remove("flash");
        void target.offsetWidth; // 重启动画
        target.classList.add("flash");
        setTimeout(() => target.classList.remove("flash"), 2000);
        $("sessTocPop").hidden = true; // 小屏弹层点击后收起
      });
    });

    observeSessUserTurns(s);
  }

  // 当前可视消息对应的 TOC 项高亮。分帧渲染下每补一帧都要重挂一次，
  // 否则新画出来的用户轮没有跟随状态。
  function observeSessUserTurns(s) {
    if (sessMsgObserver) sessMsgObserver.disconnect();
    if (!s || !Array.isArray(s.turns)) return;
    sessMsgObserver = new IntersectionObserver((ents) => {
      for (const en of ents) {
        if (!en.isIntersecting) continue;
        const i = en.target.id.replace("sess-msg-", "");
        $$(".toc-item").forEach((t) => t.classList.toggle("active", t.dataset.msg === i));
      }
    }, { root: null, threshold: 0.4 });
    for (const t of s.turns) {
      const el = document.getElementById("sess-msg-" + t.index);
      if (el) sessMsgObserver.observe(el);
    }
  }

  /* ============================================================
     右键菜单：会话行专属，单项「删除会话」（空白处/组头不弹）
     菜单 DOM 复用技能菜单的面板风格（.skills-ctx-menu 纯样式类），
     id 独立为 sessCtxMenu，关闭逻辑自管：点菜单外 / Esc / 列表滚动 / 重渲染
     ============================================================ */
  function hideSessContextMenu() {
    const menu = $("sessCtxMenu");
    if (menu) menu.remove();
  }

  function showSessContextMenu(x, y, id) {
    hideSessContextMenu();
    const menu = document.createElement("div");
    menu.id = "sessCtxMenu";
    menu.className = "skills-ctx-menu";
    menu.innerHTML = `<div class="skills-ctx-item danger">删除会话</div>`;
    menu.querySelector(".skills-ctx-item").onclick = () => {
      hideSessContextMenu();
      openSessDeleteDlg([id]);
    };
    document.body.appendChild(menu);
    // 防止菜单超出视口右/下边缘（与技能菜单同款避让）
    menu.style.left = Math.min(x, window.innerWidth - menu.offsetWidth - 8) + "px";
    menu.style.top = Math.min(y, window.innerHeight - menu.offsetHeight - 8) + "px";
  }

  /* ============================================================
     删除：确认对话框 + 异步执行 + 结果汇报
     ============================================================ */
  let sessPendingDelete = null; // { ids: [...], single: bool }

  function openSessDeleteDlg(ids) {
    if (sessState.deleting) return; // 删除进行中禁止再触发
    sessPendingDelete = { ids, single: ids.length === 1 };
    const single = sessPendingDelete.single;
    $("sessDlgTitle").textContent = single ? "删除会话" : "批量删除会话";
    const target = $("sessDlgTarget");
    if (single) {
      const s = sessState.sessions.find((x) => x.id === ids[0]);
      $("sessDlgDesc").textContent = "将删除以下会话，该会话的完整对话记录会一并移除。";
      target.hidden = false;
      target.innerHTML = `<div class="t1">${esc(sessTitle(s))}</div><div class="t2">会话 ID：${esc(s.id)}</div>`;
    } else {
      $("sessDlgDesc").textContent = `将删除选中的 ${ids.length} 个会话，这些会话的完整对话记录会一并移除。`;
      target.hidden = true;
    }
    $("sessDlgMask").classList.add("show");
  }
  function closeSessDeleteDlg() { $("sessDlgMask").classList.remove("show"); sessPendingDelete = null; }

  async function runSessDelete() {
    if (!sessPendingDelete || sessState.deleting) return;
    const ids = sessPendingDelete.ids;
    sessState.deleting = true;
    closeSessDeleteDlg();
    renderSessList(); // 加遮罩 + 禁用指针事件
    // 逐项定位 {endpoint, file}（roots 白名单校验要定位 adapter）
    const items = ids.map((id) => sessState.sessions.find((s) => s.id === id))
      .filter(Boolean).map((s) => ({ endpoint: s.endpoint, file: s.file }));
    let okCount = 0, failCount = 0;
    try {
      const res = await api("POST", "/api/sessions/delete", { items });
      const okFiles = new Set((res.ok || []).map((it) => it.file || it));
      const failItems = res.fail || [];
      okCount = okFiles.size || (items.length - failItems.length);
      failCount = failItems.length;
      // 只从 checked 清除成功项；失败项保留在列表与勾选集中
      for (const s of sessState.sessions.slice()) {
        if (okFiles.has(s.file)) {
          sessState.checked.delete(s.id);
        }
      }
      // 从 sessions 移除成功项
      setSessSessions(sessState.sessions.filter((s) => !okFiles.has(s.file)));
      // 若包含当前选中会话且已删除，selectedId 置空，详情区回空态
      const cur = currentSession();
      if (cur && okFiles.has(cur.file)) sessState.selectedId = null;
      else if (sessState.selectedId && !sessState.sessions.find((s) => s.id === sessState.selectedId)) sessState.selectedId = null;
      // 失败项的会话 ID 与原因在控制台可查
      if (failItems.length) console.warn("[sessions] 删除失败项：", failItems);
    } catch (err) {
      okCount = 0; failCount = ids.length;
      toast(panelError(err, "删除失败"), true);
    } finally {
      sessState.deleting = false;
    }
    renderSessList();
    renderSessDetail();
    updateSessBatchBar();
    showSessResult(okCount, failCount);
  }

  function showSessResult(ok, fail) {
    const bar = $("sessResultBar");
    if (fail === 0) {
      bar.className = "sess-result-bar ok";
      bar.innerHTML = `✓ 已删除 ${ok} 个会话<button class="rb-x" onclick="this.parentElement.hidden=true">×</button>`;
      toast(`已删除 ${ok} 个会话`);
    } else {
      bar.className = "sess-result-bar warn";
      bar.innerHTML = `⚠ 已删除 ${ok} 个会话，${fail} 个失败<button class="rb-x" onclick="this.parentElement.hidden=true">×</button>`;
      toast(`已删除 ${ok} 个会话，${fail} 个失败`, true);
    }
    bar.hidden = false;
    // 若详情区当前是空态（结果条不可见），toast 已兜底
    setTimeout(() => { bar.hidden = true; }, 6000);
  }

  /* ============================================================
     批量管理模式
     ============================================================ */
  function setSessBatch(on) {
    sessState.batch = on;
    if (!on) sessState.checked.clear();
    $("sessBatchBar").hidden = !on;
    $("sessBatchToggleBtn").textContent = on ? "☑ 批量管理中" : "☑ 批量管理";
    renderSessList();
    updateSessBatchBar();
  }

  function updateSessBatchBar() {
    $("sessSelCount").textContent = `已选 ${sessState.checked.size} 项`;
    $("sessBatchDelBtn").disabled = sessState.checked.size === 0;
    $("sessBatchDelBtn").textContent = sessState.checked.size ? `批量删除（${sessState.checked.size}）` : "批量删除";
  }

  /* ============================================================
     工具栏：视图切换 / 收起全部 / 端点筛选 / 搜索
     ============================================================ */
  function clearSessSearch() {
    $("sessSearchInput").value = ""; sessState.search = "";
    $("sessSearchClear").hidden = true; $("sessKbdHint").hidden = false;
    renderSessList();
    if (sessState.selectedId) renderSessDetail();
  }

  /* 进入/离开视图：首拉 list + 60s 相对时间刷新定时器（照 statsTimer 模式） */
  function enterSessionsView() {
    if (!sessInited) initSessionsTab();
    const firstReady = refreshSessionsList();
    if (!sessTimer) {
      sessTimer = setInterval(() => {
        if (document.visibilityState !== "visible") return;
        // 只刷新时间文案，不整树重渲染，避免打断交互
        $$("#sessScroll .sess-item").forEach((item) => {
          const s = sessState.sessions.find((x) => x.id === item.dataset.id);
          if (!s) return;
          const t = item.querySelector(".si-time");
          if (t) t.textContent = sessRelTime(s.lastActive);
        });
        const cur = currentSession();
        if (cur && !$("sessDetailBody").hidden) $("sessDTime").textContent = `${sessRelTime(cur.lastActive)} · ${sessAbsTime(cur.lastActive)}`;
      }, 60 * 1000);
    }
    return firstReady;
  }

  function leaveSessionsView() {
    if (sessTimer) { clearInterval(sessTimer); sessTimer = null; }
    if (sessMsgObserver) { sessMsgObserver.disconnect(); sessMsgObserver = null; }
    // ☰ 靠 body 类随视图收起，弹层是属性控制的：不收就会在回来时挂着开着的空层。
    $("sessTocPop").hidden = true;
    // 列表节点不跟着视图一起留在 DOM 里：三千行、一万八千个节点，隐藏状态下浏览器仍要
    // 为它们做样式与布局结算，切回来那一帧还得整棵重排一遍。滚动位先记下，回来再兑现。
    const scrollEl = $("sessScroll");
    if (!scrollEl) return;
    sessState.listScrollTop = scrollEl.scrollTop;
    sessListRenderSeq++; // 作废还在排队的分帧
    sessListLastKey = "";
    sessListPumping = false;
    scrollEl.innerHTML = "";
  }

  /* 一次性事件绑定（enterSessionsView 首进时执行；restoreView 可能先于 init 到达） */
  function initSessionsTab() {
    if (sessInited) return;
    sessInited = true;
    $("tabSessions").onclick = () => switchView("sessions");

    // 视图切换 seg
    $("sessViewSeg").querySelectorAll(".seg-btn").forEach((b) => {
      b.setAttribute("aria-checked", b.getAttribute("data-v") === sessState.view ? "true" : "false");
      b.addEventListener("click", () => {
        sessState.view = b.getAttribute("data-v");
        SESS_LS.set("view", sessState.view);
        $("sessViewSeg").querySelectorAll(".seg-btn").forEach((x) =>
          x.setAttribute("aria-checked", x === b ? "true" : "false"));
        $("sessCollapseAllBtn").style.visibility = sessState.view === "group" ? "visible" : "hidden";
        renderSessList();
      });
    });
    $("sessCollapseAllBtn").style.visibility = sessState.view === "group" ? "visible" : "hidden";
    // 全部收起/展开（切换语义）：当前所有组均已收起时展开全部，否则收起全部
    $("sessCollapseAllBtn").addEventListener("click", () => {
      const byEp = sessGroup(sessFiltered());
      const keys = [];
      for (const [epId, byProj] of byEp) {
        keys.push("ep:" + epId);
        for (const proj of byProj.keys()) keys.push("proj:" + epId + "|" + String(proj || "").replace(/\\/g, "/").toLowerCase());
      }
      const allCollapsed = keys.length > 0 && keys.every((k) => sessState.collapsed[k]);
      for (const k of keys) {
        if (allCollapsed) delete sessState.collapsed[k];
        else sessState.collapsed[k] = true;
      }
      SESS_LS.set("collapsed", sessState.collapsed);
      renderSessList();
    });

    // 端点筛选下拉：选项由 refreshSessEndpointOptions 按可见集维护（首建也走它）
    const sel = $("sessEndpointFilter");
    refreshSessEndpointOptions();
    sel.addEventListener("change", () => { sessState.endpoint = sel.value; renderSessList(); });

    // 搜索框：输入即搜；Esc 清空；/ 聚焦
    const searchInput = $("sessSearchInput");
    searchInput.addEventListener("input", () => {
      sessState.search = searchInput.value;
      $("sessSearchClear").hidden = !sessState.search;
      $("sessKbdHint").hidden = !!sessState.search;
      renderSessList();
      if (sessState.selectedId) renderSessDetail(); // 搜索词联动消息高亮
    });
    searchInput.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { clearSessSearch(); searchInput.blur(); }
    });
    $("sessSearchClear").addEventListener("click", clearSessSearch);
    document.addEventListener("keydown", (e) => {
      if ($("sessionsView").hidden) return; // 仅会话视图可见时响应
      const tag = (document.activeElement || {}).tagName;
      const typing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
      if (e.key === "/" && !typing) { e.preventDefault(); searchInput.focus(); }
      else if (e.key === "Escape" && !typing) {
        // 全局 Esc：优先关弹层/对话框/右键菜单，其次清空搜索
        if ($("sessCtxMenu")) return; // 右键菜单的 Esc 关闭由下面的专属监听处理
        if (!$("sessDlgMask").classList.contains("show") && $("sessTocPop").hidden && sessState.search) clearSessSearch();
      }
    });

    // 复制交互：项目目录 / 源文件 / 会话 ID / 恢复命令
    $("sessDProject").addEventListener("click", () => { const s = currentSession(); if (s) sessCopyText(s.project, "项目目录已复制"); });
    $("sessDFile").addEventListener("click", () => { const s = currentSession(); if (s) sessCopyText(s.file, "源文件路径已复制"); });
    $("sessDSid").addEventListener("click", () => { const s = currentSession(); if (s) sessCopyText(s.id, "完整会话 ID 已复制"); });
    $("sessCopyCmdBtn").addEventListener("click", () => {
      const s = currentSession(); if (!s || !s.resumeCommand) return;
      sessCopyText(s.resumeCommand, "命令已复制，粘贴到终端即可继续会话");
    });
    $("sessResumeBtn").addEventListener("click", () => {
      const s = currentSession(); if (!s || !s.resumeCommand) return;
      sessCopyText(s.resumeCommand, "命令已复制，粘贴到终端即可继续会话");
    });

    // 删除
    $("sessDeleteBtn").addEventListener("click", () => { if (sessState.selectedId) openSessDeleteDlg([sessState.selectedId]); });
    $("sessDlgCancel").addEventListener("click", closeSessDeleteDlg);
    $("sessDlgCloseBtn").addEventListener("click", closeSessDeleteDlg);
    $("sessDlgMask").addEventListener("click", (e) => { if (e.target === $("sessDlgMask")) closeSessDeleteDlg(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && $("sessDlgMask").classList.contains("show")) closeSessDeleteDlg(); });
    $("sessDlgConfirm").addEventListener("click", runSessDelete);

    // 批量管理
    $("sessBatchToggleBtn").addEventListener("click", () => setSessBatch(!sessState.batch));
    $("sessBatchExitBtn").addEventListener("click", () => setSessBatch(false));
    $("sessSelAllBtn").addEventListener("click", () => {
      // 全选当前筛选结果（与搜索/筛选联动）
      sessFiltered().forEach((s) => sessState.checked.add(s.id));
      renderSessList(); updateSessBatchBar();
    });
    $("sessSelClearBtn").addEventListener("click", () => { sessState.checked.clear(); renderSessList(); updateSessBatchBar(); });
    $("sessBatchDelBtn").addEventListener("click", () => {
      if (sessState.checked.size) openSessDeleteDlg([...sessState.checked]);
    });

    // 刷新：带 force 走 ?refresh=1 等一次真扫描落地——不带它，服务端 TTL 快照会把
    // 旧值原样返回，按钮就只剩一句「已刷新」的空响。
    $("sessRefreshBtn").addEventListener("click", async () => {
      const btn = $("sessRefreshBtn");
      if (btn.disabled) return;
      btn.disabled = true;
      try { await refreshSessionsList({ force: true }); toast("会话列表已刷新"); }
      finally { btn.disabled = false; }
    });

    // TOC 浮动按钮（小屏）
    $("sessTocFab").addEventListener("click", () => { $("sessTocPop").hidden = !$("sessTocPop").hidden; });
    document.addEventListener("click", (e) => {
      if (!$("sessTocPop").hidden && !e.target.closest("#sessTocPop") && !e.target.closest("#sessTocFab")) $("sessTocPop").hidden = true;
    });

    // 长会话分帧：消息流随页面滚动（它自己没有滚动容器），滚到接近底部续建一帧。
    window.addEventListener("scroll", () => {
      if ($("sessionsView").hidden) return;
      const cur = currentSession();
      if (!cur || !Array.isArray(cur.messages) || sessRenderCursor >= cur.messages.length) return;
      const doc = document.documentElement;
      if (doc.scrollTop + doc.clientHeight < doc.scrollHeight - 800) return;
      appendSessMessageChunk(cur);
    }, { passive: true });

    // 移动端抽屉
    $("sessDrawerOpenBtn").addEventListener("click", () => {
      $("sessListCard").classList.add("drawer-open");
      $("sessDrawerMask").classList.add("show");
    });
    $("sessDrawerMask").addEventListener("click", () => {
      $("sessListCard").classList.remove("drawer-open");
      $("sessDrawerMask").classList.remove("show");
    });

    // 右键菜单：委托挂常驻滚动容器（行节点逐帧铺入，逐行绑会失效）；
    // 命中会话行 → 先选中该行再弹单项删除菜单；空白处/组头/骨架空态不弹。
    // 选中只切行的类，不重铺列表，滚动位一动不动。
    $("sessScroll").addEventListener("contextmenu", (e) => {
      const item = e.target.closest(".sess-item");
      if (!item || sessState.deleting) return;
      e.preventDefault();
      const id = item.dataset.id;
      if (!id) return;
      if (sessState.selectedId !== id) {
        sessState.selectedId = id;
        syncSessSelection(); // 同 selectSession：只切类，滚动位一动不动
        renderSessDetail();
        $("sessListCard").classList.remove("drawer-open");
        $("sessDrawerMask").classList.remove("show");
      }
      showSessContextMenu(e.clientX, e.clientY, id);
    });
    $("sessScroll").addEventListener("scroll", hideSessContextMenu);
    document.addEventListener("click", (e) => {
      const menu = $("sessCtxMenu");
      // 菜单项自身的 click 会走菜单内处理并关闭，这里只处理点菜单外
      if (menu && !menu.contains(e.target)) hideSessContextMenu();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && $("sessCtxMenu") && !$("sessionsView").hidden) hideSessContextMenu();
    });
  }

  // 页面就绪启动
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
