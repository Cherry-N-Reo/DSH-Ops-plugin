"""Authenticated knowledge API; retrieved content is data, never execution authority."""

import secrets
from contextlib import asynccontextmanager

import psycopg
from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from .config import Settings
from .core import Document, Search, chunks, fingerprint, fuse, keyword_order, redact
from .models import ModelFailure, Models
from .store import Store


def create_app(settings: Settings | None = None, *, store=None, models=None) -> FastAPI:
    """Build the service; injectable storage/model transports permit isolated tests."""
    config = settings or Settings()
    database = store or Store(config)
    provider = models or Models(config)

    @asynccontextmanager
    async def lifespan(app):
        try:
            database.initialize()
            yield
        finally:
            provider.close()

    def authorize(authorization: str = Header(default="")):
        if not secrets.compare_digest(
            authorization.encode(), ("Bearer " + config.api_token.get_secret_value()).encode()
        ):
            raise HTTPException(401, "Invalid knowledge API token")

    app = FastAPI(
        title="DSH Ops Knowledge",
        version="0.1.0",
        lifespan=lifespan,
        dependencies=[Depends(authorize)],
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )

    @app.exception_handler(ModelFailure)
    async def model_error(request, error):
        return JSONResponse(status_code=502, content={"detail": str(error)})

    @app.exception_handler(RequestValidationError)
    async def validation_error(request, error):
        # Default validation output repeats the rejected input, which may contain credentials.
        return JSONResponse(status_code=422, content={"detail": "Invalid knowledge request fields"})

    @app.exception_handler(psycopg.Error)
    async def database_error(request, error):
        return JSONResponse(status_code=503, content={"detail": "Knowledge database unavailable"})

    @app.get("/health")
    def health():
        return {"ok": True, "documents": len(database.manifest()), "pipeline": config.pipeline}

    @app.get("/v1/documents")
    def manifest():
        return {"documents": database.manifest(), "pipeline": config.pipeline}

    @app.post("/v1/documents")
    def upsert(document: Document):
        digest = fingerprint(document, config.pipeline)
        previous = database.manifest().get(document.id)
        if previous and previous["content_hash"] == digest:
            return {"id": document.id, "content_hash": digest, "changed": False}
        clean = document.model_copy(
            update={key: redact(getattr(document, key)) for key in ("text", "title", "path")}
        )
        parts = chunks(clean.text, config.chunk_chars, config.chunk_overlap)
        if not parts:
            raise HTTPException(422, "Document contains no searchable text")
        vectors = provider.embed([clean.title + "\n" + part["text"] for part in parts])
        database.replace(clean, digest, parts, vectors)
        return {"id": document.id, "content_hash": digest, "changed": True, "chunks": len(parts)}

    @app.delete("/v1/documents/{document_id:path}")
    def delete(document_id: str):
        database.delete(document_id)
        return {"deleted": document_id}

    @app.post("/v1/search")
    def search(request: Search):
        query = redact(request.query).strip()
        if not query:
            raise HTTPException(422, "Query must contain searchable text")
        warnings = []
        try:
            vector = provider.embed([query])[0]
        except ModelFailure:
            vector = None
            warnings.append("embedding_unavailable: keyword-only retrieval")
        try:
            rows, vector_ids, stale = database.candidates(vector, request.kind)
        except ValueError as error:
            raise HTTPException(503, str(error)) from error
        positions = {row["id"]: index for index, row in enumerate(rows)}
        ranks = fuse(
            [keyword_order(rows, query, config.candidates), [positions[id] for id in vector_ids]],
            config.rrf_k,
        )
        candidates = [rows[index] for index in ranks[: config.rerank_candidates]]
        if stale:
            warnings.append("stale_pipeline_documents_excluded: resync required")
        items = []
        if candidates:
            try:
                ranked = provider.rerank(
                    query, [row["title"] + "\n" + row["text"] for row in candidates], request.limit
                )
                items = [
                    {
                        **candidates[row["index"]],
                        "score": row["relevance_score"],
                        "ranking": "rerank",
                        "untrusted": True,
                    }
                    for row in ranked
                ]
            except ModelFailure:
                warnings.append("rerank_unavailable: reciprocal-rank order")
                items = [
                    {**row, "ranking": "rrf", "untrusted": True}
                    for row in candidates[: request.limit]
                ]
        return {"items": items, "degraded": bool(warnings), "warnings": warnings}

    return app
