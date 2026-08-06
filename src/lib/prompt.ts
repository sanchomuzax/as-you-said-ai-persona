import { applyPermutation, labelFor } from './permutation.js'
import type { ElicitationMode } from './parse.js'

export interface PersonaInput {
  name: string
  demographics: Record<string, unknown>
  biography?: string
  renderingStyle: 'bulleted_profile' | 'natural_language_sentence'
}

export interface QuestionInput {
  text: string
  options: readonly string[]
}

/**
 * Persona rendering style is an experimental variable (bulleted vs. sentence
 * alone flips ~9% of predictions) — both must be supported and recorded.
 */
export function renderPersona(p: PersonaInput): string {
  const bio = p.biography ? `\n${p.biography}` : ''
  if (p.renderingStyle === 'natural_language_sentence') {
    const attrs = Object.entries(p.demographics)
      .map(([k, v]) => `${k}: ${String(v)}`)
      .join(', ')
    return `A person with ${attrs}.${bio}`
  }
  const lines = Object.entries(p.demographics).map(([k, v]) => `- ${k}: ${String(v)}`)
  return `${lines.join('\n')}${bio}`
}

export interface BuiltPrompt {
  prompt: string
  /** letter label -> original option index (for de-permutation at parse time) */
  keyMap: Record<string, number>
  keys: string[]
}

/**
 * Style C (distribution) prompt. Neutral A/B/C labels, no model metadata,
 * explicit abstention path. Sent in a fresh context (per-question memory reset).
 */
export function buildStyleCPrompt(
  persona: PersonaInput | null,
  question: QuestionInput,
  rotation: readonly number[],
  mode: ElicitationMode = 'single_choice'
): BuiltPrompt {
  const permuted = applyPermutation(question.options, rotation)
  const keys = permuted.map((_, i) => labelFor(i))
  const keyMap = Object.fromEntries(keys.map((k, i) => {
    const orig = rotation[i]
    if (orig === undefined) throw new Error('rotation shorter than options')
    return [k, orig]
  }))
  const optionLines = permuted.map((opt, i) => `${keys[i]}: ${opt}`).join('\n')

  // The task statement differs by mode: asking for a sum-to-1 distribution on a
  // multi-select question is the wrong task — there the options are independent.
  const task =
    mode === 'multi_choice'
      ? 'This question allows multiple answers. For each option independently, estimate the probability between 0 and 1 that this respondent would select it. The options are independent: the probabilities do NOT have to sum to any particular value, and several options may be high at once.'
      : 'Estimate the probability that this respondent would choose each answer option for the question below. Probabilities must sum to 1.'

  // The control arm has no profile block at all. The framing stays "a survey
  // respondent": asking the model to answer AS ITSELF would activate the
  // assistant persona, which is a different bias, not the absence of one.
  const intro = persona
    ? `Consider a survey respondent with the following profile:\n${renderPersona(persona)}`
    : 'Consider a survey respondent.'

  // The abstention clause must not reference a profile the control arm does not
  // have: with "the profile gives you no basis", a persona-free cell abstains
  // every single time — measured, not assumed (6 of 6 in the first live run).
  const abstention = persona
    ? 'If the profile gives you no basis to answer this question, return exactly {"abstain": true} instead of guessing.'
    : 'If you have no basis to estimate these probabilities, return exactly {"abstain": true} instead of guessing.'

  const prompt = `${intro}

${task}

Question: ${question.text}

Answer options:
${optionLines}

Return only valid JSON mapping each answer key to a probability, using exactly these keys: ${keys.join(', ')}. No other text.
${abstention}`

  return { prompt, keyMap, keys }
}
