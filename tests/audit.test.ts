import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { Audit, hash } from "../src/audit.ts";

test("writes a chained redacted audit and serializes the shared writer", async () => {
  const runtime = join(import.meta.dirname, "../.runtime");
  await mkdir(runtime, { recursive: true });
  const root = await mkdtemp(join(runtime, "audit-"));
  try {
    const path = join(root, "audit.jsonl");
    const first = Audit(path);
    const second = Audit(path);
    assert.equal(first, second);
    await Promise.all([
      first.record({ sessionId: "s1", assetId: "web-1", risk: "R1", phase: "attempt", outcome: "allowed", commandHash: hash("command") }),
      second.record({ sessionId: "s1", assetId: "web-1", risk: "R1", phase: "result", outcome: "complete", exitCode: 0, screenshotHash: hash("screenshot") }),
    ]);
    const lines = (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, string>);
    assert.equal(lines.length, 2);
    assert.equal(lines[1].previousHash, lines[0].hash);
    assert.equal("command" in lines[0], false);
    await assert.rejects(() => first.record({ command: "rm -rf /" }), /not allowed/);
    await assert.rejects(() => first.record({ sessionId: "s1", risk: "low", phase: "attempt", outcome: "allowed" }), /risk is not allowed/);
    await assert.rejects(() => first.record({ sessionId: "s1", risk: "R1", phase: "attempt", outcome: "allowed", credentialRef: "credential://secret" }), /credential reference/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("rejects a tampered existing chain", async () => {
  const runtime = join(import.meta.dirname, "../.runtime");
  await mkdir(runtime, { recursive: true });
  const root = await mkdtemp(join(runtime, "audit-tamper-"));
  try {
    const path = join(root, "audit.jsonl");
    const zero = "0".repeat(64);
    await writeFile(path, `${JSON.stringify({ sessionId: "s1", risk: "R0", phase: "observe", outcome: "unknown", time: new Date().toISOString(), previousHash: zero, hash: zero })}\n`);
    await assert.rejects(() => Audit(path).record({ sessionId: "s1", risk: "R0", phase: "result", outcome: "complete" }), /chain|hash/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("accepts visual input metadata and rejects unbounded counts, modes, phases, and plaintext", async t => {
  const runtime = join(import.meta.dirname, "../.runtime");
  await mkdir(runtime, { recursive: true });
  const root = await mkdtemp(join(runtime, "audit-input-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "audit.jsonl"), writer = Audit(path);
  for (const phase of ["terminal-evidence", "input-attempt", "input-verified", "input-helper-failure", "critical-environment-probe", "visual-result"]) {
    await writer.record({ sessionId: "s", phase, attempts: 3, mode: "unicode" });
  }
  await writer.record({ sessionId: "s", phase: "input-attempt", attempts: 0, mode: "keyboard" });
  for (const attempts of [-1, 4, 1.5, "3", null]) {
    await assert.rejects(writer.record({ sessionId: "s", phase: "input-attempt", attempts, mode: "unicode" }), /attempts/);
  }
  await assert.rejects(writer.record({ sessionId: "s", phase: "input-attempt", attempts: 1, mode: "paste" }), /mode/);
  await assert.rejects(writer.record({ sessionId: "s", phase: "invented-input-phase" }), /phase/);
  await assert.rejects(writer.record({ sessionId: "s", phase: "input-attempt", inputText: "private command" }), /not allowed/);
  const before = await readFile(path, "utf8");
  await writer.record({ sessionId: "s", phase: "visual-result", exitCode: 0, outcome: "complete" });
  const after = await readFile(path, "utf8");
  assert.ok(after.startsWith(before));
  const rows = after.trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
  assert.equal(rows.length, 8);
  for (let i = 1; i < rows.length; i++) assert.equal(rows[i].previousHash, rows[i - 1].hash);
  const replayPath = join(root, "replay.jsonl");
  await writeFile(replayPath, after);
  await Audit(replayPath).record({ sessionId: "s", phase: "input-verified", attempts: 3, mode: "keyboard" });
  assert.equal((await readFile(replayPath, "utf8")).trim().split("\n").length, 9);
});
