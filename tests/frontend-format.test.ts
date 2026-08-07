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

const { parseDemographics, parseQuestions } = loadPublicScript<{
  parseDemographics: (text: string) => Record<string, string>
  parseQuestions: (text: string) => { text: string; options: string[]; scaleType?: string; scaleDirection?: string }[]
}>('parsers.js', '{ parseDemographics, parseQuestions }')

// These used to be mirrored in the test because they lived inside the DOM-bound
// app.js. They now live in parsers.js and the real implementation is under test.
describe('parseDemographics', () => {
  it('keeps everything after the first colon', () => {
    expect(parseDemographics('hírérdeklődés: széleskörű: külföldi hírek (91%), belföldi (89%)')).toEqual({
      hírérdeklődés: 'széleskörű: külföldi hírek (91%), belföldi (89%)'
    })
  })

  it('ignores lines without a key or a value', () => {
    expect(parseDemographics('kor: 34\n\n: üres\nnincs kettőspont\nnem:')).toEqual({ kor: '34' })
  })
})

describe('parseQuestions', () => {
  it('reads a question block with its options', () => {
    expect(parseQuestions('Kérdés?\n- A\n- B')).toEqual([{ text: 'Kérdés?', options: ['A', 'B'] }])
  })

  // Without the marker round-trip a version edit silently re-asks a
  // multi-select question as a sum-to-1 distribution.
  it('round-trips the scale markers', () => {
    expect(parseQuestions('Kérdés? [multi_choice, descending]\n- A\n- B')).toEqual([
      { text: 'Kérdés?', options: ['A', 'B'], scaleType: 'multi_choice', scaleDirection: 'descending' }
    ])
  })

  it('defaults the direction when only the scale type is marked', () => {
    expect(parseQuestions('Kérdés? [multi_choice]\n- A\n- B')[0]?.scaleDirection).toBe('ascending')
  })

  it('drops a block with no options', () => {
    expect(parseQuestions('Csak egy kérdés?')).toEqual([])
  })
})
