import { describe, it, expect } from 'vitest'
import { loadPublicScript } from './helpers/load-public-script.js'

const { answerLabel } = loadPublicScript<{
  answerLabel: (a: unknown, o: unknown, multi?: boolean) => string
}>('format.js', '{ answerLabel }')

describe('answerLabel', () => {
  const options = ['Igen', 'Talán', 'Nem']

  it('resolves a single stored index to its option text', () => {
    expect(answerLabel('1', options)).toBe('Talán')
  })

  it('resolves a multi-select answer to every selected option', () => {
    expect(answerLabel('0,2', options, true)).toBe('Igen + Nem')
  })

  it('says "egyik sem" for an empty multi-select selection', () => {
    expect(answerLabel('', options, true)).toBe('egyik sem')
    expect(answerLabel('', options, false)).toBe('—')
  })

  it('falls back to the raw value when the option is unknown', () => {
    expect(answerLabel('9', options)).toBe('9')
    expect(answerLabel('Igen', [])).toBe('Igen')
  })

  it('handles a missing answer', () => {
    expect(answerLabel(null, options)).toBe('—')
    expect(answerLabel(undefined, options)).toBe('—')
  })
})

describe('parseDemographics (loaded from app.js is DOM-bound; logic mirrored here)', () => {
  // The parser lives in app.js next to the DOM wiring; this asserts the contract
  // the version round-trip depends on: only the first colon separates key from value.
  const parse = (text: string): Record<string, string> => {
    const out: Record<string, string> = {}
    text.split('\n').forEach((line) => {
      const trimmed = line.trim()
      const sep = trimmed.indexOf(':')
      if (sep > 0) {
        const key = trimmed.slice(0, sep).trim()
        const value = trimmed.slice(sep + 1).trim()
        if (key && value) out[key] = value
      }
    })
    return out
  }

  it('keeps everything after the first colon', () => {
    expect(parse('hírérdeklődés: széleskörű: külföldi hírek (91%), belföldi (89%)')).toEqual({
      hírérdeklődés: 'széleskörű: külföldi hírek (91%), belföldi (89%)'
    })
  })
})
