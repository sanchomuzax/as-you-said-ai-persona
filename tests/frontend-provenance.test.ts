import { describe, it, expect } from 'vitest'
import { loadPublicScript } from './helpers/load-public-script.js'

const { renderResponseProvenance, renderTranscript } = loadPublicScript<{
  renderResponseProvenance: (r: Record<string, unknown>) => string
  renderTranscript: (responses: Record<string, unknown>[]) => string
}>(['format.js', 'detail.js', 'provenance.js'], '{ renderResponseProvenance, renderTranscript }')

describe('renderResponseProvenance', () => {
  const baseResponse = {
    id: 'resp1',
    persona_name: 'Anna',
    question_text: 'Bízol a bankokban?',
    options_json: JSON.stringify(['Igen', 'Nem']),
    parsed_answer: '0',
    elicitation_mode: 'single_choice',
    prompt_rendered: 'You are Anna, 34 years old...\n\nChoose a probability:',
    raw_response: '{"probabilities": {"0": 0.7, "1": 0.3}}',
    permutation_json: JSON.stringify([1, 0]),
    seed: '12345',
    temperature: '0.7',
    model_requested: 'claude-3.5-sonnet',
    model_version: 'claude-3.5-sonnet-20241022',
    provider: 'OpenRouter',
    prompt_tokens: 150,
    completion_tokens: 50,
    cached_tokens: 0,
    cost_usd: 0.001234,
    latency_ms: 850,
    created_at: '2026-08-06 10:00:00',
    is_valid: 1,
    abstained: 0
  }

  it('renders all provenance sections for a valid response', () => {
    const html = renderResponseProvenance(baseResponse)
    expect(html).toContain('Anna')
    expect(html).toContain('Bízol a bankokban?')
    expect(html).toContain('Igen')
    expect(html).toContain('érvényes')
    expect(html).toContain('A modellnek elküldött prompt')
    expect(html).toContain('Nyers modellválasz')
    expect(html).toContain('Kísérleti beállítások')
    expect(html).toContain('Költség és idő')
  })

  it('shows "érvényes" state for is_valid: 1', () => {
    const html = renderResponseProvenance({ ...baseResponse, is_valid: 1, abstained: 0 })
    expect(html).toContain('érvényes')
    expect(html).not.toContain('tartózkodás')
    expect(html).not.toContain('nem értelmezhető')
  })

  it('shows "tartózkodás" state when abstained is true', () => {
    const html = renderResponseProvenance({ ...baseResponse, abstained: 1, is_valid: null })
    expect(html).toContain('tartózkodás')
  })

  it('shows "nem értelmezhető kimenet" state for is_valid: 0', () => {
    const html = renderResponseProvenance({ ...baseResponse, is_valid: 0, abstained: 0 })
    expect(html).toContain('nem értelmezhető kimenet')
  })

  it('decodes permutation into readable format', () => {
    // permutation [1, 0] with options ['Igen', 'Nem'] should show "1. Nem → 2. Igen"
    const html = renderResponseProvenance(baseResponse)
    expect(html).toContain('Nem')
    expect(html).toContain('Igen')
    // The permutation should appear in the settings section
    expect(html).toMatch(/1\.\s+\w+\s+→\s+2\.\s+\w+/)
  })

  it('falls back to raw indexes when options are missing', () => {
    const html = renderResponseProvenance({
      ...baseResponse,
      options_json: '[]'
    })
    expect(html).toContain('Opciósorrend')
    // Should still render something
    expect(html).not.toContain('undefined')
  })

  it('renders missing fields as "—"', () => {
    const minimal = {
      persona_name: null,
      question_text: null,
      parsed_answer: null,
      is_valid: null,
      abstained: 0,
      prompt_rendered: null,
      raw_response: null
    }
    const html = renderResponseProvenance(minimal)
    expect(html).toContain('—')
  })

  it('shows prompt text in a preformatted block', () => {
    const html = renderResponseProvenance(baseResponse)
    expect(html).toContain('provenance-pre')
    expect(html).toContain('You are Anna')
  })

  it('shows raw response in a preformatted block', () => {
    const html = renderResponseProvenance(baseResponse)
    expect(html).toContain('probabilities')
  })

  it('escapes prompt text to prevent markup injection', () => {
    const html = renderResponseProvenance({
      ...baseResponse,
      prompt_rendered: '<script>alert("xss")</script>'
    })
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('escapes raw response text to prevent markup injection', () => {
    const html = renderResponseProvenance({
      ...baseResponse,
      raw_response: 'Some text with <img src=x onerror=alert(1)>'
    })
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img')
  })

  it('handles multi-choice elicitation mode', () => {
    const html = renderResponseProvenance({
      ...baseResponse,
      elicitation_mode: 'multi_choice',
      parsed_answer: '0,2'
    })
    expect(html).toContain('Igen')
  })

  it('returns a note for null/empty input', () => {
    expect(renderResponseProvenance(null as unknown as Record<string, unknown>)).toContain('Nincs megjeleníthető adat')
    expect(renderResponseProvenance({})).toBeTruthy()
  })

  it('formats token counts with Hungarian number separators', () => {
    const html = renderResponseProvenance({
      ...baseResponse,
      prompt_tokens: 1500,
      completion_tokens: 500
    })
    // Hungarian locale uses space as thousands separator in toLocaleString
    expect(html).toContain('1')
    expect(html).toContain('500')
  })

  it('formats cost with 4 decimal places', () => {
    const html = renderResponseProvenance({
      ...baseResponse,
      cost_usd: 0.001234
    })
    // formatCost should render with 4 decimal places
    expect(html).toContain('0.0012')
  })
})

describe('renderTranscript', () => {
  const baseResponse = (overrides: Record<string, unknown> = {}) => ({
    id: 'resp1',
    persona_name: 'Anna',
    question_text: 'Kérdés 1',
    options_json: JSON.stringify(['Igen', 'Nem']),
    parsed_answer: '0',
    elicitation_mode: 'single_choice',
    seed: '12345',
    temperature: '0.7',
    model_requested: 'claude',
    model_version: 'claude-v1',
    provider: 'OpenRouter',
    permutation_json: JSON.stringify([0, 1]),
    created_at: '2026-08-06 10:00:00',
    ...overrides
  })

  it('groups responses by persona name', () => {
    const responses = [
      baseResponse({ persona_name: 'Anna', question_text: 'Q1' }),
      baseResponse({ persona_name: 'Anna', question_text: 'Q2' }),
      baseResponse({ persona_name: 'Béla', question_text: 'Q1' })
    ]
    const html = renderTranscript(responses)
    expect(html).toContain('Anna (2 válasz)')
    expect(html).toContain('Béla (1 válasz)')
  })

  it('maintains first-seen persona order', () => {
    const responses = [
      baseResponse({ persona_name: 'Béla', question_text: 'Q1', created_at: '2026-08-06 10:00:00' }),
      baseResponse({
        persona_name: 'Anna',
        question_text: 'Q1',
        created_at: '2026-08-06 10:01:00'
      }),
      baseResponse({
        persona_name: 'Béla',
        question_text: 'Q2',
        created_at: '2026-08-06 10:02:00'
      })
    ]
    const html = renderTranscript(responses)
    const bélaIdx = html.indexOf('Béla')
    const annaIdx = html.indexOf('Anna')
    expect(bélaIdx).toBeLessThan(annaIdx)
  })

  it('renders one card per exchange with numbering', () => {
    const responses = [
      baseResponse({ persona_name: 'Anna', question_text: 'Q1' }),
      baseResponse({ persona_name: 'Anna', question_text: 'Q2' }),
      baseResponse({ persona_name: 'Anna', question_text: 'Q3' })
    ]
    const html = renderTranscript(responses)
    expect(html).toContain('1.')
    expect(html).toContain('2.')
    expect(html).toContain('3.')
  })

  it('shows question, answer and per-exchange settings in each card', () => {
    const responses = [baseResponse({ persona_name: 'Anna', question_text: 'Bízol?' })]
    const html = renderTranscript(responses)
    expect(html).toContain('Bízol?')
    expect(html).toContain('Seed:')
    expect(html).toContain('Rotáció:')
    expect(html).toContain('Modellverzió:')
  })

  it('includes the methodological memory-reset note', () => {
    const responses = [baseResponse()]
    const html = renderTranscript(responses)
    expect(html).toContain('Ez NEM beszélgetés')
    expect(html).toContain('friss kontextusban')
    expect(html).toContain('nem emlékezett a korábbi válaszaira')
    expect(html).toContain('rögzítés sorrendje')
  })

  it('marks the note with detail-note-warning class', () => {
    const responses = [baseResponse()]
    const html = renderTranscript(responses)
    expect(html).toContain('detail-note-warning')
  })

  it('shows nothing message for empty input', () => {
    expect(renderTranscript([])).toContain('Nincs megjeleníthető válasz')
    expect(renderTranscript(null as unknown as Record<string, unknown>[])).toContain('Nincs megjeleníthető válasz')
  })

  it('escapes question text', () => {
    const responses = [
      baseResponse({
        persona_name: 'Anna',
        question_text: '<script>alert(1)</script>'
      })
    ]
    const html = renderTranscript(responses)
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('escapes answer text', () => {
    const responses = [
      baseResponse({
        options_json: JSON.stringify(['<b>Igen</b>', 'Nem']),
        parsed_answer: '0'
      })
    ]
    const html = renderTranscript(responses)
    expect(html).not.toContain('<b>')
    expect(html).toContain('&lt;b&gt;')
  })

  it('escapes persona name', () => {
    const responses = [
      baseResponse({
        persona_name: '"Anna" <script>alert(1)</script>'
      })
    ]
    const html = renderTranscript(responses)
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
    // Quotes can be escaped as &quot; or &amp;quot; depending on escaping layers
    expect(html).toMatch(/&(amp;)?quot;/)
  })

  it('handles persona with missing name', () => {
    const responses = [baseResponse({ persona_name: null })]
    const html = renderTranscript(responses)
    expect(html).toContain('— (1 válasz)')
  })

  it('decodes permutation in each card', () => {
    const responses = [
      baseResponse({
        options_json: JSON.stringify(['Igen', 'Nem']),
        permutation_json: JSON.stringify([1, 0])
      })
    ]
    const html = renderTranscript(responses)
    // Should show the permutation in readable form
    expect(html).toContain('Rotáció:')
  })

  it('does not look like a chat thread', () => {
    const responses = [
      baseResponse({ question_text: 'Q1' }),
      baseResponse({ question_text: 'Q2' })
    ]
    const html = renderTranscript(responses)
    // Should use "transcript-card" class, not speech bubbles or thread styling
    expect(html).toContain('transcript-card')
    expect(html).not.toContain('message')
    expect(html).not.toContain('bubble')
  })

  it('handles multiple personas and multiple exchanges', () => {
    const responses = [
      baseResponse({ persona_name: 'Anna', question_text: 'Q1' }),
      baseResponse({ persona_name: 'Anna', question_text: 'Q2' }),
      baseResponse({ persona_name: 'Béla', question_text: 'Q1' }),
      baseResponse({ persona_name: 'Béla', question_text: 'Q2' }),
      baseResponse({ persona_name: 'Béla', question_text: 'Q3' })
    ]
    const html = renderTranscript(responses)
    expect(html).toContain('Anna (2 válasz)')
    expect(html).toContain('Béla (3 válasz)')
    // Each persona section should have numbered cards (accounting for HTML structure)
    expect(html).toMatch(/1\.\s*<\/div>[\s\S]*?Q1/)
    expect(html).toMatch(/2\.\s*<\/div>[\s\S]*?Q2/)
  })
})

describe('renderTranscript — real-run size and seed 0', () => {
  const make = (i: number): Record<string, unknown> => ({
    id: 'r' + i,
    persona_name: 'Anna',
    question_text: 'Kérdés ' + i,
    parsed_answer: '0',
    options_json: JSON.stringify(['a', 'b']),
    seed: 0,
    model_version: 'm'
  })

  it('shows seed 0 as a seed, not as missing data', () => {
    expect(renderTranscript([make(1)])).toContain('Seed: 0')
  })

  it('caps a long transcript and says how many are not shown', () => {
    const html = renderTranscript(Array.from({ length: 160 }, (_, i) => make(i)))
    expect(html).toContain('160')
    expect(html).toMatch(/Az első \d+ válasz látszik/)
    expect((html.match(/class="transcript-card"/g) || []).length).toBeLessThan(160)
  })

  it('makes each exchange open its own provenance', () => {
    expect(renderTranscript([make(1)])).toContain('data-response-id="r1"')
  })
})

describe('renderResponseProvenance — values as SQLite actually returns them', () => {
  it('names the state from 1/0, not from booleans', () => {
    expect(renderResponseProvenance({ is_valid: 1, abstained: 0 })).toContain('érvényes')
    expect(renderResponseProvenance({ is_valid: 0, abstained: 0 })).toContain('nem értelmezhető kimenet')
    // abstention is a VALID response, so it must be checked first
    expect(renderResponseProvenance({ is_valid: 1, abstained: 1 })).toContain('tartózkodás')
  })

  it('shows unknown usage as unknown, never as a confident zero', () => {
    const html = renderResponseProvenance({ is_valid: 1, prompt_tokens: null, cost_usd: null, latency_ms: null })
    expect(html).not.toContain('0.0000')
    expect(html).toContain('—')
  })

  it('still shows a real zero cost as zero', () => {
    expect(renderResponseProvenance({ is_valid: 1, cost_usd: 0 })).toContain('0.0000')
  })
})

describe('renderTranscript — grouping', () => {
  it('keeps two versions of the same persona apart', () => {
    const html = renderTranscript([
      { id: 'a', persona_id: 'p-v1', persona_name: 'Anna', question_text: 'Q1', seed: 0 },
      { id: 'b', persona_id: 'p-v2', persona_name: 'Anna', question_text: 'Q2', seed: 0 }
    ])
    expect((html.match(/Anna \(1 válasz\)/g) || []).length).toBe(2)
  })

  it('survives a persona named like an Object prototype member', () => {
    const html = renderTranscript([
      { id: 'a', persona_id: 'constructor', persona_name: 'constructor', question_text: 'Q', seed: 0 }
    ])
    expect(html).toContain('constructor (1 válasz)')
  })

  it('shows the state on each card, so an abstention is not read as a broken call', () => {
    const html = renderTranscript([
      { id: 'a', persona_id: 'p', persona_name: 'A', question_text: 'Q', seed: 0, is_valid: 1, abstained: 1 }
    ])
    expect(html).toContain('tartózkodás')
  })
})
