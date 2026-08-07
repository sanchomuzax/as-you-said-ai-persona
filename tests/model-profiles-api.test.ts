import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { createDb, type Db } from '../src/db.js'
import { buildServer } from '../src/server.js'
import { promptTemplateHash } from '../src/lib/profile.js'
import type { ChatClient, ChatResult } from '../src/openrouter.js'
import type { AppConfig } from '../src/config.js'

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
  models: [
    { id: 'm1', label: 'Modell 1' },
    { id: 'm2', label: 'Modell 2' }
  ]
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

/** A finished calibration run: probe questionnaire, control cells only. */
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

beforeEach(async () => {
  db = createDb(':memory:')
  app = buildServer({ db, config: testConfig, models: testModels, client: new StubClient() })
  await app.ready()
  cookie = await login()
})

afterEach(() => app.close())

describe('GET /api/model-profiles', () => {
  it('lists every configured model, marking the uncalibrated ones', async () => {
    const rows = (await app.inject({ method: 'GET', url: '/api/model-profiles', cookies: cookie })).json().data as {
      model: string
      status: string
    }[]
    expect(rows.map((r) => r.model)).toEqual(['m1', 'm2'])
    expect(rows.every((r) => r.status === 'missing')).toBe(true)
  })

  it('reports a fresh profile as valid, with its measured summary', async () => {
    seedCalibrationRun()
    await createProfile()
    const rows = (await app.inject({ method: 'GET', url: '/api/model-profiles', cookies: cookie })).json().data as {
      model: string
      status: string
      summary: { positivityOffset: number; cellCount: number } | null
    }[]
    const m1 = rows.find((r) => r.model === 'm1')!
    expect(m1.status).toBe('valid')
    expect(m1.summary!.positivityOffset).toBeCloseTo(0.5, 5)
    expect(m1.summary!.cellCount).toBe(8)
    // the uncalibrated model is still listed — a missing profile is the finding
    expect(rows.find((r) => r.model === 'm2')!.status).toBe('missing')
  })

  // Drift detection: the profile records what was measured, the newest response
  // records what is being served now.
  it('goes stale and says why when the provider changed under the same model', async () => {
    seedCalibrationRun()
    await createProfile()
    db.prepare('INSERT INTO runs (id, questionnaire_id, name, config_json) VALUES (?,?,?,?)').run(
      'later', 'probe', 'Későbbi futás', JSON.stringify({ model: 'm1', temperature: 1, seeds: [0] })
    )
    db.prepare(
      `INSERT INTO responses (id, run_id, persona_id, question_id, condition, model_requested, model_version,
         provider, temperature, seed, permutation_json, prompt_rendered, raw_response, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      'drift', 'later', null, 'q1', 'baseline', 'm1', 'm1-2026-05', 'Fireworks', 1, 0, '[0,1,2,3]', 'p', 'r',
      '2099-01-01 00:00:00'
    )
    const rows = (await app.inject({ method: 'GET', url: '/api/model-profiles', cookies: cookie })).json().data as {
      model: string
      status: string
      reasons: string[]
    }[]
    const m1 = rows.find((r) => r.model === 'm1')!
    expect(m1.status).toBe('stale')
    expect(m1.reasons.join(' ')).toMatch(/szolgáltató megváltozott/)
  })

  it('goes stale when the elicitation template changed since the profile', async () => {
    seedCalibrationRun()
    await createProfile()
    db.prepare('UPDATE model_profiles SET prompt_template_hash = ?').run('0000000000000000')
    const rows = (await app.inject({ method: 'GET', url: '/api/model-profiles', cookies: cookie })).json().data as {
      model: string
      status: string
      reasons: string[]
    }[]
    const m1 = rows.find((r) => r.model === 'm1')!
    expect(m1.status).toBe('stale')
    expect(m1.reasons.join(' ')).toMatch(/sablon/)
  })

  // Spec §2 lists "probe questionnaire revised" as a re-test trigger.
  it('goes stale when a newer version of the probe questionnaire exists', async () => {
    seedCalibrationRun()
    await createProfile()
    db.prepare('INSERT INTO questionnaires (id, lineage_id, name, version) VALUES (?,?,?,?)').run(
      'probe-v2', 'probe', 'Alapértelmezett-perszóna próba', 2
    )
    const rows = (await app.inject({ method: 'GET', url: '/api/model-profiles', cookies: cookie })).json().data as {
      model: string
      status: string
      reasons: string[]
    }[]
    const m1 = rows.find((r) => r.model === 'm1')!
    expect(m1.status).toBe('stale')
    expect(m1.reasons.join(' ')).toMatch(/próba-kérdőívnek azóta új verziója/)
  })

  // A call OpenRouter did not attribute is no news, not different news.
  it('stays valid when a later response reports no provider at all', async () => {
    seedCalibrationRun()
    await createProfile()
    db.prepare('INSERT INTO runs (id, questionnaire_id, name, config_json) VALUES (?,?,?,?)').run(
      'later', 'probe', 'Későbbi', JSON.stringify({ model: 'm1', temperature: 1, seeds: [0] })
    )
    db.prepare(
      `INSERT INTO responses (id, run_id, persona_id, question_id, condition, model_requested, model_version,
         provider, temperature, seed, permutation_json, prompt_rendered, raw_response, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run('noprov', 'later', null, 'q1', 'baseline', 'm1', 'm1-2026-05', null, 1, 0, '[0,1,2,3]', 'p', 'r', '2099-01-01 00:00:00')
    const rows = (await app.inject({ method: 'GET', url: '/api/model-profiles', cookies: cookie })).json().data as {
      model: string
      status: string
    }[]
    expect(rows.find((r) => r.model === 'm1')!.status).toBe('valid')
  })

  it('goes stale after the validity window', async () => {
    seedCalibrationRun()
    await createProfile()
    db.prepare("UPDATE model_profiles SET valid_until = '2020-01-01 00:00:00'").run()
    const rows = (await app.inject({ method: 'GET', url: '/api/model-profiles', cookies: cookie })).json().data as {
      model: string
      status: string
      reasons: string[]
    }[]
    expect(rows.find((r) => r.model === 'm1')!.status).toBe('stale')
    expect(rows.find((r) => r.model === 'm1')!.reasons.join(' ')).toMatch(/lejárt/)
  })

  it('requires a session', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/model-profiles' })).statusCode).toBe(401)
  })
})

describe('POST /api/model-profiles', () => {
  it('reads the measured stack out of the responses, not out of the request', async () => {
    seedCalibrationRun()
    const id = await createProfile()
    const row = db.prepare('SELECT * FROM model_profiles WHERE id = ?').get(id) as Record<string, unknown>
    expect(row['model_version']).toBe('m1-2026-05')
    expect(row['provider']).toBe('DeepInfra')
    expect(row['prompt_template_hash']).toBe(promptTemplateHash())
    expect(row['probe_questionnaire_id']).toBe('probe')
  })

  it('sets a 90-day validity window', async () => {
    seedCalibrationRun()
    const id = await createProfile()
    const row = db.prepare('SELECT created_at, valid_until FROM model_profiles WHERE id = ?').get(id) as {
      created_at: string
      valid_until: string
    }
    const days = (Date.parse(row.valid_until + 'Z') - Date.parse(row.created_at + 'Z')) / 86_400_000
    expect(Math.round(days)).toBe(90)
  })

  // Two versions or providers averaged into one number would be a label on the
  // wrong bottle: the profile claims to describe one exact stack.
  it('refuses runs that span more than one model version or provider', async () => {
    seedCalibrationRun('cal')
    seedCalibrationRun('cal2', { version: 'm1-2026-09' })
    const res = await app.inject({
      method: 'POST', url: '/api/model-profiles', cookies: cookie, payload: { model: 'm1', runIds: ['cal', 'cal2'] }
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/több modellverziót vagy szolgáltatót/)
  })

  it('refuses runs that used different probe questionnaires', async () => {
    seedCalibrationRun('cal')
    db.prepare('INSERT INTO questionnaires (id, lineage_id, name) VALUES (?,?,?)').run('probe2', 'probe2', 'Másik próba')
    db.prepare('INSERT INTO runs (id, questionnaire_id, name, config_json, status) VALUES (?,?,?,?,?)').run(
      'cal3', 'probe2', 'K', JSON.stringify({ model: 'm1', temperature: 1, seeds: [0] }), 'completed'
    )
    db.prepare(
      `INSERT INTO responses (id, run_id, persona_id, question_id, condition, model_requested, model_version,
         provider, temperature, seed, permutation_json, prompt_rendered, raw_response)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run('x', 'cal3', null, 'q1', 'baseline', 'm1', 'm1-2026-05', 'DeepInfra', 1, 0, '[0,1,2,3]', 'p', 'r')
    const res = await app.inject({
      method: 'POST', url: '/api/model-profiles', cookies: cookie, payload: { model: 'm1', runIds: ['cal', 'cal3'] }
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/ugyanazt a próba-kérdőívet/)
  })

  it('refuses a run with no control cells at all', async () => {
    db.prepare('INSERT INTO questionnaires (id, lineage_id, name) VALUES (?,?,?)').run('probe', 'probe', 'P')
    db.prepare('INSERT INTO runs (id, questionnaire_id, name, config_json, status) VALUES (?,?,?,?,?)').run(
      'empty', 'probe', 'K', JSON.stringify({ model: 'm1', temperature: 1, seeds: [0] }), 'completed'
    )
    const res = await app.inject({
      method: 'POST', url: '/api/model-profiles', cookies: cookie, payload: { model: 'm1', runIds: ['empty'] }
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/kontroll/)
  })

  // The position-bias metric rests on the balanced-rotation invariant: a run
  // stopped halfway reports a content-driven model as position-driven, with
  // nothing on the record saying the design was incomplete.
  it('refuses a run that has not finished', async () => {
    seedCalibrationRun()
    db.prepare("UPDATE runs SET status = 'running' WHERE id = 'cal'").run()
    const res = await app.inject({
      method: 'POST', url: '/api/model-profiles', cookies: cookie, payload: { model: 'm1', runIds: ['cal'] }
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/befejezett/)
  })

  it('refuses a run whose control cells are all unusable', async () => {
    seedCalibrationRun()
    db.prepare("UPDATE responses SET is_valid = 0 WHERE run_id = 'cal'").run()
    const res = await app.inject({
      method: 'POST', url: '/api/model-profiles', cookies: cookie, payload: { model: 'm1', runIds: ['cal'] }
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/értékelhető/)
  })

  it('refuses runs belonging to a different model than the one claimed', async () => {
    seedCalibrationRun('cal', { model: 'm1' })
    const res = await app.inject({
      method: 'POST', url: '/api/model-profiles', cookies: cookie, payload: { model: 'm2', runIds: ['cal'] }
    })
    expect(res.statusCode).toBe(400)
  })
})

describe('GET /api/model-profiles/:id', () => {
  it('serves the model card with every measured number and what it was measured on', async () => {
    seedCalibrationRun()
    const id = await createProfile()
    const res = await app.inject({ method: 'GET', url: `/api/model-profiles/${id}`, cookies: cookie })
    expect(res.statusCode).toBe(200)
    const data = res.json().data
    expect(data.status).toBe('valid')
    expect(data.probeName).toBe('Alapértelmezett-perszóna próba')
    expect(data.probeVersion).toBe(1)
    expect(data.metrics.perQuestion[0].defaultDistribution).toEqual([0, 0, 0, 1])
    expect(data.metrics.priorBias.byPosition).toEqual([0.25, 0.25, 0.25, 0.25])
    expect(data.metrics.provenance.runIds).toEqual(['cal'])
  })

  it('404s on an unknown profile', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/model-profiles/nope', cookies: cookie })).statusCode).toBe(404)
  })
})

describe('POST /api/models/:model/calibrate', () => {
  it('launches a persona-free probe run and reports only control cells', async () => {
    seedCalibrationRun('seedrun')
    const res = await app.inject({
      method: 'POST', url: '/api/models/m1/calibrate', cookies: cookie, payload: { questionnaireId: 'probe', seeds: [0] }
    })
    expect(res.statusCode).toBe(200)
    const runId = res.json().data.runId as string

    await new Promise((resolve) => setTimeout(resolve, 250))
    const config = JSON.parse(
      (db.prepare('SELECT config_json FROM runs WHERE id = ?').get(runId) as { config_json: string }).config_json
    )
    expect(config.baselineArm).toBe(true)
    // The marker the UI matches on to list a model's calibration runs on its
    // card — matching the human-facing run name instead would break on rewording.
    expect(config.calibration).toBe(true)
    expect(db.prepare('SELECT COUNT(*) c FROM run_personas WHERE run_id = ?').get(runId)).toEqual({ c: 0 })
    const rows = db.prepare('SELECT persona_id, condition FROM responses WHERE run_id = ?').all(runId) as unknown as {
      persona_id: string | null
      condition: string
    }[]
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((r) => r.persona_id === null && r.condition === 'baseline')).toBe(true)
  })

  it('rejects an unknown model', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/models/nope/calibrate', cookies: cookie, payload: { questionnaireId: 'probe' }
    })
    expect(res.statusCode).toBe(400)
  })

  it('rejects an unknown questionnaire', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/models/m1/calibrate', cookies: cookie, payload: { questionnaireId: 'nope' }
    })
    expect(res.statusCode).toBe(400)
  })
})
