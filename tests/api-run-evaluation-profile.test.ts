import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { createDb, type Db } from '../src/db.js'
import { buildServer } from '../src/server.js'
import { promptTemplateHash } from '../src/lib/profile.js'
import type { ChatClient, ChatResult } from '../src/openrouter.js'
import type { AppConfig } from '../src/config.js'

/**
 * Issue #17 M3 (docs/MODEL-CALIBRATION.md §4): "The evaluation record stores
 * which model_profile.id was in context, so any evaluation is auditable
 * against the calibration it used." A run evaluated with no profile at all is
 * a real, recordable state (nullable) — and if the profile was stale at
 * evaluation time, that has to be recorded too, since the audit trail must
 * reflect what was true THEN, not whatever the profile's status is later.
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

const testModels = { default: 'm1', models: [{ id: 'm1', label: 'Modell 1' }] }

class StubClient implements ChatClient {
  async complete(model: string): Promise<ChatResult> {
    return {
      content: 'Kiértékelés szövege.', modelVersion: `${model}-2026-05`, promptTokens: 100,
      completionTokens: 50, cachedTokens: 0, cacheDiscountUsd: 0, provider: 'DeepInfra',
      costUsd: 0.01, requestId: 'r1', latencyMs: 10
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

async function get(url: string) {
  return app.inject({ method: 'GET', url, cookies: cookie })
}

async function evaluate(runId: string) {
  return app.inject({ method: 'POST', url: `/api/runs/${runId}/evaluate`, cookies: cookie })
}

/** Same shape as tests/model-profiles-api.test.ts's helper: a finished calibration run. */
function seedCalibrationRun(
  runId = 'cal',
  { model = 'm1', version = 'm1-2026-05', provider = 'DeepInfra' as string | null } = {}
): void {
  if (!db.prepare('SELECT id FROM questionnaires WHERE id = ?').get('probe')) {
    db.prepare('INSERT INTO questionnaires (id, lineage_id, name) VALUES (?,?,?)').run('probe', 'probe', 'Alapértelmezett-perszóna próba')
    db.prepare(
      'INSERT INTO questions (id, questionnaire_id, ord, text, scale_type, options_json, scale_direction) VALUES (?,?,?,?,?,?,?)'
    ).run('q1', 'probe', 0, 'Mennyire ért egyet?', 'ordinal', JSON.stringify(['Egyáltalán', 'Kicsit', 'Eléggé', 'Teljesen']), 'ascending')
  }
  db.prepare('INSERT INTO runs (id, questionnaire_id, name, config_json, status) VALUES (?,?,?,?,?)').run(
    runId, 'probe', `Kalibráció — ${model}`,
    JSON.stringify({ model, temperature: 1, seeds: [0, 1], baselineArm: true }), 'completed'
  )
  let n = 0
  for (const rotation of ['[0,1,2,3]', '[1,2,3,0]', '[2,3,0,1]', '[3,0,1,2]']) {
    for (const seed of [0, 1]) {
      db.prepare(
        `INSERT INTO responses (id, run_id, persona_id, question_id, condition, model_requested, model_version,
           provider, temperature, seed, permutation_json, prompt_rendered, raw_response,
           parsed_distribution_json, parsed_answer, elicitation_mode, is_valid, abstained, cost_usd)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(
        `${runId}-${n++}`, runId, null, 'q1', 'baseline', model, version, provider, 1, seed,
        rotation, 'prompt', 'raw', JSON.stringify({ '0': 0, '1': 0, '2': 0, '3': 1 }), '3',
        'single_choice', 1, 0, 0.001
      )
    }
  }
}

async function createProfile(runIds = ['cal'], model = 'm1'): Promise<string> {
  const res = await app.inject({
    method: 'POST', url: '/api/model-profiles', cookies: cookie, payload: { model, runIds }
  })
  expect(res.statusCode).toBe(200)
  return res.json().data.id as string
}

/** A separate, ordinary run to be evaluated — real questionnaire, one persona response. */
function seedEvaluableRun(runId = 'r1', model = 'm1'): void {
  db.prepare('INSERT INTO questionnaires (id, lineage_id, name) VALUES (?,?,?)').run('qn-eval', 'qn-eval', 'Kérdőív')
  db.prepare('INSERT INTO questions (id, questionnaire_id, ord, text, options_json) VALUES (?,?,0,?,?)').run(
    'q-eval', 'qn-eval', 'Kérdés?', JSON.stringify(['A', 'B'])
  )
  db.prepare('INSERT INTO personas (id, name, demographics_json) VALUES (?,?,?)').run('per1', 'Anna', '{}')
  db.prepare('INSERT INTO runs (id, questionnaire_id, name, config_json, status) VALUES (?,?,?,?,?)').run(
    runId, 'qn-eval', 'Futás', JSON.stringify({ model, temperature: 1, seeds: [0] }), 'completed'
  )
  db.prepare('INSERT INTO run_personas (run_id, persona_id) VALUES (?,?)').run(runId, 'per1')
  db.prepare(
    `INSERT INTO responses (id, run_id, persona_id, question_id, model_requested, model_version, temperature, seed,
       permutation_json, prompt_rendered, raw_response, parsed_distribution_json, parsed_answer, is_valid, abstained)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    'resp1', runId, 'per1', 'q-eval', model, `${model}-2026-05`, 1, 0,
    '[0,1]', 'p', 'r', JSON.stringify({ '0': 0.7, '1': 0.3 }), '0', 1, 0
  )
}

/** Same as seedEvaluableRun, but with an explicit model_version/provider/created_at
 * on the response row — so a run's own recorded stack can differ from whatever
 * a later-created calibration profile happens to describe. */
function seedEvaluableRunWithStack(
  runId: string,
  opts: { model: string; modelVersion: string; provider: string; createdAt: string }
): void {
  const qn = `${runId}-qn`
  const q = `${runId}-q`
  const persona = `${runId}-persona`
  db.prepare('INSERT INTO questionnaires (id, lineage_id, name) VALUES (?,?,?)').run(qn, qn, 'Kérdőív')
  db.prepare('INSERT INTO questions (id, questionnaire_id, ord, text, options_json) VALUES (?,?,0,?,?)').run(
    q, qn, 'Kérdés?', JSON.stringify(['A', 'B'])
  )
  db.prepare('INSERT INTO personas (id, name, demographics_json) VALUES (?,?,?)').run(persona, 'Anna', '{}')
  db.prepare('INSERT INTO runs (id, questionnaire_id, name, config_json, status) VALUES (?,?,?,?,?)').run(
    runId, qn, 'Futás', JSON.stringify({ model: opts.model, temperature: 1, seeds: [0] }), 'completed'
  )
  db.prepare('INSERT INTO run_personas (run_id, persona_id) VALUES (?,?)').run(runId, persona)
  db.prepare(
    `INSERT INTO responses (id, run_id, persona_id, question_id, model_requested, model_version, provider,
       temperature, seed, permutation_json, prompt_rendered, raw_response, parsed_distribution_json,
       parsed_answer, is_valid, abstained, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    `${runId}-resp`, runId, persona, q, opts.model, opts.modelVersion, opts.provider, 1, 0,
    '[0,1]', 'p', 'r', JSON.stringify({ '0': 0.7, '1': 0.3 }), '0', 1, 0, opts.createdAt
  )
}

beforeEach(async () => {
  db = createDb(':memory:')
  app = buildServer({ db, config: testConfig, models: testModels, client: new StubClient() })
  await app.ready()
  cookie = await login()
})

afterEach(() => app.close())

describe('run_evaluations records which calibration profile was in context (issue #17 M3)', () => {
  it('stores and exposes the valid profile that was active for the run’s model', async () => {
    seedCalibrationRun()
    const profileId = await createProfile()
    seedEvaluableRun('r1', 'm1')

    expect((await evaluate('r1')).statusCode).toBe(200)

    const row = db
      .prepare('SELECT model_profile_id, model_profile_status FROM run_evaluations WHERE run_id = ?')
      .get('r1') as { model_profile_id: string | null; model_profile_status: string | null } | undefined
    expect(row?.model_profile_id).toBe(profileId)
    expect(row?.model_profile_status).toBe('valid')

    const list = (await get('/api/runs/r1/evaluations')).json().data as Array<Record<string, unknown>>
    expect(list[0]!.model_profile_id).toBe(profileId)
    expect(list[0]!.model_profile_status).toBe('valid')
  })

  it('records null, not a missing field, when the run’s model has no calibration profile at all', async () => {
    seedEvaluableRun('r1', 'm1') // no calibration run, no profile ever created

    expect((await evaluate('r1')).statusCode).toBe(200)

    const row = db
      .prepare('SELECT model_profile_id, model_profile_status FROM run_evaluations WHERE run_id = ?')
      .get('r1') as { model_profile_id: string | null } | undefined
    expect(row).toBeDefined()
    expect(row!.model_profile_id).toBeNull()

    const list = (await get('/api/runs/r1/evaluations')).json().data as Array<Record<string, unknown>>
    expect(list[0]).toHaveProperty('model_profile_id')
    expect(list[0]!.model_profile_id).toBeNull()
  })

  it('records the profile as stale when it had already expired at evaluation time', async () => {
    seedCalibrationRun()
    const profileId = await createProfile()
    db.prepare("UPDATE model_profiles SET valid_until = '2020-01-01 00:00:00' WHERE id = ?").run(profileId)
    seedEvaluableRun('r1', 'm1')

    expect((await evaluate('r1')).statusCode).toBe(200)

    const row = db
      .prepare('SELECT model_profile_id, model_profile_status FROM run_evaluations WHERE run_id = ?')
      .get('r1') as { model_profile_id: string | null; model_profile_status: string | null } | undefined
    expect(row?.model_profile_id).toBe(profileId)
    expect(row?.model_profile_status).toBe('stale')

    const list = (await get('/api/runs/r1/evaluations')).json().data as Array<Record<string, unknown>>
    expect(list[0]!.model_profile_status).toBe('stale')
  })
})

/**
 * M3 review HIGH #2: `currentKeyFor` (src/model-profiles.ts) compares a
 * profile against responses created AFTER the profile — for a run that
 * finished BEFORE the profile even existed, that query finds nothing, and
 * "no news is not drift" then declares the profile valid FOR THAT RUN even
 * though the run's own responses were served by a completely different
 * model_version/provider. The cited profile must describe the run's OWN
 * calls, not just whatever the global stack looks like today.
 */
describe('the profile cited must describe the run’s own stack, not today’s global one (issue #17 M3 review, HIGH #2)', () => {
  it('does not report a valid profile when the run’s own responses were served by a different model version and provider', async () => {
    // The run finished EARLIER, on an older stack — before any profile
    // existed for this model, so nothing "since the profile" ever sees it.
    seedEvaluableRunWithStack('r1', {
      model: 'm1', modelVersion: 'm1-2025-01', provider: 'Together', createdAt: '2026-01-01 10:00:00'
    })

    // A calibration profile measured LATER, on a DIFFERENT stack.
    seedCalibrationRun('cal', { model: 'm1', version: 'm1-2026-05', provider: 'DeepInfra' })
    const profileId = await createProfile(['cal'], 'm1')
    db.prepare("UPDATE model_profiles SET created_at = '2026-08-01 10:00:00' WHERE id = ?").run(profileId)

    expect((await evaluate('r1')).statusCode).toBe(200)

    const row = db
      .prepare('SELECT model_profile_id, model_profile_status, prompt FROM run_evaluations WHERE run_id = ?')
      .get('r1') as { model_profile_id: string | null; model_profile_status: string | null; prompt: string } | undefined
    expect(row?.model_profile_id).toBe(profileId)
    // The bug: this used to read 'valid' because nothing newer than the
    // profile itself was ever checked against THIS run's own stack.
    expect(row?.model_profile_status).not.toBe('valid')

    // The judge must be able to see what it is actually comparing.
    expect(row!.prompt).toContain('Together')
    expect(row!.prompt).toContain('DeepInfra')
    expect(row!.prompt).toContain('m1-2025-01')
    expect(row!.prompt).toContain('m1-2026-05')
  })
})

/**
 * M3 review HIGH #3: buildCalibrationSection reads `metrics?.priorBias.
 * maxDeviation` — the optional chain stops at `metrics`, so a profile row
 * with an incomplete metrics_json (e.g. `{"positivityOffset": 0.1}`, no
 * priorBias at all) throws `Cannot read properties of undefined`. On the
 * auto-evaluation path (runEvents.on('run_finished', ...)) that throw is
 * swallowed by `.catch(() => undefined)`: no row, no log, no UI message.
 */
describe('a profile with incomplete metrics_json must not crash the evaluation (issue #17 M3 review, HIGH #3)', () => {
  it('still produces an evaluation, degrading gracefully, instead of throwing', async () => {
    seedEvaluableRun('r1', 'm1')
    db.prepare('INSERT INTO questionnaires (id, lineage_id, name) VALUES (?,?,?)').run(
      'probe-partial', 'probe-partial', 'Próba'
    )
    db.prepare(
      `INSERT INTO model_profiles
         (id, model_requested, model_version, provider, prompt_template_hash, probe_questionnaire_id, run_ids_json, metrics_json, valid_until)
       VALUES (?,?,?,?,?,?,?,?,?)`
    ).run(
      'prof-partial', 'm1', 'm1-2026-05', 'DeepInfra', promptTemplateHash(), 'probe-partial', '[]',
      JSON.stringify({ positivityOffset: 0.1 }), '2099-01-01 00:00:00'
    )

    const res = await evaluate('r1')
    // Not swallowed: a real response, not a 500 that the caller cannot see
    // either (the auto-evaluation path has no caller to report to at all).
    expect(res.statusCode).toBe(200)

    const row = db.prepare('SELECT prompt, content FROM run_evaluations WHERE run_id = ?').get('r1') as
      | { prompt: string; content: string }
      | undefined
    expect(row).toBeDefined()
    expect(row!.content).toBeTruthy()
  })
})

/**
 * M3 review MEDIUM #5: stalenessReasons() (src/model-profiles.ts) already
 * computes the PRECISE reason a profile is stale, for the "Modellek" tab UI.
 * The judge prompt's generic staleNote lists all five possible reasons
 * ("...modellverzió, a szolgáltató, ... vagy lejárt az érvényessége")
 * instead of stating the one that actually applies here.
 */
describe('the stale note states the actual reason, not every possible one (issue #17 M3 review, MEDIUM #5)', () => {
  it('names the specific reason (expired validity) using stalenessReasons’ own wording', async () => {
    seedCalibrationRun()
    const profileId = await createProfile()
    db.prepare("UPDATE model_profiles SET valid_until = '2020-01-01 00:00:00' WHERE id = ?").run(profileId)
    seedEvaluableRun('r1', 'm1')

    expect((await evaluate('r1')).statusCode).toBe(200)

    const row = db.prepare('SELECT prompt FROM run_evaluations WHERE run_id = ?').get('r1') as
      | { prompt: string }
      | undefined
    // stalenessReasons()'s own phrase for an expired profile — "érvényessége
    // lejárt" — not the generic listing's reversed "lejárt az érvényessége".
    expect(row!.prompt).toMatch(/érvényessége lejárt/i)
  })
})
