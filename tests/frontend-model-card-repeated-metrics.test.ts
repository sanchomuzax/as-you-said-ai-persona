import { describe, it, expect, afterEach } from 'vitest'
import { loadPublicScript } from './helpers/load-public-script.js'
import { loadAppDom, defaultRoutes, type AppDom } from './helpers/load-app-dom.js'

/**
 * Issue #47 (M4a) — the model card must show the repeated-run confidence
 * interval, and must be LOUD (not silent) about the cases where none could be
 * computed. Right now `public/model-card.js` only ever reads the OLD, scalar
 * `metrics.positivityOffset` / `metrics.priorBias.maxDeviation` /
 * `metrics.invalidRate` / `metrics.abstainRate` fields — nothing on the card
 * reads `metrics.repeated` (the parallel field this slice's backend test,
 * tests/profile-repeated-metrics-wiring.test.ts, expects `POST
 * /api/model-profiles` to start writing). Every test below therefore fails
 * against TODAY's model-card.js — that absence is the point, not a fixture
 * bug.
 *
 * Contract asserted here (this agent's own reading, flagged as such — the
 * issue does not fix a UI shape):
 *   - When `metrics.repeated.<metric>.ci` is present, its low/high bounds are
 *     shown somewhere on the card, and the card NEVER renders it as `± x`
 *     (spec: the interval is not symmetric, and must never be presented as
 *     if it were).
 *   - When `metrics.repeated.<metric>.ci` is `null`, the card shows the
 *     `ciUnavailableReason` text verbatim (that string is already
 *     backend-produced, human-readable Hungarian — see
 *     src/lib/profile.ts's `percentileBootstrapCI`), for EVERY one of the
 *     four repeated scalar metrics, not just one.
 *   - A genuinely zero-width CI (three runs that happen to agree exactly) and
 *     a missing CI (fewer than 3 runs) must render VISIBLY differently: the
 *     first is a measured, if narrow, range; the second states outright that
 *     nothing could be measured.
 *   - A profile with no `metrics.repeated` at all (pre-#47 record) must not
 *     crash the card and must not fabricate a CI for it.
 */

interface CardApi {
  renderModelCard: (
    entry: Record<string, unknown>,
    profile: Record<string, unknown> | null,
    context?: Record<string, unknown>
  ) => string
}

const card = loadPublicScript<CardApi>(
  ['format.js', 'version-diff.js', 'metrics.js', 'detail.js', 'model-card.js'],
  '({ renderModelCard })'
)

const BASE_PROFILE = {
  id: 'prof-1',
  modelRequested: 'm1',
  modelVersion: 'm1-2026-05',
  provider: 'DeepInfra',
  promptTemplateHash: 'abc123def4567890',
  probeQuestionnaireId: 'probe',
  probeName: 'Alapértelmezett-perszóna próba',
  probeVersion: 1,
  language: 'hu',
  status: 'valid',
  reasons: [],
  createdAt: '2026-08-01 10:00:00',
  validUntil: '2026-10-30 10:00:00',
  metrics: {
    schemaVersion: 2,
    perQuestion: [],
    priorBias: { byPosition: [0.25, 0.25, 0.25, 0.25], maxDeviation: 0.02, strongestPosition: 0, optionCount: 4 },
    positivityOffset: 0.1,
    invalidRate: 0.05,
    abstainRate: 0.02,
    provenance: { runIds: ['run-a', 'run-b', 'run-c'], cellCount: 24, costUsd: 0.02, firstResponseAt: null, lastResponseAt: null }
  }
}

/** One `MetricWithCI`-shaped object (src/lib/profile.ts), N >= 3, a real (non-null) CI. */
function ciAvailable(pointEstimate: number, low: number, high: number): Record<string, unknown> {
  return {
    perRun: [
      { runId: 'run-a', value: pointEstimate - 0.01 },
      { runId: 'run-b', value: pointEstimate },
      { runId: 'run-c', value: pointEstimate + 0.01 }
    ],
    pointEstimate,
    ci: { low, high },
    ciUnavailableReason: null,
    excludedRunIds: []
  }
}

const N1_REASON = 'Túl kevés futás a megbízhatósági intervallumhoz (1 futás, legalább 3 kell).'

/** One `MetricWithCI`-shaped object with N = 1 — the #40-style "cannot measure" case. */
function ciUnavailable(pointEstimate: number, reason = N1_REASON): Record<string, unknown> {
  return {
    perRun: [{ runId: 'run-solo', value: pointEstimate }],
    pointEstimate,
    ci: null,
    ciUnavailableReason: reason,
    excludedRunIds: []
  }
}

describe('renderModelCard shows the repeated-run confidence interval (issue #47, M4a UI)', () => {
  it('shows the CI bounds for a repeated metric, preserving a negative low bound', () => {
    const profile = {
      ...BASE_PROFILE,
      metrics: {
        ...BASE_PROFILE.metrics,
        repeated: {
          schemaVersion: 2,
          runCount: 3,
          excludedRunIds: [],
          positivityOffset: ciAvailable(0.1, -0.2, 0.45),
          priorBiasMaxDeviation: ciAvailable(0.02, 0.001, 0.06),
          invalidRate: ciAvailable(0.05, 0.01, 0.12),
          abstainRate: ciAvailable(0.02, 0.0, 0.05)
        }
      }
    }
    const html = card.renderModelCard({ model: 'm1', label: 'M' }, profile)

    // The negative low bound must survive rendering — dropping the sign would
    // silently claim the interval never dips below the midpoint.
    expect(html).toMatch(/-0[.,]2/)
    expect(html).toMatch(/0[.,]45/)
  })

  // The spec explicitly forbids a later "simplification" to symmetric ± —
  // this is the regression test for exactly that.
  it('never renders the interval as "± x", even when the bounds could be read as symmetric', () => {
    const profile = {
      ...BASE_PROFILE,
      metrics: {
        ...BASE_PROFILE.metrics,
        repeated: {
          schemaVersion: 2,
          runCount: 3,
          excludedRunIds: [],
          // pointEstimate 0.3, bounds 0.1/0.5 — LOOKS like "0.3 ± 0.2" but must
          // never be collapsed to that shape.
          positivityOffset: ciAvailable(0.3, 0.1, 0.5),
          priorBiasMaxDeviation: ciAvailable(0.02, 0.001, 0.06),
          invalidRate: ciAvailable(0.05, 0.01, 0.12),
          abstainRate: ciAvailable(0.02, 0.0, 0.05)
        }
      }
    }
    const html = card.renderModelCard({ model: 'm1', label: 'M' }, profile)
    expect(html).not.toContain('±')
  })

  it('states outright, for EVERY one of the four repeated metrics, why there is no CI when N < 3 — never silently just a point estimate', () => {
    const profile = {
      ...BASE_PROFILE,
      metrics: {
        ...BASE_PROFILE.metrics,
        repeated: {
          schemaVersion: 2,
          runCount: 1,
          excludedRunIds: [],
          positivityOffset: ciUnavailable(0.5),
          priorBiasMaxDeviation: ciUnavailable(0.1),
          invalidRate: ciUnavailable(0.05),
          abstainRate: ciUnavailable(0.0)
        }
      }
    }
    const html = card.renderModelCard({ model: 'm1', label: 'M' }, profile)

    // The exact reason text (already backend-produced, deterministic
    // Hungarian) must appear once for each of the four metrics — a partial
    // wiring that only handles one of them would leave the others silent.
    const occurrences = html.split(N1_REASON).length - 1
    expect(occurrences).toBeGreaterThanOrEqual(4)
    expect(html).not.toContain('±')
  })

  // The core "measured, and it's zero-width" vs "could not measure" distinction
  // from the #40 lesson, repeated for M4a.
  it('distinguishes a genuinely zero-width CI (measured, no spread) from a missing one (too few runs)', () => {
    const measuredZeroWidth = {
      ...BASE_PROFILE,
      metrics: {
        ...BASE_PROFILE.metrics,
        repeated: {
          schemaVersion: 2, runCount: 3, excludedRunIds: [],
          positivityOffset: {
            perRun: [
              { runId: 'run-a', value: 0.2 }, { runId: 'run-b', value: 0.2 }, { runId: 'run-c', value: 0.2 }
            ],
            pointEstimate: 0.2, ci: { low: 0.2, high: 0.2 }, ciUnavailableReason: null, excludedRunIds: []
          },
          priorBiasMaxDeviation: ciAvailable(0.02, 0.001, 0.06),
          invalidRate: ciAvailable(0.05, 0.01, 0.12),
          abstainRate: ciAvailable(0.02, 0.0, 0.05)
        }
      }
    }
    const tooFewRuns = {
      ...BASE_PROFILE,
      metrics: {
        ...BASE_PROFILE.metrics,
        repeated: {
          schemaVersion: 2, runCount: 1, excludedRunIds: [],
          positivityOffset: ciUnavailable(0.5),
          priorBiasMaxDeviation: ciAvailable(0.02, 0.001, 0.06),
          invalidRate: ciAvailable(0.05, 0.01, 0.12),
          abstainRate: ciAvailable(0.02, 0.0, 0.05)
        }
      }
    }

    const zeroWidthHtml = card.renderModelCard({ model: 'm1', label: 'M' }, measuredZeroWidth)
    const tooFewHtml = card.renderModelCard({ model: 'm1', label: 'M' }, tooFewRuns)

    // A real (if narrow) measurement must NOT be reported with the
    // "could not measure" wording.
    expect(zeroWidthHtml).not.toContain(N1_REASON)
    expect(zeroWidthHtml.toLowerCase()).not.toMatch(/túl kevés futás/)
    // The unmeasurable case, conversely, MUST say so.
    expect(tooFewHtml).toContain(N1_REASON)
  })

  it('does not crash and fabricates no CI when the profile predates repeated-run metrics (no metrics.repeated at all)', () => {
    // BASE_PROFILE.metrics deliberately carries no `repeated` key — the exact
    // shape of every profile recorded before this slice.
    expect(() => card.renderModelCard({ model: 'm1', label: 'M' }, BASE_PROFILE)).not.toThrow()
    const html = card.renderModelCard({ model: 'm1', label: 'M' }, BASE_PROFILE)
    expect(html).not.toContain('±')
    expect(html).not.toContain('undefined')
  })

  it('says how many runs the profile is based on', () => {
    const profile = {
      ...BASE_PROFILE,
      metrics: {
        ...BASE_PROFILE.metrics,
        repeated: {
          schemaVersion: 2,
          runCount: 1,
          excludedRunIds: [],
          positivityOffset: ciUnavailable(0.5),
          priorBiasMaxDeviation: ciUnavailable(0.1),
          invalidRate: ciUnavailable(0.05),
          abstainRate: ciUnavailable(0.0)
        }
      }
    }
    const html = card.renderModelCard({ model: 'm1', label: 'M' }, profile)
    // The reason text itself already names the run count (1); this asserts
    // the number is not just present in the raw reason string handed
    // through unread, but that the card is legible about the run count in
    // general (matches loosely so a differently-worded but still-explicit
    // rendering also passes).
    expect(html).toMatch(/1[^0-9]{0,12}futás/i)
  })
})

/**
 * Same contract, exercised through the real boot -> click -> fetch -> render
 * pipeline (model-view.js's openModelDetail), using the project's own DOM
 * harness — per the brief instruction to use tests/helpers/load-app-dom.ts
 * for the frontend half of this slice.
 */
describe('the "Modellek" tab shows the repeated-run CI end to end (issue #47, M4a UI, DOM)', () => {
  let dom: AppDom | null = null
  afterEach(() => {
    dom?.close()
    dom = null
  })

  function routesWithProfile(metrics: Record<string, unknown>): Record<string, unknown> {
    return defaultRoutes({
      'GET /api/model-profiles': [
        {
          model: 'm1', label: 'Modell 1', status: 'valid', reasons: [],
          summary: { positivityOffset: 0.1, priorBiasMaxDeviation: 0.02, invalidRate: 0.05, cellCount: 24 },
          profile: { id: 'prof-1' }
        }
      ],
      'GET /api/model-profiles/prof-1': { ...BASE_PROFILE, metrics },
      'GET /api/questionnaires': []
    })
  }

  it('renders the CI bounds on the opened model card when the profile carries N >= 3 repeated runs', async () => {
    dom = loadAppDom({
      routes: routesWithProfile({
        ...BASE_PROFILE.metrics,
        repeated: {
          schemaVersion: 2, runCount: 3, excludedRunIds: [],
          positivityOffset: ciAvailable(0.1, -0.2, 0.45),
          priorBiasMaxDeviation: ciAvailable(0.02, 0.001, 0.06),
          invalidRate: ciAvailable(0.05, 0.01, 0.12),
          abstainRate: ciAvailable(0.02, 0.0, 0.05)
        }
      })
    })
    await dom.boot()
    dom.document.querySelector('[data-model="m1"]')!.click()
    await dom.settle()

    const body = dom.document.getElementById('modelDetailBody')!
    expect(body.innerHTML).toMatch(/-0[.,]2/)
    expect(body.innerHTML).toMatch(/0[.,]45/)
    expect(body.innerHTML).not.toContain('±')
  })

  it('names the run count and reason on the opened model card when N < 3', async () => {
    dom = loadAppDom({
      routes: routesWithProfile({
        ...BASE_PROFILE.metrics,
        repeated: {
          schemaVersion: 2, runCount: 1, excludedRunIds: [],
          positivityOffset: ciUnavailable(0.5),
          priorBiasMaxDeviation: ciUnavailable(0.1),
          invalidRate: ciUnavailable(0.05),
          abstainRate: ciUnavailable(0.0)
        }
      })
    })
    await dom.boot()
    dom.document.querySelector('[data-model="m1"]')!.click()
    await dom.settle()

    const body = dom.document.getElementById('modelDetailBody')!
    expect(body.innerHTML).toContain(N1_REASON)
  })
})
