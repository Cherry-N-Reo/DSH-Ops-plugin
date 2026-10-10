---
description: "Original Desktop Client browser bridge, configuration and acceptance scope."
kind: "reference"
---

# DSH Ops on Desktop

English | [中文](DESKTOP.zh.md)

## Summary

The Desktop plugin targets official `0.2.0-rc.2` without rebuilding the application. Set `browserMode: desktop` and `desktopTransport: client` to connect Host tools to the Client through authenticated Connection RPC. The Client operates retained Browser webviews. The recompiled DSH2 application is abandoned and is not a supported installation or transport.

## Migration checklist

| Component | Desktop implementation | Acceptance |
|---|---|---|
| WebShell transport | Existing Browser tab selected by normalized URL; terminal API or page-local xterm text event and Enter; no OS focus changes. | Original Desktop loads the plugin and reports a live Client; isolated Electron 44 / xterm 6 input-read smoke passes. Real WebShell execution remains unverified. |
| Output | Page-local listeners for reachable Vue WebSockets; xterm/DOM reads in accessible frames; screenshot fallback reveals the target tab temporarily. | Client mode cannot inspect cross-origin frames or arbitrary inaccessible WebSockets; real cloud consoles need separate acceptance. |
| Binding | Ordinary run/write/read/scroll automatically bind the unique configured tab and return its title and URL. | Navigation expires the handle; duplicate targets and concurrent Session claims are refused. |
| Permissions | Native DSH permissions remain; plugin sensitive-operation questions require an explicit Allow once answer independently of access preset. | No global tool allowlist in Desktop mode; cancellation and unavailable answerer block sensitive execution. |
| Connection records | Operator-owned JSON outside the application installation; existing Windows DPAPI credentials remain bound to the Windows user. | No automatic copying of credentials, sessions or plaintext migration. |
| Login | The Client bridge reuses the narrow HTML5 form adapter, decrypting protected credentials only after form validation and explicit confirmation. | Unknown forms, redirects and MFA/SSO/captcha require manual handling; no automatic submit retry. |
| RAG settings | Config-derived volatile RAG fields and revisioned Plugins-page form, using a credential reference rather than a plaintext token. | Host/Client builds and built-page render smoke pass; live save and reload still require integration acceptance. |
| Knowledge loop | Independent pgvector/BM25/rerank API and Markdown operation records remain separate from Desktop. | RAG installation, synchronization scheduling and retrieval quality require service acceptance. |
| SSH | Connection metadata retained. | SSH command transport is not implemented. |

## Browser ownership

Open and sign in to the intended WebShell inside Desktop's Browser before running commands. The plugin does not attach to external browser windows. URL comparison sorts ordinary and hash-route query parameters while preserving origin, path and values. A matching target must be unique and can be claimed by one live plugin Session. Closing the tab, navigating away or replacing the Client expires bindings. Releasing automation does not close user tabs. Text operations do not change Sidebar selection. Screenshot fallback selects the target tab, then restores the previous tab and input focus without switching OS windows.

`terminal_run` sends one command and one Enter, waits `directReadDelayMs` (default ten seconds), then reads output. `terminal_write` sends once without waiting; repeated calls support interactive sequences. `terminal_read` reads without input or Enter. Claimed RPC jobs and uncertain input are never automatically redelivered. WebSocket URLs, headers and tokens are not collected; terminal output may contain sensitive data and enters the owning tool result.

The audit records `submitted` after the input adapter acknowledges Enter; this does not establish remote completion. A complete marker and exit code establish the collected result. Audit or collection failures never authorize automatic resubmission. A new plugin installation does not retroactively complete an earlier failed tool call or create its missing operation record.

The Browser retains tabs while hidden. Its storage partition is process-local, not persistent across app exit; do not expect permanent login cookies. Guest Node integration and preloads remain disabled, and no remote debugging listener is opened.

Generic xterm input uses a page-local `ClipboardEvent` containing Unicode text, followed by one page-local Enter event. It neither reads nor modifies the system clipboard. Hidden guests can ignore Chromium `Input.insertText`, so that API is not the Desktop driver's generic terminal input path. Unknown terminal event handlers and HTML5 VNC/RDP still need separate adapters; no unattended OS keyboard fallback is enabled in Desktop mode.

## Configuration and build

The legacy CLI package remains under the plugin root. The Desktop variant's manifest, patch, Client page and isolated build script live in `desktop/`. Its bundle inserts only `sre-webshell`; it does not change the default skill roots or install an exclusive tool policy. The bundle starts disabled with no target URL.

Set `enabled`, `targetUrl`, `operationsDir` and `runtimeDir` in the Desktop profile patch. Use existing operation and connection paths explicitly when reusing local data; do not move encrypted credentials to another Windows account. Configure `ragUrl`, `ragTokenEnv` and `ragTimeoutMs` on the plugin's RAG page. Store the RAG API token in native DSH credentials under the selected reference. The knowledge service's embedding/rerank model API key remains in its private `.env`, not in the plugin package.

The isolated plugin build is `desktop/Build.ps1`; it stages source, package metadata and documentation, never connections, runtime data or `.env`. Only the plugin is built for original Desktop. Fully quit Desktop before using its bundled `dsh plugin --profile desktop add <package.tgz>` command, then reopen it. The installed executable and `app.asar` remain unchanged. The default bundle is disabled; enable it and configure the exact target URL in the profile patch.

## Original application acceptance

The official `0.2.0-rc.2` installation loads plugin `0.2.0-rc.2.20261010.13` with authenticated exact Fetch routes under `/api/ops-browser/`. The bridge status returns `live: true`. Executable and `app.asar` SHA-256 values match their pre-install baselines. This verifies plugin activation and Client polling, not a successful post-fix command on the operator's remote WebShell, live RAG saves or sensitive-action UI.

Open the WebShell in the original application's Browser, sign in manually, and ask for one read-only `ls` through `terminal_run`. No separate observation/binding sequence is needed. Existing connections and operation documents remain in their configured workspace paths. Keep destructive actions and credential injection disabled until separately accepted. The adapter depends on released Sidebar webview markers; application upgrades require compatibility checks.

## Acceptance scope

The submission regression uses the real hash-chained audit writer with the operator's text path: one Enter, an accepted `submitted` record, a complete WebSocket marker and exit code zero. Twenty-three focused tests pass, and the plugin Host/Client build passes. Installation and a live Client heartbeat are verified in the original application; remote command execution after this fix remains a manual acceptance task. Historical packaging evidence in the acceptance log is not an installation guide.

Unit evidence is recorded in [ACCEPTANCE.md](ACCEPTANCE.md). Required release checks include Desktop Host compilation, plugin Client compilation, packaged Browser input/read/screenshot smoke, native-permission behavior, mandatory sensitive-action confirmation, navigation invalidation and listener cleanup. Tests use isolated pages; passing them does not certify Alibaba Cloud, Tencent Cloud or a production WebShell.
