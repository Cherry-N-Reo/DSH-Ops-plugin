import test from 'node:test'
import assert from 'node:assert/strict'
import { InputFlow, type InputReading } from '../src/input.ts'

function fixture(maxAttempts = 3) {
  let shots = 0, submitted = 0
  const typed: Array<{ text: string; mode: string }> = []
  const audit: Record<string, unknown>[] = []
  const backend = {
    observe: async () => ({ id: `shot-${++shots}` }),
    type: async (text: string, mode: 'unicode' | 'keyboard') => { typed.push({ text, mode }) },
    submit: async () => { submitted++ },
    audit: async (event: Record<string, unknown>) => { audit.push(event) },
  }
  const flow = new InputFlow(backend, maxAttempts), signal = new AbortController().signal
  const reading = (id: string, inputText = '', extra: Partial<InputReading> = {}): InputReading => ({
    observationId: id, inputText, idlePrompt: true, fullInputVisible: true,
    candidateVisible: false, confident: true, ...extra,
  })
  return { flow, signal, backend, typed, audit, reading, submitted: () => submitted }
}

test('baseline observation sends no input; exact Unicode echo sends one separate Enter', async () => {
  const f = fixture(), baseline = await f.flow.start('s', 'ls', f.signal)
  assert.equal(f.typed.length, 0); assert.equal(baseline.phase, 'baseline')
  const attempt = await f.flow.check('s', f.reading(baseline.observation.id), f.signal)
  assert.equal(attempt.submitted, false); assert.equal(f.submitted(), 0)
  assert.deepEqual(f.typed, [{ text: 'ls', mode: 'unicode' }])
  const done = await f.flow.check('s', f.reading('shot-2', 'ls'), f.signal)
  assert.equal(done.submitted, true); assert.equal(f.submitted(), 1)
  await assert.rejects(f.flow.check('s', f.reading('shot-2', 'ls'), f.signal), /INPUT_NOT_PENDING/)
})

test('three visually verified empty Unicode failures allow exactly one physical-key fallback', async () => {
  const f = fixture(); await f.flow.start('s', 'ls', f.signal)
  for (let i = 1; i <= 4; i++) await f.flow.check('s', f.reading(`shot-${i}`), f.signal)
  assert.deepEqual(f.typed.map(v => v.mode), ['unicode', 'unicode', 'unicode', 'keyboard'])
  assert.equal(f.submitted(), 0)
  await f.flow.check('s', f.reading('shot-5', 'ls'), f.signal)
  assert.equal(f.submitted(), 1)
})

test('failed keyboard fallback never causes a fifth input attempt', async () => {
  const f = fixture(); await f.flow.start('s', 'ls', f.signal)
  for (let i = 1; i <= 4; i++) await f.flow.check('s', f.reading(`shot-${i}`), f.signal)
  await assert.rejects(f.flow.check('s', f.reading('shot-5'), f.signal), /KEYBOARD_NOT_ACCEPTED/)
  assert.equal(f.typed.length, 4); assert.equal(f.submitted(), 0)
})

test('partial or different Unicode echo locks input without clearing, appending, fallback, or Enter', async () => {
  for (const echo of ['l', 'lsls', 'ｌｓ', '用户输入']) {
    const f = fixture(); await f.flow.start('s', 'ls', f.signal)
    await f.flow.check('s', f.reading('shot-1'), f.signal)
    await assert.rejects(f.flow.check('s', f.reading('shot-2', echo), f.signal), /INPUT_UNCERTAIN/)
    assert.equal(f.typed.length, 1); assert.equal(f.submitted(), 0)
    await assert.rejects(f.flow.check('s', f.reading('shot-2'), f.signal), /INPUT_NOT_PENDING/)
    const blocked = await f.flow.observe('s', f.signal)
    assert.equal(blocked.phase, 'blocked')
    assert.match(blocked.instruction, /Do not call terminal_input_check/)
    assert.match(blocked.instruction, /confirm recovery through terminal_bind/)
    assert.equal(f.typed.length, 1); assert.equal(f.submitted(), 0)
  }
})

test('existing user input in baseline is preserved and blocks all injection', async () => {
  const f = fixture(); await f.flow.start('s', 'ls', f.signal)
  await assert.rejects(f.flow.check('s', f.reading('shot-1', 'kubectl '), f.signal), /INPUT_UNCERTAIN/)
  assert.equal(f.typed.length, 0); assert.equal(f.submitted(), 0)
})

test('uncertain, busy, hidden, and IME candidate readings refuse input', async () => {
  for (const flags of [{ confident: false }, { idlePrompt: false }, { fullInputVisible: false }, { candidateVisible: true }]) {
    const f = fixture(); await f.flow.start('s', 'ls', f.signal)
    await assert.rejects(f.flow.check('s', f.reading('shot-1', '', flags), f.signal), /INPUT_UNCERTAIN/)
    assert.equal(f.typed.length, 0); assert.equal(f.submitted(), 0)
  }
})

test('input-helper timeout with a full echo does not replay characters', async () => {
  const f = fixture()
  f.backend.type = async (text, mode) => { f.typed.push({ text, mode }); throw new Error('timeout after input') }
  await f.flow.start('s', 'ls', f.signal)
  await f.flow.check('s', f.reading('shot-1'), f.signal)
  await f.flow.check('s', f.reading('shot-2', 'ls'), f.signal)
  assert.equal(f.typed.length, 1); assert.equal(f.submitted(), 1)
})

test('input-helper failure with an empty echo is uncertain, not permission to retry', async () => {
  const f = fixture()
  f.backend.type = async () => { throw new Error('input helper stopped') }
  await f.flow.start('s', 'ls', f.signal)
  await f.flow.check('s', f.reading('shot-1'), f.signal)
  await assert.rejects(f.flow.check('s', f.reading('shot-2'), f.signal), /INPUT_HELPER_UNCERTAIN/)
  assert.equal(f.submitted(), 0)
})

test('refresh invalidates old screenshot IDs without resending input', async () => {
  const f = fixture(); await f.flow.start('s', 'ls', f.signal)
  await f.flow.observe('s', f.signal)
  await assert.rejects(f.flow.check('s', f.reading('shot-1'), f.signal), /INPUT_OBSERVATION_STALE/)
  await f.flow.check('s', f.reading('shot-2'), f.signal)
  assert.equal(f.typed.length, 1)
})

test('Enter failure cannot trigger another Enter or another injection', async () => {
  const f = fixture()
  f.backend.submit = async () => { throw new Error('uncertain Enter') }
  await f.flow.start('s', 'ls', f.signal)
  await f.flow.check('s', f.reading('shot-1'), f.signal)
  await assert.rejects(f.flow.check('s', f.reading('shot-2', 'ls'), f.signal), /uncertain Enter/)
  assert.equal(f.flow.has('s'), false)
  await assert.rejects(f.flow.check('s', f.reading('shot-2', 'ls'), f.signal), /INPUT_NOT_PENDING/)
  assert.equal(f.typed.length, 1)
})

test('aborted verification sends neither characters nor Enter', async () => {
  const f = fixture(), control = new AbortController()
  await f.flow.start('s', 'ls', f.signal); control.abort()
  await assert.rejects(f.flow.check('s', f.reading('shot-1'), control.signal), { name: 'AbortError' })
  assert.equal(f.typed.length, 0); assert.equal(f.submitted(), 0)
})

test('session input state is isolated and operator recovery clears only its owner', async () => {
  const f = fixture(); await f.flow.start('a', 'ls', f.signal); await f.flow.start('b', 'pwd', f.signal)
  f.flow.clear('a'); assert.equal(f.flow.has('a'), false); assert.equal(f.flow.has('b'), true)
  await f.flow.check('b', f.reading('shot-2'), f.signal)
  assert.deepEqual(f.typed, [{ text: 'pwd', mode: 'unicode' }])
})

test('attempt count is configurable and input audit does not contain command text', async () => {
  const f = fixture(1); await f.flow.start('s', 'printf secret-marker', f.signal)
  await f.flow.check('s', f.reading('shot-1'), f.signal)
  await f.flow.check('s', f.reading('shot-2'), f.signal)
  assert.deepEqual(f.typed.map(v => v.mode), ['unicode', 'keyboard'])
  assert.equal(JSON.stringify(f.audit).includes('secret-marker'), false)
  assert.throws(() => fixture(4)); assert.throws(() => fixture(0))
  await assert.rejects(f.flow.start('x', 'ls\nrm', f.signal), /control characters/)
})
