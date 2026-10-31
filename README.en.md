<sub>🌐 <a href="README.md">中文</a> · <b>English</b></sub>

<div align="center">

<p><img src="docs/assets/logo.png" alt="Anyswitch logo" width="128"></p>

# Anyswitch

> *"Configure your channels once — every agent shares them."*

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-2ea44f.svg)](LICENSE)
[![Version: 0.7.0](https://img.shields.io/badge/Version-0.7.0-007ec6.svg)](https://github.com/Aurora0134/Anyswitch/tree/v0.7.0)
[![Platform: Windows](https://img.shields.io/badge/Platform-Windows-0078D6.svg)](#boundaries-to-accept-first)
[![Node.js: 22.15+](https://img.shields.io/badge/Node.js-22.15%2B-339933.svg)](package.json)
[![Deps: 5·terminal only](https://img.shields.io/badge/Deps-5·terminal--only-c2410c)](#mechanics-a-source-of-truth-not-just-a-forwarder)

<br>

**A relay and control panel on your own machine: configure channels once, ten agents share them, one sealed copy of each upstream key.**

<br>

The first agent is easy — five minutes, fill in a baseURL and a key. By the tenth, you are copying the same dozens of lines into a tenth config file; ten plaintext keys, each sitting in a directory that agent's process can read. A dead channel means manual switching; finding out who sent that 250 tok/s burst and through which channel means cross-checking ten windows and their logs.

The entire reason this tool exists is to make "configure once", "one sealed key", and "see at a glance who is running and which route they take" true at the same time.

```bat
git clone --branch v0.7.0 --single-branch https://github.com/Aurora0134/Anyswitch.git "%LOCALAPPDATA%\Anyswitch\app"
cd /d "%LOCALAPPDATA%\Anyswitch\app"
npm install
wscript panel-app.vbs
```

Runs locally on Windows · ships as source, no installer · panel and relay listen on loopback only

[Screenshots](#see-it-working-configuration-routing-and-readouts-in-one-window) · [Install](#install-and-run) · [Channels](#configure-once-ten-agents-plug-in) · [Failover](#one-dead-channel-should-not-stop-the-pipeline) · [Readouts](#whos-running-which-route-how-much-one-panel-answers) · [Terminal](#virtual-terminal-run-agents-inside-the-panel-readouts-beside-them) · [Boundaries](#boundaries-to-accept-first)

</div>

---

## See it working: configuration, routing, and readouts in one window

The panel lives at `http://127.0.0.1:47820/panel`, the relay at `127.0.0.1:47821`. The panel owns configuration and readouts; the relay takes the requests. They are separate processes: if the relay is down, the panel still opens and shows you the state.

<p align="center">
  <img src="docs/screenshots/s1-board.png" alt="Dashboard: service status, recent requests, per-agent instances with live output" width="48%">
  <img src="docs/screenshots/s2-channels.png" alt="Channel management: channels, pools and the model list" width="48%">
  <img src="docs/screenshots/s3-stats.png" alt="Usage stats: today's overview, 90-day heatmap and token trends" width="48%">
  <img src="docs/screenshots/s4-skills.png" alt="Skills management: main repo and per-agent deployment" width="48%">
</p>

The path of a single request:

```text
Claude Code / Codex / other agents
              │
              ▼
      127.0.0.1:47821 relay
   auth · routing · protocol conversion
              │
              ▼
   your OpenAI-compatible upstreams
```

Screenshots live in [`docs/screenshots/`](docs/screenshots/) — open them after cloning to check the page shapes. They were taken from the panel of this exact code on one machine; channel names, usage numbers and the skills list are desensitized demo data.

---

## Install and run

Three prerequisites: Windows (credential sealing uses DPAPI, autostart uses Task Scheduler); Node.js (`>=22.15.0 <23 || >=23.8.0`, 24 LTS recommended — that is the API floor, not a claim that every version in range was tested); and a fresh install directory (never overwrite a running one with new source).

Then the four lines above. `npm install` only installs the virtual terminal — 5 direct dependencies for PTY binding and rendering. Without it, the relay, panel, channel management, launchers and stats all work; only the terminal page stays closed. Start the panel manually with `node panel-launcher.mjs`; `panel-app.vbs` finds the launcher relative to itself, so the install directory can be anywhere.

Four steps to your first working request:

1. Open `http://127.0.0.1:47820/panel` and go to channel management.
2. Add a channel: channel ID, upstream Base URL, API key. On save, the key is sealed with the current Windows user's DPAPI.
3. Wait for model auto-discovery; if the upstream has no `GET /v1/models`, add model IDs by hand. Add fallback URLs if you want failover.
4. Start the client with the agent's launcher, or launch it straight from the virtual terminal — the launcher hands it the relay address and credentials; every other argument passes through unchanged.

Post-install self-check:

```bat
node --version
node --check panel-host.mjs
npm test
```

`npm test` runs the repo's full suite (141 test files, colocated with the implementation); it needs one `npm install` because the virtual-terminal tests touch the terminal host.

---

## Configure once, ten agents plug in

Ten agents, eleven wiring details — configure once and they are all here:

| Agent | Protocol surface | Launcher |
| --- | --- | --- |
| Claude Code | Anthropic Messages | `node launcher.mjs [claude args]` |
| Kimi Code | Anthropic Messages | `node kimi-launcher.mjs [kimi args]` |
| Codex CLI | OpenAI Responses | `node codex-launcher.mjs [codex args]` |
| OpenCode | OpenAI | `node opencode-launcher.mjs [opencode args]` |
| Pi | OpenAI | `node pi-launcher.mjs [pi args]` |
| ZCode | OpenAI | `node zcode-launcher.mjs [zcode args]` |
| ZCode CLI | OpenAI | `node zcode-cli-launcher.mjs [zcode args]` |
| DeepSeek Harness | OpenAI | `node dsh-launcher.mjs [dsh args]` |
| Qoder | OpenAI | `node qoder-launcher.mjs [qoder args]` |
| Grok Build | OpenAI | `node grok-launcher.mjs [grok args]` |
| WorkBuddy | OpenAI | `node workbuddy-launcher.mjs [codebuddy args]` |

ZCode CLI is explicit-configuration only: bring your own zcode CLI distribution and point `ZCODE_CLI_EXECUTABLE` at its entry file (`bin\zcode.mjs`); without it, that launcher is unavailable.

Config sync writes the managed channels into each agent's own config location; anything you wrote yourself stays untouched:

| Agent | Where Anyswitch writes |
| --- | --- |
| Kimi Code | `~/.kimi-code/config.toml` |
| Codex | `~/.codex/config.toml` plus the generated model catalog |
| OpenCode | `~/.config/opencode/opencode.json` (your `opencode.jsonc` untouched) |
| Pi | `~/.pi/agent/models.json` |
| ZCode | `~/.zcode/v2/config.json` |
| DeepSeek Harness | `~/.dsh/profiles/<name>/cordis.patch.yml` |
| Qoder | `~/.qoder/settings.json` |
| Grok Build | `~/.grok/config.toml` |
| WorkBuddy | `~/.workbuddy/models.json` |

What gets written is the local relay address and a local token — the real upstream key never enters any agent's config directory. Claude Code has no config-file surface; it gets environment variables injected by the launcher, with optional tier mapping in settings.

Channels already scattered across those configs don't need re-copying either: BYOK import scans the local configs of 9 endpoints (Claude has no local config surface), pulls OpenAI-compatible channels into the central store, carries over what it can select and honestly skips the rest. Moving machines goes through an exported config bundle; off-machine import no longer fails the whole bundle.

---

## One dead channel should not stop the pipeline

Three things govern where traffic goes: pools, route chains, and fallback URLs. Each covers one layer; they stack.

### Pools: one channel dies, try the next

Bundle 2–5 channels into a pool. Requests hitting the pool stay sticky across members — one conversation does not switch channels with every message; when the current member fails, the request falls through to the next in order. The agent sees the pool as one entry, not a scatter of channels. Manual member reordering takes effect immediately: the next request follows the new order and re-sticks.

### Route chains: the model name is not welded to one channel

Each agent's `auto` model walks its chain hop by hop. Chain nodes can be channels or pools — two layers of failover stacked. 

```text
model name
  └─ node A: primary channel
       └─ node B: pool (2–5 channels, sticky + per-member backoff)
            └─ node C: fallback channel (fallbackURLs of baseURL)
```

A node degrades after 2 consecutive failures and returns to the head of the chain after 5 minutes, driven by real requests. Deleting a channel or dissolving a pool prunes referencing chain entries in the same write — no dangling nodes. Every hop has a live lamp on the dashboard: which hop is serving, which is degraded, visible at a glance.

<p align="center">
  <img src="docs/screenshots/s5-route-chain.png" alt="Route chain editor: hop-by-hop failover chain and candidate tile wall" width="80%">
</p>

### Virtual models: one name, recognized by all ten agents

A virtual model is a name you define, bound to a chain of 1–8 nodes. Once enabled, it appears next to `auto` in all ten agents' model lists; disable it and it disappears from every catalog.

It solves "same role, different name everywhere": define `deepseek-pro` as "primary channel → backup pool", then pick it in Claude Code, pick it in Codex — both walk the same chain. Chain state is shared across agents: once one agent degrades a node, other agents' requests route around it without paying for the discovery again.

### Fallback URLs: providers with multiple entry points

A channel carries its own last line of defense: `baseURL` plus multiple `fallbackURLs`. Each URL gets a 180-second budget with exponential retry backoff (1s floor, 4s cap); a 4xx is a terminal answer and never switches URLs; a 5xx does. When all URLs are exhausted, the last real upstream 5xx is passed through; pure transport failures return 502.

---

## Who's running, which route, how much: one panel answers

Configuration and routing are the base; the readouts are what you use every day. Three places:

- **Dashboard**: relay and terminal service status, live lamps for every chain hop, recent requests (including failures and 429s), per-agent instances. Multiple sessions of one client show as multiple instance rows, not merged into one blur.
- **Usage stats**: today's overview (requests, tokens, cache hits, mean first-token latency, success rate), a 90-day heatmap, token trends, per-model usage and the request log.
- **Sessions**: scans the ten clients' own session stores on demand, no separate index. Turn counting happens in the data layer — only what you actually said counts, never tool output posing as user input.

Instance attribution is not guesswork: clients started via a launcher (or the virtual terminal) are attributed by the owning process of the connection; desktop GUI forms are recognized separately and never mistaken for another CLI. Attribution has a cold-cache window — right after relay start, before process scanning warms up, a launcher-shaped instance row can briefly appear twice; it collapses after 10 idle minutes.

---

## Virtual terminal: run agents inside the panel, readouts beside them

The virtual terminal is a full page in the panel, not a popup: it takes the whole page, with a header to return to the dashboard. It is a preview feature and needs one `npm install`; without it, only this page stays closed.

The new-tab menu lists exactly two things: a blank terminal, and the agents installed on this machine in CLI form — anything not installed never shows up. Pick an agent and start: the server assembles the session's environment — relay address, credentials, session identity. The upstream key never enters the terminal, never hits disk, never echoes. Blank terminals are fixed to PowerShell; the working directory defaults to your user directory and remembers the last one you typed.

> One exception, stated plainly: ZCode CLI does not take credentials from environment variables; the relay token is delivered as a key inside Anyswitch's own slot configuration, written only to its own config.

![New terminal: the “+” menu lists a blank terminal and the installed CLI agents](docs/screenshots/s7-terminal-launch.png)

### The panel knows whose session it is — without parsing terminal text

Every terminal session has a real shell PID on the host side. Attribution rule: if that PID appears in the ancestor chain of an agent's process, the session belongs to that agent's instance — the code comment says it outright: **nothing here parses terminal output text**.

So the side panel shows the same data as that instance — in-flight requests, first-token latency (green < 5s / yellow 5–15s / red > 15s), generation speed, cache hit rate, elapsed time, the last 10 requests. When the agent exits, the terminal stays and the metrics area disappears; start another agent in the same terminal and it re-attributes to the new instance.

Codex is the exception: its desktop sessions share one engine process, so PIDs don't line up with instance rows; it bridges by "working directory + recent activity" from its own session records, and only binds when the instance row actually exists.

### Refresh doesn't lose the scene: history replays from the render mirror

The old approach poured the raw byte stream back into the terminal — refreshing a long session made the screen messier. Replay now uses the host-side render mirror: clear the screen, redraw line by line at absolute positions, push scrolled-out history into scrollback; a full-screen TUI sitting on the alternate screen switches to it before drawing. After a refresh you stay on the terminal page, on the same tab — both states persist locally; reconnects likewise clear-then-replay, never stacking old and new content.

![Virtual terminal: tabs, session rail, terminal output and bottom bar](docs/screenshots/s6-terminal.png)

### The details you touch every day

- **IME input**: the input anchor pins to the composition start during CJK composition instead of jumping with high-frequency output.
- **Copy/paste**: bare `Ctrl+V` uses the browser's native paste; bare `Ctrl+C` copies when there is a selection and stays an interrupt otherwise, matching terminal habits.
- **Newlines**: `Ctrl+Enter` / `Shift+Enter`. Regular endpoints send LF; Codex alone sends `ESC CR` — it treats LF as submit, so it needs its own keybinding.
- **Font size**: 10–24, default 13; `− / +`, `Ctrl+±`, `Ctrl+wheel` — three entry points, terminal page only.
- **Tab bar**: collapses to give the terminal screen height; the transition is instant, container and canvas reflow in the same frame, no blank bars. Tabs can't be renamed; the server assigns labels from agent display names.
- **Closing a tab**: closing a busy tab asks first; closing kills the whole process tree — node-pty's plain console close leaves children alive, so this is a tree kill.
- **Theme**: terminal background, foreground, cursor and selection follow the panel's three skins and light/dark switch, re-rendering instantly.

The terminal's backend is a separate process (port 47823) owned by the relay: it is relaunched automatically on crash — retry after 1s, at most 5 times per 10 minutes, then parked in "error" awaiting a manual start. The page header has two switches: **Continue from where you left off** (default on — restores page and history on next start, processes are not resurrected, restored sessions are honestly marked as exited) and **Bottom auto-alignment** (default off — when on, collapses the bottom blank band while browsing history upward).

---

## Presets and skills: write once, effective in ten homes

Prompt presets are instructions for *your* way of working, not a template library. Enabled presets are injected into the instruction files of all ten endpoints (`~/.claude/CLAUDE.md`, `~/.zcode/AGENTS.md`, `~/.codex/AGENTS.md`, …), written and removed in managed, clearly marked pairs; the list supports Ctrl multi-select and batch delete, and an empty preset list cleans up after itself with no leftover blocks.

Skills use a main-repo model: one local directory acts as the source, deploying into each agent's skills directory. Deployed skills appear in each endpoint's own listing; the main repo and deployment surface are managed on the same Skills page — and only installed agents are served: anything not installed stays off the dashboard, auto-route tiles and session filters.

---

## Mechanics: a source of truth, not just a forwarder

```text
%LOCALAPPDATA%\Anyswitch\
├── store.json       channel/pool/chain/virtual-model metadata
├── credentials\     one DPAPI-sealed file per channel
├── settings.json    panel and per-agent switches
├── terminal-sessions.json  terminal session metadata and history snapshots
├── usage\           daily request and session usage (kept 90 days)
└── app\             this repo: relay, panel, launchers
```

- **`store.json` holds no secrets.** The schema has a built-in word list (apikey, token, secret, password, …) matched against field names segment by segment; a hit rejects the write. Keys connect to the credentials directory only as `credentialFile` references. Verify: `grep -n "SECRET_WORDS" store-schema.mjs`.
- **Keys decrypt only at request time.** DPAPI under the current user scope, ciphertext isolated per channel. Decrypted plaintext is reused short-term keyed by the ciphertext hash (a setting can disable this for burn-after-use: every request decrypts fresh); rotating the ciphertext invalidates it immediately.
- **Four processes, four ports, loopback only.** Panel `127.0.0.1:47820`, relay `127.0.0.1:47821`, watchdog marker `47822`, terminal host `127.0.0.1:47823`.
- **The terminal host is a separate process.** The page is just a browser client: refreshing or reopening the panel keeps the PTYs alive; history replays from the host render mirror; the host is owned and restarted by the relay.
- **Zero third-party runtime dependencies in the business code.** All 5 direct dependencies belong to the virtual terminal; across every `.mjs` there is exactly one third-party import: node-pty in `terminal-host.mjs`. Verify:

  ```bat
  node -e "console.log(Object.keys(require('./package.json').dependencies).join(' '))"
  node -e "const fs=require('fs');for(const f of fs.readdirSync('.').filter(x=>x.endsWith('.mjs')))for(const l of fs.readFileSync(f,'utf8').split(/\r?\n/))if(/^import .+ from \"/.test(l)&&!/from \"(node:|\.)/.test(l))console.log(f+': '+l.trim())"
  ```

  The second command should print only `terminal-host.mjs: import * as pty from "node-pty";`.

- **The write path is concurrency-safe.** Panel writes to the store go through content-hash CAS with a file lock; the routing catalog carries a generation digest so a config changed mid-request is never served stale.
- **Write endpoints trust only the local panel.** `POST /panel/api/*` passes Origin/Referer validation; the relay authenticates with a local token from the data root, as does the terminal host.

Scale is not the selling point, but it is verifiable: 256 `.mjs` files at the repo root (115 implementation + 141 test), roughly 52,200 lines of implementation code; the panel frontend trio `panel.js` / `panel.html` / `panel.css` together about 28,300 lines.

---

## How it differs from config switchers and system terminals

| | **Anyswitch** | CC Switch | system terminal + hand-written env vars |
| --- | --- | --- | --- |
| Acts on | request traffic: forwarding, protocol conversion, backoff, routing | config files: writes providers into each CLI | whatever you maintain yourself |
| Where the upstream key lives | DPAPI ciphertext on this machine; agent configs hold only a local token | inside the agent configs it writes (with the key) | wherever you put it — typically plaintext in a config or launch script |
| Runtime surface | built-in virtual terminal in the panel; can start agents | none | runs, but readouts and attribution live elsewhere |
| Observability | terminal side panel + dashboard + stats page, one shared instance dataset | none | each client has its own; nothing aligns |
| Failover | pools, route chains, fallback URLs, virtual models | manual provider switching | manual config edits |

Two fair notes: CC Switch is mature with a broad management surface — its provider preset library and bidirectional sync are real strengths; and the system terminal is always the fastest, least picky option. What Anyswitch adds is putting configuration, runtime and observation into one local control plane — the price is running a local relay and panel yourself.

The comparison is based on read-only research of CC Switch's public repo and docs, checked 2026-10-18.

---

## Boundaries to accept first

- **Windows only; no macOS or Linux.** DPAPI, Task Scheduler, native client detection and parts of the update path all depend on Windows.
- **No installer.** 0.7.0 ships as source; first installs and machine moves are git clone + `npm install`. After that, the panel's About page can self-update.
- **The 0.7 line is now stable.** The stable line moves from `v0.6.6` to `v0.7.0`: installations running a stable identity are offered `v0.7.0`, and installations that followed `v0.7.0-preview` return to the stable track once they land on this release.
- **The virtual terminal is still preview.** It needs its own `npm install` once; the default-off "bottom auto-alignment" and restore policy are still being polished on the preview line.
- **Restarting the relay interrupts in-flight requests and ends every terminal process alive at that moment.** The panel's **Restart** swaps the relay first, then the panel host; run it between sessions. Restarting only the panel host does not kill terminals — the terminal host is owned by the relay.
- **Refresh recovery has a scope.** It restores "still on the terminal page + which tab + whatever history the mirror can still replay"; it does not restore scroll position, does not replay everything since the session began, and does not resurrect sessions whose processes have exited.
- **Terminal tabs can't be renamed, and a blank terminal's shell is fixed to PowerShell.** GUI desktop forms (Claude Desktop, Codex desktop, …) are not terminal candidates.
- **The new UI is an opt-in toggle, not the default.** The default is still the classic layout; the screenshots show the default.
- **One-step self-update and the "bleeding edge" channel haven't completed a real update round yet.** An update replaces the running panel — that step can only be walked by the first person who clicks it.
- **Several attribution fixes live in the resident relay and need a relay restart to take effect**; the restart takes open terminal sessions with it — the page keeps the history and honestly marks the sessions as exited.
- **Instance attribution has a cold-cache window.** Right after relay start, launcher-shaped instance rows can briefly double before process scanning warms up; they collapse after 10 idle minutes.
- **In-panel launching for the ten CLIs, virtual models in all ten client pickers, and the About page's real install button** are verified down to code and tests, but not walked through on every client for you.
- **No official models, no bundled channels.** Every upstream comes from a provider you enter; ports 47820 / 47821 / 47822 / 47823 are fixed in code and not configurable in the panel.

This is the first stable release on the 0.7 line, not a 1.0 product: every line above is real. None of it stops someone whose channels are scattered across ten config files from using it — all of it decides whether it belongs on a production pipeline.

---

## Where the code is, where the data is

```text
Anyswitch/
├── panel-host.mjs              # 47820 panel host
├── relay-host.mjs              # 47821 resident relay host (owns the terminal host)
├── panel.mjs                   # panel API and static page routing
├── panel-ui/                   # panel pages, styles and scripts
├── launch.mjs                  # relay production assembly and request forwarding
├── launcher.mjs                # Claude Code launcher
├── *-launcher.mjs              # launchers for the other endpoints (ZCode desktop and CLI each)
├── agent-sync.mjs              # syncs managed channels into agent configs
├── byok-import.mjs             # imports channels from agent local configs
├── agent-metrics.mjs           # processes, requests, instances and dashboard readouts
├── terminal-host.mjs           # 47823 terminal host: PTY and session state
├── terminal-screen.mjs         # terminal render mirror and replay
├── terminal-attribution.mjs    # terminal-session-to-instance attribution
├── agent-session-env.mjs       # launch and env assembly when starting agents
├── session-scan.mjs            # per-agent session reading and adaptation
├── agent-skills.mjs            # skills main repo and deployment
├── skills/anyswitch-preset/    # optional preset-management skill
├── docs/                       # architecture docs and real screenshots
├── package.json                # version, Node range, virtual-terminal deps
├── SECURITY.md                 # vulnerability reporting and security model
└── LICENSE                     # Apache-2.0
```

To check the actual change scope of this release:

```bat
git log --no-merges --oneline v0.6.6..v0.7.0
```

---

## When upgrading: keep your data and `.git`

User data lives one level above `app` in `%LOCALAPPDATA%\Anyswitch\`: channels, credentials, settings, presets and usage records never follow the source directory.

The preferred upgrade entry point is in the panel: **Settings → About → Check for updates**. Confirm once on "Update now" and download plus swap complete automatically; background pre-download ("auto-check and download updates") is off by default. To walk the same path manually, first schedule a quiet moment for open sessions, then check the install directory's working tree:

```bat
cd /d "%LOCALAPPDATA%\Anyswitch\app"
git status --short
```

If there is output, deal with your own changes first — never discard them for an upgrade. With a clean tree, fetch only the target tag:

```bat
git fetch --no-tags origin tag v0.7.0
git switch --detach v0.7.0
npm install
```

Do not copy new source over an old install, and do not upgrade with `git reset --hard`; keep `.git` and the external Git object store it points to, and back up `%LOCALAPPDATA%\Anyswitch\` before upgrading.

---

## Feedback and contributions

- **Bugs**: include the Windows version, Node version, agent form, reproduction steps and the actual error; never attach API keys, credential files or full session contents.
- **Feature proposals**: first say where your workflow gets stuck, then the outcome you want; leave implementation approaches to the discussion.
- **Code changes**: follow [`CONTRIBUTING.md`](CONTRIBUTING.md) — Node.js ESM, built-in `node:test`, specs and code updated in the same commit.

## Acknowledgements and inspiration

- The prompt-preset management feature was inspired by [RP-Hub](https://github.com/STA1N156/RP-Hub).
- The usage-stats page design partially references ZCode.
- The virtual-model and auto-routing design borrows from [autoAPI](https://github.com/happy66dev/AutoAPI).
- The positioning difference versus [CC Switch](https://github.com/farion1231/cc-switch) is in the comparison section above.

## License

[Apache-2.0](LICENSE) — use it, modify it, distribute it, keep the license and copyright notice. Third-party product names and trademarks belong to their owners; see [`NOTICE`](NOTICE).

---

<div align="center">

**Your channels are configured once, inside Anyswitch.**<br>
*Ten agents share them.*

</div>
