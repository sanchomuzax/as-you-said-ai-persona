import { describe, it, expect } from 'vitest'
import {
  buildInterviewMessages,
  detectAbstention,
  stripAbstentionMarker,
  ABSTENTION_MARKER,
  type InterviewTurn
} from '../src/lib/interview.js'
import type { PersonaInput } from '../src/lib/prompt.js'

const persona: PersonaInput = {
  name: 'Anna',
  demographics: { kor: 34, város: 'Budapest' },
  biography: 'Két gyerek mellett dolgozik.',
  renderingStyle: 'bulleted_profile'
}

describe('buildInterviewMessages', () => {
  it('opens with a system turn carrying the profile', () => {
    const messages = buildInterviewMessages(persona, [], 'Hogyan tájékozódsz az akciókról?')
    expect(messages[0]?.role).toBe('system')
    expect(messages[0]?.content).toContain('kor: 34')
    expect(messages[0]?.content).toContain('Két gyerek mellett dolgozik.')
  })

  it('states the abstention path with the exact marker', () => {
    const messages = buildInterviewMessages(persona, [], 'Kérdés?')
    expect(messages[0]?.content).toContain(ABSTENTION_MARKER)
  })

  it('puts the new question last, as a user turn', () => {
    const messages = buildInterviewMessages(persona, [], 'Mennyit költesz havonta?')
    expect(messages.at(-1)).toEqual({ role: 'user', content: 'Mennyit költesz havonta?' })
  })

  // The interview is deliberately memory-carrying — that is exactly what makes it
  // unusable as measurement, and what the questionnaire runner must never do.
  it('replays the whole history as alternating user/assistant turns', () => {
    const history: InterviewTurn[] = [
      { role: 'researcher', content: 'Első kérdés' },
      { role: 'persona', content: 'Első válasz' }
    ]
    const messages = buildInterviewMessages(persona, history, 'Második kérdés')
    expect(messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user'])
    expect(messages[1]?.content).toBe('Első kérdés')
    expect(messages[2]?.content).toBe('Első válasz')
  })

  // Methodology rule: no model name and no experiment metadata may reach the prompt.
  it('leaks no model or experiment metadata into the prompt', () => {
    const text = buildInterviewMessages(persona, [], 'Kérdés?')
      .map((m) => m.content)
      .join('\n')
      .toLowerCase()
    for (const forbidden of ['deepseek', 'openrouter', 'temperature', 'seed', 'gpt', 'claude']) {
      expect(text).not.toContain(forbidden)
    }
  })

  it('renders the persona in the recorded rendering style', () => {
    const sentence = buildInterviewMessages(
      { ...persona, renderingStyle: 'natural_language_sentence' },
      [],
      'Kérdés?'
    )
    expect(sentence[0]?.content).toContain('A person with kor: 34')
  })
})

describe('detectAbstention', () => {
  it('recognises the marker at the start of the reply', () => {
    expect(detectAbstention(`${ABSTENTION_MARKER} Ehhez nem tudok mit mondani.`)).toBe(true)
  })

  it('tolerates leading whitespace and case differences', () => {
    expect(detectAbstention('\n  [no basis] nincs alapom')).toBe(true)
  })

  it('does not fire on a marker mentioned mid-answer', () => {
    expect(detectAbstention(`Szoktam akciózni, bár ${ABSTENTION_MARKER} lenne furcsa.`)).toBe(false)
  })

  it('treats an ordinary answer as an answer', () => {
    expect(detectAbstention('Hetente nézem az akciós újságokat.')).toBe(false)
  })
})

describe('stripAbstentionMarker', () => {
  it('removes only the leading marker', () => {
    expect(stripAbstentionMarker(`${ABSTENTION_MARKER} Nem tudom.`)).toBe('Nem tudom.')
  })

  it('leaves a normal answer untouched', () => {
    expect(stripAbstentionMarker('Hetente vásárolok.')).toBe('Hetente vásárolok.')
  })
})
