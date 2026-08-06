import { describe, it, expect } from 'vitest'
import { buildStyleCPrompt, renderPersona } from '../src/lib/prompt.js'

const persona = {
  name: 'P1',
  demographics: { age: 42, gender: 'female', location: 'Pécs' },
  biography: 'Teacher, two kids.',
  renderingStyle: 'bulleted_profile' as const
}

const question = {
  text: 'How much do you trust banks?',
  options: ['Not at all', 'Somewhat', 'Fully']
}

describe('renderPersona', () => {
  it('renders bulleted profile with one line per attribute', () => {
    const out = renderPersona(persona)
    expect(out).toContain('- age: 42')
    expect(out).toContain('- location: Pécs')
    expect(out).toContain('Teacher, two kids.')
  })

  it('renders natural language sentence style', () => {
    const out = renderPersona({ ...persona, renderingStyle: 'natural_language_sentence' })
    expect(out).not.toContain('- age:')
    expect(out).toContain('42')
  })
})

describe('buildStyleCPrompt', () => {
  it('labels permuted options with neutral letters', () => {
    const { prompt, keyMap } = buildStyleCPrompt(persona, question, [2, 0, 1])
    expect(prompt).toContain('A: Fully')
    expect(prompt).toContain('B: Not at all')
    expect(prompt).toContain('C: Somewhat')
    expect(keyMap).toEqual({ A: 2, B: 0, C: 1 })
  })

  it('asks for a JSON probability distribution and allows abstention', () => {
    const { prompt } = buildStyleCPrompt(persona, question, [0, 1, 2])
    expect(prompt).toMatch(/probabilit/i)
    expect(prompt).toMatch(/JSON/)
    expect(prompt).toMatch(/abstain/i)
  })

  it('never leaks model names or metadata into the prompt', () => {
    const { prompt } = buildStyleCPrompt(persona, question, [0, 1, 2])
    expect(prompt).not.toMatch(/deepseek|claude|gpt|llama|openrouter/i)
  })
})

describe('buildStyleCPrompt — multi_choice elicitation', () => {
  it('does not ask for probabilities that sum to 1', () => {
    const { prompt } = buildStyleCPrompt(persona, question, [0, 1, 2], 'multi_choice')
    expect(prompt).not.toMatch(/sum to 1/i)
  })

  it('asks for an independent probability per option', () => {
    const { prompt } = buildStyleCPrompt(persona, question, [0, 1, 2], 'multi_choice')
    expect(prompt).toMatch(/independent/i)
    expect(prompt).toMatch(/select|choose/i)
    expect(prompt).toMatch(/between 0 and 1/i)
    expect(prompt).toMatch(/abstain/i)
  })

  it('keeps the single-choice prompt constrained to a distribution', () => {
    const { prompt } = buildStyleCPrompt(persona, question, [0, 1, 2], 'single_choice')
    expect(prompt).toMatch(/sum to 1/i)
  })

  it('defaults to single-choice elicitation', () => {
    expect(buildStyleCPrompt(persona, question, [0, 1, 2]).prompt).toMatch(/sum to 1/i)
  })

  it('uses the same neutral labels and permutation in both modes', () => {
    const { keyMap } = buildStyleCPrompt(persona, question, [2, 0, 1], 'multi_choice')
    expect(keyMap).toEqual({ A: 2, B: 0, C: 1 })
  })
})

describe('buildStyleCPrompt — baseline (persona-free) arm', () => {
  it('omits the profile block entirely', () => {
    const { prompt } = buildStyleCPrompt(null, question, [0, 1, 2])
    expect(prompt).not.toContain('42')
    expect(prompt).not.toContain('Pécs')
    expect(prompt).not.toMatch(/profile:/i)
  })

  it('never tells the model to answer as itself — that would summon the assistant role', () => {
    const { prompt } = buildStyleCPrompt(null, question, [0, 1, 2])
    expect(prompt).not.toMatch(/as yourself|as an ai|as the assistant/i)
    expect(prompt).toMatch(/survey respondent/i)
  })

  it('keeps the same task, labels and abstention path as the persona arm', () => {
    const baseline = buildStyleCPrompt(null, question, [2, 0, 1])
    expect(baseline.keyMap).toEqual({ A: 2, B: 0, C: 1 })
    expect(baseline.prompt).toMatch(/sum to 1/i)
    expect(baseline.prompt).toMatch(/abstain/i)
  })
})

describe('buildStyleCPrompt — abstention wording per arm', () => {
  it('does not point the control arm at a profile it does not have', () => {
    const { prompt } = buildStyleCPrompt(null, question, [0, 1, 2])
    expect(prompt).not.toMatch(/the profile gives you no basis/i)
    expect(prompt).toMatch(/no basis to estimate/i)
  })

  it('keeps the profile-based wording for persona cells', () => {
    const { prompt } = buildStyleCPrompt(persona, question, [0, 1, 2])
    expect(prompt).toMatch(/the profile gives you no basis/i)
  })
})
