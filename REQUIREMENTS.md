---
description: "Requirements and acceptance scope for DSH Ops WebShell/SSH connections, login credentials, operation records and the RAG knowledge loop."
kind: "reference"
---

# DSH Ops requirements: connections, login and knowledge

English | [中文](REQUIREMENTS.zh.md)

## Summary

The Desktop acceptance requirements and component migration checklist are in [DESKTOP.md](DESKTOP.md). Ordinary background operations must not request separate binding confirmation; native permissions and mandatory sensitive-operation confirmation remain independent. Existing encrypted connections and the independent knowledge service must not be copied into application artifacts.

Users can select a WebShell or SSH target from local connection records, request controlled operations in natural language, and retrieve applicable manuals and labeled past operations later. WebShell login credentials should be encrypted locally and decrypted only when a login step needs them. Operation records start as Markdown and are incrementally indexed by an independent knowledge service; retrieval does not change command approval.

## Current status

| Capability | Status and evidence |
|---|---|
| WebShell bookmarks | Present: `operations/connections.json` stores URL, name, notes and optional account; `connection_list` returns metadata. |
| WebShell operations | Present: targeting, terminal input/verification, text capture and screenshot fallback for an already logged-in Chrome/Edge tab. |
| WebShell login | Initial `webshell_login` path checks an already open, exact Chromium tab through loopback CDP and can submit one unambiguous same-origin HTML5 form. It does not navigate, handle SSO/MFA/CAPTCHA, or support vendor-specific flows. |
| Credential protection | Windows DPAPI CurrentUser `protectedAuth`, on-demand login decryption and an explicit plaintext migration/connection manager are implemented. Existing plaintext files require migration before automatic login; the real local file is not migrated automatically. |
| SSH | Connection bookmarks only; SSH execution and login are not available. |
| Local knowledge | Markdown under `runbooks/` and `records/` is searchable locally with source, hash and outcome labels. Submitted terminal operations create provisional records and update them after verified collection. |
| Independent RAG | PostgreSQL/pgvector, BM25+, vector recall, RRF, model rerank and incremental sync are implemented; record outcomes now flow through the index. Deployment configuration and a separately running sync process remain required. |
| Audit | Metadata hash chain exists; it is not an operation record suitable for RAG retrieval. |

## Connections and credentials

- Each WebShell record should have a stable ID, system URL, editable name, network notes, optional terminal profile, and optional login account/password; SSH records should have a stable ID, IP/host, port, account, name and notes.
- The same address may have multiple records for different accounts. A bookmark helps select a target; it grants neither asset identity nor operation authority. Binding still verifies the current page identity.
- The WebShell account and password should be stored together as protected data. The intended Windows mechanism is DPAPI CurrentUser: only versioned ciphertext and nonsensitive metadata stay on disk. Processes running as the same Windows user can still decrypt it, so OS account access and backups matter.
- Connection lists, model context, audit, logs and RAG documents must not include decrypted accounts/passwords. Decrypt only for the current login step and send only to the verified page; a failure must not switch addresses or accounts automatically.
- Plaintext migration needs a recoverable path: validate the complete file, encrypt and verify, then atomically replace it. A failure leaves the original usable. Migration documentation must explain that prior copies, backups and file history may retain plaintext and must not destroy user backups on its own.
- SSH credentials should follow the same protection policy, while SSH execution/login remains a separate milestone. Existing external credential references remain valid; local ciphertext is not a DSH credential reference.

## WebShell login and operations

- After connection selection, the plugin operates only on a browser tab matching the intended URL/origin. It uses the terminal directly when already logged in; otherwise it identifies account/password fields and decrypts on demand. CAPTCHA, MFA, SSO and site-specific flows require user action and must not be reported as success without observation.
- Automatic form filling should first support clearly identified HTML5 forms and site adapters. Ambiguous fields/pages, origin changes, unapproved redirects or possible password echo stop the flow with a reason. Credentials must not be sent to search, RAG, models or arbitrary page scripts.
- Login success requires observed page state and a ready target WebShell terminal; submitting a form or receiving HTTP success alone is insufficient. Login retries must be bounded to avoid account lockout and duplicate submission after an uncertain result.
- Terminal work retains command risk classification, one-shot input and Enter, marked output for normal runs, standalone write/read for long waits, read-only probes and approvals for critical actions. An uncertain input or Enter result requires manual recovery before further writes. Screenshot consent is separate from login/command consent; no capture may expose a password field or protected prompt.
- A future SSH path can share connection selection, approval, audit and record format, but execution, host identity checks and transport need separate design and acceptance. Browser terminal control cannot stand in for SSH execution.

## Manuals, records and retrieval

- Human maintained Markdown is the manual source of truth. Each operation creates one independent Markdown record with at least target ID, time, intent, submitted commands and risk, observed result/exit status, failure or uncertainty, and cited manual version; secrets and sensitive output are removed before writing.
- Mark success only when execution results are observed. A tool call, timeout, disconnected page or unreadable screenshot is uncertain. Failed records remain searchable but never become approved manuals automatically.
- Recent records and manuals are searchable directly from local Markdown; older records come from an independent RAG API. The plugin deduplicates results and preserves source path, section, status and degradation warnings so the model can check applicability.
- The knowledge service tracks document ID, content hash, pipeline fingerprint, last successful sync and failures in a file manifest. Changed files reindex and failed ones remain pending. Remote deletion is explicit and controlled; one missed scan must not clear history.
- RAG uses this project's separate PostgreSQL/pgvector and embedding/rerank model APIs. The initial retrieval combines BM25+ and vector recall. Add graph relationships only if concrete cross-entity queries and evaluation show a benefit.
- Retrieval is untrusted reference data. Manuals, historical commands, similarity and rerank scores cannot replace target verification, risk classification or approval. Review raw Markdown before indexing; rule-based redaction cannot detect every secret.

## Acceptance criteria

1. Connection management can add, edit and list WebShell records; disk and model-visible output contain no readable login account/password; the intended Windows user can decrypt for the selected target, while a different user, tampered ciphertext or a different target fails.
2. A successful plaintext migration leaves usable records without plaintext passwords. Any failure leaves the original file intact; residual copies and backup risks are documented.
3. Already logged-in, logged-out, MFA, expired session, origin change and failed login each yield the correct state; terminal operations require verified target and login success.
4. Completed operations create independent readable Markdown records; failure or uncertainty cannot be marked successful; secrets do not reach records, model results or the knowledge index.
5. Local and hybrid retrieval, model outage, interrupted sync, changed documents and explicit deletion have repeatable tests; local manuals work during a RAG outage.
6. SSH execution/login need separate acceptance; a bookmark does not imply those paths are available.

## Design and usage

See the [implementation design](DESIGN.md) for data flows and capability ownership. Current setup is documented in the [plugin guide](README.md), [connection reference](operations/README.md) and [knowledge service guide](knowledge-service/README.md).
