import { describe, it, expect } from 'vitest'
import * as profileModule from '../src/lib/profile.js'

/**
 * Issue #47 (M4a) — the percentile-bootstrap CI over RUN-level metric values,
 * tested in isolation from the database. `percentileBootstrapCI` does not
 * exist yet on `src/lib/profile.ts` (nor does the file it might end up living
 * in) — it is accessed here through a cast on the MODULE NAMESPACE, exactly
 * the "cast instead of referencing a not-yet-existing field/export" pattern
 * this project already uses elsewhere (e.g. `dom.window as unknown as {...}`
 * in the frontend DOM tests) so that `tsc --noEmit` stays clean: the import
 * path `../src/lib/profile.js` is real, only the member access is cast. Every
 * test below therefore fails at RUNTIME ("... is not a function"), which is
 * the honest failure for "not implemented" — not a fixture bug.
 */

interface BootstrapResult {
  /** Mean of the input values — same formula the bootstrap replicates use. */
  pointEstimate: number | null
  ci: { low: number; high: number } | null
  /** Non-null exactly when `ci` is null: the CI is missing, never silent. */
  ciUnavailableReason: string | null
}

type PercentileBootstrapCI = (values: readonly number[], seedKey: string, replicates?: number) => BootstrapResult

const lib = profileModule as unknown as { percentileBootstrapCI: PercentileBootstrapCI }

function bootstrap(values: number[], seedKey: string): BootstrapResult {
  return lib.percentileBootstrapCI(values, seedKey, 500)
}

describe('percentileBootstrapCI (issue #47, M4a) — resampling contract', () => {
  // #40 was paid for exactly this confusion: a metric that could not be
  // measured came back as 0, and every reader mistook that for "measured,
  // and the value is zero". A CI is the same trap in a different shape: with
  // fewer than 3 runs there is nothing to resample from, and a 0-width or
  // otherwise invented interval would silently claim more certainty than
  // exists. `ci` must be `null`, WITH a stated reason — never a fabricated
  // interval, however narrow.
  it('refuses a CI from a single value (N=1) and says why', () => {
    const result = bootstrap([0.5], 'seed-n1')
    expect(result.ci).toBeNull()
    expect(result.pointEstimate).toBe(0.5) // the mean of one run is still reportable
    expect(typeof result.ciUnavailableReason).toBe('string')
    expect(result.ciUnavailableReason!.length).toBeGreaterThan(0)
    // The reason must speak to the ACTUAL count (1), and to what unit is
    // short — the project's own vocabulary for the sampling unit is "futás"
    // (run), used throughout the spec ("A mintavételi egység a FUTÁS").
    expect(result.ciUnavailableReason).toMatch(/1/)
    expect(result.ciUnavailableReason).toMatch(/futás/i)
  })

  it('refuses a CI from two values (N=2) and says why — a DIFFERENT reason text than N=1', () => {
    const result = bootstrap([0.2, 0.8], 'seed-n2')
    expect(result.ci).toBeNull()
    expect(result.pointEstimate).toBeCloseTo(0.5, 10)
    expect(result.ciUnavailableReason).toMatch(/2/)
    expect(result.ciUnavailableReason).toMatch(/futás/i)
    // Must actually mention 2, not just reuse the N=1 sentence — two draws
    // bouncing between two points is a DIFFERENT failure mode.
    expect(bootstrap([0.5], 'seed-n1').ciUnavailableReason).not.toBe(result.ciUnavailableReason)
  })

  it('never fabricates a zero-width CI merely because there was little data (N=0 too)', () => {
    const result = bootstrap([], 'seed-n0')
    expect(result.ci).toBeNull()
    expect(result.pointEstimate).toBeNull() // nothing to average
    expect(result.ciUnavailableReason).toBeTruthy()
  })

  // The seed must come from a stable key (spec: "a profil-kulcsból és a
  // metrika nevéből", never `Date.now()`), so the SAME input run twice must
  // give a BIT-IDENTICAL result — otherwise the number "changes" between two
  // openings of the same profile and the CI is not auditable.
  it('is deterministic: the same values and seed key produce a bit-identical CI on a second call', () => {
    const values = [0.12, 0.55, 0.31, 0.9, 0.05]
    const first = bootstrap(values, 'profile-key|positivityOffset')
    const second = bootstrap(values, 'profile-key|positivityOffset')
    expect(second).toEqual(first)
  })

  // Point estimate = mean of the raw values, and the spec requires it to sit
  // INSIDE the interval (same formula applied to the bootstrap replicates).
  // With 5 spread-out values and 500 replicates, a genuinely varying
  // bootstrap distribution has virtually no chance of collapsing its 2.5th
  // and 97.5th percentiles to the same point — low < high is the ordinary
  // case, not a coincidence being asserted.
  it('places the point estimate strictly inside a non-degenerate CI', () => {
    const values = [0.2, 0.4, 0.6, 0.8, 1.0]
    const result = bootstrap(values, 'seed-inside')
    const mean = values.reduce((a, b) => a + b, 0) / values.length // 0.6
    expect(result.pointEstimate).toBeCloseTo(mean, 10)
    expect(result.ci).not.toBeNull()
    expect(result.ci!.low).toBeLessThan(result.ci!.high)
    expect(result.ci!.low).toBeLessThanOrEqual(result.pointEstimate!)
    expect(result.ci!.high).toBeGreaterThanOrEqual(result.pointEstimate!)
  })

  // The CI must stay within the VALUES' own range: a percentile bootstrap of
  // a mean is a convex combination of the input values, so it mathematically
  // cannot leave [min(values), max(values)] — but a wrong implementation
  // (e.g. a normal-approximation mean ± 1.96·SE interval) COULD. This is the
  // concrete stand-in for "arány esetén [0,1]" from the spec: values drawn
  // from a bounded metric domain (here proportions near the domain edges).
  it('keeps the CI within the domain of a proportion-like metric near the lower edge', () => {
    const result = bootstrap([0.02, 0.05, 0.08], 'seed-lower-edge')
    expect(result.ci).not.toBeNull()
    expect(result.ci!.low).toBeGreaterThanOrEqual(0)
    expect(result.ci!.high).toBeLessThanOrEqual(1)
  })

  it('keeps the CI within the domain of a proportion-like metric near the upper edge', () => {
    const result = bootstrap([0.92, 0.95, 0.99], 'seed-upper-edge')
    expect(result.ci).not.toBeNull()
    expect(result.ci!.low).toBeGreaterThanOrEqual(0)
    expect(result.ci!.high).toBeLessThanOrEqual(1)
  })

  // Skewed input must produce a skewed (asymmetric) CI — the spec explicitly
  // forbids a later "simplification" to symmetric mean ± half-width. Four
  // runs cluster low (0.10–0.13), one sits far above (0.95).
  //   pointEstimate = (0.10+0.11+0.12+0.13+0.95) / 5 = 1.41/5 = 0.282
  // A resample of 5 draws (with replacement) from these 5 values excludes the
  // 0.95 outlier entirely with probability (4/5)^5 ≈ 32.8%, and draws it
  // exactly once with probability 5·0.2·0.8^4 ≈ 41.0% — together ~74% of the
  // resampled means sit AT OR BELOW the low cluster (~0.10–0.14), while only
  // the shrinking tail (one, two, ... occurrences of the outlier) reaches
  // means above 0.28. That piles mass just below the point estimate and
  // stretches a long, thin tail above it: the upper margin (97.5th
  // percentile out to the point estimate) must be wider than the lower one.
  it('produces a right-skewed, asymmetric CI when the input is right-skewed', () => {
    const values = [0.1, 0.11, 0.12, 0.13, 0.95]
    const result = bootstrap(values, 'seed-skew')
    const mean = values.reduce((a, b) => a + b, 0) / values.length
    expect(result.pointEstimate).toBeCloseTo(mean, 10)
    expect(result.ci).not.toBeNull()
    const lowerMargin = result.pointEstimate! - result.ci!.low
    const upperMargin = result.ci!.high - result.pointEstimate!
    expect(upperMargin).toBeGreaterThan(lowerMargin)
  })

  // Code-review regression (HIGH, found against the M4a implementation): the
  // seed is built from the SORTED run ids precisely so a profile's CI cannot
  // silently change if `run_ids_json` is ever re-serialized in a different
  // order (a query plan change, a migration, a manual re-store). That
  // guarantee only holds if the RESAMPLING ITSELF is blind to the order of
  // `values` — a PRNG seeded from a sorted key but then indexing into an
  // unsorted `values` array still produces an order-dependent result, which
  // is exactly what an empirical before/after diff on the real implementation
  // showed (same 5 values, same seed key, reordered only: CI moved from
  // {-0.2333, 0.3667} to {-0.2333, 0.4333}). The fix belongs in
  // `percentileBootstrapCI` itself — a caller cannot compensate for it by
  // sorting values it does not know are supposed to be sorted.
  it('is order-independent: the same multiset of values, differently ordered, with the same seed key, gives the SAME CI', () => {
    const seedKey = 'order-independence|positivityOffset'
    const inOrder = bootstrap([0.12, 0.55, 0.31, 0.9, 0.05], seedKey)
    const shuffled = bootstrap([0.9, 0.05, 0.55, 0.12, 0.31], seedKey)
    expect(shuffled).toEqual(inOrder)
  })
})
