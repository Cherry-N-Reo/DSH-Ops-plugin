import { open, rename, stat, writeFile, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { Connections, migrateConnectionFile, protectConnectionRows, validateConnectionRows } from '../src/connections.ts'
import { credentialEntropy, dpapiVault, type ConnectionAuth } from '../src/credential-vault.ts'

const file = process.argv[3] ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'operations', 'connections.json')
const operation = process.argv[2]

try {
  if (process.platform !== 'win32') throw new Error('Credential management requires Windows DPAPI.')
  if (operation === 'migrate') await migrate(file)
  else if (operation === 'add-webshell' || operation === 'add-ssh') await add(file, operation === 'add-webshell' ? 'webshell' : 'ssh')
  else if (operation === 'edit') await edit(file)
  else throw new Error('Usage: credential-manager.ts migrate [connections.json] | add-webshell [connections.json] | add-ssh [connections.json] | edit [connections.json]')
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Credential operation failed.')
  process.exitCode = 1
}

async function migrate(path: string): Promise<void> {
  const count = await migrateConnectionFile(path, 16 * 1024 * 1024)
  console.log(`Protected ${count} connection record(s). Existing backups and file history may still contain plaintext; review and manage them separately.`)
}

async function add(path: string, type: 'webshell' | 'ssh'): Promise<void> {
  const input = createInterface({ input: stdin, output: stdout })
  try {
    const id = await input.question('Connection ID: ')
    const name = await input.question('Display name (optional): ')
    const target = type === 'webshell'
      ? { url: await input.question('Complete WebShell URL: ') }
      : { host: await input.question('SSH host: '), port: Number(await input.question('SSH port [22]: ') || '22') }
    const username = await input.question('Username: ')
    input.close()
    const password = await hiddenInput('Password (blank for none): ')
    const auth: ConnectionAuth = { username }
    if (password) auth.password = password
    const entropyTarget = type === 'webshell' ? String((target as { url: string }).url)
      : `${(target as { host: string; port: number }).host}:${(target as { port: number }).port}`
    const row = { id, type, ...(name ? { name } : {}), ...target,
      protectedAuth: { version: 1, ciphertext: await dpapiVault.protect(auth, credentialEntropy(id, type, entropyTarget)), passwordConfigured: Boolean(password) } }
    const manager = new Connections(path, 16 * 1024 * 1024)
    const rows = await manager.readRows()
    const protectedRows = await protectConnectionRows(rows)
    const output = validateConnectionRows([...protectedRows, row])
    const validation = new Connections(path, 16 * 1024 * 1024, dpapiVault)
    await verify(output, validation)
    await replaceAtomically(path, JSON.stringify(output, null, 2) + '\n')
    console.log('Connection saved with Windows CurrentUser protection.')
  } finally { input.close() }
}

async function edit(path: string): Promise<void> {
  const input = createInterface({ input: stdin, output: stdout })
  try {
    const manager = new Connections(path, 16 * 1024 * 1024)
    const rows = await manager.readRows()
    const id = await input.question('Connection ID to edit: ')
    const index = rows.findIndex(row => row.id === id)
    if (index < 0) throw new Error('Connection bookmark not found.')
    const oldRow = rows[index]!
    const protectedRows = await protectConnectionRows(rows)
    const updated = { ...protectedRows[index]! }
    const name = await input.question(`Name [${String(oldRow.name ?? '')}] (Enter keeps, - clears): `)
    const notes = await input.question(`Notes [${String(oldRow.notes ?? '')}] (Enter keeps, - clears): `)
    applyOptional(updated, 'name', name)
    applyOptional(updated, 'notes', notes)
    let targetChanged = false
    if (oldRow.type === 'webshell') {
      const url = await input.question(`URL [${String(oldRow.url)}] (Enter keeps): `)
      if (url) { updated.url = url; targetChanged = url !== oldRow.url }
    } else {
      const host = await input.question(`Host [${String(oldRow.host)}] (Enter keeps): `)
      const portText = await input.question(`Port [${String(oldRow.port ?? 22)}] (Enter keeps): `)
      if (host) { updated.host = host; targetChanged ||= host !== oldRow.host }
      if (portText) { updated.port = Number(portText); targetChanged ||= Number(portText) !== (oldRow.port ?? 22) }
    }
    if (targetChanged) {
      if (await input.question('Target changes invalidate the existing binding. Type CHANGE to confirm: ') !== 'CHANGE') throw new Error('Target change was not confirmed; the original file is unchanged.')
      const before = protectedRows[index]!
      const priorAuth = before.protectedAuth as { ciphertext: string; passwordConfigured: boolean } | undefined
      if (priorAuth) {
        let auth: ConnectionAuth
        try {
          auth = await dpapiVault.unprotect(priorAuth.ciphertext,
            credentialEntropy(before.id, before.type, before.type === 'webshell' ? String(oldRow.url) : `${oldRow.host}:${oldRow.port ?? 22}`))
        } catch { throw new Error('Credentials could not be re-encrypted for the requested target; the original file is unchanged.') }
        const target = updated.type === 'webshell' ? String(updated.url) : `${updated.host}:${updated.port ?? 22}`
        updated.protectedAuth = { version: 1, ciphertext: await dpapiVault.protect(auth, credentialEntropy(updated.id, updated.type, target)),
          passwordConfigured: priorAuth.passwordConfigured }
      }
    }
    if ((await input.question('Update local login username/password? (y/N): ')).toLowerCase() === 'y') {
      const current = await resolveCandidateAuth(updated)
      const usernameInput = await input.question(`Username [${current.username}] (Enter keeps, - clears): `)
      if (usernameInput === '-') current.username = ''
      else if (usernameInput) current.username = usernameInput
      const replacePassword = (await input.question('Change password? (y/N): ')).toLowerCase() === 'y'
      let removeReference = false
      if (replacePassword && updated.credentialRef !== undefined) {
        if (await input.question('Type LOCAL to stop using the external credential reference: ') !== 'LOCAL')
          throw new Error('Credential source was not changed; the original file is unchanged.')
        removeReference = true
      }
      input.close()
      if (replacePassword) {
        const password = await hiddenInput('New password (blank clears it): ')
        if (password) current.password = password
        else delete current.password
      }
      const target = updated.type === 'webshell' ? String(updated.url) : `${updated.host}:${updated.port ?? 22}`
      updated.protectedAuth = { version: 1, ciphertext: await dpapiVault.protect(current, credentialEntropy(updated.id, updated.type, target)),
        passwordConfigured: Boolean(current.password) }
      if (removeReference) delete updated.credentialRef
    }
    const candidate = [...protectedRows]
    candidate[index] = updated
    const output = validateConnectionRows(candidate)
    await verify(output, manager)
    await replaceAtomically(path, JSON.stringify(output, null, 2) + '\n')
    console.log('Connection updated. Any legacy credentials in the file were protected during the update.')
  } finally { input.close() }
}

async function resolveCandidateAuth(row: Record<string, unknown> & { id: string; type: 'webshell' | 'ssh' }): Promise<ConnectionAuth> {
  const protectedAuth = row.protectedAuth as { ciphertext: string } | undefined
  if (!protectedAuth) return { username: '' }
  try {
    const target = row.type === 'webshell' ? String(row.url) : `${row.host}:${row.port ?? 22}`
    return await dpapiVault.unprotect(protectedAuth.ciphertext, credentialEntropy(row.id, row.type, target))
  } catch { throw new Error('Current login credentials could not be decrypted; the original file is unchanged.') }
}

function applyOptional(row: Record<string, unknown>, key: 'name' | 'notes', value: string): void {
  if (value === '-') delete row[key]
  else if (value) row[key] = value
}

async function verify(rows: Parameters<typeof protectConnectionRows>[0], manager: Connections): Promise<void> {
  for (const row of rows) {
    if (!row.protectedAuth) continue
    const temp = join(dirname(manager.path), `.${basename(manager.path)}.${randomUUID()}.verify`)
    await writeFile(temp, JSON.stringify([row]), { flag: 'wx' })
    try {
      const verifier = new Connections(temp, 16 * 1024 * 1024)
      const auth = await verifier.resolveAuth(row.id)
      if (!auth || typeof auth.username !== 'string') throw new Error('Credential round-trip verification failed.')
    } finally { await rm(temp, { force: true }) }
  }
}

async function replaceAtomically(path: string, contents: string): Promise<void> {
  if (Buffer.byteLength(contents) > 16 * 1024 * 1024) throw new Error('Connection file exceeds configured file-size limit.')
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`)
  const previousMode = await stat(path).then(info => info.mode & 0o777, () => 0o600)
  try {
    const handle = await open(temporary, 'wx', previousMode)
    try { await handle.writeFile(contents, 'utf8'); await handle.sync() } finally { await handle.close() }
    await rename(temporary, path)
  } catch {
    await rm(temporary, { force: true })
    throw new Error('Could not safely replace the connection file; the original file was left unchanged.')
  }
}

async function hiddenInput(prompt: string): Promise<string> {
  if (!stdin.isTTY || !stdout.isTTY) throw new Error('Secure credential entry requires an interactive terminal.')
  stdout.write(prompt)
  stdin.setEncoding('utf8'); stdin.setRawMode(true); stdin.resume()
  let value = ''
  try {
    for await (const chunk of stdin) {
      for (const char of String(chunk)) {
        if (char === '\u0003') throw new Error('Credential entry cancelled.')
        if (char === '\r' || char === '\n') { stdout.write('\n'); return value }
        if (char === '\b' || char === '\u007f') { value = [...value].slice(0, -1).join(''); continue }
        if (char >= ' ') value += char
      }
    }
    throw new Error('Credential entry ended before confirmation.')
  } finally { stdin.setRawMode(false); stdin.pause() }
}
