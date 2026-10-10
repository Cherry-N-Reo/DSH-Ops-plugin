import test from 'node:test'
import assert from 'node:assert/strict'
import { searchRag, validateRagUrl } from '../src/rag.ts'

const options = { url: 'http://127.0.0.1:8765', token: 'test-token', timeoutMs: 1000,
  maxResults: 3, maxText: 100 }

test('RAG forbids remote plaintext and credential-bearing endpoints', () => {
  for (const url of ['http://example.com', 'https://u:p@example.com', 'https://example.com/?token=x']) {
    assert.throws(() => validateRagUrl(url))
  }
  assert.equal(validateRagUrl(options.url).hostname, '127.0.0.1')
})

test('RAG returns bounded untrusted excerpts and sends a bounded authenticated query', async () => {
  const request: typeof fetch = async (url, init) => {
    assert.equal(String(url), 'http://127.0.0.1:8765/v1/search')
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer test-token')
    assert.deepEqual(JSON.parse(String(init?.body)), { query: 'kubectl nodes', limit: 3 })
    assert.equal(init?.redirect, 'error')
    return Response.json({ items: [{ path: 'records/check.md', text: 'x'.repeat(200), status: 'failed' }], degraded: true })
  }
  const result = await searchRag('kubectl nodes', options, request)
  assert.equal(result.items[0].text.length, 100)
  assert.equal(result.items[0].untrusted, true)
  assert.equal(result.items[0].status, 'failed')
  assert.equal(result.warnings.length, 1)
})

test('RAG errors and malformed responses do not leak provider bodies', async () => {
  for (const response of [new Response('secret', { status: 401 }), Response.json({ items: [null] }),
    new Response('x'.repeat(2_000_001))]) {
    const result = await searchRag('query', options, async () => response)
    assert.deepEqual(result.items, [])
    assert.equal(JSON.stringify(result).includes('secret'), false)
    assert.equal(result.warnings.length, 1)
  }
})
