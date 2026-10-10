/** RAG connection settings on the external bundle's Plugins row. */
import { useEffect, useState, useSyncExternalStore, type FormEvent } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'

interface RagSettings {
  ragUrl: string
  ragTokenEnv: string
  ragTimeoutMs: number
}

type Key = 'summary' | 'endpoint' | 'endpointHint' | 'timeout' | 'timeoutHint' | 'reference'
  | 'referenceHint' | 'token' | 'tokenHint' | 'configured' | 'missing' | 'environment'
  | 'save' | 'saving' | 'saveToken' | 'saved' | 'failed' | 'invalid' | 'unavailable' | 'readOnly'

const en: Record<Key, string> = {
  summary: 'Local Markdown and optional RAG knowledge search.',
  endpoint: 'RAG API URL', endpointHint: 'HTTPS, or HTTP on localhost. Leave empty to use only local Markdown.',
  timeout: 'Search timeout (ms)', timeoutHint: '1000–120000 ms.',
  reference: 'Token reference', referenceHint: 'Name of a DSH credential, not the token itself.',
  token: 'RAG API token', tokenHint: 'Stored in DSH credentials, outside settings. Leave blank to keep the current token.',
  configured: 'Token configured', missing: 'No token configured', environment: 'Provided by the environment; edit the environment to replace it.',
  save: 'Save settings', saving: 'Saving…', saveToken: 'Save token', saved: 'Saved', failed: 'Save failed; check the values and try again.',
  invalid: 'Use an HTTPS URL (or localhost HTTP), an integer timeout, and a valid token reference.',
  unavailable: 'The SRE settings section is unavailable.', readOnly: 'Settings are read-only in this deployment.',
}

const zh: Record<Key, string> = {
  summary: '本地 Markdown 与可选 RAG 知识检索。',
  endpoint: 'RAG API 地址', endpointHint: '使用 HTTPS，或本机 HTTP；留空则只查本地 Markdown。',
  timeout: '检索超时（毫秒）', timeoutHint: '范围 1000–120000 毫秒。',
  reference: '令牌引用名', referenceHint: 'DSH 凭据名称，不是令牌明文。',
  token: 'RAG API 令牌', tokenHint: '保存在 DSH 凭据中，不写入设置；留空则保留原令牌。',
  configured: '已配置令牌', missing: '尚未配置令牌', environment: '令牌由环境变量提供；需在环境中修改。',
  save: '保存设置', saving: '保存中…', saveToken: '保存令牌', saved: '已保存', failed: '保存失败，请检查输入后重试。',
  invalid: '请填写 HTTPS（或本机 HTTP）地址、整数超时和有效的令牌引用名。',
  unavailable: 'SRE 设置尚不可用。', readOnly: '当前部署的设置为只读。',
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'sre.ops': Key
  }
}

const NS = 'sre.ops'
const TOKEN_REF = 'DSH_RAG_API_TOKEN'

function validEndpoint(value: string): boolean {
  if (value === '') return true
  try {
    const url = new URL(value)
    return (url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))
      && !url.username && !url.password && !url.search && !url.hash
  } catch { return false }
}

interface PageProps extends PropsRuntime<'plugins.row.config'>, PropsLocale<'sre.ops'> {
  scope: SettingsScope<RagSettings>
  ctx: Context
}

function RagPage({ scope, ctx, t }: PageProps) {
  const snapshot = useSyncExternalStore(scope.subscribe.bind(scope), scope.getSnapshot.bind(scope))
  const [url, setUrl] = useState(snapshot.value?.ragUrl ?? '')
  const [timeout, setTimeoutValue] = useState(String(snapshot.value?.ragTimeoutMs ?? 65000))
  const [reference, setReference] = useState(snapshot.value?.ragTokenEnv ?? TOKEN_REF)
  const [token, setToken] = useState('')
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [credential, setCredential] = useState({ configured: false, writable: true })

  useEffect(() => {
    if (dirty) return
    setUrl(snapshot.value?.ragUrl ?? '')
    setTimeoutValue(String(snapshot.value?.ragTimeoutMs ?? 65000))
    setReference(snapshot.value?.ragTokenEnv ?? TOKEN_REF)
  }, [snapshot.revision, dirty])

  useEffect(() => {
    const ref = snapshot.value?.ragTokenEnv ?? TOKEN_REF
    let active = true
    void ctx.remote.credentials.describe([ref]).then(result => {
      if (!active || !result.ok) return
      setCredential({ configured: result.value[ref]?.configured ?? false, writable: result.value[ref]?.writable ?? true })
    })
    return () => { active = false }
  }, [ctx, snapshot.value?.ragTokenEnv])

  if (snapshot.status !== 'ready') return <p role="status">{t('unavailable')}</p>
  const valid = validEndpoint(url.trim()) && /^(?:[A-Za-z_][A-Za-z0-9_]*)$/.test(reference.trim())
    && /^\d+$/.test(timeout.trim()) && Number(timeout) >= 1000 && Number(timeout) <= 120000
  const field = (id: string, label: string, hint: string, value: string, set: (value: string) => void, type = 'text') => (
    <label htmlFor={id} style={{ display: 'grid', gap: 6, marginBottom: 18 }}>
      <span>{label}</span>
      <input id={id} type={type} value={value} disabled={!snapshot.writable || saving}
        style={{ width: '100%', padding: 8, color: 'inherit', background: 'transparent', border: '1px solid currentColor', borderRadius: 6 }}
        onChange={event => { set(event.target.value); setDirty(true); setMessage('') }} />
      <small>{hint}</small>
    </label>
  )
  const saveSettings = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (!valid || saving || !snapshot.writable) { setMessage(t('invalid')); return }
    setSaving(true)
    void scope.mutate([
      { op: 'set', path: ['ragUrl'], value: url.trim() },
      { op: 'set', path: ['ragTimeoutMs'], value: Number(timeout) },
      { op: 'set', path: ['ragTokenEnv'], value: reference.trim() },
    ]).then(() => {
      const saved = scope.getSnapshot().value
      const ok = saved?.ragUrl === url.trim() && saved.ragTimeoutMs === Number(timeout) && saved.ragTokenEnv === reference.trim()
      setMessage(t(ok ? 'saved' : 'failed'))
      if (ok) setDirty(false)
    }).catch(() => { setMessage(t('failed')) }).finally(() => { setSaving(false) })
  }
  const saveToken = (): void => {
    const ref = snapshot.value?.ragTokenEnv ?? TOKEN_REF
    if (!token || !credential.writable || saving || dirty) return
    setSaving(true)
    void ctx.remote.credentials.set(ref, token).then(result => {
      setToken('')
      if (!result.ok) { setMessage(t('failed')); return }
      setCredential({ configured: true, writable: true })
      setMessage(t('saved'))
    }).catch(() => { setMessage(t('failed')) }).finally(() => { setSaving(false) })
  }
  return <div style={{ maxWidth: 560, padding: 8 }}>
    {!snapshot.writable ? <p role="status">{t('readOnly')}</p> : null}
    <form onSubmit={saveSettings}>
      {field('sre-rag-url', t('endpoint'), t('endpointHint'), url, setUrl)}
      {field('sre-rag-timeout', t('timeout'), t('timeoutHint'), timeout, setTimeoutValue)}
      {field('sre-rag-reference', t('reference'), t('referenceHint'), reference, setReference)}
      {!valid ? <p role="alert">{t('invalid')}</p> : null}
      <button type="submit" disabled={!dirty || !valid || !snapshot.writable || saving}>{t(saving ? 'saving' : 'save')}</button>
    </form>
    <hr style={{ margin: '24px 0' }} />
    <label htmlFor="sre-rag-token" style={{ display: 'grid', gap: 6 }}>
      <span>{t('token')} — {t(credential.configured ? 'configured' : 'missing')}</span>
      <input id="sre-rag-token" type="password" autoComplete="off" value={token}
        disabled={!credential.writable || dirty || saving} onChange={event => { setToken(event.target.value); setMessage('') }}
        style={{ width: '100%', padding: 8, color: 'inherit', background: 'transparent', border: '1px solid currentColor', borderRadius: 6 }} />
      <small>{credential.writable ? t('tokenHint') : t('environment')}</small>
    </label>
    <button type="button" disabled={!token || !credential.writable || dirty || saving} onClick={saveToken}
      style={{ marginTop: 12 }}>{t('saveToken')}</button>
    {message ? <p role="status">{message}</p> : null}
  </div>
}

/** Register a settings page for the WebShell bundle's row. */
export const inject = ['slots', 'locale', 'remote', 'remote.credentials', 'settingsScope']

/** @param ctx Browser plugin context. */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'sre-webshell: settings dictionaries')
  const scope = ctx.settingsScope.bind<RagSettings>({ namespace: 'sre-webshell' })
  ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
    name: 'plugins.row.config', key: 'dsh-sre-webshell#sre-webshell', locale: NS,
  }, (props: PropsRuntime<'plugins.row.config'> & PropsLocale<'sre.ops'>) =>
    props.view === 'summary' ? props.t('summary') : <RagPage {...props} scope={scope} ctx={ctx} />))
}
