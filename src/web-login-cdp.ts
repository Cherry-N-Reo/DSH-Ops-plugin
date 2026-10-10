import type { LoginCdp, LoginField, LoginPage, LoginPageState } from './web-login.ts'

interface SocketLike {
  addEventListener(type: 'open' | 'close' | 'error', listener: () => void, options?: { once?: boolean }): void
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void
  removeEventListener(type: 'open' | 'close' | 'error', listener: () => void): void
  send(data: string): void
  close(): void
}
interface Pending { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
type RecordValue = Record<string, unknown>

/** Native CDP transport limits for connection and command completion. */
export interface NativeChromiumLoginCdpOptions {
  connectTimeoutMs?: number
  commandTimeoutMs?: number
  socket?: (url: string) => SocketLike
}

function socketFactory(url: string): SocketLike {
  const Constructor = globalThis.WebSocket as unknown as new (url: string) => SocketLike
  if (!Constructor) throw new Error('WebSocket is unavailable.')
  return new Constructor(url)
}

const INSPECT = String.raw`(() => {
  const visible = e => !!(e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden' && getComputedStyle(e).display !== 'none');
  const inputs = Array.from(document.querySelectorAll('input')).filter(e => visible(e) && !e.disabled && !e.readOnly);
  const fields = inputs.map((e, index) => {
    const type = (e.type || 'text').toLowerCase();
    const name = (e.name || e.id || '').toLowerCase();
    const autocomplete = (e.autocomplete || '').toLowerCase();
    const kind = type === 'password' ? 'password' : (type === 'text' || type === 'email') && (/user|login|account|email/.test(name) || autocomplete === 'username') ? 'username' : 'other';
    return { kind, selector: 'input[' + index + ']', type, autocomplete };
  });
  const challenge = document.querySelector('input[autocomplete="one-time-code"], input[name*="otp" i], input[name*="totp" i]') ? 'mfa'
    : document.querySelector('input[name*="captcha" i], iframe[src*="captcha" i], [data-sitekey]') ? 'captcha'
    : document.querySelector('a[href*="sso" i], a[href*="oauth" i], form[action*="sso" i], form[action*="oauth" i]') ? 'sso'
    : document.querySelector('input[type="file"]') ? 'unknown'
    : document.querySelector('input[type="password"]') && document.querySelectorAll('input[type="password"]').length > 1 ? 'unknown' : null;
  const ready = !!document.querySelector('.xterm, [role="terminal"], [aria-label*="terminal" i]')
    && !!document.querySelector('.xterm-helper-textarea, [role="terminal"] textarea, [aria-label*="terminal" i] textarea');
  const password = document.querySelector('input[type="password"]');
  return { url: location.href, terminalReady: ready, fields, challenge,
    passwordEchoRisk: !!password && (password.type !== 'password' || password.getAttribute('type') !== 'password') };
})()`

const FILL = String.raw`function(username, password, inspectedUrl, userIndex, passwordIndex) {
  if (location.href !== inspectedUrl) return false;
  const inputs = Array.from(document.querySelectorAll('input')).filter(e => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden' && getComputedStyle(e).display !== 'none' && !e.disabled && !e.readOnly);
  const users = inputs.filter(e => (e.type === 'text' || e.type === 'email') && (/user|login|account|email/i.test(e.name || e.id || '') || e.autocomplete === 'username'));
  const passwords = inputs.filter(e => e.type === 'password');
  if (users.length !== 1 || passwords.length !== 1 || inputs.length !== 2 || inputs[userIndex] !== users[0] || inputs[passwordIndex] !== passwords[0] || !users[0].form || users[0].form !== passwords[0].form) return false;
  const setter = (e, value) => {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    if (!descriptor || !descriptor.set) return false;
    descriptor.set.call(e, value);
    e.dispatchEvent(new Event('input', { bubbles: true }));
    e.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  };
  if (!setter(users[0], username)) return false;
  if (!setter(passwords[0], password)) { setter(users[0], ''); return false; }
  return true;
}`

const SUBMIT = String.raw`function(inspectedUrl, userIndex, passwordIndex) {
  if (location.href !== inspectedUrl) return false;
  const inputs = Array.from(document.querySelectorAll('input')).filter(e => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden' && getComputedStyle(e).display !== 'none' && !e.disabled && !e.readOnly);
  const users = inputs.filter(e => (e.type === 'text' || e.type === 'email') && (/user|login|account|email/i.test(e.name || e.id || '') || e.autocomplete === 'username'));
  const passwords = inputs.filter(e => e.type === 'password');
  if (users.length !== 1 || passwords.length !== 1 || inputs.length !== 2 || inputs[userIndex] !== users[0] || inputs[passwordIndex] !== passwords[0]) return false;
  const form = passwords[0].form;
  if (!form || form !== users[0].form) return false;
  form.requestSubmit();
  return true;
}`

/** Login-only native Chromium CDP adapter; page reads contain metadata, never input values. */
export class NativeChromiumLoginCdp implements LoginCdp {
  private readonly createSocket: (url: string) => SocketLike
  private readonly connectTimeoutMs: number
  private readonly commandTimeoutMs: number

  constructor(options: NativeChromiumLoginCdpOptions = {}) {
    this.createSocket = options.socket ?? socketFactory
    this.connectTimeoutMs = options.connectTimeoutMs ?? 10_000
    this.commandTimeoutMs = options.commandTimeoutMs ?? 10_000
    if (!Number.isInteger(this.connectTimeoutMs) || this.connectTimeoutMs < 1
      || !Number.isInteger(this.commandTimeoutMs) || this.commandTimeoutMs < 1) {
      throw new TypeError('CDP timeouts must be positive integer milliseconds.')
    }
  }

  /** Opens the already validated page debugger socket and enables only the Runtime domain. */
  async connect(debuggerUrl: string, signal: AbortSignal): Promise<LoginPage> {
    const endpoint = new URL(debuggerUrl)
    if (endpoint.protocol !== 'ws:' || !['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)
      || endpoint.username || endpoint.password) throw new Error('CDP debugger URL must use loopback WebSocket.')
    const socket = this.createSocket(debuggerUrl)
    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        clearTimeout(timer)
        signal.removeEventListener('abort', abort)
        socket.removeEventListener('open', opened)
        socket.removeEventListener('error', failed)
        socket.removeEventListener('close', failed)
      }
      const abort = (): void => { cleanup(); socket.close(); reject(new Error('CDP connect aborted.')) }
      const opened = (): void => { cleanup(); resolve() }
      const failed = (): void => { cleanup(); socket.close(); reject(new Error('CDP connect failed.')) }
      const timer = setTimeout(() => { cleanup(); socket.close(); reject(new Error('CDP connect timed out.')) }, this.connectTimeoutMs)
      if (signal.aborted) { abort(); return }
      signal.addEventListener('abort', abort, { once: true })
      socket.addEventListener('open', opened, { once: true })
      socket.addEventListener('error', failed, { once: true })
      socket.addEventListener('close', failed, { once: true })
    })
    const client = new CdpClient(socket, this.commandTimeoutMs)
    try {
      await client.send('Runtime.enable', {}, signal)
      return new ChromiumLoginPage(client)
    } catch (error) { client.close(); throw error }
  }
}

/** Production CDP adapter using Node's native WebSocket implementation. */
export function chromiumLoginCdp(options: NativeChromiumLoginCdpOptions = {}): LoginCdp {
  return new NativeChromiumLoginCdp(options)
}

class CdpClient {
  private nextId = 1
  private closed = false
  private readonly pending = new Map<number, Pending>()

  constructor(private readonly socket: SocketLike, private readonly commandTimeoutMs: number) {
    socket.addEventListener('message', event => this.onMessage(event.data))
    socket.addEventListener('close', () => this.stop())
    socket.addEventListener('error', () => this.stop())
  }

  private onMessage(data: unknown): void {
    if (typeof data !== 'string') return
    let parsed: unknown
    try { parsed = JSON.parse(data) } catch { return }
    if (!parsed || typeof parsed !== 'object') return
    const message = parsed as RecordValue
    if (typeof message.id !== 'number') return
    const request = this.pending.get(message.id)
    if (!request) return
    this.pending.delete(message.id)
    if (message.error) request.reject(new Error('CDP command failed.'))
    else request.resolve(message.result)
  }

  send(method: string, params: RecordValue, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted()
    if (this.closed) return Promise.reject(new Error('CDP connection is closed.'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const abort = (): void => {
        const request = this.pending.get(id)
        this.pending.delete(id)
        if (request) clearTimeout(request.timer)
        signal.removeEventListener('abort', abort)
        reject(new Error('aborted'))
      }
      const finish = (): void => { clearTimeout(timer); signal.removeEventListener('abort', abort) }
      const timer = setTimeout(() => {
        this.pending.delete(id); finish(); reject(new Error('CDP command timed out.'))
      }, this.commandTimeoutMs)
      this.pending.set(id, { timer,
        resolve: value => { finish(); resolve(value) }, reject: error => { finish(); reject(error) } })
      signal.addEventListener('abort', abort, { once: true })
      try { this.socket.send(JSON.stringify({ id, method, params })) }
      catch { this.pending.delete(id); signal.removeEventListener('abort', abort); reject(new Error('CDP send failed.')) }
    })
  }

  close(): void { this.socket.close(); this.stop() }
  private stop(): void {
    if (this.closed) return
    this.closed = true
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new Error('CDP connection closed.')) }
    this.pending.clear()
  }
}

class ChromiumLoginPage implements LoginPage {
  private inspectedUrl: string | undefined
  private inspectedFields: LoginField[] = []
  constructor(private readonly client: Pick<CdpClient, 'send' | 'close'>) {}

  async inspect(signal: AbortSignal): Promise<LoginPageState> {
    const result = await this.client.send('Runtime.evaluate', {
      expression: INSPECT, returnByValue: true, awaitPromise: false,
    }, signal)
    const value = ((result as RecordValue | undefined)?.result as RecordValue | undefined)?.value
    if (!value || typeof value !== 'object') throw new Error('Page inspection failed.')
    const row = value as RecordValue
    if (typeof row.url !== 'string' || typeof row.terminalReady !== 'boolean' || !Array.isArray(row.fields)
      || typeof row.passwordEchoRisk !== 'boolean') throw new Error('Page inspection returned invalid metadata.')
    const fields: LoginField[] = row.fields.flatMap((field: unknown) => {
      if (!field || typeof field !== 'object') return []
      const item = field as RecordValue
      if ((item.kind !== 'username' && item.kind !== 'password' && item.kind !== 'other') || typeof item.selector !== 'string'
        || typeof item.type !== 'string' || typeof item.autocomplete !== 'string') return []
      return [{ kind: item.kind, selector: item.selector, type: item.type, autocomplete: item.autocomplete }]
    })
    const challenge = row.challenge === 'mfa' || row.challenge === 'sso' || row.challenge === 'captcha'
      || row.challenge === 'unknown' ? row.challenge : null
    this.inspectedUrl = row.url
    this.inspectedFields = fields
    return { url: row.url, terminalReady: row.terminalReady, fields, challenge,
      passwordEchoRisk: row.passwordEchoRisk }
  }

  async fill(fields: { username: string; password: string }, signal: AbortSignal): Promise<void> {
    const inspectedUrl = this.inspectedUrl
    if (!inspectedUrl) throw new Error('Inspect the page before filling login fields.')
    const userField = this.inspectedFields.find(field => field.kind === 'username')
    const passwordField = this.inspectedFields.find(field => field.kind === 'password')
    const userIndex = userField && /^input\[(\d+)\]$/u.exec(userField.selector)?.[1]
    const passwordIndex = passwordField && /^input\[(\d+)\]$/u.exec(passwordField.selector)?.[1]
    if (userIndex === undefined || passwordIndex === undefined) throw new Error('Inspect a unique login form before filling.')
    const result = await this.client.send('Runtime.evaluate', {
      expression: 'document', returnByValue: false, objectGroup: 'dsh-login',
    }, signal)
    const objectId = ((result as RecordValue | undefined)?.result as RecordValue | undefined)?.objectId
    if (typeof objectId !== 'string') throw new Error('Cannot access the login document.')
    try {
      const response = await this.client.send('Runtime.callFunctionOn', {
        objectId, functionDeclaration: FILL,
        arguments: [{ value: fields.username }, { value: fields.password }, { value: inspectedUrl },
          { value: Number(userIndex) }, { value: Number(passwordIndex) }],
        returnByValue: true, awaitPromise: false,
      }, signal)
      const value = (((response as RecordValue | undefined)?.result as RecordValue | undefined)?.value)
      if (value !== true) throw new Error('Login fields changed or are ambiguous.')
    } finally {
      await this.client.send('Runtime.releaseObjectGroup', { objectGroup: 'dsh-login' }, signal).catch(() => {})
    }
  }

  async submit(signal: AbortSignal): Promise<void> {
    const inspectedUrl = this.inspectedUrl
    if (!inspectedUrl) throw new Error('Inspect the page before submitting the login form.')
    const userField = this.inspectedFields.find(field => field.kind === 'username')
    const passwordField = this.inspectedFields.find(field => field.kind === 'password')
    const userIndex = userField && /^input\[(\d+)\]$/u.exec(userField.selector)?.[1]
    const passwordIndex = passwordField && /^input\[(\d+)\]$/u.exec(passwordField.selector)?.[1]
    if (userIndex === undefined || passwordIndex === undefined) throw new Error('Inspect a unique login form before submitting.')
    const object = await this.client.send('Runtime.evaluate', {
      expression: 'document', returnByValue: false, objectGroup: 'dsh-login',
    }, signal)
    const objectId = ((object as RecordValue | undefined)?.result as RecordValue | undefined)?.objectId
    if (typeof objectId !== 'string') throw new Error('Cannot access the login document.')
    const response = await this.client.send('Runtime.callFunctionOn', {
      objectId, functionDeclaration: SUBMIT, arguments: [{ value: inspectedUrl },
        { value: Number(userIndex) }, { value: Number(passwordIndex) }],
      returnByValue: true, awaitPromise: false,
    }, signal)
    if (((response as RecordValue | undefined)?.result as RecordValue | undefined)?.value !== true) {
      throw new Error('Login form changed or is ambiguous.')
    }
  }

  close(): void { this.client.close() }
}

/**
 * Reuse narrow HTML5 form inspection in an already-owned Desktop guest.
 * @param evaluate - private guest evaluator; never log scripts because fill calls contain credentials.
 * @returns a login adapter whose close does not destroy the user's browser tab.
 */
export function guestLoginPage(evaluate: (script: string, signal: AbortSignal) => Promise<unknown>): LoginPage {
  return new ChromiumLoginPage({
    async send(method, params, signal) {
      if (method === 'Runtime.releaseObjectGroup') return {}
      if (method === 'Runtime.evaluate') {
        if (params.expression === 'document') return { result: { objectId: 'document' } }
        return { result: { value: await evaluate(String(params.expression), signal) } }
      }
      if (method === 'Runtime.callFunctionOn') {
        const argumentsList = params.arguments as Array<{ value: unknown }>
        const script = `(${String(params.functionDeclaration)})(${argumentsList.map(argument => JSON.stringify(argument.value)).join(',')})`
        return { result: { value: await evaluate(script, signal) } }
      }
      throw new Error('Unsupported guest login operation.')
    },
    close() {},
  })
}
