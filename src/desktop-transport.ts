/** Correlated private IPC to the customized Desktop main process, never to a remote page. */
import { randomUUID } from 'node:crypto'

interface Pending { resolve(value: unknown): void; reject(error: Error): void }

/** Private IPC operations supplied by the Desktop Host environment. */
export interface BrowserTransport {
  request(request: Record<string, unknown>, signal: AbortSignal): Promise<unknown>
  dispose(): void
}

/** One plugin-owned IPC subscription; unloading rejects outstanding requests. */
export class DesktopTransport implements BrowserTransport {
  private readonly pending = new Map<string, Pending>()
  private closed = false
  private readonly receive = (message: unknown): void => {
    if (!message || typeof message !== 'object') return
    const result = message as Record<string, unknown>
    if (result.type !== 'ops-browser-result' || typeof result.requestId !== 'string') return
    const pending = this.pending.get(result.requestId)
    if (!pending) return
    if (typeof result.error === 'string') pending.reject(new Error(result.error))
    else if ('value' in result) pending.resolve(result.value)
    else pending.reject(new Error('Malformed Desktop browser result.'))
  }

  constructor(private readonly timeoutMs: number) { process.on('message', this.receive) }

  /** @param request - trusted plugin operation. @param signal - call cancellation. @returns guest result. */
  async request(request: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted()
    if (this.closed || !process.send || !process.connected) throw new Error('Customized DSH Desktop browser IPC is unavailable.')
    const requestId = randomUUID()
    let timer: ReturnType<typeof setTimeout> | undefined
    let abort: (() => void) | undefined
    try {
      return await new Promise<unknown>((resolve, reject) => {
        this.pending.set(requestId, { resolve, reject })
        timer = setTimeout(() => reject(new Error('Desktop browser request timed out; submitted input must not be replayed.')), this.timeoutMs)
        abort = () => reject(signal.reason)
        signal.addEventListener('abort', abort, { once: true })
        process.send!({ ...request, type: 'ops-browser-request', requestId }, error => { if (error) reject(error) })
      })
    } finally {
      clearTimeout(timer)
      if (abort) signal.removeEventListener('abort', abort)
      this.pending.delete(requestId)
    }
  }

  /** Remove the process listener and reject all live requests. */
  dispose(): void {
    this.closed = true
    process.removeListener('message', this.receive)
    for (const request of this.pending.values()) request.reject(new Error('Desktop browser transport unloaded.'))
    this.pending.clear()
  }
}
