import test from 'node:test'
import assert from 'node:assert/strict'
import { Operator, type Identity } from '../src/operator.ts'
import { directWebshell } from '../src/connections.ts'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Audit } from '../src/audit.ts'
import type { TextOutput } from '../src/browser-output.ts'

const identity: Identity = { hwnd: '1', pid: 1, processName: 'chrome', title: 'Terminal',
  rect: { x: 0, y: 0, width: 800, height: 600 } }
const rect = { x: 10, y: 10, width: 700, height: 400 }
const viewport = { screenWidth: 800, screenHeight: 600, terminalWidth: 700,
  terminalHeight: 400, lineHeight: 18, zoom: 100, dpi: 96 }

function fixture(fail?: 'type' | 'submit', options: {
  audit?: (event: Record<string, unknown>) => Promise<void>; textOutput?: TextOutput
} = {}) {
  const events: string[] = []
  const desktop = {
    identity: async () => identity,
    focusTarget: async () => identity,
    copy: async () => '', paste: async () => {}, scroll: async () => {},
    typeCommand: async (_rect: typeof rect, text: string) => {
      events.push(`type:${text}`)
      if (fail === 'type') throw new Error('partial input possible')
    },
    submitCommand: async () => {
      events.push('enter')
      if (fail === 'submit') throw new Error('remote outcome unknown')
    },
  }
  const operator = new Operator(desktop, { freshnessMs: 60_000, maxScreens: 1,
    outputPolls: 1, audit: options.audit ?? (async () => {}), textOutput: options.textOutput })
  const signal = new AbortController().signal
  const bind = () => operator.bind('session', directWebshell('https://example.invalid/shell', 'linux'),
    identity, rect, viewport, async () => true, signal, false)
  const send = (command: string, marked = false) => operator.sendDirect('session', command,
    'inspect', async () => true, signal, marked)
  return { operator, events, bind, send }
}

test('marked send persists submission and collects WebSocket completion with the real audit writer', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-direct-audit-'))
  t.after(() => rm(directory, {recursive:true,force:true}))
  const path = join(directory,'audit.jsonl'), audit = Audit(path)
  const textOutput: TextOutput = {
    async arm() { return true },
    async read(_session, marker) {
      return {available:true,complete:true,source:'websocket',attempts:1,
        text:marker.begin + '\nexample.txt\n' + marker.end + ' rc=0\n'}
    },
    async clear() {}, async dispose() {},
  }
  const f = fixture(undefined,{audit:event => audit.record(event),textOutput})
  await f.bind()
  const sent = await f.send('ls',true)
  assert.equal(sent.submitted,true)
  const reading = await f.operator.collectText('session',new AbortController().signal)
  assert.equal(reading?.complete,true)
  assert.equal(reading?.exitCode,0)
  assert.equal(reading?.source,'websocket')
  assert.equal(reading?.output,'example.txt')
  assert.equal(f.operator.get('session').uncertain,false)
  assert.equal(f.events.filter(event => event === 'enter').length,1)
  const rows = (await readFile(path,'utf8')).trim().split('\n').map(line => JSON.parse(line) as Record<string,unknown>)
  assert.deepEqual(rows.map(row => row.phase),['bind','classified','attempt','submitted','text-result'])
  for (let index=1; index<rows.length; index++) assert.equal(rows[index].previousHash,rows[index-1].hash)
  assert.equal((await readFile(path,'utf8')).includes('example.txt'),false)
})

test('ordinary direct send types Unicode once then submits once', async () => {
  const f = fixture()
  await f.bind()
  const result = await f.send('ls', true)
  assert.equal(result.submitted, true)
  assert.equal(f.events.length, 2)
  assert.match(f.events[0], /^type:printf /)
  assert.equal(f.events[1], 'enter')
})

test('interactive writes can be consecutive before a read', async () => {
  const f = fixture()
  await f.bind()
  await f.send('pwd')
  await f.send('ls')
  assert.deepEqual(f.events, ["type:'pwd'", 'enter', "type:'ls'", 'enter'])
})

for (const failure of ['type', 'submit'] as const) {
  test(`${failure} failure locks the binding without resubmission`, async () => {
    const f = fixture(failure)
    await f.bind()
    await assert.rejects(f.send('pwd'))
    const count = f.events.length
    await assert.rejects(f.send('pwd'), /uncertain/)
    assert.equal(f.events.length, count)
  })
}

test('R4 cannot use direct write', async () => {
  const f = fixture()
  await f.bind()
  await assert.rejects(f.send('rm -- /tmp/example'), /R4/)
  assert.deepEqual(f.events, [])
})
