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
  /** Same, broken down per persona, with each persona's distance from the control arm. */
  byPersona: Record<
    string,
    {
      name: string
      distribution: number[]
      abstainCount: number
      /** Jensen-Shannon divergence from the control arm (0..1), null without an arm. */
      baselineDivergence: number | null
      /** False when the persona's answer sits within the run's own seed noise. */
      movesModel: boolean | null
    }
  >
  /** Mean distribution of the persona-free control cells, null when the run had no arm. */
  baseline: number[] | null
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
  /**
   * Rows that repeat an already-recorded cell (issue #16: parallel runner loops).
   * They are kept in the append-only log — they are genuine repeated measurements —
   * but counted once here, or a duplicated cell would weigh twice in the aggregate
   * and a differing duplicate would fake instability.
   */
  duplicateResponseCount: number
}

interface ResponseRow {
  id: string
  question_id: string
  elicitation_mode: string | null
  condition: string | null
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

  const allResponses = db
    .prepare(
      `SELECT res.id, res.question_id, res.persona_id, p.name AS persona_name, res.permutation_json,
              res.seed, res.parsed_distribution_json, res.parsed_answer, res.is_valid, res.abstained,
              res.elicitation_mode, res.condition
       FROM responses res LEFT JOIN personas p ON p.id = res.persona_id WHERE res.run_id = ?
       ORDER BY res.rowid`
    )
    .all(runId) as unknown as ResponseRow[]

  const { unique: responses, duplicates: duplicateResponseCount } = dedupeCells(allResponses)

  const results = questions.map((q) => {
    const options = JSON.parse(q.options_json) as string[]
    const mode = elicitationModeFor(q.scale_type)
    const allRows = responses.filter((r) => r.question_id === q.id)
    // The control arm answers the same question with no subject: it must never be
    // averaged into the persona result, only compared against it.
    const baselineRows = allRows.filter((r) => r.condition === 'baseline')
    const rows = allRows.filter((r) => r.condition !== 'baseline')
    const parsable = rows.filter((r) => r.is_valid === 1 && r.abstained === 0 && r.parsed_distribution_json)
    // A normalized answer to a multi-select question measures something else
    // entirely, so it cannot be averaged together with independent probabilities.
    // Generic on purpose: with a hardcoded multi_choice check, a third mode would
    // let a stale row survive dedupe and then average into the aggregate.
    const usable = parsable.filter(
      (r) => r.elicitation_mode === mode || (r.elicitation_mode === null && mode === 'single_choice')
    )
    const legacyElicitationCount = parsable.length - usable.length
    const valid = usable

    const aggregated = meanDistribution(valid, options.length)
    const validBaseline = baselineRows.filter(
      (r) => r.is_valid === 1 && r.abstained === 0 && r.parsed_distribution_json
    )
    const baseline = validBaseline.length > 0 ? meanDistribution(validBaseline, options.length) : null
    // Noise floor: how far the control arm drifts from itself between seeds. A
    // persona closer than that has not moved the model, it has moved with the noise.
    const noiseFloor = baseline ? seedNoiseFloor(validBaseline, options.length) : 0

    const byPersona: QuestionResult['byPersona'] = {}
    for (const row of rows) {
      if (!byPersona[row.persona_id]) {
        const personaRows = valid.filter((r) => r.persona_id === row.persona_id)
        const distribution = meanDistribution(personaRows, options.length)
        const divergence = baseline ? jensenShannon(distribution, baseline) : null
        byPersona[row.persona_id] = {
          name: row.persona_name,
          distribution,
          abstainCount: rows.filter((r) => r.persona_id === row.persona_id && r.abstained === 1).length,
          baselineDivergence: divergence,
          movesModel: divergence === null ? null : divergence > noiseFloor
        }
      }
    }

    return {
      questionId: q.id,
      text: q.text,
      options,
      scaleType: q.scale_type,
      baseline,
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
    duplicateResponseCount,
    invalidRate: total ? responses.filter((r) => r.is_valid === 0).length / total : 0,
    abstainRate: total ? responses.filter((r) => r.abstained === 1).length / total : 0
  }
}

/** One row per experimental cell; the first recording of a cell wins. */
function dedupeCells(rows: ResponseRow[]): { unique: ResponseRow[]; duplicates: number } {
  const seen = new Set<string>()
  const unique: ResponseRow[] = []
  for (const row of rows) {
    const key = `${row.question_id}|${row.persona_id}|${row.permutation_json}|${row.seed}|${row.elicitation_mode ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(row)
  }
  return { unique, duplicates: rows.length - unique.length }
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

/**
 * Jensen-Shannon divergence in bits (0 = identical, 1 = disjoint). Symmetric and
 * bounded, unlike KL — which matters because either side can contain a zero.
 */
function jensenShannon(p: number[], q: number[]): number {
  const norm = (v: number[]): number[] => {
    const sum = v.reduce((a, b) => a + b, 0)
    return sum > 0 ? v.map((x) => x / sum) : v.map(() => 0)
  }
  const a = norm(p)
  const b = norm(q)
  let divergence = 0
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const pi = a[i] ?? 0
    const qi = b[i] ?? 0
    const mi = (pi + qi) / 2
    if (pi > 0 && mi > 0) divergence += (pi / 2) * Math.log2(pi / mi)
    if (qi > 0 && mi > 0) divergence += (qi / 2) * Math.log2(qi / mi)
  }
  return Math.min(Math.max(divergence, 0), 1)
}

/** Mean divergence between the control arm's own seeds: the run's own noise level. */
function seedNoiseFloor(baselineRows: ResponseRow[], optionCount: number): number {
  const bySeed = new Map<number, ResponseRow[]>()
  for (const row of baselineRows) {
    if (!bySeed.has(row.seed)) bySeed.set(row.seed, [])
    bySeed.get(row.seed)!.push(row)
  }
  const distributions = [...bySeed.values()].map((rows) => meanDistribution(rows, optionCount))
  if (distributions.length < 2) return 0
  let sum = 0
  let pairs = 0
  for (let i = 0; i < distributions.length; i++) {
    for (let j = i + 1; j < distributions.length; j++) {
      sum += jensenShannon(distributions[i]!, distributions[j]!)
      pairs++
    }
  }
  return pairs > 0 ? sum / pairs : 0
}
