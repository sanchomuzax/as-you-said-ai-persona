import type { Db } from '../db.js'

export interface QuestionResult {
  questionId: string
  text: string
  options: string[]
  scaleType: string
  totalResponses: number
  invalidCount: number
  abstainCount: number
  /** Mean probability per original option index, over valid non-abstained responses. */
  aggregated: number[]
  /** Same, broken down per persona. */
  byPersona: Record<string, { name: string; distribution: number[]; abstainCount: number }>
  /** Position Consistency: share of (persona, seed) groups whose top choice is identical across rotations. */
  positionConsistency: number | null
  /** Repetition Stability: share of (persona, rotation) groups whose top choice is identical across seeds. */
  repetitionStability: number | null
}

export interface RunResults {
  questions: QuestionResult[]
  invalidRate: number
  abstainRate: number
  totalResponses: number
}

interface ResponseRow {
  question_id: string
  persona_id: string
  persona_name: string
  permutation_json: string
  seed: number
  parsed_distribution_json: string | null
  parsed_answer: string | null
  is_valid: number
  abstained: number
}

/**
 * Aggregates a run's responses per question: mean distributions (de-permuted to
 * original option order), invalid/abstain rates, and the RS/PC stability metrics
 * required by the validation literature. Pure read — computed from the
 * append-only response log.
 */
export function computeRunResults(db: Db, runId: string): RunResults {
  const questions = db
    .prepare(
      `SELECT q.id, q.text, q.options_json, q.scale_type FROM questions q
       JOIN runs r ON r.questionnaire_id = q.questionnaire_id WHERE r.id = ? ORDER BY q.ord`
    )
    .all(runId) as unknown as { id: string; text: string; options_json: string; scale_type: string }[]

  const responses = db
    .prepare(
      `SELECT res.question_id, res.persona_id, p.name AS persona_name, res.permutation_json,
              res.seed, res.parsed_distribution_json, res.parsed_answer, res.is_valid, res.abstained
       FROM responses res JOIN personas p ON p.id = res.persona_id WHERE res.run_id = ?`
    )
    .all(runId) as unknown as ResponseRow[]

  const results = questions.map((q) => {
    const options = JSON.parse(q.options_json) as string[]
    const rows = responses.filter((r) => r.question_id === q.id)
    const valid = rows.filter((r) => r.is_valid === 1 && r.abstained === 0 && r.parsed_distribution_json)

    const aggregated = meanDistribution(valid, options.length)
    const byPersona: QuestionResult['byPersona'] = {}
    for (const row of rows) {
      if (!byPersona[row.persona_id]) {
        const personaRows = valid.filter((r) => r.persona_id === row.persona_id)
        byPersona[row.persona_id] = {
          name: row.persona_name,
          distribution: meanDistribution(personaRows, options.length),
          abstainCount: rows.filter((r) => r.persona_id === row.persona_id && r.abstained === 1).length
        }
      }
    }

    return {
      questionId: q.id,
      text: q.text,
      options,
      scaleType: q.scale_type,
      totalResponses: rows.length,
      invalidCount: rows.filter((r) => r.is_valid === 0).length,
      abstainCount: rows.filter((r) => r.abstained === 1).length,
      aggregated,
      byPersona,
      positionConsistency: consistency(valid, (r) => `${r.persona_id}|${r.seed}`),
      repetitionStability: consistency(valid, (r) => `${r.persona_id}|${r.permutation_json}`)
    }
  })

  const total = responses.length
  return {
    questions: results,
    totalResponses: total,
    invalidRate: total ? responses.filter((r) => r.is_valid === 0).length / total : 0,
    abstainRate: total ? responses.filter((r) => r.abstained === 1).length / total : 0
  }
}

function meanDistribution(rows: ResponseRow[], optionCount: number): number[] {
  const sums = new Array<number>(optionCount).fill(0)
  let n = 0
  for (const row of rows) {
    const dist = JSON.parse(row.parsed_distribution_json!) as Record<string, number>
    n++
    for (let i = 0; i < optionCount; i++) sums[i] = (sums[i] ?? 0) + (dist[String(i)] ?? 0)
  }
  return n === 0 ? sums : sums.map((s) => s / n)
}

/** Share of groups whose parsed_answer (top choice) is identical across all group members. */
function consistency(rows: ResponseRow[], keyFn: (r: ResponseRow) => string): number | null {
  const groups = new Map<string, Set<string>>()
  for (const row of rows) {
    if (row.parsed_answer === null) continue
    const key = keyFn(row)
    if (!groups.has(key)) groups.set(key, new Set())
    groups.get(key)!.add(row.parsed_answer)
  }
  const multi = [...groups.values()].filter((s) => s.size >= 1)
  if (multi.length === 0) return null
  return multi.filter((s) => s.size === 1).length / multi.length
}
