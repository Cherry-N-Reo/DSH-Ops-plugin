import { randomBytes } from 'node:crypto'
import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { bridgeError, SreError } from './errors.ts'

export type Rect = { x: number; y: number; width: number; height: number }
export type WindowIdentity = { hwnd: string; pid: number; processName: string; title: string; rect: Rect }
export type WindowsDriverOptions = {
  runtimeDir: string
  timeoutMs: number
  settleMs: number
  browserProcesses: string[]
  targetUrl?: string
  typingIntervalMs?: number
  locateMenu?: (kind: 'copy' | 'paste', signal: AbortSignal) => Promise<[number, number]>
}

type JsonRecord = Record<string, unknown>
type Runner = (payload: JsonRecord, signal: AbortSignal) => Promise<JsonRecord>
type Screenshot = { path: string; width: number; height: number; offset: [number, number] }

const MAX_OUTPUT = 1024 * 1024
const scriptPath = (relativePath: string): string => fileURLToPath(new URL(relativePath, import.meta.url))
const bridgeScript = scriptPath('../scripts/bridge.ps1')

function abortError(): Error { return new DOMException('The Windows operation was aborted.', 'AbortError') }
function assertNotAborted(signal: AbortSignal): void { if (signal.aborted) throw abortError() }
function validNumber(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) }
function validInteger(value: unknown): value is number { return typeof value === 'number' && Number.isInteger(value) }
function checkRect(rect: Rect): void {
  if (!validNumber(rect.x) || !validNumber(rect.y) || !validNumber(rect.width) || !validNumber(rect.height) || rect.width <= 0 || rect.height <= 0) throw new TypeError('rect must contain finite x/y and positive width/height')
}
function sameIdentity(a: WindowIdentity, b: WindowIdentity): boolean {
  return a.hwnd === b.hwnd && a.pid === b.pid && a.processName === b.processName && a.title === b.title && a.rect.x === b.rect.x && a.rect.y === b.rect.y && a.rect.width === b.rect.width && a.rect.height === b.rect.height
}
function checkedIdentity(value: JsonRecord, allowed: Set<string>): WindowIdentity {
  const rect = value.rect
  if (typeof value.hwnd !== 'string' || !validInteger(value.pid) || value.pid <= 0 || typeof value.processName !== 'string' || typeof value.title !== 'string' || typeof rect !== 'object' || rect === null) throw new Error('Windows returned an invalid foreground identity.')
  const r = rect as JsonRecord
  if (!validNumber(r.x) || !validNumber(r.y) || !validNumber(r.width) || !validNumber(r.height)) throw new Error('Windows returned an invalid foreground rectangle.')
  const result: WindowIdentity = { hwnd: value.hwnd, pid: value.pid, processName: value.processName, title: value.title, rect: { x: r.x, y: r.y, width: r.width, height: r.height } }
  checkRect(result.rect)
  if (!allowed.has(result.processName.toLowerCase())) throw new Error('The foreground window is not an allowed browser.')
  return result
}
function scrubEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) if (!/(key|secret|token|password)/i.test(key)) env[key] = value
  return env
}
function powershellPath(): string {
  const root = process.env.SystemRoot
  if (!root) throw new Error('SystemRoot is unavailable; Windows PowerShell cannot be started.')
  return join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}
function makeRunner(options: WindowsDriverOptions): Runner {
  return (payload, signal) => new Promise((resolve, reject) => {
    assertNotAborted(signal)
    const child = spawn(powershellPath(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', bridgeScript], { env: scrubEnvironment(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    let stdout = ''
    let stderrSize = 0
    let failure: Error | undefined
    let killed = false
    const fail = (error: Error): void => { failure ??= error }
    const stop = (error: Error): void => { fail(error); if (!killed) { killed = true; child.kill() } }
    const timer = setTimeout(() => stop(new Error('Windows operation timed out.')), options.timeoutMs)
    const onAbort = (): void => stop(abortError())
    signal.addEventListener('abort', onAbort, { once: true })
    child.stdout.on('data', chunk => { stdout += String(chunk); if (stdout.length > MAX_OUTPUT) stop(new Error('Windows operation produced too much output.')) })
    child.stderr.on('data', chunk => { stderrSize += String(chunk).length; if (stderrSize > MAX_OUTPUT) stop(new Error('Windows operation produced too much error output.')) })
    child.stdin.on('error', () => fail(new Error('Windows helper input failed.')))
    child.once('error', () => fail(new Error('Windows helper could not be started.')))
    child.once('close', code => {
      clearTimeout(timer); signal.removeEventListener('abort', onAbort)
      if (!failure && code !== 0) {
        try { failure = bridgeError(JSON.parse(stdout).code) } catch { /* Untrusted helper output is never forwarded. */ }
      }
      if (killed || code !== 0) failure ??= new Error('Windows helper failed.')
      if (failure) { reject(failure); return }
      try {
        const parsed: unknown = JSON.parse(stdout)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || (parsed as JsonRecord).ok !== true) throw new Error()
        resolve(parsed as JsonRecord)
      } catch { reject(new Error('Windows helper returned an invalid response.')) }
    })
    child.stdin.end(JSON.stringify(payload), 'utf8')
  })
}

export class WindowsDriver {
  private readonly options: WindowsDriverOptions
  private readonly allowed: Set<string>
  private readonly run: Runner
  private readonly pending = new Set<Promise<unknown>>()
  private scratch: Promise<string> | undefined
  private disposed = false

  public constructor(options: WindowsDriverOptions, runner?: Runner) {
    if (!options || !Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0 || !Number.isFinite(options.settleMs) || options.settleMs < 0 || !Array.isArray(options.browserProcesses) || options.browserProcesses.length === 0 || !options.browserProcesses.every(name => typeof name === 'string' && name.length > 0) || typeof options.runtimeDir !== 'string' || options.runtimeDir.length === 0) throw new TypeError('invalid WindowsDriver options')
    if (options.typingIntervalMs !== undefined && (!Number.isInteger(options.typingIntervalMs) || options.typingIntervalMs < 0 || options.typingIntervalMs > 1000)) throw new TypeError('typingIntervalMs must be an integer from 0 to 1000.')
    this.options = { ...options, runtimeDir: resolve(options.runtimeDir), browserProcesses: [...options.browserProcesses] }
    this.allowed = new Set(options.browserProcesses.map(name => name.toLowerCase()))
    this.run = runner ?? makeRunner(this.options)
  }
  private operation<T>(work: () => Promise<T>): Promise<T> {
    if (this.disposed) return Promise.reject(new Error('WindowsDriver is disposed.'))
    const task = work(); this.pending.add(task); void task.finally(() => this.pending.delete(task)).catch(() => undefined); return task
  }
  private async helper(payload: JsonRecord, signal: AbortSignal): Promise<JsonRecord> {
    assertNotAborted(signal)
    if (this.options.targetUrl && ['backend-input', 'backend-capture', 'menu', 'command-input', 'command-submit'].includes(String(payload.action))) payload = { ...payload, targetUrl: this.options.targetUrl }
    const result = await this.run(payload, signal)
    if (this.options.settleMs > 0) await new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>
      const onAbort = (): void => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); reject(abortError()) }
      timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve() }, this.options.settleMs)
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) onAbort()
    })
    return result
  }
  private async identityNow(signal: AbortSignal): Promise<WindowIdentity> { return checkedIdentity(await this.helper({ action: 'identity', browserProcesses: [...this.allowed], targetUrl: this.options.targetUrl }, signal), this.allowed) }
  public identity(signal: AbortSignal): Promise<WindowIdentity> { return this.operation(() => this.identityNow(signal)) }
  /** Focuses only an existing exact-URL tab; an expected binding confines lookup to its browser window. */
  public focusTarget(signal: AbortSignal, expected?: WindowIdentity): Promise<WindowIdentity> {
    if (!this.options.targetUrl) return expected ? this.identity(signal) : Promise.reject(new SreError('TARGET_REQUIRED'))
    return this.operation(async () => checkedIdentity(await this.helper({ action: 'focus-target',
      browserProcesses: [...this.allowed], targetUrl: this.options.targetUrl, expected }, signal), this.allowed))
  }
  private async scratchDirectory(): Promise<string> {
    this.scratch ??= (async () => { await mkdir(this.options.runtimeDir, { recursive: true }); const directory = await mkdtemp(join(this.options.runtimeDir, `${basename(this.options.runtimeDir)}-windows-`)); await chmod(directory, 0o700).catch(() => undefined); return directory })()
    return await this.scratch
  }
  public screenshot(signal: AbortSignal): Promise<Screenshot> {
    return this.operation(async () => {
      const directory = await this.scratchDirectory(); const path = join(directory, `${randomBytes(12).toString('hex')}.png`)
      try {
        const expected = this.options.targetUrl ? await this.identityNow(signal) : undefined
        const result = await this.helper({ action: 'backend-capture', capture: { outPath: path }, expected }, signal)
        if (result.path !== path || !validInteger(result.width) || result.width <= 0 || !validInteger(result.height) || result.height <= 0 || !Array.isArray(result.virtual_offset) || result.virtual_offset.length !== 2 || !validInteger(result.virtual_offset[0]) || !validInteger(result.virtual_offset[1])) throw new Error('Windows capture returned an invalid response.')
        if (expected && !sameIdentity(expected, await this.identityNow(signal))) throw new SreError('TARGET_MISMATCH')
        return { path, width: result.width, height: result.height, offset: [result.virtual_offset[0], result.virtual_offset[1]] }
      } catch (error) { await rm(path, { force: true }); throw error }
    })
  }
  public async releaseScreenshot(path: string): Promise<void> {
    if (this.disposed) throw new Error('WindowsDriver is disposed.')
    const directory = await this.scratchDirectory(); const root = resolve(directory); const target = resolve(path); const child = relative(root, target)
    if (!isAbsolute(path) || !path.toLowerCase().endsWith('.png') || child === '' || child.startsWith('..') || child.includes('\\') || child.includes('/')) throw new Error('Screenshot path is outside the driver directory.')
    await rm(target, { force: true })
  }
  private point(rect: Rect): [number, number] { return [Math.round(rect.x + rect.width / 2), Math.round(rect.y + rect.height / 2)] }
  private async activateMenu(kind: 'copy' | 'paste', expected: WindowIdentity, signal: AbortSignal): Promise<void> {
    try { await this.helper({ action: 'menu', kind, expected }, signal); return } catch (uiaError) {
      const locateMenu = this.options.locateMenu; if (!locateMenu) throw uiaError; assertNotAborted(signal)
      const point = await locateMenu(kind, signal)
      if (!Array.isArray(point) || point.length !== 2 || !validInteger(point[0]) || !validInteger(point[1])) throw new Error('Menu locator returned an invalid point.')
      const current = await this.identityNow(signal)
      if (!sameIdentity(current, expected) || point[0] < current.rect.x || point[1] < current.rect.y || point[0] >= current.rect.x + current.rect.width || point[1] >= current.rect.y + current.rect.height) throw new Error('Menu locator returned an unsafe point.')
      await this.helper({ action: 'backend-input', expected, input: { action: 'click', coordinate: point } }, signal)
    }
  }
  public copy(rect: Rect, signal: AbortSignal): Promise<string> {
    checkRect(rect)
    return this.operation(async () => {
      const before = await this.identityNow(signal)
      try {
        await this.helper({ action: 'clipboard-clear' }, signal)
        await this.helper({ action: 'backend-input', expected: before, input: { action: 'drag', from: [rect.x + rect.width - 2, rect.y + rect.height - 2], to: [rect.x + 2, rect.y + 2] } }, signal)
        const after = await this.identityNow(signal); if (!sameIdentity(after, before)) throw new Error('Foreground window changed during copy.')
        await this.helper({ action: 'backend-input', expected: before, input: { action: 'click', action2: 'right_click', coordinate: this.point(rect) } }, signal)
        await this.activateMenu('copy', before, signal)
        const result = await this.helper({ action: 'clipboard-read' }, signal)
        if (typeof result.text !== 'string' || result.text.length === 0) throw new Error('Windows clipboard returned no copied text.')
        return result.text
      } finally {
        const cleanup = new AbortController(); const timer = setTimeout(() => cleanup.abort(), this.options.timeoutMs)
        try { await this.helper({ action: 'clipboard-clear' }, cleanup.signal) } finally { clearTimeout(timer) }
      }
    })
  }
  public paste(rect: Rect, text: string, submit: boolean, signal: AbortSignal): Promise<void> {
    checkRect(rect); if (typeof text !== 'string') return Promise.reject(new TypeError('text must be a string'))
    return this.operation(async () => {
      const before = await this.identityNow(signal)
      try {
        await this.helper({ action: 'clipboard-set', text }, signal)
        const beforeClick = await this.identityNow(signal); if (!sameIdentity(beforeClick, before)) throw new Error('Foreground window changed before paste.')
        await this.helper({ action: 'backend-input', expected: before, input: { action: 'click', action2: 'right_click', coordinate: this.point(rect) } }, signal)
        const beforeMenu = await this.identityNow(signal); if (!sameIdentity(beforeMenu, before)) throw new Error('Foreground window changed before paste menu.')
        await this.activateMenu('paste', beforeMenu, signal)
        if (submit) { const current = await this.identityNow(signal); if (!sameIdentity(current, before)) throw new Error('Foreground window changed before submit.'); await this.helper({ action: 'backend-input', expected: before, input: { action: 'keypress', keys: ['enter'] } }, signal) }
      } finally {
        const cleanup = new AbortController(); const timer = setTimeout(() => cleanup.abort(), this.options.timeoutMs)
        try { await this.helper({ action: 'clipboard-clear' }, cleanup.signal) } finally { clearTimeout(timer) }
      }
    })
  }
  /** Unicode packets and physical US-layout keys are distinct paths; neither writes the clipboard or submits. */
  public typeCommand(rect: Rect, text: string, mode: 'unicode' | 'keyboard', signal: AbortSignal): Promise<void> {
    checkRect(rect)
    if (!text || /[\u0000-\u001f\u007f]/.test(text)) return Promise.reject(new Error('Command input must be a nonempty single line.'))
    if (mode === 'keyboard' && /[^\x20-\x7e]/.test(text)) return Promise.reject(new Error('Physical keyboard fallback supports printable ASCII only; non-ASCII text requires verified Unicode input.'))
    return this.operation(async () => {
      const expected = await this.identityNow(signal)
      await this.helper({ action: 'command-input', expected, rect, text, mode,
        typingIntervalMs: this.options.typingIntervalMs ?? 8, timeoutMs: this.options.timeoutMs }, signal)
    })
  }
  /** A verified command receives exactly one Enter; failure does not permit automatic resubmission. */
  public submitCommand(signal: AbortSignal): Promise<void> {
    return this.operation(async () => {
      const expected = await this.identityNow(signal)
      await this.helper({ action: 'command-submit', expected }, signal)
    })
  }
  public scroll(rect: Rect, ticks: number, signal: AbortSignal): Promise<void> {
    checkRect(rect); if (!Number.isInteger(ticks)) return Promise.reject(new TypeError('ticks must be an integer')); if (ticks === 0) return Promise.resolve()
    return this.operation(async () => { const expected = await this.identityNow(signal); await this.helper({ action: 'backend-input', expected, input: { action: 'scroll', coordinate: this.point(rect), direction: ticks > 0 ? 'up' : 'down', clicks: Math.abs(ticks) } }, signal) })
  }
  public async dispose(): Promise<void> { if (this.disposed) return; this.disposed = true; await Promise.allSettled([...this.pending]); const scratch = await this.scratch?.catch(() => undefined); if (scratch) await rm(scratch, { recursive: true, force: true }) }
}
