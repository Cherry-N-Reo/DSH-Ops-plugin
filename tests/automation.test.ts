import test from 'node:test'
import assert from 'node:assert/strict'
import { approveScreenshot } from '../src/automation.ts'
import { SreError, bridgeError } from '../src/errors.ts'
import { WindowsDriver } from '../src/windows.ts'

const targetUrl = 'http://example.invalid/#/shell?serverIp=10.0.0.1&type=server'
const identity = { hwnd: '0x123', pid: 12, processName: 'chrome', title: 'WebShell', rect: { x: 0, y: 0, width: 800, height: 600 } }
const options = { runtimeDir: '.unused-runtime', timeoutMs: 1000, settleMs: 0, browserProcesses: ['chrome'], targetUrl }

test('automatic image authorization records opt-in without asking human approval', async () => {
  let recorded = 0
  await approveScreenshot({ autoScreenshot: true, targetUrl }, async () => { throw new Error('No image prompt allowed') }, async () => { recorded++ })
  assert.equal(recorded, 1)
  await assert.rejects(approveScreenshot({ autoScreenshot: true, targetUrl: '' }, async () => true, async () => {}), /TARGET_REQUIRED/)
  await assert.rejects(approveScreenshot({ autoScreenshot: true, targetUrl }, async () => true, async () => { throw new Error('audit offline') }), /audit offline/)
})

test('default image approval remains explicit and fail-closed', async () => {
  let asked = 0
  await approveScreenshot({ autoScreenshot: false, targetUrl: '' }, async () => { asked++; return true }, async () => { throw new Error('Not an automatic grant') })
  assert.equal(asked, 1)
  await assert.rejects(approveScreenshot({ autoScreenshot: false, targetUrl }, async () => false, async () => {}), /APPROVAL_REJECTED/)
})

test('desktop driver forwards exact target and confines refocus to the bound browser', async () => {
  const calls: Record<string, unknown>[] = []
  const driver = new WindowsDriver(options, async payload => { calls.push(payload); return { ok: true, ...identity } })
  try {
    assert.deepEqual(await driver.focusTarget(new AbortController().signal, identity), identity)
    assert.equal(calls[0]?.action, 'focus-target')
    assert.equal(calls[0]?.targetUrl, targetUrl)
    assert.deepEqual(calls[0]?.expected, identity)
    await driver.identity(new AbortController().signal)
    assert.equal(calls[1]?.targetUrl, targetUrl)
  } finally { await driver.dispose() }
})

test('target mismatch or cancellation prevents input and releases driver resources', async () => {
  let calls = 0
  const driver = new WindowsDriver(options, async () => { calls++; throw new SreError('TARGET_MISMATCH') })
  try {
    await assert.rejects(driver.paste({ x: 0, y: 0, width: 100, height: 100 }, 'pwd', true, new AbortController().signal), /TARGET_MISMATCH/)
    assert.equal(calls, 1)
    const aborted = new AbortController(); aborted.abort()
    await assert.rejects(driver.focusTarget(aborted.signal), error => (error as Error).name === 'AbortError')
    assert.equal(calls, 1)
  } finally { await driver.dispose() }
  assert.equal(bridgeError('secret provider payload'), undefined)
  assert.match(bridgeError('TARGET_NOT_FOUND')!.message, /^TARGET_NOT_FOUND:/)
})

test('automatic switching is unavailable without an operator target', async () => {
  const driver = new WindowsDriver({ ...options, targetUrl: undefined }, async () => { throw new Error('No helper allowed') })
  try { await assert.rejects(driver.focusTarget(new AbortController().signal), /TARGET_REQUIRED/) }
  finally { await driver.dispose() }
})
