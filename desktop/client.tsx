/** Desktop Plugins configuration uses the page owner's revisioned Config form. */
import { useState, type FormEvent } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { installClientBrowser } from './client-browser.ts'

type Key = 'summary' | 'url' | 'reference' | 'timeout' | 'save' | 'saved' | 'failed' | 'unavailable' | 'hint'
const en: Record<Key, string> = {
  summary: 'Background WebShell operations and local Markdown / RAG search.',
  url: 'RAG API URL', reference: 'RAG token credential reference', timeout: 'Timeout (ms)',
  save: 'Save', saved: 'Saved', failed: 'Not saved; check values or reload.', unavailable: 'Configuration unavailable.',
  hint: 'Keep API tokens in DSH credentials, not in this form. Empty URL uses local Markdown only.',
}
const zh: Record<Key, string> = {
  summary: '后台 WebShell 运维与本地 Markdown / RAG 检索。',
  url: 'RAG API 地址', reference: 'RAG token 凭据引用名', timeout: '超时（毫秒）',
  save: '保存', saved: '已保存', failed: '未保存，请检查配置或刷新。', unavailable: '配置不可用。',
  hint: 'API token 存在 DSH 凭据中，不填在表单里；地址留空则只检索本地 Markdown。',
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'sre.desktop': Key }
}

type Props = PropsRuntime<'plugins.row.config'> & PropsLocale<'sre.desktop'>

function RagPage({ form, t }: Props) {
  const state = form?.state
  const [url, setUrl] = useState(String(state?.value?.ragUrl ?? ''))
  const [reference, setReference] = useState(String(state?.value?.ragTokenEnv ?? 'DSH_RAG_API_TOKEN'))
  const [timeout, setTimeoutValue] = useState(String(state?.value?.ragTimeoutMs ?? 65000))
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<'saved' | 'failed' | null>(null)
  if (!form || state?.status !== 'ready') return <p>{t('unavailable')}</p>
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (busy || !state.writable) return
    setBusy(true)
    void form.mutate([
      { op: 'set', path: ['ragUrl'], value: url.trim() },
      { op: 'set', path: ['ragTokenEnv'], value: reference.trim() },
      { op: 'set', path: ['ragTimeoutMs'], value: Number(timeout) },
    ], state.revision).then(saved => { setMessage(saved ? 'saved' : 'failed') }, () => { setMessage('failed') }).finally(() => { setBusy(false) })
  }
  return <form onSubmit={submit}>
    <p>{t('hint')}</p>
    <label>{t('url')}<input value={url} onChange={event => setUrl(event.target.value)} /></label>
    <label>{t('reference')}<input value={reference} onChange={event => setReference(event.target.value)} /></label>
    <label>{t('timeout')}<input type="number" min={1000} max={120000} value={timeout} onChange={event => setTimeoutValue(event.target.value)} /></label>
    <button disabled={busy || !state.writable}>{t('save')}</button>
    {message ? <p role="status">{t(message)}</p> : null}
  </form>
}

export const inject = ['slots', 'locale']

/** @param ctx - Desktop Client plugin context; components receive no Cordis context. */
export function apply(ctx: Context): void {
  installClientBrowser(ctx)
  ctx.effect(() => ctx.locale.register('sre.desktop', { en, zh }))
  ctx.slots.inject('plugins.row.config', () => ctx.slots.register({ name: 'plugins.row.config',
    key: 'dsh-sre-webshell#sre-webshell', locale: 'sre.desktop' }, (props: Props) =>
    props.view === 'summary' ? props.t('summary') : <RagPage key={props.form?.state.revision ?? 'loading'} {...props} />))
}
