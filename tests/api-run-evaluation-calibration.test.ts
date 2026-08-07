import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { createDb, type Db } from '../src/db.js'
import { buildServer } from '../src/server.js'
import type { ChatClient, ChatResult } from '../src/openrouter.js'
import type { AppConfig } from '../src/config.js'

/**
 * Issue #35: the real POST /api/runs/:id/evaluate path — not just
 * buildEvaluationPrompt in isolation — must detect a calibration run
 * (config_json.calibration === true) and use the calibration-framed prompt,
 * end to end.
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

async function evaluate(runId: string) {
  return app.inject({ method: 'POST', url: `/api/runs/${runId}/evaluate`, cookies: cookie })
}

/** A finished calibration run: `calibration: true` in config, all rows persona-free/baseline. */
function seedCalibrationRun(runId = 'cal', model = 'm1'): void {
  db.prepare('INSERT INTO questionnaires (id, lineage_id, name) VALUES (?,?,?)').run('probe', 'probe', 'Próba')
  db.prepare(
    'INSERT INTO questions (id, questionnaire_id, ord, text, scale_type, options_json, scale_direction) VALUES (?,?,?,?,?,?,?)'
  ).run('q1', 'probe', 0, 'Mennyire bízol az intézményekben?', 'ordinal', JSON.stringify(['Egyáltalán', 'Nagyon']), 'ascending')
  db.prepare('INSERT INTO runs (id, questionnaire_id, name, config_json, status) VALUES (?,?,?,?,?)').run(
    runId, 'probe', `Kalibráció — ${model}`,
    JSON.stringify({ model, temperature: 1, seeds: [0, 1], baselineArm: true, calibration: true }), 'completed'
  )
  let n = 0
  for (const seed of [0, 1]) {
    db.prepare(
      `INSERT INTO responses (id, run_id, persona_id, question_id, condition, model_requested, model_version,
         provider, temperature, seed, permutation_json, prompt_rendered, raw_response,
         parsed_distribution_json, parsed_answer, is_valid, abstained, cost_usd)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      `${runId}-${n++}`, runId, null, 'q1', 'baseline', model, `${model}-2026-05`, 'DeepInfra', 1, seed,
      '[0,1]', 'prompt', 'raw', JSON.stringify({ '0': 0.2, '1': 0.8 }), '1',
      1, 0, 0.001
    )
  }
}

beforeEach(async () => {
  db = createDb(':memory:')
  app = buildServer({ db, config: testConfig, models: testModels, client: new StubClient() })
  await app.ready()
  cookie = await login()
})

afterEach(() => app.close())

describe('POST /api/runs/:id/evaluate uses the calibration-framed prompt for a calibration run (issue #35)', () => {
  it('detects calibration from config_json.calibration, not the run name or "zero personas"', async () => {
    seedCalibrationRun('cal', 'm1')

    expect((await evaluate('cal')).statusCode).toBe(200)

    const row = db.prepare('SELECT prompt FROM run_evaluations WHERE run_id = ?').get('cal') as
      | { prompt: string }
      | undefined
    expect(row).toBeDefined()
    expect(row!.prompt).toMatch(/modell-kalibráci/i)
    expect(row!.prompt).not.toMatch(/perszónák közti/i)
    expect(row!.prompt).not.toMatch(/spurious.split/i)
    expect(row!.prompt).not.toContain('KÖTELEZŐ kimondanod: ehhez a modellhez nincs mért alap-pozitivitás')
    expect(row!.prompt).toMatch(/ebből a futásból rögzíthető a profil/i)
  })
})
