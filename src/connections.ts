/** Optional connection bookmarks; records are not permission grants or proof of server identity. */
import { open, readFile, rename, rm, stat } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import type { Asset } from './knowledge.ts'
import { credentialEntropy, dpapiVault, type ConnectionAuth, type CredentialVault } from './credential-vault.ts'

/** Model-visible connection metadata. Account names and protected values remain local. */
export type Connection = { id: string; profile?: string; name?: string; notes?: string; credentialRef?: string;
  passwordConfigured?: boolean } & ({ type: 'webshell'; url: string } | { type: 'ssh'; host: string; port?: number })

type RawConnection = Record<string, unknown> & { id: string; type: 'webshell' | 'ssh' }
type ProtectedAuth = { version: 1; ciphertext: string; passwordConfigured: boolean }

/** Reads bookmarks and resolves protected credentials only for the selected ID. */
export class Connections {
  constructor(readonly path: string, readonly maxFile: number, private readonly vault: CredentialVault = dpapiVault) {}

  /** Returns metadata with no username, password, or ciphertext. Legacy plaintext auth is marked for migration. */
  async list(): Promise<Connection[]> {
    const rows = await this.readRows()
    return rows.map(row => {
      const { username: _username, password: _password, protectedAuth, ...visible } = row
      const configured = validProtectedAuth(protectedAuth) ? protectedAuth.passwordConfigured
        : typeof row.username === 'string' && row.username.length > 0 || typeof row.password === 'string' && row.password.length > 0
      return { ...visible, ...(validProtectedAuth(protectedAuth) ? { passwordConfigured: configured } : configured ? { passwordConfigured: true } : {}) } as Connection
    })
  }

  /**
   * Resolves credentials for one protected bookmark. Legacy plaintext records must be migrated first.
   * @param id Stable connection ID selected by the caller.
   * @returns Account and optional password, or undefined when the record has no configured local auth.
   * @throws For missing IDs, malformed records, legacy plaintext credentials, or DPAPI/target mismatch.
   */
  async resolveAuth(id: string): Promise<ConnectionAuth | undefined> {
    const row = (await this.readRows()).find(candidate => candidate.id === id)
    if (!row) throw new Error('Connection bookmark not found.')
    if (row.username !== undefined || row.password !== undefined) throw new Error('Plaintext connection credentials are disabled. Migrate the connection file before login.')
    const protectedAuth = row.protectedAuth
    if (protectedAuth === undefined) return undefined
    if (!validProtectedAuth(protectedAuth)) throw new Error('Protected connection credentials are invalid.')
    const target = targetFor(row)
    let auth: ConnectionAuth
    try { auth = await this.vault.unprotect(protectedAuth.ciphertext, credentialEntropy(row.id, row.type, target)) }
    catch { throw new Error('Protected connection credentials could not be decrypted for this Windows user and target.') }
    if (!validAuth(auth)) throw new Error('Protected connection credentials are invalid.')
    return auth
  }

  /** Reads and validates the full local file without returning secret-bearing parse errors. */
  async readRows(): Promise<RawConnection[]> {
    let text: string
    try {
      if ((await stat(this.path)).size > this.maxFile) throw new Error('Connection file exceeds configured file-size limit.')
      text = await readFile(this.path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    if (Buffer.byteLength(text) > this.maxFile) throw new Error('Connection file exceeds configured file-size limit.')
    let rows: unknown
    try { rows = JSON.parse(text) } catch { throw new Error('Connections JSON is malformed. Fix the local file; its contents are not included in this error.') }
    if (!Array.isArray(rows)) throw new Error('Connections JSON must be an array.')
    return validateConnectionRows(rows)
  }
}

/** Encrypts all legacy plaintext credentials while preserving records without auth. */
export async function protectConnectionRows(rows: RawConnection[], vault: CredentialVault = dpapiVault): Promise<RawConnection[]> {
  const output: RawConnection[] = []
  for (const row of rows) {
    if (row.username !== undefined || row.password !== undefined) {
      if (row.protectedAuth !== undefined) throw new Error('A connection cannot mix plaintext and protected credentials.')
      const auth: ConnectionAuth = { username: String(row.username ?? '') }
      if (typeof row.password === 'string' && row.password.length > 0) auth.password = row.password
      if (row.type === 'ssh' && !auth.username) throw new Error('SSH username is required before migration.')
      const ciphertext = await vault.protect(auth, credentialEntropy(row.id, row.type, targetFor(row)))
      const protectedAuth: ProtectedAuth = { version: 1, ciphertext, passwordConfigured: Boolean(auth.password) }
      const { username: _username, password: _password, ...metadata } = row
      output.push({ ...metadata, protectedAuth })
    } else output.push(row)
  }
  return output
}

/** Migrates the complete file and replaces it only after every protected credential decrypts successfully. */
export async function migrateConnectionFile(path: string, maxFile: number, vault: CredentialVault = dpapiVault): Promise<number> {
  try { await stat(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw new Error('Credential migration could not read the connection file.')
  }
  const manager = new Connections(path, maxFile, vault)
  const rows = await manager.readRows()
  let output: RawConnection[]
  try { output = validateConnectionRows(await protectConnectionRows(rows, vault)) }
  catch { throw new Error('Credential migration failed; the original connection file was left unchanged.') }
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`)
  const mode = await stat(path).then(info => info.mode & 0o777, () => 0o600)
  try {
    const handle = await open(temporary, 'wx', mode)
    try { await handle.writeFile(JSON.stringify(output, null, 2) + '\n', 'utf8'); await handle.sync() } finally { await handle.close() }
    const verifier = new Connections(temporary, maxFile, vault)
    for (const row of output) {
      if (!row.protectedAuth) continue
      const auth = await verifier.resolveAuth(row.id)
      if (!auth) throw new Error('Credential migration round-trip failed.')
    }
    await rename(temporary, path)
    return output.length
  } catch {
    await rm(temporary, { force: true })
    throw new Error('Credential migration failed; the original connection file was left unchanged.')
  }
}

/** Validates a complete connection-file candidate before migration or replacement. */
export function validateConnectionRows(value: unknown): RawConnection[] {
  if (!Array.isArray(value)) throw new Error('Connections JSON must be an array.')
  const ids = new Set<string>()
  return value.map(row => validateRow(row, ids))
}

function validateRow(value: unknown, ids: Set<string>): RawConnection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Connection must be an object.')
  const row = value as Record<string, unknown>
  const common = ['id', 'type', 'profile', 'name', 'notes', 'username', 'password', 'credentialRef', 'protectedAuth']
  const keys = row.type === 'webshell' ? [...common, 'url'] : [...common, 'host', 'port']
  if (Object.keys(row).some(key => !keys.includes(key))) throw new Error('Unknown connection field. Consult the local connection-file documentation.')
  if (typeof row.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,127}$/.test(row.id) || ids.has(row.id)) throw new Error('Connection IDs must be bounded and unique.')
  ids.add(row.id)
  for (const [field, limit] of [['name', 256], ['notes', 4096], ['password', 4096]] as const)
    if (row[field] !== undefined && (typeof row[field] !== 'string' || row[field].length > limit)) throw new Error(`Invalid connection ${field} field.`)
  if (row.username !== undefined && (typeof row.username !== 'string' || row.username.length > 256 || /[\u0000-\u001f\u007f]/u.test(row.username))) throw new Error('Invalid connection username.')
  if (row.credentialRef !== undefined && (typeof row.credentialRef !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(row.credentialRef))) throw new Error('Invalid credential reference.')
  if (row.password && row.credentialRef) throw new Error('Choose a local password or credentialRef, not both.')
  if (row.protectedAuth !== undefined && !validProtectedAuth(row.protectedAuth)) throw new Error('Protected connection credentials are invalid.')
  if (row.protectedAuth !== undefined && (row.username !== undefined || row.password !== undefined)) throw new Error('Plaintext and protected credentials cannot be mixed.')
  if (row.profile !== undefined && (typeof row.profile !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(row.profile))) throw new Error('Invalid terminal profile ID.')
  if (row.type === 'webshell') {
    if (typeof row.url !== 'string' || row.url.length > 2048) throw new Error('WebShell URL is required and bounded.')
    let url: URL
    try { url = new URL(row.url) } catch { throw new Error('Invalid WebShell URL.') }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('WebShell URL must use HTTP(S) without embedded credentials.')
  } else if (row.type === 'ssh') {
    if (typeof row.host !== 'string' || !/^[A-Za-z0-9.:[\]-]{1,253}$/.test(row.host)) throw new Error('SSH host is required.')
    if (row.port !== undefined && (typeof row.port !== 'number' || !Number.isInteger(row.port) || row.port < 1 || row.port > 65535)) throw new Error('SSH port must be 1-65535.')
    if (row.username === undefined && row.protectedAuth === undefined && typeof row.credentialRef !== 'string') throw new Error('SSH username or protected credentials are required.')
  } else throw new Error('Connection type must be webshell or ssh.')
  if (row.protectedAuth !== undefined && row.credentialRef !== undefined && (row.protectedAuth as ProtectedAuth).passwordConfigured)
    throw new Error('Choose a local password or credentialRef, not both.')
  return row as RawConnection
}

function validProtectedAuth(value: unknown): value is ProtectedAuth {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const auth = value as Record<string, unknown>
  return auth.version === 1 && typeof auth.ciphertext === 'string' && auth.ciphertext.length > 0 && auth.ciphertext.length <= 32768
    && typeof auth.passwordConfigured === 'boolean' && Object.keys(auth).every(key => ['version', 'ciphertext', 'passwordConfigured'].includes(key))
}

function validAuth(value: unknown): value is ConnectionAuth {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const auth = value as Record<string, unknown>
  return typeof auth.username === 'string' && auth.username.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(auth.username)
    && (auth.password === undefined || typeof auth.password === 'string' && auth.password.length <= 4096)
    && Object.keys(auth).every(key => key === 'username' || key === 'password')
}

function targetFor(row: RawConnection): string {
  return row.type === 'webshell' ? String(row.url) : `${row.host}:${row.port ?? 22}`
}

/** Creates session metadata for an already observed WebShell, without requiring inventory registration. */
export function directWebshell(url: string, profile: string, id?: string): Asset {
  if (id !== undefined && !/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,127}$/.test(id)) throw new Error('Invalid connection label.')
  return { id: id ?? `webshell-${createHash('sha256').update(url || 'manual').digest('hex').slice(0, 16)}`,
    environment: 'unspecified', criticality: 'high', profile, services: [], runbooks: [], credentials: {} }
}
