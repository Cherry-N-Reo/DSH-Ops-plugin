/** Optional connection bookmarks; records are not permission grants or proof of server identity. */
import { readFile, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import type { Asset } from './knowledge.ts'

/** Model-visible connection metadata. Local password contents are never included. */
export type Connection = { id: string; profile?: string; name?: string; notes?: string;
  username?: string; credentialRef?: string; passwordConfigured?: boolean } & (
  { type: 'webshell'; url: string } |
  { type: 'ssh'; host: string; port?: number; username: string; credentialRef?: string }
)

/** Reads an optional JSON connection file. Missing files are empty; malformed records fail explicitly. */
export class Connections {
  constructor(readonly path: string, readonly maxFile: number) {}
  /** Returns current connection metadata with password contents removed, including from parse errors.
   * @returns Bookmarks with only a passwordConfigured flag when a local password field exists.
   */
  async list(): Promise<Connection[]> {
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
    const ids = new Set<string>()
    return rows.map((row: unknown) => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('Connection must be an object.')
      const r = row as Record<string, unknown>
      const common = ['id', 'type', 'profile', 'name', 'notes', 'username', 'password', 'credentialRef']
      const keys = r.type === 'webshell' ? [...common, 'url'] : [...common, 'host', 'port']
      if (Object.keys(r).some(key => !keys.includes(key))) throw new Error('Unknown connection field. Consult the local connection-file documentation.')
      if (typeof r.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,127}$/.test(r.id) || ids.has(r.id)) throw new Error('Connection IDs must be bounded and unique.')
      ids.add(r.id)
      for (const [field, limit] of [['name', 256], ['notes', 4096], ['password', 4096]] as const) {
        if (r[field] !== undefined && (typeof r[field] !== 'string' || r[field].length > limit)) throw new Error(`Invalid connection ${field} field.`)
      }
      if (r.username !== undefined && (typeof r.username !== 'string' || r.username.length > 256 || /[\u0000-\u001f\u007f]/u.test(r.username))) throw new Error('Invalid connection username.')
      if (r.credentialRef !== undefined && (typeof r.credentialRef !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(r.credentialRef))) throw new Error('Invalid credential reference.')
      if (r.password && r.credentialRef) throw new Error('Choose a local password or credentialRef, not both.')
      if (r.profile !== undefined && (typeof r.profile !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(r.profile))) throw new Error('Invalid terminal profile ID.')
      if (r.type === 'webshell') {
        if (typeof r.url !== 'string' || r.url.length > 2048) throw new Error('WebShell URL is required and bounded.')
        let url: URL
        try { url = new URL(r.url) } catch { throw new Error('Invalid WebShell URL.') }
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('WebShell URL must use HTTP(S) without embedded credentials.')
      } else if (r.type === 'ssh') {
        if (typeof r.host !== 'string' || !/^[A-Za-z0-9.:[\]-]{1,253}$/.test(r.host) || typeof r.username !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(r.username)) throw new Error('SSH host and username are required.')
        if (r.port !== undefined && (typeof r.port !== 'number' || !Number.isInteger(r.port) || r.port < 1 || r.port > 65535)) throw new Error('SSH port must be 1-65535.')
      } else throw new Error('Connection type must be webshell or ssh.')
      const { password, ...visible } = r
      return { ...visible, ...(typeof password === 'string' ? { passwordConfigured: password.length > 0 } : {}) } as Connection
    })
  }
}

/** Creates session metadata for an already observed WebShell, without requiring inventory registration.
 * @param url Operator-configured URL, or empty for manual observation.
 * @param profile Explicit terminal profile for interaction.
 * @param id Optional connection label; otherwise derived from the target URL.
 * @returns Conservative metadata without service or credential privileges.
 */
export function directWebshell(url: string, profile: string, id?: string): Asset {
  if (id !== undefined && !/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,127}$/.test(id)) throw new Error('Invalid connection label.')
  return { id: id ?? `webshell-${createHash('sha256').update(url || 'manual').digest('hex').slice(0, 16)}`,
    environment: 'unspecified', criticality: 'high', profile, services: [], runbooks: [], credentials: {} }
}
