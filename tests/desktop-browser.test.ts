import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { DesktopBrowserDriver } from '../src/desktop-browser.ts'
import type { BrowserTransport } from '../src/desktop-transport.ts'

const signal = new AbortController().signal
const rect = { x: 0, y: 0, width: 800, height: 600 }

function fixture(vue: boolean) {
  const calls: Record<string, unknown>[] = []
  const inputs: string[] = []
  class DataTransfer { value = ''; setData(_type: string, value: string) { this.value = value } }
  class Event {
    constructor(readonly type: string, readonly options: { clipboardData?: DataTransfer }) {}
  }
  const textarea = { focus() { document.activeElement = textarea }, matches: () => true,
    dispatchEvent(event: Event) { if (event.type === 'paste') inputs.push(event.options.clipboardData!.value); if (event.type === 'keydown') inputs.push('\r'); return true } }
  const document = {
    activeElement: null as typeof textarea | null,
    querySelector: () => vue ? { __vue__: { term: { current: { input: (text: string) => inputs.push(text) } } } } : null,
    querySelectorAll: () => vue ? [] : [textarea],
  }
  let disposed = false
  const transport: BrowserTransport = {
    async request(request) {
      calls.push(request)
      if (request.action === 'attach') return { target: `tab-${request.session}`, title: 'Shell', url: 'https://example.com/shell' }
      if (request.action === 'evaluate') return vm.runInNewContext(String(request.script), { document, DataTransfer, ClipboardEvent: Event, KeyboardEvent: Event, innerWidth: 800, innerHeight: 600 })
      if (request.action === 'streams') return ['BEGIN\nhello\nEND rc=0\n']
      if (request.action === 'frames') return [{ id: 'one-frame' }]
      return true
    },
    dispose() { disposed = true },
  }
  const driver = new DesktopBrowserDriver({ targetUrl: 'https://example.com/shell', runtimeDir: '', timeoutMs: 1000, maxChars: 4096 }, transport)
  driver.useSession('one')
  return { driver, calls, inputs, disposed: () => disposed }
}

test('Vue terminal receives one Unicode line and one carriage return without OS focus', async () => {
  const { driver, calls, inputs, disposed } = fixture(true)
  try {
    await driver.typeCommand(rect, 'ls # 中文', 'unicode', signal)
    await driver.submitCommand(signal)
    assert.deepEqual(inputs, ['ls # 中文', '\r'])
    assert.equal(calls.some(call => call.action === 'input' || call.action === 'enter'), false)
    assert.equal((await driver.identity(signal)).processName, 'dsh-desktop-browser')
  } finally { await driver.dispose() }
  assert.equal(disposed(), true)
  assert.equal(calls.filter(call => call.action === 'release').length, 1)
})

test('generic xterm uses guest-local Unicode and Enter, never replaying an input', async () => {
  const { driver, calls, inputs } = fixture(false)
  try {
    await driver.paste(rect, 'printf hello', true, signal)
    assert.deepEqual(inputs, ['printf hello', '\r'])
    assert.equal(calls.some(call => call.action === 'input' || call.action === 'enter'), false)
    await assert.rejects(driver.submitCommand(signal), /pending/)
  } finally { await driver.dispose() }
})

test('Session switching obtains separate tab handles and releases both without closing tabs', async () => {
  const { driver, calls } = fixture(true)
  try {
    assert.equal((await driver.identity(signal)).hwnd, 'tab-one')
    driver.useSession('two')
    assert.equal((await driver.identity(signal)).hwnd, 'tab-two')
    driver.useSession('one')
    assert.equal((await driver.identity(signal)).hwnd, 'tab-one')
    assert.equal(calls.filter(call => call.action === 'attach').length, 2)
  } finally { await driver.dispose() }
  assert.equal(calls.filter(call => call.action === 'release').length, 2)
})

test('an expired guest is reacquired only on a later observation, never by replaying the failed action', async () => {
  const calls: string[] = []
  let expired = false
  const transport: BrowserTransport = {
    async request(request) {
      calls.push(String(request.action))
      if (request.action === 'attach') return { target: 'tab', title: 'Shell', url: 'https://example.com/shell' }
      if (request.action === 'evaluate') {
        if (!expired) { expired = true; throw new Error('BROWSER_HANDLE_EXPIRED') }
        return { width: 800, height: 600 }
      }
      return null
    },
    dispose() {},
  }
  const driver = new DesktopBrowserDriver({ targetUrl: 'https://example.com/shell', runtimeDir: '', timeoutMs: 1000, maxChars: 4096 }, transport)
  driver.useSession('one')
  try {
    await assert.rejects(driver.identity(signal), /BROWSER_HANDLE_EXPIRED/)
    assert.deepEqual(calls, ['attach', 'evaluate'])
    await driver.identity(signal)
    assert.deepEqual(calls, ['attach', 'evaluate', 'attach', 'evaluate'])
  } finally { await driver.dispose() }
})

test('printable input excludes multiline and control characters before any IPC', async () => {
  const { driver, calls } = fixture(true)
  try {
    await assert.rejects(driver.typeCommand(rect, 'ls\nreboot', 'unicode', signal), /printable/)
    assert.equal(calls.length, 0)
  } finally { await driver.dispose() }
})
