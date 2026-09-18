---
description: "Set up and use screenshot-driven Windows WebShell operations with DeepSeek Harness, connection records and command approvals."
kind: "package-bundle"
---

# DSH Ops Plugin

English | [中文](README.zh.md)

## Summary

Use natural-language requests to operate an already logged-in browser WebShell through DeepSeek Harness (DSH). The agent selects the configured tab, reads screenshots, types commands and verifies their echo before Enter. Normal input and output reading need no clipboard. Command policy, approvals and metadata audit restrict operations. This Windows source release is an Ops assistant, not a standalone application or a complete SRE platform.

## Table of Contents

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

Version `0.1.0` retains internal package name `dsh-sre-webshell`, plugin ID `sre-webshell` and profile `sre`. The public project name does not rename existing configuration.

| Capability | Current behavior |
|---|---|
| Existing WebShell | Exact-URL selection of an existing native Chrome/Edge tab; no automatic login/navigation |
| Input | Up to three Unicode attempts, screenshots after each, then one physical-key fallback after confirmed-empty failures |
| Input protection | Exact full echo before a separate Enter; partial, hidden or uncertain input blocks replay |
| IME/punctuation | Verified US English layout, closes available IME contexts; ASCII fallback handles Shift/Caps Lock |
| Output | Agent reads screenshots; wheel navigation and unique completion/exit-status markers |
| Policy | Limited POSIX diagnostics and approved changes; separate critical-action opt-in |
| Records | Optional WebShell/SSH bookmarks and runbooks; SSH records do not provide SSH execution |
| Audit | Hash-chained metadata; no plaintext command/output bodies in the audit file |

Requirements: Windows 10/11 with an interactive desktop, native Chrome/Edge with accessible address bar/tabs, a POSIX remote shell, and an image-capable DSH agent. Model/API credentials belong in DSH, not connection bookmarks. The Codex in-app browser is not the native Chrome/Edge control target.

This source snapshot targets DSH `0.1.6-alpha.2`. Helpers expect a built DSH source checkout in the parent directory and portable Node `22.23.2` at `.runtime/node-v22.23.2-win-x64/node.exe`. DSH's engine range is `^22.19.0 || >=24.0.0`, but these helpers select that fixed runtime. Peer versions are in [package.json](package.json). This is not an npm-published, install-anywhere package.

-----

<a id="use-this-package"></a>
## Installation and launch

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

-----

<a id="configuration"></a>
## Configuration

Edit `.dsh-home/profiles/sre/cordis.patch.yml`, a top-level YAML array. Replace directories and the exact existing tab URL, including fragment/query, and preserve unrelated rows. This enables desktop control and screenshot grants, not critical actions or credentials:

```yaml
- id: sre-webshell
  config:
    operationsDir: 'D:/Program Files/DSH/sre-webshell/operations'
    runtimeDir: 'D:/Program Files/DSH/sre-webshell/.runtime'
    enabled: true
    targetUrl: 'https://webshell.example.invalid/#/shell'
    autoScreenshot: true
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
| `enabled` | `false`; activates desktop tools and an exclusive tool allowlist |
| `targetUrl` | Empty; exact existing native browser URL; required for automatic screenshots |
| `autoScreenshot` | `false`; window capture, DSH attachment storage and model transmission without per-image approval |
| `inputAttempts` | `3`; integer 1–3 Unicode attempts, then one fallback after confirmed-empty failures |
| `typingIntervalMs` | `8`; integer 0–1000 ms per character/UTF-16 unit |
| `maxWheelTicks` | `20`; maximum absolute wheel ticks; positive up, negative down |
| `connectionsFile` | `operationsDir/connections.json`; optional bookmark JSON |
| `defaultTerminalProfile` | `linux`; profile used by direct binding |
| `allowCritical` | `false`; separate critical-action opt-in and two-stage approval |
| `allowCredentialInjection` | `false`; separate protected-prompt credential opt-in |

Select `sre-full-access` explicitly in DSH's session menu if a saved preference chooses another preset. Full filesystem access and approval are separate: `approval: never` rejects explicit approval requests rather than granting them. Binding still needs confirmation; automatic screenshots do not grant command/credential approval. Helper timeout defaults to 25 seconds and binding freshness to 120 seconds.

After code changes, rebuild, stop DSH with Ctrl+C and relaunch. After configuration changes, stop and relaunch. PowerShell and the authenticated WebShell can remain open. A fresh test conversation avoids old instructions; refreshing the page alone does not reload the plugin.

-----

<a id="usage"></a>
## Daily use and recovery

Open and log into the configured WebShell manually. Ask “Run `pwd` in the configured WebShell”, “List files with `ls`”, or “Show Kubernetes nodes with `kubectl get nodes -o wide`”. Kubernetes requires working remote `kubectl` and authorization; the plugin does not supply them.

The agent observes the tab and asks you to confirm the terminal region. No asset registration is required. It checks an empty idle line, types and reads each screenshot, then verifies exact full echo before one separate Enter. Only confirmed-empty failures advance bounded attempts. Partial or uncertain input never permits automatic clearing/appending/fallback. Physical fallback accepts printable ASCII only. Normal command input/output uses no selection, right-click copy or clipboard.

Commands include unique `DSH_BEGIN_…` / `DSH_END_… rc=…` markers to distinguish execution output from echoed input. `rc=0` means that wrapped command returned success, not that an entire deployment is healthy. The agent uses wheel screenshots for long output and reports matching markers to finish collection. Markers do not guarantee byte-perfect transcription.

Re-observe/rebind after expiry, resize, zoom/font changes, asset edits or target/focus changes. For partial input, pagers, protected prompts or uncertain outcomes, inspect and resolve the terminal manually before confirming `terminal_bind` recovery. Do not blindly rerun submitted commands. `terminal_collect` observes pending input/output without resubmission.

| Symptom | What to check |
|---|---|
| Desktop control disabled | Operator patch `enabled: true`, restarted process and correct profile |
| Target not found/mismatched | Native tab, exact URL, accessibility and foreground permissions |
| Approval rejected/unavailable | Preset permits asking and DSH's approval interface is available |
| Input uncertain/partial | Actual editable line, visibility, IME candidates and focus; resolve before recovery |
| Generic `failed closed` | Last local audit stage; the message alone does not establish an approval/inventory problem |
| Unknown asset after direct binding | Generated binding metadata is not registered inventory; direct binding needs no asset lookup |

-----

<a id="records"></a>
## Connections and privacy

Optional local `operations/connections.json` stores WebShell URLs, custom names, Web-system accounts/passwords and network notes; SSH records store host/port, server accounts/passwords, names and notes. Edit the file manually; no settings editor exists. Local plaintext passwords or credential references are supported, and model-visible lists strip password contents. SSH execution and automatic Web login are not implemented. JSON examples are in the bilingual [connection-file reference](operations/README.md).

Legacy inventory is optional for service/credential metadata. Terminal profiles in `operations/inventory/terminal-profiles.yaml` specify POSIX, `input: unicode_then_keyboard`, `output: visual` and pager patterns. Runbooks/sample skills are untrusted guidance, not authorization.

Never commit real bookmarks, API keys, `.env`, screenshots, logs or DSH history. Plaintext records are not encrypted. Screenshots can contain sensitive output, are stored as DSH attachments and sent to the selected model. The metadata-only audit excludes command/output bodies, but DSH history retains tool arguments/results/images. Raw temporary captures are removed after attachment admission. Set storage ACLs and retention yourself.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals</summary>

The installable bundle adds one Cordis plugin through [cordis.patch.yml](cordis.patch.yml), using DSH's configuration, tool registry, dependency injection, approval and attachment APIs without changing the agent loop. When enabled, its allowlist prevents generic execution/filesystem mutation and alternate transports from bypassing policy.

The parser supports limited POSIX commands and one pipeline, quoting each word literally. Unknown commands, substitutions, arbitrary interpreter wrappers and SQL clients are denied. Wildcards are literal, not expansions. This is not an unrestricted command executor; inspect [policy.ts](src/policy.ts) for supported operations.

Input uses Windows `SendInput(KEYEVENTF_UNICODE)`, not DOM assignment, private terminal JavaScript or direct WebSockets. Physical fallback handles printable ASCII. The driver revalidates URL/window identity; desktop transactions share a process-local lock. Screenshots and single-use IDs drive verification. The audit accepts bounded metadata including zero-to-three attempt counts and Unicode/keyboard modes. See [input flow](src/input.ts), [operator](src/operator.ts), [Windows driver](src/windows.ts), [audit writer](src/audit.ts) and [third-party notices](THIRD_PARTY_NOTICES.md).

Critical actions require operator opt-in, independent intent/final approvals and remote user/cwd probes before and after final approval. Credential injection requires an asset-assigned reference and operator verification of a hidden prompt; its legacy path uses the clipboard, not Enter. Protected prompts block screenshots until confirmed recovery. Leave both opt-ins disabled until separately accepted.

</details>

-----

<a id="model-experience"></a>
## Model Experience

The agent observes/binds, stages commands with `terminal_execute`, verifies actual echo using `terminal_input_check`, reads results with `terminal_collect` and scrolls with `terminal_scroll`. Optional lookup, runbook, service, credential and critical tools remain policy-controlled. The image-capable primary model reads screenshots directly; normal commands need no second vision-provider route or human transcription. DSH logs images and tool results; screen text and runbooks remain untrusted data.

-----

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

The operator reported successful native WebShell execution of `ls` with an end marker and `rc=0` on 2026-09-19. The 73 keyless tests cover policy, bounded input, no replay, approvals, real audit persistence, native-code compilation and built DSH composition, not certification of every terminal/browser/model. Evidence and earlier checks are in [ACCEPTANCE.md](ACCEPTANCE.md).

HTML5 SSH/Cloud Shell, service/Pod terminals, iframe/split panes and HTML5 VNC are compatibility targets, not certified adapters. Alibaba Cloud Workbench/Cloud Shell and Tencent Cloud OrcaTerm/VNC need separate acceptance. Flash/Java, GUI automation, SSH/WinRM execution, automatic login, unrestricted Kubernetes operations and a settings editor are not implemented. No browser debugging port is required.

Visual transcription may misread small text, soft wraps or hidden characters. Pagers need manual completion; wheel navigation does not restore position automatically. Mixed DPI/multiple monitors, delayed echo and IME behavior need target-specific testing. URL/window checks do not authenticate servers or distinguish duplicate same-URL tabs. Process-local locking cannot prevent external focus changes between checks/input. This MVP is not production-certified; do not deploy unattended.

### Dev Note

<details>
<summary>Working context</summary>

This repository provides plugin sources and reviewed helper scripts, not DSH, a model/API key or a complete runtime. Loading paths and workspace-dependent helpers remain installation-specific. Keep critical actions and credentials disabled until real-target acceptance.

</details>
