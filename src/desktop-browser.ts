/** Background WebShell driver for the customized DSH Desktop's retained Browser guests. */
import { randomUUID } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Branded } from '@deepseek-ai/dsh-brand'
import { DesktopTransport, type BrowserTransport } from './desktop-transport.ts'
import type { Desktop, Identity, Rect } from './operator.ts'
import { normalizeTerminalText, type TextOutput, type TextOutputMarker, type TextOutputReading } from './browser-output.ts'
import { extract } from './terminal.ts'
import { guestLoginPage } from './web-login-cdp.ts'
import type { LoginPage } from './web-login.ts'

type BrowserTargetId = Branded<'ops-browser-target'>
interface Target { target: BrowserTargetId; title: string; url: string }

const TERMINAL = String.raw`(() => {
  const terminals = [], seen = new Set();
  function visit(vm) {
    if (!vm || typeof vm !== 'object' || seen.has(vm)) return;
    seen.add(vm);
    for (const term of Object.values(vm.term || {})) {
      if (term && typeof term.input === 'function') terminals.push(term);
    }
    for (const child of vm.$children || []) visit(child);
  }
  visit(document.querySelector('#app')?.__vue__);
  return terminals.length === 1 ? terminals[0] : null;
})()`

const SNAPSHOT = String.raw`(() => {
  const term = __TERMINAL__;
  const buffer = term?.buffer?.active;
  if (buffer && typeof buffer.getLine === 'function') {
    const lines = [];
    for (let i = Math.max(0, buffer.length - 10000); i < buffer.length; i++) lines.push(buffer.getLine(i)?.translateToString(true) || '');
    return { source: 'xterm-buffer', text: lines.join('\n').slice(-__LIMIT__) };
  }
  const rows = document.querySelectorAll('.xterm-rows');
  return rows.length === 1 ? { source: 'dom', text: Array.from(rows[0].children, row => row.textContent || '').join('\n').slice(-__LIMIT__) } : null;
})()`

/** Guest-local input bypasses the OS input method; no method changes desktop foreground focus. */
export class DesktopBrowserDriver implements Desktop, TextOutput {
  private readonly transport: BrowserTransport
  private session = ''
  private readonly targets = new Map<string, Target>()
  private readonly input = new Map<string, 'vue' | 'textarea'>()
  private readonly inputFrames = new Map<string, string>()
  private readonly markers = new Map<string, TextOutputMarker>()
  private readonly shots = new Set<string>()

  constructor(readonly options: { targetUrl: string; runtimeDir: string; timeoutMs: number; maxChars: number }, transport?: BrowserTransport) {
    this.transport = transport ?? new DesktopTransport(options.timeoutMs)
  }

  /** @param session - owning Session selected inside the plugin's exclusive transaction. */
  useSession(session: string): void { this.session = session }

  /** @returns the selected target's metadata, without performing a new browser operation after a send. */
  boundTarget(): { title: string; url: string } | undefined {
    const target = this.targets.get(this.session)
    return target ? { title: target.title, url: target.url } : undefined
  }

  private async request(action: string, fields: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    if (!this.session) throw new Error('Desktop browser operation requires a live Session.')
    let target = this.targets.get(this.session)
    if (!target) {
      const value = await this.transport.request({ action: 'attach', session: this.session, url: this.options.targetUrl, maxChars: this.options.maxChars }, signal)
      if (!value || typeof value !== 'object' || !('target' in value) || typeof value.target !== 'string'
        || !('title' in value) || typeof value.title !== 'string' || !('url' in value) || typeof value.url !== 'string') throw new Error('Invalid Desktop browser attachment.')
      target = { target: value.target as BrowserTargetId, title: value.title, url: value.url }
      this.targets.set(this.session, target)
    }
    try {
      return await this.transport.request({ action, session: this.session, target: target.target, ...fields }, signal)
    } catch (error) {
      if (error instanceof Error && error.message === 'BROWSER_HANDLE_EXPIRED') {
        this.targets.delete(this.session)
        this.input.delete(this.session)
        this.inputFrames.delete(this.session)
        this.markers.delete(this.session)
      }
      throw error
    }
  }

  private evaluate(script: string, signal: AbortSignal, frame?: string): Promise<unknown> { return this.request('evaluate', { script, ...(frame ? { frame } : {}) }, signal) }

  private async frames(signal: AbortSignal): Promise<string[]> {
    const value = await this.request('frames', {}, signal)
    if (!Array.isArray(value) || !value.every(frame => frame && typeof frame === 'object' && typeof frame.id === 'string')) throw new Error('Invalid guest frames.')
    return value.map(frame => frame.id as string)
  }

  /** @returns the bound tab's identity and URL, without creating a new browser window. */
  async open(signal: AbortSignal): Promise<{ ready: true; url: string; title: string }> {
    await this.identity(signal)
    const target = this.targets.get(this.session)!
    return { ready: true, url: target.url, title: target.title }
  }

  /** @param signal - owning call cancellation. @returns a metadata-only form adapter for this exact guest. */
  async loginPage(signal: AbortSignal): Promise<LoginPage> {
    await this.identity(signal)
    return guestLoginPage((script, cancellation) => this.evaluate(script, cancellation))
  }

  async identity(signal: AbortSignal): Promise<Identity> {
    const value = await this.evaluate('({ width: innerWidth, height: innerHeight })', signal)
    if (!value || typeof value !== 'object' || !('width' in value) || typeof value.width !== 'number'
      || !('height' in value) || typeof value.height !== 'number' || value.width < 30 || value.height < 30) throw new Error('Desktop guest viewport is unavailable.')
    const target = this.targets.get(this.session)!
    return { hwnd: target.target, pid: 1, processName: 'dsh-desktop-browser', title: target.title,
      rect: { x: 0, y: 0, width: value.width, height: value.height } }
  }

  async focusTarget(signal: AbortSignal, expected?: Identity): Promise<Identity> {
    const identity = await this.identity(signal)
    if (expected && expected.hwnd !== identity.hwnd) throw new Error('Desktop tab binding expired.')
    return identity
  }

  async withTarget<T>(signal: AbortSignal, work: (identity: Identity) => Promise<T>, expected?: Identity): Promise<T> {
    return work(await this.focusTarget(signal, expected))
  }

  async typeCommand(_rect: Rect, text: string, mode: 'unicode' | 'keyboard', signal: AbortSignal): Promise<void> {
    if (mode !== 'unicode' || !text || /[\u0000-\u001f\u007f]/u.test(text)) throw new Error('Desktop input requires one printable command line.')
    this.input.delete(this.session)
    this.inputFrames.delete(this.session)
    const candidates: Array<{ frame: string; kind: 'vue' | 'textarea' }> = []
    for (const frame of await this.frames(signal)) {
      const kind = await this.evaluate(`(() => { if (${TERMINAL}) return 'vue'; return document.querySelectorAll('.xterm-helper-textarea').length === 1 ? 'textarea' : null; })()`, signal, frame)
      if (kind === 'vue' || kind === 'textarea') candidates.push({ frame, kind })
    }
    if (candidates.length !== 1) throw new Error('No unique supported terminal input; no command was sent.')
    const candidate = candidates[0]
    this.inputFrames.set(this.session, candidate.frame)
    if (candidate.kind === 'vue') {
      this.input.set(this.session, 'vue')
      await this.evaluate(`(() => { const term = ${TERMINAL}; if (!term) throw new Error('Terminal changed'); term.input(${JSON.stringify(text)}, true); return true; })()`, signal, candidate.frame)
      return
    }
    const focused = await this.evaluate("(() => { const inputs = document.querySelectorAll('.xterm-helper-textarea'); if (inputs.length !== 1) return false; inputs[0].focus(); return document.activeElement === inputs[0]; })()", signal, candidate.frame)
    if (focused !== true) throw new Error('No unique supported terminal input; no command was sent.')
    this.input.set(this.session, 'textarea')
    await this.evaluate(`(() => { const inputs = document.querySelectorAll('.xterm-helper-textarea'); if (inputs.length !== 1) throw new Error('Terminal changed'); const data = new DataTransfer(); data.setData('text/plain', ${JSON.stringify(text)}); inputs[0].dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })); return true; })()`, signal, candidate.frame)
  }

  async submitCommand(signal: AbortSignal): Promise<void> {
    const input = this.input.get(this.session)
    const frame = this.inputFrames.get(this.session)
    if (!input) throw new Error('No Desktop terminal command is pending.')
    if (input === 'vue') await this.evaluate(`(() => { const term = ${TERMINAL}; if (!term) throw new Error('Terminal changed'); term.input(${JSON.stringify('\r')}, true); return true; })()`, signal, frame)
    else {
      if (await this.evaluate("document.activeElement?.matches('.xterm-helper-textarea') === true", signal, frame) !== true) throw new Error('Terminal input changed before Enter.')
      await this.evaluate("(() => { const input = document.activeElement; if (!input?.matches('.xterm-helper-textarea')) throw new Error('Terminal changed'); input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true })); input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true })); return true; })()", signal, frame)
    }
    this.input.delete(this.session)
    this.inputFrames.delete(this.session)
  }

  async paste(rect: Rect, text: string, submit: boolean, signal: AbortSignal): Promise<void> {
    await this.typeCommand(rect, text, 'unicode', signal)
    if (submit) await this.submitCommand(signal)
  }

  async scroll(rect: Rect, ticks: number, signal: AbortSignal): Promise<void> {
    await this.request('scroll', { ticks, x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }, signal)
  }

  async screenshot(signal: AbortSignal): Promise<{ path: string; width: number; height: number; offset: [number, number] }> {
    const value = await this.request('screenshot', {}, signal)
    if (!value || typeof value !== 'object' || !('png' in value) || typeof value.png !== 'string'
      || !('width' in value) || typeof value.width !== 'number' || !('height' in value) || typeof value.height !== 'number') throw new Error('Invalid guest screenshot.')
    await mkdir(this.options.runtimeDir, { recursive: true, mode: 0o700 })
    const path = join(this.options.runtimeDir, `desktop-shot-${randomUUID()}.png`)
    await writeFile(path, Buffer.from(value.png, 'base64'), { flag: 'wx', mode: 0o600 })
    this.shots.add(path)
    return { path, width: value.width, height: value.height, offset: [0, 0] }
  }

  async releaseScreenshot(path: string): Promise<void> {
    if (!this.shots.delete(path)) throw new Error('Unknown Desktop screenshot.')
    await rm(path)
  }

  private async candidates(signal: AbortSignal): Promise<Array<{ source: 'websocket' | 'xterm-buffer' | 'dom'; text: string }>> {
    const streams = await this.request('streams', {}, signal)
    if (!Array.isArray(streams) || !streams.every(value => typeof value === 'string')) throw new Error('Invalid guest output stream.')
    const result: Array<{ source: 'websocket' | 'xterm-buffer' | 'dom'; text: string }> = streams.map(text => ({ source: 'websocket', text: normalizeTerminalText(text).slice(-this.options.maxChars) }))
    for (const frame of await this.frames(signal)) {
      const snapshot = await this.evaluate(SNAPSHOT.replace('__TERMINAL__', TERMINAL).replaceAll('__LIMIT__', String(this.options.maxChars)), signal, frame)
      if (snapshot && typeof snapshot === 'object' && 'source' in snapshot && (snapshot.source === 'dom' || snapshot.source === 'xterm-buffer') && 'text' in snapshot && typeof snapshot.text === 'string') result.push({ source: snapshot.source, text: normalizeTerminalText(snapshot.text) })
    }
    return result
  }

  async copy(_rect: Rect, signal: AbortSignal): Promise<string> { return (await this.candidates(signal)).find(value => value.source !== 'websocket')?.text ?? '' }

  async arm(sessionId: string, marker: TextOutputMarker, signal: AbortSignal): Promise<boolean> {
    await this.request('arm', {}, signal)
    this.markers.set(sessionId, marker)
    return true
  }

  async read(sessionId: string, marker: TextOutputMarker, signal: AbortSignal): Promise<TextOutputReading> {
    const armed = this.markers.get(sessionId)
    if (!armed || armed.begin !== marker.begin || armed.end !== marker.end) return { available: false, complete: false, text: '', attempts: 0 }
    const candidates = (await this.candidates(signal)).map(candidate => ({ candidate, result: extract(candidate.text, marker.begin, marker.end) })).filter(item => item.result.complete)
    if (new Set(candidates.map(item => `${item.result.exitCode}\0${item.result.output}`)).size !== 1) return { available: false, complete: false, text: '', attempts: 1 }
    return { available: true, complete: true, ...candidates[0].candidate, attempts: 1 }
  }

  async readRaw(_sessionId: string, signal: AbortSignal): Promise<TextOutputReading> {
    const candidates = await this.candidates(signal)
    const streams = candidates.filter(item => item.source === 'websocket' && item.text)
    const snapshots = candidates.filter(item => item.source !== 'websocket')
    const result = streams.length === 1 ? streams[0] : new Set(snapshots.map(item => item.text)).size === 1 ? snapshots[0] : undefined
    return result ? { available: true, complete: false, ...result, attempts: 1 } : { available: false, complete: false, text: '', attempts: 1 }
  }

  async clear(sessionId: string): Promise<void> { this.markers.delete(sessionId) }

  async dispose(): Promise<void> {
    try {
      await Promise.allSettled([...this.targets].map(([session, target]) => this.transport.request({ action: 'release', session, target: target.target }, AbortSignal.timeout(this.options.timeoutMs))))
    } finally {
      this.transport.dispose()
      await Promise.allSettled([...this.shots].map(path => rm(path)))
      this.targets.clear(); this.input.clear(); this.inputFrames.clear(); this.markers.clear(); this.shots.clear()
    }
  }
}
