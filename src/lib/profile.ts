import { createHash } from 'node:crypto'
import type { Db } from '../db.js'
import { buildStyleCPrompt, type TemplateLanguage } from './prompt.js'
import { elicitationModeFor } from './parse.js'
import { percentileBootstrapCI, type BootstrapResult } from './bootstrap.js'

/**
 * Re-exported so existing call sites and tests keep importing the bootstrap
 * primitive from `profile.js` — the PRNG/percentile machinery itself moved to
 * `bootstrap.ts` (code review suggestion: a natural boundary, and this file
 * was already past the "many small files" guideline's typical size).
 */
export { percentileBootstrapCI, type BootstrapResult }

/**
 * Model profiles (docs/MODEL-CALIBRATION.md, M2). A profile is the measured
 * default behaviour of ONE exact stack: model version, serving provider,
 * elicitation template, probe questionnaire version and language. Change any of
 * those and the numbers describe a configuration that no longer exists — which
 * is why the key has five components and not just the model name.
 *
 * Everything here is computed in code from the append-only response log. No
 * model is asked to summarise its own bias.
 */

/** Quarterly recalibration, per the calibration-loop guidance in the corpus. */
export const PROFILE_VALIDITY_DAYS = 90

/**
 * Recorded on a profile built from calibration runs that predate issue #33
 * (the elicitation template becoming language-dependent). Those runs used the
 * old, always-English framing regardless of what `language` below says — this
 * sentinel says so explicitly, instead of leaving a bare "no value" that a
 * later reader could misread as "unknown" or silently coerce to 'en'/'hu'.
 * Not a valid `TemplateLanguage`: nothing may be RENDERED in this "language",
 * it only ever appears as a historical marker on already-recorded data.
 */
export const LEGACY_TEMPLATE_LANGUAGE = 'mixed_legacy'

export interface ProfileKey {
  modelRequested: string
  modelVersion: string
  provider: string | null
  promptTemplateHash: string
  probeQuestionnaireId: string
  /**
   * CONTENT language of the probe questionnaire (the questions/options the
   * model was asked) — NOT the elicitation template's own wording. Kept under
   * its original name for backward compatibility with every existing profile
   * row and call site; `templateLanguage` below is the new, separate axis
   * issue #33 introduces. The two happen to agree for every profile built
   * from now on (the template defaults to the questionnaire's language), but
   * they are conceptually independent and a future HU-content/EN-template
   * comparison run would legitimately record them differently.
   */
  language: string
  /**
   * The elicitation TEMPLATE's own language (issue #33) — 'hu' or 'en' for a
   * profile built after the language split, or `LEGACY_TEMPLATE_LANGUAGE` for
   * one built from runs that predate it. Optional so the many call sites and
   * fixtures that only ever cared about the original five key components
   * (this module's own tests included) keep compiling; every profile actually
   * read out of the database populates it.
   */
  templateLanguage?: string
}

export interface StoredProfile extends ProfileKey {
  id: string
  metrics: ProfileMetrics | null
  runIds: string[]
  createdAt: string
  validUntil: string
}

export interface QuestionProfile {
  questionId: string
  text: string
  options: string[]
  scaleType: string
  /** Mean probability per original option index over the persona-free cells. */
  defaultDistribution: number[]
  /** Control cells actually behind the distribution (valid, non-abstained, current mode). */
  aggregatedResponseCount: number
  abstainCount: number
  invalidCount: number
  /**
   * Cells elicited under a DIFFERENT mode than the question now uses. Their
   * values are a different quantity (normalized probabilities vs. independent
   * supports), so they are excluded — but never silently: the count is reported.
   */
  legacyElicitationCount: number
}

export interface ProfileMetrics {
  /** Audit label for an ordinary questionnaire used as a calibration override. */
  probeInterpretability?: 'standard' | 'limited'
  /**
   * Present only on a `metrics_json` written from #47 (M4a) onward. Absence
   * (not a `1`) is how a reader recognises the pre-#47 shape — no migration
   * ever stamps this onto an old record, so `'schemaVersion' in metrics`
   * staying `false` for those rows is a load-bearing part of the contract,
   * not an oversight.
   */
  schemaVersion?: 2
  /**
   * Repeated-run distribution + bootstrap CI (issue #47, M4a), stored
   * ALONGSIDE the scalar fields below, never replacing them: `summarize()`
   * (src/model-profiles.ts) and public/model-card.js's older rendering keep
   * reading those scalars as plain numbers, unaware this field exists.
   */
  repeated?: RepeatedProfileMetrics
  perQuestion: QuestionProfile[]
  /**
   * PriDe-style prior bias: how often the model picks each POSITION, once the
   * balanced rotation has made every option appear in every position equally
   * often. A content-driven answer spreads evenly; a position-driven one does
   * not. `maxDeviation` is the largest departure from the uniform share.
   */
  priorBias: {
    byPosition: number[]
    /** Null when nothing could be measured — a 0 would read as a measured "no bias". */
    maxDeviation: number | null
    strongestPosition: number | null
    /** Which option count the histogram covers; positions are only comparable within one. */
    optionCount: number | null
  }
  /**
   * How far toward the positive pole the model's default sits on scales that
   * HAVE a pole (ordinal/frequency, with a recorded direction): 0 is the scale
   * midpoint, +0.5 the top. This is the measurable stand-in for the designed
   * Pollyanna offset — the design names product-evaluation trap items, but the
   * probe does not mark them yet, so this covers every directed scale instead
   * and must be read as the broader, weaker claim. Null when the probe has no
   * directed scale at all, because then there is no pole to be biased toward.
   */
  positivityOffset: number | null
  invalidRate: number
  abstainRate: number
  provenance: {
    runIds: string[]
    cellCount: number
    /** Repeated measurements of the same cell, counted once — but reported. */
    duplicateCellCount: number
    costUsd: number
    firstResponseAt: string | null
    lastResponseAt: string | null
  }
}

/**
 * Fingerprint of the elicitation template itself. Rendered from a fixed dummy
 * question so only the TEMPLATE contributes: every branch (persona / control
 * arm, single / multi choice, and — since issue #33 — every supported
 * template LANGUAGE) is included, so an edit to any of them shows up and
 * marks the existing profiles stale. Deliberately NOT scoped to one profile's
 * own recorded `templateLanguage`: this fingerprints the CODE, so an edit to
 * a language a given profile never rendered still invalidates it — the
 * profile only claims to describe a stack that includes this whole module.
 */
export function promptTemplateHash(): string {
  const question = { text: 'Q', options: ['A', 'B'] }
  const persona = {
    name: 'N',
    demographics: { k: 'v' },
    renderingStyle: 'bulleted_profile' as const
  }
  const languages: TemplateLanguage[] = ['en', 'hu']
  const variants = languages.flatMap((language) => [
    buildStyleCPrompt(persona, question, [0, 1], 'single_choice', language).prompt,
    buildStyleCPrompt(persona, question, [0, 1], 'multi_choice', language).prompt,
    buildStyleCPrompt(null, question, [0, 1], 'single_choice', language).prompt,
    buildStyleCPrompt(null, question, [0, 1], 'multi_choice', language).prompt
  ])
  return createHash('sha256').update(variants.join(' ')).digest('hex').slice(0, 16)
}

export type ProfileStatus = 'valid' | 'stale'

/**
 * A profile is only valid for the exact stack it was measured on. Anything else
 * is `stale`: still readable (it is a record of what was true), never presented
 * as describing the current configuration.
 */
export function profileStatus(profile: StoredProfile, current: ProfileKey, nowIso: string): ProfileStatus {
  const sameKey =
    profile.modelRequested === current.modelRequested &&
    profile.modelVersion === current.modelVersion &&
    profile.provider === current.provider &&
    profile.promptTemplateHash === current.promptTemplateHash &&
    profile.probeQuestionnaireId === current.probeQuestionnaireId &&
    profile.language === current.language &&
    profile.templateLanguage === current.templateLanguage
  if (!sameKey) return 'stale'
  return Date.parse(sqliteToIso(profile.validUntil)) > Date.parse(nowIso) ? 'valid' : 'stale'
}

/** SQLite writes UTC without a zone marker; parsed as local it drifts by hours. */
export function sqliteToIso(value: string): string {
  return /[Zz]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value.replace(' ', 'T')}Z`
}

interface ProfileRow {
  id: string
  question_id: string
  scale_type_current: string
  elicitation_mode: string | null
  seed: number
  text: string
  options_json: string
  scale_type: string
  scale_direction: string
  permutation_json: string
  parsed_distribution_json: string | null
  parsed_answer: string | null
  is_valid: number
  abstained: number
  cost_usd: number | null
  created_at: string
}

/**
 * Measures the model's default behaviour from the persona-free cells of the
 * given calibration runs. Persona cells are excluded by the query: a profile
 * that included them would describe a persona, not the model.
 */
export function computeProfileMetrics(db: Db, runIds: readonly string[]): ProfileMetrics {
  const raw = runIds.length === 0 ? [] : (db
    .prepare(
      `SELECT res.id, res.question_id, q.text, q.options_json, q.scale_type, q.scale_type AS scale_type_current,
              q.scale_direction, res.elicitation_mode, res.seed,
              res.permutation_json, res.parsed_distribution_json, res.parsed_answer,
              res.is_valid, res.abstained, res.cost_usd, res.created_at
         FROM responses res
         JOIN questions q ON q.id = res.question_id
        WHERE res.run_id IN (${runIds.map(() => '?').join(',')})
          AND res.persona_id IS NULL
        ORDER BY res.created_at`
    )
    .all(...runIds) as unknown as ProfileRow[])

  // Databases recorded before the one-row-per-cell index may hold repeated
  // measurements of the same cell. They are genuine records and stay in the log,
  // but counting one twice would move both the default distribution and the
  // position histogram — the same reasoning as in results.ts.
  const { rows, duplicates } = dedupeCells(raw)

  const byQuestion = new Map<string, ProfileRow[]>()
  for (const row of rows) {
    if (!byQuestion.has(row.question_id)) byQuestion.set(row.question_id, [])
    byQuestion.get(row.question_id)!.push(row)
  }

  const perQuestion = [...byQuestion.values()].map(toQuestionProfile)
  const timestamps = rows.map((r) => r.created_at).sort()

  return {
    perQuestion,
    priorBias: positionBias(rows.filter(matchesCurrentMode)),
    positivityOffset: positivityOffset(byQuestion),
    invalidRate: rows.length === 0 ? 0 : rows.filter((r) => r.is_valid === 0).length / rows.length,
    abstainRate: rows.length === 0 ? 0 : rows.filter((r) => r.abstained === 1).length / rows.length,
    provenance: {
      runIds: [...runIds],
      cellCount: rows.length,
      duplicateCellCount: duplicates,
      costUsd: rows.reduce((sum, r) => sum + (r.cost_usd ?? 0), 0),
      firstResponseAt: timestamps[0] ?? null,
      lastResponseAt: timestamps.at(-1) ?? null
    }
  }
}

/**
 * A cell is (question, permutation, seed, mode) — there is no persona here, the
 * whole set is the control arm.
 */
function dedupeCells(rows: ProfileRow[]): { rows: ProfileRow[]; duplicates: number } {
  const seen = new Set<string>()
  const unique: ProfileRow[] = []
  for (const row of rows) {
    const key = `${row.question_id}|${row.permutation_json}|${row.seed}|${row.elicitation_mode ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(row)
  }
  return { rows: unique, duplicates: rows.length - unique.length }
}

/**
 * Legacy rows (mode NULL) were elicited before the split and are equivalent to
 * today's single-choice output; anything else has to match the question's
 * current mode or it measures a different quantity.
 */
function matchesCurrentMode(row: ProfileRow): boolean {
  const current = elicitationModeFor(row.scale_type_current)
  return row.elicitation_mode === null ? current === 'single_choice' : row.elicitation_mode === current
}

function toQuestionProfile(rows: ProfileRow[]): QuestionProfile {
  const first = rows[0]!
  const options = JSON.parse(first.options_json) as string[]
  const current = rows.filter(matchesCurrentMode)
  const usable = current.filter((r) => r.is_valid === 1 && r.abstained === 0 && r.parsed_distribution_json !== null)
  return {
    questionId: first.question_id,
    text: first.text,
    options,
    scaleType: first.scale_type,
    defaultDistribution: meanDistribution(usable, options.length),
    // Exactly the rows behind the mean, so the reported n cannot overstate it.
    aggregatedResponseCount: usable.length,
    abstainCount: current.filter((r) => r.abstained === 1).length,
    invalidCount: current.filter((r) => r.is_valid === 0).length,
    legacyElicitationCount: rows.length - current.length
  }
}

function meanDistribution(rows: ProfileRow[], optionCount: number): number[] {
  const totals = new Array<number>(optionCount).fill(0)
  let counted = 0
  for (const row of rows) {
    if (!row.parsed_distribution_json) continue
    const parsed = JSON.parse(row.parsed_distribution_json) as Record<string, number>
    for (const [index, value] of Object.entries(parsed)) {
      const i = Number(index)
      if (Number.isInteger(i) && i >= 0 && i < optionCount) totals[i] = totals[i]! + value
    }
    counted++
  }
  return counted === 0 ? totals : totals.map((t) => t / counted)
}

/**
 * Position preference. `permutation_json` holds the rotation: entry i is the
 * ORIGINAL option index shown at position i, so the position of the chosen
 * option is where its original index sits in that array.
 */
function positionBias(rows: ProfileRow[]): ProfileMetrics['priorBias'] {
  const picks: { position: number; optionCount: number }[] = []
  for (const row of rows) {
    if (row.is_valid === 0 || row.abstained === 1 || row.parsed_answer === null) continue
    // Only a single-choice cell has ONE chosen option, and therefore one
    // position. A multi-select answer is a set — including the empty set, which
    // is written as '' and whose Number('') is 0: read as a choice it would
    // silently become "picked whatever sat first".
    if (elicitationModeFor(row.scale_type_current) !== 'single_choice') continue
    if (row.parsed_answer === '' || row.parsed_answer.includes(',')) continue
    const rotation = JSON.parse(row.permutation_json) as number[]
    const position = rotation.indexOf(Number(row.parsed_answer))
    if (position < 0) continue
    picks.push({ position, optionCount: rotation.length })
  }
  // Only questions with the SAME number of options are comparable: a 4-option
  // question can never put an answer in position 5, so mixing lengths would
  // depress the later positions and invent a first-position bias that is really
  // just the shape of the questionnaire.
  const byLength = new Map<number, number>()
  for (const pick of picks) byLength.set(pick.optionCount, (byLength.get(pick.optionCount) ?? 0) + 1)
  const modal = [...byLength.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]
  if (!modal) return { byPosition: [], maxDeviation: null, strongestPosition: null, optionCount: null }

  const [optionCount, total] = modal
  const counts = new Array<number>(optionCount).fill(0)
  for (const pick of picks) {
    if (pick.optionCount === optionCount) counts[pick.position] = counts[pick.position]! + 1
  }
  const byPosition = counts.map((c) => c / total)
  const uniform = 1 / optionCount
  const deviations = byPosition.map((share) => share - uniform)
  const maxDeviation = Math.max(...deviations)
  return {
    byPosition,
    maxDeviation,
    strongestPosition: deviations.indexOf(maxDeviation),
    optionCount
  }
}

/**
 * Mean position of the default answer on directed scales, centred on the scale
 * midpoint. Computed from the whole distribution rather than the top choice, so
 * a model spread between "eléggé" and "teljesen" is not rounded to one of them.
 *
 * The questions are weighted EQUALLY, not by option count: a 2-point item can
 * only ever return ±0.5 while a 5-point item's realistic swing is smaller, so a
 * probe mixing scale lengths lets the short items dominate. That is a property
 * of the probe design, and the model card reports the per-question values so it
 * stays visible instead of hiding inside one averaged number.
 */
function positivityOffset(byQuestion: Map<string, ProfileRow[]>): number | null {
  const DIRECTED = new Set(['ordinal', 'frequency'])
  const perQuestion: number[] = []
  for (const rows of byQuestion.values()) {
    const first = rows[0]!
    if (!DIRECTED.has(first.scale_type)) continue
    const options = JSON.parse(first.options_json) as string[]
    if (options.length < 2) continue
    const usable = rows.filter((r) => matchesCurrentMode(r) && r.is_valid === 1 && r.abstained === 0)
    if (usable.length === 0) continue
    const distribution = meanDistribution(usable, options.length)
    const mass = distribution.reduce((a, b) => a + b, 0)
    if (mass <= 0) continue
    const expected = distribution.reduce((sum, p, i) => {
      const normalized = i / (options.length - 1)
      // 'descending' means option 0 is the POSITIVE pole, so the axis flips.
      return sum + (p / mass) * (first.scale_direction === 'descending' ? 1 - normalized : normalized)
    }, 0)
    perQuestion.push(expected - 0.5)
  }
  if (perQuestion.length === 0) return null
  return perQuestion.reduce((a, b) => a + b, 0) / perQuestion.length
}

/**
 * Run-level metric with CI (issue #47, M4a). Parallel to `ProfileMetrics`'s
 * scalars, never a replacement for them (see the #47 comment thread): those
 * existing point-value fields keep their type unchanged, so `summarize()`
 * (src/model-profiles.ts:349) and public/model-card.js keep reading a plain
 * number from `ProfileMetrics`, unaware anything changed. This structure is
 * only ever stored ALONGSIDE those fields, never in place of them.
 */
export interface MetricWithCI {
  perRun: { runId: string; value: number }[]
  pointEstimate: number | null
  ci: { low: number; high: number } | null
  ciUnavailableReason: string | null
  /** Runs (from the completed set) where THIS metric specifically could not be computed. */
  excludedRunIds: string[]
}

export interface RepeatedProfileMetrics {
  schemaVersion: 2
  /** Completed runs actually used. */
  runCount: number
  /** Runs dropped because they were not `completed`. */
  excludedRunIds: string[]
  positivityOffset: MetricWithCI
  priorBiasMaxDeviation: MetricWithCI
  invalidRate: MetricWithCI
  abstainRate: MetricWithCI
}

/**
 * The repeated-run counterpart to `computeProfileMetrics`: the RUN is the
 * sampling unit (spec: "A mintavételi egység a FUTÁS"), so each of the four
 * `ProfileMetrics` scalars in scope for M4a — priorBias.maxDeviation,
 * positivityOffset, invalidRate, abstainRate — is computed ONCE PER RUN by
 * delegating to `computeProfileMetrics` scoped to that single run (reusing
 * its already-tested per-question/per-cell logic instead of duplicating it),
 * then bootstrapped ACROSS runs with the question set held fixed. The point
 * estimate is the MEAN of those N per-run values — a different number than
 * the pooled, cell-count-weighted value `computeProfileMetrics(db, runIds)`
 * reports whenever runs carry unequal response counts.
 *
 * Only `completed` runs count: a partial run breaks the balanced-rotation
 * invariant `priorBias` depends on, and would skew every other metric with
 * incomplete question coverage too. A completed run that nonetheless produced
 * zero usable persona-free cells cannot support `invalidRate`/`abstainRate`
 * either — without the explicit check below they would silently read back as
 * `0` from `computeProfileMetrics`'s own empty-input default, repeating the
 * exact #40 confusion ("could not measure" read as "measured, and it's zero")
 * this milestone exists to close.
 *
 * Deduplicates a repeated run id (code-review MEDIUM): the same id listed
 * twice is the exact same run, not a second independent measurement — the
 * existing pooled `computeProfileMetrics` already tolerates this for free (an
 * SQL `IN (...)` cannot match a row twice), so a duplicate here is treated the
 * same tolerant way rather than rejected, keeping the two functions'
 * contracts consistent for the same input.
 *
 * Every array on the result — `perRun`/`excludedRunIds` on each metric, and
 * the top-level `excludedRunIds` — is sorted into a CANONICAL (by runId)
 * order rather than kept in the caller's original order (code-review HIGH):
 * the whole point of seeding the bootstrap from the SORTED run ids is that
 * `run_ids_json` being re-serialized in a different order (a query plan
 * change, a migration, a manual re-store) must never change a stored
 * profile's reported result. That guarantee only holds end-to-end if every
 * order-sensitive array the caller can observe is also order-independent.
 */
export function computeRepeatedProfileMetrics(db: Db, runIds: readonly string[]): RepeatedProfileMetrics {
  const uniqueRunIds = [...new Set(runIds)]
  const { completedRunIds, excludedRunIds } = partitionByCompletedStatus(db, uniqueRunIds)
  const sortedCompletedRunIds = [...completedRunIds].sort()
  const perRun = sortedCompletedRunIds.map((runId) => ({ runId, metrics: computeProfileMetrics(db, [runId]) }))
  const seedBase = sortedCompletedRunIds.join(',')

  return {
    schemaVersion: 2,
    runCount: sortedCompletedRunIds.length,
    excludedRunIds: [...excludedRunIds].sort(),
    positivityOffset: metricWithCI(perRun, seedBase, 'positivityOffset', (m) => m.positivityOffset),
    priorBiasMaxDeviation: metricWithCI(perRun, seedBase, 'priorBiasMaxDeviation', (m) => m.priorBias.maxDeviation),
    invalidRate: metricWithCI(
      perRun, seedBase, 'invalidRate', (m) => (m.provenance.cellCount === 0 ? null : m.invalidRate)
    ),
    abstainRate: metricWithCI(
      perRun, seedBase, 'abstainRate', (m) => (m.provenance.cellCount === 0 ? null : m.abstainRate)
    )
  }
}

function metricWithCI(
  perRun: { runId: string; metrics: ProfileMetrics }[],
  seedBase: string,
  metricName: string,
  extract: (metrics: ProfileMetrics) => number | null
): MetricWithCI {
  const usable: { runId: string; value: number }[] = []
  const excludedRunIds: string[] = []
  // `perRun` is already canonically (runId-)sorted by the caller, so both
  // arrays built by iterating it stay in that same canonical order.
  for (const { runId, metrics } of perRun) {
    const value = extract(metrics)
    if (value === null) excludedRunIds.push(runId)
    else usable.push({ runId, value })
  }
  const { pointEstimate, ci, ciUnavailableReason } = percentileBootstrapCI(
    usable.map((u) => u.value),
    `${seedBase}|${metricName}`,
    500
  )
  return { perRun: usable, pointEstimate, ci, ciUnavailableReason, excludedRunIds }
}

/** Only a `completed` run satisfies the balanced-rotation invariant these metrics assume. */
function partitionByCompletedStatus(
  db: Db,
  runIds: readonly string[]
): { completedRunIds: string[]; excludedRunIds: string[] } {
  if (runIds.length === 0) return { completedRunIds: [], excludedRunIds: [] }
  const rows = db
    .prepare(`SELECT id, status FROM runs WHERE id IN (${runIds.map(() => '?').join(',')})`)
    .all(...runIds) as unknown as { id: string; status: string }[]
  const statusById = new Map(rows.map((r) => [r.id, r.status]))
  const completedRunIds: string[] = []
  const excludedRunIds: string[] = []
  for (const runId of runIds) {
    if (statusById.get(runId) === 'completed') completedRunIds.push(runId)
    else excludedRunIds.push(runId)
  }
  return { completedRunIds, excludedRunIds }
}
