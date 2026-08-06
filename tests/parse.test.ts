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
