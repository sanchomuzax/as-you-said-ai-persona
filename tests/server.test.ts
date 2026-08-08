import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { createDb, type Db } from '../src/db.js'
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
      cachedTokens: 0,
      cacheDiscountUsd: 0,
      provider: null,
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

// A completed run is the only thing a model-profile calibration can be built from
// (POST /api/model-profiles rejects anything else). Stop must not be able to demote
// a completed run to 'stopped' — that would silently destroy an already-paid-for
// calibration with no undo. Same reasoning protects an already-stopped run.
describe('POST /api/runs/:id/stop', () => {
  let db: Db
  let server: FastifyInstance
  let c: { asys_session: string }

  beforeEach(async () => {
    db = createDb(':memory:')
    server = buildServer({ db, config: testConfig, models: testModels, client: new StubClient() })
    await server.ready()
    c = await login(server)
    db.prepare('INSERT INTO questionnaires (id, name) VALUES (?,?)').run('q1', 'Q')
  })

  afterEach(() => server.close())

  function insertRun(id: string, status: string): void {
    db.prepare("INSERT INTO runs (id, questionnaire_id, name, status, config_json) VALUES (?,?,?,?,?)").run(
      id, 'q1', id, status, JSON.stringify({ model: 'm', temperature: 1, seeds: [0] })
    )
  }

  function statusOf(id: string): string {
    return (db.prepare('SELECT status FROM runs WHERE id = ?').get(id) as { status: string }).status
  }

  it('refuses to stop a completed run and leaves it completed', async () => {
    insertRun('r1', 'completed')
    const res = await server.inject({ method: 'POST', url: '/api/runs/r1/stop', cookies: c })
    expect(res.statusCode).toBe(400)
    expect(res.json().success).toBe(false)
    expect(statusOf('r1')).toBe('completed')
  })

  it('refuses to stop an already-stopped run and leaves it stopped', async () => {
    insertRun('r2', 'stopped')
    const res = await server.inject({ method: 'POST', url: '/api/runs/r2/stop', cookies: c })
    expect(res.statusCode).toBe(400)
    expect(res.json().success).toBe(false)
    expect(statusOf('r2')).toBe('stopped')
  })

  it('still allows stopping a running run', async () => {
    insertRun('r3', 'running')
    const res = await server.inject({ method: 'POST', url: '/api/runs/r3/stop', cookies: c })
    expect(res.statusCode).toBe(200)
    expect(res.json().success).toBe(true)
  })

  it.each(['pending', 'paused', 'failed', 'budget_exhausted'])(
    'still allows stopping a %s run',
    async (initialStatus) => {
      const id = `r-${initialStatus}`
      insertRun(id, initialStatus)
      const res = await server.inject({ method: 'POST', url: `/api/runs/${id}/stop`, cookies: c })
      expect(res.statusCode).toBe(200)
      expect(res.json().success).toBe(true)
      expect(statusOf(id)).toBe('stopped')
    }
  )
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
    expect(res.json().error).toContain('Ismeretlen projekt')
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
    // 2 options -> 2 rotations x 1 seed, once for the persona and once for the
    // persona-free control arm, which is on by default
    expect(data.responses.length).toBe(4)
    expect(data.responses.filter((r: { condition: string }) => r.condition === 'baseline')).toHaveLength(2)
    expect(data.usage.totalTokens).toBe(60)

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
    expect(res.json().error).toContain('Ismeretlen modell')
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

describe('evaluation coverage snapshot', () => {
  it('snapshots coverage BEFORE the model call, not after it', async () => {
    const db = createDb(':memory:')
    db.prepare('INSERT INTO questionnaires (id, name) VALUES (?,?)').run('q', 'Q')
    db.prepare('INSERT INTO questions (id, questionnaire_id, ord, text, options_json) VALUES (?,?,0,?,?)').run(
      'qq', 'q', 'Q?', JSON.stringify(['a', 'b'])
    )
    db.prepare('INSERT INTO personas (id, name, demographics_json) VALUES (?,?,?)').run('p', 'P', '{}')
    db.prepare("INSERT INTO runs (id, questionnaire_id, name, status, config_json) VALUES (?,?,?,'paused',?)").run(
      'run', 'q', 'R', JSON.stringify({ model: 'm', temperature: 1, seeds: [0] })
    )
    db.prepare('INSERT INTO run_personas (run_id, persona_id) VALUES (?,?)').run('run', 'p')
    let cellSeed = 0
    const insertResponse = (id: string): void => {
      db.prepare(
        `INSERT INTO responses (id, run_id, persona_id, question_id, model_requested, temperature, seed,
           permutation_json, prompt_rendered, raw_response, parsed_distribution_json, parsed_answer, is_valid, abstained)
         VALUES (?,'run','p','qq','m',1,?,?,'p','r','{"0":0.6,"1":0.4}','0',1,0)`
      ).run(id, cellSeed++, JSON.stringify([0, 1]))
    }
    insertResponse('first')

    // The run keeps working while the judge call is in flight: by the time it
    // returns, the run is finished. The snapshot must describe what was evaluated.
    const racingClient: ChatClient = {
      async complete(model: string): Promise<ChatResult> {
        insertResponse('second')
        db.prepare("UPDATE runs SET status = 'completed' WHERE id = 'run'").run()
        return {
          content: 'ok', modelVersion: model, provider: null, promptTokens: 1, completionTokens: 1,
          cachedTokens: 0, cacheDiscountUsd: 0, costUsd: 0, requestId: null, latencyMs: 1
        }
      }
    }
    const server = buildServer({ db, config: testConfig, models: testModels, client: racingClient })
    await server.ready()
    const c = await login(server)
    await server.inject({ method: 'POST', url: '/api/runs/run/evaluate', cookies: c })

    const ev = (await server.inject({ method: 'GET', url: '/api/runs/run/evaluations', cookies: c })).json().data[0]
    expect(ev.run_status).toBe('paused')
    expect(ev.done_cells).toBe(1)
    await server.close()
  })

  async function makeRun(): Promise<string> {
    const projectId = (await app.inject({ method: 'POST', url: '/api/projects', cookies: cookie, payload: { name: 'P' } })).json().data.id
    const personaId = (await app.inject({
      method: 'POST', url: '/api/personas', cookies: cookie, payload: { projectId, name: 'P1', demographics: {} }
    })).json().data.id
    const questionnaireId = (await app.inject({
      method: 'POST', url: '/api/questionnaires', cookies: cookie,
      payload: { name: 'Q', questions: [{ text: 'Q?', options: ['a', 'b'] }] }
    })).json().data.id
    const runId = (await app.inject({
      method: 'POST', url: '/api/runs', cookies: cookie,
      payload: { name: 'R', questionnaireId, personaIds: [personaId], seeds: [0] }
    })).json().data.id
    await new Promise((r) => setTimeout(r, 60))
    return runId
  }

  it('records how much of the run the evaluation actually covered', async () => {
    const runId = await makeRun()
    await app.inject({ method: 'POST', url: `/api/runs/${runId}/evaluate`, cookies: cookie })
    const evaluations = (await app.inject({ method: 'GET', url: `/api/runs/${runId}/evaluations`, cookies: cookie })).json().data
    expect(evaluations[0].run_status).toBe('completed')
    // persona cells + the control arm's cells
    expect(evaluations[0].done_cells).toBe(4)
  })

  it('marks an evaluation made while the run was still unfinished', async () => {
    const db = createDb(':memory:')
    db.prepare('INSERT INTO questionnaires (id, name) VALUES (?,?)').run('q', 'Q')
    db.prepare('INSERT INTO questions (id, questionnaire_id, ord, text, options_json) VALUES (?,?,0,?,?)').run(
      'qq', 'q', 'Q?', JSON.stringify(['a', 'b'])
    )
    db.prepare('INSERT INTO personas (id, name, demographics_json) VALUES (?,?,?)').run('p', 'P', '{}')
    db.prepare("INSERT INTO runs (id, questionnaire_id, name, status, config_json) VALUES (?,?,?,'paused',?)").run(
      'run', 'q', 'R', JSON.stringify({ model: 'm', temperature: 1, seeds: [0] })
    )
    db.prepare('INSERT INTO run_personas (run_id, persona_id) VALUES (?,?)').run('run', 'p')
    db.prepare(
      `INSERT INTO responses (id, run_id, persona_id, question_id, model_requested, temperature, seed,
         permutation_json, prompt_rendered, raw_response, parsed_distribution_json, parsed_answer, is_valid, abstained)
       VALUES ('x','run','p','qq','m',1,0,?,'p','r','{"0":0.6,"1":0.4}','0',1,0)`
    ).run(JSON.stringify([0, 1]))

    const server = buildServer({ db, config: testConfig, models: testModels, client: new StubClient() })
    await server.ready()
    const partialCookie = await login(server)
    await server.inject({ method: 'POST', url: '/api/runs/run/evaluate', cookies: partialCookie })

    const evaluations = (await server.inject({ method: 'GET', url: '/api/runs/run/evaluations', cookies: partialCookie })).json().data
    expect(evaluations[0].run_status).toBe('paused')
    expect(evaluations[0].done_cells).toBe(1)
    expect(evaluations[0].total_cells).toBe(2)
    await server.close()
  })
})

describe('persona versioning', () => {
  async function makePersona(name = 'Anna'): Promise<{ projectId: string; personaId: string }> {
    const projectId = (await app.inject({ method: 'POST', url: '/api/projects', cookies: cookie, payload: { name: 'P' } })).json().data.id
    const personaId = (await app.inject({
      method: 'POST', url: '/api/personas', cookies: cookie,
      payload: { projectId, name, demographics: { kor: '30' }, biography: 'Régi életrajz' }
    })).json().data.id
    return { projectId, personaId }
  }

  it('creates a new version instead of overwriting the persona a run referenced', async () => {
    const { personaId } = await makePersona()
    const created = await app.inject({
      method: 'POST', url: `/api/personas/${personaId}/versions`, cookies: cookie,
      payload: { name: 'Anna', demographics: { kor: '31' }, biography: 'Új életrajz' }
    })
    expect(created.statusCode).toBe(200)
    const newId = created.json().data.id
    expect(newId).not.toBe(personaId)

    const original = (await app.inject({ method: 'GET', url: `/api/personas/${personaId}/versions`, cookies: cookie })).json().data
    expect(original).toHaveLength(2)
    expect(original[0]).toMatchObject({ id: personaId, version: 1, demographics: { kor: '30' } })
    expect(original[1]).toMatchObject({ id: newId, version: 2, demographics: { kor: '31' } })
  })

  it('lists only the latest version of each persona', async () => {
    const { projectId, personaId } = await makePersona()
    await app.inject({
      method: 'POST', url: `/api/personas/${personaId}/versions`, cookies: cookie,
      payload: { name: 'Anna', demographics: { kor: '31' } }
    })
    const list = (await app.inject({ method: 'GET', url: `/api/personas?project=${projectId}`, cookies: cookie })).json().data
    expect(list).toHaveLength(1)
    expect(list[0].version).toBe(2)
    expect(list[0].isLatest).toBe(true)
  })

  it('keeps the version chain on the same lineage across several edits', async () => {
    const { personaId } = await makePersona()
    const v2 = (await app.inject({
      method: 'POST', url: `/api/personas/${personaId}/versions`, cookies: cookie, payload: { name: 'Anna', demographics: {} }
    })).json().data.id
    await app.inject({
      method: 'POST', url: `/api/personas/${v2}/versions`, cookies: cookie, payload: { name: 'Anna', demographics: {} }
    })
    // asking any version of the lineage returns the whole history
    const fromFirst = (await app.inject({ method: 'GET', url: `/api/personas/${personaId}/versions`, cookies: cookie })).json().data
    expect(fromFirst.map((p: { version: number }) => p.version)).toEqual([1, 2, 3])
  })

  it('reports that an older version is no longer the latest', async () => {
    const { personaId } = await makePersona()
    await app.inject({
      method: 'POST', url: `/api/personas/${personaId}/versions`, cookies: cookie, payload: { name: 'Anna', demographics: {} }
    })
    const versions = (await app.inject({ method: 'GET', url: `/api/personas/${personaId}/versions`, cookies: cookie })).json().data
    expect(versions[0].isLatest).toBe(false)
    expect(versions[1].isLatest).toBe(true)
  })

  it('rejects a new version of an unknown persona', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/personas/nope/versions', cookies: cookie, payload: { name: 'X', demographics: {} }
    })
    expect(res.statusCode).toBe(404)
  })
})

describe('questionnaire versioning', () => {
  const questions = [{ text: 'Q1?', options: ['a', 'b'] }]

  it('creates a new version with its own copy of the questions', async () => {
    const id = (await app.inject({
      method: 'POST', url: '/api/questionnaires', cookies: cookie, payload: { name: 'Q', questions }
    })).json().data.id
    const created = await app.inject({
      method: 'POST', url: `/api/questionnaires/${id}/versions`, cookies: cookie,
      payload: {
        name: 'Q',
        questions: [{ text: 'Q1 pontosítva?', options: ['a', 'b', 'c'], scaleType: 'single_choice', scaleDirection: 'ascending' }]
      }
    })
    expect(created.statusCode).toBe(200)

    const versions = (await app.inject({ method: 'GET', url: `/api/questionnaires/${id}/versions`, cookies: cookie })).json().data
    expect(versions).toHaveLength(2)
    expect(versions[0].questions[0].text).toBe('Q1?')
    expect(versions[1].questions[0].text).toBe('Q1 pontosítva?')
    expect(versions[1].version).toBe(2)
  })

  it('lists only the latest version', async () => {
    const id = (await app.inject({
      method: 'POST', url: '/api/questionnaires', cookies: cookie, payload: { name: 'Q', questions }
    })).json().data.id
    await app.inject({
      method: 'POST',
      url: `/api/questionnaires/${id}/versions`,
      cookies: cookie,
      payload: { name: 'Q v2', questions: questions.map((q) => ({ ...q, scaleType: 'single_choice', scaleDirection: 'ascending' })) }
    })
    const list = (await app.inject({ method: 'GET', url: '/api/questionnaires', cookies: cookie })).json().data
    expect(list).toHaveLength(1)
    expect(list[0].name).toBe('Q v2')
  })

  it('leaves a finished run pointing at the version it actually used', async () => {
    const projectId = (await app.inject({ method: 'POST', url: '/api/projects', cookies: cookie, payload: { name: 'P' } })).json().data.id
    const personaId = (await app.inject({
      method: 'POST', url: '/api/personas', cookies: cookie, payload: { projectId, name: 'P1', demographics: {} }
    })).json().data.id
    const questionnaireId = (await app.inject({
      method: 'POST', url: '/api/questionnaires', cookies: cookie, payload: { name: 'Q', questions }
    })).json().data.id
    const runId = (await app.inject({
      method: 'POST', url: '/api/runs', cookies: cookie,
      payload: { name: 'R', questionnaireId, personaIds: [personaId], seeds: [0] }
    })).json().data.id
    await new Promise((r) => setTimeout(r, 60))

    await app.inject({
      method: 'POST', url: `/api/questionnaires/${questionnaireId}/versions`, cookies: cookie,
      payload: {
        name: 'Q',
        questions: [{ text: 'Teljesen más kérdés?', options: ['x', 'y'], scaleType: 'single_choice', scaleDirection: 'ascending' }]
      }
    })
    await app.inject({
      method: 'POST', url: `/api/personas/${personaId}/versions`, cookies: cookie,
      payload: { name: 'P1', demographics: { kor: '99' } }
    })

    const detail = (await app.inject({ method: 'GET', url: `/api/runs/${runId}`, cookies: cookie })).json().data
    expect(detail.responses[0].question_text).toBe('Q1?')
    // and the run says its inputs have moved on since
    expect(detail.staleVersions.questionnaire).toEqual({ used: 1, latest: 2 })
    expect(detail.staleVersions.personas).toEqual([{ id: personaId, name: 'P1', version: 1, latestVersion: 2 }])
  })
})

describe('provider pinning and provider spread', () => {
  async function runWith(payloadExtra: Record<string, unknown>): Promise<string> {
    const projectId = (await app.inject({ method: 'POST', url: '/api/projects', cookies: cookie, payload: { name: 'P' } })).json().data.id
    const personaId = (await app.inject({
      method: 'POST', url: '/api/personas', cookies: cookie, payload: { projectId, name: 'P1', demographics: {} }
    })).json().data.id
    const questionnaireId = (await app.inject({
      method: 'POST', url: '/api/questionnaires', cookies: cookie, payload: { name: 'Q', questions: [{ text: 'Q?', options: ['a', 'b'] }] }
    })).json().data.id
    const res = await app.inject({
      method: 'POST', url: '/api/runs', cookies: cookie,
      payload: { name: 'R', questionnaireId, personaIds: [personaId], seeds: [0], ...payloadExtra }
    })
    expect(res.statusCode).toBe(200)
    await new Promise((r) => setTimeout(r, 60))
    return res.json().data.id
  }

  it('records the pinned provider as part of the run configuration', async () => {
    const runId = await runWith({ provider: 'DeepInfra' })
    const detail = (await app.inject({ method: 'GET', url: `/api/runs/${runId}`, cookies: cookie })).json().data
    expect(JSON.parse(detail.run.config_json).provider).toBe('DeepInfra')
  })

  it('reports how many providers actually served a run', async () => {
    const runId = await runWith({})
    const progress = (await app.inject({ method: 'GET', url: `/api/runs/${runId}/progress`, cookies: cookie })).json().data
    // the stub reports no provider, so nothing to warn about
    expect(progress.providers).toEqual([])

    // a run served by two providers is a reproducibility warning
    const detailBefore = (await app.inject({ method: 'GET', url: `/api/runs/${runId}`, cookies: cookie })).json().data
    expect(detailBefore.responses.length).toBeGreaterThan(0)
  })
})

describe('version round-trip must not lose experimental settings', () => {
  it('matches referenced questions by API id when an earlier unreferenced question is deleted', async () => {
    const metadata = {
      _reference: { ertek: '60%', forras: 'KSH', ev: '2025', referenceShare: 0.6, optionIndexes: [0, 2] }
    }
    const created = await app.inject({
      method: 'POST', url: '/api/questionnaires', cookies: cookie,
      payload: {
        name: 'Két kérdés',
        questions: [
          { text: 'Törlendő Q1?', options: ['Igen', 'Nem'], scaleType: 'single_choice' },
          { text: 'Változatlan Q2?', options: ['Anna', 'Gábor', 'Judit', 'Péter'], scaleType: 'single_choice', metadata }
        ]
      }
    })
    const id = created.json().data.id
    // The client must use the stable source-question id returned by list/detail,
    // not infer identity from the array position after Q1 disappears.
    const detail = (await app.inject({ method: 'GET', url: `/api/questionnaires/${id}`, cookies: cookie })).json().data
    const q2 = detail.questions[1]
    expect(q2.id).toEqual(expect.any(String))

    const version = await app.inject({
      method: 'POST', url: `/api/questionnaires/${id}/versions`, cookies: cookie,
      payload: { name: 'Csak Q2', questions: [q2] }
    })
    expect(version.statusCode).toBe(200)
    const versions = (await app.inject({ method: 'GET', url: `/api/questionnaires/${id}/versions`, cookies: cookie })).json().data
    expect(versions[1].questions).toHaveLength(1)
    expect(versions[1].questions[0]).toMatchObject({
      text: 'Változatlan Q2?',
      options: ['Anna', 'Gábor', 'Judit', 'Péter'],
      metadata
    })
  })

  it('blocks deleting or rewriting options while preserving stale reference optionIndexes', async () => {
    const metadata = {
      _reference: { ertek: '60%', forras: 'KSH', ev: '2025', referenceShare: 0.6, optionIndexes: [0, 2] }
    }
    for (const [name, options] of [
      ['Opciótörlés', ['Anna', 'Gábor']],
      ['Opcióátírás', ['Más személy', 'Gábor', 'Judit', 'Péter']]
    ] as const) {
      const id = (await app.inject({
        method: 'POST', url: '/api/questionnaires', cookies: cookie,
        payload: {
          name,
          questions: [{ text: 'Ki szerepel?', options: ['Anna', 'Gábor', 'Judit', 'Péter'], scaleType: 'single_choice', metadata }]
        }
      })).json().data.id
      const changed = await app.inject({
        method: 'POST', url: `/api/questionnaires/${id}/versions`, cookies: cookie,
        payload: {
          name,
          questions: [{ text: 'Ki szerepel?', options, scaleType: 'single_choice', scaleDirection: 'ascending', metadata }]
        }
      })
      expect(changed.statusCode, name).toBe(400)
      expect(changed.json().error, name).toMatch(/referencia|metaadat|opció/i)
    }
  })

  it.each([
    {
      name: 'ismeretlen question.id',
      payload: (q1: Record<string, unknown>, q2: Record<string, unknown>) => ({
        questions: [{ ...q2, id: 'ismeretlen-kérdés', options: ['Más személy', 'Gábor', 'Judit', 'Péter'] }]
      })
    },
    {
      name: 'részleges sourceQuestionIds',
      payload: (q1: Record<string, unknown>, q2: Record<string, unknown>) => ({
        sourceQuestionIds: [q1['id']],
        questions: [{ ...q2, id: undefined, options: ['Más személy', 'Gábor', 'Judit', 'Péter'] }]
      })
    },
    {
      name: 'duplikált question.id',
      payload: (_q1: Record<string, unknown>, q2: Record<string, unknown>) => ({
        questions: [
          q2,
          { ...q2, options: ['Más személy', 'Gábor', 'Judit', 'Péter'] }
        ]
      })
    }
  ])('rejects $name instead of letting modified reference options bypass protection', async ({ name, payload }) => {
    const metadata = {
      _reference: { ertek: '60%', forras: 'KSH', ev: '2025', referenceShare: 0.6, optionIndexes: [0, 2] }
    }
    const id = (await app.inject({
      method: 'POST', url: '/api/questionnaires', cookies: cookie,
      payload: {
        name: `Azonosító-védelem — ${name}`,
        questions: [
          { text: 'Q1 metaadat nélkül?', options: ['Igen', 'Nem'], scaleType: 'single_choice' },
          { text: 'Q2 referenciával?', options: ['Anna', 'Gábor', 'Judit', 'Péter'], scaleType: 'single_choice', metadata }
        ]
      }
    })).json().data.id
    const source = (await app.inject({ method: 'GET', url: `/api/questionnaires/${id}`, cookies: cookie })).json().data
    const body = payload(source.questions[0], source.questions[1])

    const changed = await app.inject({
      method: 'POST', url: `/api/questionnaires/${id}/versions`, cookies: cookie,
      payload: { name: source.name, ...body }
    })
    expect(changed.statusCode).toBe(400)
    expect(changed.json().error).toMatch(/kérdés|azonosító|referencia|opció/i)
  })

  it('keeps question metadata through questionnaire list, detail and version APIs', async () => {
    const metadata = {
      _scope: 'lokális',
      _tier: 'gyenge',
      _torzitas: 'tekintélytorzítás',
      _reference: {
        mit: 'nőarány', ertek: '60%', forras: 'KSH', ev: '2025',
        referenceShare: 0.6, optionIndexes: [0, 2]
      }
    }
    const created = await app.inject({
      method: 'POST', url: '/api/questionnaires', cookies: cookie,
      payload: {
        name: 'Referenciás',
        questions: [{ text: 'Ki szerepel?', options: ['Anna', 'Gábor', 'Judit', 'Péter'], scaleType: 'single_choice', metadata }]
      }
    })
    expect(created.statusCode).toBe(200)
    const id = created.json().data.id

    const listed = (await app.inject({ method: 'GET', url: '/api/questionnaires', cookies: cookie })).json().data[0]
    const detail = (await app.inject({ method: 'GET', url: `/api/questionnaires/${id}`, cookies: cookie })).json().data
    expect(listed.questions[0].metadata).toEqual(metadata)
    expect(detail.questions[0].metadata).toEqual(metadata)

    const version = await app.inject({
      method: 'POST', url: `/api/questionnaires/${id}/versions`, cookies: cookie,
      payload: { name: 'Referenciás', questions: listed.questions }
    })
    expect(version.statusCode).toBe(200)
    const versions = (await app.inject({ method: 'GET', url: `/api/questionnaires/${id}/versions`, cookies: cookie })).json().data
    expect(versions[1].questions[0].metadata).toEqual(metadata)
  })

  it('keeps every question type and scale direction when a version is created', async () => {
    const created = await app.inject({
      method: 'POST', url: '/api/questionnaires', cookies: cookie,
      payload: {
        name: 'Vegyes',
        questions: [
          { text: 'Melyekből?', options: ['a', 'b'], scaleType: 'multi_choice' },
          { text: 'Milyen gyakran?', options: ['x', 'y'], scaleType: 'frequency', scaleDirection: 'descending' }
        ]
      }
    })
    const id = created.json().data.id
    const listed = (await app.inject({ method: 'GET', url: '/api/questionnaires', cookies: cookie })).json().data[0]
    // the list must expose the settings, otherwise an edit form cannot carry them back
    expect(listed.questions[0]).toMatchObject({ scaleType: 'multi_choice', scaleDirection: 'ascending' })
    expect(listed.questions[1]).toMatchObject({ scaleType: 'frequency', scaleDirection: 'descending' })

    const version = await app.inject({
      method: 'POST', url: `/api/questionnaires/${id}/versions`, cookies: cookie,
      payload: { name: 'Vegyes', questions: listed.questions }
    })
    expect(version.statusCode).toBe(200)
    const versions = (await app.inject({ method: 'GET', url: `/api/questionnaires/${id}/versions`, cookies: cookie })).json().data
    expect(versions[1].questions[0]).toMatchObject({ scaleType: 'multi_choice', scaleDirection: 'ascending' })
    expect(versions[1].questions[1]).toMatchObject({ scaleType: 'frequency', scaleDirection: 'descending' })
  })

  it('refuses a version whose questions omit the type instead of silently defaulting it', async () => {
    const id = (await app.inject({
      method: 'POST', url: '/api/questionnaires', cookies: cookie,
      payload: { name: 'Q', questions: [{ text: 'Melyekből?', options: ['a', 'b'], scaleType: 'multi_choice' }] }
    })).json().data.id
    const res = await app.inject({
      method: 'POST', url: `/api/questionnaires/${id}/versions`, cookies: cookie,
      payload: { name: 'Q', questions: [{ text: 'Melyekből?', options: ['a', 'b'] }] }
    })
    expect(res.statusCode).toBe(400)
  })

  it('keeps the rendering style when a persona version omits it', async () => {
    const projectId = (await app.inject({ method: 'POST', url: '/api/projects', cookies: cookie, payload: { name: 'P' } })).json().data.id
    const personaId = (await app.inject({
      method: 'POST', url: '/api/personas', cookies: cookie,
      payload: { projectId, name: 'A', demographics: {}, renderingStyle: 'natural_language_sentence' }
    })).json().data.id
    await app.inject({
      method: 'POST', url: `/api/personas/${personaId}/versions`, cookies: cookie,
      payload: { name: 'A', demographics: { kor: '30' } }
    })
    const versions = (await app.inject({ method: 'GET', url: `/api/personas/${personaId}/versions`, cookies: cookie })).json().data
    // inheriting beats defaulting: the rendering style is an experimental variable
    expect(versions[1].renderingStyle).toBe('natural_language_sentence')
  })
})

describe('older versions stay reachable', () => {
  it('serves a superseded persona by id, flagged as not latest', async () => {
    const projectId = (await app.inject({ method: 'POST', url: '/api/projects', cookies: cookie, payload: { name: 'P' } })).json().data.id
    const id = (await app.inject({
      method: 'POST', url: '/api/personas', cookies: cookie, payload: { projectId, name: 'A', demographics: {} }
    })).json().data.id
    await app.inject({ method: 'POST', url: `/api/personas/${id}/versions`, cookies: cookie, payload: { name: 'A', demographics: {} } })

    const res = await app.inject({ method: 'GET', url: `/api/personas/${id}`, cookies: cookie })
    expect(res.statusCode).toBe(200)
    expect(res.json().data).toMatchObject({ id, version: 1, isLatest: false })
  })

  it('serves a superseded questionnaire by id with its own questions', async () => {
    const id = (await app.inject({
      method: 'POST', url: '/api/questionnaires', cookies: cookie,
      payload: { name: 'Q', questions: [{ text: 'Régi?', options: ['a', 'b'], scaleType: 'single_choice' }] }
    })).json().data.id
    await app.inject({
      method: 'POST', url: `/api/questionnaires/${id}/versions`, cookies: cookie,
      payload: { name: 'Q', questions: [{ text: 'Új?', options: ['a', 'b'], scaleType: 'single_choice', scaleDirection: 'ascending' }] }
    })
    const res = await app.inject({ method: 'GET', url: `/api/questionnaires/${id}`, cookies: cookie })
    expect(res.json().data).toMatchObject({ id, version: 1, isLatest: false })
    expect(res.json().data.questions[0].text).toBe('Régi?')
  })

  it('rejects a corrupt lineage instead of creating a second version 1', async () => {
    const db = createDb(':memory:')
    db.prepare('INSERT INTO personas (id, name, demographics_json, lineage_id) VALUES (?,?,?,NULL)').run('legacy', 'L', '{}')
    const server = buildServer({ db, config: testConfig, models: testModels, client: new StubClient() })
    await server.ready()
    const c = await login(server)
    const res = await server.inject({
      method: 'POST', url: '/api/personas/legacy/versions', cookies: c, payload: { name: 'L', demographics: {} }
    })
    expect(res.statusCode).toBe(500)
    const rows = db.prepare('SELECT COUNT(*) c FROM personas').get() as { c: number }
    expect(rows.c).toBe(1)
    await server.close()
  })
})

describe('response provenance', () => {
  async function makeRunWithResponse(): Promise<{ runId: string; responseId: string }> {
    const projectId = (await app.inject({ method: 'POST', url: '/api/projects', cookies: cookie, payload: { name: 'P' } })).json().data.id
    const personaId = (await app.inject({
      method: 'POST', url: '/api/personas', cookies: cookie, payload: { projectId, name: 'P1', demographics: { kor: '30' } }
    })).json().data.id
    const questionnaireId = (await app.inject({
      method: 'POST', url: '/api/questionnaires', cookies: cookie, payload: { name: 'Q', questions: [{ text: 'Q?', options: ['a', 'b'] }] }
    })).json().data.id
    const runId = (await app.inject({
      method: 'POST', url: '/api/runs', cookies: cookie,
      payload: { name: 'R', questionnaireId, personaIds: [personaId], seeds: [0] }
    })).json().data.id
    await new Promise((r) => setTimeout(r, 60))
    const detail = (await app.inject({ method: 'GET', url: `/api/runs/${runId}`, cookies: cookie })).json().data
    return { runId, responseId: detail.responses[0].id }
  }

  it('serves the exact prompt and raw output for one response', async () => {
    const { runId, responseId } = await makeRunWithResponse()
    const res = await app.inject({ method: 'GET', url: `/api/runs/${runId}/responses/${responseId}`, cookies: cookie })
    expect(res.statusCode).toBe(200)
    const data = res.json().data
    expect(data.prompt_rendered).toContain('kor: 30') // the persona as the model saw it
    expect(data.raw_response).toBe('{"A": 0.7, "B": 0.3}')
    expect(data.permutation_json).toBeTruthy()
    expect(data.temperature).toBeDefined()
    expect(data.question_text).toBe('Q?')
    expect(data.options_json).toBe(JSON.stringify(['a', 'b']))
    expect(data.persona_name).toBe('P1')
  })

  it('keeps the heavy fields out of the run response list', async () => {
    const { runId } = await makeRunWithResponse()
    const detail = (await app.inject({ method: 'GET', url: `/api/runs/${runId}`, cookies: cookie })).json().data
    // the list is polled during a run; prompts and raw outputs are fetched per row
    expect(detail.responses[0].prompt_rendered).toBeUndefined()
    expect(detail.responses[0].raw_response).toBeUndefined()
  })

  it('404s for a response that does not belong to the run', async () => {
    const { runId } = await makeRunWithResponse()
    const other = await makeRunWithResponse()
    const res = await app.inject({ method: 'GET', url: `/api/runs/${runId}/responses/${other.responseId}`, cookies: cookie })
    expect(res.statusCode).toBe(404)
  })

  it('requires a session', async () => {
    const { runId, responseId } = await makeRunWithResponse()
    const res = await app.inject({ method: 'GET', url: `/api/runs/${runId}/responses/${responseId}` })
    expect(res.statusCode).toBe(401)
  })
})
