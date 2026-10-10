/** Authenticated Connection RPC delivers each browser operation to one Client once. */
import { randomUUID } from 'node:crypto'
import type { BrowserTransport } from './desktop-transport.ts'

interface Job {
  id: string
  request: Record<string, unknown>
  deadline: number
  client?: string
  started: boolean
  resolve(value: unknown): void
  reject(error: Error): void
}

/** Single-window browser request queue. Claimed or timed-out input is never redelivered. */
export class DesktopClientTransport implements BrowserTransport {
  private readonly jobs = new Map<string, Job>()
  private readonly wake = new Set<() => void>()
  private client = ''
  private seen = 0
  private closed = false

  constructor(private readonly timeoutMs: number, private readonly pollMs: number) {}

  /** @param endpoint - registered route endpoint. @param request - authenticated JSON RPC request. @param signal - owner cancellation. @returns correlated RPC response without page error details. */
  async fetch(endpoint: string, request: Request, signal: AbortSignal): Promise<Response> {
    if (request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json') return new Response(null, {status:415})
    let input: unknown
    try { input = await request.json() } catch { return new Response(null, {status:400}) }
    if (!input || typeof input !== 'object' || Array.isArray(input)) return new Response(null, {status:400})
    const envelope = input as Record<string, unknown>
    if (envelope.type !== 'client-request' || envelope.method !== endpoint
      || typeof envelope.rpcId !== 'string' || !/^[a-f0-9-]{36}$/.test(envelope.rpcId)
      || !Object.hasOwn(envelope, 'payload')) return new Response(null, {status:400})
    let result: unknown
    try { result = {ok:true,value:await this.handle(endpoint,envelope.payload,signal)} }
    catch { result = {ok:false,error:{code:'ops/browser-unavailable',message:'Browser bridge request refused.',details:{}}} }
    return Response.json({type:'server-response',rpcId:envelope.rpcId,result})
  }

  /** @param request - trusted driver operation. @param signal - tool cancellation. @returns Client result. */
  async request(request: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted()
    if (this.closed || !this.client || Date.now() - this.seen > this.timeoutMs) throw new Error('BROWSER_CLIENT_UNAVAILABLE')
    const id = randomUUID()
    let timer: ReturnType<typeof setTimeout> | undefined
    let abort: (() => void) | undefined
    try {
      return await new Promise((resolve, reject) => {
        this.jobs.set(id, { id, request, deadline: Date.now() + this.timeoutMs, started: false, resolve, reject })
        timer = setTimeout(() => reject(new Error('BROWSER_CLIENT_TIMEOUT')), this.timeoutMs)
        abort = () => reject(new Error('BROWSER_CLIENT_CANCELLED'))
        signal.addEventListener('abort', abort, { once: true })
        for (const notify of this.wake) notify()
      })
    } finally {
      clearTimeout(timer)
      if (abort) signal.removeEventListener('abort', abort)
      this.jobs.delete(id)
    }
  }

  /** @param endpoint - authenticated ops-browser endpoint. @param payload - wire JSON. @param signal - connection cancellation. @returns bounded reply. */
  async handle(endpoint: string, payload: unknown, signal: AbortSignal): Promise<unknown> {
    if (this.closed) throw new Error('BROWSER_CLIENT_UNAVAILABLE')
    if (endpoint === 'ops-browser/status') return { live: !!this.client && Date.now() - this.seen <= this.timeoutMs, pending: this.jobs.size }
    if (!payload || typeof payload !== 'object') throw new Error('BROWSER_PROTOCOL_INVALID')
    const input = payload as Record<string, unknown>
    const client = input.client
    if (typeof client !== 'string' || !/^[a-f0-9-]{36}$/.test(client)) throw new Error('BROWSER_PROTOCOL_INVALID')
    if (this.client && this.client !== client && Date.now() - this.seen <= this.timeoutMs) throw new Error('BROWSER_CLIENT_BUSY')
    this.client = client; this.seen = Date.now()
    if (endpoint === 'ops-browser/poll') {
      const claim = () => {
        const job = [...this.jobs.values()].find(job => !job.client && job.deadline > Date.now())
        if (!job) return null
        job.client = client
        return { id: job.id, request: job.request, deadline: job.deadline }
      }
      const ready = claim()
      if (ready) return ready
      let timer: ReturnType<typeof setTimeout> | undefined
      let notify: (() => void) | undefined
      let abort: (() => void) | undefined
      try {
        return await new Promise((resolve, reject) => {
          notify = () => { const next = claim(); if (next) resolve(next) }
          this.wake.add(notify)
          timer = setTimeout(() => resolve(null), this.pollMs)
          abort = () => reject(new Error('BROWSER_CLIENT_CANCELLED'))
          signal.addEventListener('abort', abort, { once: true })
          if (signal.aborted) abort()
        })
      } finally {
        clearTimeout(timer)
        if (notify) this.wake.delete(notify)
        if (abort) signal.removeEventListener('abort', abort)
      }
    }
    const job = typeof input.id === 'string' ? this.jobs.get(input.id) : undefined
    if (!job || job.client !== client || job.deadline <= Date.now()) return { accepted: false }
    if (endpoint === 'ops-browser/start') {
      if (job.started) return { accepted: false }
      job.started = true
      return { accepted: true }
    }
    if (endpoint !== 'ops-browser/result' || !job.started) throw new Error('BROWSER_PROTOCOL_INVALID')
    if (typeof input.error === 'string') {
      const code = /^[A-Z_]{1,80}$/.test(input.error) ? input.error : 'BROWSER_CLIENT_FAILED'
      job.reject(new Error(code))
    } else if (Object.hasOwn(input, 'value')) job.resolve(input.value)
    else throw new Error('BROWSER_PROTOCOL_INVALID')
    this.jobs.delete(job.id)
    return { accepted: true }
  }

  /** Reject pending work; callers must abort the owned RPC handlers before unloading. */
  dispose(): void {
    this.closed = true
    for (const job of this.jobs.values()) job.reject(new Error('BROWSER_CLIENT_UNAVAILABLE'))
    this.jobs.clear()
  }
}
