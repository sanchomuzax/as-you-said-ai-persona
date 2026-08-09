import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

interface ReferenceMetadata {
  mit?: string
  referenceShare?: number
  optionIndexes?: number[]
}

interface PilotQuestion {
  text: string
  options: string[]
  _reference?: ReferenceMetadata
}

interface PilotSeed {
  project: { name: string }
  questionnaires: { name: string; questions: PilotQuestion[] }[]
  _pilot: {
    maxTotalCells: number
    decisionRule: {
      minUsableRotationsPerItem: number
      rotationsPerItem: number
      maxOverallAbstainRate: number
      selectByReferenceAgreement: boolean
      maxUniformResponsesPerVariant: number
      tieBreak: string[]
      ifNoVariantPasses: string
    }
  }
}

const baseSeedPath = fileURLToPath(new URL('../agent/seed/default-persona-probe-v2.json', import.meta.url))
const pilotSeedPath = fileURLToPath(new URL('../agent/seed/default-persona-probe-f-pilot.json', import.meta.url))
const baseSeed = JSON.parse(readFileSync(baseSeedPath, 'utf8')) as {
  questionnaires: { questions: PilotQuestion[] }[]
}
const originalRoleItems = baseSeed.questionnaires[0]!.questions.filter((q) => q._reference)

function loadPilotSeed(): PilotSeed {
  expect(
    existsSync(pilotSeedPath),
    'Az F-blokk pilot seedje hiányzik: agent/seed/default-persona-probe-f-pilot.json'
  ).toBe(true)
  return JSON.parse(readFileSync(pilotSeedPath, 'utf8')) as PilotSeed
}

describe('F-role wording pilot seed contract (issue #36)', () => {
  it('targets the baseline project and has the three named wording variants', () => {
    const pilot = loadPilotSeed()
    expect(pilot.project.name).toBe('Modell-baseline próba')
    expect(pilot.questionnaires).toHaveLength(3)
    const names = pilot.questionnaires.map((q) => q.name).join(' | ')
    expect(names).toMatch(/mondatkiegészítés/i)
    expect(names).toMatch(/szerzői választás/i)
    expect(names).toMatch(/profilgenerátor/i)
  })

  it('reuses exactly the five original F items, options and machine-readable references in every variant', () => {
    const pilot = loadPilotSeed()
    expect(originalRoleItems).toHaveLength(5)
    const originalsByReference = new Map(originalRoleItems.map((q) => [q._reference!.mit, q]))

    for (const variant of pilot.questionnaires) {
      expect(variant.questions, variant.name).toHaveLength(5)
      for (const item of variant.questions) {
        expect(item.options, `${variant.name}: ${item.text}`).toHaveLength(4)
        const original = originalsByReference.get(item._reference?.mit)
        expect(original, `${variant.name}: ismeretlen F-item referencia`).toBeDefined()
        expect(item.options).toEqual(original!.options)
        expect(item._reference?.referenceShare).toBe(original!._reference?.referenceShare)
        expect(item._reference?.optionIndexes).toEqual(original!._reference?.optionIndexes)
      }
    }
  })

  it('frames every item as an explicitly fictional language-continuation task without demographic leakage', () => {
    const pilot = loadPilotSeed()
    for (const variant of pilot.questionnaires) {
      for (const item of variant.questions) {
        expect(item.text, `${variant.name}: nem egyértelműen kitalált`).toMatch(/kitalált|képzeletbeli|fiktív/i)
        expect(item.text, `${variant.name}: nem generatív nyelvi feladat`).toMatch(/folytat|mondat|szöveg|szerző|profil|generál/i)
        expect(item.text).not.toMatch(/\b(?:férfi|nő|nem|neme|nemi)\b/i)
        expect(item.text).not.toMatch(/melyik név szerepel a legvalószínűbben/i)
      }
    }
  })

  it('defines the profile-generator as a fictional generator choosing only from the role', () => {
    const profileGenerator = loadPilotSeed().questionnaires.find((q) => /profilgenerátor/i.test(q.name))!
    expect(profileGenerator).toBeDefined()
    for (const item of profileGenerator.questions) {
      expect(item.text).toMatch(/kitalált|képzeletbeli|fiktív/i)
      expect(item.text).toMatch(/adatgenerátor|profilgenerátor/i)
      expect(item.text).toMatch(/kizárólag.*szerep|csak.*szerep/i)
    }
  })

  it('caps the design at 60 cells per seed; execution must later persist explicit seeds:[0] in runs.config_json', () => {
    const pilot = loadPilotSeed()
    expect(pilot._pilot.maxTotalCells).toBe(60)
    const cellsPerSeed = pilot.questionnaires.reduce(
      (sum, variant) => sum + variant.questions.reduce((variantSum, q) => variantSum + q.options.length, 0),
      0
    )
    expect(cellsPerSeed).toBeLessThanOrEqual(60)
    // `seeds:[0]` is operational run provenance, not seed-file data: when the
    // pilot is executed, the run-level integration check must read it back
    // explicitly from runs.config_json. The content seed cannot prove that.
  })

  it('records usability/abstention gates and forbids choosing by reference agreement', () => {
    const rule = loadPilotSeed()._pilot.decisionRule
    expect(rule.minUsableRotationsPerItem).toBe(3)
    expect(rule.rotationsPerItem).toBe(4)
    expect(rule.maxOverallAbstainRate).toBe(0.2)
    expect(rule.selectByReferenceAgreement).toBe(false)
    expect(rule.maxUniformResponsesPerVariant).toBe(1)
    expect(rule.tieBreak).toEqual(['lowestAbstainRate', 'lowestRotationDispersion'])
    expect(rule.ifNoVariantPasses).toBe('stop')
  })
})
