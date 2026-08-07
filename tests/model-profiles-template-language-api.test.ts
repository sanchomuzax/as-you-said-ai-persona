import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { createDb, type Db } from '../src/db.js'
import { buildServer } from '../src/server.js'
import type { ChatClient, ChatResult } from '../src/openrouter.js'
import type { AppConfig } from '../src/config.js'

/**
 * Issue #33 requirement 2: the TEMPLATE's language is recorded on the
 * model-profile key, read out of the calibration run's own config (like
 * model_version/provider — measured, not taken from the request body).
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
  async complete(): Promise<ChatResult> {
    return {
      content: '{"A": 0.5, "B": 0.5}', modelVersion: 'm1-2026-05', promptTokens: 10, completionTokens: 5,
      cachedTokens: 0, cacheDiscountUsd: 0, provider: 'DeepInfra', costUsd: 0.001, requestId: 'r1', latencyMs: 1
    }
  }
}

let app: FastifyInstance
let db: Db
let cookie: { asys_session: string }

async function login(): Promise<{ asys_session: string }> {
  const res = await app.inject({ method: 'POST', url: '/api/login', payload: { username: 'admin', password: 'test-password-123' } })
  return { asys_session: /asys_session=([^;]+)/.exec(res.headers['set-cookie'] as string)![1]! }
}

/** A finished calibration run whose config carries an explicit templateLanguage. */
function seedCalibrationRun(runId: string, templateLanguage: string | undefined): void {
  if (!db.prepare('SELECT id FROM questionnaires WHERE id = ?').get('probe')) {
    db.prepare('INSERT INTO questionnaires (id, lineage_id, name) VALUES (?,?,?)').run('probe', 'probe', 'Próba')
    db.prepare(
      'INSERT INTO questions (id, questionnaire_id, ord, text, scale_type, options_json, scale_direction) VALUES (?,?,?,?,?,?,?)'
    ).run('q1', 'probe', 0, 'Mennyire ért egyet?', 'ordinal', JSON.stringify(['Egyáltalán', 'Kicsit', 'Eléggé', 'Teljesen']), 'ascending')
  }
  const config: Record<string, unknown> = { model: 'm1', temperature: 1, seeds: [0], baselineArm: true }
  if (templateLanguage !== undefined) config['templateLanguage'] = templateLanguage
  db.prepare('INSERT INTO runs (id, questionnaire_id, name, config_json, status) VALUES (?,?,?,?,?)').run(
    runId, 'probe', `Kalibráció`, JSON.stringify(config), 'completed'
  )
  let n = 0
  for (const rotation of ['[0,1,2,3]', '[1,2,3,0]', '[2,3,0,1]', '[3,0,1,2]']) {
    db.prepare(
      `INSERT INTO responses (id, run_id, persona_id, question_id, condition, model_requested, model_version,
         provider, temperature, seed, permutation_json, prompt_rendered, raw_response,
         parsed_distribution_json, parsed_answer, elicitation_mode, is_valid, abstained, cost_usd)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      `${runId}-${n++}`, runId, null, 'q1', 'baseline', 'm1', 'm1-2026-05', 'DeepInfra', 1, 0,
      rotation, 'prompt', 'raw', JSON.stringify({ '0': 0, '1': 0, '2': 0, '3': 1 }), '3',
      'single_choice', 1, 0, 0.001
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

describe('POST /api/model-profiles — templateLanguage', () => {
  it('records the templateLanguage read out of the calibration run config', async () => {
    seedCalibrationRun('cal', 'hu')
    const res = await app.inject({
      method: 'POST', url: '/api/model-profiles', cookies: cookie, payload: { model: 'm1', runIds: ['cal'] }
    })
    expect(res.statusCode).toBe(200)
    const row = db.prepare('SELECT template_language FROM model_profiles WHERE id = ?').get(res.json().data.id) as {
      template_language: string
    }
    expect(row.template_language).toBe('hu')
  })

  it('marks a profile built from a pre-language-split run with the legacy sentinel', async () => {
    seedCalibrationRun('cal', undefined)
    const res = await app.inject({
      method: 'POST', url: '/api/model-profiles', cookies: cookie, payload: { model: 'm1', runIds: ['cal'] }
    })
    expect(res.statusCode).toBe(200)
    const row = db.prepare('SELECT template_language FROM model_profiles WHERE id = ?').get(res.json().data.id) as {
      template_language: string
    }
    expect(row.template_language).toBe('mixed_legacy')
  })

  it('refuses to combine runs that used different elicitation template languages', async () => {
    seedCalibrationRun('cal-hu', 'hu')
    seedCalibrationRun('cal-en', 'en')
    const res = await app.inject({
      method: 'POST', url: '/api/model-profiles', cookies: cookie, payload: { model: 'm1', runIds: ['cal-hu', 'cal-en'] }
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/sablon-nyelv/)
  })

  it('exposes templateLanguage on the model card', async () => {
    seedCalibrationRun('cal', 'hu')
    const created = await app.inject({
      method: 'POST', url: '/api/model-profiles', cookies: cookie, payload: { model: 'm1', runIds: ['cal'] }
    })
    const res = await app.inject({ method: 'GET', url: `/api/model-profiles/${created.json().data.id}`, cookies: cookie })
    expect(res.json().data.templateLanguage).toBe('hu')
  })
})
