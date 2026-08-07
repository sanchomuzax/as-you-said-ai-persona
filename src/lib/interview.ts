import { renderPersona, type PersonaInput } from './prompt.js'
import type { ChatMessage } from '../openrouter.js'

/** One recorded turn of an interview, in the order it happened. */
export interface InterviewTurn {
  role: 'researcher' | 'persona'
  content: string
}

/**
 * The persona is asked to lead with this exact string when the profile gives it
 * no basis to answer. Abstention is an evidence gap — a finding about the
 * persona's coverage — and never a failed call, so it is detected explicitly
 * instead of being read out of free text afterwards.
 */
export const ABSTENTION_MARKER = '[NO BASIS]'

/**
 * Builds the conversation for one interview turn.
 *
 * The whole history is replayed on purpose: an interview is exploratory and
 * memory-carrying, which is exactly what disqualifies it as measurement. The
 * questionnaire runner does the opposite (a fresh context per question) to keep
 * carryover and priming out of the recorded data — the two must never share a
 * code path or a table.
 */
export function buildInterviewMessages(
  persona: PersonaInput,
  history: readonly InterviewTurn[],
  question: string
): ChatMessage[] {
  // No model name, provider or experiment setting appears here: the persona must
  // not be able to condition on the apparatus measuring it.
  const system = `You are taking part in an exploratory research interview. Answer as the survey respondent described by the profile below: first person, in character, and only what the profile supports. Reply in the language of the question.

Profile:
${renderPersona(persona)}

If the profile gives you no basis to answer, begin your reply with exactly ${ABSTENTION_MARKER} and then say what would be needed to answer. Do not invent facts the profile does not support.`

  return [
    { role: 'system', content: system },
    ...history.map(
      (turn): ChatMessage => ({
        role: turn.role === 'researcher' ? 'user' : 'assistant',
        content: turn.content
      })
    ),
    { role: 'user', content: question }
  ]
}

/**
 * Only a marker that OPENS the reply counts. A model quoting the marker inside a
 * genuine answer ("...it would be odd to say [NO BASIS]") is answering, and
 * scoring that as an evidence gap would understate the persona's coverage.
 */
export function detectAbstention(content: string): boolean {
  return content.trimStart().toUpperCase().startsWith(ABSTENTION_MARKER)
}

/** Display form: the marker is bookkeeping, the sentence after it is the answer. */
export function stripAbstentionMarker(content: string): string {
  if (!detectAbstention(content)) return content
  return content.trimStart().slice(ABSTENTION_MARKER.length).trim()
}
