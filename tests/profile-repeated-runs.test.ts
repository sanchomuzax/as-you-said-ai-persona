import { describe, it, expect, beforeEach } from 'vitest'
import { createDb, type Db } from '../src/db.js'
import { latestProfileFor } from '../src/model-profiles.js'
import * as profileModule from '../src/lib/profile.js'

/**
 * Issue #47 (M4a) — "ismétléses eloszlás és páros bootstrap CI a
 * modell-profilokra". Preregistered contract (the issue body IS the spec):
 * the sampling unit is the RUN, not the response/cell; the question set is
 * held fixed and only the runs are resampled; N < 3 gives `ci: null` with a
 * stated reason, never a zero-width interval; the bootstrap seed is
 * deterministic; only `completed` runs count; a metric that a specific run
 * cannot support is excluded FROM THAT METRIC ONLY, and the exclusion is
 * counted; and `metrics_json` gets a `schemaVersion` while old, field-less
 * records stay readable.
 *
 * `computeRepeatedProfileMetrics` does not exist on `src/lib/profile.ts` yet
 * — TDD for a milestone that has no implementation. It is reached through a
 * cast on the module namespace (see `tests/bootstrap-ci.test.ts` for the same
 * pattern and its rationale) so `tsc --noEmit` stays clean while every call
 * below fails at RUNTIME, which is the honest signal for "not built".
 *
 * The exact TypeScript shape below (function name, field names) is this
 * agent's own reading of the prose spec — the issue does not fix an
 * interface. See the final report for this flagged explicitly.
 */

interface MetricWithCI {
  perRun: { runId: string; value: number }[]
  pointEstimate: number | null
  ci: { low: number; high: number } | null
  ciUnavailableReason: string | null
  /** Runs (from the completed set) where THIS metric specifically could not be computed. */
  excludedRunIds: string[]
}

interface RepeatedProfileMetrics {
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

type ComputeRepeatedProfileMetrics = (db: Db, runIds: readonly string[]) => RepeatedProfileMetrics

const lib = profileModule as unknown as { computeRepeatedProfileMetrics: ComputeRepeatedProfileMetrics }

function compute(db: Db, runIds: string[]): RepeatedProfileMetrics {
  return lib.computeRepeatedProfileMetrics(db, runIds)
}

let db: Db
let respSeq = 0

beforeEach(() => {
  db = createDb(':memory:')
  respSeq = 0
  db.prepare('INSERT INTO questionnaires (id, lineage_id, name) VALUES (?,?,?)').run('probe', 'probe', 'Próba')
  // 4-option directed (ordinal) question, used by the positivityOffset fixtures.
  db.prepare(
    'INSERT INTO questions (id, questionnaire_id, ord, text, scale_type, options_json, scale_direction) VALUES (?,?,?,?,?,?,?)'
  ).run(
    'q1', 'probe', 0, 'Mennyire ért egyet?', 'ordinal',
    JSON.stringify(['Egyáltalán', 'Kicsit', 'Eléggé', 'Teljesen']), 'ascending'
  )
})

function insertRun(runId: string, status = 'completed'): void {
  db.prepare('INSERT INTO runs (id, questionnaire_id, name, config_json, status) VALUES (?,?,?,?,?)').run(
    runId, 'probe', `Kalibráció ${runId}`,
    JSON.stringify({ model: 'm1', temperature: 1, seeds: [0], baselineArm: true }), status
  )
}

function insertResponse(opts: {
  runId: string
  questionId: string
  optionCount: number
  seed: number
  answer: string
  isValid?: number
  abstained?: number
}): void {
  const distribution: Record<string, number> = {}
  for (let i = 0; i < opts.optionCount; i++) distribution[String(i)] = 0
  if (opts.answer !== '') distribution[opts.answer] = 1
  const rotation = JSON.stringify(Array.from({ length: opts.optionCount }, (_, i) => i))
  db.prepare(
    `INSERT INTO responses (id, run_id, persona_id, question_id, condition, model_requested, model_version,
       provider, temperature, seed, permutation_json, prompt_rendered, raw_response,
       parsed_distribution_json, parsed_answer, elicitation_mode, is_valid, abstained,
       prompt_tokens, completion_tokens, cost_usd)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    `resp-${respSeq++}`, opts.runId, null, opts.questionId, 'baseline', 'm1', 'm1-2026-05', 'DeepInfra', 1, opts.seed,
    rotation, 'prompt', 'raw', JSON.stringify(distribution), opts.answer, 'single_choice',
    opts.isValid ?? 1, opts.abstained ?? 0, 10, 5, 0.001
  )
}

/**
 * `count` responses to q1 (4 options), all picking the same `optionIndex` —
 * gives the run a KNOWN, exact positivityOffset:
 *   normalized = optionIndex / 3;  offset = normalized - 0.5
 * optionIndex 3 -> +0.5, 0 -> -0.5, 2 -> 2/3-0.5 = 1/6, 1 -> 1/3-0.5 = -1/6
 */
function seedUniformQ1Answers(runId: string, optionIndex: number, count: number): void {
  for (let seed = 0; seed < count; seed++) {
    insertResponse({ runId, questionId: 'q1', optionCount: 4, seed, answer: String(optionIndex) })
  }
}

describe('computeRepeatedProfileMetrics (issue #47, M4a)', () => {
  // --- 1. The RUN is the sampling unit: pooled ≠ mean-of-per-run-values ----
  it('reports the mean of PER-RUN values, not the value of the pooled cells (which differ here on purpose)', () => {
    insertRun('run-a')
    insertRun('run-b')
    insertRun('run-c')
    seedUniformQ1Answers('run-a', 3, 4) // offset +0.5,  weight 4
    seedUniformQ1Answers('run-b', 0, 4) // offset -0.5,  weight 4
    seedUniformQ1Answers('run-c', 2, 12) // offset +1/6, weight 12

    const result = compute(db, ['run-a', 'run-b', 'run-c'])

    // Per-run values must be exactly the three constants above.
    const byRun = new Map(result.positivityOffset.perRun.map((r) => [r.runId, r.value]))
    expect(byRun.get('run-a')).toBeCloseTo(0.5, 10)
    expect(byRun.get('run-b')).toBeCloseTo(-0.5, 10)
    expect(byRun.get('run-c')).toBeCloseTo(1 / 6, 10)

    // Mean of the three per-run values: (0.5 - 0.5 + 1/6) / 3 = (1/6)/3 = 1/18.
    const expectedPerRunMean = (0.5 - 0.5 + 1 / 6) / 3
    expect(expectedPerRunMean).toBeCloseTo(0.055556, 5)
    expect(result.positivityOffset.pointEstimate).toBeCloseTo(expectedPerRunMean, 5)

    // The POOLED value (today's `computeProfileMetrics` behaviour, weighting
    // by cell count) is a DIFFERENT number: 20 cells total, distribution
    // [4/20, 0, 12/20, 4/20] = [0.2, 0, 0.6, 0.2], weighted normalized index
    // = 0*0.2 + (1/3)*0 + (2/3)*0.6 + 1*0.2 = 0.4 + 0.2 = 0.6, offset = 0.1.
    // A "just add a CI on top of the pooled number" implementation would
    // report 0.1 here, not ~0.0556 — this assertion is what tells the two
    // apart.
    expect(result.positivityOffset.pointEstimate).not.toBeCloseTo(0.1, 2)
  })

  // --- 2. Fixed question set, runs resampled: exact, hand-derivable CI -----
  it('holds the question set FIXED across resamples: three runs with an identical per-run invalidRate collapse to a zero-width CI', () => {
    // Two extra categorical questions alongside q1, so each run answers the
    // SAME three-question set.
    db.prepare(
      'INSERT INTO questions (id, questionnaire_id, ord, text, scale_type, options_json, scale_direction) VALUES (?,?,?,?,?,?,?)'
    ).run('q2', 'probe', 1, 'Q2?', 'categorical', JSON.stringify(['Igen', 'Nem']), 'ascending')
    db.prepare(
      'INSERT INTO questions (id, questionnaire_id, ord, text, scale_type, options_json, scale_direction) VALUES (?,?,?,?,?,?,?)'
    ).run('q3', 'probe', 2, 'Q3?', 'categorical', JSON.stringify(['Igen', 'Nem']), 'ascending')

    insertRun('run-a')
    insertRun('run-b')
    insertRun('run-c')

    // Every run: 4 responses to each of q1, q2, q3 (12 total), with exactly 3
    // invalid responses concentrated in a DIFFERENT question per run — so
    // invalidRate = 3/12 = 0.25 for EVERY run, exactly, even though WHICH
    // question carries the invalid answers differs run to run.
    const invalidQuestionByRun: Record<string, string> = { 'run-a': 'q1', 'run-b': 'q2', 'run-c': 'q3' }
    for (const runId of ['run-a', 'run-b', 'run-c']) {
      for (const questionId of ['q1', 'q2', 'q3']) {
        const optionCount = questionId === 'q1' ? 4 : 2
        for (let seed = 0; seed < 4; seed++) {
          const isInvalidSlot = questionId === invalidQuestionByRun[runId] && seed < 3
          insertResponse({
            runId, questionId, optionCount, seed, answer: '0',
            isValid: isInvalidSlot ? 0 : 1
          })
        }
      }
    }

    const result = compute(db, ['run-a', 'run-b', 'run-c'])

    // Every one of the three (identical, per-run, whole-question-set) values
    // is exactly 0.25 — so ANY resample of 3 draws (with replacement) from
    // {0.25, 0.25, 0.25} averages to exactly 0.25. A bootstrap that instead
    // resampled individual CELLS (36 total, 9 invalid, real between-cell
    // sampling variance) would NOT collapse to a point — this is what
    // distinguishes "resample runs, hold the question set fixed" from an
    // implementation that accidentally resamples cells/questions.
    for (const value of result.invalidRate.perRun.map((r) => r.value)) expect(value).toBeCloseTo(0.25, 10)
    expect(result.invalidRate.perRun).toHaveLength(3)
    expect(result.invalidRate.pointEstimate).toBeCloseTo(0.25, 10)
    expect(result.invalidRate.ci).not.toBeNull()
    expect(result.invalidRate.ci!.low).toBeCloseTo(0.25, 10)
    expect(result.invalidRate.ci!.high).toBeCloseTo(0.25, 10)
  })

  // --- 3. N < 3 -> ci null, WITH a reason, never a zero-width interval -----
  it('gives no CI from a single run (N=1) — the point estimate is still that one run\'s value', () => {
    insertRun('run-a')
    seedUniformQ1Answers('run-a', 3, 4) // offset +0.5

    const result = compute(db, ['run-a'])

    expect(result.positivityOffset.pointEstimate).toBeCloseTo(0.5, 10)
    expect(result.positivityOffset.ci).toBeNull()
    expect(result.positivityOffset.ciUnavailableReason).toBeTruthy()
    expect(result.positivityOffset.ciUnavailableReason).toMatch(/1/)
  })

  it('gives no CI from two runs (N=2) — the point estimate is the mean of the two', () => {
    insertRun('run-a')
    insertRun('run-b')
    seedUniformQ1Answers('run-a', 3, 4) // +0.5
    seedUniformQ1Answers('run-b', 0, 4) // -0.5

    const result = compute(db, ['run-a', 'run-b'])

    expect(result.positivityOffset.pointEstimate).toBeCloseTo(0, 10)
    expect(result.positivityOffset.ci).toBeNull()
    expect(result.positivityOffset.ciUnavailableReason).toBeTruthy()
    expect(result.positivityOffset.ciUnavailableReason).toMatch(/2/)
  })

  // --- 4. Determinism -------------------------------------------------------
  it('is deterministic: computing twice from the same runs gives a bit-identical result', () => {
    insertRun('run-a')
    insertRun('run-b')
    insertRun('run-c')
    seedUniformQ1Answers('run-a', 3, 4)
    seedUniformQ1Answers('run-b', 0, 4)
    seedUniformQ1Answers('run-c', 2, 4)

    const first = compute(db, ['run-a', 'run-b', 'run-c'])
    const second = compute(db, ['run-a', 'run-b', 'run-c'])

    expect(second).toEqual(first)
  })

  // --- 4b. Order-independence (code-review HIGH against the implementation) -
  // The bootstrap seed is deliberately built from the SORTED run ids (spec:
  // "a profil-kulcsból és a metrika nevéből", made order-proof on purpose) so
  // that re-serializing `run_ids_json` in a different order can never change
  // a stored profile's CI. That guarantee is broken if the run-level VALUES
  // handed to the bootstrap keep the caller's original (unsorted) order,
  // because `percentileBootstrapCI` indexes into that array with the seeded
  // draws — same seed, differently-ordered array, different replicate
  // sequence. Five runs, five DISTINCT positivityOffset values (so a swapped
  // pair is not accidentally masked by two runs sharing a value), computed in
  // two different input orders. The whole result — CI, point estimates,
  // `perRun`, and `excludedRunIds` on every metric — must be identical:
  // `perRun`/`excludedRunIds` order must be CANONICAL (not "whatever order
  // the caller happened to list runs in"), or this same `toEqual` would also
  // catch two runs merely being listed in a different order in the arrays.
  it('is order-independent: the full result is identical regardless of the order runIds are passed in', () => {
    insertRun('run-1')
    insertRun('run-2')
    insertRun('run-3')
    insertRun('run-4') // all q1 answers invalid -> excluded from positivityOffset only
    insertRun('run-5', 'running') // not completed -> excluded from the whole profile
    seedUniformQ1Answers('run-1', 3, 4) // offset +0.5
    seedUniformQ1Answers('run-2', 0, 4) // offset -0.5
    seedUniformQ1Answers('run-3', 2, 4) // offset +1/6
    for (let seed = 0; seed < 4; seed++) {
      insertResponse({ runId: 'run-4', questionId: 'q1', optionCount: 4, seed, answer: '0', isValid: 0 })
    }
    seedUniformQ1Answers('run-5', 1, 4)

    const inOrder = compute(db, ['run-1', 'run-2', 'run-3', 'run-4', 'run-5'])
    const shuffled = compute(db, ['run-5', 'run-3', 'run-1', 'run-4', 'run-2'])

    expect(shuffled).toEqual(inOrder)
  })

  // --- 4c. Duplicate run id: dedup, not double-counted -----------------------
  // If the same run id is listed twice, today it is counted TWICE — inflating
  // N and pulling the bootstrap toward that one run's value, with no signal
  // anywhere that anything unusual happened (code-review MEDIUM). A
  // duplicated id is not a second independent measurement: it is the exact
  // same run, so counting it twice violates the independence the whole
  // methodology rests on ("A mintavételi egység a FUTÁS... a futás a
  // legkisebb egység, amiről a függetlenség hihetően állítható") even more
  // directly than the cell-level pooling bug M4a itself was written to fix.
  // `computeProfileMetrics` (the existing, already-shipped pooling function)
  // already dedupes a repeated id for free, as a side effect of SQL's `IN
  // (...)` semantics — a repeated id does not make a row match twice. This
  // test requires `computeRepeatedProfileMetrics` to behave the SAME way:
  // silent deduplication, not silent inflation. (A loud rejection would also
  // close the bug, but would be a new, asymmetric contract next to the
  // pooling function's existing tolerant behaviour — see the report for the
  // reasoning; this test encodes the dedup choice.)
  it('deduplicates a repeated run id instead of counting it twice', () => {
    insertRun('run-a')
    insertRun('run-b')
    insertRun('run-c')
    seedUniformQ1Answers('run-a', 3, 4) // offset +0.5
    seedUniformQ1Answers('run-b', 0, 4) // offset -0.5
    seedUniformQ1Answers('run-c', 2, 4) // offset +1/6

    const baseline = compute(db, ['run-a', 'run-b', 'run-c'])
    const withDuplicate = compute(db, ['run-a', 'run-a', 'run-b', 'run-c'])

    expect(withDuplicate).toEqual(baseline)
    expect(withDuplicate.runCount).toBe(3)
    expect(withDuplicate.positivityOffset.perRun).toHaveLength(3)
  })

  // --- 5. CI contract: point estimate inside, range respected, asymmetric --
  it('places the point estimate inside the CI, keeps the CI within the metric\'s own range, and is asymmetric for a skewed run set', () => {
    insertRun('run-a')
    insertRun('run-b')
    insertRun('run-c')
    insertRun('run-d')
    insertRun('run-e')
    // Four runs cluster at offset -1/6 (optionIndex 1), one sits far above at +0.5 (optionIndex 3).
    seedUniformQ1Answers('run-a', 1, 4)
    seedUniformQ1Answers('run-b', 1, 4)
    seedUniformQ1Answers('run-c', 1, 4)
    seedUniformQ1Answers('run-d', 1, 4)
    seedUniformQ1Answers('run-e', 3, 4)

    const result = compute(db, ['run-a', 'run-b', 'run-c', 'run-d', 'run-e'])

    // Point estimate: (4*(-1/6) + 0.5) / 5 = (-2/3 + 1/2) / 5 = (-1/6) / 5 = -1/30.
    const expected = (4 * (-1 / 6) + 0.5) / 5
    expect(expected).toBeCloseTo(-0.033333, 5)
    expect(result.positivityOffset.pointEstimate).toBeCloseTo(expected, 5)

    expect(result.positivityOffset.ci).not.toBeNull()
    const { low, high } = result.positivityOffset.ci!
    // Inside the interval.
    expect(low).toBeLessThanOrEqual(result.positivityOffset.pointEstimate!)
    expect(high).toBeGreaterThanOrEqual(result.positivityOffset.pointEstimate!)
    // Within positivityOffset's own domain, [-0.5, 0.5].
    expect(low).toBeGreaterThanOrEqual(-0.5)
    expect(high).toBeLessThanOrEqual(0.5)
    // Right-skewed input (four low, one far-above outlier) -> the upper
    // margin from the point estimate must exceed the lower one — same
    // reasoning as the equivalent case in tests/bootstrap-ci.test.ts.
    const upperMargin = high - result.positivityOffset.pointEstimate!
    const lowerMargin = result.positivityOffset.pointEstimate! - low
    expect(upperMargin).toBeGreaterThan(lowerMargin)
  })

  // --- 6. Only `completed` runs count --------------------------------------
  it.each(['running', 'budget_exhausted', 'stopped'])(
    'excludes a %s run entirely — the result is identical to computing without it',
    (status) => {
      insertRun('run-a')
      insertRun('run-b')
      insertRun('run-c')
      seedUniformQ1Answers('run-a', 3, 4)
      seedUniformQ1Answers('run-b', 0, 4)
      seedUniformQ1Answers('run-c', 2, 4)

      insertRun('run-unfinished', status)
      // Wildly different answers: if this run leaked in, the numbers below would change.
      seedUniformQ1Answers('run-unfinished', 0, 40)

      const withExtra = compute(db, ['run-a', 'run-b', 'run-c', 'run-unfinished'])
      const withoutExtra = compute(db, ['run-a', 'run-b', 'run-c'])

      expect(withExtra.positivityOffset).toEqual(withoutExtra.positivityOffset)
      expect(withExtra.runCount).toBe(3)
      expect(withExtra.excludedRunIds).toContain('run-unfinished')
    }
  )

  // --- 7. Metric-specific exclusion, counted -------------------------------
  it('excludes a run from ONE metric only when that metric could not be computed for it, and counts the exclusion', () => {
    insertRun('run-p')
    insertRun('run-q')
    insertRun('run-r')
    insertRun('run-s')
    seedUniformQ1Answers('run-p', 3, 4) // +0.5
    seedUniformQ1Answers('run-q', 0, 4) // -0.5
    seedUniformQ1Answers('run-r', 2, 4) // +1/6

    // run-s: every q1 answer is INVALID -> positivityOffset cannot be
    // computed for it (mirrors the single-run `computeProfileMetrics`
    // behaviour: no usable rows -> null) — but invalidRate certainly CAN
    // still be computed (it is 100% invalid, a real number).
    for (let seed = 0; seed < 4; seed++) {
      insertResponse({ runId: 'run-s', questionId: 'q1', optionCount: 4, seed, answer: '0', isValid: 0 })
    }

    const result = compute(db, ['run-p', 'run-q', 'run-r', 'run-s'])

    expect(result.positivityOffset.excludedRunIds).toEqual(['run-s'])
    expect(result.positivityOffset.perRun.map((r) => r.runId).sort()).toEqual(['run-p', 'run-q', 'run-r'])
    // 3 usable runs remain -> a CI IS computable for this metric.
    expect(result.positivityOffset.ci).not.toBeNull()

    // invalidRate is unaffected: all four runs contribute a real value.
    expect(result.invalidRate.excludedRunIds).toEqual([])
    expect(result.invalidRate.perRun).toHaveLength(4)
    const runS = result.invalidRate.perRun.find((r) => r.runId === 'run-s')
    expect(runS?.value).toBeCloseTo(1, 10)
  })

  // --- 8. schemaVersion, and backward compatibility for old records --------
  it('stamps freshly computed metrics with schemaVersion 2', () => {
    insertRun('run-a')
    insertRun('run-b')
    insertRun('run-c')
    seedUniformQ1Answers('run-a', 3, 4)
    seedUniformQ1Answers('run-b', 0, 4)
    seedUniformQ1Answers('run-c', 2, 4)

    const result = compute(db, ['run-a', 'run-b', 'run-c'])
    expect(result.schemaVersion).toBe(2)
  })

  it('round-trips a schemaVersion:2 record through model_profiles.metrics_json unchanged', () => {
    insertRun('run-a')
    insertRun('run-b')
    insertRun('run-c')
    seedUniformQ1Answers('run-a', 3, 4)
    seedUniformQ1Answers('run-b', 0, 4)
    seedUniformQ1Answers('run-c', 2, 4)
    const computed = compute(db, ['run-a', 'run-b', 'run-c'])

    db.prepare(
      `INSERT INTO model_profiles (id, model_requested, model_version, provider, prompt_template_hash,
         probe_questionnaire_id, language, run_ids_json, metrics_json, valid_until)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).run(
      'profile-v2', 'm1', 'm1-2026-05', 'DeepInfra', 'hash1', 'probe', 'hu',
      JSON.stringify(['run-a', 'run-b', 'run-c']), JSON.stringify(computed), '2099-01-01 00:00:00'
    )

    const stored = latestProfileFor(db, 'm1')
    expect(stored).not.toBeNull()
    const metrics = stored!.metrics as unknown as RepeatedProfileMetrics
    expect(metrics.schemaVersion).toBe(2)
    expect(metrics.positivityOffset.pointEstimate).toBeCloseTo(computed.positivityOffset.pointEstimate!, 10)
  })

  // The hard back-compat requirement from #17 M3 (src/model-profiles.ts:307):
  // `profile.metrics` may be a PARTIAL/OLD-shaped object and reading it must
  // never throw. A field-less (pre-M4a) record must keep opening — no
  // migration, no recomputation required for it to be readable — and its
  // absence of `schemaVersion` is how a reader is meant to recognise it as
  // the old (v1, point-value, no-CI) shape.
  it('keeps an old, schemaVersion-less profile record fully readable, unmigrated', () => {
    const oldStyleMetrics = {
      perQuestion: [],
      priorBias: { byPosition: [], maxDeviation: null, strongestPosition: null, optionCount: null },
      positivityOffset: 0.42,
      invalidRate: 0.1,
      abstainRate: 0.05,
      provenance: {
        runIds: ['legacy-run'], cellCount: 8, duplicateCellCount: 0, costUsd: 0.01,
        firstResponseAt: null, lastResponseAt: null
      }
      // deliberately no `schemaVersion` field — this is what every profile
      // written before #47 looks like.
    }
    db.prepare(
      `INSERT INTO model_profiles (id, model_requested, model_version, provider, prompt_template_hash,
         probe_questionnaire_id, language, run_ids_json, metrics_json, valid_until)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).run(
      'profile-v1', 'm2', 'm2-2026-01', 'DeepInfra', 'hash1', 'probe', 'hu',
      JSON.stringify(['legacy-run']), JSON.stringify(oldStyleMetrics), '2099-01-01 00:00:00'
    )

    expect(() => latestProfileFor(db, 'm2')).not.toThrow()
    const stored = latestProfileFor(db, 'm2')
    expect(stored).not.toBeNull()
    // Old numeric fields are unchanged — "változatlan pontértékkel" from the
    // issue's acceptance section.
    expect((stored!.metrics as unknown as { positivityOffset: number }).positivityOffset).toBe(0.42)
    // No schemaVersion present -> reads as version 1 by absence, not by a
    // migration having stamped it.
    expect('schemaVersion' in (stored!.metrics as object)).toBe(false)
  })
})
