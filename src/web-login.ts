/** Login only through an explicitly matched Chromium page and a narrow CDP page adapter. */
export type LoginField = { kind: 'username' | 'password' | 'other'; selector: string; type: string; autocomplete: string }
export type LoginPageState = {
  url: string
  terminalReady: boolean
  fields: LoginField[]
  challenge: 'mfa' | 'sso' | 'captcha' | 'unknown' | null
  passwordEchoRisk: boolean
}
export type LoginCredentials = { username: string; password: string }
export interface LoginPage {
  inspect(signal: AbortSignal): Promise<LoginPageState>
  fill(fields: { username: string; password: string }, signal: AbortSignal): Promise<void>
  submit(signal: AbortSignal): Promise<void>
  close(): void
}
export interface LoginCdp {
  connect(debuggerUrl: string, signal: AbortSignal): Promise<LoginPage>
}
export type WebLoginResult =
  | { status: 'ready'; targetUrl: string }
  | { status: 'needs-user'; reason: 'challenge' | 'unknown-form' | 'login-failed' | 'redirect' | 'ambiguous-target' }
  | { status: 'rejected'; reason: 'invalid-target' | 'unsafe-cdp' | 'unsafe-form' | 'cancelled' }

export interface WebLoginOptions {
  /** Chromium remote debugging HTTP endpoint; only loopback endpoints are accepted. */
  endpoint: string
  /** Decrypt or retrieve credentials only after target and form verification. */
  credentials: () => Promise<LoginCredentials>
  /** CDP transport supplied by the host; production implementations use native Chromium CDP. */
  cdp: LoginCdp
  /** Already-owned Desktop guest; the provider validates tab ownership without opening a debug socket. */
  page?: (signal: AbortSignal) => Promise<LoginPage>
  fetch?: typeof fetch
  maxObservations?: number
  /** Delay between post-submit state reads; the caller signal bounds the overall login operation. */
  pollIntervalMs?: number
}

type CdpTarget = { type?: unknown; url?: unknown; webSocketDebuggerUrl?: unknown }
const isLoopback = (host: string): boolean => host === 'localhost' || host === '127.0.0.1' || host === '[::1]'
const normalized = (value: string): string => new URL(value).href

/**
 * Verifies one matching Chromium tab, fills only one same-origin HTML5 username/password pair,
 * and submits at most once. Credentials and page exception details never enter the result.
 */
export class WebLoginController {
  private readonly fetcher: typeof fetch
  private readonly observations: number
  private readonly pollIntervalMs: number

  constructor(private readonly options: WebLoginOptions) {
    this.fetcher = options.fetch ?? fetch
    this.observations = options.maxObservations ?? 4
    this.pollIntervalMs = options.pollIntervalMs ?? 500
    if (!Number.isInteger(this.observations) || this.observations < 1 || this.observations > 8) {
      throw new TypeError('maxObservations must be an integer from 1 to 8.')
    }
    if (!Number.isInteger(this.pollIntervalMs) || this.pollIntervalMs < 100 || this.pollIntervalMs > 2000) {
      throw new TypeError('pollIntervalMs must be an integer from 100 to 2000.')
    }
  }

  /**
   * Resolves to a redacted state; transport and page errors are deliberately not returned.
   * `ready` requires the tab URL to remain exactly `targetUrl`; same-origin path redirects currently
   * need operator handling. The caller signal bounds fetch, CDP work, polling, and the whole login.
   */
  async login(input: { targetUrl: string; signal: AbortSignal }): Promise<WebLoginResult> {
    let target: URL
    let endpoint: URL
    try {
      target = new URL(input.targetUrl)
      endpoint = new URL(this.options.endpoint)
      if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password || target.origin === 'null') {
        return { status: 'rejected', reason: 'invalid-target' }
      }
      if (endpoint.protocol !== 'http:' || !isLoopback(endpoint.hostname) || endpoint.username || endpoint.password) {
        return { status: 'rejected', reason: 'unsafe-cdp' }
      }
    } catch { return { status: 'rejected', reason: 'invalid-target' } }

    let page: LoginPage | undefined
    try {
      input.signal.throwIfAborted()
      if (this.options.page) page = await this.options.page(input.signal)
      else {
        const response = await this.fetcher(new URL('/json/list', endpoint), { signal: input.signal, redirect: 'error' })
        if (!response.ok) return { status: 'rejected', reason: 'unsafe-cdp' }
        const raw: unknown = await response.json()
        if (!Array.isArray(raw)) return { status: 'rejected', reason: 'unsafe-cdp' }
        const matches = raw.filter((item): item is CdpTarget => !!item && typeof item === 'object'
          && (item as CdpTarget).type === 'page' && typeof (item as CdpTarget).url === 'string'
          && normalized((item as CdpTarget).url as string) === target.href)
        if (matches.length !== 1) return { status: 'needs-user', reason: 'ambiguous-target' }
        const ws = matches[0].webSocketDebuggerUrl
        if (typeof ws !== 'string') return { status: 'rejected', reason: 'unsafe-cdp' }
        const debuggerUrl = new URL(ws)
        if (debuggerUrl.protocol !== 'ws:' || !isLoopback(debuggerUrl.hostname) || debuggerUrl.username || debuggerUrl.password) {
          return { status: 'rejected', reason: 'unsafe-cdp' }
        }
        page = await this.options.cdp.connect(debuggerUrl.href, input.signal)
      }
      let state = await page.inspect(input.signal)
      if (normalized(state.url) !== target.href || new URL(state.url).origin !== target.origin) {
        return { status: 'needs-user', reason: 'redirect' }
      }
      if (state.terminalReady) return { status: 'ready', targetUrl: target.href }
      if (state.challenge) return { status: 'needs-user', reason: 'challenge' }
      if (state.passwordEchoRisk) return { status: 'rejected', reason: 'unsafe-form' }
      const users = state.fields.filter(field => field.kind === 'username'
        && (field.type === 'text' || field.type === 'email'))
      const passwords = state.fields.filter(field => field.kind === 'password' && field.type === 'password')
      if (users.length !== 1 || passwords.length !== 1 || state.fields.length !== 2) {
        return { status: 'needs-user', reason: 'unknown-form' }
      }
      input.signal.throwIfAborted()
      const credentials = await this.options.credentials()
      if (!credentials || typeof credentials.username !== 'string' || !credentials.username
        || typeof credentials.password !== 'string' || !credentials.password) {
        return { status: 'needs-user', reason: 'unknown-form' }
      }
      // Recheck immediately before injection; a changed source or form invalidates the credentials.
      state = await page.inspect(input.signal)
      if (normalized(state.url) !== target.href || new URL(state.url).origin !== target.origin) {
        return { status: 'needs-user', reason: 'redirect' }
      }
      if (state.terminalReady) return { status: 'ready', targetUrl: target.href }
      if (state.challenge || state.passwordEchoRisk || state.fields.length !== 2
        || state.fields.filter(field => field.kind === 'username' && (field.type === 'text' || field.type === 'email')).length !== 1
        || state.fields.filter(field => field.kind === 'password' && field.type === 'password').length !== 1) {
        return { status: 'needs-user', reason: state.challenge ? 'challenge' : 'unknown-form' }
      }
      await page.fill({ username: credentials.username, password: credentials.password }, input.signal)
      input.signal.throwIfAborted()
      await page.submit(input.signal)
      for (let attempt = 0; attempt < this.observations; attempt++) {
        if (attempt > 0) await waitForPoll(this.pollIntervalMs, input.signal)
        input.signal.throwIfAborted()
        state = await page.inspect(input.signal)
        if (new URL(state.url).origin !== target.origin || normalized(state.url) !== target.href) {
          return { status: 'needs-user', reason: 'redirect' }
        }
        if (state.terminalReady) return { status: 'ready', targetUrl: target.href }
        if (state.challenge) return { status: 'needs-user', reason: 'challenge' }
      }
      return { status: 'needs-user', reason: 'login-failed' }
    } catch {
      return input.signal.aborted ? { status: 'rejected', reason: 'cancelled' }
        : { status: 'needs-user', reason: 'login-failed' }
    } finally { page?.close() }
  }
}

function waitForPoll(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return }
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, milliseconds)
    const abort = (): void => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason) }
    signal.addEventListener('abort', abort, { once: true })
  })
}
