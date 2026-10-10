"""Validated service settings, loaded only when the application starts."""

import json
from hashlib import sha256

from pydantic import Field, SecretStr, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Deployment settings; changing the pipeline requires document resynchronization."""

    model_config = SettingsConfigDict(
        env_prefix="RAG_", env_file=".env", extra="ignore", hide_input_in_errors=True
    )
    database_url: SecretStr
    api_token: SecretStr = Field(min_length=16)
    siliconflow_api_key: SecretStr = Field(min_length=1)
    model_base_url: str = "https://api.siliconflow.cn/v1"
    embedding_model: str = "BAAI/bge-m3"
    embedding_dimension: int = Field(default=1024, ge=1, le=16000)
    rerank_model: str = "BAAI/bge-reranker-v2-m3"
    chunk_chars: int = Field(default=1600, ge=128, le=16000)
    chunk_overlap: int = Field(default=200, ge=0)
    candidates: int = Field(default=30, ge=1, le=200)
    rerank_candidates: int = Field(default=40, ge=1, le=200)
    model_timeout_seconds: float = Field(default=30, gt=0, le=120)
    embedding_batch_size: int = Field(default=16, ge=1, le=64)
    max_corpus_chunks: int = Field(default=20000, ge=1)
    database_timeout_ms: int = Field(default=15000, ge=1000, le=120000)
    rrf_k: int = Field(default=60, ge=1)

    @model_validator(mode="after")
    def validate_pipeline(self):
        """Reject invalid overlap and insecure remote model transport."""
        if self.chunk_overlap >= self.chunk_chars:
            raise ValueError("chunk_overlap must be smaller than chunk_chars")
        for value in (self.api_token, self.siliconflow_api_key, self.database_url):
            if "replace-with" in value.get_secret_value():
                raise ValueError("Replace example credentials before starting the service")
        from urllib.parse import urlsplit

        url = urlsplit(self.model_base_url)
        if url.scheme != "https" or not url.hostname or url.username or url.query or url.fragment:
            raise ValueError("model_base_url must be HTTPS without credentials, query or fragment")
        return self

    @property
    def pipeline(self) -> str:
        """Fingerprint embedding space, redaction and chunking, excluding secrets."""
        data = [
            "markdown-v1",
            self.model_base_url,
            self.embedding_model,
            self.embedding_dimension,
            self.chunk_chars,
            self.chunk_overlap,
        ]
        return sha256(json.dumps(data).encode()).hexdigest()
