import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { createDb } from '../src/db.js'
import { buildServer } from '../src/server.js'
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
  default: 'deepseek/deepseek-v4-flash',
  models: [{ id: 'deepseek/deepseek-v4-flash', label: 'DeepSeek V4 Flash' }]
}

class StubClient implements ChatClient {
  async complete(model: string): Promise<ChatResult> {
    return {
      content: '{"A": 0.7, "B": 0.3}',
      modelVersion: model,
      promptTokens: 10,
      completionTokens: 5,
      costUsd: 0,
      requestId: 'r1',
      latencyMs: 1
    }
  }
}

let app: FastifyInstance
let cookie: { asys_session: string }

async function login(app: FastifyInstance): Promise<{ asys_session: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/login',
    payload: { username: 'admin', password: 'test-password-123' }
  })
  const setCookie = res.headers['set-cookie'] as string
  const token = /asys_session=([^;]+)/.exec(setCookie)![1]!
  return { asys_session: token }
}

beforeEach(async () => {
  app = buildServer({
    db: createDb(':memory:'),
    config: testConfig,
    models: testModels,
    client: new StubClient()
  })
  await app.ready()
  cookie = await login(app)
})

afterEach(() => app.close())

describe('auth', () => {
  it('rejects API access without a session', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/personas' })
    expect(res.statusCode).toBe(401)
  })

  it('rejects bad credentials', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/login',
      payload: { username: 'admin', password: 'wrong' }
    })
    expect(res.statusCode).toBe(401)
  })

  it('accepts valid credentials and grants API access', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/personas', cookies: cookie })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ success: true, data: [] })
  })
})

describe('models & budget', () => {
  it('serves the model config with the default model', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/models', cookies: cookie })
    expect(res.json().data.default).toBe('deepseek/deepseek-v4-flash')
  })

  it('reports budget limits and usage', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/budget', cookies: cookie })
    const { data } = res.json()
    expect(data.limits.globalBudget).toBe(1_000_000)
    expect(data.global.totalTokens).toBe(0)
  })
})

describe('restart recovery', () => {
  it('auto-resumes runs left running by a previous process', async () => {
    const db = createDb(':memory:')
    const questionnaireId = 'q1'
    const personaId = 'p1'
    const runId = 'r1'
    db.prepare('INSERT INTO questionnaires (id, name) VALUES (?,?)').run(questionnaireId, 'Q')
    db.prepare('INSERT INTO questions (id, questionnaire_id, ord, text, options_json) VALUES (?,?,0,?,?)').run(
      'qq1', questionnaireId, 'Q?', JSON.stringify(['a', 'b'])
    )
    db.prepare('INSERT INTO personas (id, name, demographics_json) VALUES (?,?,?)').run(personaId, 'P', '{}')
    db.prepare("INSERT INTO runs (id, questionnaire_id, name, status, config_json) VALUES (?,?,?,'running',?)").run(
      runId, questionnaireId, 'interrupted', JSON.stringify({ model: 'm', temperature: 1, seeds: [0] })
    )
    db.prepare('INSERT INTO run_personas (run_id, persona_id) VALUES (?,?)').run(runId, personaId)

    const restarted = buildServer({ db, config: testConfig, models: testModels, client: new StubClient() })
    await restarted.ready()
    await new Promise((r) => setTimeout(r, 50))

    const status = db.prepare('SELECT status FROM runs WHERE id = ?').get(runId) as { status: string }
    expect(status.status).toBe('completed')
    const rows = db.prepare('SELECT COUNT(*) c FROM responses WHERE run_id = ?').get(runId) as { c: number }
    expect(rows.c).toBe(2)
    await restarted.close()
  })
})

describe('projects', () => {
  it('creates and lists projects', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/projects',
      cookies: cookie,
      payload: { name: 'Startlap', applicationDomain: 'media', targetPopulation: 'HU internet users' }
    })
    expect(created.statusCode).toBe(200)
    const list = await app.inject({ method: 'GET', url: '/api/projects', cookies: cookie })
    expect(list.json().data[0].name).toBe('Startlap')
    expect(list.json().data[0].applicationDomain).toBe('media')
  })

  it('rejects a persona with an unknown project', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/personas',
      cookies: cookie,
      payload: { projectId: 'nope', name: 'P', demographics: {} }
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toContain('Unknown project')
  })

  it('filters questionnaires by project, including unscoped ones', async () => {
    const p1 = (await app.inject({ method: 'POST', url: '/api/projects', cookies: cookie, payload: { name: 'A' } })).json().data.id
    const p2 = (await app.inject({ method: 'POST', url: '/api/projects', cookies: cookie, payload: { name: 'B' } })).json().data.id
    const q = { questions: [{ text: 'Q?', options: ['a', 'b'] }] }
    await app.inject({ method: 'POST', url: '/api/questionnaires', cookies: cookie, payload: { name: 'inA', projectId: p1, ...q } })
    await app.inject({ method: 'POST', url: '/api/questionnaires', cookies: cookie, payload: { name: 'inB', projectId: p2, ...q } })
    await app.inject({ method: 'POST', url: '/api/questionnaires', cookies: cookie, payload: { name: 'global', ...q } })
    const filtered = await app.inject({ method: 'GET', url: `/api/questionnaires?project=${p1}`, cookies: cookie })
    const names = filtered.json().data.map((x: { name: string }) => x.name).sort()
    expect(names).toEqual(['global', 'inA'])
  })

  it('updates a project from the detail view', async () => {
    const id = (await app.inject({ method: 'POST', url: '/api/projects', cookies: cookie, payload: { name: 'Régi név' } })).json().data.id
    const res = await app.inject({
      method: 'PUT',
      url: `/api/projects/${id}`,
      cookies: cookie,
      payload: { name: 'Új név', applicationDomain: 'média', targetPopulation: 'HU' }
    })
    expect(res.statusCode).toBe(200)
    const list = await app.inject({ method: 'GET', url: '/api/projects', cookies: cookie })
    expect(list.json().data[0]).toMatchObject({ id, name: 'Új név', applicationDomain: 'média', targetPopulation: 'HU' })
  })

  it('clears optional project fields when they are submitted empty', async () => {
    const id = (await app.inject({
      method: 'POST', url: '/api/projects', cookies: cookie, payload: { name: 'N', applicationDomain: 'x' }
    })).json().data.id
    await app.inject({ method: 'PUT', url: `/api/projects/${id}`, cookies: cookie, payload: { name: 'N' } })
    const list = await app.inject({ method: 'GET', url: '/api/projects', cookies: cookie })
    expect(list.json().data[0].applicationDomain).toBeNull()
  })

  it('rejects updating an unknown project and an empty name', async () => {
    const missing = await app.inject({ method: 'PUT', url: '/api/projects/nope', cookies: cookie, payload: { name: 'X' } })
    expect(missing.statusCode).toBe(404)
    const id = (await app.inject({ method: 'POST', url: '/api/projects', cookies: cookie, payload: { name: 'N' } })).json().data.id
    const invalid = await app.inject({ method: 'PUT', url: `/api/projects/${id}`, cookies: cookie, payload: { name: '' } })
    expect(invalid.statusCode).toBe(400)
  })

  it('stores and returns persona provenance (Persona Provenance Card)', async () => {
    const projectId = (await app.inject({ method: 'POST', url: '/api/projects', cookies: cookie, payload: { name: 'A' } })).json().data.id
    const provenance = { source: 'KSH Mikrocenzus 2022', retrievedAt: '2026-08-06', note: 'anchor core' }
    const created = await app.inject({
      method: 'POST',
      url: '/api/personas',
      cookies: cookie,
      payload: { projectId, name: 'P', demographics: { kor: '40' }, biography: 'Bio', provenance }
    })
    expect(created.statusCode).toBe(200)
    const list = await app.inject({ method: 'GET', url: '/api/personas', cookies: cookie })
    expect(list.json().data[0].provenance).toEqual(provenance)
    expect(list.json().data[0].biography).toBe('Bio')
  })

  it('returns null provenance for personas created without one', async () => {
    const projectId = (await app.inject({ method: 'POST', url: '/api/projects', cookies: cookie, payload: { name: 'A' } })).json().data.id
    await app.inject({ method: 'POST', url: '/api/personas', cookies: cookie, payload: { projectId, name: 'P', demographics: {} } })
    const list = await app.inject({ method: 'GET', url: '/api/personas', cookies: cookie })
    expect(list.json().data[0].provenance).toBeNull()
  })

  it('filters personas by project', async () => {
    const p1 = (await app.inject({ method: 'POST', url: '/api/projects', cookies: cookie, payload: { name: 'A' } })).json().data.id
    const p2 = (await app.inject({ method: 'POST', url: '/api/projects', cookies: cookie, payload: { name: 'B' } })).json().data.id
    await app.inject({ method: 'POST', url: '/api/personas', cookies: cookie, payload: { projectId: p1, name: 'inA', demographics: {} } })
    await app.inject({ method: 'POST', url: '/api/personas', cookies: cookie, payload: { projectId: p2, name: 'inB', demographics: {} } })
    const filtered = await app.inject({ method: 'GET', url: `/api/personas?project=${p1}`, cookies: cookie })
    expect(filtered.json().data).toHaveLength(1)
    expect(filtered.json().data[0].name).toBe('inA')
    expect(filtered.json().data[0].projectId).toBe(p1)
  })
})

describe('personas, questionnaires, runs end-to-end', () => {
  it('creates entities and executes a run recording responses', async () => {
    const project = await app.inject({
      method: 'POST',
      url: '/api/projects',
      cookies: cookie,
      payload: { name: 'TestProj' }
    })
    const projectId = project.json().data.id
    const persona = await app.inject({
      method: 'POST',
      url: '/api/personas',
      cookies: cookie,
      payload: { projectId, name: 'P1', demographics: { age: 40 }, renderingStyle: 'bulleted_profile' }
    })
    expect(persona.statusCode).toBe(200)
    const personaId = persona.json().data.id

    const questionnaire = await app.inject({
      method: 'POST',
      url: '/api/questionnaires',
      cookies: cookie,
      payload: {
        name: 'Q1',
        questions: [{ text: 'Trust banks?', options: ['Yes', 'No'] }]
      }
    })
    const questionnaireId = questionnaire.json().data.id

    const run = await app.inject({
      method: 'POST',
      url: '/api/runs',
      cookies: cookie,
      payload: {
        name: 'R1',
        questionnaireId,
        personaIds: [personaId],
        seeds: [0]
      }
    })
    expect(run.statusCode).toBe(200)
    const runId = run.json().data.id

    // fire-and-forget run: give the event loop a tick to finish the stub calls
    await new Promise((r) => setTimeout(r, 50))

    const detail = await app.inject({ method: 'GET', url: `/api/runs/${runId}`, cookies: cookie })
    const { data } = detail.json()
    expect(data.run.status).toBe('completed')
    expect(data.responses.length).toBe(2) // 2 options -> 2 rotations x 1 seed
    expect(data.usage.totalTokens).toBe(30)

    const csv = await app.inject({ method: 'GET', url: `/api/runs/${runId}/export.csv`, cookies: cookie })
    expect(csv.headers['content-type']).toContain('text/csv')
    expect(csv.body).toContain('prompt_rendered')
  })

  it('rejects a run with an unknown model', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/runs',
      cookies: cookie,
      payload: {
        name: 'R',
        questionnaireId: 'x',
        personaIds: ['y'],
        model: 'not/a-model'
      }
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toContain('Unknown model')
  })
})

describe('questionnaire validation', () => {
  it('rejects an unknown scale type instead of silently falling back to single-choice elicitation', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/questionnaires',
      cookies: cookie,
      payload: { name: 'Q', questions: [{ text: 'Q?', options: ['a', 'b'], scaleType: 'multi-choice' }] }
    })
    expect(res.statusCode).toBe(400)
  })

  it('accepts the known scale types', async () => {
    for (const scaleType of ['single_choice', 'multi_choice', 'frequency', 'ordinal', 'categorical']) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/questionnaires',
        cookies: cookie,
        payload: { name: 'Q-' + scaleType, questions: [{ text: 'Q?', options: ['a', 'b'], scaleType }] }
      })
      expect(res.statusCode, scaleType).toBe(200)
    }
  })
})
