import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import test from 'node:test'

test('built client bundle registers the SRE row settings page', async () => {
  const bundle = await readFile(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf8')
  const require = createRequire(import.meta.url)
  let registration: { id: string; factory: (requireModule: (id: string) => unknown) => { apply: (ctx: unknown) => void } } | undefined
  runInNewContext(bundle, {
    window: { __ModuleLoader__: { load: (value: typeof registration) => { registration = value } } },
    Symbol,
  })
  assert.equal(registration?.id, 'dsh-sre-webshell')
  assert.ok(registration)
  const client = registration.factory(id => {
    assert.ok(id === 'react' || id === 'react/jsx-runtime')
    return require(id)
  })
  assert.equal(typeof client.apply, 'function')

  let row: { name: string; key: string; locale: string } | undefined
  const scope = { getSnapshot: () => ({ status: 'ready', value: { ragUrl: '', ragTokenEnv: 'DSH_RAG_API_TOKEN', ragTimeoutMs: 65000 } }), subscribe: () => () => {} }
  const ctx = {
    effect: (install: () => unknown) => { install() },
    locale: { register: () => () => {} },
    settingsScope: { bind: (spec: { namespace: string }) => { assert.equal(spec.namespace, 'sre-webshell'); return scope } },
    slots: {
      inject: (slot: string, install: () => unknown) => { assert.equal(slot, 'plugins.row.config'); install() },
      register: (options: typeof row) => { row = options; return () => {} },
    },
  }
  client.apply(ctx)
  assert.equal(row?.name, 'plugins.row.config')
  assert.equal(row?.key, 'dsh-sre-webshell#sre-webshell')
  assert.equal(row?.locale, 'sre.ops')
})
