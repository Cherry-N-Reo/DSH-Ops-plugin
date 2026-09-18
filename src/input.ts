/** Screenshot-verified text input with bounded Unicode attempts and one physical-key fallback. */
import { SreError } from './errors.ts'
/** Admitted screenshot evidence returned in the owning tool result. */
export interface InputObservation { id: string; [key: string]: unknown }
/** Model-transcribed editable input; uncertain or occluded characters must not be inferred. */
export interface InputReading {
  observationId: string
  inputText: string
  idlePrompt: boolean
  fullInputVisible: boolean
  candidateVisible: boolean
  confident: boolean
}
/** The provider must stop input work before rejecting and never append an implicit Enter. */
export interface InputBackend {
  /** @param signal Cancellation signal. @returns A new admitted screenshot and unique observation ID. */
  observe(signal: AbortSignal): Promise<InputObservation>
  /** @param text Single-line input. @param mode Unicode packets or physical keys. @param signal Cancellation signal. */
  type(text: string, mode: 'unicode' | 'keyboard', signal: AbortSignal): Promise<void>
  /** @param signal Cancellation signal. Sends exactly one Enter without replaying input. */
  submit(signal: AbortSignal): Promise<void>
  /** @param event Metadata only; command bodies must not enter the audit file. */
  audit(event: Record<string, unknown>): Promise<void>
}
interface PendingInput {
  text: string; phase: 'baseline' | 'unicode' | 'keyboard' | 'submitting' | 'blocked'
  attempts: number; observationId?: string; helperFailed: boolean
}

/** Every retry requires a fresh complete reading of an empty idle command line. */
export class InputFlow {
  private readonly pending = new Map<string, PendingInput>()
  constructor(readonly backend: InputBackend, readonly maxAttempts: number) {
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3) throw new Error('inputAttempts must be an integer from 1 to 3.')
  }
  /** @param sessionId Owning session. @returns Whether unsubmitted or blocked input needs inspection. */
  has(sessionId: string): boolean {
    const state = this.pending.get(sessionId)
    return !!state && state.phase !== 'submitting'
  }
  /** @param sessionId Session whose state is released after confirmed recovery or disposal. */
  clear(sessionId: string): void { this.pending.delete(sessionId) }
  /** @param sessionId Owning session. @param text Single-line command. @param signal Cancellation signal. @returns Baseline screenshot without sending characters. */
  async start(sessionId: string, text: string, signal: AbortSignal) {
    if (this.pending.has(sessionId)) throw new Error('Pending input must be resolved before starting another command.')
    if (!text || /[\u0000-\u001f\u007f]/.test(text)) throw new Error('Input must be one nonempty command line without control characters.')
    this.pending.set(sessionId, { text, phase: 'baseline', attempts: 0, helperFailed: false })
    return await this.observe(sessionId, signal)
  }
  /** Refresh evidence without sending characters or Enter, including after capture failure.
   * @param sessionId Owning session. @param signal Cancellation signal. @returns Latest single-use screenshot and pending phase.
   */
  async observe(sessionId: string, signal: AbortSignal) {
    const state = this.pending.get(sessionId)
    if (!state || state.phase === 'submitting') throw new SreError('INPUT_NOT_PENDING')
    state.observationId = undefined
    const observation = await this.backend.observe(signal)
    state.observationId = observation.id
    return { inputPending: true, submitted: false, phase: state.phase,
      attempts: state.attempts, maxAttempts: this.maxAttempts, observation,
      instruction: state.phase === 'blocked'
        ? 'Input is blocked. This screenshot is for inspection only. Do not call terminal_input_check or repeat terminal_execute. Ask the operator to resolve partial input or uncertainty and confirm recovery through terminal_bind.'
        : 'Read only the current editable command line after the idle shell prompt, joining visual soft wraps without altering characters. Report it with terminal_input_check and this observation ID. Never infer it from history or the requested command. If any character is hidden, uncertain, or an IME candidate is visible, report uncertainty. Do not repeat terminal_execute.' }
  }
  /** Accepts only the latest observation; partially entered or uncertain text is never cleared or replayed.
   * @param sessionId Owning session. @param reading Fresh visual transcription. @param signal Cancellation signal.
   * @returns A post-attempt screenshot or one-shot submission outcome. Uncertain readings reject and block input.
   */
  async check(sessionId: string, reading: InputReading, signal: AbortSignal) {
    const state = this.pending.get(sessionId)
    if (!state || state.phase === 'submitting' || state.phase === 'blocked') throw new SreError('INPUT_NOT_PENDING')
    if (!state.observationId || reading.observationId !== state.observationId) throw new SreError('INPUT_OBSERVATION_STALE')
    state.observationId = undefined
    signal.throwIfAborted()
    if (!reading.confident || !reading.idlePrompt || !reading.fullInputVisible || reading.candidateVisible) {
      state.phase = 'blocked'
      throw new SreError('INPUT_UNCERTAIN')
    }
    if (state.phase !== 'baseline' && reading.inputText === state.text) {
      await this.backend.audit({ sessionId, phase: 'input-verified', attempts: state.attempts, mode: state.phase })
      state.phase = 'submitting'
      await this.backend.submit(signal)
      this.pending.delete(sessionId)
      return { inputPending: false, submitted: true, instruction: 'Use terminal_collect to observe the existing command; never resubmit it.' }
    }
    if (reading.inputText !== '') {
      state.phase = 'blocked'
      throw new SreError('INPUT_UNCERTAIN')
    }
    if (state.helperFailed) {
      state.phase = 'blocked'
      throw new SreError('INPUT_HELPER_UNCERTAIN')
    }
    if (state.phase === 'keyboard') {
      state.phase = 'blocked'
      throw new SreError('KEYBOARD_NOT_ACCEPTED')
    }
    const mode = state.attempts < this.maxAttempts ? 'unicode' : 'keyboard'
    state.phase = mode
    state.helperFailed = false
    if (mode === 'unicode') state.attempts++
    await this.backend.audit({ sessionId, phase: 'input-attempt', mode, attempts: state.attempts })
    try { await this.backend.type(state.text, mode, signal) }
    catch (error) {
      // The helper has exited before rejection; a fresh screenshot decides whether any input arrived.
      signal.throwIfAborted()
      state.helperFailed = true
      await this.backend.audit({ sessionId, phase: 'input-helper-failure', mode, attempts: state.attempts })
    }
    return await this.observe(sessionId, signal)
  }
}
