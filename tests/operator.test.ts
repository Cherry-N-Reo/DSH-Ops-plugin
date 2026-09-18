import test from 'node:test'
import assert from 'node:assert/strict'
import { Operator, exclusive, type Identity } from '../src/operator.ts'
import { directWebshell } from '../src/connections.ts'

const identity: Identity = { hwnd: '0x123', pid: 12, processName: 'chrome', title: 'Safe terminal', rect: { x: 0, y: 0, width: 800, height: 600 } }
const asset = { id: 'sample', environment: 'staging', criticality: 'high', profile: 'posix', services: ['nginx'], runbooks: [], credentials: {} }
const viewport = { screenWidth: 800, screenHeight: 600, terminalWidth: 700, terminalHeight: 400, lineHeight: 18, zoom: 100, dpi: 96 }
function fixture() {
  let current = structuredClone(identity), now = 1000, text = '', submitted = 0
  const records: Record<string, unknown>[] = []
  const desktop = {
    identity: async () => structuredClone(current),
    copy: async () => text,
    paste: async (_rect: unknown, command: string) => {
      submitted++
      const begin = command.match(/__DSH_BEGIN_[A-Za-z0-9_.-]+__/g)?.[0]
      const end = command.match(/__DSH_END_[A-Za-z0-9_.-]+__/g)?.[0]
      text = `${begin}\n${command.includes('id -un; pwd') ? 'operator\n/tmp' : 'safe output'}\n${end} rc=0\n$ `
    },
    scroll: async () => { throw new Error('Single-screen must not scroll') },
  }
  const op = new Operator(desktop, { freshnessMs: 1000, maxScreens: 3, outputPolls: 2,
    now: () => now, audit: async record => { records.push(record) } })
  return { op, signal: new AbortController().signal, setIdentity: (v: Identity) => { current = v },
    expire: () => { now += 2000 }, submitted: () => submitted, records,
    failPaste: () => { desktop.paste = async () => { submitted++; throw new Error('Unknown remote outcome') } } }
}
async function bound() {
  const f = fixture()
  await f.op.bind('session', asset, identity, { x: 0, y: 0, width: 700, height: 400 }, viewport, async () => true, f.signal)
  return f
}
test('direct WebShell binding and read-only execution do not load inventory', async () => {
  const f = fixture()
  f.op.options.assetCurrent = async () => { throw new Error('Inventory must not be required') }
  const binding = await f.op.bind('session', directWebshell('https://example.invalid', 'linux'), identity,
    { x: 0, y: 0, width: 700, height: 400 }, viewport, async () => true, f.signal, false)
  assert.equal(binding.inventoryTracked, false)
  const result = await f.op.run('session', 'kubectl get nodes -o wide', 'inspect nodes', async () => { throw new Error('unexpected read-only approval') }, f.signal)
  assert.equal(result.complete, true); assert.equal(f.submitted(), 1)
})
test('single-screen read command is complete, audited, and has no approval', async () => {
  const f = await bound()
  const result = await f.op.run('session', 'pwd', 'inspect', async () => { throw new Error('unexpected approval') }, f.signal)
  assert.equal(result.complete, true); assert.equal(f.submitted(), 1)
  assert.equal(f.records.at(-1)?.phase, 'result')
})
test('freshness refocuses the bound window but still rejects a changed identity', async () => {
  const signal = new AbortController().signal
  let current = { ...identity, title: 'DSH approval tab' }, focuses = 0, requested: Identity | undefined
  const desktop = {
    identity: async () => current,
    focusTarget: async (_signal: AbortSignal, expected?: Identity) => { focuses++; requested = expected; current = identity; return current },
    copy: async () => '', paste: async () => {}, scroll: async () => {},
  }
  const op = new Operator(desktop, { freshnessMs: 1000, maxScreens: 1, outputPolls: 1, now: () => 0, audit: async () => {} })
  const binding = await op.bind('session', asset, identity, { x: 0, y: 0, width: 700, height: 400 }, viewport,
    async () => { current = identity; return true }, signal)
  current = { ...identity, title: 'DSH approval tab' }
  await op.fresh(binding, signal)
  assert.equal(focuses, 1); assert.deepEqual(requested, identity)
  desktop.focusTarget = async () => { current = { ...identity, pid: 999 }; return current }
  await assert.rejects(op.fresh(binding, signal), /identity or geometry changed/)
})
test('R4 cannot enter normal execution even with an always-allow approval', async () => {
  const f = await bound()
  await assert.rejects(f.op.run('session', 'rm -- /tmp/example', 'delete', async () => true, f.signal), /R4/)
  assert.equal(f.submitted(), 0)
})
test('R4 requires both independent approvals and actual environment binding', async () => {
  const f = await bound(), phases: string[] = []
  const result = await f.op.run('session', 'rm -- /tmp/example', 'impact=cache,rollback=none', async (phase, details) => {
    phases.push(phase)
    if (phase === 'final-command') { const parsed = JSON.parse(details); assert.equal(parsed.currentUser, 'operator'); assert.equal(parsed.cwd, '/tmp'); assert.equal(parsed.commandHash.length, 64) }
    return true
  }, f.signal, true)
  assert.deepEqual(phases, ['intent', 'final-command']); assert.equal(result.complete, true)
  assert.equal(f.submitted(), 3)
})
test('intent rejection and final rejection never submit destructive command', async () => {
  const a = await bound()
  await assert.rejects(a.op.run('session', 'rm -- /tmp/example', 'intent', async () => false, a.signal, true))
  assert.equal(a.submitted(), 0)
  const b = await bound()
  await assert.rejects(b.op.run('session', 'rm -- /tmp/example', 'intent', async phase => phase === 'intent', b.signal, true))
  assert.equal(b.submitted(), 1)
})
test('browser changes during approval and expired observations block paste', async () => {
  const f = await bound()
  await assert.rejects(f.op.run('session', 'systemctl restart nginx', 'repair', async () => {
    f.setIdentity({ ...identity, title: 'Different tab' }); return true
  }, f.signal))
  assert.equal(f.submitted(), 0)
  const expired = await bound(); expired.expire()
  await assert.rejects(expired.op.run('session', 'pwd', 'inspect', async () => true, expired.signal), /expired/)
  assert.equal(expired.submitted(), 0)
})
test('uncertain paste cannot be retried automatically', async () => {
  const f = await bound(); f.failPaste()
  await assert.rejects(f.op.run('session', 'pwd', 'inspect', async () => true, f.signal))
  await assert.rejects(f.op.run('session', 'pwd', 'inspect', async () => true, f.signal), /uncertain/)
  assert.equal(f.submitted(), 1)
})
test('desktop transaction lock serializes independent sessions', async () => {
  const signal = new AbortController().signal, order: string[] = []
  let release!: () => void
  const barrier = new Promise<void>(resolve => { release = resolve })
  const first = exclusive(signal, async () => { order.push('first'); await barrier; order.push('first-end') })
  const second = exclusive(signal, async () => { order.push('second') })
  await Promise.resolve(); await Promise.resolve(); assert.deepEqual(order, ['first'])
  release(); await Promise.all([first, second]); assert.deepEqual(order, ['first', 'first-end', 'second'])
})
test('changing remote cwd after final approval invalidates the destructive command', async () => {
  const f = await bound()
  const originalCopy = f.op.desktop.copy.bind(f.op.desktop)
  let finalApproved = false
  f.op.desktop.copy = async (rect, signal) => {
    const value = await originalCopy(rect, signal)
    return finalApproved ? value.replace('/tmp', '/different-target') : value
  }
  await assert.rejects(f.op.run('session', 'rm -- /tmp/example', 'delete', async phase => {
    if (phase === 'final-command') finalApproved = true
    return true
  }, f.signal, true), /changed after final approval/)
  assert.equal(f.submitted(), 2)
})
test('audit failure before paste locks the attempt without submitting any command', async () => {
  const f = await bound()
  f.op.options.audit = async record => { if (record.phase === 'attempt') throw new Error('audit unavailable') }
  await assert.rejects(f.op.run('session', 'pwd', 'inspect', async () => true, f.signal), /audit unavailable/)
  assert.equal(f.submitted(), 0)
  await assert.rejects(f.op.run('session', 'pwd', 'inspect', async () => true, f.signal), /uncertain/)
})
test('protected credential state blocks collection before clipboard access', async () => {
  const f = await bound()
  f.op.bindings.get('session')!.secretPending = true
  await assert.rejects(f.op.collectPending('session', f.signal), /Credential was pasted/)
  assert.equal(f.submitted(), 0)
})
