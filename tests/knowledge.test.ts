import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { Knowledge } from "../src/knowledge.ts";

async function fixture(): Promise<string> {
  const runtime = join(import.meta.dirname, "../.runtime");
  await mkdir(runtime, { recursive: true });
  const root = await mkdtemp(join(runtime, "knowledge-"));
  await mkdir(join(root, "inventory"));
  await mkdir(join(root, "runbooks"));
  await writeFile(join(root, "inventory", "assets.yaml"), "assets:\n  - id: web-1\n    environment: staging\n    criticality: high\n    profile: linux\n    services: [nginx]\n    runbooks: [runbooks/nginx.md]\n    credentials:\n      deploy: SAMPLE_WEB_DEPLOY\n");
  await writeFile(join(root, "runbooks", "nginx.md"), "# nginx\nRestart the service after validating configuration.\n");
  return root;
}

test("loads assets and searches contained Markdown", async () => {
  const root = await fixture();
  try {
    const knowledge = Knowledge(root);
    assert.deepEqual(await knowledge.asset("web-1"), {
      id: "web-1", environment: "staging", criticality: "high", profile: "linux",
      services: ["nginx"], runbooks: ["runbooks/nginx.md"], credentials: { deploy: "SAMPLE_WEB_DEPLOY" },
    });
    assert.equal((await knowledge.search("restart"))[0]?.untrusted, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("rejects plaintext credential fields and excludes symlink escapes", async (t) => {
  const root = await fixture();
  const outside = await mkdtemp(join(join(import.meta.dirname, "../.runtime"), "outside-"));
  try {
    await writeFile(join(root, "inventory", "assets.yaml"), "assets:\n  - id: x\n    environment: dev\n    criticality: low\n    profile: linux\n    services: []\n    runbooks: []\n    password: plaintext\n");
    await assert.rejects(() => Knowledge(root).asset("x"), /unknown or sensitive/);
    await writeFile(join(outside, "secret.md"), "restart");
    try {
      await symlink(outside, join(root, "runbooks", "escape"), "junction");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        t.skip("Windows symlink creation requires developer mode or privilege");
        return;
      }
      throw error;
    }
    const matches = await Knowledge(root).search("restart");
    assert.equal(matches.some((match) => match.path.includes("escape")), false);
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});
