import type { Db } from '../db.js'
import { elicitationModeFor, type ElicitationMode } from './parse.js'

export interface QuestionResult {
  questionId: string
  text: string
  options: string[]
  scaleType: string
  /** How this question was asked; multi_choice options are independent, not a distribution. */
  elicitationMode: ElicitationMode
  /**
   * Responses recorded before the multi_choice elicitation fix: their values were
   * normalized as if the options were mutually exclusive, so they are excluded
   * from the aggregate — but never silently: the count is reported.
   */
  legacyElicitationCount: number
  /** Responses actually behind `aggregated` (valid, non-abstained, matching mode). */
  aggregatedResponseCount: number
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
  elicitation_mode: string | null
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
              res.seed, res.parsed_distribution_json, res.parsed_answer, res.is_valid, res.abstained,
              res.elicitation_mode
       FROM responses res JOIN personas p ON p.id = res.persona_id WHERE res.run_id = ?`
    )
    .all(runId) as unknown as ResponseRow[]

  const results = questions.map((q) => {
    const options = JSON.parse(q.options_json) as string[]
    const mode = elicitationModeFor(q.scale_type)
    const rows = responses.filter((r) => r.question_id === q.id)
    const parsable = rows.filter((r) => r.is_valid === 1 && r.abstained === 0 && r.parsed_distribution_json)
    // A normalized answer to a multi-select question measures something else
    // entirely, so it cannot be averaged together with independent probabilities.
    const usable =
      mode === 'multi_choice' ? parsable.filter((r) => r.elicitation_mode === 'multi_choice') : parsable
    const legacyElicitationCount = parsable.length - usable.length
    const valid = usable

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
      elicitationMode: mode,
      legacyElicitationCount,
      aggregatedResponseCount: valid.length,
      totalResponses: rows.length,
      invalidCount: rows.filter((r) => r.is_valid === 0).length,
      abstainCount: rows.filter((r) => r.abstained === 1).length,
      aggregated,
      byPersona,
      positionConsistency: consistency(valid, (r) => `${r.persona_id}|${r.seed}`, mode),
      repetitionStability: consistency(valid, (r) => `${r.persona_id}|${r.permutation_json}`, mode)
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

/**
 * Agreement of the recorded answers within each group.
 *
 * single_choice: the share of groups whose chosen option is identical — the
 * answer is one option, so agreement is all-or-nothing.
 *
 * multi_choice: the mean pairwise Jaccard overlap of the selected sets. Exact set
 * equality would be a knife-edge test (one option crossing the 0.5 selection
 * threshold would score the whole group as inconsistent), which would make every
 * multi-select question look unreliable for an artefact of rounding.
 */
function consistency(
  rows: ResponseRow[],
  keyFn: (r: ResponseRow) => string,
  mode: ElicitationMode
): number | null {
  const groups = new Map<string, string[]>()
  for (const row of rows) {
    if (row.parsed_answer === null) continue
    const key = keyFn(row)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(row.parsed_answer)
  }
  const answerGroups = [...groups.values()]
  if (answerGroups.length === 0) return null

  const scores = answerGroups.map((answers) =>
    mode === 'multi_choice' ? meanPairwiseJaccard(answers) : (new Set(answers).size === 1 ? 1 : 0)
  )
  return scores.reduce((a, b) => a + b, 0) / scores.length
}

/** 1 when every member selected the same set; 0 when no two members overlap at all. */
function meanPairwiseJaccard(answers: string[]): number {
  if (answers.length < 2) return 1
  const sets = answers.map((a) => new Set(a === '' ? [] : a.split(',')))
  let sum = 0
  let pairs = 0
  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < sets.length; j++) {
      const a = sets[i]!
      const b = sets[j]!
      const intersection = [...a].filter((x) => b.has(x)).length
      const union = new Set([...a, ...b]).size
      // two empty selections agree completely
      sum += union === 0 ? 1 : intersection / union
      pairs++
    }
  }
  return sum / pairs
}
