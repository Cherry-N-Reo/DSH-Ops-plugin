import { randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium, type BrowserContext, type CDPSession, type Frame, type Page } from 'playwright'
import { decodeTerminalFrame, normalizeTerminalText, type TextOutput, type TextOutputMarker, type TextOutputReading } from './browser-output.ts'
import { extract } from './terminal.ts'
import type { Desktop, Identity, Rect } from './operator.ts'

interface Capture { marker: TextOutputMarker; streams: Map<string, string> }
type InputTarget = { kind: 'vue-xterm' } | { kind: 'textarea'; frame: Frame }

export interface ManagedBrowserOptions {
  targetUrl: string
  userDataDir: string
  runtimeDir: string
  executablePath?: string
  channel?: 'chrome' | 'msedge' | 'chromium'
  timeoutMs: number
  maxChars: number
  maxAttempts: number
  pollMs: number
}

function safeUrl(value: string): string {
  try { const url = new URL(value); return `${url.origin}${url.pathname}` } catch { return 'unavailable' }
}

function bounded(previous: string, next: string, limit: number): string {
  const value = previous + next
  return value.length > limit ? value.slice(-limit) : value
}

const VUE_INPUT = String.raw`(function (value) {
  const root = document.querySelector('#app')?.__vue__;
  const seen = new Set();
  const terminals = [];
  function visit(vm) {
    if (!vm || typeof vm !== 'object' || seen.has(vm)) return;
    seen.add(vm);
    if (vm.$options?.name === 'shell' && vm.term) {
      for (const candidate of Object.values(vm.term)) {
        if (candidate && typeof candidate.input === 'function') terminals.push(candidate);
      }
    }
    for (const child of vm.$children || []) visit(child);
  }
  visit(root);
  if (terminals.length !== 1) return false;
  if (value !== null) terminals[0].input(value, true);
  return true;
})(__DSH_VALUE__)`

const TERMINAL_SNAPSHOT = String.raw`(function () {
  const output = [];
  const root = document.querySelector('#app')?.__vue__;
  const seen = new Set();
  function visit(vm) {
    if (!vm || typeof vm !== 'object' || seen.has(vm)) return;
    seen.add(vm);
    for (const candidate of Object.values(vm.term || {})) {
      const buffer = candidate?.buffer?.active;
      if (!buffer || typeof buffer.getLine !== 'function') continue;
      const lines = [];
      for (let i = 0; i < buffer.length; i++) lines.push(buffer.getLine(i)?.translateToString(true) || '');
      output.push({ source: 'xterm-buffer', text: lines.join('\n') });
    }
    for (const child of vm.$children || []) visit(child);
  }
  visit(root);
  for (const rows of document.querySelectorAll('.xterm-rows')) {
    output.push({ source: 'dom', text: Array.from(rows.children, row => row.textContent || '').join('\n') });
  }
  return output;
})()`

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, milliseconds)
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason) }
    signal.addEventListener('abort', abort, { once: true })
  })
}

/** Owns one persistent Chromium profile and targets only its exact configured WebShell page. */
export class ManagedBrowserDriver implements Desktop, TextOutput {
  private context?: BrowserContext
  private opening?: Promise<BrowserContext>
  private page?: Page
  private target?: InputTarget
  private id = `managed:${randomUUID()}`
  private title?: string
  private cdp?: CDPSession
  private readonly captures = new Map<string, Capture>()
  private scratch?: string
  private readonly screenshots = new Set<string>()
  private disposed = false

  constructor(readonly options: ManagedBrowserOptions) {}

  private async browser(signal: AbortSignal): Promise<BrowserContext> {
    if (this.disposed) throw new Error('Managed browser is disposed.')
    if (this.context) return this.context
    this.opening ??= (async () => {
      signal.throwIfAborted()
      await mkdir(this.options.userDataDir, { recursive: true, mode: 0o700 })
      const context = await chromium.launchPersistentContext(this.options.userDataDir, {
        headless: false,
        ...(this.options.executablePath ? { executablePath: this.options.executablePath }
          : { channel: this.options.channel ?? (process.platform === 'win32' ? 'msedge' : 'chrome') }),
        viewport: { width: 1280, height: 800 },
        acceptDownloads: false,
        timeout: this.options.timeoutMs,
        args: ['--no-first-run', '--no-default-browser-check'],
      })
      if (signal.aborted || this.disposed) { await context.close(); signal.throwIfAborted(); throw new Error('Managed browser was disposed during startup.') }
      this.context = context
      return context
    })()
    try { return await this.opening } finally { this.opening = undefined }
  }

  /** Open the owned browser once; a login redirect stays visible for the operator. */
  async open(signal: AbortSignal): Promise<{ status: 'ready' | 'login-required'; url: string; title: string }> {
    const context = await this.browser(signal)
    if (!this.page || this.page.isClosed()) {
      await this.cdp?.detach().catch(() => {})
      this.cdp = undefined
      this.captures.clear()
      const matches = context.pages().filter(page => page.url() === this.options.targetUrl)
      if (matches.length > 1) throw new Error('Multiple managed tabs match the configured WebShell URL.')
      this.page = matches[0] ?? context.pages().find(page => page.url() === 'about:blank') ?? await context.newPage()
      this.id = `managed:${randomUUID()}`
      this.title = undefined
      this.page.on('framenavigated', frame => {
        if (frame !== this.page?.mainFrame()) return
        this.id = `managed:${randomUUID()}`
        this.title = undefined
        this.captures.clear()
      })
      if (this.page.url() !== this.options.targetUrl) await this.page.goto(this.options.targetUrl, { waitUntil: 'domcontentloaded', timeout: this.options.timeoutMs })
    }
    signal.throwIfAborted()
    const ready = this.page.url() === this.options.targetUrl
    return { status: ready ? 'ready' : 'login-required',
      url: ready ? this.options.targetUrl : safeUrl(this.page.url()), title: await this.page.title() }
  }

  private async exactPage(signal: AbortSignal): Promise<Page> {
    signal.throwIfAborted()
    if (!this.page || this.page.isClosed()) throw new Error('Open the managed WebShell browser first.')
    if (this.page.url() !== this.options.targetUrl) throw new Error('Managed WebShell is not at the configured URL. Complete login in its browser window.')
    return this.page
  }

  async identity(signal: AbortSignal): Promise<Identity> {
    const page = await this.exactPage(signal)
    this.title ??= await page.title()
    const viewport = page.viewportSize()
    if (!viewport) throw new Error('Managed browser viewport is unavailable.')
    return { hwnd: this.id, pid: 1, processName: 'managed-chromium', title: this.title,
      rect: { x: 0, y: 0, width: viewport.width, height: viewport.height } }
  }

  /** Verify the exact owned page without activating its OS window or tab. */
  async focusTarget(signal: AbortSignal, expected?: Identity): Promise<Identity> {
    const identity = await this.identity(signal)
    if (expected && (expected.hwnd !== identity.hwnd || expected.pid !== identity.pid
      || JSON.stringify(expected.rect) !== JSON.stringify(identity.rect))) throw new Error('Managed browser binding changed.')
    return identity
  }

  async withTarget<T>(signal: AbortSignal, work: (identity: Identity) => Promise<T>, expected?: Identity): Promise<T> {
    return work(await this.focusTarget(signal, expected))
  }

  async screenshot(signal: AbortSignal): Promise<{ path: string; width: number; height: number; offset: [number, number] }> {
    const page = await this.exactPage(signal)
    const viewport = page.viewportSize()
    if (!viewport) throw new Error('Managed browser viewport is unavailable.')
    await mkdir(this.options.runtimeDir, { recursive: true, mode: 0o700 })
    this.scratch ??= await mkdtemp(join(this.options.runtimeDir, 'managed-shot-'))
    await chmod(this.scratch, 0o700).catch(() => {})
    const path = join(this.scratch, `${randomUUID()}.png`)
    const bytes = await page.screenshot({ type: 'png', animations: 'disabled' })
    signal.throwIfAborted()
    await writeFile(path, bytes, { flag: 'wx', mode: 0o600 })
    this.screenshots.add(path)
    return { path, width: viewport.width, height: viewport.height, offset: [0, 0] }
  }

  async releaseScreenshot(path: string): Promise<void> {
    if (!this.screenshots.delete(path)) throw new Error('Unknown managed screenshot.')
    await rm(path, { force: true })
  }

  private async vueTerminal(page: Page): Promise<boolean> {
    return page.evaluate<boolean>(VUE_INPUT.replace('__DSH_VALUE__', 'null'))
  }

  private async sendVue(page: Page, value: string): Promise<void> {
    const accepted = await page.evaluate<boolean>(VUE_INPUT.replace('__DSH_VALUE__', JSON.stringify(value)))
    if (!accepted) throw new Error('The bound xterm instance is unavailable; input outcome is uncertain.')
  }

  async typeCommand(_rect: Rect, text: string, mode: 'unicode' | 'keyboard', signal: AbortSignal): Promise<void> {
    if (mode !== 'unicode') throw new Error('Managed browser input has no OS keyboard fallback.')
    if (!text || /[\u0000-\u001f\u007f]/u.test(text)) throw new Error('Command must be one nonempty line.')
    const page = await this.exactPage(signal)
    this.target = undefined
    if (await this.vueTerminal(page)) {
      this.target = { kind: 'vue-xterm' }
      await this.sendVue(page, text)
      return
    }
    const candidates: Frame[] = []
    for (const frame of page.frames()) if (await frame.locator('.xterm-helper-textarea').count() === 1) candidates.push(frame)
    if (candidates.length !== 1) throw new Error('Expected exactly one xterm input in the managed WebShell page.')
    const frame = candidates[0]
    this.target = { kind: 'textarea', frame }
    const input = frame.locator('.xterm-helper-textarea')
    await input.focus()
    signal.throwIfAborted()
    await page.keyboard.type(text)
  }

  async submitCommand(signal: AbortSignal): Promise<void> {
    const page = await this.exactPage(signal)
    const target = this.target
    if (!target) throw new Error('No managed terminal input is pending.')
    signal.throwIfAborted()
    if (target.kind === 'vue-xterm') await this.sendVue(page, '\r')
    else {
      if (target.frame.isDetached() || await target.frame.locator('.xterm-helper-textarea').count() !== 1) throw new Error('Managed terminal input changed before Enter.')
      await target.frame.locator('.xterm-helper-textarea').press('Enter')
    }
    this.target = undefined
  }

  async scroll(rect: Rect, ticks: number, signal: AbortSignal): Promise<void> {
    const page = await this.exactPage(signal)
    if (!Number.isInteger(ticks) || ticks === 0) throw new Error('Scroll requires nonzero integer ticks.')
    await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2)
    signal.throwIfAborted()
    await page.mouse.wheel(0, -ticks * 120)
  }

  async copy(_rect: Rect, signal: AbortSignal): Promise<string> {
    const snapshots = await this.snapshots(signal)
    return snapshots.find(item => item.source === 'xterm-buffer')?.text ?? snapshots[0]?.text ?? ''
  }

  async paste(rect: Rect, text: string, submit: boolean, signal: AbortSignal): Promise<void> {
    await this.typeCommand(rect, text, 'unicode', signal)
    if (submit) await this.submitCommand(signal)
  }

  private async network(signal: AbortSignal): Promise<void> {
    if (this.cdp) return
    const page = await this.exactPage(signal)
    const cdp = await page.context().newCDPSession(page)
    try { await cdp.send('Network.enable') } catch (error) { await cdp.detach(); throw error }
    cdp.on('Network.webSocketFrameReceived', event => {
      const response = event.response
      const value = decodeTerminalFrame(response.opcode, response.payloadData)
      if (!value) return
      for (const capture of this.captures.values()) capture.streams.set(event.requestId,
        bounded(capture.streams.get(event.requestId) ?? '', value, this.options.maxChars))
    })
    this.cdp = cdp
  }

  async arm(sessionId: string, marker: TextOutputMarker, signal: AbortSignal): Promise<boolean> {
    await this.exactPage(signal)
    this.captures.set(sessionId, { marker, streams: new Map() })
    try { await this.network(signal) } catch { /* xterm and DOM snapshots remain available. */ }
    return true
  }

  private async snapshots(signal: AbortSignal): Promise<Array<{ source: 'xterm-buffer' | 'dom'; text: string }>> {
    const page = await this.exactPage(signal)
    const values = await Promise.all(page.frames().map(async frame => {
      try { return await frame.evaluate<Array<{ source: 'xterm-buffer' | 'dom'; text: string }>>(TERMINAL_SNAPSHOT) }
      catch { return [] }
    }))
    signal.throwIfAborted()
    return values.flat().filter(item => item.text).map(item => ({ ...item,
      text: normalizeTerminalText(item.text).slice(-this.options.maxChars) }))
  }

  async read(sessionId: string, marker: TextOutputMarker, signal: AbortSignal): Promise<TextOutputReading> {
    const capture = this.captures.get(sessionId)
    if (!capture || capture.marker.begin !== marker.begin || capture.marker.end !== marker.end) return { available: false, complete: false, text: '', attempts: 0 }
    await this.exactPage(signal)
    for (let attempt = 1; attempt <= this.options.maxAttempts; attempt++) {
      const candidates = [
        ...[...capture.streams.values()].map(text => ({ source: 'websocket' as const, text })),
        ...await this.snapshots(signal),
      ]
      const complete = candidates.map(candidate => ({ candidate,
        result: extract(candidate.text, marker.begin, marker.end) })).filter(item => item.result.complete)
      const distinct = new Set(complete.map(item => `${item.result.exitCode}\0${item.result.output}`))
      if (complete.length && distinct.size === 1) {
        const selected = complete.find(item => item.candidate.source === 'websocket') ?? complete[0]
        return { available: true, complete: true, text: selected.candidate.text,
          source: selected.candidate.source, attempts: attempt }
      }
      if (attempt < this.options.maxAttempts) await wait(this.options.pollMs, signal)
    }
    return { available: false, complete: false, text: '', attempts: this.options.maxAttempts }
  }

  async readRaw(_sessionId: string, signal: AbortSignal): Promise<TextOutputReading> {
    const capture = this.captures.get(_sessionId)
    if (capture) {
      const streams = [...capture.streams.values()].filter(Boolean)
      if (streams.length === 1) return { available: true, complete: false, text: streams[0], source: 'websocket', attempts: 1 }
    }
    const values = await this.snapshots(signal)
    const selected = values.find(item => item.source === 'xterm-buffer') ?? values[0]
    return selected ? { available: true, complete: false, text: selected.text,
      source: selected.source, attempts: 1 } : { available: false, complete: false, text: '', attempts: 1 }
  }

  async clear(sessionId: string): Promise<void> { this.captures.delete(sessionId) }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.captures.clear()
    await this.cdp?.detach().catch(() => {})
    await this.opening?.catch(() => {})
    await this.context?.close()
    if (this.scratch) await rm(this.scratch, { recursive: true, force: true })
  }
}
