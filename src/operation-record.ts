import { randomUUID, createHash } from 'node:crypto'
import { mkdir, open, rename, unlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

/** A handbook reference is identified by its source path and exact UTF-8 content digest. */
export interface OperationManualReference { path: string; sha256: string }

/** Execution evidence is supplied by the terminal flow, never inferred from a summary. */
export interface OperationObservation {
  complete: boolean
  markerMatched: boolean
  exitCode: number | null
  output: string
}

/** Facts about one command attempt. Reusing recordId atomically replaces its provisional record. */
export interface OperationRecordInput {
  recordId?: string
  connectionId: string
  intent: string
  command: string
  risk: string
  manuals: OperationManualReference[]
  /** Known secret values are redacted verbatim from every persisted field and never stored. */
  secrets?: readonly string[]
  submitted: boolean
  observed: OperationObservation
  preparedAt?: string
  submittedAt?: string
  completedAt?: string
}

/** Result of an atomic write; status is the independently persisted operation conclusion. */
export interface OperationRecordResult { recordId: string; status: 'success' | 'failure' | 'uncertain'; path: string }

export interface OperationRecordWriter { write(input: OperationRecordInput): Promise<OperationRecordResult> }

export interface OperationRecordWriterOptions { directory: string; maxOutputChars?: number; maxDocumentBytes?: number }

const queues = new Map<string, Promise<void>>()
const RECORD_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u
const SHA256 = /^[a-f0-9]{64}$/u
const SECRET_ASSIGNMENT = /\b(password|passwd|token|secret|api[_-]?key|access[_-]?key|authorization)\b(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu
const AUTHORIZATION = /\bAuthorization\s*:\s*(?:Bearer\s+)?[^\s'";,]+/giu
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/giu
const URL_CREDENTIALS = /(https?:\/\/)[^\s/@:]+:[^\s/@]+@/giu

function redact(value: string, secrets: readonly string[] = []): string {
  let result = value.replace(AUTHORIZATION, 'Authorization: [REDACTED]')
    .replace(SECRET_ASSIGNMENT, '$1$2[REDACTED]')
    .replace(BEARER, 'Bearer [REDACTED]')
    .replace(URL_CREDENTIALS, '$1[REDACTED]@')
  for (const secret of secrets) if (secret.length > 0) result = result.replaceAll(secret, '[REDACTED]')
  return result
}

function scalar(value: string): string { return JSON.stringify(value) }
function validTime(value: string | undefined, fallback: string): string {
  const result = value ?? fallback
  if (!Number.isFinite(Date.parse(result))) throw new TypeError('Operation record timestamps must be valid date strings')
  return new Date(result).toISOString()
}
function statusOf(input: OperationRecordInput): OperationRecordResult['status'] {
  if (input.submitted && input.observed.complete && input.observed.markerMatched && input.observed.exitCode === 0) return 'success'
  if (!input.submitted || (input.observed.complete && input.observed.markerMatched && input.observed.exitCode !== null && input.observed.exitCode !== 0)) return 'failure'
  return 'uncertain'
}
function validate(input: OperationRecordInput): void {
  if (!input.connectionId.trim() || !input.intent.trim() || !input.command.trim() || !input.risk.trim()) throw new TypeError('Operation record metadata must be nonempty')
  if (typeof input.submitted !== 'boolean' || typeof input.observed.complete !== 'boolean' || typeof input.observed.markerMatched !== 'boolean' || typeof input.observed.output !== 'string') throw new TypeError('Operation record evidence is invalid')
  const { exitCode } = input.observed
  if (exitCode !== null && (!Number.isInteger(exitCode) || exitCode < -255 || exitCode > 255)) throw new TypeError('Observed exit code must be null or an integer from -255 to 255')
  for (const manual of input.manuals) if (!manual.path.trim() || !SHA256.test(manual.sha256)) throw new TypeError('Manual references require a path and lowercase SHA-256 digest')
  if (input.secrets?.some(secret => typeof secret !== 'string')) throw new TypeError('Known operation secrets must be strings')
  for (const timestamp of [input.preparedAt, input.submittedAt, input.completedAt]) if (timestamp !== undefined) validTime(timestamp, timestamp)
}

function document(input: OperationRecordInput, id: string, status: OperationRecordResult['status'], options: Required<Pick<OperationRecordWriterOptions, 'maxOutputChars' | 'maxDocumentBytes'>>): string {
  const now = new Date().toISOString()
  const redactField = (value: string) => redact(value, input.secrets)
  const command = redactField(input.command).slice(0, 8192)
  const redactedOutput = redactField(input.observed.output)
  const output = options.maxOutputChars === 0 ? '' : redactedOutput.slice(-options.maxOutputChars)
  const manuals = input.manuals.map(reference => `  - path: ${scalar(redactField(reference.path).slice(0, 1024))}\n    sha256: ${reference.sha256}`).join('\n')
  const manualYaml = manuals ? `manuals:\n${manuals}` : 'manuals: []'
  const body = `---\ndsh-ops-record-version: 1\nstatus: ${status}\nrecord-id: ${scalar(id)}\nconnection-id: ${scalar(redactField(input.connectionId).slice(0, 512))}\nrisk: ${scalar(redactField(input.risk).slice(0, 128))}\nprepared: true\nsubmitted: ${input.submitted}\nprepared-at: ${scalar(validTime(input.preparedAt, now))}\nsubmitted-at: ${input.submittedAt ? scalar(validTime(input.submittedAt, now)) : 'null'}\ncompleted-at: ${input.completedAt ? scalar(validTime(input.completedAt, now)) : 'null'}\nexit-code: ${input.observed.exitCode ?? 'null'}\nmarker-matched: ${input.observed.markerMatched}\n${manualYaml}\n---\n\n# 操作记录\n\n## 用户意图\n\n${redactField(input.intent).slice(0, 4096)}\n\n## 已提交命令\n\n\`\`\`sh\n${command}\n\`\`\`\n\n## 观测输出${input.observed.complete ? '' : '（片段；结局尚未确认）'}\n\n\`\`\`text\n${output}\n\`\`\`\n`
  if (Buffer.byteLength(body, 'utf8') > options.maxDocumentBytes) throw new RangeError('Operation record exceeds the configured document size limit')
  return body
}

/** Creates independently addressed Markdown operation records with atomic same-directory replacement. */
export function createOperationRecordWriter(options: OperationRecordWriterOptions): OperationRecordWriter {
  const directory = resolve(options.directory)
  const limits = { maxOutputChars: options.maxOutputChars ?? 12_000, maxDocumentBytes: options.maxDocumentBytes ?? 32_768 }
  if (!Number.isInteger(limits.maxOutputChars) || limits.maxOutputChars < 0 || !Number.isInteger(limits.maxDocumentBytes) || limits.maxDocumentBytes < 1) throw new RangeError('Operation record limits must be nonnegative output and positive document bounds')
  return {
    async write(input) {
      validate(input)
      const recordId = input.recordId ?? randomUUID()
      if (!RECORD_ID.test(recordId)) throw new TypeError('Operation record ID contains unsupported characters')
      const status = statusOf(input)
      const path = join(directory, `${recordId}.md`)
      const content = document(input, recordId, status, limits)
      const temporary = join(directory, `.${recordId}.${randomUUID()}.tmp`)
      const previous = queues.get(path) ?? Promise.resolve()
      let release!: () => void
      const current = new Promise<void>(resolveQueue => { release = resolveQueue })
      const queued = previous.then(() => current)
      queues.set(path, queued)
      await previous
      try {
        await mkdir(dirname(path), { recursive: true })
        const handle = await open(temporary, 'wx', 0o600)
        try { await handle.writeFile(content, 'utf8') } finally { await handle.close() }
        await rename(temporary, path)
        return { recordId, status, path }
      } finally {
        release()
        if (queues.get(path) === queued) queues.delete(path)
        try { await unlink(temporary) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      }
    },
  }
}

/** Hashes manual bytes for a stable reference without retaining their contents in the record. */
export function operationManualReference(path: string, contents: string | Uint8Array): OperationManualReference {
  return { path, sha256: createHash('sha256').update(contents).digest('hex') }
}
