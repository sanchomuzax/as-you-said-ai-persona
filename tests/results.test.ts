import { describe, it, expect, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { createDb, type Db } from '../src/db.js'
import { computeRunResults } from '../src/lib/results.js'
import { buildEvaluationPrompt } from '../src/lib/evaluate.js'

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
          byPersona: { p: { name: 'P', distribution: [0, 0], abstainCount: 0 } },
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
