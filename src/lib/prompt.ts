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
 * The elicitation template's own language (issue #33) — a SEPARATE axis from
 * the questionnaire/persona CONTENT language: the research corpus says the
 * language of the ASKING itself activates cultural favouritism independent of
 * the persona given, so a Hungarian questionnaire answered through an English
 * framing measures a linguistically mixed state, not a clean persona effect.
 * Selectable per call so a future Hungarian-vs-English comparison run is
 * possible; this module does not pick a default on its own behalf beyond
 * preserving the historical English wording (see `buildStyleCPrompt` below).
 */
export type TemplateLanguage = 'hu' | 'en'

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

interface StyleCCopy {
  introPersona: string
  introControl: string
  taskSingle: string
  taskMulti: string
  questionLabel: string
  optionsHeader: string
  jsonInstruction: (keys: string) => string
  abstentionPersona: string
  abstentionControl: string
}

/**
 * The full prose of the Style C template, once per supported language. Every
 * branch (persona / control arm, single / multi choice, abstention wording)
 * is translated — nothing here is machine-translated per question at runtime,
 * and nothing here decides which language to use (that is the caller's job,
 * driven by the questionnaire, not a per-question heuristic).
 */
const COPY: Record<TemplateLanguage, StyleCCopy> = {
  en: {
    introPersona: 'Consider a survey respondent with the following profile:',
    introControl: 'Consider a survey respondent.',
    taskSingle:
      'Estimate the probability that this respondent would choose each answer option for the question below. Probabilities must sum to 1.',
    taskMulti:
      'This question allows multiple answers. For each option independently, estimate the probability between 0 and 1 that this respondent would select it. The options are independent: the probabilities do NOT have to sum to any particular value, and several options may be high at once.',
    questionLabel: 'Question:',
    optionsHeader: 'Answer options:',
    jsonInstruction: (keys) =>
      `Return only valid JSON mapping each answer key to a probability, using exactly these keys: ${keys}. No other text.`,
    abstentionPersona: 'If the profile gives you no basis to answer this question, return exactly {"abstain": true} instead of guessing.',
    abstentionControl:
      'If you have no basis to estimate these probabilities, return exactly {"abstain": true} instead of guessing.'
  },
  // Natural Hungarian, not a literal word-for-word translation of the English —
  // same methodological content: neutral A/B labels, no model name or
  // experiment metadata, an explicit abstention path, and the
  // distribution-vs-independent-probability distinction between modes.
  hu: {
    introPersona: 'Vegyen figyelembe egy kérdőívre válaszoló személyt a következő profillal:',
    introControl: 'Vegyen figyelembe egy kérdőívre válaszoló személyt.',
    taskSingle:
      'Becsülje meg annak valószínűségét, hogy ez a válaszadó az alábbi kérdésre az egyes válaszlehetőségeket választaná. A valószínűségeknek 1-re kell összegezniük.',
    taskMulti:
      'Ez a kérdés több válasz megjelölését is megengedi. Minden opcióra külön-külön, egymástól függetlenül becsülje meg 0 és 1 közötti valószínűséggel, hogy ez a válaszadó kiválasztaná-e. Az opciók függetlenek egymástól: a valószínűségeknek NEM kell semmilyen konkrét összegre kijönniük, és több opció valószínűsége is lehet egyszerre magas.',
    questionLabel: 'Kérdés:',
    optionsHeader: 'Válaszlehetőségek:',
    jsonInstruction: (keys) =>
      `Kizárólag érvényes JSON-t adjon vissza, amely minden válaszkulcshoz egy valószínűséget rendel, pontosan ezekkel a kulcsokkal: ${keys}. Más szöveget ne írjon.`,
    abstentionPersona:
      'Ha a profil nem ad alapot ennek a kérdésnek a megválaszolásához, találgatás helyett pontosan ezt adja vissza: {"abstain": true}.',
    abstentionControl:
      'Ha nincs alapja megbecsülni ezeket a valószínűségeket, találgatás helyett pontosan ezt adja vissza: {"abstain": true}.'
  }
}

/**
 * Style C (distribution) prompt. Neutral A/B/C labels, no model metadata,
 * explicit abstention path. Sent in a fresh context (per-question memory reset).
 *
 * `language` selects the TEMPLATE's own wording (issue #33) — distinct from
 * the questionnaire/persona content language, which is whatever the caller
 * put into `question`/`persona` and this function never inspects. Defaults to
 * 'en' to keep every call site that predates this parameter byte-identical to
 * before; callers building prompts for an actual questionnaire should pass
 * the questionnaire's own language explicitly instead of relying on this
 * default.
 */
export function buildStyleCPrompt(
  persona: PersonaInput | null,
  question: QuestionInput,
  rotation: readonly number[],
  mode: ElicitationMode = 'single_choice',
  language: TemplateLanguage = 'en'
): BuiltPrompt {
  const permuted = applyPermutation(question.options, rotation)
  const keys = permuted.map((_, i) => labelFor(i))
  const keyMap = Object.fromEntries(keys.map((k, i) => {
    const orig = rotation[i]
    if (orig === undefined) throw new Error('rotation shorter than options')
    return [k, orig]
  }))
  const optionLines = permuted.map((opt, i) => `${keys[i]}: ${opt}`).join('\n')
  const copy = COPY[language]

  // The task statement differs by mode: asking for a sum-to-1 distribution on a
  // multi-select question is the wrong task — there the options are independent.
  const task = mode === 'multi_choice' ? copy.taskMulti : copy.taskSingle

  // The control arm has no profile block at all. The framing stays "a survey
  // respondent"; asking the model to answer AS ITSELF would activate the
  // assistant persona, which is a different bias, not the absence of one.
  const intro = persona ? `${copy.introPersona}\n${renderPersona(persona)}` : copy.introControl

  // The abstention clause must not reference a profile the control arm does not
  // have: with "the profile gives you no basis", a persona-free cell abstains
  // every single time — measured, not assumed (6 of 6 in the first live run).
  const abstention = persona ? copy.abstentionPersona : copy.abstentionControl

  const prompt = `${intro}

${task}

${copy.questionLabel} ${question.text}

${copy.optionsHeader}
${optionLines}

${copy.jsonInstruction(keys.join(', '))}
${abstention}`

  return { prompt, keyMap, keys }
}
