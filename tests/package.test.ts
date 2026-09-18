import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { profile } from '../src/profiles.ts'

test('community backend scripts are byte-identical to reviewed pinned files', async () => {
  const base = new URL('../', import.meta.url)
  const pins = JSON.parse(await readFile(new URL('dependency-pins.json', base), 'utf8'))
  for (const [file, expected] of [['input.ps1', pins['computer-user'].inputSha256], ['capture.ps1', pins['computer-user'].captureSha256]]) {
    const bytes = await readFile(new URL(`third-party/computer-user/${file}`, base))
    assert.equal(createHash('sha256').update(bytes).digest('hex'), expected)
  }
})
test('operator-owned profile uses only the controlled POSIX interaction path', async () => {
  const path = new URL('../operations/inventory/terminal-profiles.yaml', import.meta.url)
  const { fileURLToPath } = await import('node:url')
  assert.equal((await profile(fileURLToPath(path), 'linux')).shell, 'posix')
  await assert.rejects(profile(fileURLToPath(path), 'unknown'))
})
