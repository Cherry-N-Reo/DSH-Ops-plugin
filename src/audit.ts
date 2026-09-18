import { createHash } from "node:crypto";
import { mkdir, open, readFile, chmod } from "node:fs/promises";
import { dirname, resolve } from "node:path";

/** Metadata fields accepted in the redacted audit record. */
const FIELDS = new Set(["sessionId", "callId", "assetId", "terminalSession", "commandHash", "risk", "phase", "outcome", "outputHash", "exitCode", "observationId", "credentialRef", "screenshotHash", "time", "attempts", "mode"]);
const HASH_FIELDS = new Set(["commandHash", "outputHash", "screenshotHash"]);
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const RISKS = new Set(["R0", "R1", "R2", "R3", "R4"]);
const PHASES = new Set(["accept", "bind", "intent", "final-command", "classified", "attempt", "result", "observe", "calibrate", "screenshot", "protected-recovery", "credential-hidden-prompt", "credential-attempt", "credential-result", "failure", "terminal-evidence", "input-attempt", "input-verified", "input-helper-failure", "critical-environment-probe", "visual-result"]);
const OUTCOMES = new Set(["allowed", "allowed-once", "unavailable", "rejected", "cancelled", "complete", "unknown", "injected", "failure"]);
const queues = new Map<string, Promise<void>>();
const instances = new Map<string, AuditApi>();

/** Returns the lowercase SHA-256 digest of UTF-8 text. */
export function hash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function canonical(value: Record<string, unknown>): string {
  return JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))));
}

function validate(event: Record<string, unknown>, requireTime = false): Record<string, unknown> {
  for (const key of Object.keys(event)) if (!FIELDS.has(key)) throw new Error(`Audit field is not allowed: ${key}`);
  if (requireTime && event.time === undefined) throw new Error("Audit record is missing time");
  const result: Record<string, unknown> = { ...event, time: event.time ?? new Date().toISOString() };
  for (const [key, value] of Object.entries(result)) {
    if (key === "time") {
      if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw new Error("Audit time must be an ISO date string");
    } else if (HASH_FIELDS.has(key)) {
      if (typeof value !== "string" || !SHA256.test(value)) throw new Error(`Audit ${key} must be a SHA-256 digest`);
    } else if (key === "exitCode") {
      if (value !== null && (typeof value !== "number" || !Number.isInteger(value) || value < -255 || value > 255)) throw new Error("Audit exitCode must be null or an integer from -255 to 255");
    } else if (key === "attempts") {
      if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 3) throw new Error("Audit attempts must be an integer from 0 to 3");
    } else if (typeof value !== "string" || !ID.test(value)) {
      throw new Error(`Audit ${key} must be a bounded identifier`);
    }
    if (key === "credentialRef" && (typeof value !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value))) throw new Error("Audit credentialRef must be a credential reference");
    if (key === "risk" && !RISKS.has(value as string)) throw new Error("Audit risk is not allowed");
    if (key === "phase" && !PHASES.has(value as string)) throw new Error("Audit phase is not allowed");
    if (key === "outcome" && !OUTCOMES.has(value as string)) throw new Error("Audit outcome is not allowed");
    if (key === "mode" && value !== "unicode" && value !== "keyboard") throw new Error("Audit input mode is not allowed");
  }
  return result;
}

interface AuditApi {
  record(event: Record<string, unknown>): Promise<void>;
}

/**
 * Opens a redacted, hash-chained JSONL audit log. Records contain metadata and digests only;
 * Input metadata admits only zero-to-three attempts and Unicode/keyboard modes;
 * unknown fields, plaintext commands, output, and secrets are rejected. Instances for one
 * resolved path share a writer, and append failures reject without advancing the chain.
 */
export function Audit(path: string): AuditApi {
  const target = resolve(path);
  const existing = instances.get(target);
  if (existing) return existing;
  let previous = "0".repeat(64);
  let initialized = false;
  const api: AuditApi = {
    async record(event) {
      const prior = queues.get(target) ?? Promise.resolve();
      const current = prior.then(async () => {
        await mkdir(dirname(target), { recursive: true });
        const metadata = validate(event);
        if (!initialized) {
          try {
            const text = await readFile(target, "utf8");
            const lines = text.trimEnd().length === 0 ? [] : text.trimEnd().split(/\r?\n/);
            for (const line of lines) {
              const parsed: unknown = JSON.parse(line);
              if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Audit log contains a non-object record");
              const record = parsed as Record<string, unknown>;
              if (typeof record.hash !== "string" || !SHA256.test(record.hash) || typeof record.previousHash !== "string" || record.previousHash !== previous) throw new Error("Audit log chain is invalid");
              const metadata = Object.fromEntries(Object.entries(record).filter(([key]) => key !== "hash" && key !== "previousHash"));
              const body = validate(metadata, true);
              if (hash(canonical({ ...body, previousHash: record.previousHash })) !== record.hash) throw new Error("Audit log record hash is invalid");
              previous = record.hash;
            }
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
          initialized = true;
        }
        const body = { ...metadata, previousHash: previous };
        const line = JSON.stringify({ ...body, hash: hash(canonical(body)) });
        const handle = await open(target, "a", 0o600);
        try {
          await handle.writeFile(`${line}\n`, "utf8");
          try { await chmod(target, 0o600); } catch { /* Windows ACLs do not expose POSIX mode bits. */ }
        } finally {
          await handle.close();
        }
        previous = JSON.parse(line).hash as string;
      });
      queues.set(target, current.catch(() => undefined));
      await current;
    },
  };
  instances.set(target, api);
  return api;
}
