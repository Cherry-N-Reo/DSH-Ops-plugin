"""Integration tests own an ephemeral PostgreSQL container, never an existing database."""

import json
import subprocess
import time
import uuid

import pytest

from ops_knowledge.config import Settings
from ops_knowledge.store import Store


def pytest_addoption(parser):
    parser.addoption("--run-db", action="store_true", help="Run isolated Docker pgvector tests")


@pytest.fixture(scope="session")
def database_url(request):
    if not request.config.getoption("--run-db"):
        pytest.skip("Pass --run-db to start an isolated disposable pgvector container")
    name = "dsh-rag-test-" + uuid.uuid4().hex
    password = uuid.uuid4().hex
    subprocess.run(
        [
            "docker",
            "run",
            "--detach",
            "--name",
            name,
            "--label",
            "dsh.rag.test=true",
            "-e",
            "POSTGRES_PASSWORD=" + password,
            "-p",
            "127.0.0.1::5432",
            "pgvector/pgvector:pg16",
        ],
        check=True,
        capture_output=True,
    )
    try:
        info = json.loads(subprocess.check_output(["docker", "inspect", name]))[0]
        port = info["NetworkSettings"]["Ports"]["5432/tcp"][0]["HostPort"]
        deadline = time.monotonic() + 60
        while True:
            ready = subprocess.run(
                ["docker", "exec", name, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"],
                capture_output=True,
                check=False,
            )
            if ready.returncode == 0:
                break
            if time.monotonic() >= deadline:
                raise RuntimeError("Test PostgreSQL did not become ready")
            time.sleep(0.2)
        yield f"postgresql://postgres:{password}@127.0.0.1:{port}/postgres"
    finally:
        subprocess.run(
            ["docker", "rm", "--force", "--volumes", name], check=True, capture_output=True
        )


@pytest.fixture
def settings():
    return Settings(
        _env_file=None,
        database_url="postgresql://unused",
        api_token="test-token-123456",
        siliconflow_api_key="fake",
        embedding_dimension=3,
    )


@pytest.fixture
def store(database_url, settings):
    # Each test has a unique database, so tests never share tables or installed extensions.
    admin = Store(
        settings.model_copy(update={"database_url": type(settings.database_url)(database_url)})
    )
    name = "test_" + uuid.uuid4().hex
    with admin.connect() as conn:
        conn.autocommit = True
        conn.execute(f'CREATE DATABASE "{name}"')
    config = settings.model_copy(
        update={
            "database_url": type(settings.database_url)(database_url.rsplit("/", 1)[0] + "/" + name)
        }
    )
    result = Store(config)
    try:
        result.initialize()
        yield result
    finally:
        with admin.connect() as conn:
            conn.autocommit = True
            conn.execute(f'DROP DATABASE "{name}" WITH (FORCE)')
