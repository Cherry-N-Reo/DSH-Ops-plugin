import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WindowsDriver } from '../src/windows.js'

const execFileAsync = promisify(execFile)
const pluginDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const bridgePath = join(pluginDir, 'scripts', 'bridge.ps1')
const hasWindows = process.platform === 'win32'

test('rejects invalid options and geometry before desktop work', async () => {
  assert.throws(() => new WindowsDriver({ runtimeDir: '', timeoutMs: 1, settleMs: 0, browserProcesses: ['chrome'] }))
  const driver = new WindowsDriver({ runtimeDir: join(pluginDir, '.test-runtime'), timeoutMs: 100, settleMs: 0, browserProcesses: ['chrome'] })
  assert.throws(() => driver.copy({ x: 0, y: 0, width: 0, height: 1 }, new AbortController().signal))
  await assert.rejects(driver.scroll({ x: 0, y: 0, width: 1, height: 1 }, 1.5, new AbortController().signal))
  await driver.dispose()
})

test('rejects operations after quiescent dispose', async () => {
  const driver = new WindowsDriver({ runtimeDir: join(pluginDir, '.test-runtime'), timeoutMs: 100, settleMs: 0, browserProcesses: ['chrome'] })
  await driver.dispose()
  await assert.rejects(driver.scroll({ x: 0, y: 0, width: 1, height: 1 }, 1, new AbortController().signal), /disposed/)
  await driver.dispose()
})

test('rejects an already-aborted signal without starting a helper', async () => {
  const driver = new WindowsDriver({ runtimeDir: join(pluginDir, '.test-runtime'), timeoutMs: 100, settleMs: 0, browserProcesses: ['chrome'] })
  const controller = new AbortController(); controller.abort()
  await assert.rejects(driver.scroll({ x: 0, y: 0, width: 1, height: 1 }, 1, controller.signal), error => (error as Error).name === 'AbortError')
  await driver.dispose()
})

test('bridge keeps upstream invocation and PowerShell automatic-variable contracts', async () => {
  const bridge = await readFile(bridgePath, 'utf8')
  assert.doesNotMatch(bridge, /\$pid\s*=/i)
  assert.match(bridge, /\$backend\s+-Json\s+\$encoded/)
  assert.match(bridge, /ReadToEnd\(\)/)
  assert.match(bridge, /\[Console\]::InputEncoding = \[System\.Text\.Encoding\]::UTF8/)
  // Windows PowerShell 5.1 reads BOM-less files as ANSI; localized labels must be ASCII escapes.
  assert.doesNotMatch(bridge, /[^\x00-\x7f]/)
  if (!hasWindows) return
  const { stdout } = await execFileAsync(process.env.SystemRoot + '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `[scriptblock]::Create((Get-Content -Raw '${bridgePath.replaceAll("'", "''")}')) | Out-Null; 'ok'`])
  assert.equal(stdout.trim(), 'ok')
})

test('native command bridge compiles correct SendInput records without controlling the desktop', { skip: !hasWindows }, async () => {
  const command = `$source=[IO.File]::ReadAllText('${bridgePath.replaceAll("'", "''")}');$tokens=$null;$errors=$null;$ast=[System.Management.Automation.Language.Parser]::ParseInput($source,[ref]$tokens,[ref]$errors);$code=$ast.Find({param($item) $item -is [System.Management.Automation.Language.StringConstantExpressionAst] -and $item.Value.Contains('public static class DshWin')},$true);Add-Type -TypeDefinition $code.Value -ErrorAction Stop;[Runtime.InteropServices.Marshal]::SizeOf([type][DshKeys+IN])`
  const { stdout } = await execFileAsync(process.env.SystemRoot + '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command])
  assert.equal(Number(stdout.trim()), process.arch === 'x64' ? 40 : 28)
})

test('Unicode and physical input are distinct non-clipboard operations and Enter is separate', async () => {
  const calls: Record<string, unknown>[] = []
  const identity = { ok: true, hwnd: '0x123', pid: 10, processName: 'chrome', title: 'terminal', rect: { x: 0, y: 0, width: 800, height: 600 } }
  const driver = new WindowsDriver({ runtimeDir: pluginDir, timeoutMs: 1000, settleMs: 0,
    browserProcesses: ['chrome'], targetUrl: 'https://example.invalid/#/shell', typingIntervalMs: 0 },
  async payload => { calls.push(payload); return payload.action === 'identity' ? identity : { ok: true } })
  try {
    const signal = new AbortController().signal, rect = { x: 10, y: 20, width: 600, height: 400 }
    await driver.typeCommand(rect, 'ls -l', 'unicode', signal)
    await driver.typeCommand(rect, 'printf "a!$?\\"', 'keyboard', signal)
    const inputs = calls.filter(call => call.action === 'command-input')
    assert.deepEqual(inputs.map(call => call.mode), ['unicode', 'keyboard'])
    assert.ok(inputs.every(call => call.targetUrl === 'https://example.invalid/#/shell' && call.typingIntervalMs === 0))
    assert.equal(calls.some(call => String(call.action).startsWith('clipboard')), false)
    assert.equal(calls.some(call => call.action === 'command-submit'), false)
    await driver.submitCommand(signal)
    assert.equal(calls.filter(call => call.action === 'command-submit').length, 1)
    const count = calls.length
    await assert.rejects(driver.typeCommand(rect, '中文', 'keyboard', signal), /ASCII/)
    await assert.rejects(driver.typeCommand(rect, 'ls\n', 'unicode', signal), /single line/)
    assert.equal(calls.length, count)
  } finally { await driver.dispose() }
})

test('real bridge identity smoke is read-only', { skip: !hasWindows }, async () => {
  const powershell = process.env.SystemRoot + '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
  const command = "$t=Add-Type -PassThru -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class F{[DllImport(\"user32.dll\")]public static extern IntPtr GetForegroundWindow();[DllImport(\"user32.dll\")]public static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);}';$p=[uint32]0;[F]::GetWindowThreadProcessId([F]::GetForegroundWindow(),[ref]$p)|Out-Null;(Get-Process -Id $p).ProcessName"
  const { stdout: nameOutput } = await execFileAsync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command])
  const processName = nameOutput.trim()
  assert.ok(processName)
  const { stdout: namesOutput } = await execFileAsync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '(Get-Process).ProcessName | Sort-Object -Unique'])
  const allowedNames = namesOutput.split(/\r?\n/).map(name => name.trim()).filter(Boolean)
  assert.ok(allowedNames.includes(processName))
  const child = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', bridgePath], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  let stdout = ''; child.stdout.on('data', chunk => { stdout += String(chunk) })
  child.stdin.end(JSON.stringify({ action: 'identity', browserProcesses: allowedNames }))
  const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
  assert.equal(code, 0)
  const result = JSON.parse(stdout) as Record<string, unknown>
  assert.equal(result.ok, true)
  // The user may switch foreground apps between independent observations. Validate this observation itself.
  assert.ok(typeof result.processName === 'string' && allowedNames.includes(result.processName))
  assert.ok(typeof result.pid === 'number' && result.pid > 0)
  assert.match(String(result.hwnd), /^0x[0-9A-F]+$/)
})
