import test from 'node:test'
import assert from 'node:assert/strict'
import { confirmSensitive } from '../src/desktop-approval.ts'

test('sensitive confirmation asks with Deny first and accepts only the exact explicit Allow choice', async () => {
  const decision = await confirmSensitive(async request => {
    const question = request.questions[0]
    assert.equal(question.options?.[0].label, '拒绝 / Deny')
    assert.equal(question.question, 'Restart nginx on the selected server')
    return { answers: [{ id: question.id, selected: ['允许本次 / Allow once'] }] }
  }, {}, 'Restart nginx on the selected server')
  assert.equal(decision.allowed, true)
})

test('denial, free text, stale ids, multiple choices and empty answers cannot grant permission', async () => {
  for (const kind of ['deny', 'custom', 'stale', 'multiple', 'empty']) {
    const decision = await confirmSensitive(async request => {
      const question = request.questions[0]
      if (kind === 'empty') return { answers: [] }
      return { answers: [{ id: kind === 'stale' ? 'previous-question' : question.id,
        selected: kind === 'deny' ? ['拒绝 / Deny'] : kind === 'multiple' ? ['允许本次 / Allow once', '拒绝 / Deny'] : ['允许本次 / Allow once'],
        ...(kind === 'custom' ? { custom: 'approve' } : {}) }] }
    }, {}, 'Sensitive action')
    assert.equal(decision.allowed, false, kind)
  }
})

test('unavailable, delegated or cancelled answer services propagate rejection, never granting permission', async () => {
  for (const message of ['NO_PROVIDER', 'DELEGATED_CALLER', 'ASK_ABORTED']) {
    await assert.rejects(confirmSensitive(async () => { throw new Error(message) }, {}, 'Sensitive action'), new RegExp(message))
  }
})
