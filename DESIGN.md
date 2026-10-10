---
description: "Implementation design and current status for DSH Ops connections, login, terminal operations, Markdown records and the independent RAG service."
kind: "reference"
---

# DSH Ops design: from connection to retrieval

English | [中文](DESIGN.zh.md)

## Summary

Desktop-specific transport, ownership, permission and configuration design is maintained in [DESKTOP.md](DESKTOP.md). The main process owns guest handles; the plugin sends correlated private IPC requests. Foreground-window checks and a global tool allowlist do not apply to Desktop mode.

The DSH plugin selects connections, verifies browser targets, operates terminals under command policy and reads results. Local Markdown keeps reviewable manuals and individual operation records; an independent knowledge API handles long-term indexing, hybrid retrieval and reranking. Initial protected credentials, narrow HTML5 login, and evidence-based operation records are implemented; SSH execution and vendor-specific login remain separate work. Requirements and acceptance criteria are in the [requirements](REQUIREMENTS.md).

## Components and status

| Component | Current implementation | Next step |
|---|---|---|
| Connection directory | `src/connections.ts` lists metadata without accounts or ciphertext; `credential-vault.ts` and `scripts/credential-manager.ts` provide DPAPI protection, migration and editing. | Validate user-specific migration and backup handling in deployment. |
| Browser terminal | `src/index.ts`, `src/input.ts` and `src/browser-output.ts` handle verified input and text/screenshot output; `web-login.ts` supports one same-origin HTML5 login attempt. | Vendor adapters and redirected/SSO login handling. |
| Command policy and audit | Risk levels, approval and a metadata hash chain feed the operation record writer after Enter and output verification. | Evaluate real-world redaction and recovery cases. |
| Local documents | Markdown search under `operations/runbooks/` and `operations/records/` returns status, source and hash; submitted operations get one provisional record updated at completion. | Improve record attribution and indexing cadence. |
| Knowledge service | Independent PostgreSQL/pgvector API, sync and hybrid retrieval under `knowledge-service/ops_knowledge/`. | Deployment integration, quality evaluation and scale tuning. |
| SSH | Connection metadata only in `connections.json`. | Separate transport and host identity verification. |

## Target data flow

1. The user selects a WebShell connection ID; the plugin reads public metadata and checks the URL, active tab and network notes. An explicit URL can still operate an already logged-in page without a bookmark.
2. If the target terminal is ready, the existing command path continues. If login expired, the login controller checks page origin and form fields before decrypting that connection's account/password; the user completes MFA or other human steps.
3. Only after observing terminal readiness does the plugin bind it. `terminal_run` applies risk policy and approval, types once, sends one Enter, waits the configured interval, then reads marked output or a screenshot. `terminal_write` sends one approved command without waiting; `terminal_read` observes existing output, so several writes may precede a read. Uncertain input or Enter blocks further writing until manual inspection and rebind; submitted commands are never retried automatically.
4. A record writer creates `operations/records/<unique-id>.md` from actual execution evidence, masks secrets and writes atomically. Failure and uncertainty produce records without being relabeled successful.
5. The synchronizer sends changed source hashes to the independent knowledge API. It chunks text, calls SiliconFlow embeddings and atomically replaces the PostgreSQL document; failure retains the old index and pending source.
6. Later work queries local Markdown and RAG. RAG combines BM25+, pgvector cosine recall and SiliconFlow rerank, returning sources and outcome labels. The plugin treats results as reference data under the existing approval rules.

Steps 1–4 have an initial implementation, subject to the exact-tab and HTML5-form constraints above. Steps 5–6 require separately deploying the knowledge service and running its synchronizer; the plugin does not launch synchronization automatically. SSH execution is still unavailable.

## Connection records and local encryption

`connections.json` continues to carry IDs, types, URL/host, names, notes and profiles. Versioned `protectedAuth` contains Windows DPAPI CurrentUser ciphertext and a password-present flag. The account and password are encrypted together instead of retained as top-level plaintext fields. SSH credentials follow the same principle, but SSH execution remains separate.

Bind encryption to the connection ID, type and complete canonical target URL, including path, query and fragment identifying a server. Editing the name or notes does not affect decryption. Changing the target requires decrypting, re-encrypting and user confirmation. Ciphertext copied to another connection, a changed target, a different Windows account or corrupted bytes must fail. Migration and editing validate all records before writing to avoid partial updates.

`connection_list` exposes only ID, name, target, notes and whether authentication exists, never WebShell account, ciphertext, password or raw decrypt exceptions. Only the login controller obtains plaintext after it has verified the selected target and the login requirement. Plaintext lives only for that step and must not enter tool arguments/results, context, audit, RAG, screenshots or generic diagnostics. DPAPI cannot protect against a compromised process under the same Windows user; migration to another Windows identity requires credential re-entry or an external credential manager.

Migration reads existing optional plaintext `username`/`password`, builds and verifies a complete encrypted file, then atomically replaces it. The original remains unchanged until success. Existing backups or Git/DSH history may still contain plaintext; the migration does not remove those copies automatically. The running plugin rereads the file after migration. File and decrypt errors close the login path instead of silently reverting to plaintext.

## WebShell login controller

The login adapter receives the expected connection ID, target URL and browser tab identity. It checks for terminal readiness first. On a login page it prefers uniquely identifiable HTML5 fields, with vendor-specific entry and redirect rules in separate adapters. Ambiguous forms require human action rather than attempting password input in the terminal.

Credentials go only to a verified intended origin. Cross-origin SSO needs an explicitly allowed login origin and user handoff. CAPTCHA, MFA, QR codes, hardware keys and risk challenges are observed and delegated to the user. Limit retries by submitting once and observing once; redirects, timeout, lost fields or unknown state require human recovery.

The login flow does not reuse `credential_inject`: that existing tool targets a hidden prompt inside an already bound shell, uses an asset credential reference and is disabled by default. Browser forms and terminal password prompts have different targets, states and approvals. Do not capture a screen showing password fields during entry or route credentials through CDP output listeners, models or RAG.

## Operation records and knowledge service

The record writer creates a document for each completed or interrupted operation from durable tool evidence and metadata; freeform model summaries do not establish success. A record contains connection ID rather than account ciphertext, necessary command summary or masked text, risk, observed output excerpt/exit status, outcome and cited manual path/content hash. Without an end marker or reliable reading it uses `uncertain`, never `success`.

The writer bounds size and paths, masks secrets and writes atomically. Local Markdown is the operation record source; the hash-chain audit still contains metadata only. A record-writing failure cannot make a submitted command appear unsubmitted: report command outcome and record outcome independently. RAG sync failure preserves the MD and does not change the execution outcome.

The synchronizer reads only Markdown under `runbooks/` and `records/`, tracks successful hashes and pipeline fingerprints in `.rag-sync.json`, retains failures for a later run and requires explicit `--prune` for deletions. The knowledge API has storage separate from other projects. `/v1/search` returns path, section, lines, kind, status and ranking markers, plus explicit degradation. Versioned record frontmatter maps `success`, `failure` and `uncertain` to `verified`, `failed` and `unverified`; manuals remain `unverified`.

BM25+ targets commands, error codes and Chinese terminology; vectors cover semantically similar descriptions. The current small-corpus implementation rebuilds BM25+ from filtered chunks, runs exact pgvector cosine search, combines ranks with RRF and reranks bounded candidates. Measure recall, latency and memory before introducing a keyword index or approximate vector index. A graph is reserved for queries that need relationships between assets, services and failures.

## Data minimization and failures

Connection plaintext never enters knowledge sync directories. Secrets are checked before writing records and before requests to embedding/rerank APIs; existing rule-based redaction in the knowledge service is a second layer, not a replacement for reviewing source documents. Model and database credentials live in ignored local project configuration, without borrowing old-project settings.

Local Markdown remains searchable when RAG is down. Embedding failure can degrade to BM25+, rerank failure to RRF order, and both return warnings. Credential decryption, page identity or login state failure stops login even when RAG works. Retry only reads or sync steps known not to have submitted an action; never resubmit a remote command with an uncertain outcome.

## Implementation and acceptance order

1. Add encrypted connection credentials, editing and recoverable migration; test same-user decryption, wrong user/target, damaged ciphertext, migration failure and model-visible fields.
2. Add login state detection and WebShell adapters; test logged-in, password entry, MFA wait, redirects and terminal readiness on fictional sites.
3. Write one Markdown record from observed tool outcomes; test uncertainty, masking, atomic writes and sync recovery.
4. Carry record status through RAG and evaluate retrieval and misuse on known manuals/cases before choosing performance work or graph retrieval.
5. Accept SSH login/execution separately; browser WebShell tests cannot stand in for it.

Current usage and configuration remain in the [plugin guide](README.md), [configuration guide](CONFIGURATION.md), [connection reference](operations/README.md) and [knowledge service guide](knowledge-service/README.md). Planned parts of this design do not imply those features are available today.
