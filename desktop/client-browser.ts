/** Browser-side operations for the original Desktop's retained webviews. */
import type { Context } from '@deepseek-ai/cordis'

interface Rpc {
  call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<
    { ok: true; value: unknown } | { ok: false; error: { message: string } }>
}
interface Sidebar {
  mounted: { getSnapshot(): string | undefined }
  openTab(kind: string, options: { params: { url: string } }): void
  active(): { id: string } | undefined
  focus(id: string): void
  isExpanded(): boolean
  toggleExpanded(): void
}
interface Webview extends HTMLElement {
  getURL(): string
  getTitle(): string
  executeJavaScript(script: string): Promise<unknown>
  capturePage(): Promise<{ getSize(): { width: number; height: number }; toDataURL(): string }>
}
interface Request { action: string; session: string; target?: string; url?: string; maxChars?: number; script?: string; frame?: string; ticks?: number }
interface Target { view: Webview; session: string; url: string; maxChars: number }
interface Job { id: string; deadline: number; request: Request }

function normalized(value: string): string {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('BROWSER_PROTOCOL_INVALID')
  url.searchParams.sort()
  const [route, query] = url.hash.slice(1).split('?')
  if (query !== undefined) { const params = new URLSearchParams(query); params.sort(); url.hash = route + '?' + params.toString() }
  return url.href
}
function code(error: unknown): string {
  return error instanceof Error && /^[A-Z_]{1,80}$/.test(error.message) ? error.message : 'BROWSER_CLIENT_FAILED'
}
function parseJob(value: unknown): Job {
  if (!value || typeof value !== 'object') throw new Error('BROWSER_PROTOCOL_INVALID')
  const job = value as Partial<Job>
  if (typeof job.id !== 'string' || typeof job.deadline !== 'number' || !Number.isFinite(job.deadline)
    || !job.request || typeof job.request.session !== 'string' || typeof job.request.action !== 'string') throw new Error('BROWSER_PROTOCOL_INVALID')
  return job as Job
}
function abortable<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error('BROWSER_CLIENT_CANCELLED'))
    signal.addEventListener('abort', abort, { once: true })
    void task.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

/** Owns exact-tab bindings; only screenshot fallback changes Sidebar selection. */
export class ClientBrowser {
  private readonly targets = new Map<string, Target>()
  constructor(private readonly sidebar: Sidebar, private readonly document: Document) {}

  private find(url: string): Webview[] {
    return [...this.document.querySelectorAll<Webview>('webview[data-sidebar-browser-frame]')].filter(view => {
      try { return normalized(view.getURL()) === url } catch { return false }
    })
  }
  private async attach(request: Request, signal: AbortSignal): Promise<unknown> {
    if (typeof request.url !== 'string') throw new Error('BROWSER_PROTOCOL_INVALID')
    const url = normalized(request.url)
    let matches = this.find(url)
    if (!matches.length) {
      if (this.sidebar.mounted.getSnapshot() !== request.session) throw new Error('BROWSER_TARGET_NOT_FOUND')
      this.sidebar.openTab('browser', { params: { url: request.url } })
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => { clearInterval(timer); signal.removeEventListener('abort', abort) }
        const abort = () => { cleanup(); reject(new Error('BROWSER_CLIENT_CANCELLED')) }
        const timer = setInterval(() => { if (this.find(url).length) { cleanup(); resolve() } }, 100)
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) abort()
      })
      matches = this.find(url)
    }
    if (matches.length !== 1) throw new Error(matches.length ? 'BROWSER_TARGET_AMBIGUOUS' : 'BROWSER_TARGET_NOT_FOUND')
    for (const [id, target] of this.targets) {
      if (target.view === matches[0]) {
        if (target.session !== request.session) throw new Error('BROWSER_TARGET_BUSY')
        return { target: id, url: request.url, title: target.view.getTitle() }
      }
    }
    const id = crypto.randomUUID()
    const maxChars = request.maxChars ?? 262144
    if (!Number.isInteger(maxChars) || maxChars < 4096 || maxChars > 1048576) throw new Error('BROWSER_PROTOCOL_INVALID')
    this.targets.set(id, { view: matches[0], session: request.session, url, maxChars })
    return { target: id, url: request.url, title: matches[0].getTitle() }
  }
  private bound(request: Request): Target {
    const target = request.target ? this.targets.get(request.target) : undefined
    if (!target || target.session !== request.session || !target.view.isConnected || normalized(target.view.getURL()) !== target.url) {
      if (request.target) this.targets.delete(request.target)
      throw new Error('BROWSER_HANDLE_EXPIRED')
    }
    return target
  }
  private evaluate(target: Target, script: string): Promise<unknown> {
    return target.view.executeJavaScript(`(()=>{if((${normalized.toString()})(location.href)!==${JSON.stringify(target.url)})throw new Error('BROWSER_HANDLE_EXPIRED');return (${script});})()`)
  }
  /** @param request - authenticated driver operation. @param signal - delivery deadline. @returns guest response. */
  async handle(request: Request, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted()
    if (request.action === 'attach') return this.attach(request, signal)
    const target = this.bound(request)
    switch (request.action) {
      case 'release': this.targets.delete(request.target!); return true
      case 'frames': return this.evaluate(target, `(()=>{const result=[];function visit(w,id){try{void w.document;result.push({id});for(let i=0;i<w.frames.length;i++)visit(w.frames[i],id+'/'+i)}catch{}}visit(window,'top');return result})()`)
      case 'evaluate': {
        if (typeof request.script !== 'string' || request.script.length > 2097152 || (request.frame && !/^top(?:\/\d+)*$/.test(request.frame))) throw new Error('BROWSER_PROTOCOL_INVALID')
        if (!request.frame || request.frame === 'top') return this.evaluate(target, request.script)
        return this.evaluate(target, `(()=>{let w=window;for(const i of ${JSON.stringify(request.frame.split('/').slice(1))})w=w.frames[Number(i)];try{void w.document}catch{throw new Error('BROWSER_FRAME_UNAVAILABLE')}return w.eval(${JSON.stringify(request.script)})})()`)
      }
      case 'arm': return this.evaluate(target, `(()=>{
        window.__dshOpsStreams??={sockets:new WeakSet(),frames:[],chars:0};const s=window.__dshOpsStreams;s.frames=[];s.chars=0;
        const seen=new Set();function visit(vm){if(!vm||seen.has(vm))return;seen.add(vm);for(const entry of Object.values(vm.client||{})){const ws=entry?.client;if(ws instanceof WebSocket&&!s.sockets.has(ws)){s.sockets.add(ws);ws.addEventListener('message',e=>{if(typeof e.data!=='string')return;const text=e.data.slice(-${target.maxChars});s.frames.push(text);s.chars+=text.length;while(s.chars>${target.maxChars})s.chars-=s.frames.shift().length})}}for(const child of vm.$children||[])visit(child)}
        visit(document.querySelector('#app')?.__vue__);return true})()`)
      case 'streams': return this.evaluate(target, `(()=>{const text=window.__dshOpsStreams?.frames.join('')||'';return text?[text]:[]})()`)
      case 'scroll': {
        if (!Number.isInteger(request.ticks) || Math.abs(request.ticks!) > 100) throw new Error('BROWSER_PROTOCOL_INVALID')
        return this.evaluate(target, `(()=>{const v=document.querySelectorAll('.xterm-viewport');if(v.length!==1)throw new Error('BROWSER_SCROLL_UNAVAILABLE');v[0].scrollTop+=${request.ticks! * 48};return true})()`)
      }
      case 'screenshot': {
        const before = this.sidebar.active()
        const expanded = this.sidebar.isExpanded()
        const focused = this.document.activeElement instanceof HTMLElement ? this.document.activeElement : undefined
        const marker = target.view.closest<HTMLElement>('[data-dockkit-tab], [data-sidebar-right-tab]')
        const tabId = marker?.dataset.dockkitTab ?? marker?.dataset.sidebarRightTab
        if (!tabId || target.view.closest<HTMLElement>('[data-sidebar-right-session]')?.dataset.sidebarRightSession !== this.sidebar.mounted.getSnapshot()) throw new Error('BROWSER_SCREENSHOT_UNAVAILABLE')
        try {
          if (!expanded) this.sidebar.toggleExpanded()
          this.sidebar.focus(tabId)
          await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
          signal.throwIfAborted(); this.bound(request)
          const image = await abortable(target.view.capturePage(), signal)
          return { ...image.getSize(), png: image.toDataURL().split(',')[1] }
        } finally {
          if (this.sidebar.active()?.id === tabId && before) this.sidebar.focus(before.id)
          if (!expanded && this.sidebar.isExpanded()) this.sidebar.toggleExpanded()
          if (focused?.isConnected && this.document.activeElement !== focused) focused.focus({ preventScroll: true })
        }
      }
      default: throw new Error('BROWSER_PROTOCOL_INVALID')
    }
  }
  /** Drop bindings without navigating or closing any user-owned page. */
  dispose(): void { this.targets.clear() }
}

/** @param ctx - Client context with authenticated Connection and Sidebar services. */
export function installClientBrowser(ctx: Context): void {
  if (!(globalThis as typeof globalThis & { dshDesktop?: unknown }).dshDesktop) return
  ctx.inject(['connection', 'sidebarRight'], scope => {
    // The external package compiles both faces; this entry runs only in the Client.
    const rpc = (scope.get('connection') as unknown as { rpc: Rpc }).rpc
    const browser = new ClientBrowser(scope.get('sidebarRight') as Sidebar, document)
    const client = crypto.randomUUID()
    const lifetime = new AbortController()
    const call = async (endpoint: string, payload: object, signal: AbortSignal) => {
      const result = await rpc.call('/api', 'ops-browser/' + endpoint, { client, ...payload }, signal)
      if (!result.ok) throw new Error('BROWSER_CLIENT_UNAVAILABLE')
      return result.value
    }
    const run = async () => {
      while (!lifetime.signal.aborted) {
        try {
          const value = await call('poll', {}, lifetime.signal)
          if (!value) continue
          const job = parseJob(value)
          const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(Math.max(1, job.deadline - Date.now()))])
          const start = await call('start', { id: job.id }, signal) as { accepted: boolean }
          if (!start.accepted) continue
          let response: { value: unknown } | { error: string }
          try { response = { value: await abortable(browser.handle(job.request, signal), signal) } }
          catch (error) { response = { error: code(error) } }
          await call('result', { id: job.id, ...response }, lifetime.signal)
        } catch {
          if (lifetime.signal.aborted) break
          await new Promise<void>(resolve => {
            const done = () => { clearTimeout(timer); lifetime.signal.removeEventListener('abort', done); resolve() }
            const timer = setTimeout(done, 1000)
            lifetime.signal.addEventListener('abort', done, { once: true })
          })
        }
      }
    }
    const task = run()
    scope.effect(() => async () => { lifetime.abort(); browser.dispose(); await task })
  })
}
