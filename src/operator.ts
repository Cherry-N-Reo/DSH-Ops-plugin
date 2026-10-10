import { randomUUID } from 'node:crypto'
import { classify } from './policy.ts'
import { markers, collect, extract, type Calibration, type Viewport } from './terminal.ts'
import type { Asset } from './knowledge.ts'
import type { InputFlow } from './input.ts'
import type { TextOutput } from './browser-output.ts'
import { SreError } from './errors.ts'

export interface Rect { x: number; y: number; width: number; height: number }
export interface Identity { hwnd: string; pid: number; processName: string; title: string; rect: Rect }
export interface Desktop {
  identity(signal: AbortSignal): Promise<Identity>
  focusTarget?(signal: AbortSignal, expected?: Identity): Promise<Identity>
  copy(rect: Rect, signal: AbortSignal): Promise<string>
  paste(rect: Rect, text: string, submit: boolean, signal: AbortSignal): Promise<void>
  scroll(rect: Rect, ticks: number, signal: AbortSignal): Promise<void>
  typeCommand?(rect: Rect, text: string, mode: 'unicode', signal: AbortSignal): Promise<void>
  submitCommand?(signal: AbortSignal): Promise<void>
}
export interface Binding {
  id: string; asset: Asset; identity: Identity; rect: Rect; viewport: Viewport
  createdAt: number; calibration?: Calibration; secretPending: boolean; uncertain: boolean
  pagerPatterns: string[]
  inventoryTracked: boolean
  directPending?: boolean
  lastCommand?: { begin: string; end: string; hash: string; risk: string }
  critical?: { command: string; details: Record<string, unknown>; phase: 'before-final' | 'after-final';
    environment?: { currentUser: string; cwd: string }; hash: string }
}
export interface Approval { (phase: string, details: string): Promise<boolean> }

// One process-wide lock includes all plugin instances and sessions, including HMR replacements.
let desktopTail: Promise<unknown> = Promise.resolve()
export async function exclusive<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  const previous = desktopTail
  let release!: () => void
  desktopTail = new Promise<void>(resolve => { release = resolve })
  await previous.catch(() => {})
  try { signal.throwIfAborted(); return await work() } finally { release() }
}

export function sameWindow(a: Identity, b: Identity): boolean {
  return a.hwnd === b.hwnd && a.pid === b.pid && a.processName === b.processName
    && a.title === b.title && JSON.stringify(a.rect) === JSON.stringify(b.rect)
}
export function validateRect(rect: Rect, window: Rect): void {
  if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)
    || rect.width < 30 || rect.height < 30 || rect.x < window.x || rect.y < window.y
    || rect.x + rect.width > window.x + window.width || rect.y + rect.height > window.y + window.height) {
    throw new Error('Terminal rectangle must be contained in the approved browser window.')
  }
}

/** Approval and observation checks run inside the desktop transaction; grants are never cached. */
export class Operator {
  readonly bindings = new Map<string, Binding>()
  constructor(readonly desktop: Desktop, readonly options: {
    freshnessMs: number; maxScreens: number; outputPolls: number
    audit: (event: Record<string, unknown>) => Promise<void>; now?: () => number
    assetCurrent?: (id: string) => Promise<Asset>
    inputFlow?: InputFlow
    textOutput?: TextOutput
  }) {}
  private now(): number { return this.options.now?.() ?? Date.now() }
  async fresh(binding: Binding, signal: AbortSignal): Promise<void> {
    await this.freshBackground(binding, signal)
    await this.desktop.focusTarget?.(signal, binding.identity)
    if (!sameWindow(binding.identity, await this.desktop.identity(signal))) throw new Error('Browser identity or geometry changed. Observe and bind again.')
  }
  /** Validate recorded binding state without changing the foreground during browser text collection. */
  async freshBackground(binding: Binding, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    if (this.now() - binding.createdAt > this.options.freshnessMs) throw new Error('Observation expired. Observe and bind again.')
    if (binding.inventoryTracked && this.options.assetCurrent && JSON.stringify(binding.asset) !== JSON.stringify(await this.options.assetCurrent(binding.asset.id))) throw new Error('Inventory changed. Bind the asset again.')
    validateRect(binding.rect, binding.identity.rect)
  }
  get(sessionId: string): Binding {
    const binding = this.bindings.get(sessionId)
    if (!binding) throw new Error('Observe and bind an asset before terminal operations.')
    if (binding.secretPending) throw new Error('Credential was pasted: screenshots and collection remain blocked until operator rebinds after completing the protected prompt.')
    return binding
  }
  async bind(sessionId: string, asset: Asset, identity: Identity, rect: Rect, viewport: Viewport,
    approve: Approval, signal: AbortSignal, inventoryTracked = true, targetUrl = ''): Promise<Binding> {
    validateRect(rect, identity.rect)
    if (!await approve('bind', JSON.stringify({ asset: asset.id, url: targetUrl, browser: identity, terminal: rect,
      confirmation: 'Verify the shell has an idle prompt and an empty editable line before enabling automatic Enter.' }))) throw new Error('Asset binding denied.')
    if (!sameWindow(identity, await this.desktop.identity(signal))) throw new Error('Browser changed while approving binding.')
    const binding: Binding = { id: randomUUID(), asset, identity, rect, viewport,
      createdAt: this.now(), secretPending: false, uncertain: false, inventoryTracked, pagerPatterns: ['--More--', '(END)'] }
    await this.options.audit({ sessionId, assetId: asset.id, terminalSession: binding.id, phase: 'bind', outcome: 'allowed' })
    this.bindings.set(sessionId, binding)
    return binding
  }
  async run(sessionId: string, command: string, intent: string, approve: Approval, signal: AbortSignal,
    criticalOnly = false) {
    const binding = this.get(sessionId)
    if (binding.uncertain) throw new Error('Prior command outcome is uncertain. Human inspection and a new binding are required; do not retry.')
    await this.fresh(binding, signal)
    const decision = classify(command, binding.asset)
    if (decision.risk === 'R4' && !criticalOnly) throw new Error('R4 requires sre_request_critical_action with reason, impact, and rollback information.')
    if (criticalOnly && decision.risk !== 'R4') throw new Error('Critical-action tool only accepts R4 commands.')
    const details = { sessionId, asset: binding.asset.id, terminalSession: binding.id,
      command: decision.normalized, commandHash: decision.hash, targets: decision.targets, intent }
    await this.options.audit({ sessionId, assetId: binding.asset.id, terminalSession: binding.id,
      commandHash: decision.hash, risk: decision.risk, phase: 'classified' })
    if (['R2', 'R3', 'R4'].includes(decision.risk)) {
      if (!await approve('intent', JSON.stringify(details))) throw new Error('Action intent denied.')
      await this.fresh(binding, signal)
    }
    if (decision.risk === 'R4') {
      if (this.options.inputFlow) {
        binding.critical = { command: decision.normalized, details, phase: 'before-final', hash: decision.hash }
        return this.stageVisual(sessionId, binding, 'id -un; pwd', decision.hash, 'R4', signal)
      }
      // Read actual remote user/cwd only after intent approval. Never trust model-supplied environment facts.
      const environment = await this.environment(binding, signal)
      const { currentUser, cwd } = environment
      await this.fresh(binding, signal)
      if (!await approve('final-command', JSON.stringify({ ...details, currentUser, cwd,
        timestamp: this.now(), observationId: binding.id }))) throw new Error('Final command denied.')
      await this.fresh(binding, signal)
      const afterApproval = await this.environment(binding, signal)
      if (JSON.stringify(environment) !== JSON.stringify(afterApproval)) throw new Error('Remote user/cwd changed after final approval. Approval invalidated.')
      await this.fresh(binding, signal)
    }
    signal.throwIfAborted()
    if (this.options.inputFlow) return this.stageVisual(sessionId, binding, decision.normalized, decision.hash, decision.risk, signal)
    const marker = markers(decision.normalized, randomUUID().replaceAll('-', ''))
    binding.lastCommand = { begin: marker.begin, end: marker.end, hash: decision.hash, risk: decision.risk }
    // Input and Enter failures can leave an unsubmitted line or an uncertain remote outcome.
    binding.uncertain = true
    await this.options.audit({ sessionId, assetId: binding.asset.id, terminalSession: binding.id,
      commandHash: decision.hash, risk: decision.risk, phase: 'attempt', outcome: 'unknown' })
    await this.desktop.paste(binding.rect, marker.wrapped, true, signal)
    let bottom = ''
    for (let i = 0; i < this.options.outputPolls; i++) {
      await this.fresh(binding, signal)
      bottom = await this.desktop.copy(binding.rect, signal)
      if (bottom.split(/\r?\n/).some(line => line.startsWith(marker.end + ' rc='))) break
      if (binding.pagerPatterns.some(pattern => bottom.includes(pattern))) throw new Error('Interactive pager detected. Outcome uncertain; complete pager manually and rebind. Prefer bounded --no-pager commands.')
    }
    const result = await this.collectPending(sessionId, signal)
    return { ...result, risk: decision.risk, commandHash: decision.hash, untrusted: true }
  }
  /** Type once with Unicode packets and submit once; a helper failure locks the binding against replay. */
  async sendDirect(sessionId: string, command: string, intent: string, approve: Approval,
    signal: AbortSignal, marked: boolean) {
    const binding = this.get(sessionId)
    if (binding.uncertain && !binding.directPending) throw new Error('Prior input or outcome is uncertain. Inspect and rebind; do not retry.')
    if (binding.critical) throw new Error('Resolve the pending critical action before writing again.')
    await this.fresh(binding, signal)
    const decision = classify(command, binding.asset)
    if (decision.risk === 'R4') throw new Error('R4 requires sre_request_critical_action.')
    await this.options.audit({ sessionId, assetId: binding.asset.id, terminalSession: binding.id,
      commandHash: decision.hash, risk: decision.risk, phase: 'classified' })
    if (decision.risk === 'R2' || decision.risk === 'R3') {
      if (!await approve('intent', JSON.stringify({ sessionId, asset: binding.asset.id,
        terminalSession: binding.id, command: decision.normalized, commandHash: decision.hash,
        targets: decision.targets, intent }))) throw new Error('Action intent denied.')
      await this.fresh(binding, signal)
    }
    if (!this.desktop.typeCommand || !this.desktop.submitCommand) throw new Error('Direct Unicode input is unavailable.')
    const previousMarked = !!binding.lastCommand
    const marker = marked ? markers(decision.normalized, randomUUID().replaceAll('-', '')) : undefined
    if (marker) await this.options.textOutput?.arm(sessionId, marker, signal)
    else if (!binding.directPending || previousMarked) await this.options.textOutput?.arm(sessionId, { begin: '', end: '' }, signal)
    const text = marker?.wrapped ?? decision.normalized
    binding.uncertain = true
    binding.directPending = false
    binding.lastCommand = marker ? { begin: marker.begin, end: marker.end, hash: decision.hash, risk: decision.risk } : undefined
    await this.options.audit({ sessionId, assetId: binding.asset.id, terminalSession: binding.id,
      commandHash: decision.hash, risk: decision.risk, phase: 'attempt', outcome: 'unknown' })
    await this.desktop.typeCommand(binding.rect, text, 'unicode', signal)
    await this.freshBackground(binding, signal)
    if (!sameWindow(binding.identity, await this.desktop.identity(signal))) throw new Error('Browser changed after typing. Inspect the terminal and rebind.')
    await this.desktop.submitCommand(signal)
    binding.directPending = true
    await this.options.audit({ sessionId, assetId: binding.asset.id, terminalSession: binding.id,
      commandHash: decision.hash, risk: decision.risk, phase: 'submitted', outcome: 'allowed' })
    return { submitted: true, risk: decision.risk, commandHash: decision.hash,
      terminalSession: binding.id, complete: false, untrusted: true }
  }
  private async stageVisual(sessionId: string, binding: Binding, command: string, hash: string,
    risk: string, signal: AbortSignal) {
    await this.fresh(binding, signal)
    const marker = markers(command, randomUUID().replaceAll('-', ''))
    binding.lastCommand = { begin: marker.begin, end: marker.end, hash, risk }
    binding.uncertain = true
    await this.options.audit({ sessionId, assetId: binding.asset.id, terminalSession: binding.id,
      commandHash: hash, risk, phase: binding.critical ? 'critical-environment-probe' : 'attempt', outcome: 'unknown' })
    const textCapture = await this.options.textOutput?.arm(sessionId, marker, signal) ?? false
    if (this.options.textOutput) await this.options.audit({ sessionId, assetId: binding.asset.id,
      terminalSession: binding.id, commandHash: hash, risk, phase: 'text-capture',
      outcome: textCapture ? 'allowed' : 'unavailable', source: 'browser' })
    const input = await this.options.inputFlow!.start(sessionId, marker.wrapped, signal)
    return { ...input, output: '', exitCode: null, complete: false, truncated: false,
      screens: 1, reason: binding.critical ? 'verify remote environment for critical action' : 'awaiting visual input verification',
      risk, commandHash: hash, untrusted: true }
  }
  /** Collect an already attempted command without resubmitting it, including an uncertain pending result. */
  async collectPending(sessionId: string, signal: AbortSignal) {
    if (this.options.inputFlow) throw new Error('Visual mode requires terminal_collect screenshots, not clipboard collection.')
    const binding = this.get(sessionId), marker = binding.lastCommand
    if (!marker) throw new Error('No submitted command is pending collection.')
    await this.fresh(binding, signal)
    const fallback: Calibration = { viewport: binding.viewport, fullPageTicks: 2, collectionTicks: 1, overlapRatio: .18 }
    const result = await collect({ capture: async () => {
      await this.fresh(binding, signal); return this.desktop.copy(binding.rect, signal)
    }, scroll: async ticks => {
      if (!binding.calibration) throw new Error('Long output requires actual scroll calibration. Rebind after manual inspection.')
      await this.fresh(binding, signal); await this.desktop.scroll(binding.rect, ticks, signal)
    } }, marker, binding.calibration ?? fallback, this.options.maxScreens)
    await this.options.audit({ sessionId, assetId: binding.asset.id, terminalSession: binding.id,
      commandHash: marker.hash, risk: marker.risk, phase: 'result', outputHash: classifyHash(result.output),
      exitCode: result.exitCode, outcome: result.complete ? 'complete' : 'unknown' })
    binding.uncertain = !result.complete
    if (result.complete) binding.directPending = false
    return { ...result, risk: marker.risk, commandHash: marker.hash, untrusted: true }
  }
  /** Marker verification never executes a command; screenshots and transcription remain untrusted evidence. */
  async acceptVisualOutput(sessionId: string, text: string, signal: AbortSignal, approve?: Approval,
    source: 'screenshot' | 'websocket' | 'xterm-buffer' | 'dom' = 'screenshot') {
    const binding = this.get(sessionId), marker = binding.lastCommand
    if (!marker || this.options.inputFlow?.has(sessionId)) throw new Error('Verify and submit pending input before collecting output.')
    await this.freshBackground(binding, signal)
    const result = extract(text, marker.begin, marker.end)
    await this.options.audit({ sessionId, assetId: binding.asset.id, terminalSession: binding.id,
      commandHash: marker.hash, risk: marker.risk, phase: source === 'screenshot' ? 'visual-result' : 'text-result',
      source, outputHash: classifyHash(text), exitCode: result.exitCode,
      outcome: result.complete ? 'complete' : 'unknown' })
    if (result.complete) await this.options.textOutput?.clear(sessionId)
    binding.uncertain = !result.complete
    if (result.complete) this.options.inputFlow?.clear(sessionId)
    if (result.complete && binding.critical) {
      const plan = binding.critical
      binding.uncertain = true
      const fields = result.output.split(/\r?\n/)
      if (result.exitCode !== 0 || fields.length !== 2 || !/^[a-zA-Z0-9_.-]+$/.test(fields[0]) || !fields[1].startsWith('/')) throw new SreError('CRITICAL_ENVIRONMENT_UNCERTAIN')
      const environment = { currentUser: fields[0], cwd: fields[1] }
      if (plan.phase === 'before-final') {
        if (!approve) throw new SreError('APPROVAL_UNAVAILABLE')
        await this.fresh(binding, signal)
        if (!await approve('final-command', JSON.stringify({ ...plan.details, ...environment,
          timestamp: this.now(), observationId: binding.id }))) throw new SreError('APPROVAL_REJECTED')
        await this.fresh(binding, signal)
        plan.environment = environment; plan.phase = 'after-final'
        return this.stageVisual(sessionId, binding, 'id -un; pwd', plan.hash, 'R4', signal)
      }
      if (JSON.stringify(environment) !== JSON.stringify(plan.environment)) throw new SreError('CRITICAL_ENVIRONMENT_CHANGED')
      binding.critical = undefined
      return this.stageVisual(sessionId, binding, plan.command, plan.hash, 'R4', signal)
    }
    return { ...result, output: result.complete ? result.output : text, truncated: false, source,
      reason: result.complete ? 'complete' : 'visual marker record incomplete; do not resubmit',
      risk: marker.risk, commandHash: marker.hash, untrusted: true }
  }
  /** Try browser text collection before asking the model to read a screenshot. */
  async collectText(sessionId: string, signal: AbortSignal, approve?: Approval) {
    const binding = this.get(sessionId), marker = binding.lastCommand
    if (!marker || !this.options.textOutput) return undefined
    if (this.options.inputFlow?.has(sessionId)) throw new Error('Verify and submit pending input before collecting output.')
    await this.freshBackground(binding, signal)
    const reading = await this.options.textOutput.read(sessionId, marker, signal)
    if (reading.complete && reading.source) {
      return this.acceptVisualOutput(sessionId, reading.text, signal, approve, reading.source)
    }
    if (!reading.available) return undefined
    return { output: '', exitCode: null, complete: false, truncated: false, screens: 0,
      reason: 'browser text output is not complete yet; collect again without resubmitting',
      attempts: reading.attempts, source: reading.source ?? 'browser', risk: marker.risk,
      commandHash: marker.hash, untrusted: true }
  }
  private async environment(binding: Binding, signal: AbortSignal): Promise<{ currentUser: string; cwd: string }> {
    await this.fresh(binding, signal)
    const probe = markers('id -un; pwd', randomUUID().replaceAll('-', ''))
    await this.desktop.paste(binding.rect, probe.wrapped, true, signal)
    for (let i = 0; i < this.options.outputPolls; i++) {
      await this.fresh(binding, signal)
      const result = extract(await this.desktop.copy(binding.rect, signal), probe.begin, probe.end)
      if (!result.complete) continue
      const fields = result.output.split(/\r?\n/)
      if (result.exitCode !== 0 || fields.length !== 2 || !/^[a-zA-Z0-9_.-]+$/.test(fields[0]) || !fields[1].startsWith('/')) break
      return { currentUser: fields[0], cwd: fields[1] }
    }
    throw new Error('Cannot verify remote user/cwd. Critical action denied.')
  }
}
import { createHash } from 'node:crypto'
function classifyHash(value: string): string { return createHash('sha256').update(value).digest('hex') }
