"""Explicit Markdown synchronization; deletes require --prune and a prior owned manifest."""

import argparse
import json
import os
import tempfile
import time
from datetime import UTC, datetime
from hashlib import sha256
from pathlib import Path
from urllib.parse import quote, urlsplit

import httpx
from dotenv import dotenv_values


def record_status(text: str) -> str:
    """Read the versioned status in a record's leading YAML frontmatter."""
    lines = text.splitlines()
    if not lines or lines[0] != "---":
        return "unverified"
    try:
        end = lines.index("---", 1)
    except ValueError as error:
        raise ValueError("Unclosed record frontmatter") from error
    fields = {}
    for line in lines[1:end]:
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        key, separator, value = line.partition(":")
        key = key.strip()
        if not separator or not key or key in fields:
            raise ValueError("Invalid record frontmatter")
        fields[key] = value.strip().strip("\"'")
    if fields.get("dsh-ops-record-version") != "1":
        raise ValueError("Unsupported record metadata version")
    statuses = {"success": "verified", "failure": "failed", "uncertain": "unverified"}
    try:
        return statuses[fields["status"]]
    except KeyError as error:
        raise ValueError("Invalid record status") from error


def synchronize(root: Path, manifest: Path, client: httpx.Client, *, prune=False) -> dict:
    """Sync runbooks/records; retain failed entries and never prune after scan failures."""
    root = root.resolve(strict=True)
    old = (
        json.loads(manifest.read_text(encoding="utf-8"))
        if manifest.exists()
        else {"root": str(root), "files": {}}
    )
    if old["root"] != str(root):
        raise ValueError("Sync manifest belongs to a different root")
    response = client.get("v1/documents")
    response.raise_for_status()
    remote = response.json()
    files = dict(old["files"])
    seen = set()
    failures = []
    changed = 0
    for folder, kind in (("runbooks", "manual"), ("records", "record")):
        base = root / folder
        if not base.is_dir() or base.is_symlink() or not base.resolve().is_relative_to(root):
            raise ValueError(f"Required directory missing or outside root: {folder}")
        paths = []

        def scan_error(error):
            raise error

        for directory, directories, names in os.walk(base, onerror=scan_error, followlinks=False):
            for child in directories:
                candidate = Path(directory) / child
                if candidate.is_symlink() or not candidate.resolve().is_relative_to(root):
                    raise ValueError("Linked document directories are not supported")
            paths.extend(Path(directory) / name for name in names if name.lower().endswith(".md"))
        for path in sorted(paths):
            relative = path.relative_to(root).as_posix()
            seen.add(relative)
            try:
                if path.is_symlink() or not path.resolve().is_relative_to(root):
                    raise ValueError("Document link escapes source root")
                if path.stat().st_size > 2_000_000:
                    raise ValueError("Document exceeds 2 MB")
                text = path.read_text(encoding="utf-8")
                status = record_status(text) if kind == "record" else "unverified"
                local_hash = sha256((text + "\0" + status).encode()).hexdigest()
                # Namespace incorporates the source root to prevent unrelated sync roots colliding.
                id = "md-" + sha256((str(root) + "/" + relative).encode()).hexdigest()
                prior = files.get(relative, {})
                stored = remote["documents"].get(id, {})
                if (
                    prior.get("source_hash") == local_hash
                    and prior.get("pipeline") == remote["pipeline"]
                    and stored.get("content_hash") == prior.get("content_hash")
                    and stored.get("content_hash") is not None
                ):
                    continue
                title = next(
                    (line.lstrip("# ") for line in text.splitlines() if line.startswith("# ")),
                    path.stem,
                )
                result = client.post(
                    "v1/documents",
                    json={
                        "id": id,
                        "path": relative,
                        "title": title,
                        "text": text,
                        "kind": kind,
                        "status": status,
                    },
                )
                result.raise_for_status()
                files[relative] = {
                    "id": id,
                    "source_hash": local_hash,
                    "content_hash": result.json()["content_hash"],
                    "pipeline": remote["pipeline"],
                    "synced_at": datetime.now(UTC).isoformat(),
                }
                changed += 1
            except (OSError, ValueError, httpx.HTTPError) as error:
                # Never persist upstream bodies, document contents, URLs or credential-bearing errors.
                failures.append({"path": relative, "error": type(error).__name__})
    if prune and not failures:
        for relative in sorted(set(files) - seen):
            result = client.delete("v1/documents/" + quote(files[relative]["id"], safe=""))
            result.raise_for_status()
            del files[relative]
    state = {"root": str(root), "files": files, "failures": failures}
    manifest.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(dir=manifest.parent, prefix=".sync-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(state, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
        os.replace(temporary, manifest)
    finally:
        Path(temporary).unlink(missing_ok=True)
    return {"changed": changed, "failures": failures, "tracked": len(files)}


def main():
    """Run once or poll while this foreground process remains open."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path)
    parser.add_argument("--url", default="http://127.0.0.1:8765/")
    parser.add_argument("--manifest", type=Path)
    parser.add_argument("--prune", action="store_true")
    parser.add_argument("--interval", type=int, default=0)
    args = parser.parse_args()
    url = urlsplit(args.url)
    if (
        url.username
        or url.password
        or url.query
        or url.fragment
        or not (
            url.scheme == "https"
            or (url.scheme == "http" and url.hostname in ("127.0.0.1", "localhost", "::1"))
        )
    ):
        parser.error("Use HTTPS, or HTTP on loopback, without URL credentials")
    if args.interval < 0:
        parser.error("interval must be nonnegative")
    token = os.environ.get("RAG_API_TOKEN") or dotenv_values(".env").get("RAG_API_TOKEN")
    if not token:
        parser.error("Set RAG_API_TOKEN in the environment")
    manifest = args.manifest or args.root / ".rag-sync.json"
    # Only one sync process may own a manifest. A crash leaves a lock requiring operator review.
    lock = manifest.with_suffix(manifest.suffix + ".lock")
    lock.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    try:
        os.close(fd)
        with httpx.Client(
            base_url=args.url.rstrip("/") + "/",
            timeout=120,
            headers={"Authorization": "Bearer " + token},
        ) as client:
            while True:
                report = synchronize(args.root, manifest, client, prune=args.prune)
                print(json.dumps(report, ensure_ascii=False))
                if not args.interval:
                    if report["failures"]:
                        raise SystemExit(1)
                    break
                time.sleep(args.interval)
    finally:
        lock.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
