import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

test('built plugin boots in a real authenticated Web profile on an OS-assigned port', { timeout: 60000 }, async () => {
  const pluginRoot = fileURLToPath(new URL('..', import.meta.url))
  const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
  const runtime = join(pluginRoot, '.runtime')
  await mkdir(runtime, { recursive: true })
  const scratch = await mkdtemp(join(runtime, 'web-acceptance-'))
  const child = spawn(join(repoRoot, '.runtime/node-v22.23.2-win-x64/node.exe'), [
    join(repoRoot, 'apps/cli/lib/bin.js'), '--profile', 'web',
    '--patch', join(pluginRoot, 'local.patch.yml'), '--patch', join(pluginRoot, 'tests/fixtures/web-startup.patch.yml'), '--no-open',
  ], { cwd: scratch, windowsHide: true, env: {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(key|secret|token|password|DSH_HOME|DSH_TOOLS_MODE)/i.test(key))),
    DSH_HOME: join(scratch, 'home'),
  } })
  let output = '', errorOutput = '', readyResolve!: (url: string) => void, readyReject!: (error: Error) => void
  const ready = new Promise<string>((resolve, reject) => { readyResolve = resolve; readyReject = reject })
  const exited = new Promise<void>(resolve => child.once('close', () => { readyReject(new Error('Web profile exited before readiness: ' + errorOutput.slice(0, 4096))); resolve() }))
  child.once('error', () => readyReject(new Error('Web profile could not start.')))
  child.stdout.on('data', chunk => {
    output += String(chunk)
    if (output.length > 1048576) { readyReject(new Error('Web startup output exceeded budget.')); child.kill() }
    const match = output.match(/dsh web: (http:\/\/127\.0\.0\.1:[0-9]+\/\?token=[^\s]+)/)
    if (match) readyResolve(match[1])
  })
  child.stderr.on('data', chunk => { errorOutput += String(chunk); if (errorOutput.length > 1048576) { readyReject(new Error('Web error output exceeded budget.')); child.kill() } })
  const deadline = setTimeout(() => { readyReject(new Error('Web readiness deadline exceeded.')); child.kill() }, 45000)
  try {
    const url = await ready
    const parsed = new URL(url)
    const unauthorized = await fetch(parsed.origin, { signal: AbortSignal.timeout(5000) })
    assert.ok([401, 403].includes(unauthorized.status))
    const exchange = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(5000) })
    assert.equal(exchange.status, 303)
    const cookie = exchange.headers.get('set-cookie')?.split(';', 1)[0]
    assert.ok(cookie)
    const authorized = await fetch(parsed.origin, { headers: { cookie }, signal: AbortSignal.timeout(5000) })
    assert.equal(authorized.status, 200)
    assert.match(await authorized.text(), /<html/i)
    assert.doesNotMatch(errorOutput, /failed|error|unresolved|requires Windows/i)
  } finally {
    clearTimeout(deadline)
    child.kill()
    await exited
    await rm(scratch, { recursive: true, force: true })
  }
})
