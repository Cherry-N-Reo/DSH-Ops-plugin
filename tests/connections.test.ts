import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Connections, directWebshell } from '../src/connections.ts'

test('connection bookmarks are optional and contain both WebShell and SSH metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-connections-'))
  try {
    const file = join(root, 'connections.json'), connections = new Connections(file, 4096)
    assert.deepEqual(await connections.list(), [])
    const records = [{ id: 'web', type: 'webshell', url: 'https://example.invalid/#/shell' },
      { id: 'ssh', type: 'ssh', host: '10.0.0.1', port: 22, username: 'operator', credentialRef: 'STAGING_SSH' }]
    await writeFile(file, JSON.stringify(records))
    assert.deepEqual(await connections.list(), records)
    assert.equal(directWebshell(records[0]!.url!, 'linux').profile, 'linux')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('connection parser rejects malformed records and invalid authentication fields without leaking values', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-connections-'))
  try {
    const file = join(root, 'connections.json'), connections = new Connections(file, 4096)
    for (const records of [
      [{ id: 's', type: 'ssh', host: 'host', username: 'user', password: 'secret', credentialRef: 'SSH_REF' }],
      [{ id: 's', type: 'ssh', host: 'host', username: 'user', port: 0 }],
      [{ id: 'w', type: 'webshell', url: 'https://user:secret@example.invalid' }],
      [{ id: 'w', type: 'webshell', url: 'https://example.invalid' }, { id: 'w', type: 'webshell', url: 'https://example.invalid' }],
      { connections: [] },
    ]) {
      await writeFile(file, JSON.stringify(records))
      await assert.rejects(connections.list())
    }
    await writeFile(file, '[')
    await assert.rejects(connections.list(), /Connections JSON is malformed/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('WebShell and SSH names, usernames and notes are editable while passwords stay local', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-connections-'))
  try {
    const file = join(root, 'connections.json'), connections = new Connections(file, 4096)
    const records = [
      { id: 'web', type: 'webshell', url: 'https://example.invalid', name: '集群控制台', username: 'admin@example.invalid', password: 'test-only-web-password', notes: '需要 VPN 和公司内网' },
      { id: 'ssh', type: 'ssh', host: '10.0.0.1', username: 'operator', password: 'test-only-ssh-password', name: '节点一', notes: '仅内网可连接' },
    ]
    await writeFile(file, JSON.stringify(records))
    const visible = await connections.list()
    assert.equal(visible[0]!.name, '集群控制台'); assert.equal(visible[0]!.username, 'admin@example.invalid')
    assert.equal(visible[1]!.notes, '仅内网可连接')
    assert.ok(visible.every(row => row.passwordConfigured === true && !('password' in row)))
    assert.equal(JSON.stringify(visible).includes('test-only-'), false)
    records[0]!.name = '新的服务器名称'
    await writeFile(file, JSON.stringify(records))
    assert.equal((await connections.list())[0]!.name, '新的服务器名称')
    await writeFile(file, '[{"password":"test-only-secret-context", BAD JSON]')
    await assert.rejects(connections.list(), error => !String(error).includes('test-only-secret-context'))
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('direct WebShell metadata requires no registration or invented environment facts', () => {
  const a = directWebshell('https://example.invalid/#/a', 'linux')
  assert.deepEqual(a, directWebshell('https://example.invalid/#/a', 'linux'))
  assert.notEqual(a.id, directWebshell('https://example.invalid/#/b', 'linux').id)
  assert.deepEqual(a.credentials, {}); assert.deepEqual(a.services, [])
  assert.equal(a.environment, 'unspecified'); assert.equal(a.criticality, 'high')
})
