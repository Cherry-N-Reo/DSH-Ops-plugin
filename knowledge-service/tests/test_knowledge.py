"""Core algorithms and real API/storage tests with only the model network mocked."""

import json

import httpx
import pytest
from fastapi.testclient import TestClient

from ops_knowledge.api import create_app
from ops_knowledge.core import Document, chunks, fingerprint, fuse, keyword_order, redact
from ops_knowledge.models import ModelFailure, Models
from ops_knowledge.sync import synchronize


def provider(settings, *, fail=None):
    def respond(request):
        body = json.loads(request.content)
        if request.url.path.endswith(fail or "never"):
            return httpx.Response(500, text="private upstream body")
        if request.url.path.endswith("embeddings"):
            return httpx.Response(
                200,
                json={
                    "data": [
                        {"index": i, "embedding": [1, 0, 0]} for i, _ in enumerate(body["input"])
                    ]
                },
            )
        return httpx.Response(
            200,
            json={
                "results": [
                    {"index": i, "relevance_score": 1 / (i + 1)} for i in range(body["top_n"])
                ]
            },
        )

    return Models(settings, httpx.MockTransport(respond))


def client_for(store, *, fail=None):
    return TestClient(
        create_app(store.settings, store=store, models=provider(store.settings, fail=fail)),
        headers={"Authorization": "Bearer test-token-123456"},
    )


def document(text="节点检查：kubectl get nodes", **changes):
    return {
        "id": "manual-nodes",
        "path": "runbooks/nodes.md",
        "title": "节点检查",
        "text": text,
        **changes,
    }


def test_keyword_chinese_and_commands():
    rows = [
        {"id": 1, "title": "集群", "text": "查看节点 kubectl get nodes"},
        {"id": 2, "title": "存储", "text": "磁盘空间 df -h"},
    ]
    assert keyword_order(rows, "节点", 8) == [0]
    assert keyword_order(rows, "kubectl", 8) == [0]
    assert keyword_order(rows, "unrelated", 8) == []
    assert keyword_order([], "节点", 8) == []
    assert fuse([[0, 1], [1]], 60) == [1, 0]


def test_chunks_cover_tail_and_mask_secrets():
    text = "# Nodes\n" + "x" * 400
    parts = chunks(text, 128, 20)
    assert parts[-1]["text"].endswith("x" * 20)
    assert parts[1]["section"] == "Nodes"
    value = redact('password=hello token="world" Bearer abc123 https://u:p@host?a=1&token=xyz')
    for secret in ("hello", "world", "abc123", "u:p", "xyz"):
        assert secret not in value


def test_config_and_hash(settings):
    with pytest.raises(ValueError):
        type(settings)(_env_file=None, **(settings.model_dump() | {"chunk_overlap": 9999}))
    doc = Document(**document())
    assert fingerprint(doc, settings.pipeline) != fingerprint(
        doc.model_copy(update={"status": "verified"}), settings.pipeline
    )


@pytest.mark.parametrize(
    "data",
    [
        {"data": []},
        {"data": [{"index": 0, "embedding": [1]}]},
        {"data": [{"index": 0, "embedding": [0, 0, 0]}]},
    ],
)
def test_invalid_embeddings(settings, data):
    model = Models(settings, httpx.MockTransport(lambda request: httpx.Response(200, json=data)))
    try:
        with pytest.raises(ModelFailure):
            model.embed(["test"])
    finally:
        model.close()


def test_invalid_rerank_indexes(settings):
    model = Models(
        settings,
        httpx.MockTransport(
            lambda request: httpx.Response(
                200, json={"results": [{"index": 99, "relevance_score": 1}]}
            )
        ),
    )
    try:
        with pytest.raises(ModelFailure):
            model.rerank("query", ["doc"], 1)
    finally:
        model.close()


def test_api_roundtrip_and_idempotency(store):
    with client_for(store) as client:
        assert client.get("/health", headers={"Authorization": "wrong"}).status_code == 401
        invalid = client.post("/v1/documents", json={"text": "private-input"})
        assert invalid.status_code == 422 and "private-input" not in invalid.text
        first = client.post("/v1/documents", json=document()).json()
        assert first["changed"]
        assert not client.post("/v1/documents", json=document()).json()["changed"]
        result = client.post("/v1/search", json={"query": "节点"}).json()
        assert result["items"][0]["path"] == "runbooks/nodes.md"
        assert result["items"][0]["content_hash"] == first["content_hash"]
        assert result["items"][0]["untrusted"]
        assert not result["degraded"]
        assert (
            client.post("/v1/search", json={"query": "节点", "kind": "record"}).json()["items"]
            == []
        )
        client.post("/v1/documents", json=document("new content", status="verified"))
        assert store.manifest()["manual-nodes"]["content_hash"] != first["content_hash"]
        client.delete("/v1/documents/manual-nodes")
        assert store.manifest() == {}


def test_failed_update_keeps_old_document_and_search_degrades(store):
    with client_for(store) as client:
        client.post("/v1/documents", json=document())
    before = store.manifest()
    with client_for(store, fail="embeddings") as client:
        response = client.post("/v1/documents", json=document("replacement"))
        assert response.status_code == 502
        assert "private upstream" not in response.text
        assert store.manifest() == before
        result = client.post("/v1/search", json={"query": "节点"}).json()
        assert result["degraded"] and result["items"]
    with client_for(store, fail="rerank") as client:
        result = client.post("/v1/search", json={"query": "节点"}).json()
        assert result["items"][0]["ranking"] == "rrf"


def test_pipeline_change_excludes_incompatible_vectors(store):
    with client_for(store) as client:
        client.post("/v1/documents", json=document())
    store.settings = store.settings.model_copy(update={"embedding_model": "different-model"})
    with client_for(store) as client:
        result = client.post("/v1/search", json={"query": "节点"}).json()
        assert result["items"] == []
        assert "stale_pipeline" in result["warnings"][0]


def test_secrets_removed_before_storage(store):
    with client_for(store) as client:
        client.post("/v1/documents", json=document("token=secret123\nkubectl get nodes"))
    with store.connect() as conn:
        text = conn.execute("SELECT text FROM rag_chunks").fetchone()["text"]
        assert "secret123" not in text


def test_sync_update_delete_and_manifest(store, tmp_path):
    (tmp_path / "runbooks").mkdir()
    (tmp_path / "records").mkdir()
    path = tmp_path / "runbooks" / "nodes.md"
    path.write_text("# Nodes\nkubectl get nodes", encoding="utf-8")
    manifest = tmp_path / ".rag-sync.json"
    with client_for(store) as client:
        assert synchronize(tmp_path, manifest, client)["changed"] == 1
        assert synchronize(tmp_path, manifest, client)["changed"] == 0
        path.write_text("# Nodes\nkubectl get nodes -o wide", encoding="utf-8")
        assert synchronize(tmp_path, manifest, client)["changed"] == 1
        path.unlink()
        synchronize(tmp_path, manifest, client)
        assert len(store.manifest()) == 1
        synchronize(tmp_path, manifest, client, prune=True)
        assert store.manifest() == {}


def test_sync_failure_remains_pending_and_suppresses_prune(store, tmp_path):
    (tmp_path / "runbooks").mkdir()
    (tmp_path / "records").mkdir()
    path = tmp_path / "runbooks" / "nodes.md"
    path.write_text("# Nodes\nkubectl", encoding="utf-8")
    manifest = tmp_path / ".rag-sync.json"
    with client_for(store) as client:
        synchronize(tmp_path, manifest, client)
    path.unlink()
    (tmp_path / "records" / "failed.md").write_text("new", encoding="utf-8")
    with client_for(store, fail="embeddings") as client:
        report = synchronize(tmp_path, manifest, client, prune=True)
        assert len(report["failures"]) == 1
        assert len(store.manifest()) == 1
        assert "records/failed.md" not in json.loads(manifest.read_text())["files"]


@pytest.mark.parametrize(
    ("record_state", "expected"),
    [("success", "verified"), ("failure", "failed"), ("uncertain", "unverified")],
)
def test_sync_record_status_reaches_search_and_status_changes_resync(
    store, tmp_path, record_state, expected
):
    (tmp_path / "runbooks").mkdir()
    records = tmp_path / "records"
    records.mkdir()
    path = records / "operation.md"
    manifest = tmp_path / ".rag-sync.json"
    body = "# Operation\nobserved result"
    path.write_text(
        f"---\ndsh-ops-record-version: 1\nstatus: {record_state}\n---\n{body}",
        encoding="utf-8",
    )
    with client_for(store) as client:
        assert synchronize(tmp_path, manifest, client)["changed"] == 1
        found = client.post("/v1/search", json={"query": "observed"}).json()["items"]
        assert found[0]["status"] == expected
        assert found[0]["untrusted"]
        path.write_text(
            f"---\ndsh-ops-record-version: 1\nstatus: "
            f"{'failure' if record_state != 'failure' else 'success'}\n---\n{body}",
            encoding="utf-8",
        )
        assert synchronize(tmp_path, manifest, client)["changed"] == 1


@pytest.mark.parametrize(
    "frontmatter",
    [
        "---\ndsh-ops-record-version: 1\nstatus: done\n---",
        "---\ndsh-ops-record-version: 1\nstatus success\n---",
        "---\ndsh-ops-record-version: 1\nstatus: success",
        "---\ndsh-ops-record-version: 2\nstatus: success\n---",
    ],
)
def test_invalid_record_status_stays_pending_and_suppresses_prune(store, tmp_path, frontmatter):
    (tmp_path / "runbooks").mkdir()
    records = tmp_path / "records"
    records.mkdir()
    path = records / "operation.md"
    path.write_text(
        "---\ndsh-ops-record-version: 1\nstatus: success\n---\n# Operation\nobserved",
        encoding="utf-8",
    )
    manifest = tmp_path / ".rag-sync.json"
    with client_for(store) as client:
        synchronize(tmp_path, manifest, client)
        original = store.manifest()
        path.write_text(frontmatter + "\n# Operation\nobserved", encoding="utf-8")
        report = synchronize(tmp_path, manifest, client, prune=True)
        state = json.loads(manifest.read_text(encoding="utf-8"))
        assert report["failures"] == [{"path": "records/operation.md", "error": "ValueError"}]
        assert state["files"]["records/operation.md"]["source_hash"]
        assert store.manifest() == original


def test_sync_runbooks_remain_unverified(store, tmp_path):
    (tmp_path / "runbooks").mkdir()
    (tmp_path / "records").mkdir()
    (tmp_path / "runbooks" / "guide.md").write_text(
        "---\ndsh-ops-record-version: 1\nstatus: success\n---\n# Guide\nobserved",
        encoding="utf-8",
    )
    with client_for(store) as client:
        synchronize(tmp_path, tmp_path / ".rag-sync.json", client)
        result = client.post("/v1/search", json={"query": "observed"}).json()
        assert result["items"][0]["status"] == "unverified"


def test_pgvector_cosine_order_and_transaction_rollback(store):
    first = Document(**document("first"))
    second = Document(**document("second", id="second"))
    store.replace(first, "first", chunks(first.text, 128, 0), [[1, 0, 0]])
    store.replace(second, "second", chunks(second.text, 128, 0), [[0, 1, 0]])
    rows, ranks, _ = store.candidates([0, 1, 0], None)
    assert next(row for row in rows if row["id"] == ranks[0])["document_id"] == "second"
    with pytest.raises(ValueError):
        store.replace(first, "bad-update", chunks(first.text, 128, 0), [])
    assert store.manifest()[first.id]["content_hash"] == "first"


def test_sync_missing_directory_never_prunes(store, tmp_path):
    (tmp_path / "runbooks").mkdir()
    (tmp_path / "records").mkdir()
    source = tmp_path / "runbooks" / "file.md"
    source.write_text("# Guide\ncheck nodes", encoding="utf-8")
    manifest = tmp_path / ".rag-sync.json"
    with client_for(store) as client:
        synchronize(tmp_path, manifest, client)
        (tmp_path / "records").rmdir()
        with pytest.raises(ValueError, match="Required directory"):
            synchronize(tmp_path, manifest, client, prune=True)
        assert len(store.manifest()) == 1
