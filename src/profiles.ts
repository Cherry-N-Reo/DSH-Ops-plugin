import { readFile } from 'node:fs/promises'
import { parseDocument } from 'yaml'

export interface TerminalProfile {
  id: string; shell: 'posix'; input: 'unicode_then_keyboard'; output: 'visual'; pagerPatterns: string[]
}
/** Profiles are operator-owned configuration, never writable through agent tools. Invalid profiles fail closed. */
export async function profile(path: string, id: string): Promise<TerminalProfile> {
  const text = await readFile(path, 'utf8')
  if (text.length > 131072) throw new Error('Terminal profile file exceeds 128 KiB.')
  const document = parseDocument(text, { uniqueKeys: true })
  if (document.errors.length) throw new Error('Invalid terminal profile YAML.')
  const value: unknown = document.toJS({ maxAliasCount: 0 })
  if (!value || typeof value !== 'object' || !('profiles' in value) || !Array.isArray(value.profiles)) throw new Error('Terminal profile YAML requires profiles array.')
  const match: unknown = value.profiles.find((entry: unknown) => entry && typeof entry === 'object' && 'id' in entry && entry.id === id)
  if (!match || typeof match !== 'object') throw new Error('Asset terminal profile is missing.')
  const record = match as Record<string, unknown>
  if (Object.keys(record).some(key => !['id', 'shell', 'input', 'output', 'pagerPatterns'].includes(key))
    || record.shell !== 'posix' || record.input !== 'unicode_then_keyboard' || record.output !== 'visual'
    || !Array.isArray(record.pagerPatterns)
    || record.pagerPatterns.length > 10 || !record.pagerPatterns.every(v => typeof v === 'string' && v.length < 128)) {
    throw new Error('Profile requires POSIX shell, unicode_then_keyboard input, visual output, and bounded pager patterns.')
  }
  return { id, shell: 'posix', input: 'unicode_then_keyboard', output: 'visual', pagerPatterns: record.pagerPatterns as string[] }
}
