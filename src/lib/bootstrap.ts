import { createHash } from 'node:crypto'

/**
 * Percentile bootstrap over an already-computed set of run-level metric
 * values (issue #47, M4a). Deterministic: the seed comes from `seedKey`
 * (spec: "a rendezett runIds és a metrika nevének stabil hasheléséből"), not
 * from wall-clock time, so the same input always reproduces the same CI — the
 * number stays auditable across two openings of the same profile.
 *
 * N < 3 (the #40 lesson, repeated): with fewer than 3 values there is nothing
 * to resample from, and any interval — however narrow — would claim more
 * certainty than exists. `ci` is `null` WITH a stated reason instead, so
 * "could not measure" is never mistaken for "measured, and it's zero-width".
 */
export interface BootstrapResult {
  /** Mean of the input values — same formula the bootstrap replicates use. */
  pointEstimate: number | null
  ci: { low: number; high: number } | null
  /** Non-null exactly when `ci` is null: the CI is missing, never silent. */
  ciUnavailableReason: string | null
}

const BOOTSTRAP_MIN_VALUES = 3

/**
 * The resampling itself must be blind to the CALLER's ordering of `values`
 * (code-review HIGH): the seed is built from a sorted key precisely so a
 * profile's CI cannot change if `run_ids_json` is ever re-serialized in a
 * different order, but that guarantee only holds if indexing into `values`
 * with the seeded draws is itself order-independent. A sorted COPY (numeric,
 * ascending) is resampled instead of the caller's array — sorting only
 * reorders which index holds which value, never the multiset drawn from, so
 * `pointEstimate` (already order-independent, a plain sum) is unaffected and
 * the replicate distribution becomes reproducible regardless of input order.
 */
export function percentileBootstrapCI(
  values: readonly number[],
  seedKey: string,
  replicates = 500
): BootstrapResult {
  const n = values.length
  if (n < BOOTSTRAP_MIN_VALUES) {
    return {
      pointEstimate: n === 0 ? null : mean(values),
      ci: null,
      ciUnavailableReason:
        `Túl kevés futás a megbízhatósági intervallumhoz (${n} futás, legalább ${BOOTSTRAP_MIN_VALUES} kell).`
    }
  }
  const sorted = [...values].sort((a, b) => a - b)
  const draw = seededDraw(seedKey)
  const replicateMeans = new Array<number>(replicates)
  for (let r = 0; r < replicates; r++) {
    let sum = 0
    for (let i = 0; i < n; i++) sum += sorted[Math.floor(draw() * n)]!
    replicateMeans[r] = sum / n
  }
  replicateMeans.sort((a, b) => a - b)
  return {
    pointEstimate: mean(values),
    ci: { low: percentileOf(replicateMeans, 0.025), high: percentileOf(replicateMeans, 0.975) },
    ciUnavailableReason: null
  }
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length
}

/** Linear-interpolation percentile (numpy's default "linear" method) of an ascending-sorted array. */
function percentileOf(sortedAsc: readonly number[], p: number): number {
  if (sortedAsc.length === 1) return sortedAsc[0]!
  const rank = p * (sortedAsc.length - 1)
  const lower = Math.floor(rank)
  const upper = Math.ceil(rank)
  if (lower === upper) return sortedAsc[lower]!
  const weight = rank - lower
  return sortedAsc[lower]! * (1 - weight) + sortedAsc[upper]! * weight
}

/**
 * Seeded PRNG (mulberry32), keyed off a stable hash of `seedKey` instead of
 * `Date.now()` — the whole point of a deterministic bootstrap. Returns a
 * `() => number` in [0, 1), matching `Math.random()`'s contract so it can
 * drive index draws the same way.
 */
function seededDraw(seedKey: string): () => number {
  let state = createHash('sha256').update(seedKey).digest().readUInt32BE(0)
  return (): number => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
