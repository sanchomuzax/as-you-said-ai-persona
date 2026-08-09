import type { Db } from '../db.js'
import { elicitationModeFor, type ElicitationMode } from './parse.js'

export const POSITION_SHIFT_MIN_SAMPLE = 8

export interface ReferenceComparison {
  measuredShare: number | null
  referenceShare: number
  differencePercentagePoints: number | null
  source: string
  year: string
  valueLabel: string
  measurementArm: 'persona' | 'baseline' | null
}

export interface QuestionResult {
  questionId: string
  text: string
  options: string[]
  scaleType: string
  /** Versioned research context stored with the exact question snapshot. */
  metadata?: Record<string, unknown> | null
  /** Explicit, source-backed comparison; null means no usable reference was recorded. */
  referenceComparison?: ReferenceComparison | null
  /** Why a recorded _reference could not be evaluated; null when absent or usable. */
  referenceIssue?: string | null
  /** How this question was asked; multi_choice options are independent, not a distribution. */
  elicitationMode: ElicitationMode
  /**
   * Responses recorded before the multi_choice elicitation fix: their values were
   * normalized as if the options were mutually exclusive, so they are excluded
   * from the aggregate — but never silently: the count is reported.
   */
  legacyElicitationCount: number
  /**
   * Same drop, but on the control-arm side (`condition = 'baseline'`). Kept
   * separate from `legacyElicitationCount`: in a mixed run the persona
   * aggregate and the control-arm mean are two different numbers, and
   * `legacyElicitationCount`'s one consumer (evaluate.ts's legacyNote) names a
   * specific aggregate — folding a baseline-side drop into it would
   * misattribute which aggregate lost a row.
   */
  legacyElicitationBaselineCount?: number
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
      /**
       * Whether the persona's divergence exceeds the control arm's own seed
       * noise floor. `null` on two DIFFERENT grounds, distinguishable only via
       * `baselineDivergence`: no control arm at all (`baselineDivergence` is
       * also `null` there), or a control arm with fewer than 2 surviving
       * seed-groups — a real divergence was measured (`baselineDivergence` is
       * a number), but there is nothing to compare it against, so the answer
       * is genuinely unknown, never `true` by default (issue #40 review
       * CRITICAL). `true`/`false` are only produced once a real noise floor
       * (>= 2 seed-groups) was measured.
       */
      movesModel: boolean | null
    }
  >
  /** Mean distribution of the persona-free control cells, null when the run had no arm. */
  baseline: number[] | null
  /** Position Consistency: share of (persona, seed) groups whose top choice is identical across rotations. */
  positionConsistency: number | null
  /** Repetition Stability: share of (persona, rotation) groups whose top choice is identical across seeds. */
  repetitionStability: number | null
  /**
   * Mean displayed position of the single top choice, normalized to 0..1 and
   * centred on 0.5. Negative means primacy; positive means recency. `null`
   * means the direction was not measurable, never a measured zero.
   */
  positionShift: number | null
  /** Valid, non-abstaining, single-choice cells behind `positionShift`. */
  positionShiftSampleSize: number
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
      `SELECT q.id, q.text, q.options_json, q.scale_type, q.metadata_json FROM questions q
       JOIN runs r ON r.questionnaire_id = q.questionnaire_id WHERE r.id = ? ORDER BY q.ord`
    )
    .all(runId) as unknown as { id: string; text: string; options_json: string; scale_type: string; metadata_json: string | null }[]

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
    // averaged into the persona result, only compared against it. But it is still
    // a real, recorded response — issue #32: totalResponses/invalidCount/abstainCount
    // below must count it, or a run whose rows are ALL baseline (persona_id IS NULL,
    // e.g. a calibration run) reports 0/0/0 for every question while the run-level
    // totals (computed from the unfiltered response set) still show the real count.
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
    const parsableBaseline = baselineRows.filter(
      (r) => r.is_valid === 1 && r.abstained === 0 && r.parsed_distribution_json
    )
    // Same elicitation_mode filter as the persona side (`usable` above), with
    // the same null-legacy + single_choice allowance — otherwise a baseline row
    // recorded under a stale mode both skews the control-arm mean and corrupts
    // its PC/RS group (issue #40 review MEDIUM).
    const validBaseline = parsableBaseline.filter(
      (r) => r.elicitation_mode === mode || (r.elicitation_mode === null && mode === 'single_choice')
    )
    const legacyElicitationBaselineCount = parsableBaseline.length - validBaseline.length
    const baseline = validBaseline.length > 0 ? meanDistribution(validBaseline, options.length) : null
    // Noise floor: how far the control arm drifts from itself between seeds. A
    // persona closer than that has not moved the model, it has moved with the
    // noise. `null` (not 0) when fewer than 2 control-arm seed-groups survive
    // the elicitation-mode filter above — with only one group there is no pair
    // to measure drift between, so "0 noise" would be a fabricated measurement,
    // not an absence of one, and every non-zero divergence would then read as
    // "moved the model" (issue #40 review CRITICAL).
    const noiseFloor = baseline ? seedNoiseFloor(validBaseline, options.length) : null
    // PC/RS are computed over both arms together (see below) — the control arm
    // is real evidence of the model's own stability, not just a comparison point.
    const pcRsRows = [...valid, ...validBaseline]

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
          // Undecidable (null) unless BOTH a divergence AND a measured noise
          // floor exist — a control arm with only one surviving seed-group has
          // a real divergence but no measurable noise floor, and must not
          // default to `true` just because `divergence > 0`.
          movesModel: divergence === null || noiseFloor === null ? null : divergence > noiseFloor
        }
      }
    }

    const metadata = parseQuestionMetadata(q.metadata_json)
    const reference = compareWithReference(
      metadata,
      valid.length > 0 ? aggregated : baseline,
      valid.length > 0 ? 'persona' : baseline ? 'baseline' : null,
      options.length
    )

    const measuredPositionShift = positionShift(pcRsRows, options.length, mode)

    return {
      questionId: q.id,
      text: q.text,
      options,
      scaleType: q.scale_type,
      metadata,
      referenceComparison: reference.comparison,
      referenceIssue: reference.issue,
      baseline,
      elicitationMode: mode,
      legacyElicitationCount,
      legacyElicitationBaselineCount,
      aggregatedResponseCount: valid.length,
      // All rows for this question — persona AND control-arm — not just `rows`
      // (persona-condition only): the control arm's own invalid/abstain rows are
      // real evidence gaps too, and a baseline-only run must not report 0 here.
      totalResponses: allRows.length,
      invalidCount: allRows.filter((r) => r.is_valid === 0).length,
      abstainCount: allRows.filter((r) => r.abstained === 1).length,
      aggregated,
      byPersona,
      // PC/RS group by (subject, seed/rotation) — "subject" is the persona for
      // persona rows and the control arm itself for baseline rows (persona_id
      // is NULL there). Combining both arms here, keyed this way, means a
      // baseline-only (calibration) run gets a real PC/RS instead of null, and
      // a mixed run keeps the control arm's own group separate from every
      // persona's group rather than dropping it (issue #40).
      positionConsistency: consistency(pcRsRows, (r) => `${r.persona_id ?? 'baseline'}|${r.seed}`, mode),
      repetitionStability: consistency(
        pcRsRows,
        (r) => `${r.persona_id ?? 'baseline'}|${r.permutation_json}`,
        mode
      ),
      positionShift: measuredPositionShift.value,
      positionShiftSampleSize: measuredPositionShift.sampleSize
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

/**
 * Direction of the position effect for one question (issue #39).
 *
 * `permutation_json[i]` is the ORIGINAL option index displayed at position i.
 * Only a single-choice answer has one well-defined displayed position. The
 * input rows have already passed validity, abstention, elicitation-mode and
 * duplicate-cell filtering; malformed answer/rotation pairs still stay out of
 * the denominator so the returned sample size exposes the remaining gap.
 */
function positionShift(
  rows: ResponseRow[],
  optionCount: number,
  mode: ElicitationMode
): { value: number | null; sampleSize: number } {
  if (mode !== 'single_choice' || optionCount < 2) return { value: null, sampleSize: 0 }

  const positions: number[] = []
  for (const row of rows) {
    if (row.parsed_answer === null || row.parsed_answer === '' || row.parsed_answer.includes(',')) continue
    const answer = Number(row.parsed_answer)
    if (!Number.isInteger(answer) || answer < 0 || answer >= optionCount) continue

    let rotation: unknown
    try {
      rotation = JSON.parse(row.permutation_json)
    } catch {
      continue
    }
    if (
      !Array.isArray(rotation) ||
      rotation.length !== optionCount ||
      rotation.some((index) => !Number.isInteger(index) || index < 0 || index >= optionCount) ||
      new Set(rotation).size !== optionCount
    ) continue

    const displayedPosition = rotation.indexOf(answer)
    if (displayedPosition < 0) continue
    positions.push(displayedPosition / (optionCount - 1))
  }

  const sampleSize = positions.length
  if (sampleSize < POSITION_SHIFT_MIN_SAMPLE) return { value: null, sampleSize }
  const meanPosition = positions.reduce((sum, position) => sum + position, 0) / sampleSize
  return { value: meanPosition - 0.5, sampleSize }
}

function parseQuestionMetadata(value: string | null): Record<string, unknown> | null {
  if (value === null || value === '') return null
  const parsed = JSON.parse(value) as unknown
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('A kérdés metaadata nem JSON-objektum')
  }
  return parsed as Record<string, unknown>
}

function compareWithReference(
  metadata: Record<string, unknown> | null,
  distribution: number[] | null,
  measurementArm: 'persona' | 'baseline' | null,
  optionCount: number
): { comparison: ReferenceComparison | null; issue: string | null } {
  const raw = metadata?.['_reference']
  if (raw === undefined) return { comparison: null, issue: null }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { comparison: null, issue: 'Hibás referencia-metaadat: a _reference mezőnek objektumnak kell lennie.' }
  }
  const reference = raw as Record<string, unknown>
  const referenceShare = reference['referenceShare']
  const optionIndexes = reference['optionIndexes']
  const indexesValid = Array.isArray(optionIndexes) && optionIndexes.length > 0 &&
    optionIndexes.every((index) => Number.isInteger(index) && Number(index) >= 0 && Number(index) < optionCount) &&
    new Set(optionIndexes.map(Number)).size === optionIndexes.length
  if (
    typeof referenceShare !== 'number' || !Number.isFinite(referenceShare) || referenceShare < 0 || referenceShare > 1 ||
    !indexesValid
  ) {
    return {
      comparison: null,
      issue: 'Hiányos vagy hibás referencia-metaadat: a referenceShare (0–1) és az egyedi, érvényes optionIndexes kötelező.'
    }
  }

  const total = distribution?.reduce((sum, value) => sum + value, 0) ?? 0
  const measuredShare = distribution && total > 0
    ? optionIndexes.reduce((sum, index) => sum + (distribution[Number(index)] ?? 0), 0) / total
    : null
  return { comparison: {
    measuredShare,
    referenceShare,
    differencePercentagePoints: measuredShare === null ? null : (measuredShare - referenceShare) * 100,
    source: typeof reference['forras'] === 'string' ? reference['forras'] : 'Nincs rögzített forrás',
    year: typeof reference['ev'] === 'string' ? reference['ev'] : 'Nincs rögzített év',
    valueLabel: typeof reference['ertek'] === 'string' ? reference['ertek'] : `${Math.round(referenceShare * 100)}%`,
    measurementArm
  }, issue: null }
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

/**
 * Mean divergence between the control arm's own seeds: the run's own noise
 * level. `null` when fewer than 2 seed-groups survive — the noise floor is
 * genuinely unmeasurable then, not zero (issue #40 review CRITICAL: a
 * fabricated 0 would make every non-zero persona divergence read as "moved
 * the model").
 */
function seedNoiseFloor(baselineRows: ResponseRow[], optionCount: number): number | null {
  const bySeed = new Map<number, ResponseRow[]>()
  for (const row of baselineRows) {
    if (!bySeed.has(row.seed)) bySeed.set(row.seed, [])
    bySeed.get(row.seed)!.push(row)
  }
  const distributions = [...bySeed.values()].map((rows) => meanDistribution(rows, optionCount))
  if (distributions.length < 2) return null
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
