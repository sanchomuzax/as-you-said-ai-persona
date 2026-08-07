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
  persona?: string
}): void {
  db.prepare(
    `INSERT INTO responses (id, run_id, persona_id, question_id, model_requested, temperature, seed,
       permutation_json, prompt_rendered, raw_response, parsed_distribution_json, parsed_answer, is_valid, abstained)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    randomUUID(), runId, opts.persona ?? p1, qid, 'm', 1.0, opts.seed ?? 0,
    JSON.stringify(opts.rotation ?? [0, 1]), 'p', 'r',
    opts.dist === null ? null : JSON.stringify(opts.dist ?? { '0': 0.8, '1': 0.2 }),
    opts.answer === undefined ? '0' : opts.answer,
    opts.valid === false ? 0 : 1, opts.abstained ? 1 : 0
  )
}

beforeEach(() => {
  db = createDb(':memory:')
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
})

describe('buildEvaluationPrompt', () => {
  it('embeds computed metrics and anti-bias instructions', () => {
    insertResponse({ dist: { '0': 0.9, '1': 0.1 } })
    const prompt = buildEvaluationPrompt('R', computeRunResults(db, runId))
    expect(prompt).toContain('Trust?')
    expect(prompt).toContain('Yes: 90.0%')
    expect(prompt).toContain('Pollyanna')
    expect(prompt).toContain('TSTR')
    expect(prompt).toContain('spurious split')
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
    insertArm({ condition: 'baseline', persona: null, dist: { '0': 0.6, '1': 0.4 } })
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
