import { describe, it, expect } from 'vitest'
import { buildStyleCPrompt } from '../src/lib/prompt.js'

/**
 * Issue #33: the Style C template used to be hardcoded English while the
 * questionnaire, options and persona are Hungarian — the language of the
 * ASKING itself activates cultural favouritism independent of the persona, so
 * a mixed-language prompt confounds the measurement. The template must now be
 * selectable per call, defaulting (when unspecified) to the historical
 * English wording so every existing golden-text test in tests/prompt.test.ts
 * keeps passing untouched.
 */

const persona = {
  name: 'P1',
  demographics: { kor: 42, nem: 'nő', lakóhely: 'Pécs' },
  biography: 'Tanárnő, két gyerek.',
  renderingStyle: 'bulleted_profile' as const
}

const question = {
  text: 'Mennyire bízik a bankokban?',
  options: ['Egyáltalán nem', 'Valamennyire', 'Teljesen']
}

describe('buildStyleCPrompt — default template language', () => {
  it('still defaults to English when no language argument is passed', () => {
    const { prompt } = buildStyleCPrompt(persona, question, [0, 1, 2])
    expect(prompt).toMatch(/survey respondent/i)
    expect(prompt).toMatch(/estimate the probability/i)
  })

  it('explicit language="en" renders byte-identical prose to the old default', () => {
    const withoutArg = buildStyleCPrompt(persona, question, [0, 1, 2]).prompt
    const withArg = buildStyleCPrompt(persona, question, [0, 1, 2], 'single_choice', 'en').prompt
    expect(withArg).toBe(withoutArg)
  })
})

describe('buildStyleCPrompt — Hungarian template, persona arm', () => {
  it('carries no English framing at all', () => {
    const { prompt } = buildStyleCPrompt(persona, question, [2, 0, 1], 'single_choice', 'hu')
    expect(prompt).not.toMatch(/survey respondent|estimate the probability|consider a|return only valid json/i)
  })

  it('labels permuted options with neutral letters, exactly like the English template', () => {
    const { prompt, keyMap } = buildStyleCPrompt(persona, question, [2, 0, 1], 'single_choice', 'hu')
    expect(prompt).toContain('A: Teljesen')
    expect(prompt).toContain('B: Egyáltalán nem')
    expect(prompt).toContain('C: Valamennyire')
    expect(keyMap).toEqual({ A: 2, B: 0, C: 1 })
  })

  it('asks for a probability distribution in Hungarian and requires JSON', () => {
    const { prompt } = buildStyleCPrompt(persona, question, [0, 1, 2], 'single_choice', 'hu')
    expect(prompt).toMatch(/valószín/i)
    expect(prompt).toMatch(/JSON/)
    expect(prompt).toMatch(/1-re kell összegez/i)
  })

  it('keeps the profile-based abstention clause, in Hungarian', () => {
    const { prompt } = buildStyleCPrompt(persona, question, [0, 1, 2], 'single_choice', 'hu')
    expect(prompt).toMatch(/profil/i)
    expect(prompt).toMatch(/\{"abstain": true\}/)
  })

  it('never leaks model names or metadata into the Hungarian prompt either', () => {
    const { prompt } = buildStyleCPrompt(persona, question, [0, 1, 2], 'single_choice', 'hu')
    expect(prompt).not.toMatch(/deepseek|claude|gpt|llama|openrouter/i)
  })
})

describe('buildStyleCPrompt — Hungarian template, multi_choice mode', () => {
  it('does not ask for probabilities that sum to 1', () => {
    const { prompt } = buildStyleCPrompt(persona, question, [0, 1, 2], 'multi_choice', 'hu')
    expect(prompt).not.toMatch(/1-re kell összegez/i)
  })

  it('asks for an independent probability per option', () => {
    const { prompt } = buildStyleCPrompt(persona, question, [0, 1, 2], 'multi_choice', 'hu')
    expect(prompt).toMatch(/független/i)
    expect(prompt).toMatch(/0 és 1 közötti/i)
  })
})

describe('buildStyleCPrompt — Hungarian template, baseline (persona-free) arm', () => {
  it('omits the profile block entirely', () => {
    const { prompt } = buildStyleCPrompt(null, question, [0, 1, 2], 'single_choice', 'hu')
    expect(prompt).not.toContain('Pécs')
    expect(prompt).not.toMatch(/profillal/i)
  })

  it('never tells the model to answer as itself', () => {
    const { prompt } = buildStyleCPrompt(null, question, [0, 1, 2], 'single_choice', 'hu')
    expect(prompt).not.toMatch(/mint saját magad|mint az ai|mint az asszisztens/i)
    expect(prompt).toMatch(/kérdőívre válaszoló személyt/i)
  })

  it('uses a different abstention wording than the persona arm — no reference to a profile it does not have', () => {
    const { prompt } = buildStyleCPrompt(null, question, [0, 1, 2], 'single_choice', 'hu')
    expect(prompt).not.toMatch(/ha a profil nem ad alapot/i)
    expect(prompt).toMatch(/\{"abstain": true\}/)
  })

  it('keeps the same neutral labels and permutation as the persona arm', () => {
    const baseline = buildStyleCPrompt(null, question, [2, 0, 1], 'single_choice', 'hu')
    expect(baseline.keyMap).toEqual({ A: 2, B: 0, C: 1 })
  })
})
