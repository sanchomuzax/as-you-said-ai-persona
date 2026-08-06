import { describe, it, expect } from 'vitest'
import { parseDistribution } from '../src/lib/parse.js'

describe('parseDistribution', () => {
  const keys = ['A', 'B', 'C']

  it('parses a clean JSON distribution and normalizes to 1', () => {
    const r = parseDistribution('{"A": 0.5, "B": 0.3, "C": 0.2}', keys)
    expect(r.isValid).toBe(true)
    expect(r.distribution).toEqual({ A: 0.5, B: 0.3, C: 0.2 })
    expect(r.topChoice).toBe('A')
  })

  it('extracts JSON wrapped in prose or code fences', () => {
    const raw = 'Here is my estimate:\n```json\n{"A": 0.1, "B": 0.7, "C": 0.2}\n```'
    const r = parseDistribution(raw, keys)
    expect(r.isValid).toBe(true)
    expect(r.topChoice).toBe('B')
  })

  it('normalizes distributions that do not sum to 1', () => {
    const r = parseDistribution('{"A": 2, "B": 1, "C": 1}', keys)
    expect(r.isValid).toBe(true)
    expect(r.distribution!.A).toBeCloseTo(0.5)
  })

  it('defaults missing keys to 0', () => {
    const r = parseDistribution('{"A": 1}', keys)
    expect(r.isValid).toBe(true)
    expect(r.distribution).toEqual({ A: 1, B: 0, C: 0 })
  })

  it('flags empty output as invalid, keeping the raw text', () => {
    const r = parseDistribution('', keys)
    expect(r.isValid).toBe(false)
    expect(r.distribution).toBeNull()
  })

  it('flags non-JSON output as invalid', () => {
    const r = parseDistribution('I would say mostly B.', keys)
    expect(r.isValid).toBe(false)
  })

  it('flags non-positive totals as invalid', () => {
    const r = parseDistribution('{"A": 0, "B": 0, "C": 0}', keys)
    expect(r.isValid).toBe(false)
  })

  it('handles brace characters inside JSON string values', () => {
    const r = parseDistribution('{"note": "opt {weird}", "A": 1, "B": 0, "C": 0}', keys)
    expect(r.isValid).toBe(true)
    expect(r.topChoice).toBe('A')
  })

  it('detects abstention marker', () => {
    const r = parseDistribution('{"abstain": true}', keys)
    expect(r.abstained).toBe(true)
    expect(r.isValid).toBe(true)
    expect(r.distribution).toBeNull()
  })
})

describe('parseDistribution — multi_choice mode', () => {
  const keys = ['A', 'B', 'C']

  it('keeps independent probabilities instead of normalizing them', () => {
    const r = parseDistribution('{"A": 0.8, "B": 0.7, "C": 0.1}', keys, 'multi_choice')
    expect(r.isValid).toBe(true)
    expect(r.distribution).toEqual({ A: 0.8, B: 0.7, C: 0.1 })
  })

  it('reports every option above the selection threshold, not just the top one', () => {
    const r = parseDistribution('{"A": 0.8, "B": 0.7, "C": 0.1}', keys, 'multi_choice')
    expect(r.selectedKeys).toEqual(['A', 'B'])
    expect(r.topChoice).toBe('A')
  })

  it('treats "selects none of them" as a valid answer with an empty selection', () => {
    const r = parseDistribution('{"A": 0.1, "B": 0.2, "C": 0.0}', keys, 'multi_choice')
    expect(r.isValid).toBe(true)
    expect(r.selectedKeys).toEqual([])
  })

  it('rejects values outside 0..1 instead of silently rescaling them', () => {
    expect(parseDistribution('{"A": 80, "B": 70, "C": 10}', keys, 'multi_choice').isValid).toBe(false)
    expect(parseDistribution('{"A": -0.2, "B": 0.5, "C": 0.1}', keys, 'multi_choice').isValid).toBe(false)
  })

  it('treats a missing key as probability 0', () => {
    const r = parseDistribution('{"A": 0.9}', keys, 'multi_choice')
    expect(r.isValid).toBe(true)
    expect(r.distribution).toEqual({ A: 0.9, B: 0, C: 0 })
  })

  it('still honours abstention', () => {
    const r = parseDistribution('{"abstain": true}', keys, 'multi_choice')
    expect(r.abstained).toBe(true)
    expect(r.isValid).toBe(true)
    expect(r.selectedKeys).toBeNull()
  })

  it('flags unparseable output as invalid', () => {
    expect(parseDistribution('nem json', keys, 'multi_choice').isValid).toBe(false)
  })

  it('leaves single-choice behaviour unchanged', () => {
    const r = parseDistribution('{"A": 2, "B": 1, "C": 1}', keys, 'single_choice')
    expect(r.distribution!.A).toBeCloseTo(0.5)
    expect(r.selectedKeys).toBeNull()
  })
})

describe('parseDistribution — broken output must not become an answer', () => {
  const keys = ['A', 'B', 'C']

  it('rejects objects that contain none of the expected keys instead of reading them as "selects none"', () => {
    const cases = [
      '{"probabilities": {"A": 0.8, "B": 0.1, "C": 0.1}}',
      '{"abstain": "yes"}',
      '{"error": "I cannot answer"}',
      '{"A_option": 0.8, "B_option": 0.2}'
    ]
    for (const raw of cases) {
      expect(parseDistribution(raw, keys, 'multi_choice').isValid, raw).toBe(false)
      expect(parseDistribution(raw, keys, 'single_choice').isValid, raw).toBe(false)
    }
  })

  it('still accepts a genuine all-zero answer, where the keys are present', () => {
    const r = parseDistribution('{"A": 0, "B": 0, "C": 0}', keys, 'multi_choice')
    expect(r.isValid).toBe(true)
    expect(r.selectedKeys).toEqual([])
  })

  it('accepts numeric strings the same way in both modes', () => {
    const multi = parseDistribution('{"A": "0.8", "B": "0.1", "C": "0.0"}', keys, 'multi_choice')
    expect(multi.isValid).toBe(true)
    expect(multi.distribution!.A).toBeCloseTo(0.8)
    const single = parseDistribution('{"A": "0.8", "B": "0.1", "C": "0.1"}', keys, 'single_choice')
    expect(single.isValid).toBe(true)
    expect(single.distribution!.A).toBeCloseTo(0.8)
  })

  it('rejects non-numeric values in both modes', () => {
    expect(parseDistribution('{"A": "sok", "B": 0.5, "C": 0.5}', keys, 'multi_choice').isValid).toBe(false)
    expect(parseDistribution('{"A": "sok", "B": "kevés", "C": "semmi"}', keys, 'single_choice').isValid).toBe(false)
  })

  it('tolerates floating point noise just above 1', () => {
    expect(parseDistribution('{"A": 1.0000000001, "B": 0, "C": 0}', keys, 'multi_choice').isValid).toBe(true)
  })
})
