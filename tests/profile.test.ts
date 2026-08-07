import { describe, it, expect, beforeEach } from 'vitest'
import { createDb, type Db } from '../src/db.js'
import {
  promptTemplateHash,
  computeProfileMetrics,
  profileStatus,
  PROFILE_VALIDITY_DAYS,
  type StoredProfile
} from '../src/lib/profile.js'

describe('promptTemplateHash', () => {
  it('is stable across calls', () => {
    expect(promptTemplateHash()).toBe(promptTemplateHash())
  })

  it('is a short hex digest', () => {
    expect(promptTemplateHash()).toMatch(/^[0-9a-f]{16}$/)
  })
})

describe('profileStatus', () => {
  const key = {
    modelRequested: 'm1',
    modelVersion: 'm1-2026-05',
    provider: 'DeepInfra',
    promptTemplateHash: 'abc123',
    probeQuestionnaireId: 'probe-1',
    language: 'hu'
  }
  const profile = (overrides: Partial<StoredProfile> = {}): StoredProfile => ({
    id: 'p1',
    ...key,
    metrics: null,
    runIds: ['r1'],
    createdAt: '2026-08-01 10:00:00',
    validUntil: '2026-10-30 10:00:00',
    ...overrides
  })

  it('is valid when every key component matches and it has not expired', () => {
    expect(profileStatus(profile(), key, '2026-08-07T10:00:00Z')).toBe('valid')
  })

  it('goes stale when the model version changed under the same alias', () => {
    expect(profileStatus(profile(), { ...key, modelVersion: 'm1-2026-09' }, '2026-08-07T10:00:00Z')).toBe('stale')
  })

  it('goes stale when the serving provider changed', () => {
    expect(profileStatus(profile(), { ...key, provider: 'Fireworks' }, '2026-08-07T10:00:00Z')).toBe('stale')
  })

  // An edit to the elicitation template invalidates every profile: the numbers
  // describe the model's behaviour under a prompt that no longer exists.
  it('goes stale when the prompt template changed', () => {
    expect(profileStatus(profile(), { ...key, promptTemplateHash: 'other' }, '2026-08-07T10:00:00Z')).toBe('stale')
  })

  it('goes stale when the probe questionnaire version changed', () => {
    expect(profileStatus(profile(), { ...key, probeQuestionnaireId: 'probe-2' }, '2026-08-07T10:00:00Z')).toBe('stale')
  })

  it('goes stale after valid_until', () => {
    expect(profileStatus(profile(), key, '2026-11-01T10:00:00Z')).toBe('stale')
  })

  // A profile measured without a pinned provider cannot claim to describe one.
  it('treats an unpinned profile and a pinned run as different keys', () => {
    expect(profileStatus(profile({ provider: null }), key, '2026-08-07T10:00:00Z')).toBe('stale')
  })

  it('keeps the default validity window at 90 days', () => {
    expect(PROFILE_VALIDITY_DAYS).toBe(90)
  })
})

describe('computeProfileMetrics', () => {
  let db: Db

  /**
   * A calibration run: one 4-option ordinal question, control arm only, two
   * seeds and the four balanced rotations.
   */
  function seedRun(answersByRotation: Record<string, string>, scaleType = 'ordinal'): void {
    db.prepare('INSERT INTO questionnaires (id, lineage_id, name) VALUES (?,?,?)').run('probe', 'probe', 'Próba')
    db.prepare(
      'INSERT INTO questions (id, questionnaire_id, ord, text, scale_type, options_json, scale_direction) VALUES (?,?,?,?,?,?,?)'
    ).run('q1', 'probe', 0, 'Mennyire ért egyet?', scaleType, JSON.stringify(['Egyáltalán', 'Kicsit', 'Eléggé', 'Teljesen']), 'ascending')
    db.prepare('INSERT INTO runs (id, questionnaire_id, name, config_json, status) VALUES (?,?,?,?,?)').run(
      'cal', 'probe', 'Kalibráció', JSON.stringify({ model: 'm1', temperature: 1, seeds: [0, 1], baselineArm: true }), 'completed'
    )
    let n = 0
    for (const [rotation, answer] of Object.entries(answersByRotation)) {
      for (const seed of [0, 1]) {
        const distribution: Record<string, number> = { '0': 0, '1': 0, '2': 0, '3': 0 }
        distribution[answer] = 1
        db.prepare(
          `INSERT INTO responses (id, run_id, persona_id, question_id, condition, model_requested, model_version,
             provider, temperature, seed, permutation_json, prompt_rendered, raw_response,
             parsed_distribution_json, parsed_answer, elicitation_mode, is_valid, abstained,
             prompt_tokens, completion_tokens, cost_usd)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        ).run(
          `resp-${n++}`, 'cal', null, 'q1', 'baseline', 'm1', 'm1-2026-05', 'DeepInfra', 1, seed,
          rotation, 'prompt', 'raw', JSON.stringify(distribution), answer, 'single_choice', 1, 0, 10, 5, 0.001
        )
      }
    }
  }

  beforeEach(() => {
    db = createDb(':memory:')
  })

  it('reports the default distribution of the control arm per question', () => {
    // whichever rotation is used, the model picks original option 3
    seedRun({ '[0,1,2,3]': '3', '[1,2,3,0]': '3', '[2,3,0,1]': '3', '[3,0,1,2]': '3' })
    const metrics = computeProfileMetrics(db, ['cal'])
    expect(metrics.perQuestion).toHaveLength(1)
    expect(metrics.perQuestion[0]!.defaultDistribution).toEqual([0, 0, 0, 1])
    expect(metrics.perQuestion[0]!.text).toBe('Mennyire ért egyet?')
  })

  /**
   * The point of the balanced permutation: a model that answers by CONTENT picks
   * the same option wherever it sits, so no position is preferred.
   */
  it('finds no position bias when the answer follows the content', () => {
    seedRun({ '[0,1,2,3]': '3', '[1,2,3,0]': '3', '[2,3,0,1]': '3', '[3,0,1,2]': '3' })
    const metrics = computeProfileMetrics(db, ['cal'])
    expect(metrics.priorBias.byPosition).toEqual([0.25, 0.25, 0.25, 0.25])
    expect(metrics.priorBias.maxDeviation).toBeCloseTo(0, 5)
  })

  /**
   * A model that always picks the FIRST listed option answers by position. With
   * balanced rotations that shows up as one position taking every choice.
   */
  it('detects a first-position preference', () => {
    // rotation[0] is the original index shown first; the answer equals it
    seedRun({ '[0,1,2,3]': '0', '[1,2,3,0]': '1', '[2,3,0,1]': '2', '[3,0,1,2]': '3' })
    const metrics = computeProfileMetrics(db, ['cal'])
    expect(metrics.priorBias.byPosition).toEqual([1, 0, 0, 0])
    expect(metrics.priorBias.maxDeviation).toBeCloseTo(0.75, 5)
    expect(metrics.priorBias.strongestPosition).toBe(0)
  })

  // On a directed scale, how far toward the positive pole the model sits by
  // default. 0 is the scale midpoint; +0.5 is the top of the scale.
  it('measures the positivity offset on a directed scale', () => {
    seedRun({ '[0,1,2,3]': '3', '[1,2,3,0]': '3', '[2,3,0,1]': '3', '[3,0,1,2]': '3' })
    expect(computeProfileMetrics(db, ['cal']).positivityOffset).toBeCloseTo(0.5, 5)
  })

  it('reports a negative offset when the model sits at the bottom of the scale', () => {
    seedRun({ '[0,1,2,3]': '0', '[1,2,3,0]': '0', '[2,3,0,1]': '0', '[3,0,1,2]': '0' })
    expect(computeProfileMetrics(db, ['cal']).positivityOffset).toBeCloseTo(-0.5, 5)
  })

  // Categorical options have no poles, so a positivity number would be meaningless.
  it('reports no positivity offset when no question has a directed scale', () => {
    seedRun({ '[0,1,2,3]': '3', '[1,2,3,0]': '3', '[2,3,0,1]': '3', '[3,0,1,2]': '3' }, 'categorical')
    expect(computeProfileMetrics(db, ['cal']).positivityOffset).toBeNull()
  })

  it('records the provenance of the profile', () => {
    seedRun({ '[0,1,2,3]': '3', '[1,2,3,0]': '3', '[2,3,0,1]': '3', '[3,0,1,2]': '3' })
    const metrics = computeProfileMetrics(db, ['cal'])
    expect(metrics.provenance.runIds).toEqual(['cal'])
    expect(metrics.provenance.cellCount).toBe(8)
    expect(metrics.provenance.costUsd).toBeCloseTo(0.008, 6)
    expect(metrics.invalidRate).toBe(0)
    expect(metrics.abstainRate).toBe(0)
  })

  // The profile describes the model's DEFAULT behaviour. A persona cell that
  // slipped into a calibration run would describe a persona instead.
  it('ignores persona cells entirely', () => {
    seedRun({ '[0,1,2,3]': '3', '[1,2,3,0]': '3', '[2,3,0,1]': '3', '[3,0,1,2]': '3' })
    db.prepare('INSERT INTO personas (id, lineage_id, name, demographics_json) VALUES (?,?,?,?)').run(
      'per1', 'per1', 'Anna', '{}'
    )
    db.prepare(
      `INSERT INTO responses (id, run_id, persona_id, question_id, condition, model_requested, temperature,
         seed, permutation_json, prompt_rendered, raw_response, parsed_distribution_json, parsed_answer,
         elicitation_mode, is_valid, abstained)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      'persona-resp', 'cal', 'per1', 'q1', 'persona', 'm1', 1, 0, '[0,1,2,3]', 'p', 'r',
      JSON.stringify({ '0': 1, '1': 0, '2': 0, '3': 0 }), '0', 'single_choice', 1, 0
    )
    const metrics = computeProfileMetrics(db, ['cal'])
    expect(metrics.perQuestion[0]!.defaultDistribution).toEqual([0, 0, 0, 1])
    expect(metrics.provenance.cellCount).toBe(8)
  })

  it('returns an empty, clearly-marked profile when there is nothing to measure', () => {
    const metrics = computeProfileMetrics(db, ['missing'])
    expect(metrics.perQuestion).toEqual([])
    expect(metrics.positivityOffset).toBeNull()
    expect(metrics.provenance.cellCount).toBe(0)
  })

  // results.ts already dedupes cells (issue #16); the profile path must not be
  // the one aggregator that counts a repeated measurement twice.
  it('counts a duplicated cell once', () => {
    seedRun({ '[0,1,2,3]': '3', '[1,2,3,0]': '3', '[2,3,0,1]': '3', '[3,0,1,2]': '3' })
    db.prepare(
      `INSERT INTO responses (id, run_id, persona_id, question_id, condition, model_requested, temperature,
         seed, permutation_json, prompt_rendered, raw_response, parsed_distribution_json, parsed_answer,
         elicitation_mode, is_valid, abstained)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      'dup', 'cal', null, 'q1', 'baseline', 'm1', 1, 0, '[0,1,2,3]', 'p', 'r',
      JSON.stringify({ '0': 1, '1': 0, '2': 0, '3': 0 }), '0', 'single_choice', 1, 0
    )
    const metrics = computeProfileMetrics(db, ['cal'])
    expect(metrics.perQuestion[0]!.defaultDistribution).toEqual([0, 0, 0, 1])
    expect(metrics.priorBias.byPosition).toEqual([0.25, 0.25, 0.25, 0.25])
    expect(metrics.provenance.cellCount).toBe(8)
    expect(metrics.provenance.duplicateCellCount).toBe(1)
  })

  // Normalized probabilities and independent supports are different quantities;
  // averaging them together is the bug the mode split was introduced to remove.
  it('excludes rows elicited under a different mode, and says how many', () => {
    seedRun({ '[0,1,2,3]': '3', '[1,2,3,0]': '3', '[2,3,0,1]': '3', '[3,0,1,2]': '3' })
    db.prepare("UPDATE questions SET scale_type = 'multi_choice' WHERE id = 'q1'").run()
    const metrics = computeProfileMetrics(db, ['cal'])
    expect(metrics.perQuestion[0]!.aggregatedResponseCount).toBe(0)
    expect(metrics.perQuestion[0]!.legacyElicitationCount).toBe(8)
    expect(metrics.priorBias.byPosition).toEqual([])
  })

  // "I would select none of these" is written as an empty answer; Number('') is
  // 0, which would silently read as "chose the first option".
  it('does not read an empty multi-select answer as a choice', () => {
    seedRun({ '[0,1,2,3]': '3', '[1,2,3,0]': '3', '[2,3,0,1]': '3', '[3,0,1,2]': '3' })
    db.prepare("UPDATE questions SET scale_type = 'multi_choice' WHERE id = 'q1'").run()
    db.prepare("UPDATE responses SET elicitation_mode = 'multi_choice', parsed_answer = ''").run()
    const metrics = computeProfileMetrics(db, ['cal'])
    expect(metrics.priorBias.byPosition).toEqual([])
    expect(metrics.priorBias.maxDeviation).toBeNull()
  })

  // A zero would read as a measured "no position bias" finding.
  it('reports no position bias as unknown, not as zero', () => {
    seedRun({ '[0,1,2,3]': '3', '[1,2,3,0]': '3', '[2,3,0,1]': '3', '[3,0,1,2]': '3' })
    db.prepare('UPDATE responses SET is_valid = 0').run()
    const metrics = computeProfileMetrics(db, ['cal'])
    expect(metrics.priorBias.maxDeviation).toBeNull()
    expect(metrics.priorBias.strongestPosition).toBeNull()
  })

  it('reports the invalid and abstain rates of the control arm', () => {
    seedRun({ '[0,1,2,3]': '3', '[1,2,3,0]': '3', '[2,3,0,1]': '3', '[3,0,1,2]': '3' })
    db.prepare("UPDATE responses SET is_valid = 0 WHERE id = 'resp-0'").run()
    db.prepare("UPDATE responses SET abstained = 1 WHERE id = 'resp-1'").run()
    const metrics = computeProfileMetrics(db, ['cal'])
    expect(metrics.invalidRate).toBeCloseTo(1 / 8, 5)
    expect(metrics.abstainRate).toBeCloseTo(1 / 8, 5)
    // neither contributes to the measured default
    expect(metrics.perQuestion[0]!.aggregatedResponseCount).toBe(6)
  })
})
