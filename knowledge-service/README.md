---
description: "Configure the independent DSH Ops Markdown knowledge API, hybrid retrieval and incremental synchronization."
---

# DSH Ops Knowledge

English | [中文](README.zh.md)

## Summary

Search Markdown manuals and operation records through an independent authenticated API. Retrieval combines Chinese/technical BM25+, pgvector cosine search, reciprocal-rank fusion and SiliconFlow reranking. The DSH plugin can query this service while retaining local Markdown fallback. No existing project database is required or modified.

## Table of Contents

- [Setup](#setup)
- [Synchronize documents](#sync)
- [Connect DSH](#dsh)
- [API and behavior](#api)
- [Limits and verification](#limits)

<a id="setup"></a>
## Setup

Requirements: Python 3.11+, uv, Docker Desktop in Linux-container mode, and SiliconFlow embedding/rerank access. Run the following from this directory after reviewing and filling the example settings; do not overwrite an existing .env.

```powershell
Copy-Item .env.example .env
# Edit .env before continuing.
./Start-Knowledge.ps1
```

Set POSTGRES_PASSWORD and the matching password in RAG_DATABASE_URL; use URL encoding in the connection URL if needed. Set a new RAG_API_TOKEN, RAG_SILICONFLOW_API_KEY and your actual model IDs/dimension. Example model names are configurable, not an assertion about your account's access. Never commit .env.

The launcher installs locked dependencies, validates configuration, selects docker-compose when available (otherwise docker compose), starts only this Compose project's PostgreSQL, and runs the API in the foreground on 127.0.0.1:8765. PostgreSQL binds 127.0.0.1:55432 and stores data in .data/postgres under this directory. Closing the API does not stop PostgreSQL. Back up this database separately from the Markdown sources.

Use Start-Knowledge.ps1 -Check to validate configuration without starting services. Production startup and real SiliconFlow access require your completed .env; the automated integration tests use a separate disposable database and mocked model HTTP.

<a id="sync"></a>
## Synchronize documents

Place manuals in ../operations/runbooks/ and one Markdown file per operation in ../operations/records/. Both directories must exist. The sync command reads only .md files in these directories, never the connection inventory.

```powershell
uv run python -m ops_knowledge.sync ../operations
# Optional foreground polling every five minutes:
uv run python -m ops_knowledge.sync ../operations --interval 300
```

The command reads RAG_API_TOKEN from the environment or this directory's .env. It stores source hashes, remote hashes, pipeline IDs and successful sync times in ../operations/.rag-sync.json. Unchanged files avoid embedding calls. Failed files remain pending; a failed one-shot run exits nonzero. A service-level connection failure ends the polling process; restart it after recovery.

Renames create new document IDs. Remote deletion is disabled unless --prune is supplied; pruning only affects files previously tracked by this manifest, and any document failure suppresses pruning. Missing source directories abort the run. Do not delete the manifest to resolve an error: it owns deletion scope. A crash may leave its .lock file; remove that lock only after confirming no sync process is running.

Sync marks manuals `unverified`. For versioned operation records, it maps frontmatter `success` to `verified`, `failure` to `failed`, and `uncertain` to `unverified`; malformed record metadata fails that file's sync and blocks pruning. A historical success does not approve a new command. The plugin creates provisional records after Enter and updates them from verified terminal output; it does not promote records into reviewed manuals. Review each Markdown file for sensitive content before sending it to embedding and reranking APIs.

<a id="dsh"></a>
## Connect DSH

In DSH **Plugins** → `dsh-sre-webshell` → `sre-webshell` → **Configure**, set the RAG API URL and timeout, then save this service's `.env` `RAG_API_TOKEN` value in the separate token field. The DSH credential reference defaults to `DSH_RAG_API_TOKEN`; the launch script no longer imports this service's `.env`. Existing YAML configuration remains the initial value, for example:

```yaml
- id: sre-webshell
  config:
    ragUrl: http://127.0.0.1:8765
    ragTokenEnv: DSH_RAG_API_TOKEN
    ragTimeoutMs: 65000
```

Rebuild with ../Build.ps1 and restart DSH after changing plugin source; settings saved on the page apply to the next search. Empty ragUrl preserves local-only search. runbook_search returns local excerpts plus remote excerpts, with local paths taking precedence during deduplication. Local search is bounded case-insensitive substring matching, not hybrid retrieval. API failure returns local results and an explicit warning, never permission to bypass command policy.

Remote HTTP requires HTTPS; plaintext HTTP is allowed only on loopback. Requests never follow redirects. The service requires its bearer token on every endpoint. All retrieval results remain untrusted data and are persisted through the existing tool-result logging path.

<a id="api"></a>
## API and behavior

| Method/path | Behavior |
|---|---|
| GET /health | Database connectivity, document count and pipeline ID; no model health probe |
| GET /v1/documents | Document IDs, content hashes and pipeline IDs |
| POST /v1/documents | Upsert id, path, title, text, kind and status; embeddings finish before atomic replacement |
| DELETE /v1/documents/{id} | Idempotent deletion of one document and its chunks |
| POST /v1/search | query, optional limit (1–20), optional kind (manual/record) |

The service returns excerpts with source paths, sections, line references, document hashes, status and ranking method. Model settings and chunking parameters contribute to a pipeline fingerprint. Changing them excludes incompatible stored documents until resynchronization. Failed embedding updates leave the previous document intact.

Search embedding failure falls back to BM25+; rerank failure falls back to fused rank order. Both return degradation warnings. No graph database or separate keyword search cluster is used. PostgreSQL performs exact vector search; BM25+ is rebuilt from the filtered corpus for each query, capped by RAG_MAX_CORPUS_CHUNKS.

Common password/token assignments, bearer strings, private-key blocks and URL credentials are masked before storage and model requests. This is best-effort masking, not a guarantee for arbitrary secrets. Review source documents before synchronization: their redacted text is sent to SiliconFlow, and original local Markdown is not rewritten or scrubbed.

<a id="limits"></a>
## Limits and verification

This version targets a small single-user corpus, not multi-tenant production. It has no graph retrieval, PDF/Word parser, admin UI, automatic operation summary or reviewed-manual publication workflow. Character-window chunking may split code blocks; retrieved commands require the original manual and normal operation checks. Defaults are 1600 characters per chunk with 200-character overlap, 30 candidates per recall branch and 40 rerank candidates.

```powershell
uv sync --frozen
uv run pytest --run-db -q
uv run ruff check ops_knowledge tests
```

The integration tests create uniquely named disposable pgvector containers and databases, bind OS-assigned loopback ports, and remove their resources on completion. They exercise authentication, actual database reads/writes, update failure retention, deletion, hybrid retrieval, degradation, pipeline changes and sync manifests. SiliconFlow responses are mocked; live model quality and access remain a deployment check.

Protocol references: [SiliconFlow rerank](https://docs.siliconflow.cn/docs/api/rerank-post), [pgvector](https://github.com/pgvector/pgvector), [rank-bm25](https://github.com/dorianbrown/rank_bm25).

### Dev Note

No additional deployment assumptions.
