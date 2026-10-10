"""Markdown chunking, secret masking and Chinese/technical BM25 with rank fusion."""

import json
import re
from hashlib import sha256
from typing import Literal

import jieba
from pydantic import BaseModel, ConfigDict, Field
from rank_bm25 import BM25Plus


class Document(BaseModel):
    """A source document; operation records are unverified unless explicitly classified."""

    model_config = ConfigDict(extra="forbid")
    id: str = Field(min_length=1, max_length=200, pattern=r"^[\w./:@-]+$")
    path: str = Field(min_length=1, max_length=1000)
    title: str = Field(min_length=1, max_length=300)
    text: str = Field(min_length=1, max_length=500000)
    kind: Literal["manual", "record"] = "manual"
    status: Literal["unverified", "verified", "failed"] = "unverified"


class Search(BaseModel):
    """Bounded query and optional document-type filter."""

    model_config = ConfigDict(extra="forbid")
    query: str = Field(min_length=1, max_length=512)
    limit: int = Field(default=8, ge=1, le=20)
    kind: Literal["manual", "record"] | None = None


def redact(text: str) -> str:
    """Mask common credential syntax; this is not a general secret detector."""
    text = re.sub(
        r"-----BEGIN [^-]*PRIVATE KEY-----.*?-----END [^-]*PRIVATE KEY-----",
        lambda match: "[REDACTED PRIVATE KEY]" + "\n" * match.group(0).count("\n"),
        text,
        flags=re.DOTALL,
    )
    text = re.sub(r"(?i)(bearer\s+)[\w.+/=-]+", r"\1[REDACTED]", text)
    text = re.sub(
        r"""(?i)((?:password|passwd|token|secret|api[_-]?key)["']?\s*[=:]\s*)"""
        r"""(?:"[^"\n]*"|'[^'\n]*'|[^\s&;]+)""",
        r"\1[REDACTED]",
        text,
    )
    text = re.sub(r"(?i)(https?://)[^/@\s]+:[^/@\s]+@", r"\1[REDACTED]@", text)
    return re.sub(r"\bsk-[A-Za-z0-9_-]{12,}\b", "[REDACTED]", text)


def fingerprint(doc: Document, pipeline: str) -> str:
    """Hash the original content and metadata without storing the original secrets."""
    return sha256(
        (pipeline + json.dumps(doc.model_dump(), sort_keys=True, ensure_ascii=False)).encode()
    ).hexdigest()


def chunks(text: str, size: int, overlap: int) -> list[dict]:
    """Split by character window, retaining nearest Markdown heading and line references."""
    result = []
    for start in range(0, len(text), size - overlap):
        end = min(start + size, len(text))
        headings = [
            match.group(1)
            for match in re.finditer(r"(?m)^#{1,6}\s+(.+)$", text)
            if match.start() <= start
        ]
        body = text[start:end]
        if body.strip():
            result.append(
                {
                    "text": body,
                    "section": headings[-1] if headings else "",
                    "line_start": text.count("\n", 0, start) + 1,
                    "line_end": text.count("\n", 0, end) + 1,
                }
            )
        if end == len(text):
            break
    return result


def tokens(text: str) -> list[str]:
    """Segment Chinese while retaining command, hostname and error-code tokens."""
    pieces = re.findall(r"[a-z0-9_./:@-]+|[\u3400-\u9fff]+", text.lower())
    return [
        word
        for piece in pieces
        for word in (
            jieba.cut_for_search(piece) if re.search(r"[\u3400-\u9fff]", piece) else [piece]
        )
        if word.strip()
    ]


def keyword_order(rows: list[dict], query: str, limit: int) -> list[int]:
    """Return matching BM25+ ranks; exclude nonmatches even with positive score offsets."""
    corpus = [tokens(row["title"] + " " + row["text"]) for row in rows]
    query_tokens = tokens(query)
    if not corpus or not any(corpus) or not query_tokens:
        return []
    scores = BM25Plus(corpus).get_scores(query_tokens)
    matching = [i for i, words in enumerate(corpus) if set(words).intersection(query_tokens)]
    return sorted(matching, key=lambda i: (-scores[i], rows[i]["id"]))[:limit]


def fuse(rankings: list[list[int]], k: int) -> list[int]:
    """Fuse incomparable retrieval scores by reciprocal rank with stable tie ordering."""
    scores: dict[int, float] = {}
    for ranking in rankings:
        for rank, index in enumerate(dict.fromkeys(ranking), 1):
            scores[index] = scores.get(index, 0) + 1 / (k + rank)
    return sorted(scores, key=lambda index: (-scores[index], index))
