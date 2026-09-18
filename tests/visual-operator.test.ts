import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Audit, hash } from '../src/audit.ts'
import { Operator, type Identity } from '../src/operator.ts'
import { InputFlow } from '../src/input.ts'
import { directWebshell } from '../src/connections.ts'

async function fixture(writeAudit?: (event: Record<string, unknown>) => Promise<void>) {
  const identity: Identity = { hwnd: '0x123', pid: 12, processName: 'chrome', title: 'terminal', rect: { x: 0, y: 0, width: 800, height: 600 } }
  let shots = 0, enters = 0
  const typed: string[] = [], records: Record<string, unknown>[] = []
  const signal = new AbortController().signal
  const record = async (event: Record<string, unknown>) => { records.push(event); await writeAudit?.(event) }
  const flow = new InputFlow({ observe: async () => {
    const id = `shot-${++shots}`
    await record({ sessionId: 's', phase: 'terminal-evidence', observationId: id, screenshotHash: hash(id) })
    return { id }
  },
    type: async text => { typed.push(text) }, submit: async () => { enters++ },
    audit: record }, 3)
  const operator = new Operator({ identity: async () => identity,
    copy: async () => { throw new Error('No clipboard reading in visual mode') },
    paste: async () => { throw new Error('No clipboard paste in visual mode') }, scroll: async () => {},
  }, { inputFlow: flow, freshnessMs: 1000, maxScreens: 3, outputPolls: 1,
    now: () => 0, audit: record })
  await operator.bind('s', directWebshell('https://example.invalid', 'linux'), identity,
    { x: 10, y: 20, width: 600, height: 400 }, { screenWidth: 800, screenHeight: 600,
      terminalWidth: 600, terminalHeight: 400, lineHeight: 18, zoom: 1, dpi: 96 }, async () => true, signal, false)
  const enterCurrent = async () => {
    const baseline = await flow.observe('s', signal)
    const empty = { observationId: baseline.observation.id, inputText: '', idlePrompt: true,
      confident: true, fullInputVisible: true, candidateVisible: false }
    await flow.check('s', empty, signal)
    const echo = await flow.observe('s', signal)
    await flow.check('s', { ...empty, observationId: echo.observation.id, inputText: typed.at(-1)! }, signal)
  }
  const output = (body: string) => {
    const marker = operator.get('s').lastCommand!
    return `${marker.begin}\n${body}\n${marker.end} rc=0`
  }
  return { operator, flow, signal, typed, records, enterCurrent, output, enters: () => enters }
}

test('visual read-only execution stays pending until exact echo and marker output without clipboard access', async () => {
  const f = await fixture()
  const start = await f.operator.run('s', 'ls', 'read', async () => { throw new Error('No read-only approval') }, f.signal)
  assert.equal(start.complete, false); assert.equal(f.enters(), 0)
  await assert.rejects(f.operator.run('s', 'ls', 'repeat', async () => true, f.signal), /uncertain/)
  await assert.rejects(f.operator.acceptVisualOutput('s', '', f.signal), /pending input/)
  await f.enterCurrent(); assert.equal(f.enters(), 1)
  const result = await f.operator.acceptVisualOutput('s', f.output('one\ntwo'), f.signal)
  assert.equal(result.complete, true); assert.equal(result.output, 'one\ntwo')
  assert.equal(f.operator.get('s').uncertain, false)
})

test('visual preparation, input verification, and marker output persist through the real audit writer', async t => {
  const runtime = join(import.meta.dirname, '../.runtime')
  await mkdir(runtime, { recursive: true })
  const root = await mkdtemp(join(runtime, 'visual-audit-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'audit.jsonl'), writer = Audit(path)
  const f = await fixture(event => writer.record(event))
  const start = await f.operator.run('s', 'ls', 'read', async () => true, f.signal)
  assert.ok('phase' in start)
  assert.equal(start.phase, 'baseline'); assert.equal(f.typed.length, 0)
  await f.enterCurrent()
  const done = await f.operator.acceptVisualOutput('s', f.output('entry'), f.signal)
  assert.equal(done.complete, true); assert.equal(f.enters(), 1)
  await f.operator.run('s', 'rm -- /tmp/example', 'impact and rollback', async () => true, f.signal, true)
  await f.enterCurrent()
  await f.operator.acceptVisualOutput('s', f.output('operator\n/tmp'), f.signal, async () => true)
  await f.enterCurrent()
  await f.operator.acceptVisualOutput('s', f.output('operator\n/tmp'), f.signal)
  await f.enterCurrent()
  await f.operator.acceptVisualOutput('s', f.output(''), f.signal)
  assert.equal(f.enters(), 4)
  const logs = (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
  for (const phase of ['terminal-evidence', 'input-attempt', 'input-verified', 'visual-result', 'critical-environment-probe']) {
    assert.ok(logs.some(row => row.phase === phase), `missing persisted ${phase}`)
  }
  const input = logs.find(row => row.phase === 'input-attempt')
  assert.ok(input)
  assert.equal(input.attempts, 1); assert.equal(input.mode, 'unicode')
  for (let i = 1; i < logs.length; i++) assert.equal(logs[i].previousHash, logs[i - 1].hash)
  assert.ok(logs.every(row => !('command' in row) && !('inputText' in row) && !('output' in row)))
})

test('incomplete visual marker output never unlocks or resubmits the existing command', async () => {
  const f = await fixture(); await f.operator.run('s', 'ls', 'read', async () => true, f.signal)
  await f.enterCurrent()
  const result = await f.operator.acceptVisualOutput('s', 'only a partial page', f.signal)
  assert.equal(result.complete, false); assert.equal(f.operator.get('s').uncertain, true)
  assert.equal(f.enters(), 1)
})

test('staged critical flow preserves independent final approval and post-approval user/cwd probe', async () => {
  const f = await fixture(), phases: string[] = []
  await f.operator.run('s', 'rm -- /tmp/example', 'impact and rollback', async phase => { phases.push(phase); return true }, f.signal, true)
  await f.enterCurrent(); assert.ok(f.typed[0].includes('id -un; pwd'))
  const afterFinal = await f.operator.acceptVisualOutput('s', f.output('operator\n/tmp'), f.signal, async (phase, details) => {
    phases.push(phase); const value = JSON.parse(details)
    assert.equal(value.currentUser, 'operator'); assert.equal(value.cwd, '/tmp')
    assert.match(value.command, /rm/); return true
  })
  assert.equal(afterFinal.complete, false); await f.enterCurrent()
  const command = await f.operator.acceptVisualOutput('s', f.output('operator\n/tmp'), f.signal)
  assert.equal(command.complete, false); assert.equal(f.typed.some(text => text.includes("'rm'")), false)
  await f.enterCurrent(); assert.ok(f.typed[2].includes("'rm'"))
  assert.deepEqual(phases, ['intent', 'final-command']); assert.equal(f.enters(), 3)
  const done = await f.operator.acceptVisualOutput('s', f.output(''), f.signal)
  assert.equal(done.complete, true); assert.equal(f.operator.get('s').critical, undefined)
})

test('staged critical final denial never injects the critical command', async () => {
  const f = await fixture()
  await f.operator.run('s', 'rm -- /tmp/example', 'impact', async () => true, f.signal, true)
  await f.enterCurrent()
  await assert.rejects(f.operator.acceptVisualOutput('s', f.output('operator\n/tmp'), f.signal, async () => false), /APPROVAL_REJECTED/)
  assert.equal(f.typed.length, 1); assert.equal(f.operator.get('s').uncertain, true)
})

test('staged critical environment change or invalid reading blocks destructive input', async () => {
  for (const environment of ['operator\n/different', 'no trustworthy environment']) {
    const f = await fixture()
    await f.operator.run('s', 'rm -- /tmp/example', 'impact', async () => true, f.signal, true)
    await f.enterCurrent()
    await f.operator.acceptVisualOutput('s', f.output('operator\n/tmp'), f.signal, async () => true)
    await f.enterCurrent()
    await assert.rejects(f.operator.acceptVisualOutput('s', f.output(environment), f.signal), /CRITICAL_ENVIRONMENT_(CHANGED|UNCERTAIN)/)
    assert.equal(f.typed.length, 2); assert.equal(f.operator.get('s').uncertain, true)
  }
})
