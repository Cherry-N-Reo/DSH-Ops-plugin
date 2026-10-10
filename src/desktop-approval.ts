/** Exact affirmative answers for plugin-owned sensitive-operation confirmation. */
import { randomUUID } from 'node:crypto'
import type { AskUserQuestionRequest, AskUserQuestionAnswer } from '@deepseek-ai/dsh-user-questions'

const ALLOW = '允许本次 / Allow once'
const DENY = '拒绝 / Deny'

/**
 * Ask independently of the native tool approval preset; only a matching explicit choice grants permission.
 * @param ask - live root-agent answer service, which rejects unavailable or delegated callers.
 * @param request - owning Agent and call cancellation; no credentials are included.
 * @param detail - exact operation the user is being asked to approve.
 * @returns question id and an explicit affirmative decision; errors propagate without granting permission.
 */
export async function confirmSensitive(
  ask: (request: AskUserQuestionRequest) => Promise<AskUserQuestionAnswer>,
  request: Omit<AskUserQuestionRequest, 'questions'>,
  detail: string,
): Promise<{ questionId: string; allowed: boolean }> {
  const questionId = randomUUID()
  const answer = await ask({ ...request, questions: [{ id: questionId, question: detail,
    options: [{ label: DENY }, { label: ALLOW }] }] })
  const item = answer.answers[0]
  return { questionId, allowed: answer.answers.length === 1 && item.id === questionId
    && item.selected.length === 1 && item.selected[0] === ALLOW && !item.custom }
}
