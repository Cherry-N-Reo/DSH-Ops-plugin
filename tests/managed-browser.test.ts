import test from 'node:test'
import assert from 'node:assert/strict'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserContext } from 'playwright'
import { ManagedBrowserDriver } from '../src/managed-browser.ts'

const browser = process.platform === 'win32'
  ? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
  : '/usr/bin/google-chrome'

test('managed browser inputs and reads through its owned page without native focus', async t => {
  if (process.env.CI || (process.platform !== 'win32' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY)) {
    t.skip('A local interactive browser session is required.'); return
  }
  try { await access(browser) } catch { t.skip('A local Chromium executable is not installed.'); return }
  const temporary = await mkdtemp(join(tmpdir(), 'dsh-managed-test-'))
  const html = `<!doctype html><title>Local test shell</title><div id="app"></div><script>
    const values = [];
    const active = { get length() { return values.length; }, getLine(i) { return { translateToString() { return values[i] } } } };
    const term = { buffer: { active }, input(value) {
      if (value === '\\r') { values.push('DSH_BEGIN_local', 'hello', 'DSH_END_local rc=0'); window.line = ''; window.submits = (window.submits || 0) + 1; }
      else window.line = (window.line || '') + value;
    } };
    document.querySelector('#app').__vue__ = { $options: { name: 'shell' }, term: { only: term }, $children: [] };
  </script>`
  const targetUrl = `data:text/html,${encodeURIComponent(html)}`
  const driver = new ManagedBrowserDriver({ targetUrl, runtimeDir: temporary,
    userDataDir: join(temporary, 'profile'), executablePath: browser,
    timeoutMs: 20000, maxChars: 65536, maxAttempts: 2, pollMs: 10 })
  const signal = new AbortController().signal
  try {
    assert.equal((await driver.open(signal)).status, 'ready')
    const identity = await driver.identity(signal)
    assert.equal(identity.processName, 'managed-chromium')
    const context = (driver as unknown as { context: BrowserContext }).context
    const other = await context.newPage()
    await other.setContent('<textarea autofocus></textarea>')
    await other.bringToFront()
    const begin = 'DSH_BEGIN_local'; const end = 'DSH_END_local'
    await driver.arm('test-session', { begin, end }, signal)
    await driver.typeCommand(identity.rect, `printf '${begin}\\nhello\\n${end} rc=0'`, 'unicode', signal)
    await driver.submitCommand(signal)
    assert.equal(await other.evaluate('document.querySelector("textarea").value'), '')
    const reading = await driver.read('test-session', { begin, end }, signal)
    assert.equal(reading.complete, true)
    assert.equal(reading.source, 'xterm-buffer')
    const raw = await driver.readRaw('test-session', signal)
    assert.equal(raw.available, true)
    assert.match(raw.text, /DSH_BEGIN_local/)
    const shot = await driver.screenshot(signal)
    await access(shot.path)
    await driver.releaseScreenshot(shot.path)
    await assert.rejects(access(shot.path))
    assert.equal((await driver.focusTarget(signal, identity)).hwnd, identity.hwnd)
    await assert.rejects(driver.submitCommand(signal), /No managed terminal input/)
    const target = context.pages().find(page => page.url() === targetUrl)
    assert.ok(target)
    await target.goto('about:blank')
    await assert.rejects(driver.focusTarget(signal, identity), /configured URL/)
  } finally {
    await driver.dispose()
    await rm(temporary, { recursive: true, force: true })
  }
})

test('generic xterm textarea receives command and Enter through the managed page', async t => {
  if (process.env.CI || (process.platform !== 'win32' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY)) {
    t.skip('A local interactive browser session is required.'); return
  }
  try { await access(browser) } catch { t.skip('A local Chromium executable is not installed.'); return }
  const temporary = await mkdtemp(join(tmpdir(), 'dsh-managed-key-test-'))
  const html = `<!doctype html><title>Generic shell</title><textarea class="xterm-helper-textarea"></textarea><div class="xterm-rows"><div></div></div><script>
    document.querySelector('textarea').addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        document.querySelector('.xterm-rows div').textContent = event.target.value;
        event.preventDefault();
      }
    });
  </script>`
  const driver = new ManagedBrowserDriver({ targetUrl: `data:text/html,${encodeURIComponent(html)}`,
    runtimeDir: temporary, userDataDir: join(temporary, 'profile'), executablePath: browser,
    timeoutMs: 20000, maxChars: 65536, maxAttempts: 2, pollMs: 10 })
  const signal = new AbortController().signal
  try {
    assert.equal((await driver.open(signal)).status, 'ready')
    const rect = (await driver.identity(signal)).rect
    await driver.typeCommand(rect, 'ls', 'unicode', signal)
    await driver.submitCommand(signal)
    assert.equal((await driver.readRaw('test-session', signal)).text, 'ls')
  } finally {
    await driver.dispose()
    await rm(temporary, { recursive: true, force: true })
  }
})
