"""Transactional PostgreSQL document replacement and snapshot-consistent hybrid candidates."""

import json
from contextlib import contextmanager

import psycopg
from psycopg.rows import dict_row

from .config import Settings
from .core import Document


class Store:
    """Open short-lived connections; reserve this database for the knowledge service."""

    def __init__(self, settings: Settings):
        self.settings = settings

    @contextmanager
    def connect(self):
        """Close or roll back every connection, including failed requests."""
        with psycopg.connect(
            self.settings.database_url.get_secret_value(),
            row_factory=dict_row,
            connect_timeout=5,
            options=(
                f"-c statement_timeout={self.settings.database_timeout_ms} "
                f"-c lock_timeout={self.settings.database_timeout_ms}"
            ),
        ) as conn:
            yield conn

    def initialize(self):
        """Create version-one tables; reject unknown schema generations."""
        with self.connect() as conn:
            conn.execute("SELECT pg_advisory_xact_lock(83190521)")
            conn.execute("CREATE EXTENSION IF NOT EXISTS vector")
            conn.execute("CREATE TABLE IF NOT EXISTS rag_schema (version integer PRIMARY KEY)")
            conn.execute("INSERT INTO rag_schema VALUES (1) ON CONFLICT DO NOTHING")
            if [row["version"] for row in conn.execute("SELECT version FROM rag_schema")] != [1]:
                raise RuntimeError("Unsupported knowledge schema version")
            conn.execute("""CREATE TABLE IF NOT EXISTS rag_documents (
                id text PRIMARY KEY, path text NOT NULL, title text NOT NULL,
                kind text NOT NULL, status text NOT NULL, content_hash text NOT NULL,
                pipeline text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())""")
            conn.execute("""CREATE TABLE IF NOT EXISTS rag_chunks (
                id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                document_id text NOT NULL REFERENCES rag_documents(id) ON DELETE CASCADE,
                ordinal integer NOT NULL, text text NOT NULL, section text NOT NULL,
                line_start integer NOT NULL, line_end integer NOT NULL, embedding vector NOT NULL,
                UNIQUE(document_id, ordinal))""")

    def manifest(self) -> dict[str, dict]:
        """Return source hashes and pipeline versions, without document bodies."""
        with self.connect() as conn:
            return {
                row["id"]: row
                for row in conn.execute(
                    "SELECT id, content_hash, pipeline FROM rag_documents ORDER BY id"
                )
            }

    def replace(self, doc: Document, digest: str, rows: list[dict], vectors: list[list[float]]):
        """Atomically replace one document after all embeddings have succeeded."""
        with self.connect() as conn:
            conn.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))", (doc.id,))
            conn.execute(
                """INSERT INTO rag_documents
                (id,path,title,kind,status,content_hash,pipeline) VALUES (%s,%s,%s,%s,%s,%s,%s)
                ON CONFLICT(id) DO UPDATE SET path=excluded.path,title=excluded.title,
                kind=excluded.kind,status=excluded.status,content_hash=excluded.content_hash,
                pipeline=excluded.pipeline,updated_at=now()""",
                (doc.id, doc.path, doc.title, doc.kind, doc.status, digest, self.settings.pipeline),
            )
            conn.execute("DELETE FROM rag_chunks WHERE document_id=%s", (doc.id,))
            for index, (row, vector) in enumerate(zip(rows, vectors, strict=True)):
                conn.execute(
                    """INSERT INTO rag_chunks
                    (document_id,ordinal,text,section,line_start,line_end,embedding)
                    VALUES (%s,%s,%s,%s,%s,%s,%s::vector)""",
                    (
                        doc.id,
                        index,
                        row["text"],
                        row["section"],
                        row["line_start"],
                        row["line_end"],
                        json.dumps(vector),
                    ),
                )

    def delete(self, document_id: str):
        """Delete only the identified document and its chunks, idempotently."""
        with self.connect() as conn:
            conn.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))", (document_id,))
            conn.execute("DELETE FROM rag_documents WHERE id=%s", (document_id,))

    def candidates(self, vector: list[float] | None, kind: str | None):
        """Read keyword corpus and vector ranks from the same database snapshot."""
        with self.connect() as conn:
            conn.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
            clauses = "d.pipeline=%s AND (%s::text IS NULL OR d.kind=%s)"
            params = (self.settings.pipeline, kind, kind)
            rows = conn.execute(
                f"""SELECT c.id,c.text,c.section,c.line_start,c.line_end,
                d.id AS document_id,d.path,d.title,d.kind,d.status,d.content_hash,d.updated_at
                FROM rag_chunks c JOIN rag_documents d ON c.document_id=d.id
                WHERE {clauses} ORDER BY c.id LIMIT %s""",
                (*params, self.settings.max_corpus_chunks + 1),
            ).fetchall()
            if len(rows) > self.settings.max_corpus_chunks:
                raise ValueError("Corpus exceeds max_corpus_chunks; increase the configured limit")
            vector_ids = []
            if vector is not None:
                vector_ids = [
                    row["id"]
                    for row in conn.execute(
                        f"""SELECT c.id
                    FROM rag_chunks c JOIN rag_documents d ON c.document_id=d.id
                    WHERE {clauses} ORDER BY c.embedding <=> %s::vector, c.id LIMIT %s""",
                        (*params, json.dumps(vector), self.settings.candidates),
                    )
                ]
            stale = conn.execute(
                "SELECT count(*) AS n FROM rag_documents WHERE pipeline<>%s",
                (self.settings.pipeline,),
            ).fetchone()["n"]
            return rows, vector_ids, stale
