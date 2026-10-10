/** Optional knowledge API client. Remote documents never grant execution authority. */
export interface RagOptions {
  url: string; token: string; timeoutMs: number; maxResults: number; maxText: number;
}

/** Validates the endpoint before any token can be sent. @param value Base API URL. */
export function validateRagUrl(value: string): URL {
  const url = new URL(value)
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:'
    && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))
    || url.username || url.password || url.search || url.hash) {
    throw new Error('RAG URL requires HTTPS or loopback HTTP, without credentials, query or fragment')
  }
  return url
}

/** Searches the API with bounded output; failures expose no response bodies or credentials.
 * @param query Search text.
 * @param options Validated deployment settings.
 * @param request HTTP transport, injectable for isolated tests.
 * @returns Untrusted excerpts and explicit degradation warnings.
 */
export async function searchRag(query: string, options: RagOptions, request: typeof fetch = fetch) {
  try {
    const base = validateRagUrl(options.url)
    base.pathname = base.pathname.replace(/\/?$/, '/') + 'v1/search'
    const response = await request(base, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(options.timeoutMs),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${options.token}` },
      body: JSON.stringify({ query, limit: Math.min(options.maxResults, 20) }),
    })
    if (!response.ok || !response.body) throw new Error('API unavailable')
    const reader = response.body.getReader()
    const pieces: Uint8Array[] = []
    let size = 0
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        size += value.length
        if (size > 2_000_000) throw new Error('Response too large')
        pieces.push(value)
      }
    } finally { await reader.cancel() }
    const data: unknown = JSON.parse(Buffer.concat(pieces).toString('utf8'))
    if (!data || typeof data !== 'object' || !('items' in data) || !Array.isArray(data.items)) {
      throw new Error('Invalid response')
    }
    const items = data.items.slice(0, options.maxResults).map((value: unknown) => {
      if (!value || typeof value !== 'object') throw new Error('Invalid item')
      const row = value as Record<string, unknown>
      if (typeof row.path !== 'string' || typeof row.text !== 'string') throw new Error('Invalid excerpt')
      return { path: row.path.slice(0, 1000), text: row.text.slice(0, options.maxText),
        title: typeof row.title === 'string' ? row.title.slice(0, 300) : '',
        section: typeof row.section === 'string' ? row.section.slice(0, 300) : '',
        contentHash: typeof row.content_hash === 'string' ? row.content_hash.slice(0, 64) : '',
        ...(Number.isSafeInteger(row.line_start) && Number.isSafeInteger(row.line_end)
          ? { lineStart: row.line_start as number, lineEnd: row.line_end as number } : {}),
        kind: row.kind === 'manual' ? 'manual' : 'record',
        status: row.status === 'verified' || row.status === 'failed' ? row.status : 'unverified',
        untrusted: true as const, source: 'rag' as const }
    })
    const degraded = 'degraded' in data && data.degraded === true
    return { items, warnings: degraded ? ['RAG returned degraded retrieval; inspect knowledge service health.'] : [] }
  } catch {
    // Transport and parser errors may contain sensitive URLs or upstream response bodies.
    return { items: [], warnings: ['RAG unavailable; only local Markdown results are available.'] }
  }
}
