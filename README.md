---
description: "Operate WebShells in original DeepSeek Harness Desktop with background input, text capture, approvals and an optional RAG service."
kind: "package-bundle"
---

# DSH Ops Plugin

English | [中文](README.zh.md)

# Let DeepSeek Handle Tedious WebShell Operations for You

## Summary

Use natural-language requests to operate WebShells inside original DeepSeek Harness Desktop, without rebuilding the application. The plugin inputs and reads in background Browser tabs; a normal command is submitted once and read after a configurable ten-second wait. Separate write/read tools support interactive commands and longer waits. WebSocket/xterm/DOM text is preferred, with screenshots as fallback. Sensitive commands require confirmation. Local Markdown records and an optional pgvector/BM25/rerank API support knowledge retrieval. This is an Ops assistant, not a complete SRE platform.

## Table of Contents

Optional [Markdown knowledge service](knowledge-service/README.md): independent pgvector storage, BM25/vector retrieval, SiliconFlow reranking and incremental synchronization.

For original Desktop integration without rebuilding the app, see the Desktop guide: [English](DESKTOP.md) | [中文](DESKTOP.zh.md). The root CLI package and the Desktop variant are separate builds.

For the complete connection, login, operation record and RAG scope, see [requirements](REQUIREMENTS.md) / [中文需求](REQUIREMENTS.zh.md) and [implementation design](DESIGN.md) / [中文设计](DESIGN.zh.md). These documents distinguish current capabilities from planned work.

- [Capabilities and requirements](#requirements)
- [Installation and launch](#use-this-package)
- [Configuration](#configuration)
- [Daily use and recovery](#usage)
- [Connections and privacy](#records)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="requirements"></a>
## Capabilities and requirements

The Desktop plugin version is `0.2.0-rc.2.20261010.13`, targeting official DSH `0.2.0-rc.2`. The internal package name is `dsh-sre-webshell` and plugin ID is `sre-webshell`; Desktop uses the `desktop` profile. The root package retains legacy CLI version `0.1.0` and profile `sre`.

Only the original Desktop plugin is supported for Desktop integration. The recompiled DSH2 application is abandoned; do not install it or use its custom-main-process transport. See the Desktop guide: [English](DESKTOP.md) | [中文](DESKTOP.zh.md).

| Capability | Current behavior |
|---|---|
| WebShell | Original Desktop's embedded Browser; legacy CLI can use managed Chromium or optional Windows native-tab mode |
| Input | Page-scoped terminal input followed by one Enter; Desktop text operations do not require an active tab or OS foreground |
| Input protection | An uncertain typing or Enter result locks further writes until manual inspection and rebind; no automatic replay |
| IME/punctuation | Managed input uses browser Unicode events, independent of the host IME; native Windows mode retains layout/IME checks |
| Output | Normal run waits 10 seconds by default; optional WebSocket/xterm/DOM text first, then screenshot and wheel fallback; separate read supports long waits |
| Policy | Limited POSIX diagnostics and approved changes; separate critical-action opt-in |
| Records | Optional DPAPI-protected WebShell/SSH bookmarks and runbooks; submitted operations write provisional Markdown records and update verified outcomes; SSH execution is unavailable |
| Audit | Hash-chained metadata, including the acknowledged `submitted` phase; remote completion requires an output marker and exit code, not merely a successful send |

Desktop requires official DSH `0.2.0-rc.2`, a logged-in WebShell in its embedded Browser and a POSIX remote shell. Text input/read does not need a DevTools port, external Chrome or OS keyboard simulation. Screenshot fallback needs an image-capable model. Client adapters cannot read cross-origin frames or arbitrary inaccessible WebSockets; cloud consoles require separate acceptance. The plugin does not control the Codex in-app browser.

Legacy CLI helpers target DSH `0.1.6-alpha.2`, with a built DSH checkout in the parent directory and portable Node `22.23.2` at `.runtime/node-v22.23.2-win-x64/node.exe`. Managed CLI mode additionally needs Chrome/Edge and a graphical session for first login; native mode remains Windows-only. Peer versions are in [package.json](package.json) and [desktop/package.json](desktop/package.json). This is not an npm-published, install-anywhere package.

On Linux, use system Node within DSH's engine range and `bash sre-webshell/Build.sh`; configure the local `sre` profile with Linux paths before `bash sre-webshell/Start-SRE.sh`. The shell launcher requires an installed profile and uses `DSH_HOME` when set. These scripts do not install Chrome/Edge or DSH.

-----

<a id="use-this-package"></a>
## Installation and launch

### Original Desktop: recommended

Follow the Desktop guide: [English](DESKTOP.md) | [中文](DESKTOP.zh.md). Build only the `desktop/` plugin variant, fully quit DSH, install the plugin archive into its `desktop` profile through the bundled official CLI, then reopen DSH. Enable the plugin and configure its target URL and local data paths. The application executable and `app.asar` are not replaced. Open and sign in to the target WebShell inside DSH's Browser; ordinary run/write/read automatically bind the unique matching tab.

RAG is optional: configure its endpoint, timeout and token reference in the plugin settings page, and configure the independent knowledge service separately. Its SiliconFlow key must stay in a private `.env`; see the [knowledge-service guide](knowledge-service/README.md). Without the service, local runbooks remain available.

### Legacy CLI source checkout

Install and build [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) using its own instructions first. Place this repository's contents in a directory named `sre-webshell` directly inside the DSH checkout:

```text
DSH/
  apps/cli/lib/bin.js
  node_modules/
  .runtime/node-v22.23.2-win-x64/node.exe
  sre-webshell/
    package.json
    Build.ps1
    Start-SRE.ps1
    src/
    operations/
```

The loading layers contain `D:/Program Files/DSH/sre-webshell` paths. For another location, update skill, operations/runtime and local built-entry paths in `cordis.patch.yml` and `local.patch.yml`. Preserve the bundle's `name: dsh-sre-webshell`. From the DSH directory, build and test:

```powershell
& './sre-webshell/Build.ps1'
& './sre-webshell/Test.ps1'
```

The build links workspace dependencies and emits `lib/`; it does not install/build DSH. Parent dependencies, portable runtime and built CLI must already exist. Generated files and dependencies are not committed.
The build also emits `lib/client.js` for the Web plugin settings page; restart DSH after installation or upgrade to load that browser bundle.

Install the local bundle into a dedicated profile through the official CLI:

```powershell
$env:Path = (Join-Path (Get-Location) '.runtime/node-v22.23.2-win-x64') + ';' + $env:Path
$env:COREPACK_HOME = Join-Path (Get-Location) '.runtime/corepack'
$env:DSH_HOME = Join-Path (Get-Location) '.dsh-home'
& './.runtime/node-v22.23.2-win-x64/node.exe' './apps/cli/lib/bin.js' plugin --profile sre add 'link:./sre-webshell'
```

In `.dsh-home/profiles/sre/package.json`, set `dsh.profile.bundles` to the ordered list below. Preserve existing dependencies and other fields; this block shows only bundle selection. A custom profile initialized by `plugin add` includes base, not automatically the Web application.

```json
{
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-sre-webshell"
      ]
    }
  }
}
```

Add the operator patch below, then start from the DSH directory:

```powershell
& './sre-webshell/Start-SRE.ps1'
```

Use `-NoOpen` to suppress opening DSH's page. Keep PowerShell running; DSH's local URL token is a secret. If the profile is absent, the launcher uses the Web template plus `local.patch.yml`, still with desktop control disabled. This fallback does not replace explicit installation/configuration. Keep this profile separate from a general-purpose assistant.

The root package supports the legacy CLI; `desktop/` provides a DSH `0.2.0-rc.2` variant. Original Desktop uses the plugin's Client bridge for background embedded Browser automation, without rebuilding the main process. Desktop owns its separate `desktop` profile and does not inherit `sre`. See the [Desktop guide](DESKTOP.md) for migration, configuration and acceptance scope.

-----

<a id="configuration"></a>
## Configuration

Managed mode is the default: do not start a debugging browser or configure `browserDebugUrl`. The plugin launches a persistent profile under `runtimeDir/managed-browser-profile`; call `webshell_open` or `terminal_observe`, sign in once in the new window, then observe and bind. On Linux, replace the Windows paths below with the actual installation paths. The following manual DevTools launch applies only to optional `browserMode: native` on Windows; [Chrome 136 and later](https://developer.chrome.com/blog/remote-debugging-port) require a non-default `--user-data-dir` for it.

```powershell
& 'C:/Program Files/Google/Chrome/Application/chrome.exe' --remote-debugging-port=9222 --user-data-dir='D:/Program Files/DSH/sre-webshell/.runtime/chrome-profile'
# Or: & 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' --remote-debugging-port=9222 --user-data-dir='D:/Program Files/DSH/sre-webshell/.runtime/edge-profile'
```

Edit `.dsh-home/profiles/sre/cordis.patch.yml`, a top-level YAML array. Replace directories and the exact target URL, including fragment/query, and preserve unrelated rows. This enables managed browser control, direct text capture and screenshot fallback, not critical actions or credentials:

```yaml
- id: sre-webshell
  config:
    operationsDir: 'D:/Program Files/DSH/sre-webshell/operations'
    runtimeDir: 'D:/Program Files/DSH/sre-webshell/.runtime'
    enabled: true
    targetUrl: 'https://webshell.example.invalid/#/shell'
    browserMode: managed
    autoScreenshot: true
    directReadDelayMs: 10000
    inputAttempts: 3
    typingIntervalMs: 8
    maxWheelTicks: 20
    allowCritical: false
    allowCredentialInjection: false
- id: permission
  config:
    defaultPreset: sre-full-access
    presets:
      read-only:
        sandbox: read-only
        approval: ask
      workspace-write:
        sandbox: workspace-write
        approval: ask
      danger-full-access:
        sandbox: danger-full-access
        approval: never
      sre-full-access:
        sandbox: danger-full-access
        approval: ask
```

| Setting | Default and meaning |
|---|---|
| `enabled` | `false`; activates WebShell tools and an exclusive tool allowlist |
| `targetUrl` | Empty; exact WebShell URL, required in managed mode |
| `browserMode` | `managed`; `native` selects the legacy Windows foreground driver |
| `managedBrowserChannel` / `managedBrowserExecutablePath` | Empty; automatic Edge on Windows or Chrome on Linux, or an explicit channel/executable override |
| `managedUserDataDir` | Empty; defaults to `runtimeDir/managed-browser-profile` for persistent login |
| `browserDebugUrl` | Empty; native mode only, optional loopback Chromium DevTools origin for text output; incompatible with managed mode |
| `browserDebugTimeoutMs` | `3000`; bounded target discovery and DevTools connection timeout |
| `textOutputAttempts` | `3`; direct probes within one normal read before screenshot fallback |
| `textOutputPollMs` | `200`; delay between direct probes, bounded to 0–2000 ms |
| `textOutputMaxChars` | `262144`; maximum characters retained per candidate terminal stream |
| `directReadDelayMs` | `10000`; wait after `terminal_run` sends Enter before one output read, bounded to 0–60000 ms |
| `autoScreenshot` | `false`; window capture, DSH attachment storage and model transmission without per-image approval |
| `inputAttempts` | `3`; legacy critical-action input flow only; ordinary commands use one page-scoped or native Unicode attempt |
| `typingIntervalMs` | `8`; native Windows driver only, integer 0–1000 ms per character/UTF-16 unit |
| `maxWheelTicks` | `20`; maximum absolute wheel ticks; positive up, negative down |
| `connectionsFile` | `operationsDir/connections.json`; optional bookmark JSON |
| `recordMaxOutputChars` / `recordMaxDocumentBytes` | `12000` / `32768`; maximum stored output excerpt and Markdown record bytes |
| `defaultTerminalProfile` | `linux`; profile used by direct binding |
| `allowCritical` | `false`; separate critical-action opt-in and two-stage approval |
| `allowCredentialInjection` | `false`; separate protected-prompt credential opt-in |

### Configure RAG in Plugins

Open DSH **Plugins** → `dsh-sre-webshell` → `sre-webshell` → **Configure**. The page edits `ragUrl`, `ragTimeoutMs`, and `ragTokenEnv` (RAG API URL, search timeout, and token reference). Saved values apply to the next `runbook_search` without editing `cordis.patch.yml` or restarting. An empty `ragUrl` keeps local Markdown search only. Save the token in the separate password field; DSH stores it in its credential store, not the settings document. Copy the knowledge service's `RAG_API_TOKEN` value from `knowledge-service/.env` here once. The default reference is `DSH_RAG_API_TOKEN`; the token is never read back into the page.

Earlier `Start-SRE.ps1`/`Start-SRE.sh` versions automatically injected `DSH_RAG_API_TOKEN` from the knowledge service `.env`; they no longer do so, allowing the page to update the credential. An explicitly set process environment variable still takes precedence over DSH's store, makes the token control read-only, and requires a DSH restart after removal before the page can manage it. Missing credentials or an unavailable knowledge service leave local Markdown search available with a RAG warning. The knowledge service's database, SiliconFlow models, and synchronization settings remain in `knowledge-service/.env`; this page neither starts nor configures that separate service. See the [knowledge-service guide](knowledge-service/README.md).

Select `sre-full-access` explicitly in DSH's session menu if a saved preference chooses another preset. Full filesystem access and approval are separate: `approval: never` rejects explicit approval requests rather than granting them. Binding still needs confirmation; automatic screenshots do not grant command/credential approval. Helper timeout defaults to 25 seconds and binding freshness to 120 seconds.

After code changes, rebuild, stop DSH with Ctrl+C and relaunch. Restart after changing profile YAML; the RAG settings page applies to the next search without a restart. Managed mode closes its owned browser when DSH stops but retains the profile for the next login session; do not open the same profile in another browser process. A fresh test conversation avoids old instructions; refreshing the page alone does not reload the plugin.

-----

<a id="usage"></a>
## Daily use and recovery

In managed mode, call `webshell_open` or `terminal_observe` to launch the configured URL, sign in manually in the owned browser, then observe and bind. Later browser input, text reading and page screenshots work even when another window or tab is foreground. Native mode instead uses an existing Chrome/Edge tab; only that mode supports the legacy `webshell_login` tool through loopback CDP. Then ask “Run `pwd` in the configured WebShell”, “List files with `ls`”, or “Show Kubernetes nodes with `kubectl get nodes -o wide`”. Kubernetes requires working remote `kubectl` and authorization; the plugin does not supply them.

The binding confirmation shows the target URL and browser title; confirm that the terminal has an idle prompt and empty editable line. No asset registration is required. `terminal_run` enters one command, sends one Enter, waits 10 seconds by default and returns output in the same tool call. For long waits or several commands before reading, use `terminal_write` repeatedly and then `terminal_read`. An uncertain input or Enter result blocks further writes until manual inspection and rebind; the plugin never clears or replays partial input automatically. Normal command input/output uses no selection, right-click copy or clipboard.

Commands include unique `DSH_BEGIN_…` / `DSH_END_… rc=…` markers to distinguish execution output from echoed input. `rc=0` means that wrapped command returned success, not that an entire deployment is healthy. Managed mode probes WebSocket receive frames, xterm buffers and terminal DOM in the owned page; a complete unique marker record avoids a screenshot. Incomplete probes fall back to a browser-page screenshot without activating the OS window. Native mode may require the target tab foreground for input or screenshot fallback. Commands are never resubmitted during read fallback. Markers do not guarantee byte-perfect visual transcription.

Re-observe/rebind after expiry, resize, zoom/font changes, asset edits or target/focus changes. For partial input, pagers, protected prompts or uncertain outcomes, inspect and resolve the terminal manually before confirming `terminal_bind` recovery. Do not blindly rerun submitted commands. `terminal_read` observes output without resubmission; screenshot-only output does not prove exit status.

| Symptom | What to check |
|---|---|
| Desktop control disabled | Operator patch `enabled: true`, restarted process and correct profile |
| Target not found/mismatched | Managed browser login/redirect and exact URL; for native mode check tab, accessibility and foreground permissions |
| Approval rejected/unavailable | Preset permits asking and DSH's approval interface is available |
| Input uncertain/partial | Actual editable line, visibility, IME candidates and focus; resolve before recovery |
| Input helper failed | Check the fixed focus, keyboard-layout or IME error code; inspect the terminal before any recovery or retry |
| Browser text unavailable | Managed mode: inspect the owned browser page and supported xterm/DOM output; native mode: verify its optional DevTools endpoint or use screenshot fallback |
| Target focus unavailable | Native mode only: check whether the exact Chrome/Edge tab can be selected |
| Generic `failed closed` | Last local audit stage; the message alone does not establish an approval/inventory problem |
| Unknown asset after direct binding | Generated binding metadata is not registered inventory; direct binding needs no asset lookup |

-----

<a id="records"></a>
## Connections and privacy

Optional local `operations/connections.json` stores WebShell URLs, custom names and network notes; SSH records store host/port, names and notes. The interactive connection manager creates and edits Windows DPAPI CurrentUser-protected account/password pairs and explicitly migrates legacy plaintext. Model-visible lists contain neither accounts nor ciphertext. Existing plaintext must be migrated before `webshell_login` can use it; the plugin never migrates the real file automatically. SSH execution and a settings UI remain unavailable. Commands and JSON examples are in the bilingual [connection-file reference](operations/README.md).

Legacy inventory is optional for service/credential metadata. Terminal profiles in `operations/inventory/terminal-profiles.yaml` specify POSIX, `input: unicode_then_keyboard`, `output: visual` and pager patterns. Runbooks/sample skills are untrusted guidance, not authorization.

Never commit real bookmarks, API keys, `.env`, screenshots, logs, browser profiles or DSH history. The managed profile stores browser cookies/session data locally and is not encrypted by this plugin; restrict filesystem access and keep it out of backups and Git. DPAPI bookmark protection and the credential-manager workflow remain Windows-only. Screenshots can contain sensitive output, are stored as DSH attachments and sent to the selected model. Direct terminal text is returned in ordinary DSH tool results and therefore remains in DSH history too. The metadata-only audit stores source identifiers and output hashes, never WebSocket URLs, bearer tokens or output bodies. Submitted operations create Markdown under `operations/records/`; generated records are excluded from Git and packaging, but include redacted command/output excerpts and must be reviewed before RAG synchronization because pattern-based redaction cannot detect every secret. Raw temporary captures are removed after attachment admission. Set storage ACLs and retention yourself.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals</summary>

The installable bundle adds one Cordis plugin through [cordis.patch.yml](cordis.patch.yml), using DSH's configuration, tool registry, dependency injection, approval and attachment APIs without changing the agent loop. When enabled, its allowlist prevents generic execution/filesystem mutation and alternate transports from bypassing policy.

The parser supports limited POSIX commands and one pipeline, quoting each word literally. Unknown commands, substitutions, arbitrary interpreter wrappers and SQL clients are denied. Wildcards are literal, not expansions. This is not an unrestricted command executor; inspect [policy.ts](src/policy.ts) for supported operations.

Managed input uses a discoverable xterm instance's `input()` or page-scoped keyboard events for a unique xterm helper textarea; it does not write directly to the remote WebSocket. The managed driver reads CDP WebSocket frames and xterm/DOM snapshots from its owned page and validates the exact URL before every action. Native mode retains Windows `SendInput` and optional loopback DevTools output. Completion requires one unambiguous marker record; interactive reads remain unverified text or screenshots. Transactions share a process-local lock. See [managed browser](src/managed-browser.ts), [browser output](src/browser-output.ts), [operator](src/operator.ts), [Windows driver](src/windows.ts), [audit writer](src/audit.ts) and [third-party notices](THIRD_PARTY_NOTICES.md).

Critical actions require operator opt-in, independent intent/final approvals and remote user/cwd probes before and after final approval. Credential injection requires an asset-assigned reference and operator verification of a hidden prompt; its legacy path uses the clipboard, not Enter. Protected prompts block screenshots until confirmed recovery. Leave both opt-ins disabled until separately accepted.

</details>

-----

<a id="model-experience"></a>
## Model Experience

In managed mode the agent calls `webshell_open` or `terminal_observe`; a login redirect asks the operator to sign in in the owned browser before binding. Native mode alone offers `webshell_login` for a protected bookmark on an exact HTML5 form. The agent uses `terminal_run` for ordinary commands, or `terminal_write` followed by `terminal_read` for interactive timing. `terminal_scroll` reads earlier pages. Browser text is preferred; screenshots are returned when no complete marked output is available. Optional lookup, runbook, service, credential and critical tools remain policy-controlled. DSH logs images and tool results; terminal text, screen text and runbooks remain untrusted data.

-----

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

The operator reported successful native WebShell execution of `ls` with an end marker and `rc=0` on 2026-09-19. Managed mode has been tested against local synthetic Chromium pages, including input while another tab is foreground, one Enter, xterm/DOM reading and screenshot cleanup; it has not yet been exercised against the live Apollo WebShell or a Linux host. Other keyless tests cover policy, no replay, approvals, audit persistence and built DSH composition, not certification of every terminal/browser/model. Evidence and earlier checks are in [ACCEPTANCE.md](ACCEPTANCE.md).

Raw-text WebSockets such as the tested Apollo WebShell are the strongest path. [Alibaba Cloud Workbench CLI](https://www.alibabacloud.com/help/tc/ecs/user-guide/connect-to-an-instance-through-workbench-cli/) documents a WebSocket backend and is a compatibility target for the generic CDP collector; [Tencent Cloud OrcaTerm](https://cloud.tencent.com/document/product/1665) is also a browser-terminal target, but its private frame protocol is not publicly certified here. JSON or binary vendor envelopes are accepted only when their text is recognizable. HTML5 VNC/RDP is visual/binary rather than a terminal text stream and therefore uses screenshots. Cloud Shell, service/Pod terminals, iframe/split panes and each vendor login flow still require real-target acceptance. Flash/Java, GUI automation, SSH/WinRM execution, redirected/vendor-specific automatic login, unrestricted Kubernetes operations and a settings editor are not implemented.

Visual transcription may misread small text, soft wraps or hidden characters. Pagers need manual completion; wheel navigation does not restore position automatically. Managed mode requires a browser-exposed xterm input or unique helper textarea; unsupported canvas/proprietary terminals fail closed for input. Exact URL checks do not authenticate servers. Native mode still needs target-specific mixed-DPI, IME and focus testing. This MVP is not production-certified; do not deploy unattended.

### Dev Note

<details>
<summary>Working context</summary>

This repository provides plugin sources and reviewed helper scripts, not DSH, a model/API key or a complete runtime. Loading paths and workspace-dependent helpers remain installation-specific. Keep critical actions and credentials disabled until real-target acceptance.

</details>
