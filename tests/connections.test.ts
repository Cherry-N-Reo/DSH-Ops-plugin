import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Connections, directWebshell, migrateConnectionFile, protectConnectionRows, validateConnectionRows } from '../src/connections.ts'
import { credentialEntropy, dpapiVault, type ConnectionAuth, type CredentialVault } from '../src/credential-vault.ts'

const testVault: CredentialVault = {
  async protect(auth, entropy) { return Buffer.from(JSON.stringify({ auth, entropy })).toString('base64') },
  async unprotect(ciphertext, entropy) {
    const value = JSON.parse(Buffer.from(ciphertext, 'base64').toString()) as { auth: ConnectionAuth; entropy: string }
    if (value.entropy !== entropy) throw new Error('DPAPI authentication failed')
    return value.auth
  },
}

test('connection bookmarks are optional and visible metadata excludes account names', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-connections-'))
  try {
    const file = join(root, 'connections.json'), connections = new Connections(file, 4096, testVault)
    assert.deepEqual(await connections.list(), [])
    const records = [{ id: 'web', type: 'webshell', url: 'https://example.invalid/#/shell' },
      { id: 'ssh', type: 'ssh', host: '10.0.0.1', port: 22, username: 'operator', credentialRef: 'STAGING_SSH' }]
    await writeFile(file, JSON.stringify(records))
    const visible = await connections.list()
    assert.deepEqual(visible, [{ ...records[0] }, { id: 'ssh', type: 'ssh', host: '10.0.0.1', port: 22, credentialRef: 'STAGING_SSH', passwordConfigured: true }])
    assert.equal(JSON.stringify(visible).includes('operator'), false)
    assert.equal(directWebshell(records[0]!.url, 'linux').profile, 'linux')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('protected credentials resolve only for their original identity and target', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-connections-'))
  try {
    const absent = join(root, 'absent.json')
    assert.equal(await migrateConnectionFile(absent, 4096, testVault), 0)
    await assert.rejects(readFile(absent))
    const file = join(root, 'connections.json')
    const legacy = [{ id: 'web', type: 'webshell', url: 'https://example.invalid/#/shell', username: 'admin@example.invalid', password: 'test-only-web-password', name: 'Console' },
      { id: 'ssh', type: 'ssh', host: '10.0.0.1', username: 'operator', password: 'test-only-ssh-password', name: 'Node' }]
    const encrypted = await protectConnectionRows(validateConnectionRows(legacy), testVault)
    await writeFile(file, JSON.stringify(encrypted))
    const connections = new Connections(file, 4096, testVault)
    const visible = await connections.list()
    assert.equal(visible[0]!.name, 'Console')
    assert.ok(visible.every(row => row.passwordConfigured === true))
    assert.doesNotMatch(JSON.stringify(visible), /admin@example|operator|test-only-|ciphertext/)
    assert.deepEqual(await connections.resolveAuth('web'), { username: 'admin@example.invalid', password: 'test-only-web-password' })
    assert.deepEqual(await connections.resolveAuth('ssh'), { username: 'operator', password: 'test-only-ssh-password' })

    const changed = structuredClone(encrypted)
    changed[0]!.url = 'https://other.invalid/#/shell'
    await writeFile(file, JSON.stringify(changed))
    await assert.rejects(connections.resolveAuth('web'), /could not be decrypted/)
    changed[0]!.url = legacy[0]!.url
    changed[0]!.id = 'other-id'
    await writeFile(file, JSON.stringify(changed))
    await assert.rejects(connections.resolveAuth('other-id'), /could not be decrypted/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('modified ciphertext, wrong user and legacy plaintext cannot be resolved', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-connections-'))
  try {
    const file = join(root, 'connections.json')
    const encrypted = await protectConnectionRows(validateConnectionRows([{ id: 'web', type: 'webshell', url: 'https://example.invalid', username: 'operator', password: 'secret' }]), testVault)
    const original = encrypted[0]!.protectedAuth as { version: 1; ciphertext: string; passwordConfigured: boolean }
    const connections = new Connections(file, 4096, testVault)
    await writeFile(file, JSON.stringify(encrypted))
    await assert.rejects(connections.resolveAuth('missing'), /not found/)
    const tampered = structuredClone(encrypted)
    ;(tampered[0]!.protectedAuth as { ciphertext: string }).ciphertext = original.ciphertext.slice(0, -2) + 'AA'
    await writeFile(file, JSON.stringify(tampered))
    await assert.rejects(connections.resolveAuth('web'), /could not be decrypted/)
    const otherUser: CredentialVault = { ...testVault, async unprotect() { throw new Error('wrong user') } }
    await writeFile(file, JSON.stringify(encrypted))
    await assert.rejects(new Connections(file, 4096, otherUser).resolveAuth('web'), /could not be decrypted/)
    await writeFile(file, JSON.stringify([{ id: 'web', type: 'webshell', url: 'https://example.invalid', username: 'operator', password: 'secret' }]))
    const legacyManager = new Connections(file, 4096, testVault)
    assert.doesNotMatch(JSON.stringify(await legacyManager.list()), /operator|secret/)
    await assert.rejects(legacyManager.resolveAuth('web'), /Migrate the connection file/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('migration verifies before replacement and leaves the original bytes intact on failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-connections-'))
  try {
    const file = join(root, 'connections.json')
    const original = JSON.stringify([{ id: 'web', type: 'webshell', url: 'https://example.invalid', username: 'operator', password: 'migration-secret' },
      { id: 'ssh', type: 'ssh', host: 'node.example.invalid', username: 'operator', credentialRef: 'SSH_OPERATOR' }])
    await writeFile(file, original)
    const failingVault: CredentialVault = { ...testVault, async protect() { throw new Error('provider error with migration-secret') } }
    await assert.rejects(migrateConnectionFile(file, 4096, failingVault), error => !String(error).includes('migration-secret'))
    assert.equal(await readFile(file, 'utf8'), original)
    const count = await migrateConnectionFile(file, 4096, testVault)
    assert.equal(count, 2)
    const contents = await readFile(file, 'utf8')
    assert.doesNotMatch(contents, /operator|migration-secret/)
    assert.deepEqual(await new Connections(file, 4096, testVault).resolveAuth('web'), { username: 'operator', password: 'migration-secret' })
    assert.deepEqual(await new Connections(file, 4096, testVault).resolveAuth('ssh'), { username: 'operator' })
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('Windows DPAPI CurrentUser round-trips Unicode and rejects changed target entropy', { skip: process.platform !== 'win32' }, async () => {
  const entropy = credentialEntropy('web', 'webshell', 'https://example.invalid/#/shell?region=一')
  const auth = { username: '运维员@example.invalid', password: 'Päss🔐word' }
  const ciphertext = await dpapiVault.protect(auth, entropy)
  assert.notEqual(ciphertext, JSON.stringify(auth))
  assert.deepEqual(await dpapiVault.unprotect(ciphertext, entropy), auth)
  await assert.rejects(dpapiVault.unprotect(ciphertext, credentialEntropy('web', 'webshell', 'https://other.invalid/')))
})

test('malformed records reject without echoing their credential fields', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-connections-'))
  try {
    const file = join(root, 'connections.json'), connections = new Connections(file, 4096, testVault)
    await writeFile(file, '[{"password":"test-only-secret-context", BAD JSON]')
    await assert.rejects(connections.list(), error => !String(error).includes('test-only-secret-context'))
    await writeFile(file, JSON.stringify([{ id: 'web', type: 'webshell', url: 'https://example.invalid', protectedAuth: { version: 1, ciphertext: 'cipher', passwordConfigured: true, username: 'leak' } }]))
    await assert.rejects(connections.list(), /invalid/)
    await assert.rejects(connections.resolveAuth('web'), /invalid/)
    assert.equal((await readFile(file, 'utf8')).includes('leak'), true)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('direct WebShell metadata does not invent environment facts', () => {
  const a = directWebshell('https://example.invalid/#/a', 'linux')
  assert.deepEqual(a, directWebshell('https://example.invalid/#/a', 'linux'))
  assert.notEqual(a.id, directWebshell('https://example.invalid/#/b', 'linux').id)
  assert.deepEqual(a.credentials, {}); assert.deepEqual(a.services, [])
  assert.equal(a.environment, 'unspecified'); assert.equal(a.criticality, 'high')
})
