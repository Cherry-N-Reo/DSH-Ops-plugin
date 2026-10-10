import test from 'node:test'
import assert from 'node:assert/strict'
import { guestLoginPage } from '../src/web-login-cdp.ts'
import { WebLoginController, type LoginPageState } from '../src/web-login.ts'

const targetUrl = 'https://shell.example.test/login'
const loginState = (patch: Partial<LoginPageState> = {}): LoginPageState => ({
  url: targetUrl,
  terminalReady: false,
  fields: [
    { kind: 'username', selector: 'input[0]', type: 'text', autocomplete: 'username' },
    { kind: 'password', selector: 'input[1]', type: 'password', autocomplete: 'current-password' },
  ],
  challenge: null,
  passwordEchoRisk: false,
  ...patch,
})

function guestFixture(states: LoginPageState[]) {
  const evaluated: string[] = []
  let inspected = 0
  let credentials = 0
  let submits = 0
  let pageRequests = 0
  let fetches = 0
  const page = guestLoginPage(async script => {
    evaluated.push(script)
    if (script.startsWith('(() => {')) return states[Math.min(inspected++, states.length - 1)]
    if (script.includes('function(username, password, inspectedUrl')) return true
    if (script.includes('function(inspectedUrl, userIndex, passwordIndex)')) {
      submits++
      return true
    }
    throw new Error('Unexpected guest evaluator script.')
  })
  const controller = new WebLoginController({
    endpoint: 'http://127.0.0.1:9222',
    page: async () => { pageRequests++; return page },
    fetch: async () => { fetches++; throw new Error('Desktop guest login must not fetch CDP targets.') },
    cdp: { connect: async () => { throw new Error('Desktop guest login must not connect CDP.') } },
    credentials: async () => { credentials++; return { username: 'operator', password: 'secret' } },
    maxObservations: 1,
  })
  return {
    controller,
    evaluated,
    counts: () => ({ credentials, submits, pageRequests, fetches, inspected }),
  }
}

test('guest page inspection exposes metadata only; fill and submit evaluate once with escaped values', async () => {
  const scripts: string[] = []
  const metadata = loginState()
  const page = guestLoginPage(async script => {
    scripts.push(script)
    if (script.startsWith('(() => {')) return metadata
    return true
  })
  const signal = new AbortController().signal
  assert.deepEqual(await page.inspect(signal), metadata)
  const username = `operator');globalThis.pwned=true;//\"`
  const password = `p\\ass\"word');alert(1);//`
  await page.fill({ username, password }, signal)
  await page.submit(signal)
  page.close()

  assert.equal(scripts.length, 3)
  assert.equal(scripts[0]!.includes(username), false)
  assert.equal(scripts[0]!.includes(password), false)
  assert.equal(scripts[0]!.includes('value:'), false)
  assert.ok(scripts[1]!.endsWith(`(${JSON.stringify(username)},${JSON.stringify(password)},${JSON.stringify(targetUrl)},0,1)`))
  assert.equal(scripts.length, 3, 'closing the adapter must not operate on the guest tab')
  assert.ok(scripts[2]!.includes('requestSubmit()'))
})

test('Desktop guest controller bypasses CDP discovery, checks the form, and submits only once', async () => {
  const f = guestFixture([loginState(), loginState(), loginState({ terminalReady: true })])
  const result = await f.controller.login({ targetUrl, signal: new AbortController().signal })
  assert.deepEqual(result, { status: 'ready', targetUrl })
  assert.deepEqual(f.counts(), {
    credentials: 1, submits: 1, pageRequests: 1, fetches: 0, inspected: 3,
  })
  assert.equal(f.evaluated.filter(script => script.includes('function(username, password, inspectedUrl')).length, 1)
  assert.equal(f.evaluated.filter(script => script.includes('function(inspectedUrl, userIndex, passwordIndex)')).length, 1)
})

test('Desktop guest controller withholds credentials for MFA, unknown forms, and URL changes', async t => {
  const cases: Array<[string, LoginPageState, string]> = [
    ['MFA', loginState({ challenge: 'mfa' }), 'challenge'],
    ['unknown fields', loginState({ fields: [...loginState().fields, {
      kind: 'other', selector: 'input[2]', type: 'text', autocomplete: '',
    }] }), 'unknown-form'],
    ['cross-origin redirect', loginState({ url: 'https://idp.example.test/login' }), 'redirect'],
    ['same-origin path change', loginState({ url: 'https://shell.example.test/other' }), 'redirect'],
  ]
  for (const [label, state, reason] of cases) await t.test(label, async () => {
    const f = guestFixture([state])
    const result = await f.controller.login({ targetUrl, signal: new AbortController().signal })
    assert.deepEqual(result, { status: 'needs-user', reason })
    assert.equal(f.counts().credentials, 0)
    assert.equal(f.counts().submits, 0)
    assert.equal(f.counts().fetches, 0)
  })
})
