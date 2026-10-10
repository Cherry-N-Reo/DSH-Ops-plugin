"""SiliconFlow embedding and rerank adapter with bounded requests and validated responses."""

import math

import httpx

from .config import Settings


class ModelFailure(Exception):
    """Provider failure whose public message does not contain upstream response bodies."""


class Models:
    """Own one HTTP client; close it on application shutdown."""

    def __init__(self, settings: Settings, transport=None):
        self.settings = settings
        self.client = httpx.Client(
            base_url=settings.model_base_url.rstrip("/") + "/",
            headers={"Authorization": "Bearer " + settings.siliconflow_api_key.get_secret_value()},
            timeout=settings.model_timeout_seconds,
            transport=transport,
            follow_redirects=False,
        )

    def close(self):
        """Release owned HTTP connections."""
        self.client.close()

    def post(self, endpoint: str, body: dict) -> dict:
        """Translate provider errors without leaking credentials or document bodies."""
        try:
            response = self.client.post(endpoint, json=body)
            response.raise_for_status()
            data = response.json()
            if not isinstance(data, dict):
                raise TypeError("object expected")
            return data
        except (httpx.HTTPError, ValueError, TypeError) as error:
            raise ModelFailure(
                "Model API request failed; check endpoint, model and credentials"
            ) from error

    def embed(self, texts: list[str]) -> list[list[float]]:
        """Return finite, nonzero vectors in input order; reject dimension mismatches."""
        result = []
        size = self.settings.embedding_batch_size
        for start in range(0, len(texts), size):
            batch = texts[start : start + size]
            data = self.post(
                "embeddings",
                {
                    "model": self.settings.embedding_model,
                    "input": batch,
                    "encoding_format": "float",
                },
            )
            try:
                rows = sorted(data["data"], key=lambda row: row["index"])
                if [row["index"] for row in rows] != list(range(len(batch))):
                    raise ValueError("invalid embedding indexes")
                for row in rows:
                    vector = row["embedding"]
                    if (
                        len(vector) != self.settings.embedding_dimension
                        or not all(type(v) in (int, float) and math.isfinite(v) for v in vector)
                        or not any(vector)
                    ):
                        raise ValueError("invalid vector")
                    result.append(vector)
            except (KeyError, TypeError, ValueError) as error:
                raise ModelFailure(
                    "Model API returned invalid embedding dimensions or values"
                ) from error
        return result

    def rerank(self, query: str, documents: list[str], limit: int) -> list[dict]:
        """Return unique, in-range result indexes with finite relevance scores."""
        data = self.post(
            "rerank",
            {
                "model": self.settings.rerank_model,
                "query": query,
                "documents": documents,
                "top_n": min(limit, len(documents)),
                "return_documents": False,
            },
        )
        try:
            rows = data["results"]
            if not isinstance(rows, list) or len(rows) != min(limit, len(documents)):
                raise ValueError("invalid rerank count")
            indexes = set()
            for row in rows:
                index, score = row["index"], row["relevance_score"]
                if (
                    type(index) is not int
                    or not 0 <= index < len(documents)
                    or index in indexes
                    or type(score) not in (int, float)
                    or not math.isfinite(score)
                ):
                    raise ValueError("invalid rerank result")
                indexes.add(index)
            return sorted(rows, key=lambda row: -row["relevance_score"])
        except (KeyError, TypeError, ValueError) as error:
            raise ModelFailure("Model API returned invalid rerank results") from error
