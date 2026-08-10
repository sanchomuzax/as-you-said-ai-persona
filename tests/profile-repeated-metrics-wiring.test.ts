import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { createDb, type Db } from '../src/db.js'
import { buildServer } from '../src/server.js'
import { computeProfileMetrics } from '../src/lib/profile.js'
import type { ChatClient, ChatResult } from '../src/openrouter.js'
import type { AppConfig } from '../src/config.js'

/**
 * Issue #47 (M4a) — WIRING gap. `percentileBootstrapCI` and
 * `computeRepeatedProfileMetrics` exist on `src/lib/profile.ts` (green,
 * covered by tests/bootstrap-ci.test.ts and tests/profile-repeated-runs.test.ts)
 * but NOTHING calls them yet: `POST /api/model-profiles` (src/model-profiles.ts,
 * ~line 515) only ever calls `computeProfileMetrics`. So a researcher who
 * finishes three calibration runs and records a profile still sees no
 * repeated-run distribution, no N, no confidence interval anywhere — the
 * project's own hard rule ("tilos 'kész'-nek jelenteni bármit, amit a
 * felhasználó a saját felületén nem lát") is violated by the current state.
 *
 * Every test below exercises `POST /api/model-profiles` with MULTIPLE
 * completed runs and asserts on what `GET /api/model-profiles` (list) and
 * `GET /api/model-profiles/:id` (card) come back with. They currently FAIL
 * because the repeated data is simply absent — that absence, not a fixture
 * bug, is the point of this file.
 *
 * Contract this file assumes (this agent's own reading — nothing in the #47
 * issue or in the already-green files fixes the wiring shape, only the pure
 * functions' own signatures):
 *   - `metrics_json`'s existing scalar fields (positivityOffset,
 *     priorBias.maxDeviation, invalidRate, abstainRate, perQuestion,
 *     provenance, probeInterpretability) stay EXACTLY as they are today —
 *     same keys, same plain-number/array/object types, same values as
 *     `computeProfileMetrics` alone would produce. This is the regression
 *     surface: `summarize()` (src/model-profiles.ts:346) reads
 *     `metrics?.positivityOffset` etc. as a bare number, and
 *     `public/model-card.js` (lines ~115, ~459) renders it directly with
 *     `formatSigned`/`calibrationValue` — an object there would silently
 *     break both without a type error anywhere.
 *   - The repeated-run data lives in a NEW, PARALLEL field on the same
 *     `metrics_json` object: `metrics.repeated` (this agent's naming),
 *     holding exactly the `computeRepeatedProfileMetrics(db, runIds)` return
 *     value (schemaVersion 2, runCount, excludedRunIds, and one MetricWithCI
 *     per scalar: positivityOffset, priorBiasMaxDeviation, invalidRate,
 *     abstainRate).
 *   - The freshly written `metrics_json` object itself gets a top-level
 *     `schemaVersion: 2` marker (spec wording: "az új rekord kapjon
 *     schemaVersion: 2-t") — old rows have no such key at all, which is how a
 *     reader tells the two shapes apart without a migration.
 *   - A profile written before this wiring (no `schemaVersion`, no
 *     `repeated`) must keep opening and keep reporting its old point values
 *     unchanged — no migration, no recomputation required.
 * If the real implementation instead nests the parallel data under a
 * different key name, only the assertions that hard-code `metrics.repeated`
 * need renaming; everything else in this file (numbers, unchanged scalar
 * shape, schemaVersion presence/absence, summarize()-path regression) still
 * has to hold under any field-name choice.
 */

const testConfig: AppConfig = {
  OPENROUTER_API_KEY: 'test-key',
  OPENROUTER_BASE_URL: 'https://openrouter.ai/api/v1',
  AUTH_USERNAME: 'admin',
  AUTH_PASSWORD: 'test-password-123',
  SESSION_SECRET: 'test-secret-at-least-16-chars',
  TOKEN_BUDGET_GLOBAL: 1_000_000,
  TOKEN_BUDGET_PER_RUN: 100_000,
  PORT: 0,
  DATABASE_PATH: ':memory:'
}

const testModels = {
  default: 'm1',
  models: [{ id: 'm1', label: 'Modell 1' }]
}

class StubClient implements ChatClient {
  async complete(model: string): Promise<ChatResult> {
    return {
      content: '{"A": 0.2, "B": 0.8}', modelVersion: `${model}-2026-05`, promptTokens: 10,
      completionTokens: 5, cachedTokens: 0, cacheDiscountUsd: 0, provider: 'DeepInfra',
      costUsd: 0.001, requestId: 'r1', latencyMs: 5
    }
  }
}

let app: FastifyInstance
let db: Db
let cookie: { asys_session: string }

async function login(): Promise<{ asys_session: string }> {
  const res = await app.inject({
    method: 'POST', url: '/api/login', payload: { username: 'admin', password: 'test-password-123' }
  })
  return { asys_session: /asys_session=([^;]+)/.exec(res.headers['set-cookie'] as string)![1]! }
}

/** Same 4-option directed (ordinal) probe question used throughout the M4a tests. */
function ensureProbeQuestionnaire(): void {
  if (db.prepare('SELECT id FROM questionnaires WHERE id = ?').get('probe')) return
  db.prepare('INSERT INTO questionnaires (id, lineage_id, name) VALUES (?,?,?)').run(
    'probe', 'probe', 'Alapértelmezett-perszóna próba'
  )
  db.prepare(
    'INSERT INTO questions (id, questionnaire_id, ord, text, scale_type, options_json, scale_direction) VALUES (?,?,?,?,?,?,?)'
  ).run('q1', 'probe', 0, 'Mennyire ért egyet?', 'ordinal', JSON.stringify(['Egyáltalán', 'Kicsit', 'Eléggé', 'Teljesen']), 'ascending')
}

/**
 * A finished calibration run whose every q1 response picks `optionIndex` —
 * gives the run a known, exact positivityOffset: `optionIndex/3 - 0.5`.
 * Mirrors profile-repeated-runs.test.ts's seedUniformQ1Answers, but through
 * the real HTTP-visible `runs`/`responses` rows POST /api/model-profiles reads.
 */
function seedCalibrationRun(
  runId: string,
  optionIndex: number,
  { model = 'm1', version = 'm1-2026-05', provider = 'DeepInfra' as string | null, seeds = [0, 1, 2, 3] } = {}
): void {
  ensureProbeQuestionnaire()
  db.prepare('INSERT INTO runs (id, questionnaire_id, name, config_json, status) VALUES (?,?,?,?,?)').run(
    runId, 'probe', `Kalibráció — ${model} — ${runId}`,
    JSON.stringify({ model, temperature: 1, seeds, baselineArm: true }), 'completed'
  )
  let n = 0
  for (const seed of seeds) {
    const distribution: Record<string, number> = { '0': 0, '1': 0, '2': 0, '3': 0 }
    distribution[String(optionIndex)] = 1
    db.prepare(
      `INSERT INTO responses (id, run_id, persona_id, question_id, condition, model_requested, model_version,
         provider, temperature, seed, permutation_json, prompt_rendered, raw_response,
         parsed_distribution_json, parsed_answer, elicitation_mode, is_valid, abstained, cost_usd)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      `${runId}-${n++}`, runId, null, 'q1', 'baseline', model, version, provider, 1, seed,
      '[0,1,2,3]', 'prompt', 'raw', JSON.stringify(distribution), String(optionIndex),
      'single_choice', 1, 0, 0.001
    )
  }
}

async function createProfile(runIds: string[], model = 'm1'): Promise<{ id: string; body: Record<string, unknown> }> {
  const res = await app.inject({
    method: 'POST', url: '/api/model-profiles', cookies: cookie, payload: { model, runIds }
  })
  expect(res.statusCode, JSON.stringify(res.json())).toBe(200)
  return { id: res.json().data.id as string, body: res.json() }
}

async function getProfile(id: string): Promise<Record<string, unknown>> {
  const res = await app.inject({ method: 'GET', url: `/api/model-profiles/${id}`, cookies: cookie })
  expect(res.statusCode).toBe(200)
  return res.json().data as Record<string, unknown>
}

async function listProfiles(): Promise<{ model: string; summary: Record<string, unknown> | null }[]> {
  const res = await app.inject({ method: 'GET', url: '/api/model-profiles', cookies: cookie })
  return res.json().data as { model: string; summary: Record<string, unknown> | null }[]
}

beforeEach(async () => {
  db = createDb(':memory:')
  app = buildServer({ db, config: testConfig, models: testModels, client: new StubClient() })
  await app.ready()
  cookie = await login()
})

afterEach(() => app.close())

describe('POST /api/model-profiles wires up repeated-run metrics (issue #47, M4a bekötés)', () => {
  it('stamps a freshly recorded profile with schemaVersion 2 and a parallel repeated field', async () => {
    seedCalibrationRun('run-a', 3) // offset +0.5
    seedCalibrationRun('run-b', 0) // offset -0.5
    seedCalibrationRun('run-c', 2) // offset +1/6

    const { id } = await createProfile(['run-a', 'run-b', 'run-c'])
    const profile = await getProfile(id)
    const metrics = profile['metrics'] as Record<string, unknown>

    expect(metrics['schemaVersion']).toBe(2)
    expect(metrics['repeated']).toBeTruthy()
  })

  it('reports the three runs individually, with the SAME per-run values computeRepeatedProfileMetrics gives standalone', async () => {
    seedCalibrationRun('run-a', 3) // +0.5
    seedCalibrationRun('run-b', 0) // -0.5
    seedCalibrationRun('run-c', 2) // +1/6

    const { id } = await createProfile(['run-a', 'run-b', 'run-c'])
    const profile = await getProfile(id)
    const repeated = (profile['metrics'] as Record<string, unknown>)['repeated'] as {
      runCount: number
      positivityOffset: {
        perRun: { runId: string; value: number }[]
        pointEstimate: number | null
        ci: { low: number; high: number } | null
        ciUnavailableReason: string | null
      }
    }

    expect(repeated.runCount).toBe(3)
    const byRun = new Map(repeated.positivityOffset.perRun.map((r) => [r.runId, r.value]))
    expect(byRun.get('run-a')).toBeCloseTo(0.5, 10)
    expect(byRun.get('run-b')).toBeCloseTo(-0.5, 10)
    expect(byRun.get('run-c')).toBeCloseTo(1 / 6, 10)

    // Mean of per-run values, NOT the pooled/cell-weighted number — same
    // distinguishing check as tests/profile-repeated-runs.test.ts.
    const expectedPerRunMean = (0.5 - 0.5 + 1 / 6) / 3
    expect(repeated.positivityOffset.pointEstimate).toBeCloseTo(expectedPerRunMean, 5)
    expect(repeated.positivityOffset.ci).not.toBeNull()
  })

  it('gives N=1 a null CI with a stated reason naming the run count — never a fabricated interval', async () => {
    seedCalibrationRun('run-solo', 3)

    const { id } = await createProfile(['run-solo'])
    const profile = await getProfile(id)
    const repeated = (profile['metrics'] as Record<string, unknown>)['repeated'] as {
      runCount: number
      positivityOffset: { pointEstimate: number | null; ci: unknown; ciUnavailableReason: string | null }
    }

    expect(repeated.runCount).toBe(1)
    expect(repeated.positivityOffset.pointEstimate).toBeCloseTo(0.5, 10)
    expect(repeated.positivityOffset.ci).toBeNull()
    expect(repeated.positivityOffset.ciUnavailableReason).toBeTruthy()
    expect(repeated.positivityOffset.ciUnavailableReason).toMatch(/1/)
    expect(repeated.positivityOffset.ciUnavailableReason).toMatch(/futás/i)
  })

  // --- Audit-trail consistency: the stored run list must match what was
  //     actually measured, even when the caller sent a duplicate -----------
  // Closing review finding (not a HIGH, but an audit-trail contradiction):
  // `POST /api/model-profiles` writes the RAW `body.data.runIds` into
  // `run_ids_json` (src/model-profiles.ts), while `metrics.repeated` is
  // computed from the DEDUPLICATED set (`computeRepeatedProfileMetrics`,
  // fixed per the earlier code-review MEDIUM in tests/profile-repeated-runs.test.ts).
  // A duplicated id in the request therefore produces two disagreeing audit
  // trails on the SAME profile: `repeated.runCount` says the measurement used
  // 3 runs, but `GET /api/model-profiles/:id`'s `runIds` field lists 4, one of
  // them twice. Storage must follow measurement: the persisted `runIds` is
  // what the numbers were actually computed from, so it must be deduplicated
  // exactly like `repeated` already is. The assertion is the EQUALITY between
  // the two, not a specific array — this still passes however the dedup is
  // implemented (Set, sort+dedup, a different storage strategy entirely).
  it('stores a deduplicated runIds list when the request repeats a run id — matching repeated.runCount', async () => {
    seedCalibrationRun('run-a', 3) // +0.5
    seedCalibrationRun('run-b', 0) // -0.5
    seedCalibrationRun('run-c', 2) // +1/6

    const { id } = await createProfile(['run-a', 'run-a', 'run-b', 'run-c'])
    const profile = await getProfile(id)
    const runIds = profile['runIds'] as string[]
    const repeated = (profile['metrics'] as Record<string, unknown>)['repeated'] as { runCount: number }

    // No duplicates left in the stored/returned audit trail.
    expect(new Set(runIds).size).toBe(runIds.length)
    // The two audit trails on the same profile must agree on how many runs
    // the measurement is based on.
    expect(runIds.length).toBe(repeated.runCount)
  })

  // --- The regression this whole slice exists to guard against -----------
  describe('the pre-existing scalar fields survive the wiring UNCHANGED (regression risk)', () => {
    it('metrics.positivityOffset stays a plain number, equal to computeProfileMetrics\'s own pooled value', async () => {
      seedCalibrationRun('run-a', 3)
      seedCalibrationRun('run-b', 0)
      seedCalibrationRun('run-c', 2)

      const { id } = await createProfile(['run-a', 'run-b', 'run-c'])
      const profile = await getProfile(id)
      const metrics = profile['metrics'] as Record<string, unknown>

      const independentlyPooled = computeProfileMetrics(db, ['run-a', 'run-b', 'run-c'])

      expect(typeof metrics['positivityOffset']).toBe('number')
      expect(metrics['positivityOffset']).toBeCloseTo(independentlyPooled.positivityOffset!, 10)
      expect(typeof (metrics['priorBias'] as { maxDeviation: unknown }).maxDeviation).toBe('number')
      expect(typeof metrics['invalidRate']).toBe('number')
      expect(typeof metrics['abstainRate']).toBe('number')
    })

    // The exact regression named in the brief: summarize() (src/model-profiles.ts)
    // reads metrics?.positivityOffset as a bare number for GET /api/model-profiles's
    // list `summary` field, and public/model-card.js renders that same shape
    // directly. Both must keep seeing a number, not an object, after the wiring.
    it('GET /api/model-profiles\'s summary.positivityOffset is unchanged: a plain number equal to the pre-repeated value', async () => {
      seedCalibrationRun('run-a', 3)
      seedCalibrationRun('run-b', 0)
      seedCalibrationRun('run-c', 2)

      const independentlyPooled = computeProfileMetrics(db, ['run-a', 'run-b', 'run-c'])
      await createProfile(['run-a', 'run-b', 'run-c'])
      const rows = await listProfiles()
      const m1 = rows.find((r) => r.model === 'm1')!

      expect(typeof m1.summary!['positivityOffset']).toBe('number')
      expect(m1.summary!['positivityOffset']).toBeCloseTo(independentlyPooled.positivityOffset!, 10)
      expect(typeof m1.summary!['priorBiasMaxDeviation']).toBe('number')
      expect(typeof m1.summary!['invalidRate']).toBe('number')
      expect(typeof m1.summary!['cellCount']).toBe('number')
    })

    it('a single-run profile (N=1, repeated present but CI null) still summarizes to the same plain number as before', async () => {
      seedCalibrationRun('run-solo', 3)
      const independentlyPooled = computeProfileMetrics(db, ['run-solo'])
      await createProfile(['run-solo'])
      const rows = await listProfiles()
      const m1 = rows.find((r) => r.model === 'm1')!

      expect(typeof m1.summary!['positivityOffset']).toBe('number')
      expect(m1.summary!['positivityOffset']).toBeCloseTo(independentlyPooled.positivityOffset!, 10)
    })
  })

  // --- Old profiles must open exactly as before, with no migration --------
  describe('a profile recorded before this wiring stays fully readable, unmigrated (issue #47 acceptance)', () => {
    async function insertLegacyProfile(model = 'm1'): Promise<string> {
      ensureProbeQuestionnaire()
      const legacyMetrics = {
        perQuestion: [],
        priorBias: { byPosition: [], maxDeviation: 0.05, strongestPosition: 0, optionCount: 4 },
        positivityOffset: 0.317,
        invalidRate: 0.02,
        abstainRate: 0.01,
        provenance: {
          runIds: ['legacy-run'], cellCount: 16, duplicateCellCount: 0, costUsd: 0.02,
          firstResponseAt: '2026-01-01 00:00:00', lastResponseAt: '2026-01-01 01:00:00'
        }
        // no `schemaVersion`, no `repeated` — exactly what every profile
        // written before #47 looks like on disk.
      }
      db.prepare(
        `INSERT INTO model_profiles
           (id, model_requested, model_version, provider, prompt_template_hash,
            probe_questionnaire_id, language, run_ids_json, metrics_json, valid_until)
         VALUES (?,?,?,?,?,?,?,?,?,?)`
      ).run(
        'legacy-profile', model, `${model}-2026-01`, 'DeepInfra', 'legacyhash0000000',
        'probe', 'hu', JSON.stringify(['legacy-run']), JSON.stringify(legacyMetrics), '2099-01-01 00:00:00'
      )
      return 'legacy-profile'
    }

    it('GET /api/model-profiles/:id does not throw and reports the old point value unchanged', async () => {
      const id = await insertLegacyProfile()
      const profile = await getProfile(id)
      const metrics = profile['metrics'] as Record<string, unknown>

      expect(metrics['positivityOffset']).toBe(0.317)
      expect('schemaVersion' in metrics).toBe(false)
      expect(metrics['repeated']).toBeFalsy()
    })

    it('GET /api/model-profiles (list) does not throw and summarizes the legacy record correctly', async () => {
      await insertLegacyProfile()
      const rows = await listProfiles()
      const m1 = rows.find((r) => r.model === 'm1')!

      expect(m1.summary!['positivityOffset']).toBe(0.317)
      expect(m1.summary!['cellCount']).toBe(16)
    })
  })
})
