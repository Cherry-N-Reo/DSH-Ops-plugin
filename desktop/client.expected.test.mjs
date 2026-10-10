/** Built Client smoke; run after desktop/Build.ps1, using the staged React runtime. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import { join } from 'node:path'

const require = createRequire(new URL('../../.runtime/desktop-migration/source/apps/desktop/package.json', import.meta.url))
const { renderToStaticMarkup } = require('react-dom/server')

test('built settings page registers the Config row and renders live RAG values without a token field', () => {
  let client
  const bundle = process.env.DSH_DESKTOP_PLUGIN_STAGE
    ? join(process.env.DSH_DESKTOP_PLUGIN_STAGE, 'lib/client.js')
    : new URL('../../.runtime/desktop-migration/plugin/lib/client.js', import.meta.url)
  vm.runInNewContext(readFileSync(bundle, 'utf8'), {
    window: { __ModuleLoader__: { load({ id, factory }) { assert.equal(id, 'dsh-sre-webshell'); client=factory(require) } } },
  })
  let renderer, dictionary
  const ctx = {
    effect: effect => effect(),
    locale: { register(namespace, value) { assert.equal(namespace, 'sre.desktop'); dictionary=value; return () => {} } },
    slots: {
      inject(name, effect) { assert.equal(name, 'plugins.row.config'); return effect() },
      register(item, render) { assert.equal(item.key, 'dsh-sre-webshell#sre-webshell'); renderer=render; return () => {} },
    },
  }
  client.apply(ctx)
  const props = { view:'detail', t:key=>dictionary.en[key], form:{state:{status:'ready',revision:'one',writable:true,value:{ragUrl:'http://127.0.0.1:8099',ragTokenEnv:'RAG_TEST_REF',ragTimeoutMs:9000}}} }
  const markup = renderToStaticMarkup(renderer(props))
  assert.match(markup, /http:\/\/127\.0\.0\.1:8099/)
  assert.match(markup, /RAG_TEST_REF/)
  assert.match(markup, /value="9000"/)
  assert.equal((markup.match(/<input/g) ?? []).length, 3)
  assert.doesNotMatch(markup, /type="password"/)
  props.form.state.writable=false
  assert.match(renderToStaticMarkup(renderer(props)), /disabled=""/)
  props.form.state.status='loading'
  assert.match(renderToStaticMarkup(renderer(props)), /Configuration unavailable/)
  props.t=key=>dictionary.zh[key]
  assert.match(renderToStaticMarkup(renderer(props)), /配置不可用/)
})
