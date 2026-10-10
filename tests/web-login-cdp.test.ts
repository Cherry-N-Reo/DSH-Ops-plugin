import test from 'node:test'
import assert from 'node:assert/strict'
import { NativeChromiumLoginCdp } from '../src/web-login-cdp.ts'
import type { LoginPageState } from '../src/web-login.ts'

type Listener = (event?: { data: unknown }) => void
class MockSocket {
  readonly sent: Array<Record<string, unknown>> = []
  private readonly listeners = new Map<string, Listener[]>()
  closed = false
  respond = true
  addEventListener(type: string, listener: Listener): void {
    const entries = this.listeners.get(type) ?? []
    entries.push(listener); this.listeners.set(type, entries)
  }
  removeEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter(entry => entry !== listener))
  }
  open(): void { for (const fn of this.listeners.get('open') ?? []) fn() }
  close(): void { this.closed = true; for (const fn of this.listeners.get('close') ?? []) fn() }
  send(text: string): void {
    const request = JSON.parse(text) as { id: number; method: string; params: Record<string, unknown> }
    this.sent.push(request)
    let result: unknown = {}
    if (request.method === 'Runtime.evaluate' && request.params.expression !== 'document') {
      result = { result: { value: {
        url: 'https://shell.example.test/login', terminalReady: false,
        fields: [
          { kind: 'username', selector: 'input[0]', type: 'text', autocomplete: 'username' },
          { kind: 'password', selector: 'input[1]', type: 'password', autocomplete: 'current-password' },
        ], challenge: null, passwordEchoRisk: false,
      } satisfies LoginPageState } }
    } else if (request.method === 'Runtime.evaluate') result = { result: { objectId: 'doc-object' } }
    else if (request.method === 'Runtime.callFunctionOn') result = { result: { value: true } }
    if (!this.respond) return
    queueMicrotask(() => {
      for (const fn of this.listeners.get('message') ?? []) fn({ data: JSON.stringify({ id: request.id, result }) })
    })
  }
}

test('CDP login page returns only metadata and never evaluates or returns entered values', async () => {
  const socket = new MockSocket()
  const connecting = new NativeChromiumLoginCdp({ socket: () => socket as never })
    .connect('ws://127.0.0.1/devtools/page/mock', new AbortController().signal)
  socket.open()
  const page = await connecting
  const state = await page.inspect(new AbortController().signal)
  assert.equal(state.url, 'https://shell.example.test/login')
  assert.equal(state.fields.length, 2)
  await page.fill({ username: 'private-user', password: 'private-password' }, new AbortController().signal)
  await page.submit(new AbortController().signal)

  const fill = socket.sent.find(item => item.method === 'Runtime.callFunctionOn')!
  assert.equal(fill.params && (fill.params as Record<string, unknown>).returnByValue, true)
  assert.match(JSON.stringify(fill.params), /private-user/)
  assert.match(JSON.stringify(fill.params), /private-password/)
  const reads = socket.sent.filter(item => item.method === 'Runtime.evaluate')
  assert.equal(reads.some(item => JSON.stringify(item.params).includes('private-password')), false)
  assert.equal(socket.sent.some(item => !String(item.method).startsWith('Runtime.')), false)
  page.close()
  assert.equal(socket.closed, true)
})

test('fill and submit require a prior page inspection', async () => {
  const socket = new MockSocket()
  const connecting = new NativeChromiumLoginCdp({ socket: () => socket as never })
    .connect('ws://127.0.0.1/devtools/page/mock', new AbortController().signal)
  socket.open()
  const page = await connecting
  await assert.rejects(page.fill({ username: 'u', password: 'p' }, new AbortController().signal), /Inspect the page/)
  await assert.rejects(page.submit(new AbortController().signal), /Inspect the page/)
  assert.equal(socket.sent.length, 1)
  page.close()
})

test('CDP handshake and commands stop on timeout or caller abort', async () => {
  const stalled = new MockSocket()
  await assert.rejects(new NativeChromiumLoginCdp({ socket: () => stalled as never, connectTimeoutMs: 15 })
    .connect('ws://127.0.0.1/devtools/page/stalled', new AbortController().signal), /timed out/)
  assert.equal(stalled.closed, true)

  const socket = new MockSocket()
  const connecting = new NativeChromiumLoginCdp({ socket: () => socket as never, commandTimeoutMs: 15 })
    .connect('ws://127.0.0.1/devtools/page/stalled', new AbortController().signal)
  socket.open()
  const page = await connecting
  socket.respond = false
  await assert.rejects(page.inspect(new AbortController().signal), /timed out/)
  page.close()

  const abortedSocket = new MockSocket(), abort = new AbortController()
  const pending = new NativeChromiumLoginCdp({ socket: () => abortedSocket as never })
    .connect('ws://127.0.0.1/devtools/page/aborted', abort.signal)
  abort.abort()
  await assert.rejects(pending, /aborted/)
  assert.equal(abortedSocket.closed, true)
})
