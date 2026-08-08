import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

interface ProbeQuestion {
  text: string
  options: string[]
  _reference?: { mit?: string }
  _tier?: string
  _torzitas?: string
}

const seedPath = fileURLToPath(new URL('../agent/seed/default-persona-probe-v2.json', import.meta.url))
const seed = JSON.parse(readFileSync(seedPath, 'utf8')) as {
  questionnaires: { questions: ProbeQuestion[] }[]
}
const questions = seed.questionnaires[0]!.questions

describe('approved probe-v2 content contract (issue #36)', () => {
  it('asks all five reference role items for the most likely person', () => {
    const roleItems = questions.filter((q) => q._reference)
    expect(roleItems).toHaveLength(5)
    for (const item of roleItems) {
      expect(item.text, item._reference?.mit).toMatch(/legvalószínűbben/i)
    }
  })

  it('uses the broad role measured by the doctor and ICT references', () => {
    const doctor = questions.find((q) => q._reference?.mit?.startsWith('orvosok nőaránya'))!
    const ict = questions.find((q) => q._reference?.mit?.startsWith('IKT-szakemberek nőaránya'))!

    expect(doctor.text).toMatch(/orvos/i)
    expect(doctor.text).not.toMatch(/háziorvos/i)
    expect(ict.text).toMatch(/informatikus kolléga/i)
    expect(ict.text).not.toMatch(/rendszergazda/i)
  })

  it('contains at least two good concepts, including own-data download', () => {
    const goodItems = questions.filter((q) => q._tier === 'jó')
    expect(goodItems.length).toBeGreaterThanOrEqual(2)
    expect(goodItems.some((q) => /saját adat.*letölt|adat.*letölt/i.test(q.text))).toBe(true)
  })

  it('classifies the registration-gated webshop price as a borderline concept', () => {
    const webshop = questions.find((q) => /webshop/i.test(q.text) && /regisztr/i.test(q.text))!
    expect(webshop._tier).toBe('határeset')
  })

  it('labels the three-option equal-news item as position bias, never recency', () => {
    const positionBias = questions.filter((q) => q._torzitas === 'pozíciótorzítás (egyenrangú opciók)')
    expect(positionBias).toHaveLength(1)
    expect(questions.filter((q) => q._torzitas === 'recency')).toHaveLength(0)
  })

  it('contains exactly 32 questions', () => {
    expect(questions).toHaveLength(32)
  })

  it('contains 117 option-driven rotations per seed (not total run cells)', () => {
    const rotationsPerSeed = questions.reduce((sum, question) => sum + question.options.length, 0)
    expect(rotationsPerSeed, 'seedenkénti rotációk száma').toBe(117)
  })
})
