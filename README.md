<sub>🌐 <b>中文</b> · <a href="README.en.md">English</a></sub>

<div align="center">

<p><img src="docs/assets/logo.png" alt="Anyswitch logo" width="128"></p>

# Anyswitch

> *「配一次渠道，九个 agent 在同一个终端里干活。」*

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-2ea44f.svg)](LICENSE)
[![Version: 0.7.0-preview](https://img.shields.io/badge/Version-0.7.0--preview-007ec6.svg)](https://github.com/Aurora0134/Anyswitch/tree/v0.7.0-preview)
[![Platform: Windows](https://img.shields.io/badge/Platform-Windows-0078D6.svg)](#这些边界要先接受)
[![Node.js: 22.15+](https://img.shields.io/badge/Node.js-22.15%2B-339933.svg)](package.json)

<br>

**把渠道配一次，然后在这个窗口里启动、观测、切换九个 coding agent——凭据不出本机。**

<br>

给第一个 agent 配渠道，谁都乐意：填 baseURL、填 key、勾模型，五分钟的事。到第四个，你在把同样几十条配置往第四份文件里抄；到第九个，九份配置里躺着九份明文 key，每一份都活在那个 agent 进程读得到的目录里。

开工之后更乱：九个窗口各说各的，渠道挂了要手动换，长会话说断就断；想知道刚才那笔 250 tok/s 是谁发的，得在日志里对时间。

这个工具存在的全部理由，是让「只配一次」「只存一份密文」「一眼看到谁在跑」三件事同时成立。

```bat
git clone --branch v0.7.0-preview --single-branch https://github.com/Aurora0134/Anyswitch.git "%LOCALAPPDATA%\Anyswitch\app"
```

Windows 本地运行 · 源码发行、无安装器 · relay 只听环回地址

[看效果](#看效果一个窗口里从启动到读数) · [安装](#装上就能用) · [虚拟终端](#虚拟终端agent-在跑读数就在旁边) · [边界](#这些边界要先接受)

</div>

---

## 看效果：一个窗口里，从启动到读数

面板在 `http://127.0.0.1:47820/panel`，relay 在 `127.0.0.1:47821`。两个进程分开跑：relay 停了，面板照样打开给你看状态。

![虚拟终端：页签、会话栏、终端输出与底栏（右栏状态面板可展开，此图为收起态）](docs/screenshots/s6-terminal.png)

一条真实路径，四步：

1. 渠道管理里加一个渠道：Base URL、API Key、模型自动发现。保存时 key 用当前 Windows 用户的 DPAPI 封存。
2. 打开「虚拟终端」，点「+」。菜单里只出现本机已装的 CLI Agent；选一个、填工作目录、点启动。
3. 它就在面板里跑起来。右栏是这个实例的首字响应、生成速度、缓存命中、已工作时间与最近请求。
4. 按 F5：还停在终端页、还停在原页签；画面从宿主渲染镜像按行回放，重连先清屏再画。

![新建终端：“+”菜单列出空白终端与本机已装的 CLI Agent（列表可滚动，截图露出前几项），工作目录可改](docs/screenshots/s7-terminal-launch.png)

右栏不是估算：它读的是看板同一份实例数据，「这个页签里是哪个 agent」由进程号与实例号对上，不解析终端输出。

看板是同一套读数的汇总，虚拟终端入口在左栏：

![看板：服务状态、虚拟终端入口、各 agent 实例与实时输出](docs/screenshots/s1-board.png)

<sub>截图摄于本机同一份代码的面板；面板启动时读到的版本徽标还是升号前的 0.6.6。</sub>

装完自检，在安装目录跑：

```bat
node --version
node --check panel-host.mjs
curl http://127.0.0.1:47821/
```

最后一条应当返回一份本机 relay 的健康状态，例如：

```json
{"status":"ok","service":"anyswitch-relay","degraded":false,"consecutiveFailures":0,"lastFailureKind":null}
```

---

## 装上就能用

### 先准备这三件事

- Windows。凭据封存走 Windows DPAPI，开机自启走计划任务，客户端检测与部分更新路径也依赖 Windows。
- Node.js。`package.json` 要求 `>=22.15.0 <23 || >=23.8.0`，推荐 24 LTS；这是 API 下限，不表示范围内每个版本都实测过。
- 一个新的安装目录。不要把新源码覆盖到正在运行的目录上。

### 第一次安装

```bat
git clone --branch v0.7.0-preview --single-branch https://github.com/Aurora0134/Anyswitch.git "%LOCALAPPDATA%\Anyswitch\app"
cd /d "%LOCALAPPDATA%\Anyswitch\app"
npm install
wscript panel-app.vbs
```

`npm install` 只为虚拟终端装依赖：终端进程绑定与渲染器一共 5 个直接依赖。不装它，relay、面板、渠道管理、启动器、统计照常用，只是终端页打不开。

手动启动面板也行：`node panel-launcher.mjs`。`panel-app.vbs` 按自身位置找启动器，安装目录不必固定，桌面快捷方式直接指它。

### 四步跑通第一条请求

1. 打开 `http://127.0.0.1:47820/panel`，进渠道管理。
2. 新增渠道：填渠道 ID、上游 Base URL、API Key。保存时 key 用当前 Windows 用户的 DPAPI 封存。
3. 等模型自动发现；上游没有 `GET /v1/models` 就手动补模型 ID。要容灾，再填备用地址。
4. 用对应 agent 的启动器拉起客户端，或者直接在虚拟终端里启动它——relay 地址与鉴权由启动器交给它，其余参数原样透传。

装完自检：

```bat
node --version
node --check panel-host.mjs
npm test
```

`npm test` 是仓库自带的全量测试；它需要一次 `npm install`，因为虚拟终端测试会碰终端宿主。

---

## 虚拟终端：agent 在跑，读数就在旁边

虚拟终端是面板里的独立页面，不是一个弹窗：整页显示，页头能返回看板，页签条能整排收起给终端屏让高。

### 「+」里只有你装了的 Agent

新建菜单列两样东西：空白终端，和本机已安装且检测为 CLI 形态的 agent。九个端点——Claude Code、Codex、Kimi Code、OpenCode、Pi、DeepSeek Harness、Grok Build、Qoder、ZCode——的 CLI 形态都在候选里；桌面图形形态不进终端，菜单里不会出现没装的东西。

选中 agent 后点启动，服务端为该会话组装环境变量：relay 地址、鉴权、会话身份。上游 key 不进终端、不落盘、不回显。空白终端固定 PowerShell，工作目录默认你的用户目录，并记住你上次填的那一个。

> 一个例外写清楚：ZCode CLI 不从环境变量收凭据，relay 令牌会作为 Anyswitch 自有槽位配置里的密钥下发，且只写在它自己的配置里。

### 会话属于谁，面板知道，但不是靠猜终端的字

每个终端会话在宿主侧都有真实 shell 进程号。归属判定是：这个 shell 进程号出现在某个 agent 进程的祖先链里，就把会话算给那个 agent 的实例。代码注释里写得直白：**nothing here parses terminal output text**。

所以右栏显示的是该实例的同一份数据——在途请求、首字响应（<5 秒绿 / 5–15 秒黄 / >15 秒红）、生成速度、缓存命中率、已工作时间、最近 10 条请求。agent 退出后终端还在，监测区跟着消失；在同一个终端里再起另一个 agent，按新实例重新归属。

Codex 是特例：它的桌面会话共用一个引擎进程，进程号对不上实例行，所以按「工作目录 + 最近活动」从它的会话记录里桥接，且只在实例行真实存在时才绑定。

### 刷新不洗屏：历史从渲染镜像重建

旧做法是把原始字节流再倒给终端，长会话刷一次屏反而更乱。现在回放用的是宿主侧渲染镜像：先清屏，再按行、按绝对位置重绘，滚出去的历史推进 scrollback；全屏 TUI 若正处在备屏，回放会先切进备屏再画。

刷新后你停在终端页、停原页签，这两个状态各有一把本机存档。断线重连同样先清屏再回放，不会新旧内容叠成双份。宿主里能回放的是有预算的——镜像最多 5000 行 / 1MB，单次回放上限 2MB——所以「历史全都在」这句话不成立，它是「镜像里还在的都在」。

### 每天都会碰到的那些细节

- **中文输入法**：组字期间把输入锚点钉在组字起点，不跟着高频输出乱跳。
- **复制粘贴**：裸 `Ctrl+V` 走浏览器原生粘贴；裸 `Ctrl+C` 有选中时复制、无选中时仍然是中断，跟终端习惯一致。
- **换行**：`Ctrl+Enter` / `Shift+Enter` 换行。普通端点发 LF；Codex 单独发 `ESC CR`——它把 LF 当提交，得命中它自己的换行键位。
- **字号**：10–24，默认 13；`− / +`、`Ctrl+±`、`Ctrl+滚轮` 三个入口，只在终端页生效。
- **页签条**：可整排隐藏/展示。收展是瞬切，没有动画；这一版修的是收展瞬间容器与画布同拍重排，不再露空白条。
- **底部自动对齐**：默认关。开启后，向上翻历史时自动收掉窗口收放多出来的底部空白带，滚回底部恰好对齐。
- **主题**：终端底色、前景、光标、选区跟着面板的三套皮肤与亮/暗切换走，切主题即时重刷。

### 页签、服务与设置

页签可以新建、关闭、切换；标签名由服务端按 agent 显示名下发，不能重命名。关一个正在干活的页签会先确认，关掉即终结这棵进程树——node-pty 只关伪控制台时子进程不会自己退，所以这里用的是树杀。

终端的后台服务是独立进程（端口 47823），由 relay 托管：崩了自动拉起，1 秒后重试，10 分钟内最多 5 次，超了留在「异常」等手动启动。页头有两个开关：

- **从上次中断的地方继续**（默认开）：终端服务下次启动时恢复页面与历史，但进程不复活，恢复出来的会话如实标为已退出。
- **底部自动对齐**（默认关）：见上。

![终端设置：从上次中断的地方继续、底部自动对齐](docs/screenshots/s8-terminal-settings.png)

---

## 渠道配一次，九个端点都见它

九个 agent、九条接法，配好一次就都在这里：

| agent | 协议面 | 启动方式 |
| --- | --- | --- |
| Claude Code | Anthropic Messages | `node launcher.mjs [claude 参数]` |
| Kimi Code | Anthropic Messages | `node kimi-launcher.mjs [kimi 参数]` |
| Codex CLI | OpenAI Responses | `node codex-launcher.mjs [codex 参数]` |
| OpenCode | OpenAI | `node opencode-launcher.mjs [opencode 参数]` |
| Pi | OpenAI | `node pi-launcher.mjs [pi 参数]` |
| ZCode | OpenAI | `node zcode-launcher.mjs [zcode 参数]` |
| ZCode CLI | OpenAI | `node zcode-cli-launcher.mjs [zcode 参数]` |
| DeepSeek Harness | OpenAI | `node dsh-launcher.mjs [dsh 参数]` |
| Qoder | OpenAI | `node qoder-launcher.mjs [qoder 参数]` |
| Grok Build | OpenAI | `node grok-launcher.mjs [grok 参数]` |

配置同步把托管渠道写进各 agent 自己的配置位置，你手写的其它内容原样保留：

| agent | Anyswitch 写入的位置 |
| --- | --- |
| Kimi Code | `~/.kimi-code/config.toml` |
| Codex | `~/.codex/config.toml` 与生成的模型目录 |
| OpenCode | `~/.config/opencode/opencode.json`（你的 `opencode.jsonc` 不动） |
| Pi | `~/.pi/agent/models.json` |
| ZCode | `~/.zcode/v2/config.json` |
| DeepSeek Harness | `~/.dsh/profiles/<name>/cordis.patch.yml` |
| Qoder | `~/.qoder/settings.json` |
| Grok Build | `~/.grok/config.toml` |

写进这些文件的是本地 relay 地址和一枚本地 token——上游的真实 key 不进任何 agent 的配置目录。Claude Code 没有配置文件面，走启动器注入环境变量。

已经散在各家配置里的渠道也不用重抄：BYOK 导入会扫描 8 个端点的本地配置（Claude 没有本地配置面），把 OpenAI 兼容渠道拉进中央 store，能选的带过去，不能选的如实跳过。

---

## 挂了一个渠道，流水线不该停

管流量走向的有三样东西：号池、路由链、备用地址。它们各管一层，可以叠着用。

- **号池**：2–5 个渠道收进一个池。同一段会话在成员间保持粘性，不会每句话换一个渠道；当前成员失败，按顺序退到下一个。
- **路由链**：每个 agent 的 `auto` 模型按链逐跳尝试，节点可以是渠道，也可以是号池。节点连续失败 2 次降级，5 分钟后由真实请求驱动回到链首重试。
- **虚拟模型**：你自建的名字绑一条 1–8 节点的链，绑完在全部九个 agent 的模型列表里出现同一个名字；一个 agent 把某节点打降级了，另一个 agent 的请求直接绕开它。
- **备用地址**：渠道自己再加一道保险。每个地址 180 秒生成预算、1/2/4 秒指数退避；4xx 是请求终态，5xx 才换下一个；全部耗尽时透传最后一次真实上游 5xx，纯传输失败返回 502。

```text
模型名
  └─ 节点 A：主渠道
       └─ 节点 B：号池（2–5 个渠道，粘性 + 逐成员退避）
            └─ 节点 C：备用渠道（baseURL 的 fallbackURLs）
```

删渠道、解散号池时，引用它的链条目在同一笔写入里被剪掉，不留悬空节点；链的每一跳在看板上有实况灯，哪跳在走、哪跳降级，直接看得到。

---

## 机制：不是转发器，是本机的配置真相源

```text
%LOCALAPPDATA%\Anyswitch\
├── store.json       渠道、模型、号池、路由链、虚拟模型的元数据
├── credentials\     每个渠道一个 DPAPI 密文文件
├── settings.json    面板与各 agent 开关
├── terminal-sessions.json  终端的会话元数据与历史快照
├── usage\           按日记录的请求与会话用量（保留 90 天）
└── app\             本仓库：relay、面板、启动器
```

- **`store.json` 不放秘密。** schema 内置词表（apikey、token、secret、password……）逐段匹配字段名，命中即拒绝写入；key 只以 `credentialFile` 引用的形式连到凭据目录。复算：`grep -n "SECRET_WORDS" store-schema.mjs`。
- **key 只在请求那一刻解密。** DPAPI 用当前用户作用域，密文按渠道隔离。解出的明文默认在本进程内按密文哈希做短时复用（设置里可关，关掉即用后即焚、每个请求重新解密）；轮换密文会立即失效。
- **三个进程，四个端口，全部只监听环回。** 面板 `127.0.0.1:47820`、relay `127.0.0.1:47821`、watchdog 标记 `47822`、终端宿主 `127.0.0.1:47823`。
- **终端宿主是独立进程。** 页面只是浏览器客户端：刷新或重开面板不丢 PTY，历史从宿主渲染镜像回放；宿主归 relay 托管并自动重启。
- **业务代码零第三方运行依赖。** 5 个直接依赖全部属于虚拟终端；全部 `.mjs` 里 import 第三方包的只有一处：`terminal-host.mjs` 的 node-pty。复算：

  ```bat
  node -e "console.log(Object.keys(require('./package.json').dependencies).join(' '))"
  node -e "const fs=require('fs');for(const f of fs.readdirSync('.').filter(x=>x.endsWith('.mjs')))for(const l of fs.readFileSync(f,'utf8').split(/\r?\n/))if(/^import .+ from \"/.test(l)&&!/from \"(node:|\.)/.test(l))console.log(f+': '+l.trim())"
  ```

  第二条只应打印 `terminal-host.mjs: import * as pty from "node-pty";`。

- **写面有并发保护。** 面板写 store 走内容哈希 CAS 加文件锁；路由目录带 generation 摘要，配置在请求中途变化时拒绝用旧目录。
- **面板写接口只认本地面板。** `POST /panel/api/*` 要过 Origin/Referer 可信校验；relay 用数据根里的本地 token 鉴权，终端宿主同样。

规模不是卖点，但可以复算：仓库根 239 个 `.mjs`（108 个实现 + 131 个测试），实现代码约 46,195 行；面板前端三件套 `panel.js` / `panel.html` / `panel.css` 共约 23,900 行。

---

## 它和配置切换器、系统终端差在哪

| | **Anyswitch** | CC Switch | 系统终端 + 手写环境变量 |
| --- | --- | --- | --- |
| 动作对象 | 请求流量：转发、协议转换、退避、路由 | 配置文件：往各 CLI 里写供应商 | 你自己维护的环境与配置 |
| 上游 key 在哪 | 本机 DPAPI 密文，agent 配置里只有本地 token | 它写入的 agent 配置里（含 key） | 你手写在哪里就在哪里，常见是配置或启动脚本里的明文 |
| 运行面 | 面板内置虚拟终端，能起 agent | 无 | 能跑，但读数和归属在别处 |
| 观测 | 终端右栏 + 看板 + 统计页同一份实例数据 | 无 | 各客户端自己一套，互相不对齐 |
| 容灾 | 号池、路由链、备用地址、虚拟模型 | 手动切换供应商 | 手动改配置 |

两句公道话：CC Switch 成熟、管理面广，供应商预设库和双向同步是它的强项；系统终端永远是最快、最不挑工具的选择。Anyswitch 多出来的是「把配置、运行、观测放在同一个本地控制面」这件事，代价是你得自己跑一个本地 relay 和面板。

对比基于对 CC Switch 的公开仓库与文档的只读调研，核查日期 2026-10-18。

---

## 安全与数据流：密文在盘上，明文只在内存里

- **上游 key 以密文落盘。** 每个渠道一个 DPAPI 密文文件，解密需要当前 Windows 用户上下文；换一个用户账户读不走。
- **agent 配置目录里没有上游 key。** 写进去的是 `http://127.0.0.1:47821/...` 与一枚本地 token；真实 key 不经过任何 agent 进程。
- **面板与 relay 都只听环回。** 没有 `0.0.0.0` 绑定；面板写接口另有 Origin/Referer 校验，防止浏览器里的任意页面替你改配置。
- **终端注入的凭据只走环境变量**（ZCode CLI 的槽位配置例外，见上一节）：不进终端进程的启动参数、不落盘、不回显；终端宿主新建会话时对 env 做键名与体积校验。
- **上游请求当然会离开本机。** 去往你在渠道里填写的服务商地址。Anyswitch 守的是凭据存储、路由配置和本地控制面，不会把上游调用伪装成离线运行。

安全问题走 [`SECURITY.md`](SECURITY.md) 指向的 GitHub Security Advisories，不要公开发可利用细节。

---

## 这些边界要先接受

- **只支持 Windows，不支持 macOS / Linux。** DPAPI、计划任务、原生客户端检测、部分更新路径都依赖 Windows。
- **没有安装器。** 0.7.0 以源码发行；首次安装与换机都是 git clone + `npm install`。安装好之后，面板「关于」页可以做两步自更新（下载 → 应用）。
- **虚拟终端仍是预览功能。** 它要单独装依赖；这一版默认关的「底部自动对齐」和恢复策略都在预览线上继续打磨。
- **重启 relay 会中断在途请求，并结束当时所有终端进程。** 面板里的「重启」会先换 relay 再换面板宿主，请在空档执行。只重启面板宿主不会杀终端进程——终端宿主归 relay 托管。
- **刷新恢复有范围。** 只恢复「停在终端页 + 哪个页签 + 镜像里还能重放的历史」；不恢复滚动位置，不回放会话开始以来的全部输出，进程已退的会话不会自动复活。
- **终端页签不能重命名，空白终端的 shell 固定为 PowerShell。** 两种桌面形态的图形客户端（Claude Desktop、Codex 桌面等）不在终端候选里。
- **九个 CLI 的面板内启动、虚拟模型在九个客户端选择器里的逐一显示、关于页的真实安装按钮**，都核到了代码与测试层，但没有替你在每台客户端上逐一走完。
- **实例归属有冷缓存窗口。** relay 刚启动、进程扫描还没预热时，launcher 形态的实例行可能短暂建出两行，闲置 10 分钟后收掉。
- **新版左侧导航是可选开关，不是默认。** 默认仍是旧顶栏布局；截图取的就是默认布局。
- **没有官方模型、没有内置渠道。** 所有上游都来自你自己填写的 provider。

这是一个 0.7 线的预览版，不是 1.0 成品：上面每一条都真实存在，它们不影响「渠道散落在九个配置文件里」的人把它用起来，但决定它能不能上生产流水线。

---

## 代码在哪，数据在哪

```text
Anyswitch/
├── panel-host.mjs              # 47820 面板宿主
├── relay-host.mjs              # 47821 常驻 relay 宿主（同时托管终端宿主）
├── panel.mjs                   # 面板 API 与静态页面路由
├── panel-ui/                   # 面板页面、样式和脚本
├── launch.mjs                  # relay 生产装配与请求转发
├── launcher.mjs                # Claude Code 启动器
├── *-launcher.mjs              # 其他端点的启动器（ZCode 桌面与 CLI 各一）
├── agent-sync.mjs              # 托管渠道同步到各 agent 配置
├── agent-metrics.mjs           # 进程、请求、实例和看板读数
├── terminal-host.mjs           # 47823 终端宿主：PTY 与会话状态
├── terminal-screen.mjs         # 终端渲染镜像与回放
├── terminal-attribution.mjs    # 终端会话与实例的归属连接
├── agent-session-env.mjs       # 启动 agent 时的 launch 与环境变量组装
├── session-scan.mjs            # 各 agent 的会话读取与适配
├── agent-skills.mjs            # Skills 主仓库与部署
├── skills/anyswitch-preset/    # 可选的预设管理技能
├── docs/                       # 架构文档与真实截图
├── package.json                # 版本、Node 范围、虚拟终端依赖
├── SECURITY.md                 # 漏洞报告与安全模型
└── LICENSE                     # Apache-2.0
```

想核对这一版的实际改动范围：

```bat
git log --no-merges --oneline v0.6.6..v0.7.0-preview
```

---

## 升级时，保留数据和 `.git`

用户数据在 `%LOCALAPPDATA%\Anyswitch\` 的 `app` 上层：渠道、凭据、设置、预设、用量记录都不随源码目录替换。

先安排现有会话的空档，再检查安装目录的工作树：

```bat
cd /d "%LOCALAPPDATA%\Anyswitch\app"
git status --short
```

有输出就先处理自己的改动，别为了升级直接丢弃。工作树干净后，只取目标标签：

```bat
git fetch --no-tags origin tag v0.7.0-preview
git switch --detach v0.7.0-preview
npm install
```

升级首选入口在面板里：**设置 → 关于 → 检查更新**。下载只把目标 tag 拉进本地仓库，不碰工作树；应用才换装并重启 relay 与面板。不要把新源码整目录覆盖到旧安装，也不要用 `git reset --hard` 升级；保留 `.git` 以及它指向的外部 Git 对象库，升级前备份 `%LOCALAPPDATA%\Anyswitch\`。

这一版是预览线：按正式版身份运行的安装不会收到 `v0.7.0-preview`，稳定线仍是 `v0.6.6`；按预览版身份运行的安装会照常收到升级提示。

---

## 反馈与贡献

- **Bug**：写清 Windows 版本、Node 版本、agent 形态、复现步骤和实际错误；不要附 API Key、凭据文件或完整会话内容。
- **功能提案**：先说你的工作流在哪一步停住，再说期望的结果；实现方案留在讨论里。
- **代码修改**：遵循 [`CONTRIBUTING.md`](CONTRIBUTING.md)——Node.js ESM、内置 `node:test`、规格与代码同笔更新。

## 致谢与灵感来源

- 提示词预设管理的功能灵感来自 [RP-Hub](https://github.com/STA1N156/RP-Hub)。
- 使用统计页的设计，部分参考了 ZCode。
- 虚拟模型与自动路由的设计借鉴了 [autoAPI](https://github.com/happy66dev/AutoAPI)。
- 与 [CC Switch](https://github.com/farion1231/cc-switch) 的定位差异见上文对比节。

## License

[Apache-2.0](LICENSE)——可以用，可以改，可以分发，保留协议与版权声明。第三方产品名称和商标归各自所有者，见 [`NOTICE`](NOTICE)。

---

<div align="center">

**Anyswitch** 把配置、运行和读数收在一个本地窗口里。<br>
**你**，只需要配一次。<br>
*配一次渠道，九个 agent 在同一个终端里干活。*

</div>
