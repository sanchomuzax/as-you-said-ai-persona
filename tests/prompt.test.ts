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
