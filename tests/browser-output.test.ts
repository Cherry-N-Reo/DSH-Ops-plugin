import test from 'node:test'
import assert from 'node:assert/strict'
import { BrowserTextOutput, decodeTerminalFrame, normalizeTerminalText } from '../src/browser-output.ts'

type Listener = (() => void) | ((event: { data: unknown }) => void)

class FakeSocket {
  readonly readyState = 1
  readonly listeners = new Map<string, Listener[]>()
  closed = false
  stallMethod?: string
  currentUrl = 'https://console.example.invalid/shell?server=one#terminal'
  snapshot: Array<{ source: 'xterm-buffer' | 'dom'; text: string }> = []

  addEventListener(type: string, listener: Listener): void {
    const values = this.listeners.get(type) ?? []
    values.push(listener); this.listeners.set(type, values)
  }
  send(data: string): void {
    const request = JSON.parse(data) as { id: number; method: string; sessionId?: string; params?: { expression?: string } }
    if (request.method === this.stallMethod) return
    const result = request.method === 'Runtime.evaluate'
      ? { result: { value: request.params?.expression === 'location.href'
        ? this.currentUrl : this.snapshot } }
      : {}
    queueMicrotask(() => this.emit('message', { data: JSON.stringify({ id: request.id, result,
      ...(request.sessionId ? { sessionId: request.sessionId } : {}) }) }))
  }
  close(): void { this.closed = true; this.emit('close') }
  emit(type: string, event?: { data: unknown }): void {
    for (const listener of this.listeners.get(type) ?? []) {
      if (event) (listener as (value: { data: unknown }) => void)(event)
      else (listener as () => void)()
    }
  }
  frame(requestId: string, payloadData: string, opcode = 1, sessionId?: string): void {
    this.emit('message', { data: JSON.stringify({ method: 'Network.webSocketFrameReceived',
      ...(sessionId ? { sessionId } : {}), params: { requestId, response: { opcode, payloadData } } }) })
  }
}

function fixture(maxAttempts = 3) {
  const sockets: FakeSocket[] = []
  const targetUrl = 'https://console.example.invalid/shell?server=one#terminal'
  const output = new BrowserTextOutput({ endpoint: 'http://127.0.0.1:9222', targetUrl,
    timeoutMs: 1000, maxChars: 4096, maxAttempts, pollMs: 0,
    fetch: async () => new Response(JSON.stringify([{ type: 'page', url: targetUrl,
      webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/page/secret-target' }]), { status: 200 }),
    socket: () => {
      const socket = new FakeSocket(); sockets.push(socket)
      queueMicrotask(() => socket.emit('open'))
      return socket
    },
  })
  return { output, sockets, marker: { begin: '__DSH_BEGIN_x__', end: '__DSH_END_x__' },
    signal: new AbortController().signal }
}

test('decodes raw, JSON, base64, and ANSI terminal frames', () => {
  assert.equal(normalizeTerminalText('\u001b[32mok\u001b[0m\r\n'), 'ok\n')
  assert.equal(decodeTerminalFrame(1, JSON.stringify({ o: 'data', data: '\u001b[31mhello\u001b[0m' })), 'hello')
  assert.equal(decodeTerminalFrame(2, Buffer.from('world').toString('base64')), 'world')
  assert.equal(decodeTerminalFrame(8, 'ignored'), '')
})

test('collects split marker output from exactly one WebSocket stream', async t => {
  const f = fixture(); t.after(() => f.output.dispose())
  assert.equal(await f.output.arm('s', f.marker, f.signal), true)
  const socket = f.sockets[0]
  socket.frame('terminal', `${f.marker.begin}\r\none\r\n`)
  socket.frame('terminal', `two\r\n${f.marker.end} rc=0\r\n`)
  const reading = await f.output.read('s', f.marker, f.signal)
  assert.equal(reading.complete, true); assert.equal(reading.source, 'websocket')
  assert.match(reading.text, /one\ntwo/)
})

test('navigation away from the exact target discards queued WebSocket output', async t => {
  const f = fixture(1); t.after(() => f.output.dispose())
  assert.equal(await f.output.arm('s', f.marker, f.signal), true)
  f.sockets[0].frame('terminal', `${f.marker.begin}\nold\n${f.marker.end} rc=0`)
  f.sockets[0].currentUrl = 'https://console.example.invalid/other'
  const reading = await f.output.read('s', f.marker, f.signal)
  assert.equal(reading.available, false)
  assert.equal(reading.complete, false)
  assert.equal(f.sockets[0].closed, true)
})

test('uses xterm/DOM snapshots and falls back after bounded incomplete reads', async t => {
  const f = fixture(3); t.after(() => f.output.dispose())
  await f.output.arm('s', f.marker, f.signal)
  f.sockets[0].snapshot = [{ source: 'xterm-buffer',
    text: `${f.marker.begin}\nentry\n${f.marker.end} rc=0` }]
  const complete = await f.output.read('s', f.marker, f.signal)
  assert.equal(complete.complete, true); assert.equal(complete.source, 'xterm-buffer')

  await f.output.arm('pending', f.marker, f.signal)
  f.sockets[1].snapshot = [{ source: 'dom', text: f.marker.begin }]
  const pending = await f.output.read('pending', f.marker, f.signal)
  assert.equal(pending.available, false); assert.equal(pending.attempts, 3)
})

test('requires one exact matching page and closes replaced captures', async () => {
  const f = fixture()
  assert.equal(await f.output.arm('s', f.marker, f.signal), true)
  const first = f.sockets[0]
  assert.equal(await f.output.arm('s', f.marker, f.signal), true)
  assert.equal(first.closed, true)
  await f.output.dispose(); assert.equal(f.sockets[1].closed, true)
})

test('a stalled DevTools enable request ends at its deadline and closes the socket', async () => {
  const targetUrl = 'https://console.example.invalid/shell'
  const socket = new FakeSocket()
  socket.stallMethod = 'Network.enable'
  const output = new BrowserTextOutput({ endpoint: 'http://127.0.0.1:9222', targetUrl,
    timeoutMs: 30, maxChars: 4096, maxAttempts: 1, pollMs: 0,
    fetch: async () => new Response(JSON.stringify([{ type: 'page', url: targetUrl,
      webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/page/target' }]), { status: 200 }),
    socket: () => { queueMicrotask(() => socket.emit('open')); return socket },
  })
  let guard: ReturnType<typeof setTimeout> | undefined
  try {
    const bounded = Promise.race([
      output.arm('s', { begin: 'begin', end: 'end' }, new AbortController().signal),
      new Promise<never>((_resolve, reject) => { guard = setTimeout(() => reject(new Error('DevTools deadline did not settle')), 1000) }),
    ])
    assert.equal(await bounded, false)
  } finally { if (guard) clearTimeout(guard) }
  assert.equal(socket.closed, true)
})

test('a stalled terminal snapshot yields screenshot fallback without resubmission', async () => {
  const f = fixture(1)
  f.output.options.timeoutMs = 30
  try {
    assert.equal(await f.output.arm('s', f.marker, f.signal), true)
    f.sockets[0].stallMethod = 'Runtime.evaluate'
    let guard: ReturnType<typeof setTimeout> | undefined
    try {
      const bounded = Promise.race([
        f.output.read('s', f.marker, f.signal),
        new Promise<never>((_resolve, reject) => { guard = setTimeout(() => reject(new Error('Snapshot deadline did not settle')), 1000) }),
      ])
      const reading = await bounded
      assert.equal(reading.available, false)
      assert.equal(reading.complete, false)
    } finally { if (guard) clearTimeout(guard) }
  } finally { await f.output.dispose() }
})

test('ambiguous duplicate target tabs disable text capture without opening a socket', async () => {
  const targetUrl = 'https://console.example.invalid/shell'
  let sockets = 0
  const output = new BrowserTextOutput({ endpoint: 'http://127.0.0.1:9222', targetUrl,
    timeoutMs: 1000, maxChars: 4096, maxAttempts: 1, pollMs: 0,
    fetch: async () => new Response(JSON.stringify([
      { type: 'page', url: targetUrl, webSocketDebuggerUrl: 'ws://127.0.0.1/one' },
      { type: 'page', url: targetUrl, webSocketDebuggerUrl: 'ws://127.0.0.1/two' },
    ]), { status: 200 }),
    socket: () => { sockets++; return new FakeSocket() },
  })
  assert.equal(await output.arm('s', { begin: 'begin', end: 'end' }, new AbortController().signal), false)
  assert.equal(sockets, 0)
})

test('rejects a non-loopback debugger WebSocket returned by discovery', async () => {
  const targetUrl = 'https://console.example.invalid/shell'
  let sockets = 0
  const output = new BrowserTextOutput({ endpoint: 'http://127.0.0.1:9222', targetUrl,
    timeoutMs: 1000, maxChars: 4096, maxAttempts: 1, pollMs: 0,
    fetch: async () => new Response(JSON.stringify([{ type: 'page', url: targetUrl,
      webSocketDebuggerUrl: 'ws://attacker.example.invalid/devtools/page/token' }]), { status: 200 }),
    socket: () => { sockets++; return new FakeSocket() },
  })
  assert.equal(await output.arm('s', { begin: 'begin', end: 'end' }, new AbortController().signal), false)
  assert.equal(sockets, 0)
})
