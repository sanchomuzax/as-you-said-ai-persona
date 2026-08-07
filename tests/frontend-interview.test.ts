import { describe, it, expect } from 'vitest'
import { loadPublicScript } from './helpers/load-public-script.js'

interface InterviewApi {
  INTERVIEW_DISCLAIMER: string
  interviewListItem: (interview: Record<string, unknown>) => string
  renderInterviewTranscript: (messages: Record<string, unknown>[]) => string
  renderInterviewTurnMeta: (message: Record<string, unknown>) => string
}

const api = loadPublicScript<InterviewApi>(
  ['format.js', 'interview.js'],
  '({ INTERVIEW_DISCLAIMER, interviewListItem, renderInterviewTranscript, renderInterviewTurnMeta })'
)

const personaTurn = {
  id: 'm2',
  turn: 2,
  role: 'persona',
  content: 'Hetente nézem az akciós újságokat.',
  abstained: 0,
  model_version: 'deepseek/deepseek-v4-flash-2026-05',
  provider: 'DeepInfra',
  temperature: 0.8,
  seed: 0,
  prompt_tokens: 40,
  completion_tokens: 12,
  cached_tokens: 8,
  cost_usd: 0.002,
  latency_ms: 123,
  created_at: '2026-08-06 10:00:00'
}

describe('INTERVIEW_DISCLAIMER', () => {
  it('says the conversation is exploratory, not measurement', () => {
    expect(api.INTERVIEW_DISCLAIMER).toMatch(/feltáró/i)
    expect(api.INTERVIEW_DISCLAIMER).toMatch(/hipotézis/i)
  })

  // The issue is explicit: grounding improves trust, not certainty. No wording
  // may suggest the output is verified, traceable evidence.
  it('makes no claim of proof, verification or traceability', () => {
    const text = api.INTERVIEW_DISCLAIMER.toLowerCase()
    for (const forbidden of ['bizonyít', 'igazolt', 'visszakövethet', '100%', 'garant']) {
      expect(text).not.toContain(forbidden)
    }
  })
})

describe('renderInterviewTranscript', () => {
  it('shows a placeholder for an empty conversation', () => {
    expect(api.renderInterviewTranscript([])).toContain('Még nincs kérdés')
  })

  it('separates the researcher question from the persona answer', () => {
    const html = api.renderInterviewTranscript([
      { id: 'm1', turn: 1, role: 'researcher', content: 'Hogyan tájékozódsz?' },
      personaTurn
    ])
    expect(html).toContain('interview-turn-researcher')
    expect(html).toContain('interview-turn-persona')
    expect(html).toContain('Hogyan tájékozódsz?')
    expect(html).toContain('Hetente nézem az akciós újságokat.')
  })

  it('escapes model- and user-supplied text', () => {
    const html = api.renderInterviewTranscript([
      { id: 'm1', turn: 1, role: 'researcher', content: '<img src=x onerror=alert(1)>' }
    ])
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img')
  })

  // Abstention is an evidence gap about the persona's coverage, never an error.
  it('marks an abstention as an evidence gap', () => {
    const html = api.renderInterviewTranscript([{ ...personaTurn, abstained: 1 }])
    expect(html).toContain('bizonyítékhézag')
    // the explanation may say what it is NOT; the label and styling may not
    // present it as a failure
    expect(html).not.toContain('chip-error')
    expect(html).not.toMatch(/érvénytelen|sikertelen/i)
  })

  it('does not mark an ordinary answer', () => {
    expect(api.renderInterviewTranscript([personaTurn])).not.toContain('bizonyítékhézag')
  })

  // The panel itself is exercised end-to-end in tests/frontend-app-dom.test.ts;
  // here only the hook it needs is asserted, including keyboard reachability.
  it('makes a persona turn openable for provenance, by mouse and keyboard', () => {
    const html = api.renderInterviewTranscript([personaTurn])
    expect(html).toContain('data-interview-message="m2"')
    expect(html).toContain('role="button"')
    expect(html).toContain('tabindex="0"')
  })

  it('leaves the researcher turn unopenable — it has no model call behind it', () => {
    const html = api.renderInterviewTranscript([
      { id: 'm1', turn: 1, role: 'researcher', content: 'Kérdés?' }
    ])
    expect(html).not.toContain('role="button"')
  })
})

describe('renderInterviewTurnMeta', () => {
  it('shows the recorded provenance of the turn', () => {
    const html = api.renderInterviewTurnMeta(personaTurn)
    expect(html).toContain('deepseek/deepseek-v4-flash-2026-05')
    expect(html).toContain('DeepInfra')
    expect(html).toContain('123')
  })

  // A seed of 0 is a real, common setting: `value || '—'` swallowed it before.
  it('renders seed 0 as 0, not as missing', () => {
    const html = api.renderInterviewTurnMeta({ ...personaTurn, seed: 0 })
    expect(html).toMatch(/seed[^0-9—]*0/i)
  })

  it('renders a missing value as unknown, not as zero', () => {
    const html = api.renderInterviewTurnMeta({ ...personaTurn, provider: null, latency_ms: null })
    expect(html).toContain('—')
    expect(html).not.toContain('DeepInfra')
  })

  it('returns nothing for a researcher turn, which has no model provenance', () => {
    expect(api.renderInterviewTurnMeta({ id: 'm1', turn: 1, role: 'researcher', content: 'Kérdés?' })).toBe('')
  })
})

describe('interviewListItem', () => {
  it('renders a keyboard-reachable row naming what opening it does', () => {
    const html = api.interviewListItem({
      id: 'i1',
      title: 'Feltáró beszélgetés',
      personaName: 'Anna',
      turnCount: 4,
      createdAt: '2026-08-06 10:00:00'
    })
    expect(html).toContain('data-interview-id="i1"')
    expect(html).toContain('role="button"')
    expect(html).toContain('tabindex="0"')
    expect(html).toContain('aria-label="Interjú megnyitása: Feltáró beszélgetés"')
    expect(html).toContain('Anna')
  })

  it('counts exchanges, not stored rows', () => {
    // four stored messages are two question-answer exchanges
    expect(api.interviewListItem({ id: 'i1', title: 'T', personaName: 'A', turnCount: 4 })).toContain('2 kérdés')
  })
})
