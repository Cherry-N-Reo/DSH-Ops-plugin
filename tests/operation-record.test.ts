import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { parse } from 'yaml'
import { createOperationRecordWriter, operationManualReference, type OperationRecordInput } from '../src/operation-record.ts'

async function withWriter(run: (directory: string, writer: ReturnType<typeof createOperationRecordWriter>) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-operation-record-'))
  try { await run(directory, createOperationRecordWriter({ directory, maxOutputChars: 256 })) }
  finally { await rm(directory, { recursive: true, force: true }) }
}

function sample(overrides: Partial<OperationRecordInput> = {}): OperationRecordInput {
  return {
    connectionId: 'web-stage-1', intent: '检查服务状态', command: 'systemctl status nginx', risk: 'R1', manuals: [],
    submitted: true, observed: { complete: false, markerMatched: false, exitCode: null, output: 'still running' }, ...overrides,
  }
}

test('keeps submitted but incomplete operations uncertain, then finalizes the same record ID', async () => withWriter(async (directory, writer) => {
  const provisional = await writer.write(sample())
  assert.equal(provisional.status, 'uncertain')
  const final = await writer.write(sample({ recordId: provisional.recordId,
    observed: { complete: true, markerMatched: true, exitCode: 0, output: 'active (running)' } }))
  assert.equal(final.recordId, provisional.recordId)
  assert.equal(final.status, 'success')
  const content = await readFile(final.path, 'utf8')
  assert.match(content, /^---\ndsh-ops-record-version: 1\nstatus: success\n/u)
  assert.equal((await readdir(directory)).filter(name => name.endsWith('.md')).length, 1)
  assert.deepEqual(await readdir(directory), [`${provisional.recordId}.md`])
}))

test('records observed command failures and never treats a missing exact marker as success', async () => withWriter(async (_directory, writer) => {
  const failed = await writer.write(sample({ observed: { complete: true, markerMatched: true, exitCode: 2, output: 'failed' } }))
  assert.equal(failed.status, 'failure')
  const incomplete = await writer.write(sample({ observed: { complete: true, markerMatched: false, exitCode: 0, output: 'looked successful' } }))
  assert.equal(incomplete.status, 'uncertain')
  const notSubmitted = await writer.write(sample({ submitted: false }))
  assert.equal(notSubmitted.status, 'failure')
}))

test('redacts secrets, bounds captured output, and stores handbook content hashes', async () => withWriter(async (_directory, writer) => {
  const secret = 'super-secret-value'
  const bare = 'bare-secret-9472'
  const manual = operationManualReference('operations/runbooks/nginx.md', '# nginx handbook')
  const result = await writer.write(sample({ command: `curl --password=${secret} -H 'Authorization: Bearer ${secret}' https://user:${secret}@host`, manuals: [manual], secrets: [secret, bare],
    observed: { complete: false, markerMatched: false, exitCode: null, output: `\`\`\`text\n${bare}\npassword=${secret}\n${'x'.repeat(400)}` } }))
  const content = await readFile(result.path, 'utf8')
  assert.equal(content.includes(secret), false)
  assert.equal(content.includes(bare), false)
  assert.ok(content.includes(`sha256: ${manual.sha256}`))
  assert.ok(content.length < 1000)
  assert.equal(parse(content.split('---')[1]).manuals[0].sha256, manual.sha256)
  const noManuals = await writer.write(sample({ recordId: 'no-manuals' }))
  assert.deepEqual(parse((await readFile(noManuals.path, 'utf8')).split('---')[1]).manuals, [])
}))

test('writes independent IDs concurrently and atomically upserts one stable ID', async () => withWriter(async (directory, writer) => {
  const [left, right] = await Promise.all([
    writer.write(sample({ recordId: 'left' })),
    writer.write(sample({ recordId: 'right', connectionId: 'web-stage-2' })),
  ])
  assert.notEqual(left.path, right.path)
  await Promise.all([
    writer.write(sample({ recordId: 'shared', intent: 'first value' })),
    writer.write(sample({ recordId: 'shared', intent: 'last value' })),
  ])
  const content = await readFile(join(directory, 'shared.md'), 'utf8')
  assert.ok(content.includes('first value') || content.includes('last value'))
  assert.equal((await readdir(directory)).some(name => name.endsWith('.tmp')), false)
}))
