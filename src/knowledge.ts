import { realpath } from "node:fs/promises";
import { readFile, readdir, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { parseDocument, type Document } from "yaml";

/** A validated inventory entry. Credential values are references, never secrets. */
export interface Asset {
  id: string;
  environment: string;
  criticality: string;
  profile: string;
  services: string[];
  runbooks: string[];
  credentials: Record<string, string>;
}

const ASSET_KEYS = new Set([
  "id",
  "environment",
  "criticality",
  "profile",
  "services",
  "runbooks",
  "credentials",
]);
const CREDENTIAL_REFERENCE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SENSITIVE_KEY = /(?:password|token|secret|api[_-]?key|private[_-]?key)/i;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,127}$/;

function fail(message: string): never {
  throw new Error(`Invalid inventory: ${message}`);
}

function stringField(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) {
    fail(`${field} must be a non-empty string of at most 512 characters`);
  }
  return value;
}

function stringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > 64) fail(`${field} must be an array of at most 64 strings`);
  return value.map((entry, index) => stringField(entry, `${field}[${index}]`));
}

function referenceList(value: unknown, field: string): string[] {
  return stringList(value, field).map((entry) => {
    if (isAbsolute(entry) || entry.split(/[\\/]/).includes("..")) fail(`${field} contains a path outside the knowledge root`);
    return entry;
  });
}

function credentials(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("credentials must be a mapping");
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key)) fail(`credential key ${key} is not an allowed metadata name`);
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(key)) fail(`invalid credential name ${key}`);
    const reference = stringField(entry, `credentials.${key}`);
    if (!CREDENTIAL_REFERENCE.test(reference)) fail(`credentials.${key} must be a credential reference`);
    result[key] = reference;
  }
  return result;
}

function parseAssets(document: Document): Asset[] {
  if (document.errors.length > 0) fail(document.errors.map((error) => error.message).join("; "));
  const value = document.toJS({ maxAliasCount: 0 }) as unknown;
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("root must be a mapping");
  const root = value as Record<string, unknown>;
  for (const key of Object.keys(root)) {
    if (key !== "assets" || SENSITIVE_KEY.test(key)) fail(`unknown or sensitive root field ${key}`);
  }
  const entries = root.assets;
  if (!Array.isArray(entries) || entries.length > 256) fail("assets must be an array of at most 256 entries");
  const parsed = entries.map((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) fail(`assets[${index}] must be a mapping`);
    const record = entry as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (!ASSET_KEYS.has(key) || SENSITIVE_KEY.test(key)) fail(`unknown or sensitive field ${key}`);
    }
    for (const required of ["id", "environment", "criticality", "profile", "services", "runbooks"]) {
      if (!(required in record)) fail(`assets[${index}] is missing ${required}`);
    }
    const id = stringField(record.id, `assets[${index}].id`);
    if (!SAFE_ID.test(id)) fail(`assets[${index}].id is not a safe bounded identifier`);
    return {
      id,
      environment: stringField(record.environment, `assets[${index}].environment`),
      criticality: stringField(record.criticality, `assets[${index}].criticality`),
      profile: stringField(record.profile, `assets[${index}].profile`),
      services: stringList(record.services, `assets[${index}].services`),
      runbooks: referenceList(record.runbooks, `assets[${index}].runbooks`),
      credentials: credentials(record.credentials),
    };
  });
  if (new Set(parsed.map((asset) => asset.id)).size !== parsed.length) fail("asset ids must be unique");
  return parsed;
}

async function inside(root: string, candidate: string): Promise<string | undefined> {
  const rootReal = await realpath(root);
  try {
    const candidateReal = await realpath(candidate);
    const rel = relative(rootReal, candidateReal);
    return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${candidateReal.includes("\\") ? "\\" : "/"}`))
      ? candidateReal
      : undefined;
  } catch {
    return undefined;
  }
}

async function markdownFiles(root: string, directory: string, maxResults: number,
  budget = { remaining: maxResults * 20, visited: new Set<string>() }): Promise<string[]> {
  const key = process.platform === 'win32' ? directory.toLowerCase() : directory;
  if (budget.visited.has(key) || budget.remaining <= 0) return [];
  budget.visited.add(key);
  const result: string[] = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (--budget.remaining < 0) break;
    const candidate = join(directory, entry.name);
    const safe = await inside(root, candidate);
    if (!safe) continue;
    if (entry.isDirectory()) result.push(...await markdownFiles(root, safe, maxResults, budget));
    else if (entry.isFile() && safe.toLowerCase().endsWith(".md")) result.push(safe);
    if (result.length >= maxResults * 4) break;
  }
  return result;
}

/**
 * Loads the local inventory and searches contained Markdown runbooks.
 * Search follows directory entries only after realpath validation, caps results and text,
 * and returns untrusted document text for callers to handle as data.
 */
export interface KnowledgeOptions {
  maxResults?: number;
  maxText?: number;
  maxFile?: number;
}

/** Creates a local inventory reader with bounded, caller-configurable search limits. */
export function Knowledge(root: string, options: KnowledgeOptions = {}) {
  const rootPath = resolve(root);
  const maxResults = options.maxResults ?? 20;
  const maxText = options.maxText ?? 16_384;
  const maxFile = options.maxFile ?? 1_048_576;
  if (![maxResults, maxText, maxFile].every((value) => Number.isInteger(value) && value > 0)) throw new Error("Knowledge limits must be positive integers");
  const load = async (): Promise<Asset[]> => {
    const inventoryPath = await inside(rootPath, join(rootPath, "inventory", "assets.yaml"));
    if (!inventoryPath) throw new Error("Inventory path is outside the knowledge root");
    if ((await stat(inventoryPath)).size > maxFile) throw new Error('Inventory exceeds configured file-size limit');
    return parseAssets(parseDocument(await readFile(inventoryPath, "utf8"), { uniqueKeys: true }));
  };
  return {
    async asset(id: string): Promise<Asset> {
      const found = (await load()).find((asset) => asset.id === id);
      if (!found) throw new Error(`Unknown asset: ${id}`);
      return { ...found, services: [...found.services], runbooks: [...found.runbooks], credentials: { ...found.credentials } };
    },
    async search(query: string): Promise<{ path: string; text: string; untrusted: true }[]> {
      if (typeof query !== "string" || query.length === 0 || query.length > 512) throw new Error("Search query must be 1-512 characters");
      const safeRoot = await realpath(rootPath);
      const runbooks = await inside(safeRoot, join(safeRoot, "runbooks"));
      if (!runbooks) return [];
      const files = await markdownFiles(safeRoot, runbooks, maxResults);
      const lowered = query.toLocaleLowerCase();
      const matches: { path: string; text: string; untrusted: true }[] = [];
      for (const file of files) {
        if (matches.length >= maxResults) break;
        const info = await stat(file);
        if (info.size > maxFile) continue;
        const text = await readFile(file, "utf8");
        if (text.toLocaleLowerCase().includes(lowered)) {
          const path = relative(safeRoot, file);
          if (isAbsolute(path)) continue;
          matches.push({ path: path.replaceAll("\\", "/"), text: Buffer.from(text).subarray(0, maxText).toString('utf8'), untrusted: true });
        }
      }
      return matches;
    },
  };
}
