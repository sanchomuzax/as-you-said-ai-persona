import { describe, it, expect, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { createDb, type Db } from '../src/db.js'
import { computeRunResults } from '../src/lib/results.js'
import { buildEvaluationPrompt } from '../src/lib/evaluate.js'
import type { StoredProfile, ProfileStatus } from '../src/lib/profile.js'

let db: Db
let runId: string
let qid: string
let p1: string

function insertResponse(opts: {
  dist?: Record<string, number> | null
  answer?: string | null
  valid?: boolean
  abstained?: boolean
  rotation?: number[]
  seed?: number
  persona?: string | null
  questionId?: string
  elicitationMode?: 'single_choice' | 'multi_choice'
  condition?: 'persona' | 'baseline' | null
}): void {
  db.prepare(
    `INSERT INTO responses (id, run_id, persona_id, question_id, model_requested, temperature, seed,
       permutation_json, prompt_rendered, raw_response, parsed_distribution_json, parsed_answer, is_valid, abstained,
       elicitation_mode, condition)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    randomUUID(), runId, opts.persona === undefined ? p1 : opts.persona, opts.questionId ?? qid, 'm', 1.0, opts.seed ?? 0,
    JSON.stringify(opts.rotation ?? [0, 1]), 'p', 'r',
    opts.dist === null ? null : JSON.stringify(opts.dist ?? { '0': 0.8, '1': 0.2 }),
    opts.answer === undefined ? '0' : opts.answer,
    opts.valid === false ? 0 : 1, opts.abstained ? 1 : 0,
    opts.elicitationMode ?? null, opts.condition ?? 'persona'
  )
}

beforeEach(() => {
  db = createDb(':memory:')
  const questionColumns = db.prepare('PRAGMA table_info(questions)').all() as unknown as { name: string }[]
  if (!questionColumns.some((c) => c.name === 'metadata_json')) {
    // Keep the output contract independently red on today's code instead of
    // failing only because the migration test already found the missing column.
    db.exec('ALTER TABLE questions ADD COLUMN metadata_json TEXT')
  }
  const questionnaireId = randomUUID()
  qid = randomUUID()
  p1 = randomUUID()
  runId = randomUUID()
  db.prepare('INSERT INTO questionnaires (id, name) VALUES (?,?)').run(questionnaireId, 'Q')
  db.prepare('INSERT INTO questions (id, questionnaire_id, ord, text, options_json) VALUES (?,?,0,?,?)').run(
    qid, questionnaireId, 'Trust?', JSON.stringify(['Yes', 'No'])
  )
  db.prepare('INSERT INTO personas (id, name, demographics_json) VALUES (?,?,?)').run(p1, 'P1', '{}')
  db.prepare('INSERT INTO runs (id, questionnaire_id, name, config_json) VALUES (?,?,?,?)').run(
    runId, questionnaireId, 'R', JSON.stringify({ model: 'm', temperature: 1, seeds: [0, 1] })
  )
  db.prepare('INSERT INTO run_personas (run_id, persona_id) VALUES (?,?)').run(runId, p1)
})

describe('computeRunResults', () => {
  it('aggregates mean distributions over valid responses', () => {
    insertResponse({ dist: { '0': 1, '1': 0 } })
    insertResponse({ dist: { '0': 0.5, '1': 0.5 }, seed: 1 })
    const r = computeRunResults(db, runId)
    expect(r.questions[0]!.aggregated[0]).toBeCloseTo(0.75)
    expect(r.questions[0]!.byPersona[p1]!.distribution[0]).toBeCloseTo(0.75)
  })

  it('excludes invalid and abstained rows from distributions but counts them', () => {
    insertResponse({ dist: { '0': 1, '1': 0 }, seed: 0 })
    insertResponse({ dist: null, answer: null, valid: false, seed: 1 })
    insertResponse({ dist: null, answer: null, abstained: true, rotation: [1, 0], seed: 0 })
    const r = computeRunResults(db, runId)
    expect(r.questions[0]!.aggregated[0]).toBeCloseTo(1)
    expect(r.questions[0]!.invalidCount).toBe(1)
    expect(r.questions[0]!.abstainCount).toBe(1)
    expect(r.invalidRate).toBeCloseTo(1 / 3)
  })

  it('computes position consistency across rotations and repetition stability across seeds', () => {
    // same persona+seed, two rotations, SAME top answer -> PC consistent
    insertResponse({ rotation: [0, 1], seed: 0, answer: '0' })
    insertResponse({ rotation: [1, 0], seed: 0, answer: '0' })
    // same persona+rotation, two seeds, DIFFERENT top answer -> RS inconsistent
    insertResponse({ rotation: [0, 1], seed: 1, answer: '1' })
    const r = computeRunResults(db, runId)
    expect(r.questions[0]!.positionConsistency).toBe(1) // seed 0 group consistent, seed 1 single-member group consistent
    expect(r.questions[0]!.repetitionStability).toBeCloseTo(0.5) // [0,1] group has {0,1}; [1,0] group has {0}
  })

  it('returns a machine-readable measured-vs-reference difference with source and year', () => {
    const metadata = {
      _scope: 'lokális',
      _reference: {
        mit: 'nőarány',
        ertek: '96%',
        forras: 'KSH, Szám-Lap: tanári hivatás',
        ev: '2023-2025',
        // Explicit machine fields: the result code must not infer gender from names.
        referenceShare: 0.96,
        optionIndexes: [0, 2]
      }
    }
    db.prepare('UPDATE questions SET options_json = ?, metadata_json = ? WHERE id = ?').run(
      JSON.stringify(['Nagy Erika', 'Nagy Zoltán', 'Szabó Mónika', 'Szabó Balázs']),
      JSON.stringify(metadata),
      qid
    )
    insertResponse({ dist: { '0': 0.2, '1': 0.3, '2': 0.2, '3': 0.3 }, rotation: [0, 1, 2, 3] })

    const question = computeRunResults(db, runId).questions[0]!
    expect(question).toHaveProperty('metadata', metadata)
    expect(question).toHaveProperty('referenceComparison')
    const comparison = (question as unknown as { referenceComparison: Record<string, unknown> }).referenceComparison
    expect(comparison).toMatchObject({
      measuredShare: 0.4,
      referenceShare: 0.96,
      source: 'KSH, Szám-Lap: tanári hivatás',
      year: '2023-2025'
    })
    expect(comparison['differencePercentagePoints']).toBeCloseTo(-56)
  })

  it('uses null for a missing reference instead of fabricating a zero comparison', () => {
    const question = computeRunResults(db, runId).questions[0]!
    expect(question).toHaveProperty('metadata', null)
    expect(question).toHaveProperty('referenceComparison', null)
  })

  it('reports a malformed _reference schema loudly instead of treating it as absent', () => {
    db.prepare('UPDATE questions SET metadata_json = ? WHERE id = ?').run(
      JSON.stringify({
        _reference: {
          ertek: '15,7%',
          forras: 'EU IKT-statisztika',
          ev: '2023-2025',
          referenceShare: 0.157
          // optionIndexes is mandatory for a machine-computed share.
        }
      }),
      qid
    )
    const question = computeRunResults(db, runId).questions[0]! as unknown as {
      referenceComparison: unknown
      referenceIssue?: string | null
    }
    expect(question.referenceComparison).toBeNull()
    expect(question.referenceIssue).toMatch(/hibás|hiányos|optionIndexes|opcióindex/i)
  })

  describe('position shift (issue #39)', () => {
    function insertPositionChoices(
      questionId: string,
      side: 'first' | 'last',
      count = 8,
      opts: { valid?: boolean; abstained?: boolean; elicitationMode?: 'single_choice' | 'multi_choice' } = {}
    ): void {
      const rotations = [
        [0, 1, 2],
        [1, 2, 0],
        [2, 0, 1]
      ]
      for (let seed = 0; seed < count; seed++) {
        const rotation = rotations[seed % rotations.length]!
        const originalAnswer = rotation[side === 'first' ? 0 : rotation.length - 1]!
        insertResponse({
          questionId,
          rotation,
          seed,
          answer: String(originalAnswer),
          dist: { '0': 1, '1': 0, '2': 0 },
          valid: opts.valid,
          abstained: opts.abstained,
          elicitationMode: opts.elicitationMode ?? 'single_choice'
        })
      }
    }

    function positionFields(question: unknown): { positionShift: number | null; positionShiftSampleSize: number } {
      const value = question as { positionShift: number | null; positionShiftSampleSize: number }
      return { positionShift: value.positionShift, positionShiftSampleSize: value.positionShiftSampleSize }
    }

    it('computes primacy and recency independently per question from the chosen original answer and its displayed rotation', () => {
      const q2 = randomUUID()
      const questionnaireId = (
        db.prepare('SELECT questionnaire_id FROM questions WHERE id = ?').get(qid) as { questionnaire_id: string }
      ).questionnaire_id
      db.prepare(
        'UPDATE questions SET options_json = ? WHERE id = ?'
      ).run(JSON.stringify(['A', 'B', 'C']), qid)
      db.prepare(
        'INSERT INTO questions (id, questionnaire_id, ord, text, scale_type, options_json) VALUES (?,?,1,?,?,?)'
      ).run(q2, questionnaireId, 'Második kérdés?', 'single_choice', JSON.stringify(['A', 'B', 'C']))

      insertPositionChoices(qid, 'first')
      insertPositionChoices(q2, 'last')

      const [primacy, recency] = computeRunResults(db, runId).questions.map(positionFields)
      expect(primacy).toEqual({ positionShift: -0.5, positionShiftSampleSize: 8 })
      expect(recency).toEqual({ positionShift: 0.5, positionShiftSampleSize: 8 })
    })

    it('deduplicates cells, excludes invalid and abstaining rows, and keeps a loud sample count below the threshold', () => {
      db.prepare('UPDATE questions SET options_json = ? WHERE id = ?').run(JSON.stringify(['A', 'B', 'C']), qid)
      insertPositionChoices(qid, 'first', 7)
      // Same experimental cell as seed 0: append-only duplicate, not an eighth observation.
      // Production prevents new duplicates, but old/imported logs may contain
      // them; mirror the repository's existing duplicate-response fixture.
      db.exec('DROP INDEX IF EXISTS idx_responses_cell')
      insertResponse({
        rotation: [0, 1, 2], seed: 0, answer: '2', dist: { '0': 0, '1': 0, '2': 1 }, elicitationMode: 'single_choice'
      })
      insertResponse({
        rotation: [0, 2, 1], seed: 20, answer: '0', dist: null, valid: false, elicitationMode: 'single_choice'
      })
      insertResponse({
        rotation: [2, 1, 0], seed: 21, answer: '2', dist: null, abstained: true, elicitationMode: 'single_choice'
      })

      expect(positionFields(computeRunResults(db, runId).questions[0])).toEqual({
        positionShift: null,
        positionShiftSampleSize: 7
      })
    })

    it('does not assign the ambiguous single-choice position-shift metric to a multi-choice question', () => {
      db.prepare('UPDATE questions SET scale_type = ?, options_json = ? WHERE id = ?').run(
        'multi_choice', JSON.stringify(['A', 'B', 'C']), qid
      )
      insertPositionChoices(qid, 'first', 8, { elicitationMode: 'multi_choice' })

      expect(positionFields(computeRunResults(db, runId).questions[0])).toEqual({
        positionShift: null,
        positionShiftSampleSize: 0
      })
    })
  })
})

describe('buildEvaluationPrompt', () => {
  function weakTierCalibrationPrompt(displayedPosition: 0 | 1 | 2): string {
    db.prepare('UPDATE questions SET options_json = ?, metadata_json = ? WHERE id = ?').run(
      JSON.stringify(['A', 'B', 'C']),
      JSON.stringify({ _tier: 'gyenge', _torzitas: 'Pollyanna' }),
      qid
    )
    const rotations = [[0, 1, 2], [1, 2, 0], [2, 0, 1]]
    for (let seed = 0; seed < 8; seed++) {
      const rotation = rotations[seed % rotations.length]!
      insertResponse({
        rotation,
        seed,
        answer: String(rotation[displayedPosition]),
        dist: { '0': 1, '1': 0, '2': 0 },
        elicitationMode: 'single_choice',
        persona: null,
        condition: 'baseline'
      })
    }
    return buildEvaluationPrompt('Kalibráció', computeRunResults(db, runId), { calibration: true })
  }

  function positionShiftLine(prompt: string): string {
    return prompt.split('\n').find((line) => line.includes('Pozíció-eltolódás:')) ?? ''
  }

  it('embeds computed metrics and anti-bias instructions', () => {
    insertResponse({ dist: { '0': 0.9, '1': 0.1 } })
    const prompt = buildEvaluationPrompt('R', computeRunResults(db, runId))
    expect(prompt).toContain('Trust?')
    expect(prompt).toContain('Yes: 90.0%')
    expect(prompt).toContain('Pollyanna')
    expect(prompt).toContain('TSTR')
    expect(prompt).toContain('spurious split')
  })

  it('frames a weak-tier Pollyanna item position shift as a diagnostic trap signal, never an automatic product rating (issue #39)', () => {
    const prompt = weakTierCalibrationPrompt(2)
    expect(prompt).toMatch(/pozíció-eltolódás[^\n]*(recency|\+0[,.]50)/i)
    expect(prompt).toMatch(/recency[^\n]*(összhangban|megfelel)[^\n]*csapda/i)
    expect(prompt).toMatch(/primacy[^\n]*(nem támasztja alá|nem validálja)[^\n]*csapda/i)
    expect(prompt).toMatch(/diagnosztikai jel/i)
    expect(prompt).toMatch(/nem automatikus[^\n]*termék|minősítésre[^\n]*nem/i)
  })

  it('says on the measured question line that actual primacy does not support the weak Pollyanna trap (issue #39 review)', () => {
    const line = positionShiftLine(weakTierCalibrationPrompt(0))
    expect(line).toMatch(/pozíció-eltolódás[^\n]*primacy[^\n]*-0[,.]50[^\n]*n=8/i)
    expect(line).toMatch(/primacy[^\n]*nem támasztja alá[^\n]*csapd/i)
  })

  it('keeps a measured neutral shift undecided instead of validating or rejecting the weak Pollyanna trap', () => {
    const line = positionShiftLine(weakTierCalibrationPrompt(1))
    expect(line).toMatch(/pozíció-eltolódás[^\n]*nincs irányeltolódás[^\n]*0[,.]00[^\n]*n=8/i)
    expect(line).toMatch(/iránysemleges[^\n]*nem dönti el[^\n]*csapda/i)
  })
})

/**
 * Issue #17 M3 (docs/MODEL-CALIBRATION.md §4): the judge prompt gains a
 * model-calibration section computed in code — the active profile's
 * positivity offset and prior-bias summary. This is a NEW section, distinct
 * from the per-question control-arm/divergence lines M1 already added (still
 * covered above via `q.baseline`) — it comes from the model_profiles
 * registry, not from any one run's own responses.
 *
 * `context` is passed via a typed local variable, not an inline object
 * literal, only because that also sidesteps TypeScript's excess-property
 * check if this file is ever compiled against an older buildEvaluationPrompt
 * signature — the current one already declares `profile`.
 *
 * Review finding (M3 review, false-green #1): assertions here must be
 * anchored to the MODELL-KALIBRÁCIÓ block specifically
 * (`calibrationSectionOf` below), not to the whole prompt — M1's pre-existing
 * KONTROLL-KAR line (src/lib/evaluate.ts) already contains generic phrases
 * like "ahhoz képest" and "nem térítette el", so an unanchored regex can stay
 * green even with buildCalibrationSection deleted outright. Verified by
 * temporarily stashing src/lib/evaluate.ts's calibration section: the
 * anchored versions of these two assertions go red, the unanchored ones did
 * not.
 */
function calibrationSectionOf(prompt: string): string {
  const start = prompt.indexOf('MODELL-KALIBRÁCIÓ')
  if (start === -1) return ''
  const end = prompt.indexOf('\n\nADATOK:', start)
  return prompt.slice(start, end === -1 ? undefined : end)
}
describe('buildEvaluationPrompt — model-calibration section (issue #17 M3)', () => {
  const PROFILE: StoredProfile = {
    id: 'prof-1',
    modelRequested: 'm',
    modelVersion: 'm-2026-05',
    provider: 'DeepInfra',
    promptTemplateHash: 'abc123def456',
    probeQuestionnaireId: 'probe-qn',
    language: 'hu',
    runIds: ['cal-1'],
    createdAt: '2026-08-01 10:00:00',
    validUntil: '2026-10-30 10:00:00',
    metrics: {
      perQuestion: [],
      priorBias: { byPosition: [0.1, 0.15, 0.75], maxDeviation: 0.42, strongestPosition: 2, optionCount: 3 },
      positivityOffset: 0.267,
      invalidRate: 0,
      abstainRate: 0,
      provenance: { runIds: ['cal-1'], cellCount: 10, duplicateCellCount: 0, costUsd: 0.01, firstResponseAt: null, lastResponseAt: null }
    }
  }

  function contextWithProfile(status: ProfileStatus = 'valid'): {
    providers?: { provider: string; count: number }[]
    profile?: { profile: StoredProfile; status: ProfileStatus } | null
  } {
    return { profile: { profile: PROFILE, status } }
  }

  it("includes the active profile's measured positivity offset and prior-bias summary", () => {
    insertResponse({ dist: { '0': 0.9, '1': 0.1 } })
    const prompt = buildEvaluationPrompt('R', computeRunResults(db, runId), contextWithProfile('valid'))
    expect(prompt).toContain('0.267')
    expect(prompt).toContain('0.42')
  })

  it('says explicitly when there is no calibration profile for the run’s model, rather than omitting the section', () => {
    insertResponse({ dist: { '0': 0.9, '1': 0.1 } })
    const noProfile: {
      providers?: { provider: string; count: number }[]
      profile?: { profile: StoredProfile; status: ProfileStatus } | null
    } = { profile: null }
    const prompt = buildEvaluationPrompt('R', computeRunResults(db, runId), noProfile)
    expect(prompt).toMatch(/nincs.*kalibráci/i)
  })
})

/** Issue #17 M3, §4's mandatory instructions for the calibration section. */
describe('buildEvaluationPrompt — mandatory calibration instructions (§4, issue #17 M3)', () => {
  const PROFILE: StoredProfile = {
    id: 'prof-1',
    modelRequested: 'm',
    modelVersion: 'm-2026-05',
    provider: 'DeepInfra',
    promptTemplateHash: 'abc123def456',
    probeQuestionnaireId: 'probe-qn',
    language: 'hu',
    runIds: ['cal-1'],
    createdAt: '2026-08-01 10:00:00',
    validUntil: '2026-10-30 10:00:00',
    metrics: {
      perQuestion: [],
      priorBias: { byPosition: [0.1, 0.15, 0.75], maxDeviation: 0.42, strongestPosition: 2, optionCount: 3 },
      positivityOffset: 0.267,
      invalidRate: 0,
      abstainRate: 0,
      provenance: { runIds: ['cal-1'], cellCount: 10, duplicateCellCount: 0, costUsd: 0.01, firstResponseAt: null, lastResponseAt: null }
    }
  }

  function promptWithProfile(): string {
    insertResponse({ dist: { '0': 0.9, '1': 0.1 } })
    const context: {
      providers?: { provider: string; count: number }[]
      profile?: { profile: StoredProfile; status: ProfileStatus } | null
    } = {
      profile: { profile: PROFILE, status: 'valid' }
    }
    return buildEvaluationPrompt('R', computeRunResults(db, runId), context)
  }

  // Review false-green #1: anchored to the MODELL-KALIBRÁCIÓ block itself, not
  // the whole prompt — M1's pre-existing KONTROLL-KAR line already contains
  // "ahhoz képest", so an unanchored match stays green even with
  // buildCalibrationSection deleted outright.
  it('says, inside the calibration section, to interpret persona results relative to the baseline', () => {
    const section = calibrationSectionOf(promptWithProfile())
    expect(section).not.toBe('')
    expect(section).toMatch(/kontrollhoz? képest|ahhoz képest|baseline.*képest/i)
  })

  it('says, inside the calibration section, that a persona within the noise floor added nothing', () => {
    const section = calibrationSectionOf(promptWithProfile())
    expect(section).not.toBe('')
    expect(section).toMatch(/nem tett hozzá|nem térítette el/i)
  })

  it('says to read positive results against the measured positivity offset', () => {
    const section = calibrationSectionOf(promptWithProfile())
    expect(section).toMatch(/pozitivitás-eltolás|mért pozitivitás|Pollyanna-eltolás/i)
  })

  it('states the stereotyping caveat: persona differences are upper bounds, not findings, until human data exists', () => {
    const section = calibrationSectionOf(promptWithProfile())
    expect(section).toMatch(/felső korlát/i)
    expect(section).toMatch(/nem (megállapítás|eredmény)/i)
  })

  // Review HIGH #4: the model card's own caveat for positivityOffset
  // (public/model-card.js) is that it is NOT the trap-item-specific Pollyanna
  // measure the design calls for — it is the mean over EVERY directed scale,
  // "a broader and weaker statement" ("tágabb és gyengébb állítás"), because
  // the probe does not mark product-evaluation trap items yet. The judge
  // prompt must carry the SAME caveat, not narrow the number onto
  // product-concept results as if it had been measured specifically there.
  it('carries the same "broader, weaker" caveat as the model card, instead of overclaiming the offset was measured on product-concept items', () => {
    const section = calibrationSectionOf(promptWithProfile())
    expect(section).toMatch(/tágabb/i)
    expect(section).toMatch(/gyengébb/i)
  })

  // Review MEDIUM #7: the no-profile branch used to say "a mért
  // alap-pozitivitáshoz ... nincs mihez viszonyítani" — which PRESUPPOSES a
  // measured positivity exists (the very thing "nincs kalibrációs profil"
  // just denied). Encoded as a negative match on the inverted phrase plus a
  // positive match on the corrected meaning, without pinning exact prose.
  it('does not presuppose a measured positivity/bias exists when there is no calibration profile', () => {
    const noProfile: {
      providers?: { provider: string; count: number }[]
      profile?: { profile: StoredProfile; status: ProfileStatus } | null
    } = { profile: null }
    insertResponse({ dist: { '0': 0.9, '1': 0.1 } })
    const section = calibrationSectionOf(buildEvaluationPrompt('R', computeRunResults(db, runId), noProfile))
    expect(section).not.toBe('')
    // The inverted phrasing: "a mért ... -hoz nincs mihez viszonyítani" claims
    // a measured quantity exists and only the comparison is missing.
    expect(section).not.toMatch(/a mért alap-pozitivitáshoz[^.]*nincs mihez viszonyítani/i)
    // The corrected meaning: there IS NO measurement at all, not "a
    // measurement exists but nothing to compare it to".
    expect(section).toMatch(/nincs mért|nem mérve|nem mérhető|nincs mérés/i)
  })
})

/**
 * Constraint from issue #17 M3: this milestone adds CONTEXT for the judge —
 * it must never correct or otherwise touch the recorded data. computeRunResults
 * does not even take a profile argument; this guards that a future change
 * cannot make its output depend on whether a model_profiles row exists.
 */
describe('computeRunResults is unaffected by model-calibration context (issue #17 M3)', () => {
  it('produces identical results whether or not a model profile exists for the run’s model', () => {
    insertResponse({ dist: { '0': 0.9, '1': 0.1 } })
    const before = computeRunResults(db, runId)

    db.prepare('INSERT INTO questionnaires (id, lineage_id, name) VALUES (?,?,?)').run('probe-qn', 'probe-qn', 'Próba')
    db.prepare(
      `INSERT INTO model_profiles
         (id, model_requested, model_version, prompt_template_hash, probe_questionnaire_id, run_ids_json, metrics_json, valid_until)
       VALUES (?,?,?,?,?,?,?,?)`
    ).run('prof-1', 'm', 'm-2026-05', 'hash', 'probe-qn', '[]', '{}', '2099-01-01 00:00:00')

    const after = computeRunResults(db, runId)
    expect(after).toEqual(before)
  })
})

describe('computeRunResults — multi_choice questions', () => {
  let mqid: string

  function insertMultiResponse(opts: { dist: Record<string, number>; mode?: string | null; answer?: string; seed?: number }): void {
    db.prepare(
      `INSERT INTO responses (id, run_id, persona_id, question_id, model_requested, temperature, seed,
         permutation_json, prompt_rendered, raw_response, parsed_distribution_json, parsed_answer,
         is_valid, abstained, elicitation_mode)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,0,?)`
    ).run(
      randomUUID(), runId, p1, mqid, 'm', 1.0, opts.seed ?? 0, JSON.stringify([0, 1]), 'p', 'r',
      JSON.stringify(opts.dist), opts.answer ?? '0', opts.mode === undefined ? 'multi_choice' : opts.mode
    )
  }

  beforeEach(() => {
    mqid = randomUUID()
    const questionnaireId = (db.prepare('SELECT questionnaire_id q FROM runs WHERE id = ?').get(runId) as { q: string }).q
    db.prepare(
      'INSERT INTO questions (id, questionnaire_id, ord, text, scale_type, options_json) VALUES (?,?,1,?,?,?)'
    ).run(mqid, questionnaireId, 'Melyekből tájékozódsz?', 'multi_choice', JSON.stringify(['Hírlevél', 'Bolt']))
  })

  it('reports the question as multi_choice and keeps per-option support un-normalized', () => {
    insertMultiResponse({ dist: { '0': 0.9, '1': 0.8 } })
    insertMultiResponse({ dist: { '0': 0.7, '1': 0.6 }, seed: 1 })
    const q = computeRunResults(db, runId).questions.find((x) => x.questionId === mqid)!
    expect(q.elicitationMode).toBe('multi_choice')
    expect(q.aggregated[0]).toBeCloseTo(0.8)
    expect(q.aggregated[1]).toBeCloseTo(0.7)
    // support values are independent: they may sum above 1
    expect(q.aggregated[0]! + q.aggregated[1]!).toBeGreaterThan(1)
  })

  it('excludes legacy (wrongly normalized) responses from a multi_choice aggregate and says how many', () => {
    insertMultiResponse({ dist: { '0': 0.9, '1': 0.8 } })
    insertMultiResponse({ dist: { '0': 0.53, '1': 0.47 }, mode: null, seed: 1 })
    const q = computeRunResults(db, runId).questions.find((x) => x.questionId === mqid)!
    expect(q.legacyElicitationCount).toBe(1)
    expect(q.aggregated[0]).toBeCloseTo(0.9)
  })

  it('keeps legacy rows for single-choice questions, where the semantics did not change', () => {
    insertResponse({ dist: { '0': 1, '1': 0 } })
    const q = computeRunResults(db, runId).questions.find((x) => x.questionId === qid)!
    expect(q.elicitationMode).toBe('single_choice')
    expect(q.legacyElicitationCount).toBe(0)
    expect(q.aggregated[0]).toBeCloseTo(1)
  })
})

describe('computeRunResults — stability metrics for multi_choice', () => {
  let mqid: string

  function insertMulti(opts: { answer: string; rotation: number[]; seed?: number }): void {
    db.prepare(
      `INSERT INTO responses (id, run_id, persona_id, question_id, model_requested, temperature, seed,
         permutation_json, prompt_rendered, raw_response, parsed_distribution_json, parsed_answer,
         is_valid, abstained, elicitation_mode)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,0,'multi_choice')`
    ).run(
      randomUUID(), runId, p1, mqid, 'm', 1.0, opts.seed ?? 0, JSON.stringify(opts.rotation), 'p', 'r',
      JSON.stringify({ '0': 0.9, '1': 0.8, '2': 0.1 }), opts.answer
    )
  }

  beforeEach(() => {
    mqid = randomUUID()
    const questionnaireId = (db.prepare('SELECT questionnaire_id q FROM runs WHERE id = ?').get(runId) as { q: string }).q
    db.prepare(
      'INSERT INTO questions (id, questionnaire_id, ord, text, scale_type, options_json) VALUES (?,?,2,?,?,?)'
    ).run(mqid, questionnaireId, 'Melyeket?', 'multi_choice', JSON.stringify(['a', 'b', 'c']))
  })

  it('scores identical selections as fully consistent', () => {
    insertMulti({ answer: '0,1', rotation: [0, 1, 2] })
    insertMulti({ answer: '0,1', rotation: [1, 2, 0] })
    const q = computeRunResults(db, runId).questions.find((x) => x.questionId === mqid)!
    expect(q.positionConsistency).toBeCloseTo(1)
  })

  it('degrades gradually instead of collapsing when one option differs', () => {
    insertMulti({ answer: '0,1', rotation: [0, 1, 2] })
    insertMulti({ answer: '0,1,2', rotation: [1, 2, 0] })
    const q = computeRunResults(db, runId).questions.find((x) => x.questionId === mqid)!
    // set overlap 2/3, not a knife-edge 0
    expect(q.positionConsistency).toBeCloseTo(2 / 3)
  })

  it('scores fully disjoint selections as zero', () => {
    insertMulti({ answer: '0', rotation: [0, 1, 2] })
    insertMulti({ answer: '1', rotation: [1, 2, 0] })
    const q = computeRunResults(db, runId).questions.find((x) => x.questionId === mqid)!
    expect(q.positionConsistency).toBeCloseTo(0)
  })

  it('treats two "selects none" answers as agreeing', () => {
    insertMulti({ answer: '', rotation: [0, 1, 2] })
    insertMulti({ answer: '', rotation: [1, 2, 0] })
    const q = computeRunResults(db, runId).questions.find((x) => x.questionId === mqid)!
    expect(q.positionConsistency).toBeCloseTo(1)
  })
})

describe('buildEvaluationPrompt — no fabricated numbers', () => {
  it('says there is nothing to evaluate instead of printing zeros', () => {
    const prompt = buildEvaluationPrompt('R', {
      totalResponses: 3,
      duplicateResponseCount: 0,
      invalidRate: 0,
      abstainRate: 0,
      questions: [
        {
          questionId: 'q',
          text: 'Melyeket?',
          options: ['a', 'b'],
          scaleType: 'multi_choice',
          elicitationMode: 'multi_choice',
          legacyElicitationCount: 3,
          aggregatedResponseCount: 0,
          totalResponses: 3,
          invalidCount: 0,
          abstainCount: 0,
          aggregated: [0, 0],
          byPersona: {
            p: { name: 'P', distribution: [0, 0], abstainCount: 0, baselineDivergence: null, movesModel: null }
          },
          baseline: null,
          positionShift: null,
          positionShiftSampleSize: 0,
          positionConsistency: null,
          repetitionStability: null
        }
      ]
    })
    expect(prompt).toContain('Nincs értékelhető válasz')
    expect(prompt).not.toContain('Aggregált eloszlás')
    expect(prompt).not.toContain('Opciónkénti támogatottság')
    expect(prompt).toContain('3')
  })
})

describe('computeRunResults — duplicated cells', () => {
  // A database recorded before issue #16 was fixed: the unique index cannot exist
  // there, and the duplicates are kept as the genuine repeated measurements they are.
  beforeEach(() => {
    db.exec('DROP INDEX IF EXISTS idx_responses_cell')
  })

  it('counts a duplicated cell once and reports how many duplicates it found', () => {
    // the same cell recorded twice (parallel runner loops, issue #16)
    insertResponse({ dist: { '0': 1, '1': 0 }, rotation: [0, 1], seed: 0 })
    insertResponse({ dist: { '0': 0, '1': 1 }, rotation: [0, 1], seed: 0 })
    insertResponse({ dist: { '0': 1, '1': 0 }, rotation: [1, 0], seed: 0 })

    const r = computeRunResults(db, runId)
    const q = r.questions[0]!
    // two unique cells, not three: the first recording of a cell wins
    expect(q.aggregatedResponseCount).toBe(2)
    expect(q.aggregated[0]).toBeCloseTo(1)
    expect(r.duplicateResponseCount).toBe(1)
  })

  it('does not treat a re-elicited cell as a duplicate of its legacy row', () => {
    // The shape of ALL 336 "duplicate" pairs in the live database: a multi-select
    // question answered before the elicitation fix (mode NULL) and re-elicited
    // afterwards. A naive 5-tuple key would call this a duplicate, keep the
    // wrongly-normalized legacy row and discard the corrected one.
    const multiQid = randomUUID()
    const questionnaireId = (db.prepare('SELECT questionnaire_id q FROM runs WHERE id = ?').get(runId) as { q: string }).q
    db.prepare(
      'INSERT INTO questions (id, questionnaire_id, ord, text, scale_type, options_json) VALUES (?,?,5,?,?,?)'
    ).run(multiQid, questionnaireId, 'Melyekből?', 'multi_choice', JSON.stringify(['a', 'b']))
    const insertPair = (mode: string | null, dist: Record<string, number>): void => {
      db.prepare(
        `INSERT INTO responses (id, run_id, persona_id, question_id, model_requested, temperature, seed,
           permutation_json, prompt_rendered, raw_response, parsed_distribution_json, parsed_answer,
           is_valid, abstained, elicitation_mode)
         VALUES (?,?,?,?,'m',1,0,?,'p','r',?,'0',1,0,?)`
      ).run(randomUUID(), runId, p1, multiQid, JSON.stringify([0, 1]), JSON.stringify(dist), mode)
    }
    insertPair(null, { '0': 0.7, '1': 0.3 })
    insertPair('multi_choice', { '0': 0.9, '1': 0.8 })

    const r = computeRunResults(db, runId)
    const q = r.questions.find((x) => x.questionId === multiQid)!
    expect(r.duplicateResponseCount).toBe(0)
    expect(q.aggregatedResponseCount).toBe(1)
    expect(q.aggregated[0]).toBeCloseTo(0.9) // the corrected row, not the legacy one
    expect(q.legacyElicitationCount).toBe(1)
  })

  it('reports zero duplicates for clean data', () => {
    insertResponse({ dist: { '0': 1, '1': 0 }, rotation: [0, 1], seed: 0 })
    insertResponse({ dist: { '0': 1, '1': 0 }, rotation: [0, 1], seed: 1 })
    expect(computeRunResults(db, runId).duplicateResponseCount).toBe(0)
  })

  it('does not let a duplicate inflate the stability metrics', () => {
    // same cell twice with DIFFERENT answers: counting both would fake instability
    insertResponse({ dist: { '0': 1, '1': 0 }, answer: '0', rotation: [0, 1], seed: 0 })
    insertResponse({ dist: { '0': 0, '1': 1 }, answer: '1', rotation: [0, 1], seed: 0 })
    const q = computeRunResults(db, runId).questions[0]!
    expect(q.positionConsistency).toBe(1)
  })
})

describe('computeRunResults — baseline control arm', () => {
  function insertArm(opts: { condition: string; persona?: string | null; dist: Record<string, number>; seed?: number; rotation?: number[] }): void {
    db.prepare(
      `INSERT INTO responses (id, run_id, persona_id, question_id, model_requested, temperature, seed,
         permutation_json, prompt_rendered, raw_response, parsed_distribution_json, parsed_answer,
         is_valid, abstained, condition)
       VALUES (?,?,?,?,'m',1,?,?,'p','r',?,'0',1,0,?)`
    ).run(
      randomUUID(), runId, opts.persona === undefined ? p1 : opts.persona, qid, opts.seed ?? 0,
      JSON.stringify(opts.rotation ?? [0, 1]), JSON.stringify(opts.dist), opts.condition
    )
  }

  it('keeps the control arm out of the persona aggregate and reports it separately', () => {
    insertArm({ condition: 'persona', dist: { '0': 1, '1': 0 } })
    insertArm({ condition: 'baseline', persona: null, dist: { '0': 0, '1': 1 } })
    const q = computeRunResults(db, runId).questions[0]!
    expect(q.aggregated[0]).toBeCloseTo(1) // persona only
    expect(q.baseline).toBeTruthy()
    expect(q.baseline![1]).toBeCloseTo(1)
    expect(q.aggregatedResponseCount).toBe(1)
  })

  it('measures the persona effect as divergence from the control arm', () => {
    insertArm({ condition: 'persona', dist: { '0': 1, '1': 0 } })
    insertArm({ condition: 'baseline', persona: null, dist: { '0': 0, '1': 1 } })
    const q = computeRunResults(db, runId).questions[0]!
    // opposite distributions: maximal divergence
    expect(q.byPersona[p1]!.baselineDivergence).toBeCloseTo(1, 1)
  })

  it('flags a persona that does not move the model away from its default', () => {
    insertArm({ condition: 'persona', dist: { '0': 0.6, '1': 0.4 } })
    // TWO control-arm seed-groups (not one): this test's intent is the
    // DECIDED `false` case ("the persona sits within the model's own noise
    // — we know that, because we measured the noise"), not the separate
    // "we don't know" case a single control-arm seed-group now produces
    // (issue #40 review CRITICAL — see the
    // 'computeRunResults — movesModel is undecidable …' describe block
    // below). A single baseline row here would make the noise floor
    // unmeasurable and `movesModel` would correctly come back `null`
    // instead of `false`, which is not what this test is about. Both
    // seed-groups share the same distribution as the persona, so the noise
    // floor is a genuinely MEASURED zero, and the persona's own divergence
    // (also zero) does not exceed it — same outcome as before, now reached
    // for the right reason instead of by the bug's accidental default-0 path.
    insertArm({ condition: 'baseline', persona: null, dist: { '0': 0.6, '1': 0.4 }, seed: 0 })
    insertArm({ condition: 'baseline', persona: null, dist: { '0': 0.6, '1': 0.4 }, seed: 1 })
    const q = computeRunResults(db, runId).questions[0]!
    expect(q.byPersona[p1]!.baselineDivergence).toBeCloseTo(0)
    expect(q.byPersona[p1]!.movesModel).toBe(false)
  })

  it('reports no baseline when the run had no control arm', () => {
    insertArm({ condition: 'persona', dist: { '0': 1, '1': 0 } })
    const q = computeRunResults(db, runId).questions[0]!
    expect(q.baseline).toBeNull()
    expect(q.byPersona[p1]!.baselineDivergence).toBeNull()
  })

  /**
   * Issue #32 (CRITICAL): a calibration run has NO persona rows at all — every
   * response is `persona_id IS NULL`, `condition = 'baseline'`. The per-question
   * aggregation used to filter those rows out entirely before computing
   * totalResponses/invalidCount/abstainCount/byPersona, so a run that is 100%
   * control-arm reported 0/0/0 for every question while the top-level
   * `results.totalResponses` (computed before that filter) still showed the
   * real count — the exact header/detail contradiction the reporter saw.
   */
  it('a baseline-only run (all rows persona_id NULL) produces non-empty per-question aggregates', () => {
    insertArm({ condition: 'baseline', persona: null, dist: { '0': 0.9, '1': 0.1 }, seed: 0 })
    insertArm({ condition: 'baseline', persona: null, dist: { '0': 0.7, '1': 0.3 }, seed: 1 })
    db.prepare(
      `INSERT INTO responses (id, run_id, persona_id, question_id, model_requested, temperature, seed,
         permutation_json, prompt_rendered, raw_response, parsed_distribution_json, parsed_answer,
         is_valid, abstained, condition)
       VALUES (?,?,NULL,?,'m',1,2,?,'p','r',NULL,NULL,0,0,'baseline')`
    ).run(randomUUID(), runId, qid, JSON.stringify([0, 1]))
    db.prepare(
      `INSERT INTO responses (id, run_id, persona_id, question_id, model_requested, temperature, seed,
         permutation_json, prompt_rendered, raw_response, parsed_distribution_json, parsed_answer,
         is_valid, abstained, condition)
       VALUES (?,?,NULL,?,'m',1,3,?,'p','r',NULL,NULL,1,1,'baseline')`
    ).run(randomUUID(), runId, qid, JSON.stringify([0, 1]))

    const r = computeRunResults(db, runId)
    expect(r.totalResponses).toBe(4)
    const q = r.questions[0]!
    expect(q.totalResponses).toBe(4)
    expect(q.invalidCount).toBe(1)
    expect(q.abstainCount).toBe(1)
    expect(q.baseline).toBeTruthy()
    expect(q.baseline![0]).toBeCloseTo(0.8)
  })

  /**
   * Issue #32, point 2: the evaluation prompt itself must present the control
   * arm as its own named group when a question has no persona rows at all —
   * never as "no evaluable data" (the reporter's exact symptom) and never
   * silently dropped.
   */
  it('presents the control arm as a named group in the evaluation prompt instead of "no evaluable data"', () => {
    insertArm({ condition: 'baseline', persona: null, dist: { '0': 0.9, '1': 0.1 }, seed: 0 })
    insertArm({ condition: 'baseline', persona: null, dist: { '0': 0.7, '1': 0.3 }, seed: 1 })
    const prompt = buildEvaluationPrompt('R', computeRunResults(db, runId))
    expect(prompt).not.toContain('Nincs értékelhető válasz')
    expect(prompt).toContain('Kontroll — perszóna nélkül')
    expect(prompt).toContain('Yes: 80.0%')
  })
})

/**
 * Issue #40: positionConsistency/repetitionStability are computed only from
 * `valid` (persona-condition rows, grouped by `persona_id`), so the control
 * arm's rows never enter them — in a calibration run (100% baseline, no
 * persona at all) both come out `undefined` for every question, even though
 * PC/RS are the primary product of a calibration run. The fix must feed the
 * control arm's own valid rows into the same metric, grouped as its OWN
 * condition (e.g. keyed by `persona_id ?? 'baseline'`), not merged into any
 * one persona's group and not dropped.
 */
describe('computeRunResults — PC/RS include the control arm (issue #40)', () => {
  function insertBaseline(opts: { seed: number; rotation: number[]; answer: string; dist?: Record<string, number> }): void {
    db.prepare(
      `INSERT INTO responses (id, run_id, persona_id, question_id, model_requested, temperature, seed,
         permutation_json, prompt_rendered, raw_response, parsed_distribution_json, parsed_answer,
         is_valid, abstained, condition)
       VALUES (?,?,NULL,?,'m',1,?,?,'p','r',?,?,1,0,'baseline')`
    ).run(
      randomUUID(), runId, qid, opts.seed, JSON.stringify(opts.rotation),
      JSON.stringify(opts.dist ?? { '0': 0.8, '1': 0.2 }), opts.answer
    )
  }

  it('computes non-null PC/RS for a baseline-only (calibration) run, matching the same grouping logic used for personas', () => {
    // Exact mirror of the existing persona-only PC/RS fixture above
    // ("computes position consistency across rotations and repetition
    // stability across seeds"), just with condition='baseline' rows instead
    // of a persona row — proves the SAME grouping logic now also covers the
    // control arm, rather than a special-cased approximation.
    insertBaseline({ seed: 0, rotation: [0, 1], answer: '0' })
    insertBaseline({ seed: 0, rotation: [1, 0], answer: '0' })
    insertBaseline({ seed: 1, rotation: [0, 1], answer: '1' })
    const q = computeRunResults(db, runId).questions[0]!
    // PC groups by (condition, seed): seed=0 -> answers ['0','0'] agree -> 1;
    // seed=1 -> single-member group ['1'] -> 1. Mean of the two groups = 1.
    expect(q.positionConsistency).toBe(1)
    // RS groups by (condition, rotation): rotation=[0,1] -> answers ['0'
    // (seed0), '1' (seed1)] disagree -> 0; rotation=[1,0] -> single-member
    // group ['0'] -> 1. Mean of the two groups = 0.5.
    expect(q.repetitionStability).toBeCloseTo(0.5)
  })

  it('scores a perfectly self-consistent baseline as fully consistent (1) on both metrics', () => {
    insertBaseline({ seed: 0, rotation: [0, 1], answer: '0' })
    insertBaseline({ seed: 0, rotation: [1, 0], answer: '0' })
    insertBaseline({ seed: 1, rotation: [0, 1], answer: '0' })
    insertBaseline({ seed: 1, rotation: [1, 0], answer: '0' })
    const q = computeRunResults(db, runId).questions[0]!
    // Every seed-group and every rotation-group agrees on '0' throughout.
    expect(q.positionConsistency).toBe(1)
    expect(q.repetitionStability).toBe(1)
  })

  it('scores a maximally disagreeing baseline as fully inconsistent (0) on both metrics', () => {
    insertBaseline({ seed: 0, rotation: [0, 1], answer: '0' })
    insertBaseline({ seed: 0, rotation: [1, 0], answer: '1' })
    insertBaseline({ seed: 1, rotation: [0, 1], answer: '1' })
    insertBaseline({ seed: 1, rotation: [1, 0], answer: '0' })
    const q = computeRunResults(db, runId).questions[0]!
    // seed=0 group: ['0','1'] disagree -> 0; seed=1 group: ['1','0']
    // disagree -> 0. Mean = 0.
    expect(q.positionConsistency).toBe(0)
    // rotation=[0,1] group: ['0' (seed0), '1' (seed1)] disagree -> 0;
    // rotation=[1,0] group: ['1' (seed0), '0' (seed1)] disagree -> 0. Mean = 0.
    expect(q.repetitionStability).toBe(0)
  })

  it('gives the control arm its own group in a mixed run, distinct from both "dropped" and "merged into a persona"', () => {
    // Persona P1: SAME seed, two rotations, DISAGREEING answers -> its own
    // group is internally inconsistent (score 0).
    insertResponse({ dist: { '0': 0.6, '1': 0.4 }, answer: '0', rotation: [0, 1], seed: 0 })
    insertResponse({ dist: { '0': 0.6, '1': 0.4 }, answer: '1', rotation: [1, 0], seed: 0 })
    // Control arm: SAME seed and SAME rotations, but internally AGREEING
    // answers -> its own group is fully consistent (score 1).
    insertBaseline({ seed: 0, rotation: [0, 1], answer: '0' })
    insertBaseline({ seed: 0, rotation: [1, 0], answer: '0' })

    const q = computeRunResults(db, runId).questions[0]!
    // Correct grouping keeps two SEPARATE (condition, seed) groups: persona
    // ['0','1'] -> 0, control ['0','0'] -> 1. Mean of the two groups = 0.5.
    //
    // Two distinct bugs would both miss this number:
    //  - dropping the control arm entirely (today's bug: `valid` only holds
    //    persona rows) leaves just the persona group -> 0, not 0.5.
    //  - a naive fix that keys grouping by seed alone, ignoring condition,
    //    would pool all four rows into one group ['0','1','0','0'], which
    //    disagrees -> 0, not 0.5.
    // 0.5 is reachable only by grouping the control arm on its own.
    expect(q.positionConsistency).toBeCloseTo(0.5)
  })

  it('leaves PC/RS for a persona-only run (no control arm at all) unchanged — no regression', () => {
    insertResponse({ rotation: [0, 1], seed: 0, answer: '0' })
    insertResponse({ rotation: [1, 0], seed: 0, answer: '0' })
    insertResponse({ rotation: [0, 1], seed: 1, answer: '1' })
    const q = computeRunResults(db, runId).questions[0]!
    expect(q.positionConsistency).toBe(1)
    expect(q.repetitionStability).toBeCloseTo(0.5)
  })

  it('computes control-arm PC for a multi_choice question via Jaccard overlap, not exact-match', () => {
    const mqid = randomUUID()
    const questionnaireId = (db.prepare('SELECT questionnaire_id q FROM runs WHERE id = ?').get(runId) as { q: string })
      .q
    db.prepare(
      'INSERT INTO questions (id, questionnaire_id, ord, text, scale_type, options_json) VALUES (?,?,3,?,?,?)'
    ).run(mqid, questionnaireId, 'Melyeket? (kontroll)', 'multi_choice', JSON.stringify(['a', 'b', 'c']))

    function insertBaselineMulti(opts: { seed: number; rotation: number[]; answer: string }): void {
      db.prepare(
        `INSERT INTO responses (id, run_id, persona_id, question_id, model_requested, temperature, seed,
           permutation_json, prompt_rendered, raw_response, parsed_distribution_json, parsed_answer,
           is_valid, abstained, elicitation_mode, condition)
         VALUES (?,?,NULL,?,'m',1,?,?,'p','r',?,?,1,0,'multi_choice','baseline')`
      ).run(
        randomUUID(), runId, mqid, opts.seed, JSON.stringify(opts.rotation),
        JSON.stringify({ '0': 0.9, '1': 0.8, '2': 0.1 }), opts.answer
      )
    }
    // Same seed, two different rotations — matches the existing "degrades
    // gradually" multi_choice PC fixture above (persona version), applied
    // here to a control-arm-only run.
    insertBaselineMulti({ seed: 0, rotation: [0, 1, 2], answer: '0,1' })
    insertBaselineMulti({ seed: 0, rotation: [1, 2, 0], answer: '0,1,2' })
    const q = computeRunResults(db, runId).questions.find((x) => x.questionId === mqid)!
    // Both rows land in the same (condition, seed=0) group. Jaccard('0,1',
    // '0,1,2') = intersection 2 / union 3 = 2/3 — a set overlap, not a
    // knife-edge 0 (the whole reason multi_choice uses Jaccard, not equality).
    expect(q.positionConsistency).toBeCloseTo(2 / 3)
  })
})

/**
 * Issue #40 review, MEDIUM: `validBaseline` (src/lib/results.ts) is built with NO
 * elicitation_mode filter, unlike the persona-side `usable` — so a baseline row
 * recorded under a stale elicitation mode still lands in `q.baseline` and, since
 * the #40 fix above, in the PC/RS grouping (`pcRsRows`) too. Concrete failure
 * mode from the review: question mode is single_choice, a legacy baseline row
 * has elicitation_mode='multi_choice' and parsed_answer='0,2' — it joins a
 * (condition, seed) group where every OTHER member answered '0', flipping that
 * group's score from 1 to 0 under exact-match scoring
 * (`new Set(['0','0,2']).size === 2`). PC is a hard reliability gate in the
 * judge prompt (PC < 0.7 -> "KÖTELEZŐ megbízhatatlannak jelölnöd"), so a
 * silently mis-scored baseline group is not cosmetic.
 *
 * The fix must mirror the persona-side filter exactly, including the
 * null-legacy + single_choice allowance, and must never silently drop the
 * excluded row.
 *
 * Design decision (see task report for the full justification): a SEPARATE
 * counter, `legacyElicitationBaselineCount`, rather than folding the baseline
 * drop into the existing `legacyElicitationCount`. That field's one consumer
 * (evaluate.ts's legacyNote: "X válasz ... ki van hagyva az AGGREGÁTUMBÓL")
 * names a specific aggregate — the persona one. In a MIXED run (persona rows
 * AND baseline rows both present for the same question) the persona aggregate
 * and the control-arm mean are two different numbers; blending a baseline-side
 * drop into the persona-side counter would misattribute which aggregate lost a
 * row. `legacyElicitationCount` therefore keeps its current, already-tested
 * meaning (persona-condition rows only) and a new, equally-reported field
 * covers the control arm.
 */
describe('computeRunResults — baseline rows are filtered by elicitation_mode, mirroring persona rows (issue #40 review MEDIUM)', () => {
  function insertBaselineRow(opts: {
    seed: number
    rotation: number[]
    answer: string
    dist?: Record<string, number>
    mode?: string | null
  }): void {
    db.prepare(
      `INSERT INTO responses (id, run_id, persona_id, question_id, model_requested, temperature, seed,
         permutation_json, prompt_rendered, raw_response, parsed_distribution_json, parsed_answer,
         is_valid, abstained, elicitation_mode, condition)
       VALUES (?,?,NULL,?,'m',1,?,?,'p','r',?,?,1,0,?,'baseline')`
    ).run(
      randomUUID(), runId, qid, opts.seed, JSON.stringify(opts.rotation),
      JSON.stringify(opts.dist ?? { '0': 0.8, '1': 0.2 }), opts.answer, opts.mode === undefined ? null : opts.mode
    )
  }

  it('excludes a baseline row whose elicitation_mode does not match the question, from both the baseline mean and PC/RS — and counts the exclusion', () => {
    // qid's mode is single_choice (default scale_type 'categorical', set in the
    // top-level beforeEach). Both rows share seed=0, so — if the mismatched row
    // is not filtered out — they land in the SAME PC group (`baseline|0`),
    // reproducing the review's exact flip-from-1-to-0 case.
    insertBaselineRow({ seed: 0, rotation: [0, 1], answer: '0', dist: { '0': 0.9, '1': 0.1 } }) // mode: null -> legacy-allowed on a single_choice question
    insertBaselineRow({ seed: 0, rotation: [1, 0], answer: '0,2', dist: { '0': 0.53, '1': 0.47 }, mode: 'multi_choice' }) // mismatched mode -> must be excluded

    const q = computeRunResults(db, runId).questions[0]!
    // Only the matching row survives into the baseline mean.
    expect(q.baseline).toBeTruthy()
    expect(q.baseline![0]).toBeCloseTo(0.9)
    expect(q.baseline![1]).toBeCloseTo(0.1)
    // PC group `baseline|0` now has a single surviving member ('0') -> fully
    // consistent. Under the bug, the group is ['0', '0,2'] -> Set size 2 -> 0.
    expect(q.positionConsistency).toBe(1)
    // The dropped row is reported, not silently absorbed into the mean.
    expect((q as unknown as { legacyElicitationBaselineCount: number }).legacyElicitationBaselineCount).toBe(1)
    // The pre-existing, persona-scoped counter is untouched by a baseline-side drop.
    expect(q.legacyElicitationCount).toBe(0)
  })

  it('keeps a null-elicitation_mode baseline row on a single_choice question (mirrors the persona-side null-legacy allowance) — not counted as a drop', () => {
    insertBaselineRow({ seed: 0, rotation: [0, 1], answer: '0', dist: { '0': 1, '1': 0 } }) // mode left null
    const q = computeRunResults(db, runId).questions[0]!
    expect(q.baseline).toBeTruthy()
    expect(q.baseline![0]).toBeCloseTo(1)
    expect((q as unknown as { legacyElicitationBaselineCount: number }).legacyElicitationBaselineCount).toBe(0)
  })
})

describe('computeRunResults — baseline legacy filtering on a multi_choice question (issue #40 review MEDIUM)', () => {
  let mqid: string

  function insertBaselineMulti(opts: { dist: Record<string, number>; mode?: string | null; answer?: string; seed?: number }): void {
    db.prepare(
      `INSERT INTO responses (id, run_id, persona_id, question_id, model_requested, temperature, seed,
         permutation_json, prompt_rendered, raw_response, parsed_distribution_json, parsed_answer,
         is_valid, abstained, elicitation_mode, condition)
       VALUES (?,?,NULL,?,?,?,?,?,?,?,?,?,1,0,?,'baseline')`
    ).run(
      randomUUID(), runId, mqid, 'm', 1.0, opts.seed ?? 0, JSON.stringify([0, 1]), 'p', 'r',
      JSON.stringify(opts.dist), opts.answer ?? '0', opts.mode === undefined ? 'multi_choice' : opts.mode
    )
  }

  beforeEach(() => {
    mqid = randomUUID()
    const questionnaireId = (db.prepare('SELECT questionnaire_id q FROM runs WHERE id = ?').get(runId) as { q: string }).q
    db.prepare(
      'INSERT INTO questions (id, questionnaire_id, ord, text, scale_type, options_json) VALUES (?,?,1,?,?,?)'
    ).run(mqid, questionnaireId, 'Melyekből tájékozódsz? (kontroll)', 'multi_choice', JSON.stringify(['Hírlevél', 'Bolt']))
  })

  it('excludes a legacy (null elicitation_mode) baseline response from a multi_choice control-arm mean, and counts it', () => {
    insertBaselineMulti({ dist: { '0': 0.9, '1': 0.8 } }) // mode: multi_choice (matches the question)
    insertBaselineMulti({ dist: { '0': 0.53, '1': 0.47 }, mode: null, seed: 1 }) // legacy: wrongly normalized as single_choice
    const q = computeRunResults(db, runId).questions.find((x) => x.questionId === mqid)!
    expect(q.baseline).toBeTruthy()
    expect(q.baseline![0]).toBeCloseTo(0.9)
    expect((q as unknown as { legacyElicitationBaselineCount: number }).legacyElicitationBaselineCount).toBe(1)
  })
})

/**
 * Issue #40 review, HIGH/A: `buildQuestionLines` (src/lib/evaluate.ts)'s
 * baseline-only branch — the branch EVERY question in a calibration run takes,
 * since `aggregatedResponseCount` is 0 whenever there are no persona rows —
 * prints the baseline distribution, the legacy note, and invalid/abstain
 * counts, but NEVER positionConsistency/repetitionStability. Meanwhile
 * `buildCalibrationEvaluationPrompt` unconditionally instructs the judge: "Ahol
 * a pozíció-konzisztencia (PC) 0.7 alatt van, ott az adott kérdés eredményét
 * KÖTELEZŐ megbízhatatlannak jelölnöd" — a number the judge is never actually
 * given for this branch. Since the #40 fix, PC/RS ARE computed for a
 * baseline-only question (they used to be null too, compounding the gap) —
 * they just never reach the prompt text.
 */
describe('buildEvaluationPrompt — control-arm PC/RS reaches the judge prompt for a baseline-only question (issue #40 review HIGH/A)', () => {
  function insertBaseline(opts: { seed: number; rotation: number[]; answer: string }): void {
    db.prepare(
      `INSERT INTO responses (id, run_id, persona_id, question_id, model_requested, temperature, seed,
         permutation_json, prompt_rendered, raw_response, parsed_distribution_json, parsed_answer,
         is_valid, abstained, condition)
       VALUES (?,?,NULL,?,'m',1,?,?,'p','r',?,?,1,0,'baseline')`
    ).run(
      randomUUID(), runId, qid, opts.seed, JSON.stringify(opts.rotation),
      JSON.stringify({ '0': 0.8, '1': 0.2 }), opts.answer
    )
  }

  it('prints the control arm’s own PC and RS for a calibration (baseline-only) question, explicitly labeled as the control arm’s — not silently omitted', () => {
    // Exact mirror of the "computes non-null PC/RS for a baseline-only
    // (calibration) run" fixture in the #40 describe block above: PC = 1,
    // RS = 0.5 (documented there, row group by row group). No persona rows at
    // all for this question -> aggregatedResponseCount === 0 -> buildQuestionLines
    // takes the baseline-only branch.
    insertBaseline({ seed: 0, rotation: [0, 1], answer: '0' })
    insertBaseline({ seed: 0, rotation: [1, 0], answer: '0' })
    insertBaseline({ seed: 1, rotation: [0, 1], answer: '1' })

    const results = computeRunResults(db, runId)
    const q = results.questions[0]!
    expect(q.aggregatedResponseCount).toBe(0) // sanity: no persona rows at all for this question
    expect(q.positionConsistency).toBe(1)
    expect(q.repetitionStability).toBeCloseTo(0.5)

    const prompt = buildEvaluationPrompt('R', results, { calibration: true })

    // The exact contract this test enforces, spelled out so the implementer does
    // not have to guess: the baseline-only branch gains a line that (a) names
    // the control arm explicitly (not a generic "PC"/"RS" label, which would be
    // indistinguishable from the persona-branch's own PC/RS line) and (b) prints
    // both numbers with the SAME two-decimal formatting `buildQuestionLines`
    // already uses for the persona branch (the local `fmt()` helper,
    // `.toFixed(2)`):
    //   "Kontroll-kar pozíció-konzisztencia (PC): 1.00, kontroll-kar ismétlési stabilitás (RS): 0.50"
    expect(prompt).toContain('Kontroll-kar pozíció-konzisztencia (PC): 1.00')
    expect(prompt).toContain('kontroll-kar ismétlési stabilitás (RS): 0.50')
  })

  it('adds no control-arm PC/RS line when there is no control arm at all (no persona data AND no baseline) — no regression', () => {
    const results = {
      totalResponses: 3,
      duplicateResponseCount: 0,
      invalidRate: 0,
      abstainRate: 0,
      questions: [
        {
          questionId: 'q',
          text: 'Melyeket?',
          options: ['a', 'b'],
          scaleType: 'single_choice',
          elicitationMode: 'single_choice' as const,
          legacyElicitationCount: 0,
          aggregatedResponseCount: 0,
          totalResponses: 3,
          invalidCount: 3,
          abstainCount: 0,
          aggregated: [0, 0],
          byPersona: {},
          baseline: null,
          positionShift: null,
          positionShiftSampleSize: 0,
          positionConsistency: null,
          repetitionStability: null
        }
      ]
    }
    const prompt = buildEvaluationPrompt('R', results, { calibration: true })
    expect(prompt).not.toContain('Kontroll-kar pozíció-konzisztencia')
    expect(prompt).not.toContain('kontroll-kar ismétlési stabilitás')
  })
})

/**
 * Issue #40 review CRITICAL: `seedNoiseFloor` (src/lib/results.ts) returns 0
 * whenever the control arm has FEWER THAN 2 of its own seed-groups. Before
 * this milestone that could only happen when a run itself used a single
 * seed. Since the elicitation-mode filter added in this same milestone
 * (issue #40 review MEDIUM, see the `legacyElicitationBaselineCount` describe
 * blocks above) can drop one seed's only surviving baseline row, it now ALSO
 * fires on a run configured with >= 2 seeds, whenever exactly one seed's
 * baseline row happens to be legacy. `movesModel = divergence > noiseFloor`
 * then reads `divergence > 0`, true for almost any nonzero divergence — a
 * false "this persona moved the model" for what is actually unmeasured
 * noise, reaching both the judge prompt (evaluate.ts) and the UI
 * (run-view.js:236, ' (zajszint)' suffix).
 *
 * REQUIRED CONTRACT (spelled out so the implementer does not have to guess):
 *
 *   1. `baselineDivergence` is UNCHANGED: it stays `null` ONLY when there is
 *      no control arm at all for this question (`q.baseline === null`). It
 *      remains a real number whenever a control-arm mean was computed, even
 *      if that arm's OWN noise floor could not be measured — "how far is the
 *      persona from the control arm" and "do we know the control arm's own
 *      noise level" are two separate facts and must not be conflated into
 *      one `null`.
 *
 *   2. `movesModel` gains a new way to be `null`: whenever the control arm
 *      has FEWER THAN 2 of its own seed-groups (after the elicitation-mode
 *      filter), `movesModel` MUST be `null` — never `true` — regardless of
 *      how large or small the raw divergence is. `movesModel` may only be
 *      `true`/`false` once the noise floor was ACTUALLY measured (>= 2
 *      control-arm seed-groups survived the filter).
 *
 *   3. The two `null` cases must stay distinguishable by inspecting
 *      `baselineDivergence` alongside `movesModel`:
 *        - `baselineDivergence === null` -> "no control arm at all".
 *        - `movesModel === null && baselineDivergence !== null` -> "control
 *          arm exists, but its own noise floor is unknown".
 *
 *   4. That distinction must reach BOTH reader surfaces, not just the
 *      computed field:
 *        - evaluate.ts's per-persona divergence line must print a
 *          qualifier containing the phrase "nem eldönthető" for this case,
 *          and must NOT print the existing "a zajszinten belül" qualifier
 *          (that phrase is reserved for the genuinely-decided `false` case —
 *          printing it here would be a false claim, since no real noise
 *          floor was ever compared against).
 *        - run-view.js's persona-breakdown table cell must likewise carry a
 *          qualifier containing "nem eldönthető", and must NOT contain
 *          "zajszint" (which would misleadingly read as the decided
 *          "within noise" case).
 *      Both surfaces are exercised by dedicated tests below/elsewhere (this
 *      file's next describe block for the prompt; tests/frontend-view-dom.test.ts
 *      for the persona-breakdown table).
 *
 * RESOLVED CONFLICT WITH A PRE-EXISTING #40 TEST: the existing test "flags a
 * persona that does not move the model away from its default"
 * (`describe('computeRunResults — baseline control arm', …)` above) used to
 * insert a SINGLE control-arm row (one seed-group). Its divergence was
 * exactly 0 only by construction of that fixture, which is why the pre-fix
 * code accidentally produced the "right-looking" `false` there — but under
 * the contract above a single seed-group makes the noise floor undecidable,
 * so `movesModel` would correctly become `null`, not `false`, contradicting
 * that test's own title and intent ("flags … that does NOT move the
 * model" — a DECIDED `false`, not "we don't know"). Fixed in place (this
 * file, same describe block, same test): a second, identical-distribution
 * control-arm seed-group was added so the noise floor is genuinely MEASURED
 * (and still comes out 0), preserving both the original intent and the
 * original assertion for the right reason.
 */
describe('computeRunResults — movesModel is undecidable (null), not true, when the control arm’s own noise floor cannot be measured (issue #40 review CRITICAL)', () => {
  function insertBaselineRow(opts: { seed: number; dist: Record<string, number>; mode?: string | null }): void {
    db.prepare(
      `INSERT INTO responses (id, run_id, persona_id, question_id, model_requested, temperature, seed,
         permutation_json, prompt_rendered, raw_response, parsed_distribution_json, parsed_answer,
         is_valid, abstained, elicitation_mode, condition)
       VALUES (?,?,NULL,?,'m',1,?,?,'p','r',?,'0',1,0,?,'baseline')`
    ).run(
      randomUUID(), runId, qid, opts.seed, JSON.stringify([0, 1]),
      JSON.stringify(opts.dist), opts.mode === undefined ? null : opts.mode
    )
  }

  // Exact fixture from the code review: persona [0.78, 0.22]; control-arm
  // seed 0 [0.8, 0.2]; control-arm seed 1 [0.5, 0.5]. Independently verified
  // against the project's own jensenShannon() formula (see task report):
  // divergence persona-vs-seed0-only = 0.0004349…; divergence
  // persona-vs-mean-of-both = 0.0150567…; noise floor (seed0 vs seed1) =
  // 0.0731040….
  it('reports movesModel as undecidable, not true, when the elicitation-mode filter (issue #40 review MEDIUM) leaves only one control-arm seed-group', () => {
    insertResponse({ dist: { '0': 0.78, '1': 0.22 } })
    insertBaselineRow({ seed: 0, dist: { '0': 0.8, '1': 0.2 } }) // mode null -> kept (question is single_choice)
    insertBaselineRow({ seed: 1, dist: { '0': 0.5, '1': 0.5 }, mode: 'multi_choice' }) // mismatched mode -> dropped

    const q = computeRunResults(db, runId).questions[0]!
    expect((q as unknown as { legacyElicitationBaselineCount: number }).legacyElicitationBaselineCount).toBe(1)
    expect(q.baseline).toBeTruthy() // one seed-group still survived: a control-arm mean exists
    expect(q.byPersona[p1]!.baselineDivergence).toBeCloseTo(0.000435, 5) // real, tiny divergence — NOT null
    // THE BUG: under today's code this reads `true` (0.000435 > noiseFloor=0).
    expect(q.byPersona[p1]!.movesModel).toBeNull()
  })

  it('computes a real noise floor and correctly scores movesModel once both control-arm seed-groups survive the filter — same fixture, no drop', () => {
    insertResponse({ dist: { '0': 0.78, '1': 0.22 } })
    insertBaselineRow({ seed: 0, dist: { '0': 0.8, '1': 0.2 } })
    insertBaselineRow({ seed: 1, dist: { '0': 0.5, '1': 0.5 } }) // mode null too -> kept

    const q = computeRunResults(db, runId).questions[0]!
    expect((q as unknown as { legacyElicitationBaselineCount: number }).legacyElicitationBaselineCount).toBe(0)
    expect(q.byPersona[p1]!.baselineDivergence).toBeCloseTo(0.015057, 4) // now against the mean of BOTH seeds
    expect(q.byPersona[p1]!.movesModel).toBe(false) // 0.0151 < noise floor 0.0731: genuinely within noise
  })

  it('reports movesModel as undecidable for a run with only ONE control-arm seed to begin with — the more general case, not only reachable via the elicitation-mode filter', () => {
    insertResponse({ dist: { '0': 0.9, '1': 0.1 } })
    insertBaselineRow({ seed: 0, dist: { '0': 0.2, '1': 0.8 } }) // single seed, large divergence
    const q = computeRunResults(db, runId).questions[0]!
    expect(q.baseline).toBeTruthy()
    expect(q.byPersona[p1]!.baselineDivergence).toBeGreaterThan(0.3) // ~0.397 — a real, large divergence
    expect(q.byPersona[p1]!.movesModel).toBeNull() // still undecidable: only one seed-group ever existed
  })

  it('keeps movesModel AND baselineDivergence both null when there is no control arm at all — distinguishable from the new "undecidable" case above', () => {
    insertResponse({ dist: { '0': 0.9, '1': 0.1 } })
    const q = computeRunResults(db, runId).questions[0]!
    expect(q.baseline).toBeNull()
    expect(q.byPersona[p1]!.baselineDivergence).toBeNull()
    expect(q.byPersona[p1]!.movesModel).toBeNull()
  })
})

/**
 * Issue #40 review CRITICAL, continued: the judge prompt (evaluate.ts) must
 * not silently drop the undecidable-noise-floor case into either "moved the
 * model" (no qualifier at all) or "within noise" (the existing `false`
 * qualifier). See the contract spelled out in the describe block above.
 */
describe('buildEvaluationPrompt — an undecidable movesModel reads as undecidable, not as "within noise" and not as a plain decided divergence (issue #40 review CRITICAL)', () => {
  function insertBaselineRow(dist: Record<string, number>): void {
    db.prepare(
      `INSERT INTO responses (id, run_id, persona_id, question_id, model_requested, temperature, seed,
         permutation_json, prompt_rendered, raw_response, parsed_distribution_json, parsed_answer,
         is_valid, abstained, condition)
       VALUES (?,?,NULL,?,'m',1,0,?,'p','r',?,'0',1,0,'baseline')`
    ).run(randomUUID(), runId, qid, JSON.stringify([0, 1]), JSON.stringify(dist))
  }

  it('prints the divergence but flags it "nem eldönthető" — not "a zajszinten belül" — when the control arm has only one seed-group', () => {
    insertResponse({ dist: { '0': 0.9, '1': 0.1 } })
    insertBaselineRow({ '0': 0.2, '1': 0.8 })
    const results = computeRunResults(db, runId)
    expect(results.questions[0]!.byPersona[p1]!.movesModel).toBeNull() // sanity, mirrors the contract above
    expect(results.questions[0]!.byPersona[p1]!.baselineDivergence).not.toBeNull() // sanity

    const prompt = buildEvaluationPrompt('R', results)
    // Scoped to the PER-PERSONA divergence line only, not the whole prompt.
    // The prompt also carries a STATIC, every-run rule paragraph
    // (buildEvaluationPrompt's FONTOS SZABÁLYOK bullet, evaluate.ts) that
    // itself contains the words "a zajszinten belül" as general reader
    // guidance, unrelated to this run's data — a whole-prompt
    // `not.toContain('a zajszinten belül')` can never pass regardless of
    // what the per-persona line says, and that static paragraph is also
    // byte-for-byte pinned by tests/evaluate-calibration.test.ts's
    // GOLDEN_PERSONA_PROMPT (an intentional regression guard, not to be
    // touched). Extracting just "P1: …" isolates the one line this test is
    // actually about.
    const personaLineMatch = prompt.match(/P1: [^\n]*/)
    expect(personaLineMatch).not.toBeNull()
    const personaLine = personaLineMatch![0]
    expect(personaLine).toContain('0.397') // the number itself must still be printed, never hidden
    expect(personaLine).toContain('nem eldönthető')
    expect(personaLine).not.toContain('a zajszinten belül') // reserved for the genuinely-decided `false` case
  })
})

/**
 * Issue #40 review HIGH: `legacyBaselineNote` (evaluate.ts's buildQuestionLines)
 * is only ever spliced into the text from INSIDE a `q.baseline ? … : ''`
 * branch — both in the `aggregatedResponseCount === 0` fork (baseline-only
 * question) and in the ordinary (persona-bearing) fork's `baselineLine`. If
 * the elicitation-mode filter (issue #40 review MEDIUM) drops EVERY baseline
 * row for a question, `q.baseline` becomes `null` and the whole branch that
 * carries `legacyBaselineNote` is skipped — even though
 * `legacyElicitationBaselineCount` was computed correctly and is > 0. The
 * judge is left thinking the run simply had no control arm for that
 * question, not that a data-quality drop happened.
 *
 * Required fix: `legacyBaselineNote` must reach the rendered text whenever
 * `legacyElicitationBaselineCount > 0`, independent of whether `q.baseline`
 * is `null` — in EITHER fork (baseline-only AND ordinary/mixed).
 */
describe('buildEvaluationPrompt — the control-arm legacy warning survives even when q.baseline is null (issue #40 review HIGH)', () => {
  function insertBaselineRow(opts: { seed: number; dist: Record<string, number>; mode: string }): void {
    db.prepare(
      `INSERT INTO responses (id, run_id, persona_id, question_id, model_requested, temperature, seed,
         permutation_json, prompt_rendered, raw_response, parsed_distribution_json, parsed_answer,
         is_valid, abstained, elicitation_mode, condition)
       VALUES (?,?,NULL,?,'m',1,?,?,'p','r',?,'0',1,0,?,'baseline')`
    ).run(randomUUID(), runId, qid, opts.seed, JSON.stringify([0, 1]), JSON.stringify(opts.dist), opts.mode)
  }

  it('keeps the legacy control-arm warning when EVERY baseline row is filtered out, in a MIXED run where the persona side still has data (review’s exact reproduction)', () => {
    insertResponse({ dist: { '0': 1, '1': 0 } }) // one valid persona row -> aggregatedResponseCount > 0
    insertBaselineRow({ seed: 0, dist: { '0': 0.5, '1': 0.5 }, mode: 'multi_choice' })
    insertBaselineRow({ seed: 1, dist: { '0': 0.5, '1': 0.5 }, mode: 'multi_choice' })

    const results = computeRunResults(db, runId)
    const q = results.questions[0]!
    expect(q.baseline).toBeNull() // sanity: the whole control arm was dropped
    expect(q.aggregatedResponseCount).toBe(1) // sanity: NOT the zero-aggregate branch
    expect((q as unknown as { legacyElicitationBaselineCount: number }).legacyElicitationBaselineCount).toBe(2)

    const prompt = buildEvaluationPrompt('R', results)
    // Existing, already-tested wording (evaluate.ts) — this test only asserts
    // it actually reaches the output when q.baseline is null, not that the
    // wording itself is new.
    expect(prompt).toContain('2 kontroll-kar válasz')
    expect(prompt).toMatch(/régi.*elicitation/i)
  })

  it('keeps the legacy control-arm warning when the question has NO persona rows at all AND every baseline row is legacy (the zero-aggregate branch)', () => {
    insertBaselineRow({ seed: 0, dist: { '0': 0.5, '1': 0.5 }, mode: 'multi_choice' })
    insertBaselineRow({ seed: 1, dist: { '0': 0.9, '1': 0.1 }, mode: 'multi_choice' })

    const results = computeRunResults(db, runId)
    const q = results.questions[0]!
    expect(q.baseline).toBeNull()
    expect(q.aggregatedResponseCount).toBe(0) // sanity: THE zero-aggregate branch
    expect((q as unknown as { legacyElicitationBaselineCount: number }).legacyElicitationBaselineCount).toBe(2)

    const prompt = buildEvaluationPrompt('R', results)
    expect(prompt).toContain('Nincs értékelhető válasz')
    expect(prompt).toContain('2 kontroll-kar válasz')
  })
})
