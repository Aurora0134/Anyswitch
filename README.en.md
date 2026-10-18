<sub>🌐 <a href="README.md">中文</a> · <b>English</b></sub>

<div align="center">

<p><img src="docs/assets/logo.png" alt="Anyswitch logo" width="128"></p>

# Anyswitch

> *"Set up a channel once. Nine agents share one terminal."*

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-2ea44f.svg)](LICENSE)
[![Version: 0.7.0-preview](https://img.shields.io/badge/Version-0.7.0--preview-007ec6.svg)](https://github.com/Aurora0134/Anyswitch/tree/v0.7.0-preview)
[![Platform: Windows](https://img.shields.io/badge/Platform-Windows-0078D6.svg)](#boundaries-to-accept-first)
[![Node.js: 22.15+](https://img.shields.io/badge/Node.js-22.15%2B-339933.svg)](package.json)

<br>

**Set up your channels once, then launch, watch and switch nine coding agents in one window — with credentials that never leave this machine.**

<br>

Setting up channels for your first agent is a pleasure: base URL, key, tick the models. Five minutes. By the fourth agent you are copying the same dozens of entries into a fourth file; by the ninth, nine files hold nine copies of your keys in plaintext, each one readable by that agent's process.

The workday is worse: nine windows each telling a different story, a dead channel that has to be swapped by hand, long sessions that break mid-sentence, and no way to answer "who sent that 250 tok/s request just now" without lining up timestamps across logs.

This tool exists for one reason: make "configure once", "store one ciphertext", and "see who is running at a glance" true at the same time.

```bat
git clone --branch v0.7.0-preview --single-branch https://github.com/Aurora0134/Anyswitch.git "%LOCALAPPDATA%\Anyswitch\app"
```

Windows-local · source distribution, no installer · relay listens on loopback only

[See it](#see-it-launch-and-readouts-in-one-window) · [Install](#install-and-run) · [Virtual terminal](#virtual-terminal-the-agent-runs-its-readouts-sit-beside-it) · [Boundaries](#boundaries-to-accept-first)

</div>

---

## See it: launch and readouts in one window

The panel is at `http://127.0.0.1:47820/panel`, the relay at `127.0.0.1:47821`. They run as separate processes: stop the relay and the panel still opens to show you its state.

![Virtual terminal: tabs, session bar, terminal output and the footbar (the right rail can be expanded; it is collapsed here)](docs/screenshots/s6-terminal.png)

One real path, four steps:

1. Add a channel under Channels: base URL, API key, automatic model discovery. On save the key is sealed with the current Windows user's DPAPI.
2. Open Virtual terminal and press "+". The menu lists only CLI agents actually installed on this machine; pick one, set the working directory, press Start.
3. It runs inside the panel. The right rail is that instance's time to first token, generation speed, cache hit rate, working time and recent requests.
4. Press F5: you stay on the terminal page and on the same tab; the screen is replayed line by line from the host's render mirror, and a reconnect clears the screen first.

![New terminal: a blank terminal or any installed CLI agent, with an editable working directory](docs/screenshots/s7-terminal-launch.png)

The rail is not an estimate: it reads the same instance data as the dashboard, and "which agent is in this tab" is resolved by process and instance id — never by parsing terminal output.

The dashboard is the same readouts rolled up; the virtual terminal entry sits in its left column:

![Dashboard: service status, the virtual terminal entry, agent instances and live output](docs/screenshots/s1-board.png)

<sub>The screenshots were taken from the panel running this same code; the version badge it read at startup still says 0.6.6 because the version bump had not happened yet.</sub>

Self-check after install, from the install directory:

```bat
node --version
node --check panel-host.mjs
curl http://127.0.0.1:47821/
```

The last one should return the relay's health state, for example:

```json
{"status":"ok","service":"anyswitch-relay","degraded":false,"consecutiveFailures":0,"lastFailureKind":null}
```

---

## Install and run

### Three things to prepare

- Windows. Credential sealing uses Windows DPAPI, autostart uses a scheduled task, and client detection plus parts of the update path depend on Windows as well.
- Node.js. `package.json` asks for `>=22.15.0 <23 || >=23.8.0`; Node 24 LTS is recommended. That is the API floor, not a claim that every version in the range has been tested.
- A fresh install directory. Do not overlay new source onto a running install.

### First install

```bat
git clone --branch v0.7.0-preview --single-branch https://github.com/Aurora0134/Anyswitch.git "%LOCALAPPDATA%\Anyswitch\app"
cd /d "%LOCALAPPDATA%\Anyswitch\app"
npm install
wscript panel-app.vbs
```

`npm install` only exists for the virtual terminal: five direct dependencies for the terminal process binding and the renderer. Skip it and the relay, panel, channel management, launchers and stats all keep working — only the terminal page will not open.

You can start the panel by hand too: `node panel-launcher.mjs`. `panel-app.vbs` finds the launcher relative to itself, so the install directory does not have to be fixed; a desktop shortcut can point at it.

### Four steps to your first request

1. Open `http://127.0.0.1:47820/panel` and go to Channels.
2. Add a channel: channel ID, upstream base URL, API key. On save the key is sealed with the current Windows user's DPAPI.
3. Wait for model discovery; if the upstream has no `GET /v1/models`, add model IDs by hand. For failover, add fallback addresses as well.
4. Start the client through its launcher, or start it directly inside the virtual terminal — the relay address and auth are handed to it by the launcher, everything else is passed through unchanged.

Self-check after install:

```bat
node --version
node --check panel-host.mjs
npm test
```

`npm test` is the repository's own full test suite; it needs `npm install` once, because the virtual terminal tests touch the terminal host.

---

## Virtual terminal: the agent runs, its readouts sit beside it

The virtual terminal is a page of its own, not a pop-over: full page, a header that returns to the dashboard, and a tab bar you can fold away to give the terminal screen more height.

### The "+" menu lists only what you have installed

The new-terminal menu offers two things: a blank terminal, and the CLI forms of agents installed and detected on this machine. All nine endpoints — Claude Code, Codex, Kimi Code, OpenCode, Pi, DeepSeek Harness, Grok Build, Qoder, ZCode — are candidates when their CLI form is installed; desktop graphical forms do not enter the terminal, and nothing you have not installed appears at all.

After you pick an agent and press Start, the server assembles that session's environment: relay address, auth, session identity. Upstream keys never enter the terminal, never touch disk, are never echoed. A blank terminal is fixed to PowerShell; the working directory defaults to your user directory and remembers the last one you typed.

> One exception, stated plainly: ZCode CLI does not read credentials from the environment, so the relay token is delivered as a key inside Anyswitch's own config slot — written only into its own configuration.

### The panel knows which session belongs to whom — without guessing from terminal text

Every terminal session carries a real shell process id on the host side. Attribution is: that shell pid appears in some agent process's ancestor chain, so the session belongs to that agent's instance. The code says it plainly: **nothing here parses terminal output text.**

That is why the right rail shows the same data as the dashboard for that instance: in-flight requests, time to first token (under 5s green / 5–15s amber / over 15s red), generation speed, cache hit rate, working time, and the last 10 requests. When the agent exits the terminal remains; the monitoring area disappears with the agent. Start another agent in the same terminal and it is attributed to the new instance.

Codex is the exception: its desktop sessions share one engine process, so a pid-shaped instance row never exists. It is bridged by "working directory + last active" from Codex's own session records, and only bound when that instance row really exists.

### Refresh does not wash the screen: history is rebuilt from the render mirror

The old approach handed the raw byte stream back to the terminal, and the longer the session, the worse the screen got. Replay now uses the host-side render mirror: clear the screen first, then repaint line by line at absolute positions and push scrolled-off history back into scrollback; a full-screen TUI that is currently on the alternate screen gets the replay drawn there.

After a refresh you stay on the terminal page and on the original tab — both states have their own local record. A reconnect clears and replays the same way, so old and new content never stack into two copies. What the host can replay is budgeted — the mirror holds at most 5000 lines / 1MB and a single replay is capped at 2MB — so "all history is here" is not true; it is "whatever is still in the mirror".

### The details you hit every day

- **Chinese input methods**: during composition the input anchor is pinned at the composition start, so a busy output stream cannot drag it around.
- **Copy and paste**: plain `Ctrl+V` goes to the browser's native paste; plain `Ctrl+C` copies when there is a selection and still sends an interrupt when there is none — the usual terminal habit.
- **Newlines**: `Ctrl+Enter` / `Shift+Enter` insert a newline. Normal endpoints get LF; Codex gets `ESC CR` on its own — it treats LF as submit, so the key has to hit its own newline binding.
- **Font size**: 10–24, default 13; the `− / +` buttons, `Ctrl+±` and `Ctrl+wheel` all work, only on the terminal page.
- **Tab bar**: can be hidden and shown as a whole. The change is instant, with no animation; this release fixes the container and canvas re-laying out in the same frame, so folding no longer flashes a blank strip.
- **Bottom auto-alignment**: off by default. Turned on, scrolling up through history trims the blank band left by window resizing, and scrolling back to the bottom lands exactly at the end.
- **Theme**: terminal background, foreground, cursor and selection follow the panel's three skins and light/dark switching, live.

### Tabs, service and settings

Tabs can be created, closed and switched; labels come from the server using the agent's display name and cannot be renamed. Closing a tab that is still working asks first, and closing ends that whole process tree — node-pty only closes the pseudo-console, so processes detached from the console would not exit on their own, hence the tree kill.

The terminal's background service is a separate process (port 47823) owned by the relay: if it crashes it is respawned after one second, at most five times in ten minutes; past that it stays "crashed" until started by hand. The page header carries two switches:

- **Continue where you left off** (on by default): the next time the terminal service starts, pages and history are restored — but processes are not revived, and restored sessions are honestly marked as exited.
- **Bottom auto-alignment** (off by default): see above.

![Terminal settings: continue where you left off, bottom auto-alignment](docs/screenshots/s8-terminal-settings.png)

---

## Configure a channel once, nine endpoints see it

Nine agents, nine ways in, all configured in one place:

| agent | protocol surface | how to launch |
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

Config sync writes managed channels into each agent's own configuration location, leaving everything you wrote by hand intact:

| agent | where Anyswitch writes |
| --- | --- |
| Kimi Code | `~/.kimi-code/config.toml` |
| Codex | `~/.codex/config.toml` plus the generated model catalogue |
| OpenCode | `~/.config/opencode/opencode.json` (your `opencode.jsonc` is untouched) |
| Pi | `~/.pi/agent/models.json` |
| ZCode | `~/.zcode/v2/config.json` |
| DeepSeek Harness | `~/.dsh/profiles/<name>/cordis.patch.yml` |
| Qoder | `~/.qoder/settings.json` |
| Grok Build | `~/.grok/config.toml` |

What lands in those files is the local relay address and a local token — upstream keys never enter any agent's configuration directory. Claude Code has no configuration surface at all; it goes through launcher-injected environment variables.

Channels already scattered across those configs do not need to be re-copied either: BYOK import scans the local configuration of eight endpoints (Claude has no local configuration), pulls OpenAI-compatible channels into the central store, takes over what it can, and honestly skips what it cannot.

---

## One dead channel should not stop the pipeline

Three things control where traffic goes: pools, route chains and fallback addresses. They work at different layers and stack together.

- **Pools**: gather 2–5 channels into a pool. One conversation stays sticky to a member instead of switching channel every message; when the current member fails, requests fall through to the next one in order.
- **Route chains**: an agent's `auto` model walks the chain hop by hop; a node can be a channel or a pool. A node demotes after 2 consecutive failures, and a real request drives it back to the head of the chain after 5 minutes.
- **Virtual models**: a name you define, bound to a chain of 1–8 nodes, appears under the same name in all nine agents' model lists; when one agent demotes a node, another agent's requests route around it.
- **Fallback addresses**: one more layer per channel. Each address gets a 180-second generation budget with 1/2/4-second exponential backoff; 4xx is terminal, only 5xx moves to the next address; when every address is exhausted the last real upstream 5xx is passed through, and pure transport failure returns 502.

```text
model name
  └─ node A: primary channel
       └─ node B: pool (2–5 channels, sticky + per-member failover)
            └─ node C: fallback channel (`fallbackURLs` of the base URL)
```

Deleting a channel or dissolving a pool prunes the chain entries that referenced it in the same write, leaving no dangling node; every hop has a live lamp on the dashboard, so you can see which hop is walking and which is demoted.

---

## Mechanism: not a forwarder — the local source of truth for configuration

```text
%LOCALAPPDATA%\Anyswitch\
├── store.json       channel, model, pool, route-chain and virtual-model metadata
├── credentials\     one DPAPI ciphertext file per channel
├── settings.json    panel and per-agent switches
├── terminal-sessions.json  terminal session metadata and screen snapshots
├── usage\           per-day request and session usage (kept for 90 days)
└── app\             this repository: relay, panel, launchers
```

- **`store.json` holds no secrets.** Its schema has a built-in word list (apikey, token, secret, password…) matched against every field name and refuses to write on a hit; keys connect to the credentials directory only through a `credentialFile` reference. Check: `grep -n "SECRET_WORDS" store-schema.mjs`.
- **A key is decrypted at request time.** DPAPI in the current user scope, ciphertext isolated per channel. The decrypted value is reused briefly in-process by ciphertext hash by default (switchable off in settings, which makes it per-request and to-zero); rotating the ciphertext invalidates it immediately.
- **Three processes, four ports, all loopback only.** Panel `127.0.0.1:47820`, relay `127.0.0.1:47821`, watchdog marker `47822`, terminal host `127.0.0.1:47823`.
- **The terminal host is a separate process.** The page is only a browser client: refresh or reopen the panel and the PTY survives; history is replayed from the host's render mirror. The host is owned and supervised by the relay.
- **No third-party runtime dependency in business code.** The five direct dependencies all belong to the virtual terminal, and the only third-party import in any `.mjs` is node-pty in `terminal-host.mjs`. Verify:

  ```bat
  node -e "console.log(Object.keys(require('./package.json').dependencies).join(' '))"
  node -e "const fs=require('fs');for(const f of fs.readdirSync('.').filter(x=>x.endsWith('.mjs')))for(const l of fs.readFileSync(f,'utf8').split(/\r?\n/))if(/^import .+ from \"/.test(l)&&!/from \"(node:|\.)/.test(l))console.log(f+': '+l.trim())"
  ```

  The second command should print exactly one line: `terminal-host.mjs: import * as pty from "node-pty";`.

- **Writes are protected.** Panel writes to the store go through content-hash CAS plus a file lock; the routing catalogue carries a generation digest and refuses to serve a stale catalogue mid-request.
- **Panel write endpoints only answer the local panel.** `POST /panel/api/*` must pass a trusted Origin/Referer check; the relay authenticates with the local token in the data root, and so does the terminal host.

Scale is not the pitch, but it is checkable: the repository root has 239 `.mjs` files (108 implementation, 131 test), about 46,195 lines of implementation; the panel front end — `panel.js` / `panel.html` / `panel.css` — is about 23,900 lines.

---

## How it differs from config switchers and a plain terminal

| | **Anyswitch** | CC Switch | A terminal + hand-written env vars |
| --- | --- | --- | --- |
| Operates on | Request traffic: forwarding, protocol translation, failover, routing | Configuration files: writes providers into each CLI | Whatever you maintain by hand |
| Upstream keys live | DPAPI ciphertext locally; agent configs hold only a local token | In the agent configs it writes (keys included) | Wherever you wrote them, usually plaintext in configs or launch scripts |
| Run surface | A built-in virtual terminal that can start agents | None | It runs, but readouts and attribution live elsewhere |
| Observability | Terminal rail + dashboard + stats page, one set of instance data | None | Each client has its own, none aligned |
| Failover | Pools, route chains, fallback addresses, virtual models | Switch provider by hand | Edit configuration by hand |

Two fair points: CC Switch is mature and broad, with a strong provider-preset library and two-way sync; a plain terminal is always the fastest, least opinionated choice. What Anyswitch adds is putting configuration, execution and observability on one local control plane — the price is running a local relay and panel yourself.

Comparison based on read-only research into CC Switch's public repository and documentation, checked 2026-10-18.

---

## Security and data flow: ciphertext on disk, plaintext only in memory

- **Upstream keys land on disk as ciphertext.** One DPAPI ciphertext file per channel; decryption needs the current Windows user context, so another user account cannot read them.
- **Agent configuration directories hold no upstream key.** What goes in is `http://127.0.0.1:47821/...` and a local token; the real key never passes through any agent process.
- **Panel and relay listen on loopback only.** No `0.0.0.0` binding; panel write endpoints also carry an Origin/Referer check, so an arbitrary page in your browser cannot rewrite your configuration.
- **Credentials injected into a terminal travel only through environment variables** (ZCode CLI's own config slot is the exception, see above): not in the terminal process's launch arguments, not on disk, never echoed; the terminal host validates env key names and total size when creating a session.
- **Upstream requests do leave the machine.** They go to the providers you typed into your channels. Anyswitch protects credential storage, routing configuration and the local control plane; it does not pretend upstream calls are offline.

Security issues go through the GitHub Security Advisories pointed to by [`SECURITY.md`](SECURITY.md); do not post exploitable details publicly.

---

## Boundaries to accept first

- **Windows only; no macOS or Linux.** DPAPI, scheduled tasks, native client detection and parts of the update path all depend on Windows.
- **No installer.** 0.7.0 ships as source; first install and moving machines are git clone + `npm install`. Once installed, the panel's About page can do a two-step self-update (download → apply).
- **The virtual terminal is still a preview feature.** It needs its packages installed once, and this release's default-off bottom auto-alignment and restore policy keep being polished on the preview line.
- **Restarting the relay interrupts in-flight requests and ends every terminal process open at that moment.** The panel's "restart" replaces the relay first and then the panel host, so pick your moment. Restarting only the panel host does not kill terminal processes — the terminal host is owned by the relay.
- **Refresh restore has a range.** It restores "stays on the terminal page + which tab + whatever history is still in the mirror"; it does not restore scroll position, does not replay everything since the session started, and sessions whose process already exited are not revived.
- **Terminal tabs cannot be renamed, and a blank terminal's shell is fixed to PowerShell.** Graphical desktop clients (Claude Desktop, Codex desktop and the like) are not terminal candidates.
- **Launching each of the nine CLIs inside the panel, showing virtual models one by one in each client's picker, and the About page's real install button** were checked at code and test level, not walked one by one on every client on your behalf.
- **Instance attribution has a cold-cache window.** Right after the relay starts, before process scanning warms up, a launcher-shaped instance row can briefly split in two; it is reaped after 10 idle minutes.
- **The new left-rail interface is an optional switch, not the default.** The classic top-bar layout is still what you see; the screenshots are of that default.
- **No official models and no built-in channels.** Every upstream comes from a provider you add yourself.

This is a 0.7-line preview, not a 1.0 product: every item above is real, and none of it prevents people whose channels are scattered across nine config files from using it — but it decides whether it can go on a production pipeline.

---

## Where the code is, where the data is

```text
Anyswitch/
├── panel-host.mjs              # 47820 panel host
├── relay-host.mjs              # 47821 resident relay host (also supervises the terminal host)
├── panel.mjs                   # panel API and static page routes
├── panel-ui/                   # panel page, styles and scripts
├── launch.mjs                  # relay production assembly and request forwarding
├── launcher.mjs                # Claude Code launcher
├── *-launcher.mjs              # launchers for other endpoints (ZCode desktop and CLI separately)
├── agent-sync.mjs              # sync managed channels into each agent's config
├── agent-metrics.mjs           # processes, requests, instances and dashboard readouts
├── terminal-host.mjs           # 47823 terminal host: PTYs and session state
├── terminal-screen.mjs         # terminal render mirror and replay
├── terminal-attribution.mjs    # joins terminal sessions to agent instances
├── agent-session-env.mjs       # launch and env assembly for agent sessions
├── session-scan.mjs            # reading and adapting each agent's sessions
├── agent-skills.mjs            # Skills main repository and deployment
├── skills/anyswitch-preset/    # optional preset-management skill
├── docs/                       # architecture docs and real screenshots
├── package.json                # version, Node range, virtual terminal dependencies
├── SECURITY.md                 # vulnerability reporting and security model
└── LICENSE                     # Apache-2.0
```

To check what this release actually contains:

```bat
git log --no-merges --oneline v0.6.6..v0.7.0-preview
```

---

## Upgrading: keep your data and `.git`

User data lives in `%LOCALAPPDATA%\Anyswitch\`, above `app`: channels, credentials, settings, presets and usage records are not replaced with the source directory.

Schedule a break in active sessions first, then inspect the working tree of the install directory:

```bat
cd /d "%LOCALAPPDATA%\Anyswitch\app"
git status --short
```

Anything printed there is yours to handle — do not throw it away just to upgrade. With a clean working tree, fetch only the target tag:

```bat
git fetch --no-tags origin tag v0.7.0-preview
git switch --detach v0.7.0-preview
npm install
```

The preferred entry point is inside the panel: **Settings → About → Check for updates**. Download only pulls the target tag into the local repository without touching the working tree; apply swaps it in and restarts the relay and panel. Do not overlay new source onto the old install, and do not upgrade with `git reset --hard`; keep `.git` and the external Git object store it points to, and back up `%LOCALAPPDATA%\Anyswitch\` first.

This is the preview line: installations running a stable identity are not offered `v0.7.0-preview`, and the stable line remains `v0.6.6`; installations running a preview identity are offered the upgrade as usual.

---

## Feedback and contributing

- **Bug reports**: include the Windows version, Node version, agent form, reproduction steps and the actual error; do not attach API keys, credential files or full session content.
- **Feature proposals**: start from the step where your workflow stops, then describe the outcome you want; keep the implementation in the discussion.
- **Code changes**: follow [`CONTRIBUTING.md`](CONTRIBUTING.md) — Node.js ESM, built-in `node:test`, specs and code updated in the same commit.

## Acknowledgements

- Prompt-preset management was inspired by [RP-Hub](https://github.com/STA1N156/RP-Hub).
- The usage stats page's design partly references ZCode.
- Virtual models and auto-routing borrow from [autoAPI](https://github.com/happy66dev/AutoAPI).
- The positioning difference from [CC Switch](https://github.com/farion1231/cc-switch) is described in the comparison section above.

## License

[Apache-2.0](LICENSE) — use it, change it, redistribute it, keep the license and copyright notice. Third-party product names and trademarks belong to their respective owners; see [`NOTICE`](NOTICE).

---

<div align="center">

**Anyswitch** puts configuration, execution and readouts in one local window.<br>
**You** only set it up once.<br>
*Set up a channel once. Nine agents share one terminal.*

</div>
