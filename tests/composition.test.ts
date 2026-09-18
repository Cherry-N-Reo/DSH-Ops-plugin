import { mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import Loader from '@deepseek-ai/cordis-plugin-loader'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const pluginRoot = fileURLToPath(new URL('..', import.meta.url))
const node = join(repoRoot, '.runtime', 'node-v22.23.2-win-x64', 'node.exe')
const bin = join(repoRoot, 'apps', 'cli', 'lib', 'bin.js')
const localPatch = join(pluginRoot, 'local.patch.yml')
const compositionPatch = join(pluginRoot, 'tests', 'fixtures', 'composition.patch.yml')
const guardPatch = join(pluginRoot, 'tests', 'fixtures', 'composition-guard.patch.yml')
const mockPath = join(pluginRoot, 'tests', 'fixtures', 'composition-mock-llm.mjs')
const expectedPath = join(pluginRoot, 'tests', 'fixtures', 'composition-expected.json')
const operationsDir = join(pluginRoot, 'operations')
const runtimeRoot = join(pluginRoot, '.runtime')

interface JsonObject { [key: string]: unknown }
interface RunResult { code: number; stdout: string; stderr: string; timedOut: boolean }

function runDsh(options: { cwd: string; sessionRoot: string; home: string; sentinel: string; patches?: string[]; guard?: boolean; entry?: string }): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const args = [options.entry ?? bin, '--profile', 'headless', ...(options.patches ?? [localPatch, compositionPatch]).flatMap(patch => ['--patch', patch]), '--json', 'Exercise the SRE composition tools.']
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(KEY|SECRET|TOKEN|PASSWORD)/i.test(key)))
    const child = spawn(node, args, {
      cwd: options.cwd,
      env: {
        ...inherited,
        DSH_HOME: options.home,
        DSH_COMPOSITION_MOCK_PATH: mockPath,
        DSH_COMPOSITION_OPERATIONS_DIR: operationsDir,
        DSH_COMPOSITION_CONNECTIONS_FILE: join(pluginRoot, 'tests', 'fixtures', 'connections.json'),
        DSH_COMPOSITION_SESSION_ROOT: options.sessionRoot,
        DSH_COMPOSITION_SENTINEL: options.sentinel,
        DSH_TELEMETRY_DISABLED: '1',
        ...(options.guard ? { DSH_COMPOSITION_GUARD: '1', DSH_PERMISSION_MODE: 'danger-full-access' } : {}),
      } as NodeJS.ProcessEnv,
      windowsHide: true,
    })
    let stdout = '', stderr = '', settled = false, timedOut = false
    const finish = (code: number): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, stdout, stderr, timedOut })
    }
    const stop = (code: number): void => {
      if (settled) return
      timedOut = true
      child.kill()
      child.once('close', () => finish(code))
    }
    const append = (target: 'stdout' | 'stderr', chunk: string): void => {
      const next = target === 'stdout' ? stdout + chunk : stderr + chunk
      if (next.length > 1_048_576) { stop(125); return }
      if (target === 'stdout') stdout = next
      else stderr = next
    }
    const timer = setTimeout(() => stop(124), 30_000)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => append('stdout', chunk))
    child.stderr.on('data', chunk => append('stderr', chunk))
    child.once('error', reject)
    child.once('close', code => finish(code ?? -1))
  })
}

async function filesUnder(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  const files: string[] = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await filesUnder(path))
    else files.push(path)
  }
  return files
}

async function readLogs(rootPath: string): Promise<JsonObject[]> {
  const records: JsonObject[] = []
  for (const path of (await filesUnder(rootPath)).filter(path => path.endsWith('.jsonl'))) {
    for (const line of (await readFile(path, 'utf8')).trim().split('\n')) if (line.length > 0) records.push(JSON.parse(line) as JsonObject)
  }
  return records
}

function toolResultText(record: JsonObject): string {
  const data = record.data as JsonObject
  const message = data.message as JsonObject
  const result = (message.content as JsonObject[])[0]
  const text = ((result.content as JsonObject[])[0]).text
  if (typeof text !== 'string') throw new Error('persisted tool result has no text payload')
  return text
}

async function fixtureRoots(label: string): Promise<{ cwd: string; sessionRoot: string; home: string; sentinel: string }> {
  await mkdir(runtimeRoot, { recursive: true })
  const cwd = await mkdtemp(join(runtimeRoot, `${label}-cwd-`))
  const sessionRoot = await mkdtemp(join(runtimeRoot, `${label}-session-`))
  const home = await mkdtemp(join(runtimeRoot, `${label}-home-`))
  return { cwd, sessionRoot, home, sentinel: join(cwd, 'shell-sentinel') }
}

async function removeRoots(roots: { cwd: string; sessionRoot: string; home: string }): Promise<void> {
  await Promise.all(Object.values(roots).map(path => rm(path, { recursive: true, force: true })))
}

describe('sre-webshell real DSH composition', () => {
  it('runs tools through the launcher-selected built CLI without a source loader', async () => {
    // A source CLI and built registry create distinct scheduler symbols before tool dispatch.
    const launcher = await readFile(join(pluginRoot, 'Start-SRE.ps1'), 'utf8')
    const selected = launcher.match(/\$cli = Join-Path \$dshRoot '([^']+)'/)
    assert.ok(selected, 'launcher must explicitly select the built DSH CLI')
    assert.equal(selected[1], 'apps/cli/lib/bin.js')
    assert.match(launcher, /\$launchArgs = @\(\$cli, '--profile', 'sre'\)/)
    assert.match(launcher, /& \(Join-Path \$nodeRoot 'node\.exe'\) @launchArgs/)
    const roots = await fixtureRoots('launcher-composition')
    try {
      const result = await runDsh({ ...roots, entry: join(repoRoot, selected[1]!) })
      assert.equal(result.timedOut, false)
      assert.equal(result.code, 0, result.stderr || result.stdout)
      const results = (await readLogs(roots.sessionRoot)).filter(record => record.type === 'tool/result')
      assert.equal(results.length, 6, result.stderr || result.stdout)
      const expected = JSON.parse(await readFile(expectedPath, 'utf8')) as JsonObject
      assert.deepEqual(JSON.parse(toolResultText(results[0] as JsonObject)), expected.asset)
      assert.deepEqual(JSON.parse(toolResultText(results[1] as JsonObject)), expected.runbook)
    } finally { await removeRoots(roots) }
  }, 120_000)
  it('keeps the built namespace, inject list, schema, and R4 policy', async () => {
    const module = await import(pathToFileURL(join(pluginRoot, 'lib', 'index.js')).href)
    assert.equal('default' in module, false)
    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(module) as Record<string, unknown>
    assert.equal(unwrapped, module)
    assert.equal(unwrapped.name, 'sre-webshell')
    assert.deepEqual(unwrapped.inject, ['tools', 'approval', 'credentials', 'attachments', 'llm'])
    const schema = (unwrapped.Config as { toJSON?: () => unknown }).toJSON?.()
    assert.match(JSON.stringify(schema), /operationsDir/)
    const policy = await import(pathToFileURL(join(pluginRoot, 'lib', 'policy.js')).href)
    assert.equal(policy.classify('rm -rf /', { id: 'sample-web-staging', environment: 'staging', criticality: 'high', profile: 'linux', services: ['nginx'], runbooks: ['runbooks/nginx.md'], credentials: {} }).risk, 'R4')
  })

  it('persists canonical asset, runbook, schemas, and disabled denial results', async () => {
    const roots = await fixtureRoots('composition')
    try {
      const result = await runDsh(roots)
      assert.equal(result.code, 0, result.stderr || result.stdout)
      assert.equal(result.timedOut, false)
      assert.equal(result.stderr, '')
      assert.deepEqual(JSON.parse(result.stdout.trim().split('\n').at(-1)!) as JsonObject, { type: 'final', text: 'composition complete' })
      const expected = JSON.parse(await readFile(expectedPath, 'utf8')) as JsonObject
      const records = await readLogs(roots.sessionRoot)
      const events = records.filter(record => typeof record.type === 'string')
      const calls = events.filter(record => record.type === 'tool/call')
      assert.deepEqual(calls.map(record => (record.data as JsonObject).name), ['asset_lookup', 'runbook_search', 'terminal_execute', 'connection_list', 'terminal_input_check', 'terminal_scroll'])
      const header = ((events.find(record => record.type === 'request/header')?.data as JsonObject).header as JsonObject)
      const tools = header.tools as JsonObject[]
      assert.deepEqual(tools.filter(tool => ['asset_lookup', 'runbook_search', 'terminal_execute', 'terminal_collect'].includes(String(tool.name))).map(tool => tool.name), ['asset_lookup', 'runbook_search', 'terminal_collect', 'terminal_execute'])
      const skillTool = tools.find(tool => tool.name === 'skill')
      assert.ok(skillTool)
      assert.deepEqual((skillTool.parameters as JsonObject).required, ['name'])
      const results = events.filter(record => record.type === 'tool/result')
      assert.deepEqual(JSON.parse(toolResultText(results[0] as JsonObject)), expected.asset)
      assert.deepEqual(JSON.parse(toolResultText(results[1] as JsonObject)), expected.runbook)
      assert.equal(toolResultText(results[2] as JsonObject), expected.terminalDisabled)
      assert.deepEqual(JSON.parse(toolResultText(results[3] as JsonObject)), expected.connections)
      assert.equal(toolResultText(results[4] as JsonObject), expected.terminalDisabled)
      assert.equal(toolResultText(results[5] as JsonObject), expected.terminalDisabled)
      const inputTool = tools.find(tool => tool.name === 'terminal_input_check')!
      assert.deepEqual((inputTool.parameters as JsonObject).required,
        ['observationId', 'inputText', 'idlePrompt', 'fullInputVisible', 'candidateVisible', 'confident'])
      assert.match(String(inputTool.description), /three Unicode attempts/)
      assert.ok(tools.some(tool => tool.name === 'terminal_scroll'))
      assert.equal(tools.some(tool => tool.name === 'terminal_calibrate'), false)
      const bindSchema = tools.find(tool => tool.name === 'terminal_bind')!.parameters as JsonObject
      assert.equal((bindSchema.required as string[]).includes('assetId'), false)
      assert.equal(results.some(record => toolResultText(record).includes('DEEPSEEK_API_KEY')), false)
      assert.equal(JSON.stringify(records).includes('fixture-only-web-password'), false)
      assert.equal(JSON.stringify(records).includes('fixture-only-ssh-password'), false)
    } finally { await removeRoots(roots) }
  }, 120_000)

  it('keeps the exclusive guard ahead of a permissive prepend fixture in full-access mode', async () => {
    const roots = await fixtureRoots('guard')
    try {
      const result = await runDsh({ ...roots, guard: true, patches: [localPatch, compositionPatch, guardPatch] })
      assert.equal(result.code, 0, result.stderr || result.stdout)
      assert.equal(result.timedOut, false)
      assert.equal(result.stderr, '')
      const records = await readLogs(roots.sessionRoot)
      const results = records.filter(record => record.type === 'tool/result')
      assert.equal(toolResultText(results[0] as JsonObject), 'Error: Exclusive SRE profile: generic execution, filesystem, clipboard and desktop tools cannot bypass SRE policy.')
      assert.equal((await stat(roots.sentinel).catch(() => undefined)), undefined)
      assert.match(JSON.stringify(records), /"preset":"danger-full-access"/)
    } finally { await removeRoots(roots) }
  }, 120_000)
})
