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
    insertResponse({ dist: { '0': 1, '1': 0 } })
    insertResponse({ dist: null, answer: null, valid: false })
    insertResponse({ dist: null, answer: null, abstained: true })
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
