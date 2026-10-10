import test from 'node:test'
import assert from 'node:assert/strict'
import { WebLoginController, type LoginPage, type LoginPageState } from '../src/web-login.ts'

const targetUrl = 'https://shell.example.test/login'
const state = (patch: Partial<LoginPageState> = {}): LoginPageState => ({
  url: targetUrl, terminalReady: false,
  fields: [
    { kind: 'username', selector: 'input[autocomplete=username]', type: 'text', autocomplete: 'username' },
    { kind: 'password', selector: 'input[type=password]', type: 'password', autocomplete: 'current-password' },
  ], challenge: null, passwordEchoRisk: false, ...patch,
})

function fixture(states: LoginPageState[], targets: unknown[] = [{ type: 'page', url: targetUrl,
  webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/1' }]) {
  let credentialCalls = 0, submitted = 0, filled: { username: string; password: string } | undefined
  let closed = 0, inspected = 0
  const page: LoginPage = {
    inspect: async () => states[Math.min(inspected++, states.length - 1)]!,
    fill: async value => { filled = value }, submit: async () => { submitted++ }, close: () => { closed++ },
  }
  const controller = new WebLoginController({ endpoint: 'http://127.0.0.1:9222',
    fetch: async () => ({ ok: true, json: async () => targets }) as Response,
    credentials: async () => { credentialCalls++; return { username: 'operator', password: 'secret-value' } },
    cdp: { connect: async () => page }, maxObservations: 3, pollIntervalMs: 100 })
  return { controller, page, calls: () => ({ credentialCalls, submitted, filled, closed, inspected }) }
}

test('already-ready terminal returns directly without asking for credentials', async () => {
  const f = fixture([state({ terminalReady: true })])
  assert.deepEqual(await f.controller.login({ targetUrl, signal: new AbortController().signal }),
    { status: 'ready', targetUrl })
  assert.equal(f.calls().credentialCalls, 0)
  assert.equal(f.calls().submitted, 0)
})

test('unique HTML5 form requests credentials after verification and submits once', async () => {
  const f = fixture([state(), state(), state({ terminalReady: true })])
  const result = await f.controller.login({ targetUrl, signal: new AbortController().signal })
  assert.deepEqual(result, { status: 'ready', targetUrl })
  assert.equal(f.calls().credentialCalls, 1)
  assert.equal(f.calls().submitted, 1)
  assert.deepEqual(f.calls().filled, { username: 'operator', password: 'secret-value' })
  assert.equal(JSON.stringify(result).includes('secret-value'), false)
  assert.equal(f.calls().closed, 1)
})

test('email-type username fields pass controller verification', async () => {
  const emailForm = state({ fields: [
    { kind: 'username', selector: 'input[autocomplete=username]', type: 'email', autocomplete: 'username' },
    { kind: 'password', selector: 'input[type=password]', type: 'password', autocomplete: 'current-password' },
  ] })
  const f = fixture([emailForm, emailForm, state({ terminalReady: true })])
  assert.deepEqual(await f.controller.login({ targetUrl, signal: new AbortController().signal }),
    { status: 'ready', targetUrl })
  assert.equal(f.calls().credentialCalls, 1)
  assert.equal(f.calls().submitted, 1)
})

test('MFA, unknown fields, and cross-origin redirects never receive credentials', async () => {
  const cases: Array<[LoginPageState, string]> = [
    [state({ challenge: 'mfa' }), 'challenge'],
    [state({ fields: [...state().fields, { kind: 'username', selector: '#extra', type: 'text', autocomplete: '' }] }), 'unknown-form'],
    [state({ url: 'https://idp.example.test/login' }), 'redirect'],
  ]
  for (const [pageState, reason] of cases) {
    const f = fixture([pageState])
    const result = await f.controller.login({ targetUrl, signal: new AbortController().signal })
    assert.equal(result.status === 'needs-user' ? result.reason : '', reason)
    assert.equal(f.calls().credentialCalls, 0)
    assert.equal(f.calls().submitted, 0)
  }
})

test('duplicate matching tabs and non-loopback CDP endpoints are rejected', async () => {
  const duplicate = fixture([state()], [
    { type: 'page', url: targetUrl, webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/1' },
    { type: 'page', url: targetUrl, webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/2' },
  ])
  assert.deepEqual(await duplicate.controller.login({ targetUrl, signal: new AbortController().signal }),
    { status: 'needs-user', reason: 'ambiguous-target' })
  assert.equal(duplicate.calls().credentialCalls, 0)
  const remote = new WebLoginController({ endpoint: 'http://192.0.2.1:9222', credentials: async () => ({ username: 'x', password: 'y' }), cdp: { connect: async () => { throw Error() } } })
  assert.deepEqual(await remote.login({ targetUrl, signal: new AbortController().signal }),
    { status: 'rejected', reason: 'unsafe-cdp' })
})
