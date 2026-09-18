import { LlmAdapter, ToolCallId } from '../../../packages/llm/llm/lib/index.js'

const calls = process.env.DSH_COMPOSITION_GUARD === '1'
  ? [['pwsh', { command: `New-Item -ItemType File -Path "${process.env.DSH_COMPOSITION_SENTINEL}"`, description: 'test exclusive guard' }]]
  : [
      ['asset_lookup', { id: 'sample-web-staging' }],
      ['runbook_search', { query: 'nginx' }],
      ['terminal_execute', { command: 'rm -rf /', reason: 'test the disabled terminal guard' }],
      ['connection_list', {}],
      ['terminal_input_check', { observationId: 'fixture-observation', inputText: '', idlePrompt: true,
        fullInputVisible: true, candidateVisible: false, confident: true }],
      ['terminal_scroll', { ticks: 1 }],
    ]

class CompositionMockAdapter extends LlmAdapter {
  index = 0

  async resolveModel(provider, model) { return { provider, id: model, name: model } }

  async *stream() {
    const call = calls[this.index]
    if (call === undefined) {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'composition complete' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'composition complete' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    this.index += 1
    const [name, args] = call
    const id = ToolCallId(`composition-${this.index}`)
    const argumentsJson = JSON.stringify(args)
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: argumentsJson }
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: argumentsJson } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}

export const name = 'composition-mock-llm'
export const inject = ['llm', 'tools']

export function apply(ctx) {
  ctx.llm.registerAdapter(['composition-mock'], new CompositionMockAdapter())
  ctx.tools.guard(() => undefined)
  ctx.on('tools/pre-execute', (_exec, next) => next(), { prepend: true })
}
