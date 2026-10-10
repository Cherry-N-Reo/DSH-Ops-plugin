import { Buffer } from 'node:buffer'
import { extract } from './terminal.ts'

/** One pending command whose output may be available without a screenshot. */
export interface TextOutputMarker { begin: string; end: string }

/** A bounded terminal reading from the browser debugging channel. */
export interface TextOutputReading {
  available: boolean
  complete: boolean
  text: string
  source?: 'websocket' | 'xterm-buffer' | 'dom'
  attempts: number
}

/** Optional output backend used before visual collection. */
export interface TextOutput {
  /** Start collecting future output for one command marker. */
  arm(sessionId: string, marker: TextOutputMarker, signal: AbortSignal): Promise<boolean>
  /** Probe bounded browser sources for one complete marker record. */
  read(sessionId: string, marker: TextOutputMarker, signal: AbortSignal): Promise<TextOutputReading>
  /** Return bounded unverified output from an interactive sequence, when a browser source exists. */
  readRaw?(sessionId: string, signal: AbortSignal): Promise<TextOutputReading>
  /** Stop and discard one Session's current collection. */
  clear(sessionId: string): Promise<void>
  /** Stop all browser collection owned by this backend. */
  dispose(): Promise<void>
}

interface SocketLike {
  readonly readyState: number
  addEventListener(type: 'open', listener: () => void, options?: { once?: boolean }): void
  addEventListener(type: 'close' | 'error', listener: () => void, options?: { once?: boolean }): void
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void
  send(data: string): void
  close(): void
}

interface DevToolsTarget { type?: unknown; url?: unknown; webSocketDebuggerUrl?: unknown }
interface PendingRequest { resolve(value: unknown): void; reject(error: Error): void }
interface Capture {
  client: DevToolsClient
  marker: TextOutputMarker
  streams: Map<string, string>
}

/** Settings and injectable I/O used by the browser text collector. */
export interface BrowserTextOutputOptions {
  endpoint: string
  targetUrl: string
  timeoutMs: number
  maxChars: number
  maxAttempts: number
  pollMs: number
  fetch?: typeof fetch
  socket?: (url: string) => SocketLike
}

const TERMINAL_SNAPSHOT = String.raw`(() => {
  const results = [];
  const add = (source, text) => { if (typeof text === "string" && text.length > 0) results.push({ source, text }); };
  try {
    const root = document.querySelector("#app");
    const seen = new Set();
    const visit = vm => {
      if (!vm || seen.has(vm)) return;
      seen.add(vm);
      if (vm.$options && vm.$options.name === "shell" && vm.term) {
        for (const term of Object.values(vm.term)) {
          const buffer = term && term.buffer && term.buffer.active;
          if (!buffer || typeof buffer.getLine !== "function") continue;
          const lines = [];
          for (let i = 0; i < buffer.length; i++) lines.push(buffer.getLine(i)?.translateToString(true) ?? "");
          add("xterm-buffer", lines.join("\n"));
        }
      }
      for (const child of vm.$children || []) visit(child);
    };
    visit(root && root.__vue__);
  } catch {}
  for (const rows of document.querySelectorAll(".xterm-rows")) add("dom", Array.from(rows.children, row => row.textContent || "").join("\n"));
  for (const terminal of document.querySelectorAll("[role=terminal], [aria-label*=terminal i]")) add("dom", terminal.textContent || "");
  return results;
})()`

function socketFactory(url: string): SocketLike {
  // Node's WebSocket implementation is a wire dependency whose event values are narrowed below.
  const Constructor = globalThis.WebSocket as unknown as new (value: string) => SocketLike
  if (!Constructor) throw new Error('This Node runtime does not provide WebSocket.')
  return new Constructor(url)
}

function boundedAppend(previous: string, next: string, maximum: number): string {
  const combined = previous + next
  return combined.length <= maximum ? combined : combined.slice(-maximum)
}

function isLoopback(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]'
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(finish, milliseconds)
    const abort = (): void => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason) }
    function finish(): void { signal.removeEventListener('abort', abort); resolve() }
    signal.addEventListener('abort', abort, { once: true })
  })
}

/** Remove terminal control sequences and preserve marker-bearing line structure. */
export function normalizeTerminalText(value: string): string {
  let text = value
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/gu, '')
    .replace(/\x1bP[\s\S]*?\x1b\\/gu, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, '')
    .replace(/\r\n/gu, '\n')
    .replace(/\r/gu, '\n')
  while (/[^\n]\x08/gu.test(text)) text = text.replace(/[^\n]\x08/gu, '')
  return text.replace(/\x00/gu, '')
}

function stringsFromJson(value: unknown, depth = 0): string[] {
  if (depth > 4 || value === null) return []
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(item => stringsFromJson(item, depth + 1))
  if (typeof value !== 'object') return []
  const record = value as Record<string, unknown>
  for (const key of ['data', 'output', 'payload', 'message', 'content', 'text']) {
    if (!(key in record)) continue
    const strings = stringsFromJson(record[key], depth + 1)
    if (strings.length > 0) return strings
  }
  return []
}

/** Decode a CDP WebSocket frame without assuming one vendor's terminal envelope. */
export function decodeTerminalFrame(opcode: number, payload: string): string {
  let decoded = payload
  if (opcode === 2) {
    try { decoded = Buffer.from(payload, 'base64').toString('utf8') } catch { return '' }
    if (decoded.includes('\ufffd')) return ''
  } else if (opcode !== 1) return ''
  try {
    const parsed: unknown = JSON.parse(decoded)
    const values = stringsFromJson(parsed)
    if (values.length > 0) return normalizeTerminalText(values.join(''))
  } catch { /* A raw PTY text frame is not JSON. */ }
  return normalizeTerminalText(decoded)
}

class DevToolsClient {
  private nextId = 1
  private readonly pending = new Map<number, PendingRequest>()
  readonly sessions = new Set<string>()
  private closed = false

  constructor(readonly socket: SocketLike, readonly streams: Map<string, string>, readonly maxChars: number,
    readonly timeoutMs: number) {
    socket.addEventListener('message', event => this.message(event.data))
    socket.addEventListener('close', () => this.stop(new Error('Browser debugging connection closed.')), { once: true })
    socket.addEventListener('error', () => this.stop(new Error('Browser debugging connection failed.')), { once: true })
  }

  static async connect(url: string, streams: Map<string, string>, maxChars: number, timeoutMs: number,
    create: (url: string) => SocketLike, signal: AbortSignal): Promise<DevToolsClient> {
    const socket = create(url)
    await new Promise<void>((resolve, reject) => {
      const abort = (): void => { socket.close(); reject(signal.reason) }
      signal.addEventListener('abort', abort, { once: true })
      socket.addEventListener('open', () => { signal.removeEventListener('abort', abort); resolve() }, { once: true })
      socket.addEventListener('error', () => { signal.removeEventListener('abort', abort); reject(new Error('Cannot connect to browser debugging target.')) }, { once: true })
    })
    const client = new DevToolsClient(socket, streams, maxChars, timeoutMs)
    try {
      await client.enable(undefined, signal)
      await client.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, undefined, signal)
      return client
    } catch (error) {
      client.close()
      throw error
    }
  }

  private message(data: unknown): void {
    if (typeof data !== 'string') return
    let value: unknown
    try { value = JSON.parse(data) } catch { return }
    if (!value || typeof value !== 'object') return
    const record = value as Record<string, unknown>
    if (typeof record.id === 'number') {
      const request = this.pending.get(record.id)
      if (!request) return
      this.pending.delete(record.id)
      if (record.error && typeof record.error === 'object') request.reject(new Error('Browser debugging command failed.'))
      else request.resolve(record.result)
      return
    }
    const params = record.params && typeof record.params === 'object' ? record.params as Record<string, unknown> : undefined
    if (record.method === 'Target.attachedToTarget' && params) {
      const sessionId = typeof params.sessionId === 'string' ? params.sessionId : undefined
      if (sessionId) {
        this.sessions.add(sessionId)
        void this.enable(sessionId).then(() => this.send('Target.setAutoAttach', {
          autoAttach: true, waitForDebuggerOnStart: false, flatten: true,
        }, sessionId)).catch(() => {})
      }
      return
    }
    if (record.method === 'Target.detachedFromTarget' && params && typeof params.sessionId === 'string') {
      this.sessions.delete(params.sessionId)
      return
    }
    if (record.method !== 'Network.webSocketFrameReceived' || !params) return
    const response = params.response && typeof params.response === 'object' ? params.response as Record<string, unknown> : undefined
    if (!response || typeof response.opcode !== 'number' || typeof response.payloadData !== 'string') return
    const text = decodeTerminalFrame(response.opcode, response.payloadData)
    if (!text) return
    const sessionId = typeof record.sessionId === 'string' ? record.sessionId : 'root'
    const requestId = typeof params.requestId === 'string' ? params.requestId : 'unknown'
    const key = `${sessionId}:${requestId}`
    this.streams.set(key, boundedAppend(this.streams.get(key) ?? '', text, this.maxChars))
  }

  private async enable(sessionId: string | undefined, signal?: AbortSignal): Promise<void> {
    await this.send('Network.enable', {}, sessionId, signal)
    await this.send('Runtime.enable', {}, sessionId, signal)
  }

  async matchesUrl(targetUrl: string, signal: AbortSignal): Promise<boolean> {
    try {
      const result = await this.send('Runtime.evaluate', { expression: 'location.href', returnByValue: true }, undefined, signal)
      if (!result || typeof result !== 'object') return false
      const remote = (result as Record<string, unknown>).result
      if (!remote || typeof remote !== 'object') return false
      const current = (remote as Record<string, unknown>).value
      return typeof current === 'string' && new URL(current).href === new URL(targetUrl).href
    } catch { return false }
  }

  async send(method: string, params: Record<string, unknown>, sessionId?: string, signal?: AbortSignal): Promise<unknown> {
    if (this.closed) throw new Error('Browser debugging connection is closed.')
    const deadline = signal ? AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs)
    deadline.throwIfAborted()
    const id = this.nextId++
    let onAbort: (() => void) | undefined
    const result = new Promise<unknown>((resolve, reject) => {
      const cleanup = (): void => { if (onAbort) deadline.removeEventListener('abort', onAbort) }
      this.pending.set(id, { resolve: value => { cleanup(); resolve(value) }, reject: error => { cleanup(); reject(error) } })
      onAbort = (): void => {
        this.pending.delete(id)
        cleanup()
        reject(deadline.reason ?? new Error('Browser debugging command aborted.'))
      }
      deadline.addEventListener('abort', onAbort, { once: true })
    })
    try { this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })) }
    catch (error) { this.pending.get(id)?.reject(error instanceof Error ? error : new Error('Browser debugging send failed.')); this.pending.delete(id) }
    return result
  }

  async snapshots(signal: AbortSignal): Promise<Array<{ source: 'xterm-buffer' | 'dom'; text: string }>> {
    const values: Array<{ source: 'xterm-buffer' | 'dom'; text: string }> = []
    for (const sessionId of [undefined, ...this.sessions]) {
      try {
        const result = await this.send('Runtime.evaluate', { expression: TERMINAL_SNAPSHOT, returnByValue: true }, sessionId, signal)
        if (!result || typeof result !== 'object') continue
        const remote = (result as Record<string, unknown>).result
        if (!remote || typeof remote !== 'object') continue
        const rows = (remote as Record<string, unknown>).value
        if (!Array.isArray(rows)) continue
        for (const row of rows) {
          if (!row || typeof row !== 'object') continue
          const item = row as Record<string, unknown>
          if ((item.source === 'xterm-buffer' || item.source === 'dom') && typeof item.text === 'string') {
            values.push({ source: item.source, text: normalizeTerminalText(item.text).slice(-this.maxChars) })
          }
        }
      } catch { /* A detached or cross-process frame remains eligible for screenshot fallback. */ }
    }
    return values
  }

  close(): void { this.stop(new Error('Browser debugging collection ended.')); this.socket.close() }
  private stop(error: Error): void {
    if (this.closed) return
    this.closed = true
    for (const request of this.pending.values()) request.reject(error)
    this.pending.clear()
  }
}

/** Collect marker-delimited output from a matching Chromium tab through loopback CDP. */
export class BrowserTextOutput implements TextOutput {
  private readonly captures = new Map<string, Capture>()
  private readonly fetcher: typeof fetch
  private readonly createSocket: (url: string) => SocketLike

  constructor(readonly options: BrowserTextOutputOptions) {
    this.fetcher = options.fetch ?? fetch
    this.createSocket = options.socket ?? socketFactory
  }

  async arm(sessionId: string, marker: TextOutputMarker, signal: AbortSignal): Promise<boolean> {
    await this.clear(sessionId)
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(this.options.timeoutMs)])
    try {
      const listUrl = new URL('/json/list', this.options.endpoint)
      const response = await this.fetcher(listUrl, { signal: deadline, redirect: 'error' })
      if (!response.ok) return false
      const targets: unknown = await response.json()
      if (!Array.isArray(targets)) return false
      const matches = targets.filter(value => {
        if (!value || typeof value !== 'object') return false
        const item = value as DevToolsTarget
        return item.type === 'page' && typeof item.url === 'string'
          && new URL(item.url).href === new URL(this.options.targetUrl).href
          && typeof item.webSocketDebuggerUrl === 'string'
      }) as DevToolsTarget[]
      const target = matches.length === 1 ? matches[0] : undefined
      if (!target || typeof target.webSocketDebuggerUrl !== 'string') return false
      const debuggerUrl = new URL(target.webSocketDebuggerUrl)
      if (debuggerUrl.protocol !== 'ws:' || !isLoopback(debuggerUrl.hostname)
        || debuggerUrl.username || debuggerUrl.password) return false
      const streams = new Map<string, string>()
      const client = await DevToolsClient.connect(debuggerUrl.href, streams,
        this.options.maxChars, this.options.timeoutMs, this.createSocket, deadline)
      this.captures.set(sessionId, { client, marker, streams })
      return true
    } catch { return false }
  }

  async read(sessionId: string, marker: TextOutputMarker, signal: AbortSignal): Promise<TextOutputReading> {
    signal.throwIfAborted()
    const capture = this.captures.get(sessionId)
    if (!capture || capture.marker.begin !== marker.begin || capture.marker.end !== marker.end) {
      return { available: false, complete: false, text: '', attempts: 0 }
    }
    if (!await capture.client.matchesUrl(this.options.targetUrl, signal)) {
      await this.clear(sessionId)
      return { available: false, complete: false, text: '', attempts: 0 }
    }
    let selected: { source: 'websocket' | 'xterm-buffer' | 'dom'; text: string } | undefined
    for (let attempt = 1; attempt <= this.options.maxAttempts; attempt++) {
      const candidates: Array<{ source: 'websocket' | 'xterm-buffer' | 'dom'; text: string }> = [
        ...Array.from(capture.streams.values(), text => ({ source: 'websocket' as const, text })),
        ...await capture.client.snapshots(AbortSignal.any([signal, AbortSignal.timeout(this.options.timeoutMs)])),
      ]
      const complete = candidates.map(candidate => ({ candidate,
        result: extract(candidate.text, marker.begin, marker.end) })).filter(value => value.result.complete)
      const distinct = new Set(complete.map(value => `${value.result.exitCode}\u0000${value.result.output}`))
      if (complete.length > 0 && distinct.size === 1) {
        const rank = { websocket: 0, 'xterm-buffer': 1, dom: 2 }
        selected = complete.sort((left, right) => rank[left.candidate.source] - rank[right.candidate.source])[0].candidate
        return { available: true, complete: true, ...selected, attempts: attempt }
      }
      const markerCandidates = candidates.filter(candidate => candidate.text.includes(marker.begin) || candidate.text.includes(marker.end))
      selected = markerCandidates.length === 1 ? markerCandidates[0] : undefined
      if (attempt < this.options.maxAttempts) await wait(this.options.pollMs, signal)
    }
    return { available: false, complete: false, text: selected?.text ?? '',
      source: selected?.source, attempts: this.options.maxAttempts }
  }

  async readRaw(sessionId: string, signal: AbortSignal): Promise<TextOutputReading> {
    signal.throwIfAborted()
    const capture = this.captures.get(sessionId)
    if (!capture || !await capture.client.matchesUrl(this.options.targetUrl, signal)) {
      await this.clear(sessionId)
      return { available: false, complete: false, text: '', attempts: 0 }
    }
    const snapshots = await capture.client.snapshots(signal)
    const chosen = snapshots.find(item => item.source === 'xterm-buffer' && item.text)
      ?? snapshots.find(item => item.text)
    return chosen ? { available: true, complete: false, text: chosen.text, source: chosen.source, attempts: 1 }
      : { available: false, complete: false, text: '', attempts: 1 }
  }

  async clear(sessionId: string): Promise<void> {
    const capture = this.captures.get(sessionId)
    if (!capture) return
    this.captures.delete(sessionId)
    capture.client.close()
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.captures.keys()].map(sessionId => this.clear(sessionId)))
  }
}
