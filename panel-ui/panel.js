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

  // 按失败率降级（自动路由高级项）：范围与 relay-settings.mjs 的同名常量一致，
  // 默认关闭——关闭时自动路由仍只看连续失败次数。
  const DEFAULT_FAILURE_RATE_SAMPLES = 10;
  const MIN_FAILURE_RATE_SAMPLES = 4;
  const MAX_FAILURE_RATE_SAMPLES = 50;
  const DEFAULT_FAILURE_RATE_PERCENT = 60;
  const MIN_FAILURE_RATE_PERCENT = 20;
  const MAX_FAILURE_RATE_PERCENT = 100;
  let failureRateGate = {
    enabled: false,
    samples: DEFAULT_FAILURE_RATE_SAMPLES,
    failPercent: DEFAULT_FAILURE_RATE_PERCENT,
  };
  const historyBuffers = {
    ttft: [],
    tps: [],
    cache: [],
    dsh_ttft: [],
    dsh_tps: [],
    dsh_cache: [],
    qoder_ttft: [],
    qoder_tps: [],
    qoder_cache: [],
  };

  function $(id) { return document.getElementById(id); }
  function escapeHtml(s) {
    return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  // opts.durationMs 覆盖默认 3s 驻留；opts.action = { label, onClick } 在文案后追加
  // 一个可点小字（如「查看差异」）——点中即收起 toast 再执行 onClick
  function toast(msg, isErr, opts) {
    const t = $("toast");
    const action = opts && opts.action;
    if (action) {
      t.textContent = "";
      t.append(document.createTextNode(msg));
      const link = document.createElement("span");
      link.className = "toast-action";
      link.textContent = action.label;
      link.onclick = () => { clearTimeout(t._tid); t.classList.remove("show"); action.onClick(); };
      t.append(link);
    } else {
      t.textContent = msg;
    }
    t.className = "toast" + (isErr ? " err" : "") + " show";
    clearTimeout(t._tid);
    t._tid = setTimeout(() => t.classList.remove("show"), (opts && opts.durationMs) || 3000);
  }

  // /panel/api/* 的失败文本按语言分两种身份：中文句子是为这个界面写的，可以直接
  // 上屏；英文短句是校验语、短码（"cas-conflict"、"pool members must be an array…"）
  // 或系统错误，一律换成调用方自带的中文兜底，原文交给控制台。新增端点文案要落中文，
  // 否则会被当开发者文本吞掉。短码分支一律读 err.code（err.message 带 "HTTP <status>：" 前缀）。
  const PANEL_UI_COPY_RE = /[\u4e00-\u9fff]/;

  function panelCopy(raw, fallback) {
    const text = String(raw == null ? "" : raw);
    return PANEL_UI_COPY_RE.test(text) ? text : fallback;
  }

  function panelError(err, fallback) {
    const raw = (err && err.code) || (err && err.message) || "";
    const text = panelCopy(raw, fallback);
    if (text === fallback) console.warn("[panel] " + fallback + " ← " + raw);
    return text;
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
  function updateSparkline(containerId, dataPoints, minVal, maxVal) {
    const container = $(containerId);
    if (!container) return;
    // B3 路径级 diff：已有正常态 SVG（area+line 两个 path 子节点）时只改 d，
    // d 相同零 DOM 写；空态 1-path SVG 不命中判定，维持现状重建（不劣化）。
    const EMPTY_D = "M0,13 L68,13";
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
      container.innerHTML = '<svg viewBox="0 0 68 26" preserveAspectRatio="none"><path d="M0,13 L68,13" fill="none" stroke="var(--spark-line)" stroke-width="1.5" stroke-dasharray="2,2"/></svg>';
      return;
    }
    const w = 68, h = 26, pad = 3;
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

  function clampFailureRateSamples(n) {
    const parsed = Number.parseInt(n, 10);
    if (!Number.isInteger(parsed) || parsed < MIN_FAILURE_RATE_SAMPLES) return DEFAULT_FAILURE_RATE_SAMPLES;
    return Math.min(MAX_FAILURE_RATE_SAMPLES, parsed);
  }

  function clampFailureRatePercent(n) {
    const parsed = Number.parseInt(n, 10);
    if (!Number.isInteger(parsed) || parsed < MIN_FAILURE_RATE_PERCENT) return DEFAULT_FAILURE_RATE_PERCENT;
    return Math.min(MAX_FAILURE_RATE_PERCENT, parsed);
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
    dsh: [["dshSparkTtft", "dsh_ttft"], ["dshSparkTps", "dsh_tps"], ["dshSparkCache", "dsh_cache"]],
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
  // 左上品牌版本徽标：版本只有一处来源——package.json 经 /api/app-info 下发，
  // 页面里不写死版本号（写死就得每次发版记得手改，漏改即显示过期版本）。
  // 取不到就保持隐藏：宁可没有徽标，也不显示占位符或可能过期的数字。
  async function initBrandVersion() {
    const tag = $("brandVersion");
    if (!tag) return;
    try {
      const info = await api("GET", "/api/app-info");
      const version = info && typeof info.version === "string" ? info.version.trim() : "";
      if (!version) return;
      tag.textContent = "v" + version;
      tag.hidden = false;
    } catch { /* 接口不可达（面板服务换新中）：不显示版本，不进控制台噪音 */ }
  }

  let startupViewReady = Promise.resolve();
  async function init() {
    initTheme();
    initStylePicker();
    initBrandVersion();
    initSettingsView();
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
              : $("sessionsView");
            enteredView.classList.remove("view-enter");
            void enteredView.offsetWidth;
            enteredView.classList.add("view-enter");
            enteredView.addEventListener("animationend", () => enteredView.classList.remove("view-enter"), { once: true });
          }
        };
      }
      await Promise.allSettled([firstStatus, startupViewReady]);
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
  // 装配（子 tab 重置到「通用」并重拉设置项）。设置本身不写入 panel-view。
  let settingsReturnView = "board";
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
    if (document.hidden) return;
    refreshStatus();
    if (currentView === "stats") {
      refreshStatsState({ silent: true });
      return;
    }
    if (!boardVisible()) return;
    refreshAgents();
    refreshModelStability();
  });

  async function refreshStatus() {
    try {
      const res = await api("GET", "/api/status");
      // 记住面板进程身份：请求重启面板后，靠 pid/startTime 变化判定新进程已接管。
      lastPanelIdentity = { pid: res?.pid ?? null, startTime: res?.startTime ?? null };
      const dot = $("topDot");
      const statusText = $("topRelayStatus");
      const sbState = $("sbStateBadge");
      const hostEl = $("sbHost");
      const uptimeEl = $("sbUptime");

      const relay = res && res.relay ? res.relay : { status: res && res.running ? "running" : "stopped" };
      // Drive the start/stop toggle (text + red/blue) from the relay's real state.
      updateRelayControls(relay);

      if (relay.status === "running") {
        dot.className = "pulse-dot running";
        statusText.textContent = `Relay 运行中 (${relay.port || 47821})`;
        sbState.className = "badge badge-ok";
        sbState.textContent = "运行正常";
        hostEl.textContent = `127.0.0.1:${relay.port || 47821}`;
        if (res && res.startTime) {
          uptimeEl.textContent = formatDurationSeconds(Date.now() - res.startTime);
        }
      } else if (relay.status === "starting") {
        dot.className = "pulse-dot starting";
        statusText.textContent = "Relay 启动中...";
        sbState.className = "badge badge-warn";
        sbState.textContent = "启动中";
      } else {
        dot.className = "pulse-dot stopped";
        statusText.textContent = "Relay 已停止";
        sbState.className = "badge badge-danger";
        sbState.textContent = "已停止";
      }
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
    container.append(...cards);
  }

  // ── B1 卡片渲染指纹：数据没变就整卡跳过，不碰 DOM ──
  // 指纹 = routeChainsVer/msModelsCacheVer/routeRuntimeVer/sparkWindowPoints
  // + JSON.stringify(agent)。routeChainsVer 由链配置引用变化驱动（R9：Store tab
  // 改链后 storeState.routingChains 换引用即失配，切回看板另有清表+补刷兜底）。
  const agentRenderFp = {};
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

  // 静态卡（zc/dsh/qoder）端点级陈旧判定：读全局汇总行 lastSeen，口径同实例行。
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

  async function refreshAgents() {
    if (agentsInFlight) return;
    agentsInFlight = true;
    try {
      const res = await api("GET", "/api/agents");
      if (res && res.agents) {
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

  // 端点详情折叠（zcode/dsh/qoder）：运行中默认收起——
  // 详细遥测四宫格换成与多实例端点实例行同构的简要信息栏（含 tokens 行/请求数徽标），
  // 「全局汇总」行改仅展开态显示（与多实例栏 detail-open-only 同范式：收起态 tokens/请求数
  // 已由简要栏承载，双行并存属重复展示）；
  // 展开后换回四宫格。展开态记 localStorage（与 route-fold 同交互语义），刷新不回落；
  // 渲染只拨 *MetricsBlock.hidden，不碰 grid/brief.hidden，故折叠态跨 15s 轮询自然保持；
  // 未运行时折叠钮由 card-collapsed CSS 隐藏。
  // pi/kimi/opencode/codex 已从此旧机制摘除，改走下方 data-prefix 事件委托。
  ["zc", "dsh", "qoder"].forEach((prefix) => {
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
      // 本栏若挂了实例行（DSH），四宫格随折叠态一起收放——与 data-prefix 栏的
      // applyDetailFold 同语义。渲染侧每轮按 isDetailOpen 重画，但数据未变时
      // renderIfChanged 不会重跑，点击瞬间得自己拨一次 hidden。
      const card = grid.closest(".panel-card");
      if (card) card.querySelectorAll(".instance-telemetry-grid").forEach((el) => { el.hidden = !open; });
      foldBtn.setAttribute("aria-expanded", open ? "true" : "false");
      foldBtn.textContent = open ? "收起 ▴" : "展开 ▾";
      // 展开瞬间补绘：折叠期间端点级 buffer 照常累积但不绘制（见 redrawEndpointSparklines），
      // 这里用已攒数据立刻上屏，不等下一轮 1s 轮询。
      if (open) {
        redrawEndpointSparklines(prefix);
        redrawInstanceSparklines(prefix);
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
  // 缓存命中率按 prompt 加权，TTFT 与 lastSeen 取最近有活动的会话。
  function claudeAggregateMetrics(sessions) {
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
  // 供 applyDetailFold（data-prefix 栏）与旧 id 接线栏的 setFold（zcode/dsh/qoder）
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
  let routeChainsFetchedAt = 0;
  let routeNodeInfoCache = null; // { providers: Map<id,name>, pools: Map<id,name> }
  const ROUTE_CHAINS_CACHE_TTL_MS = 60000;

  async function refreshRouteChainsCache() {
    const now = Date.now();
    if (routeChainsCache !== null && now - routeChainsFetchedAt < ROUTE_CHAINS_CACHE_TTL_MS) return;
    try {
      const res = await api("GET", "/api/store/state");
      routeChainsCache = Array.isArray(res.routingChains) ? res.routingChains : [];
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

  // 「启用自动路由」判定（语义=该端点正在用 auto 工作）：端点配了链 且 启用
  // 开关开（entry.enabled !== false；getState 显式下发布尔，缺省=开）且端点
  // 进程在运行（status === "running"）。开关本身就是「正在用 auto 工作」的
  // 声明，不再看活跃/最近模型；命中返回链，供胶囊 auto 标记（renderModelBadges）
  // 判定流量来源，否则返回 null，胶囊保持直连样式。
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
  function capsuleTargetList(st) {
    if (Array.isArray(st?.activeTargets)) {
      const list = (st.activeTargets || [])
        .filter((t) => hasDisplayIdentity(t?.providerId, t?.model))
        .map((t) => ({ providerId: t.providerId || null, model: t.model, active: true, viaAuto: (Number(t.autoCount) || 0) > 0 }));
      if (list.length > 0) return list;
      return hasDisplayIdentity(st.lastProvider, st.lastModel)
        ? [{ providerId: st.lastProvider || null, model: st.lastModel, active: false, viaAuto: Boolean(st.lastViaAuto) }]
        : [];
    }
    const activeList = (st.activeModels || (st.currentModel ? [st.currentModel] : []))
      .filter((m) => hasDisplayIdentity(null, m));
    if (activeList.length > 0) return activeList.map((m) => ({ providerId: null, model: m, active: true, viaAuto: false }));
    return hasDisplayIdentity(null, st.lastModel)
      ? [{ providerId: null, model: st.lastModel, active: false, viaAuto: false }]
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
  function renderModelBadges(listEl, agentId, st) {
    listEl.innerHTML = "";
    const chain = agentUsingAutoRoute(agentId, st);
    const seen = new Set();
    for (const t of capsuleTargetList(st)) {
      const key = (t.providerId || "") + "\u0000" + t.model;
      if (seen.has(key)) continue;
      seen.add(key);
      const mark = autoRouteMarkForTarget(chain, t.providerId, t.model, t.viaAuto);
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
    const sessions = c.sessions || [];
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
      const isGenerating = sessions.some((s) => s.activeRequests > 0 || s.status === "active");
      const agg = claudeAggregateMetrics(sessions);
      renderInstanceRows({ prefix: "cc", listEl: list, instances: sessions, aggregateFallback: buildAggregateFallback(agg, c, isGenerating) });
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
    } else {
      setInstanceCount("cc", 0);
      empty.hidden = false;
      block.hidden = true;
    }
  }

  // DSH 卡分面副行："Web ×1 · TUI ×2"。只有进程扫描能在第一条请求之前分辨面
  // （web 与 TUI 在请求面上同像：同一条 x-agent-id: dsh），命令行里读不出
  // profile 的那一档按「DSH ×n」如实显示，所以副行加总恒等于卡上的进程数。
  function renderDshSurfaceSummary(surfaces) {
    const el = $("dshSurfaceSummary");
    if (!el) return;
    const rows = (Array.isArray(surfaces) ? surfaces : []).filter((s) => s && s.count > 0);
    if (rows.length === 0) {
      el.hidden = true;
      el.textContent = "";
      return;
    }
    el.hidden = false;
    el.textContent = rows.map((s) => `${s.label ?? s.profile ?? "DSH"} ×${s.count}`).join(" · ");
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

      // 实例行：一行 = 一个 DSH 进程（一个 web 进程一行、每个 TUI 终端一行），
      // 行上的面徽标取后端从该进程命令行读出的 profile 名。
      // 不传 aggregateFallback——端点级汇总由本卡的「实时遥测」简要栏与展开态
      // 「全局汇总」行承担（这张卡今天的形状），实例化只多出行、不拆聚合行。
      const instances = Array.isArray(d.instances) ? d.instances : [];
      const instancesWrap = $("dshInstancesWrapper");
      setInstanceCount("dsh", instances.length);
      if (instancesWrap) instancesWrap.hidden = instances.length === 0;
      renderInstanceRows({ prefix: "dsh", listEl: $("dshInstancesList"), instances, showSurface: true });
      renderDshSurfaceSummary(d.surfaces);

      const m = d.metrics || {};
      const sess = (d.sessions && d.sessions[0]) || {};
      // 陈旧端点：速率类置 —、压暗、折线停绘，简要栏换相对时间胶囊；工时等累计量不动。
      const stale = isEndpointStale(d, isGenerating);
      endpointStaleFlags.dsh = stale;
      dimEndpointRateCards("dsh", stale);
      const ttft = m.lastTtftMs || d.lastTtftMs;
      if (!stale && typeof ttft === "number" && ttft > 0) {
        $("dshTtftVal").textContent = (ttft / 1000).toFixed(2);
        $("dshTtftUnit").textContent = "s";
        const color = m.ttftColor || "green";
        $("dshTtftLamp").className = "lamp lamp-" + color;
      } else {
        $("dshTtftVal").textContent = "-";
        $("dshTtftLamp").className = "lamp lamp-gray";
      }

      const tps = m.tps !== undefined ? m.tps : d.tps;
      $("dshTpsVal").textContent = (!stale && typeof tps === "number" && tps > 0) ? tps.toFixed(1) : "-";

      const hit = m.cacheHitRate !== undefined ? m.cacheHitRate : d.cacheHitRate;
      $("dshCacheVal").textContent = (!stale && typeof hit === "number") ? hit.toFixed(1) : "-";

      const dur = m.activeDurationMs || d.activeDurationMs;
      $("dshDurationVal").textContent = formatDurationSeconds(dur);

      const tokens = m.tokens || sess.tokens || {};
      updateDetailBrief("dsh", {
        isGenerating,
        ttft: (typeof ttft === "number" && ttft > 0) ? ttft : null,
        ttftColor: m.ttftColor || "green",
        tps: (typeof tps === "number" && tps > 0) ? tps : null,
        hit: (typeof hit === "number") ? hit : null,
        durationText: formatDurationSeconds(dur),
        staleText: stale ? formatRelativeAge(sess.lastSeen) : null,
        requests: m.totalRequests || d.totalRequests || 0,
        tokensText: `Prompt: ${formatTokens(tokens.prompt)} · Completion: ${formatTokens(tokens.completion)} · Cached: ${formatTokens(tokens.cached)}`,
      });

      if (!stale) {
        pushMetricPoint("dsh_ttft", typeof ttft === "number" ? ttft / 1000 : null, m.sparkHistory?.ttft);
        pushMetricPoint("dsh_tps", tps, m.sparkHistory?.tps);
        pushMetricPoint("dsh_cache", hit, m.sparkHistory?.cache);

        redrawEndpointSparklines("dsh");
      }

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
      renderDshSurfaceSummary([]);
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
      const instances = Array.isArray(p.instances) ? p.instances : [];
      setInstanceCount("kimi", instances.length);
      renderInstanceRows({ prefix: "kimi", listEl: $("kimiInstancesList"), instances, aggregateFallback: buildAggregateFallback(m, p, isGenerating) });
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
  function startLogStream() {
    const body = $("logBody");
    if (es) es.close();
    // 滚动跟随：贴底时自动跟随新日志；上翻查看旧日志即暂停，回到底部自动恢复。
    body.addEventListener("scroll", () => {
      followLogs = body.scrollTop + body.clientHeight >= body.scrollHeight - 24;
    });
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
    // 真清空：服务端缓冲一并清掉，刷新不再复活旧日志，其它打开的面板窗口同步清空。
    $("clearLog").onclick = async () => {
      body.innerHTML = "";
      try { await api("POST", "/api/logs/clear"); } catch {}
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

  function createAboutController({ request, doc, now = () => Date.now(), notify = () => {}, schedule = setTimeout, cancelSchedule = clearTimeout }) {
    const get = (id) => doc.getElementById(id);
    const pending = new Map();
    const remoteCache = new Map();
    const rows = new Map();
    let active = false, environmentGen = 0, updateGen = 0;
    let appInfo = null, local = null, localAt = 0, update = null, updateAt = 0;
    let environmentTask = null, updateTask = null, localFailed = false;
    const products = {
      claude: ["anthropics/claude-code", "@anthropic-ai/claude-code"],
      codex: ["openai/codex", "@openai/codex"],
      opencode: ["anomalyco/opencode", "opencode-ai"],
      pi: ["earendil-works/pi", "@earendil-works/pi-coding-agent"],
      kimi: ["MoonshotAI/kimi-code", "@moonshot-ai/kimi-code"],
      dsh: ["deepseek-ai/deepseek-harness", "@deepseek-ai/dsh"],
      zcode: [], qoder: [],
    };
    // 面板可代管安装/更新的客户端（npm 全局包）。与服务端 client-lifecycle.mjs
    // 的 CLIENT_PACKAGES 保持同一份清单，两者的一致性由 client-lifecycle.test.mjs 钉住；
    // 服务端仍是权威，这里只决定按钮是否出现。zcode/qoder 是桌面应用，走官方更新渠道。
    const updatableClients = new Set(["claude", "codex", "opencode", "pi", "kimi", "dsh"]);
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
          : id === "qoder" ? ["qoder.com", "www.qoder.com", "qoder.com.cn", "www.qoder.com.cn", "docs.qoder.com", "download.qoder.com.cn"] : [];
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
    // 服务端单飞 + npm 全局目录单写者：任一时刻全页面只允许一个任务。
    // 任务在后台跑，这里持 runId 轮询；离开关于页就放弃轮询与本地标记，
    // 服务端会自己跑完，结果由重新检测兜底呈现。
    let lifecycleRun = null; // { clientId, action, runId }
    let lifecyclePoll = null; // 轮询 timer
    let lifecycleGen = 0; // leave() 时 +1，丢弃迟到的轮询回调
    let lifecycleBatch = null; // { queue, results }，批量更新进行中非 null
    let lifecycleModalResolve = null;
    // 该安装项当前能做什么：可更新 > 未安装可安装；桌面应用与状态不明不给动作。
    function installationAction(installation) {
      if (!installation || installation.kind !== "cli") return null;
      const remote = remoteCache.get(cacheKey(installation))?.data;
      if (remote?.state === "ok" && remote.version && validLocal(installation) && remote.comparison === "update_available") {
        return { kind: "update", version: remote.version };
      }
      if (installation.status === "not_found") return { kind: "install" };
      return null;
    }
    function clientName(id) { return local?.clients.find((client) => client.id === id)?.name || id; }
    function updateBatchButton() {
      const button = get("aboutUpdateAll");
      if (!button) return;
      const count = (local?.clients ?? []).filter((client) => updatableClients.has(client.id))
        .filter((client) => client.installations.some((installation) => installationAction(installation)?.kind === "update")).length;
      button.disabled = count === 0 || Boolean(lifecycleRun) || Boolean(lifecycleBatch);
      button.textContent = lifecycleBatch ? "批量更新中…" : count > 0 ? `全部更新 (${count})` : "全部更新";
    }
    function confirmClientUpdate(names, many) {
      get("clientUpdateModalTitle").textContent = many ? `${names.length} 个客户端正在运行` : `${names[0]} 正在运行`;
      get("clientUpdateModalBody").textContent = `${names.join("、")} 正在运行，更新可能失败或打断当前会话。建议先退出后再更新。`;
      get("clientUpdateModal").classList.toggle("show", true);
      return new Promise((resolve) => { lifecycleModalResolve = resolve; });
    }
    function closeLifecycleModal(decision) {
      get("clientUpdateModal").classList.toggle("show", false);
      const resolve = lifecycleModalResolve;
      lifecycleModalResolve = null;
      if (resolve) resolve(decision);
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
    function pollLifecycle(runId) {
      const gen = lifecycleGen;
      return new Promise((resolve, reject) => {
        const step = async () => {
          let status;
          try { status = await fetchOnce(`/api/environment/update/${encodeURIComponent(runId)}`); }
          catch { status = null; }
          if (!active || gen !== lifecycleGen) { reject(Object.assign(new Error("lifecycle abandoned"), { abandoned: true })); return; }
          lifecyclePoll = null;
          if (status?.state === "running") { lifecyclePoll = schedule(step, 1500); return; }
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
      if (lifecycleRun) return { id, outcome: "skipped" };
      lifecycleRun = { clientId: id, action, runId: null };
      renderLocal();
      updateBatchButton();
      try {
        const started = await request("POST", "/api/environment/update", { id, action });
        lifecycleRun.runId = started.runId;
        const status = await pollLifecycle(started.runId);
        reportLifecycleOutcome(status, id);
        return { id, outcome: status?.outcome ?? "unknown" };
      } catch (error) {
        if (!error?.abandoned) {
          if (error?.code === "busy") notify("已有更新任务在进行中，请等待完成后重试", true);
          else notify("更新失败，请重新检测确认结果", true);
        }
        return { id, outcome: "failed" };
      } finally {
        lifecycleRun = null;
        if (lifecyclePoll !== null) { cancelSchedule(lifecyclePoll); lifecyclePoll = null; }
        if (active) { renderLocal(); updateBatchButton(); }
      }
    }
    // 单个动作：本端点在跑先确认，再执行。
    async function updateClient(id, action) {
      if (lifecycleRun || lifecycleBatch || lifecycleModalResolve) return;
      const running = await runningClients([id]);
      if (running.length && !(await confirmClientUpdate(running.map(clientName), false))) return;
      await performLifecycleRun({ id, action });
      if (active) await loadEnvironment(true);
    }
    // 批量：只挑「有新版本」的，不给未安装的客户端静默装机；一次确认后在服务端串行。
    async function startUpdateAll() {
      if (lifecycleRun || lifecycleBatch || lifecycleModalResolve) return;
      const targets = (local?.clients ?? []).filter((client) => updatableClients.has(client.id))
        .filter((client) => client.installations.some((installation) => installationAction(installation)?.kind === "update"))
        .map((client) => ({ id: client.id, action: "update" }));
      if (!targets.length) return;
      const running = await runningClients(targets.map((target) => target.id));
      if (running.length && !(await confirmClientUpdate(running.map(clientName), true))) return;
      lifecycleBatch = { results: [] };
      const batch = lifecycleBatch;
      updateBatchButton();
      for (const target of targets) {
        const result = await performLifecycleRun(target);
        batch.results.push(result);
        if (lifecycleBatch !== batch) return; // 中途离开关于页，批量收尾交给服务端与下次检测
      }
      lifecycleBatch = null;
      if (active) {
        const updated = batch.results.filter((result) => result.outcome === "updated").length;
        const failed = batch.results.length - updated;
        notify(failed ? `批量更新完成：${updated} 个成功，${failed} 个未生效` : `批量更新完成：${updated} 个客户端已更新`, failed > 0);
        updateBatchButton();
        await loadEnvironment(true);
      } else {
        updateBatchButton();
      }
    }
    function renderApp() {
      get("aboutAppVersion").textContent = appInfo?.version || "版本暂时无法读取";
      get("aboutPreviewBadge").hidden = !appInfo?.prerelease;
      const system = local || appInfo;
      if (system) get("aboutSystem").textContent = `${({ win32: "Windows", darwin: "macOS", linux: "Linux" })[system.platform] || "当前系统"} · Node ${system.nodeVersion || "版本未知"}`;
    }
    function renderUpdate(checking = false) {
      const state = update?.state;
      const releaseVersion = update?.release?.version || "";
      const copy = {
        update_available: update?.release?.prerelease ? `发现新预览版 ${releaseVersion}` : `发现新版本 ${releaseVersion}`,
        current: "当前已是最新", ahead: "当前版本领先于已发布版本", no_releases: "暂无发布版本",
        error: "暂时无法检查，请重试", unknown_version: "当前版本无法比较",
      };
      const status = get("aboutUpdateStatus");
      status.textContent = checking ? "正在检查更新…" : copy[state] || "尚未检查更新";
      status.dataset.tone = !checking && state === "error" ? "danger" : !checking && state === "current" ? "ok" : "";
      get("aboutUpdateTime").textContent = update?.checkedAt ? `检查时间 ${timeText(update.checkedAt)}` : "";
      const link = get("aboutReleaseLink");
      const href = !checking && safeLink(update?.release?.url, "app");
      link.hidden = !href;
      if (href) link.href = href; else link.removeAttribute("href");
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
      for (const installation of client.installations) {
        const cached = remoteCache.get(cacheKey(installation));
        const remote = cached?.data;
        const goodRemote = remote?.state === "ok" && !!remote.version;
        const kind = installation.kind === "desktop" ? "桌面" : "CLI";
        const found = installation.status === "found";
        const localStatus = installation.status === "not_found" ? "未找到"
          : !found ? "检测失败"
          : installation.issue === "not_runnable" ? "已安装但无法运行"
          : !validLocal(installation) ? "版本无法读取" : "已发现";
        const line = element("div", "about-version-line");
        line.appendChild(element("span", "about-kind", kind));
        const localSpan = element("span", "about-version", `本地 ${found && installation.version ? installation.version : localStatus}`);
        if (installation.status === "error" || installation.issue === "not_runnable") localSpan.dataset.tone = "danger";
        line.appendChild(localSpan);
        // 无官方版本源的安装项（Grok Build）不查官方版本，官方列直述「自带更新」
        const remoteText = !installation.remoteId ? "自带更新" : goodRemote ? remote.version : loading ? "查询中…" : "查询失败";
        line.appendChild(element("span", "about-version", `官方最新 ${remoteText}`));
        const comparison = goodRemote && validLocal(installation) ? remote.comparison : "unknown";
        const compared = { update_available: "有新版本", current: "与官方最新版本一致", ahead: "本地版本较新" }[comparison];
        // 结果列只说比对结论：没有结论时不重复「本地」列已经显示过的状态词
        const resultText = compared || (goodRemote ? "无法比较版本" : "");
        if (resultText) {
          const result = element("span", "about-result", resultText);
          result.dataset.tone = comparison === "update_available" ? "warn" : comparison === "current" ? "ok" : "";
          line.appendChild(result);
        }
        if (loading && remote) line.appendChild(element("span", "about-meta", "查询中…"));
        // 动作位：本行任务在跑 > 可更新/可安装；其他行有任务时按钮留形但禁用（服务器单飞）。
        if (updatableClients.has(client.id)) {
          let intent = null;
          if (lifecycleRun?.clientId === client.id) {
            intent = { label: lifecycleRun.action === "install" ? "安装中…" : "更新中…", disabled: true };
          } else {
            const act = installationAction(installation);
            if (act) intent = { label: act.kind === "update" ? `更新到 ${act.version}` : "安装", action: act.kind, disabled: Boolean(lifecycleRun) };
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
        detail(`${kind} 路径`, installation.path || "未找到");
        detail(`${kind} 版本来源`, sourceText(installation.versionSource));
        const href = safeLink(remote?.url, installation.remoteId);
        if (href) {
          const target = element("dd", "");
          const link = element("a", "about-link", "查看官方版本");
          link.href = href; link.target = "_blank"; link.rel = "noopener noreferrer";
          target.appendChild(link); list.append(element("dt", "", `${kind} 官方来源`), target);
        }
        if (remote?.checkedAt) detail(`${kind} 查询时间`, timeText(remote.checkedAt));
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
    function enter() {
      if (active) return environmentTask || Promise.resolve();
      active = true;
      if (appInfo) renderApp();
      renderUpdate();
      renderLocal();
      updateBatchButton();
      // 进页自动查一次（非强制、吃后端缓存）：没查过、上次失败、或结果超过 10 分钟才查；
      // 「检查更新」按钮保留 refresh=1 的强制语义
      if (!update || update.state === "error" || now() - updateAt >= 600_000) checkUpdates(false);
      return loadEnvironment();
    }
    function leave() {
      active = false;
      environmentGen++; updateGen++; lifecycleGen++;
      environmentTask = null; updateTask = null;
      // 更新任务交给服务端跑完：离开即放弃轮询与本地标记，结果由下次进页的重新检测呈现
      if (lifecyclePoll !== null) { cancelSchedule(lifecyclePoll); lifecyclePoll = null; }
      lifecycleRun = null;
      lifecycleBatch = null;
      closeLifecycleModal(false);
      busy("aboutEnvironmentRefresh", false, "重新检测", "检测中…");
      busy("aboutCheckUpdates", false, "检查更新", "检查中…");
    }
    get("aboutCheckUpdates").onclick = () => checkUpdates(true);
    get("aboutEnvironmentRefresh").onclick = () => loadEnvironment(true);
    get("aboutUpdateAll").onclick = () => startUpdateAll();
    get("clientUpdateModalCancel").onclick = () => closeLifecycleModal(false);
    get("clientUpdateModalClose").onclick = () => closeLifecycleModal(false);
    get("clientUpdateModalConfirm").onclick = () => closeLifecycleModal(true);
    get("clientUpdateModal").onclick = (event) => { if (event?.target === get("clientUpdateModal")) closeLifecycleModal(false); };
    return { enter, leave, checkUpdates, refresh: () => loadEnvironment(true) };
  }

  // 设置全页视图与各项开关
  function initSettingsView() {
    const keepAliveToggle = $("keepAliveToggle");
    const keepAliveEndpointsWrap = $("keepAliveEndpoints");
    const keepAliveTitle = $("keepAliveTitle");
    const keepAliveDesc = $("keepAliveDesc");
    const followAgentToggle = $("followAgentToggle");
    const injectEffortToggle = $("injectEffortToggle");
    const sparkWindowInput = $("sparkWindowInput");
    const keepAliveRetriesInput = $("keepAliveRetriesInput");
    const failureRateToggle = $("failureRateToggle");
    const failureRateSamplesInput = $("failureRateSamplesInput");
    const failureRatePercentInput = $("failureRatePercentInput");
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
      off: { title: "抗截断", desc: "不做防截断处理，输出即时；各端点偏好保留，重新开启后生效。", toast: "已停用抗截断" },
      enhanced: { title: "抗截断", desc: "整段验证后一次性交付，截断或上游故障会静默重试；代价是回合内看不到逐字输出、失败重试会整段重跑。", toast: "已启用抗截断" },
    };
    let settingsLoadGen = 0;
    const settingsSaving = { keepAlive: false, followAgent: false, injectEffort: false, spark: false, keepAliveRetries: false, keepAliveEndpoints: false, failureRate: false };
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
      if (!keepAliveEndpointsWrap || keepAliveEndpointsWrap.childElementCount > 0) return;
      const board = document.querySelector(".agent-cards-container");
      for (const agentId of AGENT_CARD_ORDER) {
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
    }
    buildKeepAliveEndpoints();

    // 设置入口：页头齿轮切入全页设置视图，退出回到进入前的视图
    const openBtn = $("settingsBtn");
    const exitBtn = $("settingsExitBtn");
    if (openBtn) openBtn.onclick = () => {
      if (currentView !== "settings") settingsReturnView = currentView;
      switchView("settings");
    };
    if (exitBtn) exitBtn.onclick = () => switchView(settingsReturnView);

    // 子 tab：通用 / 自动路由 / 主题 / 关于；进入设置固定落「通用」。
    const about = createAboutController({ request: api, doc: document, notify: toast });
    leaveSettingsView = () => about.leave();
    const settingsSubTabs = {
      general: ["settingsTabGeneral", "settingsPanelGeneral"],
      route: ["settingsTabRoute", "settingsPanelRoute"],
      theme: ["settingsTabTheme", "settingsPanelTheme"],
      about: ["settingsTabAbout", "settingsPanelAbout"],
    };
    function activateSettingsSubTab(which, animate) {
      const selected = settingsSubTabs[which];
      if (!selected || $(selected[0]).classList.contains("active")) return;
      resetPageScroll();
      if (which !== "about") about.leave();
      for (const [name, [tabId, panelId]] of Object.entries(settingsSubTabs)) {
        const on = name === which;
        $(tabId).classList.toggle("active", on);
        $(tabId).setAttribute("aria-selected", String(on));
        $(tabId).tabIndex = on ? 0 : -1;
        $(panelId).hidden = !on;
      }
      if (animate) replayViewEnter($(selected[1]));
      if (which === "theme") captureSettingsMirror();
      // 「自动路由」的配置数据与渠道页同源（store state），进 tab 即刷新一次，
      // 与渠道页每次切入都刷新同语义；渲染在 doRefreshStoreState 内统一完成。
      if (which === "route") refreshStoreState();
      if (which === "about") return about.enter();
    }
    // 主题预览 = 真实看板镜像：克隆看板页当前 DOM（tab 条 + telemetry-view），剥 id
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
      const tabs = document.querySelector("#mainHeadInner nav.view-tabs");
      if (tabs) {
        const tabsClone = tabs.cloneNode(true);
        stripIds(tabsClone);
        const tabsWrap = document.createElement("div");
        tabsWrap.className = "settings-mirror-tabs";
        tabsWrap.appendChild(tabsClone);
        scaleEl.appendChild(tabsWrap);
      }
      const boardClone = board.cloneNode(true);
      boardClone.removeAttribute("hidden");
      stripIds(boardClone);
      scaleEl.appendChild(boardClone);
      // 看板被切走时量不到自身宽度：镜像自然宽以 main 内容宽为准（两者同宽）；
      // 缩放比 = 预览可视宽 / 自然宽，sizer 按缩放后尺寸撑开供 viewport 内滚。
      const mainCs = getComputedStyle(main);
      const naturalW = main.clientWidth - parseFloat(mainCs.paddingLeft) - parseFloat(mainCs.paddingRight);
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
      resetSettingsSubTab();
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
        if (!settingsSaving.injectEffort && injectEffortToggle && d.settings && typeof d.settings.injectThinkingEffort === "boolean") {
          injectEffortToggle.checked = d.settings.injectThinkingEffort;
        }
        if (!settingsSaving.spark) {
          const fromApi = d.sparkWindowPoints ?? d.settings?.sparkWindowPoints;
          sparkWindowPoints = clampSparkWindow(fromApi ?? sparkWindowPoints);
          resetAgentRenderFingerprints(); // B1：视窗宽度变了，卡片须重渲
          if (sparkWindowInput) sparkWindowInput.value = String(sparkWindowPoints);
          Object.values(historyBuffers).forEach(pruneSparkBuffer);
        }
        if (!settingsSaving.failureRate && d.failureRateGate) {
          failureRateGate = readFailureRate(d.failureRateGate);
          applyFailureRateUi(failureRateGate);
        }
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

    function readFailureRate(raw) {
      return {
        enabled: raw?.enabled === true,
        samples: clampFailureRateSamples(raw?.samples),
        failPercent: clampFailureRatePercent(raw?.failPercent),
      };
    }

    function applyFailureRateUi(gate) {
      if (failureRateToggle) failureRateToggle.checked = gate.enabled === true;
      if (failureRateSamplesInput) failureRateSamplesInput.value = String(gate.samples);
      if (failureRatePercentInput) failureRatePercentInput.value = String(gate.failPercent);
    }

    // 一项设置三个控件：任一改动都整段 PATCH 落盘（后端逐字段合并），失败回滚。
    async function persistFailureRate(patch, message) {
      if (settingsSaving.failureRate) return;
      const previous = { ...failureRateGate };
      const next = readFailureRate({ ...failureRateGate, ...patch });
      failureRateGate = next;
      applyFailureRateUi(next);
      settingsSaving.failureRate = true;
      settingsLoadGen += 1;
      try {
        const d = await api("POST", "/api/settings", { failureRateGate: next });
        if (!d.ok) {
          failureRateGate = previous;
          applyFailureRateUi(previous);
          toast("设置保存失败", true);
          return;
        }
        const saved = d.failureRateGate ?? d.settings?.failureRateGate;
        if (saved) {
          failureRateGate = readFailureRate(saved);
          applyFailureRateUi(failureRateGate);
        }
        toast(message);
      } catch (e) {
        failureRateGate = previous;
        applyFailureRateUi(previous);
        toast(panelError(e, "请求失败"), true);
      } finally {
        settingsSaving.failureRate = false;
      }
    }

    function failureRateToggleMessage(gate) {
      return gate.enabled ? "已开启按失败率降级" : "已关闭按失败率降级";
    }

    if (failureRateToggle) {
      failureRateToggle.onchange = () => {
        const next = { ...failureRateGate, enabled: failureRateToggle.checked };
        persistFailureRate(next, failureRateToggleMessage(next));
      };
    }

    if (failureRateSamplesInput) {
      const persist = () => persistFailureRate(
        { samples: failureRateSamplesInput.value },
        "按失败率降级已按最近 " + clampFailureRateSamples(failureRateSamplesInput.value) + " 次请求判断",
      );
      failureRateSamplesInput.onchange = persist;
      failureRateSamplesInput.onkeydown = (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          persist();
        }
      };
    }

    if (failureRatePercentInput) {
      const persist = () => persistFailureRate(
        { failPercent: failureRatePercentInput.value },
        "失败占比达 " + clampFailureRatePercent(failureRatePercentInput.value) + "% 即跳过该渠道",
      );
      failureRatePercentInput.onchange = persist;
      failureRatePercentInput.onkeydown = (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          persist();
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

    loadSettingsState();
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
        const labels = { zcode: "ZCode", claude: "Claude Code", dsh: "DSH", opencode: "OpenCode", pi: "Pi", kimi: "Kimi Code", qoder: "Qoder", codex: "Codex", grok: "Grok Build" };
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
    const playStartupSplash = () => {
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
    // 主头行与设置头行各有一颗亮暗钮：同一状态源（data-theme + panel-theme），
    // 同一套日/月图标逻辑，任一侧切换两侧同步刷新
    const toggles = [
      { btn: $("themeToggle"), sun: $("icoSun"), moon: $("icoMoon") },
      { btn: $("settingsThemeToggle"), sun: $("settingsIcoSun"), moon: $("settingsIcoMoon") },
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
        if (t.sun) t.sun.hidden = !dark;
        if (t.moon) t.moon.hidden = dark;
        t.btn.setAttribute("aria-label", label); t.btn.title = label;
      }
    }
    function setTheme(mode) {
      if (mode === "light" || mode === "dark") document.documentElement.setAttribute("data-theme", mode);
      else document.documentElement.removeAttribute("data-theme");
      try { localStorage.setItem("panel-theme", mode); } catch {}
      syncBtns();
    }
    const saved = localStorage.getItem("panel-theme");
    setTheme(saved === "light" || saved === "dark" ? saved : "auto");
    for (const t of toggles) t.btn.onclick = () => setTheme(currentTheme() === "dark" ? "light" : "dark");
  }

  // 面板主题（设置视图「主题」子 tab 左栏列表，点选即全局生效）
  function initStylePicker() {
    const picker = $("stylePicker");
    if (!picker) return;
    // 「赛博」(neon)、「工业+」(industrial)、「极简」(editorial) 等历史主题均已退役，
    // CSS 片段已随退役删除；历史 localStorage 存档的退役样式
    // 由 <head> 恢复脚本兜底回落 SaaS。
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

  // ── 收藏（迭代3）：relPath 集合，localStorage 持久化（与 panel-view 同模式）。
  // 收藏与选中正交：选中是高光/操作对象，收藏只是标记，跨刷新保留。
  let skillsFavorites = loadSkillsFavorites();
  function loadSkillsFavorites() {
    try {
      const raw = localStorage.getItem("skills-favorites");
      const arr = raw ? JSON.parse(raw) : [];
      return new Set(Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : []);
    } catch { return new Set(); }
  }
  function saveSkillsFavorites() {
    try { localStorage.setItem("skills-favorites", JSON.stringify([...skillsFavorites])); } catch {}
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

  function initSkillsTab() {
    $("tabBoard").onclick = () => switchView("board");
    $("tabSkills").onclick = () => switchView("skills");
    $("skillsPickRepoBtn").onclick = pickSkillsRepo;
    $("skillsImportBtn").onclick = () => importSkillViaPicker("skillsImportBtn", "/api/skills/repo/import-pick");
    $("skillsImportZipBtn").onclick = () => importSkillViaPicker("skillsImportZipBtn", "/api/skills/repo/import-pick-zip");
    $("skillsRefreshBtn").onclick = runSkillsRefreshWithFeedback;
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

  // view-enter 重播：remove → 强制 reflow（复位进行中的动画，连切时重播）→ add →
  // animationend 一次性清类。switchView 的视图入场与设置子 tab 面板切换共用同一套。
  function replayViewEnter(el) {
    el.classList.remove("view-enter");
    void el.offsetWidth;
    el.classList.add("view-enter");
    el.addEventListener("animationend", () => el.classList.remove("view-enter"), { once: true });
  }

  function resetPageScroll() {
    window.scrollTo(0, 0);
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
  }

  function switchView(name) {
    const board = name === "board";
    const store = name === "store";
    const stats = name === "stats";
    const presets = name === "presets";
    const sessions = name === "sessions";
    const settings = name === "settings";
    resetPageScroll();
    currentView = name;
    document.querySelector(".telemetry-view").hidden = !board;
    $("skillsView").hidden = !(name === "skills");
    $("presetsView").hidden = !presets;
    $("storeView").hidden = !store;
    $("statsView").hidden = !stats;
    $("sessionsView").hidden = !sessions;
    $("settingsView").hidden = !settings;
    // 设置是全页视图：主头行（品牌 + 六个主 tab + 状态条）与设置专用头行互斥
    $("mainHeadInner").hidden = settings;
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
        : $("sessionsView");
      replayViewEnter(enteredView);
    }
    // 设置视图不写入 panel-view：刷新后按 restoreView 白名单恢复，永不落设置页
    if (!settings) try { localStorage.setItem("panel-view", name); } catch {}
    let viewReady;
    if (name === "skills") viewReady = refreshSkillsState();
    if (presets) viewReady = refreshPresetsState();
    if (store) viewReady = refreshStoreState();
    if (stats) viewReady = enterStatsView(); else leaveStatsView();
    if (sessions) viewReady = enterSessionsView(); else leaveSessionsView();
    if (settings) viewReady = enterSettingsView(); else leaveSettingsView();
    if (window.panelStartupController && viewReady) startupViewReady = viewReady;
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
  }

  // 看板变体入场（移植 CC Switch 设置页「关于」tab 的 mount 阶梯动画）：容器整体淡入
  // 上浮 10px 立即开始；可见 .panel-card 按文档顺序逐张阶梯——首卡（服务状态）用 scale
  // 变奏、延迟 100ms，其余淡入+上浮、延迟 150ms+i×40ms。隐藏卡（如无链时的路由链卡）
  // 跳过不占延迟位；播完即清，1s 轮询只更新卡片内容不重建节点，不会打断动画。
  function playBoardEnter(view) {
    view.classList.remove("board-enter");
    void view.offsetWidth; // 复位进行中的动画，连切时重播
    view.classList.add("board-enter");
    view.addEventListener("animationend", () => view.classList.remove("board-enter"), { once: true });
    const cards = [...view.querySelectorAll(".panel-card")].filter((el) => !el.hidden);
    cards.forEach((el, i) => {
      const hero = i === 0;
      el.style.setProperty("--board-delay", hero ? "100ms" : `${150 + (i - 1) * 40}ms`);
      el.classList.remove("board-card-enter", "board-card-enter-scale");
      void el.offsetWidth;
      el.classList.add(hero ? "board-card-enter-scale" : "board-card-enter");
      el.addEventListener("animationend", () => el.classList.remove("board-card-enter", "board-card-enter-scale"), { once: true });
    });
  }

  // 刷新页面后留在原 tab（默认看板）；launcher 启动的那一次固定落看板，
  // 刷新与普通访问不受影响，仍按 panel-view 恢复。
  function restoreView() {
    if (window.panelStartupLaunch) return;
    let saved = null;
    try { saved = localStorage.getItem("panel-view"); } catch {}
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
    if (window.panelStartupRestart) {
      // saved 为 "board"/null/无效值时看板是 HTML 默认显示的、不经 switchView，同样
      // 靠这个标记补播。
      restartEnterView = (saved === "skills" || saved === "presets" || saved === "store" || saved === "stats" || saved === "sessions") ? saved : "board";
    }
  }

  // reconcile（每次刷新后）：prune 集合中已消失的 relPath；焦点不在集合内则回退
  // （非空取最后一员，否则 null）。空集合不自动选中——用户清空后刷新不能复活。
  function reconcileSkillsSelection() {
    const skills = (skillsState && skillsState.skills) || [];
    const relPaths = new Set(skills.map((s) => s.relPath));
    for (const k of [...skillsSelection]) if (!relPaths.has(k)) skillsSelection.delete(k);
    if (!skillsSelection.has(skillsFocusKey)) skillsFocusKey = lastSelectionKey();
    // 收藏同步 prune：仓库中已消失的 relPath 不再保留（与选中集合同思路）
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
      pathEl.textContent = skillsState.repoPath + "（不存在或不含任何 skill）";
    } else {
      badge.className = "badge badge-ok";
      badge.textContent = (skillsState.skills || []).length + " 个 skill";
      pathEl.textContent = skillsState.repoPath;
    }
    // 仓库计数变化时闪一下（只读不消费；最后渲染的 renderSkillsList 负责消费）
    if (skillsFlashCount) { badge.classList.remove("badge-flash"); void badge.offsetWidth; badge.classList.add("badge-flash"); }
    const candidates = (skillsState && skillsState.candidates) || [];
    const usable = candidates.filter((c) => c.exists && c.path !== (skillsState && skillsState.repoPath));
    candEl.innerHTML = usable.length
      ? usable.map((c) => `<button class="btn btn-mini" data-cand="${escapeHtml(c.path)}" title="${escapeHtml(c.path)}">使用 ${escapeHtml(shortHomePath(c.path))}</button>`).join("")
      : "";
    candEl.querySelectorAll("button[data-cand]").forEach((btn) => {
      btn.onclick = () => setSkillsRepo(btn.getAttribute("data-cand"));
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

  async function setSkillsRepo(path) {
    try {
      const d = await api("POST", "/api/skills/repo", { repoPath: path });
      toast(`主仓库已设置（${d.skillCount} 个 skill）`);
    } catch (e) {
      toast(panelError(e, "设置主仓库失败"), true);
    }
    refreshSkillsState();
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
    // 分母只计已启用端点（目录存在的）；未启用端点不可部署，计入会稀释口径。
    const enabledEps = endpoints.filter((ep) => ep.dirExists);
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
            `已部署 ${eps.length}/${enabledEps.length} 个端点`
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
      bodyHtml: `将把 <b>${escapeHtml(skill.dirName)}</b> 从主仓库移入回收站，并清除所有端点上指向它的链接。端点上的真实目录不受影响。`,
      confirmText: "移入回收站",
      onConfirm: async () => {
        let removed = [];
        try {
          const d = await api("POST", "/api/skills/repo/delete", { skillName: skill.dirName });
          toast(d.unlinked && d.unlinked.length ? `已删除，并清除 ${d.unlinked.length} 处端点链接` : "已删除");
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
      body.innerHTML = '<div class="empty-hint">从左侧列表选择一个 skill，查看详情并管理端点部署</div>';
      return;
    }
    const endpoints = (skillsState && skillsState.endpoints) || [];
    const rows = endpoints.map((ep) => {
      const junctions = (ep.entries || []).filter((e) => e.kind === "junction");
      const deployed = junctions.some((e) => !e.broken && e.repoSkill === skill.dirName);
      const stateBadge = !ep.dirExists
        ? '<span class="badge badge-neutral">未启用</span>'
        : deployed
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
        <span>部署到端点</span>
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

  // 部署/解除的共用核心：对 skills × 各自目标端点串行调单点接口。
  // 未启用端点跳过、已是目标状态跳过；部署遇本地冲突不强制、计数跳过
  // 留给用户逐条处理（与单点 toggle 的冲突语义一致）。返回计数由调用方包装 toast。
  async function runDeployBatch(skills, on) {
    let okCount = 0, conflictCount = 0, failCount = 0, targetCount = 0;
    for (const skill of skills) {
      const endpoints = (skillsState && skillsState.endpoints) || [];
      const targets = endpoints.filter((ep) => {
        if (!ep.dirExists) return false;
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

  // 一键全开/关：单 skill × 所有端点，复用 runDeployBatch。
  async function setAllDeployments(skill, on, btn) {
    if (btn) btn.disabled = true;
    const { okCount, conflictCount, failCount, targetCount } = await runDeployBatch([skill], on);
    if (!targetCount) {
      toast(on ? "已启用的端点都已部署" : "没有已部署的端点");
    } else {
      const parts = [on ? `已部署到 ${okCount} 个端点` : `已解除 ${okCount} 个端点`];
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
        { label: "部署选中项到所有端点", fn: () => batchSetDeployments(true) },
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
        { label: "部署到所有端点", fn: () => setAllDeployments(skill, true, null) },
        { label: "从所有端点解除", fn: () => setAllDeployments(skill, false, null) },
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
        ? "以下端点目录与主仓库内容一致，不复制文件：端点上的真实目录将移入回收站（可恢复），原位改为指向主仓库副本的链接。"
        : "以下端点目录将逐项复制到主仓库（.git 除外），随后端点上的真实目录移入回收站（可恢复），原位改为链接。")
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

  // 删除端点本地实体目录（回收站语义，禁止硬删，走 /api/skills/local/delete）。
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
    if (uniqCount < items.length) notes.push("一致可迁移项主仓库仍有副本，删除端点目录不影响仓库内容。");
    showSkillsModal({
      title: items.length === 1 ? "删除端点本地目录" : `删除选中的 ${items.length} 个端点目录`,
      danger: true,
      bodyHtml: `将把以下端点上的实体目录移入回收站：<div style="margin-top:8px;">${listHtml}</div><div style="margin-top:8px; color:var(--danger);">${notes.join("<br>")}</div>`,
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
          : `已删除 ${okCount} 个端点目录`, failCount > 0);
        anomalyChecked.matching.clear();
        anomalyChecked.unique.clear();
        // 乐观更新：回收站删除每条约 1-3s，先把成功项从本地 state 移除并立即
        // 重渲染让列表即时反映，随后 refreshSkillsState 与服务端真实状态对齐
        if (okItems.length && skillsState && skillsState.endpoints) {
          const removed = new Set(okItems.map((it) => `${it.ep.id}\x01${it.entry.name}`));
          for (const ep of skillsState.endpoints) {
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
      bodyHtml: `将把以下 skill 从主仓库移入回收站，并清除所有端点上指向它们的链接。端点上的真实目录不受影响。<div style="margin-top:8px;">${listHtml}</div>${skippedNote}`,
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

  // ── 卡片 D：端点条目与异常（跨端点全局聚合，右列下） ──
  function renderSkillsAnomalies() {
    const body = $("skillsAnomalyBody");
    const badge = $("skillsAnomalyBadge");
    const endpoints = (skillsState && skillsState.endpoints) || [];
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
      body.innerHTML = '<div class="empty-hint">没有异常或端点条目</div>';
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
        `<div class="skills-group-title"${sections.length ? "" : firstStyle}>分叉冲突（端点与仓库同名但内容不同）</div>` +
        diverged.map(({ ep, entry }) => rowHtml(ep, entry,
          '<span class="badge badge-danger">分叉冲突</span>',
          `<button class="btn btn-mini" data-diff="${key(ep, entry)}">查看差异</button>` +
          `<button class="btn btn-mini" data-resolve-repo="${key(ep, entry)}">以主仓库覆盖端点</button>` +
          `<button class="btn btn-danger btn-mini" data-resolve-local="${key(ep, entry)}">以端点覆盖主仓库</button>`)).join(""),
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

    body.querySelectorAll("button[data-remove-broken]").forEach((btn) => {
      btn.onclick = () => removeBrokenJunction(...btn.getAttribute("data-remove-broken").split(SEP));
    });
    body.querySelectorAll("button[data-diff]").forEach((btn) => {
      btn.onclick = () => showLocalDiff(...btn.getAttribute("data-diff").split(SEP));
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
      bodyHtml: `将移除端点 <b>${escapeHtml(endpointId)}</b> 上指向 <b>${escapeHtml(skillName)}</b> 的失效链接（只删链接，不影响任何真实目录）。`,
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

  async function showLocalDiff(endpointId, skillName) {
    try {
      const diffs = await fetchLocalDiffs(endpointId, skillName);
      showSkillsModal({
        title: `差异：${skillName}`,
        danger: false,
        bodyHtml: `端点 <b>${escapeHtml(endpointId)}</b> 的实体目录与主仓库同名 skill 的内容差异：${diffListHtml(diffs) || "（无差异）"}`,
        confirmText: "知道了",
        onConfirm: null,
      });
    } catch (e) {
      toast(panelError(e, "获取差异失败"), true);
    }
  }

  // 分叉冲突的两个显式方向；两个方向的终态都是端点目录变 junction 指向主仓库。
  async function resolveConflict(endpointId, skillName, direction) {
    const isRepo = direction === "repo";
    let diffs = [];
    try {
      diffs = await fetchLocalDiffs(endpointId, skillName);
    } catch { /* 差异取不到也允许继续，确认框少一份清单而已 */ }
    showSkillsModal({
      title: isRepo ? "以主仓库覆盖端点" : "以端点覆盖主仓库",
      danger: true,
      bodyHtml: isRepo
        ? `端点 <b>${escapeHtml(endpointId)}</b> 上的真实目录 <b>${escapeHtml(skillName)}</b> 将移入回收站，并改为链接指向主仓库版本。${diffListHtml(diffs)}`
        : `主仓库中的 <b>${escapeHtml(skillName)}</b> 旧版本将先移入回收站（可恢复），再以端点 <b>${escapeHtml(endpointId)}</b> 的内容覆盖；其他端点指向该 skill 的链接会自动跟到新内容。${diffListHtml(diffs)}`,
      confirmText: isRepo ? "覆盖端点" : "覆盖主仓库",
      onConfirm: async () => {
        try {
          await api("POST", "/api/skills/resolve-conflict", { endpointId, skillName, direction });
          toast(isRepo ? "已以主仓库版本覆盖端点" : "已以端点版本覆盖主仓库（旧版在回收站）");
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
        toast(`已部署到 ${endpointId}`);
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
    return kind === "only-a" ? "仅仓库有" : kind === "only-b" ? "仅端点有" : "内容不同";
  }

  function diffListHtml(diffs) {
    if (!diffs.length) return "";
    return `<div class="skills-diff-list">${diffs.map((d) =>
      `<div class="skills-diff-row"><span>${escapeHtml(d.path)}</span><span>${diffKindLabel(d.kind)}</span></div>`
    ).join("")}</div>`;
  }

  function showDeployConflict(endpointId, skillName, diffs) {
    showSkillsModal({
      title: "端点目录与仓库不一致",
      danger: true,
      bodyHtml: `端点 <b>${escapeHtml(endpointId)}</b> 上已存在同名的真实目录 <b>${escapeHtml(skillName)}</b>，内容与仓库不同。确认替换会将该目录移入回收站，并改为链接指向仓库版本。${diffListHtml(diffs)}`,
      confirmText: "替换为仓库版本",
      onConfirm: async () => {
        try {
          await api("POST", "/api/skills/deploy", { endpointId, skillName, force: true });
          toast(`已替换并部署到 ${endpointId}`);
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
    showSkillsModal({
      title: isMatching ? "转为主仓库托管" : "导入主仓库",
      danger: false,
      bodyHtml: isMatching
        ? `端点 <b>${escapeHtml(endpointId)}</b> 上的目录 <b>${escapeHtml(skillName)}</b> 与主仓库内容一致，不会复制文件：端点上的真实目录将移入回收站（可恢复），原位改为链接指向主仓库副本，此后以主仓库为唯一来源。`
        : `将把端点 <b>${escapeHtml(endpointId)}</b> 上的目录 <b>${escapeHtml(skillName)}</b> 复制到主仓库（.git 除外），随后端点上的真实目录移入回收站（可恢复），原位改为链接，此后其他端点也可部署该 skill。`,
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
              bodyHtml: `仓库中的 <b>${escapeHtml(skillName)}</b> 与端点上的版本内容不同，未做任何改动。请用「分叉冲突」分区的两个方向按钮处理。${diffListHtml(d.diffs || [])}`,
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
  function showSkillsModal({ title, bodyHtml, confirmText, danger, wide, onConfirm }) {
    $("storeAddPoolCtl")?.remove(); // 新增渠道弹窗注入标题的建池控件，防跨弹窗残留
    $("skillsModalTitle").textContent = title;
    $("skillsModalBody").innerHTML = bodyHtml;
    const btn = $("skillsModalConfirmBtn");
    btn.textContent = confirmText || "确认";
    btn.disabled = false; // 上一弹窗可能停在「处理中…」禁用态（回调内改开新弹窗的路径）
    btn.className = "btn" + (danger ? " btn-danger" : " btn-primary");
    skillsModalConfirm = onConfirm || null;
    skillsModalGen++;
    $("skillsModal").classList.toggle("skills-modal-wide", !!wide); // 仅正文查阅加宽
    $("skillsModal").classList.add("show");
  }

  function hideSkillsModal() {
    if (skillsModalBusy) return; // 确认处理中：忽略遮罩点击与关闭按钮
    $("skillsModal").classList.remove("show");
    skillsModalConfirm = null;
  }

  // ══════════════════════════════════════════════════════════════════
  // 预设管理 tab（预设 = 预注入到各端点全局指令文件的 prompt 文本）
  // 完全照 skills 范式：单选（选中即焦点）驱动右侧详情卡，行内不放操作按钮，
  // 编辑/删除走详情卡按钮 + 右键菜单；端点注入开关在详情卡内逐端点 toggle。
  // 布局/样式零新增类，全量复用 skills-*/store-form-* 既有类（皮肤自动生效）。
  // ══════════════════════════════════════════════════════════════════
  let presetsState = null;       // GET /panel/api/prompts/state 最近一次结果
  let presetsSelection = null;   // 单选：选中预设 id（选中即焦点，驱动详情卡）
  let presetsFilter = "";

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
      if (firstLoad && presetsSelection === null) {
        const first = (res.presets || [])[0];
        if (first) presetsSelection = first.id;
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

  // reconcile（每次刷新后）：选中项已消失则回落首项（无条目则清空）
  function reconcilePresetsSelection() {
    if (presetsSelection === null) return;
    const presets = (presetsState && presetsState.presets) || [];
    if (!presets.some((p) => p.id === presetsSelection)) {
      presetsSelection = presets.length ? presets[0].id : null;
    }
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
    // 单选（选中即焦点）：左键选中/再点取消；点列表空白处清空选中
    $("presetsList").addEventListener("click", (e) => {
      // 拖拽重排落位后的合成 click：吞掉，不当成选中操作
      if (suppressPresetClick) { suppressPresetClick = false; return; }
      const row = e.target.closest("[data-preset]");
      if (!row) {
        if (presetsSelection !== null) {
          presetsSelection = null;
          renderPresetsList();
          renderPresetDetail();
        }
        return;
      }
      const id = row.getAttribute("data-preset");
      presetsSelection = presetsSelection === id ? null : id;
      renderPresetsList();
      renderPresetDetail();
    });
    // 右键菜单（复用 skills 菜单基建 popSkillsContextMenu）：编辑 / 启用|停用 / 删除
    $("presetsList").addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const row = e.target.closest("[data-preset]");
      if (!row) return;
      const id = row.getAttribute("data-preset");
      if (presetsSelection !== id) {
        presetsSelection = id;
        renderPresetsList();
        renderPresetDetail();
      }
      const preset = ((presetsState && presetsState.presets) || []).find((p) => p.id === id);
      if (!preset) return;
      popSkillsContextMenu(e.clientX, e.clientY, preset.title, [
        { label: "编辑", fn: () => showPresetFormModal(preset) },
        { label: preset.enabled ? "停用" : "启用", fn: () => setPresetEnabled(preset, !preset.enabled) },
        { label: "删除", danger: true, fn: () => confirmDeletePreset(preset) },
      ]);
    });
    $("presetsList").addEventListener("scroll", hideSkillsContextMenu);
    // Esc 收起右键菜单（skills 的全局 keydown 只在 skills/store 视图生效，这里补 presets）
    document.addEventListener("keydown", (e) => {
      if ($("presetsView").hidden) return;
      if (e.key === "Escape" && $("skillsCtxMenu")) {
        hideSkillsContextMenu();
        e.preventDefault();
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
  // 用「全部预设」正文总长给卡片头占用条上色/出数（与过滤集无关）
  function paintCtxMeter(presets) {
    const meter = $("ctxMeter");
    if (!meter) return;
    const total = (presets || []).reduce((s, p) => s + presetCharCount(p), 0);
    const pct = total / CTX_BUDGET;
    const tier = ctxTierOf(pct);
    meter.setAttribute("data-tier", tier);
    const fill = $("ctxFill");
    if (fill) fill.style.width = (tier === "empty" ? 0 : Math.min(pct, 1) * 100) + "%";
    const totalEl = $("ctxTotal"), pctEl = $("ctxPct"), bar = $("ctxBar");
    if (totalEl) totalEl.textContent = formatChars(total);
    if (pctEl) pctEl.textContent = Math.round(pct * 100) + "%";
    if (bar) bar.setAttribute("title",
      `预设注入正文合计 ${total.toLocaleString()} 字，占上下文预算 ${CTX_BUDGET.toLocaleString()} 字的 ${Math.round(pct * 100)}%（${CTX_TIER_NAME[tier]}）`);
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
        : `<span class="skills-ep-count${n >= epTotal ? " full" : n ? " some" : ""}" title="注入 ${n}/${epTotal} 个端点">${n}/${epTotal}</span>`;
      const chars = presetCharCount(p);
      const lenBadge = `<span class="badge ctx-preset-badge ${presetBadgeClass(chars)}" title="正文 ${chars} 字">${formatCharsCompact(chars)}</span>`;
      const tagBadge = p.tag ? `<span class="badge badge-neutral">${escapeHtml(p.tag)}</span>` : "";
      const firstLine = (p.content || "").split("\n").find((l) => l.trim()) || "（无内容）";
      // 未启用的预设行整体压暗（内联透明度）；--i 供 cascade 交错（窗口内重基见 playSkillsListCascade）
      const rowStyle = (p.enabled ? "" : "opacity:0.55;") + "--i:" + i;
      return `<div class="skills-list-row${presetsSelection === p.id ? " selected" : ""}" style="${rowStyle}" data-preset="${escapeHtml(p.id)}" data-preset-index="${i}"${drag}>
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
    const preset = presets.find((p) => p.id === presetsSelection) || null;
    // 无选中时整卡收起；empty-hint 仅作结构兜底（与 skills 详情卡同手法）
    const card = body.closest(".panel-card");
    if (card) card.hidden = !preset;
    if (!preset) {
      body.innerHTML = '<div class="empty-hint">从左侧列表选择一个预设，查看详情并管理端点注入</div>';
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
        <span>注入到端点</span>
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

  // 全部注入/全部解除：对 9 端点串行走 override，已是目标状态的端点跳过
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
      toast(failed ? `完成 ${changed} 个端点，失败 ${failed} 个` : (on ? "已全部注入" : "已全部解除"), failed > 0);
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
      bodyHtml: `将删除预设 <b>${escapeHtml(preset.title)}</b>，并从所有端点全局指令文件中移除其注入内容。`,
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
      <div class="store-form-row"><label class="store-form-label">正文（预注入到各端点全局指令文件）</label>
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
            if (created?.preset?.id) presetsSelection = created.preset.id;
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
  async function doRefreshStoreState() {
    try {
      const [res, stab] = await Promise.all([
        api("GET", "/api/store/state"),
        api("GET", "/api/model-stability").catch(() => null), // 稳定性拉取失败不挡渠道配置加载
      ]);
      if (stab) storeAvailability = buildStoreAvailability(stab.models);
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
      renderStoreOverview();
      renderRouteChains();
      renderStoreList();
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
    const failed = (rr && rr.failed) || [];
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

  function renderStoreDetail() {
    const body = $("storeDetailBody");
    const row = storeFocusRow();
    $("storeDetailTitle").textContent = row && row.kind === "pool" ? "号池详情" : "渠道详情";
    if (!row) {
      body.innerHTML = `<div class="skills-list-desc" style="padding:8px 0;">选择左侧渠道查看详情</div>`;
      return;
    }
    if (row.kind === "pool") {
      renderPoolDetail(row);
      return;
    }
    renderProviderDetail(row.p, body);
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
    if (highlight) consumeStoreNewModels(p.id);
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
    const failed = [];
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
          failed.push(`${label}：${panelError(e, "连不上")}`);
          setStoreRefreshStatus("正在测试连接..", "busy",
            `<span class="srs-neg">${escapeHtml(label)} 连不上</span>${prog}`);
        }
      }
      const last = labelMap.get(ids[ids.length - 1]) || ids[ids.length - 1];
      if (!failed.length) {
        const tail = multi
          ? `<span class="srs-pos">${ok} 个渠道全部可用</span>`
          : `<span class="srs-pos">${escapeHtml(last)} 可用</span>`;
        setStoreRefreshStatus("测试完成", "done", tail);
        toast(multi ? `${ok} 个渠道全部可用` : `${last} 可用`);
      } else {
        setStoreRefreshStatus("测试完成", "err",
          `<span class="srs-neg">${ok} 个可用、${failed.length} 个连不上（${escapeHtml(failed.join("；"))}）</span>`);
        toast(multi
          ? `${ok} 个渠道可用、${failed.length} 个连不上（${failed.join("；")}）`
          : `${failed.join("；")}`, true);
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
  // 10s 淡出计时：弹窗打开期间暂停（计时器清掉、不重新武装），关闭弹窗时
  // 若状态小字仍可见则重新武装一个完整 10s
  function armStoreStatusTimer() {
    const el = $("storeRefreshStatus");
    if (storeStatusTimer) { clearTimeout(storeStatusTimer); storeStatusTimer = null; }
    storeStatusTimer = setTimeout(() => {
      el.classList.remove("show");
      storeStatusTimer = null;
    }, 10000);
  }
  function disarmStoreStatusTimer() {
    if (storeStatusTimer) { clearTimeout(storeStatusTimer); storeStatusTimer = null; }
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
  // opts.wholeLabel（号池详情传入）= 单单元且循环中不更新 tail，只显示
  // 「正在刷新.. 池名」。进行中：状态小字 = 窄波的「正在刷新..」前缀 + 单元
  // 结果（结构化着色，只摆增减数字），结果保留显示到下一单元刷完，窄波效果
  // 贯穿长时程刷新全程；全部完成后 = 整体高光「刷新完成」+ tail 保留最后一个
  // 单元结果，完成态不整行染红。
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
      displayName: $("storeAddName")?.value.trim() ?? "",
      baseURLs: $("storeAddUrls")?.value.trim() ?? "",
      modelIdsText: $("storeAddModels")?.value ?? "",
      sets: [],
    };
    body.querySelectorAll(".store-add-set").forEach((setEl) => {
      v.sets.push({
        id: setEl.querySelector(".set-id").value.trim(),
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
        <div class="store-form-row"><label class="store-form-label">渠道 ID（字母数字 . _ -，不可含 /）</label>
          <input class="store-form-input set-id" value="${escapeHtml(s.id || "")}" placeholder="如 myprovider-${k + 1}"></div>
        <div class="store-form-row"><label class="store-form-label">显示名</label>
          <input class="store-form-input set-name" value="${escapeHtml(s.displayName || "")}"></div>
        <div class="store-form-row"><label class="store-form-label">Base URL${k === 0 ? "（逗号分隔，首个为主、其余为回退；不写协议默认 https，需要 http 时显式以 http:// 开头）" : "（留空 = 与资料 1 一致）"}</label>
          <input class="store-form-input set-urls" value="${escapeHtml(s.baseURLs || "")}" placeholder="${k === 0 ? "https://api.example.com/v1" : "留空 = 与资料 1 一致"}"></div>
        <div class="store-form-row"><label class="store-form-label">API 密钥（仅本机加密保存，保存后不再显示）</label>
          <input class="store-form-input set-key" type="password" autocomplete="new-password"></div>
        <div class="store-form-row"><label class="store-form-label">模型 IDs（可选，每行一个；留空则在线发现）</label>
          <textarea class="store-form-textarea set-models">${escapeHtml(s.modelIdsText || "")}</textarea></div>
      </div>`;
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
        <div class="store-form-row"><label class="store-form-label">渠道 ID（字母数字 . _ -，不可含 /）</label>
          <input class="store-form-input" id="storeAddId" value="${escapeHtml(v.id || "")}" placeholder="如 myprovider"></div>
        <div class="store-form-row"><label class="store-form-label">显示名</label>
          <input class="store-form-input" id="storeAddName" value="${escapeHtml(v.displayName || "")}" placeholder="如 My Provider"></div>
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
      // 校验/发现失败：保留已填内容重开弹窗并展示错误（密钥不回填）
      showAddModal({ id, displayName, baseURLs, modelIdsText });
      const err = $("storeAddError");
      err.hidden = false;
      err.textContent = /provide modelIds/.test(e.code || "")
        ? "在线发现没拿到模型列表，请在「模型 IDs」里手填后重试"
        : panelError(e, "渠道添加失败");
      if (e.code === "cas-conflict") await refreshStoreState();
    }
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
      for (const createdId of created) {
        try {
          await api("POST", "/api/store/delete", { id: createdId });
        } catch { /* 回滚尽力而为，残留渠道用户可手动删 */ }
      }
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
        await rollback();
        fail(`第 ${s.k} 份资料：${/provide modelIds/.test(e.code || "") ? "在线发现没拿到模型列表，请在「模型 IDs」里手填后重试" : panelError(e, "渠道创建失败")}（已回滚 ${created.length} 个已建渠道）`);
        await refreshStoreState();
        return;
      }
    }
    try {
      await api("POST", "/api/store/pool/create", { poolId, displayName, members: created });
    } catch (e) {
      await rollback();
      fail(`${panelError(e, "号池创建失败")}（已回滚 ${created.length} 个已建渠道）`);
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
    showSkillsModal({
      title: `删除渠道 ${p.displayName}`,
      danger: true,
      confirmText: "确认删除",
      bodyHtml: `<div style="font-size:12.5px; line-height:1.7;">
        将从渠道管理删除渠道 <b>${escapeHtml(p.id)}</b>（${p.modelCount} 个有效模型），
        并删除它在主机上的加密凭据。<br>
        凭据删除是唯一不可恢复的步骤；渠道删除失败时凭据会原样保留。</div>`,
      onConfirm: async () => {
        await storeAction("/api/store/delete", { id: p.id },
          (r) => `已删除 ${p.id}（${r.modelCount} 个模型）`);
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
    showSkillsModal({
      title: `删除渠道 ${p.displayName}`,
      danger: true,
      confirmText: "确认删除",
      bodyHtml: `<div style="font-size:12.5px; line-height:1.7;">
        将从渠道管理删除渠道 <b>${escapeHtml(p.id)}</b>（${p.modelCount} 个有效模型），
        并删除它在主机上的加密凭据。<br>
        该渠道属于号池 <b>${escapeHtml(poolName)}</b>，删除后会自动移出号池${dissolving ? "；号池只剩 1 个成员，将一并解除" : ""}。<br>
        凭据删除是唯一不可恢复的步骤；渠道删除失败时凭据会原样保留。</div>`,
      onConfirm: async () => {
        await storeAction("/api/store/delete", { id: p.id },
          (r) => `已删除 ${p.id}（${r.modelCount} 个模型）`);
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
    showSkillsModal({
      title: `解除号池 ${row.displayName}`,
      confirmText: "解除号池",
      bodyHtml: `<div style="font-size:12.5px; line-height:1.7;">
        号池 <b>${escapeHtml(row.id)}</b> 解除后，成员渠道 ${row.members.map((m) => `<b>${escapeHtml(m.id)}</b>`).join("、")}
        退回各自独立渠道状态；渠道、模型与凭据均保留。</div>`,
      onConfirm: async () => {
        await storeAction("/api/store/pool/delete", { poolId: row.id }, `已解除号池：${row.displayName}`);
      },
    });
  }

  // 删除号池（两步语义）：先解除号池，再逐个删除成员渠道及凭据
  function confirmDeletePool(row) {
    showSkillsModal({
      title: `删除号池 ${row.displayName}`,
      danger: true,
      confirmText: "确认删除",
      bodyHtml: `<div style="font-size:12.5px; line-height:1.7;">
        将<b>先解除号池</b> ${escapeHtml(row.id)}，再逐个删除 ${row.members.length} 个成员渠道及其凭据文件：<br>
        ${row.members.map((m) => `· ${escapeHtml(m.id)}（${m.modelCount} 个有效模型）`).join("<br>")}<br>
        凭据删除是唯一不可恢复的步骤。</div>`,
      onConfirm: async () => {
        await deletePoolAndMembers(row);
      },
    });
  }
  async function deletePoolAndMembers(row) {
    const failed = [];
    try {
      await api("POST", "/api/store/pool/delete", { poolId: row.id });
    } catch (e) {
      failed.push(`号池 ${row.id} 解除失败：${panelError(e, "操作未完成")}`);
    }
    let deleted = 0;
    for (const m of row.members) {
      try {
        await api("POST", "/api/store/delete", { id: m.id });
        deleted++;
      } catch (e) {
        failed.push(`${m.id}：${panelError(e, "删除未完成")}`);
      }
    }
    if (failed.length) toast(`部分删除失败（已删 ${deleted}/${row.members.length}）：${failed.join("；")}`, true);
    else toast(`已删除号池 ${row.displayName} 及 ${deleted} 个成员渠道`);
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
        凭据删除是唯一不可恢复的步骤。</div>`,
      onConfirm: async () => {
        const failed = [];
        for (const row of poolRows) {
          try {
            await api("POST", "/api/store/pool/delete", { poolId: row.id });
          } catch (e) {
            failed.push(`号池 ${row.id} 解除失败：${panelError(e, "操作未完成")}`);
          }
        }
        let deleted = 0;
        for (const id of providerIds) {
          try {
            await api("POST", "/api/store/delete", { id });
            deleted++;
          } catch (e) {
            failed.push(`${id}：${panelError(e, "操作未完成")}`);
          }
        }
        if (failed.length) toast(`部分删除失败（已删 ${deleted}/${providerIds.length}）：${failed.join("；")}`, true);
        else toast(`已删除 ${deleted} 个渠道${poolRows.length ? `（含 ${poolRows.length} 个号池）` : ""}`);
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
      await api("POST", apiPath, payload);
      $("poolBuildModal").classList.remove("show");
      toast(okMsg);
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

  let routeChainEndpointId = null;   // 编辑器当前端点
  let routeChainDraft = [];          // 编辑中的链 [{node, model}]
  let routeChainCandModels = {};     // 候选区模型下拉选择（nodeId -> modelId），重渲染后保留
  let routeChainBusy = false;

  function storeRoutingChains() {
    return (storeState && storeState.routingChains) || [];
  }
  function storeRoutingChainFor(endpointId) {
    const entry = storeRoutingChains().find((c) => c.endpointId === endpointId);
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

  // ── 设置「自动路由」tab：九端点瓦片墙（每端点一枚瓦片，三列网格） ──
  function renderRouteChains() {
    const grid = $("routeChainGrid");
    if (!grid) return;
    const byEp = new Map(storeRoutingChains().map((c) => [c.endpointId, c]));
    let configured = 0;
    grid.innerHTML = ROUTE_CHAIN_ENDPOINTS.map((ep) => {
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
            <label class="toggle" title="启用自动路由：开 = 该端点暴露虚拟模型 auto 并按链退避；关 = 链配置保留但 auto 不暴露"><input type="checkbox" data-route-enabled="${ep}"${enabled ? " checked" : ""}><span class="slider"></span></label>
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
  }

  function confirmRouteChainDelete(endpointId) {
    const label = routeChainEndpointLabel(endpointId);
    showSkillsModal({
      title: `删除路由链 — ${label}`,
      danger: true,
      confirmText: "确认删除",
      bodyHtml: `<div style="font-size:12.5px; line-height:1.7;">
        删除后端点 <b>${escapeHtml(label)}</b> 请求模型 <b>auto</b> 将不再走链式路由（回退到常规渠道解析）；渠道与号池本身不受影响。</div>`,
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
    routeChainEndpointId = endpointId;
    const saved = storeRoutingChainFor(endpointId);
    routeChainDraft = saved ? saved.map((it) => ({ node: it.node, model: it.model })) : [];
    routeChainCandModels = {};
    renderRouteChainBody();
    $("routeChainModal").classList.add("show");
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
  function renderRouteStageHtml(opts) {
    const enterAnim = !!(opts && opts.enterAnim);
    const items = routeChainDraft;
    const parts = [`<div class="route-entry" aria-hidden="true"><span class="route-entry-tag">auto</span></div>`];
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
    const label = routeChainEndpointLabel(routeChainEndpointId);
    $("routeChainTitle").textContent = `编辑路由链 — ${label}`;
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
    $("routeChainBody").innerHTML = `
      <div style="font-size:11.5px; color:var(--text-3);">
        链路自上而下按序路由，失败自动退避下一跳；节点卡可拖拽调序、右键移除。一条链最多 ${ROUTE_CHAIN_MAX_NODES} 跳，同一渠道/号池可绑定不同模型各占一跳。</div>
      <div class="route-editor">
        <div class="route-stage-col">
          <div class="store-form-label">链路（入口 auto → 逐跳退避）</div>
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

  async function confirmRouteChainSave() {
    const err = $("routeChainError");
    const fail = (msg) => {
      err.hidden = false;
      err.textContent = msg;
    };
    err.hidden = true;
    const validErr = routeChainValidate(routeChainDraft);
    if (validErr) return fail(validErr);
    const btn = $("routeChainConfirmBtn");
    const label = routeChainEndpointLabel(routeChainEndpointId);
    routeChainBusy = true;
    btn.disabled = true;
    btn.textContent = "保存中…";
    try {
      await api("POST", "/api/store/route-chain/save", {
        endpointId: routeChainEndpointId,
        chain: routeChainDraft.map((it) => ({ node: it.node, model: it.model })),
      });
      $("routeChainModal").classList.remove("show");
      toast(`路由链已保存：${label}（${routeChainDraft.length} 个节点）`);
      await refreshStoreState();
    } catch (e) {
      if (e.code === "cas-conflict") {
        fail("渠道配置已被其他操作改动，请稍后重试");
        await refreshStoreState();
      } else {
        fail(panelError(e, "操作失败"));
      }
    } finally {
      routeChainBusy = false;
      btn.disabled = false;
      btn.textContent = "保存路由链";
    }
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

  // 同步接口会带回 Codex 模型列表的重写结果：state 表示已重写时，把「已更新」与条数
  // 一并说给用户。判定与同步日志同一套状态值（written 即「这次重写过」）；
  // 字段尚未上线（undefined）或 state 表示没重写时一句都不提——没拿到证据就不说话，
  // 避免又变成一句永远正确的套话。点名端点复用统计页那套端点显示名（同一批客户端）。
  const SYNC_CATALOG_REWRITTEN_STATES = new Set(["written"]);
  // Codex 桌面端的选择器只取模型列表的第一页（100 个），页外的模型在 Codex 里选不到。
  // 目录条数越过这条线就明说，不论本轮有没有重写——超限是持续状态，不是一次性事件。
  const CODEX_PICKER_PAGE_SIZE = 100;
  function syncCodexCatalogNote(cat) {
    if (!cat || typeof cat !== "object") return "";
    const entries = Number.isFinite(cat.entries) ? cat.entries : null;
    const parts = [];
    if (SYNC_CATALOG_REWRITTEN_STATES.has(String(cat.state || ""))) {
      parts.push(entries === null ? "Codex 的模型列表已更新" : `Codex 的模型列表已更新，共 ${entries} 个模型`);
    }
    if (entries !== null && entries > CODEX_PICKER_PAGE_SIZE) {
      parts.push(`Codex 的选择器只显示前 ${CODEX_PICKER_PAGE_SIZE} 个模型，当前 ${entries} 个，排后面的选不到`);
    }
    return parts.join("。");
  }

  function initStoreTab() {
    $("tabStore").onclick = () => switchView("store");
    $("storeAddBtn").onclick = () => showAddModal();
    $("storeRefreshAllBtn").onclick = () => storeRefresh(null);
    // 「查看差异」弹窗关闭：关闭钮 / 点遮罩 / Esc（与会话删除确认弹窗同模式）
    $("storeDiffCloseBtn").addEventListener("click", closeStoreDiffModal);
    $("storeDiffMask").addEventListener("click", (e) => { if (e.target === $("storeDiffMask")) closeStoreDiffModal(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && $("storeDiffMask").classList.contains("show")) closeStoreDiffModal(); });
    $("storeSyncAgentsBtn").onclick = async () => {
      // 立即把当前渠道配置推送到各端点——走独立同步进程，现读磁盘上的 merge 逻辑，
      // 因此写层的修复不需要重启服务即可生效。结果按同步接口如实反馈：全部成功、
      // 部分端点没成功（点名端点）、Codex 模型列表已更新（带条数）。
      const btn = $("storeSyncAgentsBtn");
      if (btn.disabled) return;
      btn.disabled = true;
      setStoreRefreshStatus("正在同步到端点..", "busy");
      try {
        const r = await api("POST", "/api/sync-agents");
        // synced/failed/codexCatalog 由同步接口下发，尚未上线时取不到：取不到就按
        // 全部成功处理，不报错
        const synced = Array.isArray(r.synced) ? r.synced : [];
        const failed = Array.isArray(r.failed) ? r.failed : [];
        const names = failed.map((id) => statsEndpointLabel(id)).join("、");
        const catalogNote = syncCodexCatalogNote(r.codexCatalog);
        const withNote = (head) => (catalogNote ? `${head}。${catalogNote}` : head);
        if (failed.length) {
          const head = synced.length
            ? `已同步 ${synced.length} 个端点，${names} 没同步成功`
            : `这些端点没同步成功：${names}`;
          setStoreRefreshStatus("端点同步未完成", "err", escapeHtml(`未成功：${names}`));
          toast(withNote(head), true);
        } else {
          const head = synced.length
            ? `已同步到全部 ${synced.length} 个端点的配置`
            : "已同步到全部端点的配置";
          setStoreRefreshStatus("端点同步完成", "done", escapeHtml(catalogNote));
          toast(withNote(head));
        }
      } catch (err) {
        setStoreRefreshStatus("同步失败", "err");
        toast(panelError(err, "端点同步失败"), true);
      } finally {
        btn.disabled = false;
      }
    };
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
    zcode: "ZCode", claude: "Claude Code", dsh: "DSH",
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
  }

  // 手动刷新的视觉反馈：按钮走 .btn:disabled 的 45% 变暗（与看板「重启」键、
  // skills 刷新键同源，暗着即「还没好」），持续到数据落地后各栏目生长动画
  // 播完才亮起。重播=进 tab 首渲同款：趋势图清屏 reveal 左至右生长（重置
  // statsTrendPrev）+ 用量环/柱状图一笔画生长（重置 statsUsageRevealed）；
  // TTFT 小图无动画参数（渲染器收到 undefined anim 直接画终态），随本次重渲
  // 自然刷新。等待串在刷新之后而不是与请求并行取最大值：reveal 只能在数据
  // 落地那次渲染起跑，从点击起算会让亮起早于动画收尾一个请求耗时。
  async function runStatsRefreshWithFeedback() {
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

  // 进入 tab 拉一次；停留期间 30s 轮询（页面隐藏时暂停，离开 tab 停止）
  function enterStatsView() {
    statsTrendPrev = null; // 进 tab 首张图走 reveal 揭示动画
    statsUsageRevealed = false; // 环形图揭示同理：每次进 tab 重播（与趋势图一致）
    loadStatsPrefs(); // 兜底：restoreView 可能先于 initStatsTab 到达
    // 缓存热渲染：切走时 leaveStatsView 只取消 rAF 不清 DOM，旧画面会残留在
    // 容器里直到网络返回——先同步用已缓存数据重渲（此时 reveal 标记刚被重置，
    // 趋势图与环均从零起步立即重播生长动画），消除「旧图静置、动画迟到」的
    // 割裂与空窗。fetch 落地后：数据未变由守卫跳过静默重渲（环 _usageRaf、
    // 趋势图同终点签名），已变则趋势图 morph 从在飞位置半途接管，均不打断动画。
    if (statsData) { renderStatsTrend(); renderStatsUsage(); }
    const firstReady = refreshStatsState();
    if (!statsTimer) {
      statsTimer = setInterval(() => {
        if (document.hidden) return;
        refreshStatsState({ silent: true });
      }, 30000);
    }
    return firstReady;
  }

  function leaveStatsView() {
    if (statsTimer) { clearInterval(statsTimer); statsTimer = null; }
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
    // （轴刻度 + 系列键/色/虚线/值），与数据来源无关。
    if (container._statsAnim && container._statsAnim.raf) {
      if (container._statsAnim.targetSig === renderStatsTrendSignature(cfg)) return;
    }
    // 基线优先级：在飞动画的中间像素帧 > 上次提交的像素帧
    const prevAnim = container._statsAnim || null;
    const baseline = (prevAnim && prevAnim.current) || container._statsCommit || null;
    if (prevAnim) { cancelAnimationFrame(prevAnim.raf); container._statsAnim = null; }
    container.textContent = "";
    const W = 760, H = cfg.height || 220;
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
  // 渲染输出签名：轴刻度 + 各系列 key/色/虚线/值。同终点守卫用它判断在飞动画
  // 的目标是否与本次请求渲染的内容一致（与数据来源/调用方无关）。
  function renderStatsTrendSignature(cfg) {
    return JSON.stringify([
      cfg.labels, cfg.min, cfg.max, cfg.height,
      cfg.series.map((s) => [s.key, s.color, s.dash || "", s.values]),
    ]);
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
    const animSig = renderStatsTrendSignature(cfg);
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
    // 曲线被"拉伸揉捏"成新形状而非擦掉重画）
    const anim = statsTrendPrev ? { type: "morph" } : { type: "reveal" };
    renderStatsLineChart(chartEl, {
      labels: buckets.map((t) => statsFmtBucketLabel(t)),
      series: visible,
      fmt: (v) => formatTokensCn(Math.round(v)),
      ariaLabel: "Token 趋势图",
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
  function statsRenderBars(el, rows) {
    // rows: [{label, value(0-1 之外任意正数), valText, ok?}]
    el.textContent = "";
    el.classList.add("stats-bars"); // grid 三列共享列宽，各行轨道右端对齐
    const maxV = rows.reduce((m, r) => Math.max(m, r.value || 0), 0) || 1;
    rows.forEach((r) => {
      const row = document.createElement("div");
      row.className = "stats-bar-row";
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
  function renderStatsTtft() {
    const chartEl = $("statsTtftChart");
    const barsEl = $("statsTtftBars");
    if (!chartEl || !barsEl) return;
    const ttft = statsData && statsData.ttft ? statsData.ttft : {};
    const daily = Array.isArray(ttft.daily) ? ttft.daily : [];
    const byModel = Array.isArray(ttft.byModel) ? ttft.byModel : [];
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
    const rows = byModel.filter((r) => r.avg != null).slice(0, 5);
    if (rows.length) {
      statsRenderBars(barsEl, rows.map((r) => ({
        label: r.key,
        value: r.avg,
        valText: `${statsFmtTtft(r.avg)} · p95 ${statsFmtTtft(r.p95)} · ${statsFmtInt(r.samples)} 次`,
      })));
    } else {
      barsEl.textContent = "";
    }
  }

  // ── G1：TPS 生成速度（按模型横条） ──
  function renderStatsTps() {
    const el = $("statsTpsBars");
    if (!el) return;
    const rows = statsData && Array.isArray(statsData.tps) ? statsData.tps : [];
    const valid = rows.filter((r) => r.avgTps != null && r.avgTps > 0);
    if (!valid.length) { el.innerHTML = '<div class="empty-hint">暂无数据</div>'; return; }
    statsRenderBars(el, valid.map((r) => ({
      label: r.key,
      value: r.avgTps,
      valText: `${Number(r.avgTps).toFixed(1)} tok/s · ${statsFmtInt(r.samples)} 样本`,
    })));
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
  };
  let sessTimer = null;                // 60s 相对时间刷新定时器（enter/leave 管理）
  let sessMsgObserver = null;          // TOC 高亮用的 IntersectionObserver
  let sessInited = false;              // initSessionsTab 一次性事件绑定标记
  let sessListReqSeq = 0;              // 列表取数竞态守卫
  const SESS_FOLD_LIMIT = 3000, SESS_FOLD_HEAD = 1500; // 超长消息折叠阈值与预览长度

  /* ============================================================
     数据拉取
     ============================================================ */
  async function refreshSessionsList() {
    const seq = ++sessListReqSeq;
    sessState.loading = true;
    renderSessList({ keepScroll: true });
    try {
      const res = await api("GET", "/api/sessions/list");
      if (seq !== sessListReqSeq) return; // 已有更新请求在飞，丢弃旧响应
      sessState.sessions = Array.isArray(res.sessions) ? res.sessions : [];
      sessState.endpointErrors = Array.isArray(res.endpointErrors) ? res.endpointErrors : [];
      // prune：已消失的会话从 checked/selectedId 清掉
      const ids = new Set(sessState.sessions.map((s) => s.id));
      for (const id of [...sessState.checked]) if (!ids.has(id)) sessState.checked.delete(id);
      if (sessState.selectedId && !ids.has(sessState.selectedId)) sessState.selectedId = null;
    } catch (err) {
      if (seq !== sessListReqSeq) return;
      toast(panelError(err, "会话列表加载失败"), true);
      sessState.sessions = [];
      sessState.endpointErrors = [];
    } finally {
      if (seq === sessListReqSeq) sessState.loading = false;
    }
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
    const list = sessFiltered();
    $("sessListCount").textContent = list.length;
    $("sessTotalBadge").textContent = sessState.sessions.length + " 个会话";
    scrollEl.classList.toggle("deleting", sessState.deleting);
    const prevScrollTop = keepScroll ? scrollEl.scrollTop : 0;

    // 加载态骨架屏只在冷启动演：切走再切回时 sessions 里还留着上一次的数据，
    // 整树换成骨架屏会把「静默重取」显形成为重载。
    if (sessState.loading && sessState.sessions.length === 0) {
      scrollEl.innerHTML = Array.from({ length: 6 }, () =>
        `<div style="padding:10px 12px;"><div class="sessions-skel" style="height:14px;width:75%;margin-bottom:6px;"></div><div class="sessions-skel" style="height:11px;width:45%;"></div></div>`
      ).join("");
      return;
    }
    // 空态 / 搜索无结果
    if (sessState.sessions.length === 0) {
      scrollEl.innerHTML = `<div class="sessions-list-empty"><div class="le-icon">🗂️</div>还没有可浏览的会话<br><span style="font-size:11.5px;">在任意端点里开始一段对话后，会出现在这里。</span></div>`;
      return;
    }
    if (list.length === 0) {
      scrollEl.innerHTML = `<div class="sessions-list-empty"><div class="le-icon">🔍</div>没有匹配的会话<br><span style="font-size:11.5px;">换个关键词试试，或清空搜索查看全部。</span></div>`;
      return;
    }

    scrollEl.innerHTML = sessState.view === "group" ? renderSessGrouped(list) : renderSessFlat(list);
    if (keepScroll) scrollEl.scrollTop = prevScrollTop;
    bindSessListEvents();
  }

  /* 分组视图 */
  function renderSessGrouped(list) {
    const kw = sessState.search.trim();
    const byEp = sessGroup(list);
    let html = "";
    for (const [epId, byProj] of byEp) {
      const epCount = [...byProj.values()].reduce((n, arr) => n + arr.length, 0);
      const epKey = "ep:" + epId;
      const epCollapsed = !!sessState.collapsed[epKey];
      html += sessGroupHeadHtml(epKey, sessEpName(epId), epCount, epCollapsed, 1, sessEpColor(epId), byProj, null, SESS_EP_RINGED.has(epId));
      if (epCollapsed) continue;
      for (const [proj, arr] of byProj) {
        const pKey = "proj:" + epId + "|" + String(proj || "").replace(/\\/g, "/").toLowerCase();
        const pCollapsed = !!sessState.collapsed[pKey];
        html += sessGroupHeadHtml(pKey, sessDirName(proj), arr.length, pCollapsed, 2, null, arr, proj);
        if (pCollapsed) continue;
        html += arr.map((s) => sessItemHtml(s, kw, 2)).join("");
      }
    }
    return html;
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
    return `data-indeterminate="1"`; // 半选态在 bindSessListEvents 里设置（HTML 属性无法表达 indeterminate）
  }

  /* 列表视图（平铺，按最后活跃倒序，sessFiltered 已排序） */
  function renderSessFlat(list) {
    const kw = sessState.search.trim();
    return list.map((s) => sessItemHtml(s, kw, 1)).join("");
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

  /* 列表事件绑定（渲染后重绑） */
  function bindSessListEvents() {
    const root = $("sessScroll");
    // 组头折叠/展开
    root.querySelectorAll(".sess-group-head").forEach((h) => {
      h.addEventListener("click", (e) => {
        if (e.target.classList.contains("grp-cb")) return; // 点复选框不折叠
        const key = h.dataset.key;
        sessState.collapsed[key] = !sessState.collapsed[key];
        if (!sessState.collapsed[key]) delete sessState.collapsed[key];
        SESS_LS.set("collapsed", sessState.collapsed);
        renderSessList();
      });
    });
    // 组复选框：全选/取消整组；设置半选态
    root.querySelectorAll(".grp-cb").forEach((cb) => {
      if (cb.dataset.indeterminate) cb.indeterminate = true;
      cb.addEventListener("change", () => {
        const ids = sessCollectGroupIds(cb.dataset.key);
        if (cb.checked) ids.forEach((id) => sessState.checked.add(id));
        else ids.forEach((id) => sessState.checked.delete(id));
        renderSessList(); updateSessBatchBar();
      });
    });
    // 会话项：批量模式下点整行切换勾选；正常模式选中查看
    root.querySelectorAll(".sess-item").forEach((item) => {
      item.addEventListener("click", (e) => {
        const id = item.dataset.id;
        if (sessState.batch) {
          if (!e.target.classList.contains("item-cb")) {
            const cb = item.querySelector(".item-cb");
            cb.checked = !cb.checked;
          }
          const on = item.querySelector(".item-cb").checked;
          on ? sessState.checked.add(id) : sessState.checked.delete(id);
          renderSessList(); updateSessBatchBar();
          return;
        }
        selectSession(id);
      });
    });
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
      `<div class="sessions-err-banner"><span>⚠</span><span>${esc(sessEpName(e.endpoint))} 端点的会话目录未配置或不可读，该端点的历史会话暂不可浏览。</span><button class="eb-close" data-eb="${esc(e.endpoint)}" title="关闭提示">×</button></div>`
    ).join("");
    host.querySelectorAll(".eb-close").forEach((b) =>
      b.addEventListener("click", () => b.closest(".sessions-err-banner").remove()));
  }

  /* ============================================================
     右栏：会话详情
     ============================================================ */
  function selectSession(id) {
    sessState.selectedId = id;
    renderSessList();      // 刷新选中态
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
    $("sessResumeCmd").textContent = cmd || "该端点暂不支持恢复命令";
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
    try {
      const res = await api("GET", "/api/sessions/messages?endpoint=" + encodeURIComponent(s.endpoint) + "&path=" + encodeURIComponent(s.file));
      messages = Array.isArray(res.messages) ? res.messages : [];
    } catch (err) {
      // 会话可能已被删/移动：回退空消息流并提示
      flow.innerHTML = `<div class="sessions-list-empty">${esc(panelError(err, "消息加载失败"))}</div>`;
      return;
    }
    // 竞态：拉取期间用户已改选其它会话 → 丢弃
    if (sessState.selectedId !== s.id) return;
    s.messages = messages; // 缓存到会话对象，TOC/复制/折叠共用
    renderSessMessages(s);
  }

  function renderSessMessages(s) {
    const kw = sessState.search.trim();
    const flow = $("sessMsgFlow");
    flow.innerHTML = "";
    (s.messages || []).forEach((m, i) => {
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
      flow.appendChild(div);
    });
  }

  /* ============================================================
     消息目录 TOC
     ============================================================ */
  function sessTocEntries(s) {
    if (!s || !Array.isArray(s.messages)) return [];
    const out = [];
    s.messages.forEach((m, i) => {
      if (m.role !== "user") return;
      const clean = String(m.content || "").replace(/^\s+/, "");
      if (!clean) return;
      out.push({ idx: out.length + 1, msgIdx: i, text: clean.slice(0, 40) });
    });
    return out;
  }

  function renderSessToc(s) {
    const entries = sessTocEntries(s);
    const has = entries.length > 0;
    $("sessTocSide").hidden = !has;
    $("sessTocFab").classList.toggle("has-toc", has);
    if (!has) { $("sessTocPop").hidden = true; return; }

    const html = entries.map((e) =>
      `<div class="toc-item" data-msg="${e.msgIdx}"><span class="t-idx">${e.idx}</span><span class="t-text">${esc(e.text)}</span></div>`
    ).join("");
    $("sessTocList").innerHTML = html;
    $("sessTocPopList").innerHTML = html;

    // 点击定位：平滑滚动 + 高亮闪烁 2 秒
    $$(".toc-item").forEach((item) => {
      item.addEventListener("click", () => {
        const target = document.getElementById("sess-msg-" + item.dataset.msg);
        if (!target) return;
        target.scrollIntoView({ behavior: "smooth", block: "start" });
        target.classList.remove("flash");
        void target.offsetWidth; // 重启动画
        target.classList.add("flash");
        setTimeout(() => target.classList.remove("flash"), 2000);
        $("sessTocPop").hidden = true; // 小屏弹层点击后收起
      });
    });

    // 当前可视消息对应的 TOC 项高亮
    if (sessMsgObserver) sessMsgObserver.disconnect();
    sessMsgObserver = new IntersectionObserver((ents) => {
      for (const en of ents) {
        if (!en.isIntersecting) continue;
        const i = en.target.id.replace("sess-msg-", "");
        $$(".toc-item").forEach((t) => t.classList.toggle("active", t.dataset.msg === i));
      }
    }, { root: null, threshold: 0.4 });
    (s.messages || []).forEach((m, i) => {
      if (m.role === "user") {
        const el = document.getElementById("sess-msg-" + i);
        if (el) sessMsgObserver.observe(el);
      }
    });
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
      sessState.sessions = sessState.sessions.filter((s) => !okFiles.has(s.file));
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

    // 端点筛选下拉
    const sel = $("sessEndpointFilter");
    for (const ep of SESSIONS_ENDPOINTS) {
      const opt = document.createElement("option");
      opt.value = ep.id;
      opt.textContent = ep.name;
      sel.appendChild(opt);
    }
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

    // 刷新：重调 list（无状态现扫下 list 即 rescan）
    $("sessRefreshBtn").addEventListener("click", async () => {
      const btn = $("sessRefreshBtn");
      if (btn.disabled) return;
      btn.disabled = true;
      try { await refreshSessionsList(); toast("会话列表已刷新"); }
      finally { btn.disabled = false; }
    });

    // TOC 浮动按钮（小屏）
    $("sessTocFab").addEventListener("click", () => { $("sessTocPop").hidden = !$("sessTocPop").hidden; });
    document.addEventListener("click", (e) => {
      if (!$("sessTocPop").hidden && !e.target.closest("#sessTocPop") && !e.target.closest("#sessTocFab")) $("sessTocPop").hidden = true;
    });

    // 移动端抽屉
    $("sessDrawerOpenBtn").addEventListener("click", () => {
      $("sessListCard").classList.add("drawer-open");
      $("sessDrawerMask").classList.add("show");
    });
    $("sessDrawerMask").addEventListener("click", () => {
      $("sessListCard").classList.remove("drawer-open");
      $("sessDrawerMask").classList.remove("show");
    });

    // 右键菜单：委托挂常驻滚动容器（行节点每次全量重建，逐行绑会失效）；
    // 命中会话行 → 先选中该行再弹单项删除菜单；空白处/组头/骨架空态不弹。
    // 选中走 keepScroll 变体：selectSession 会整树重渲染并回顶，右键时必须保住滚动条。
    $("sessScroll").addEventListener("contextmenu", (e) => {
      const item = e.target.closest(".sess-item");
      if (!item || sessState.deleting) return;
      e.preventDefault();
      const id = item.dataset.id;
      if (!id) return;
      if (sessState.selectedId !== id) {
        sessState.selectedId = id;
        renderSessList({ keepScroll: true });
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
