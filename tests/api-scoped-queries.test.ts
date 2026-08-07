import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { createDb, type Db } from '../src/db.js'
import { buildServer } from '../src/server.js'
import type { ChatClient, ChatResult } from '../src/openrouter.js'
import type { AppConfig } from '../src/config.js'

/**
 * Issue #11: a detail view must not download whole collections to show one item,
 * and a list endpoint must not scan a table that has nothing to do with the rows
 * it returns. On a Raspberry Pi this degrades linearly with the research corpus.
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
      content: '{"A": 1}', modelVersion: model, promptTokens: 1, completionTokens: 1,
      cachedTokens: 0, cacheDiscountUsd: 0, provider: null, costUsd: 0, requestId: null, latencyMs: 1
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

/** Two projects plus a global questionnaire, so filtering has something to get wrong. */
function seed(): void {
  db.prepare('INSERT INTO projects (id, name, application_domain) VALUES (?,?,?)').run('p1', 'Startlap', 'Hírportál')
  db.prepare('INSERT INTO projects (id, name) VALUES (?,?)').run('p2', 'Másik projekt')
  for (const [id, project, name] of [
    ['qn1', 'p1', 'Első kérdőív'],
    ['qn2', 'p2', 'Másik kérdőív'],
    ['qn3', null, 'Globális kérdőív']
  ] as [string, string | null, string][]) {
    db.prepare('INSERT INTO questionnaires (id, project_id, lineage_id, name) VALUES (?,?,?,?)').run(id, project, id, name)
    db.prepare('INSERT INTO questions (id, questionnaire_id, ord, text, options_json) VALUES (?,?,?,?,?)').run(
      `${id}-q`, id, 0, `${name} kérdése?`, JSON.stringify(['A', 'B'])
    )
  }
  const config = JSON.stringify({ model: 'm1', temperature: 1, seeds: [0] })
  for (const [id, questionnaire, name] of [
    ['r1', 'qn1', 'Startlap futás'],
    ['r2', 'qn2', 'Másik futás'],
    ['r3', 'qn3', 'Globális futás']
  ] as [string, string, string][]) {
    db.prepare('INSERT INTO runs (id, questionnaire_id, name, config_json) VALUES (?,?,?,?)').run(id, questionnaire, name, config)
  }
}

beforeEach(async () => {
  db = createDb(':memory:')
  app = buildServer({ db, config: testConfig, models: testModels, client: new StubClient() })
  await app.ready()
  cookie = await login()
  seed()
})

afterEach(() => app.close())

describe('GET /api/projects/:id', () => {
  it('returns one project without the whole list', async () => {
    const res = await get('/api/projects/p1')
    expect(res.statusCode).toBe(200)
    expect(res.json().data).toMatchObject({ id: 'p1', name: 'Startlap', applicationDomain: 'Hírportál' })
  })

  it('404s on an unknown project', async () => {
    expect((await get('/api/projects/missing')).statusCode).toBe(404)
  })

  it('requires a session', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/projects/p1' })).statusCode).toBe(401)
  })
})

describe('GET /api/runs?project=', () => {
  // Runs belong to a project through their questionnaire; the filter has to make
  // that join, not return everything and hope the client sorts it out.
  it('returns only the runs of the project own questionnaires', async () => {
    const runs = (await get('/api/runs?project=p1')).json().data as { id: string }[]
    expect(runs.map((r) => r.id)).toEqual(['r1'])
  })

  it('excludes runs started on a global questionnaire, which belongs to no project', async () => {
    const runs = (await get('/api/runs?project=p2')).json().data as { id: string }[]
    expect(runs.map((r) => r.id)).toEqual(['r2'])
  })

  it('returns everything without the filter', async () => {
    const runs = (await get('/api/runs')).json().data as { id: string }[]
    expect(runs).toHaveLength(3)
  })

  it('returns nothing for an unknown project rather than everything', async () => {
    expect((await get('/api/runs?project=missing')).json().data).toEqual([])
  })

  // An empty value is a request for ONE project's runs, not for all of them.
  it('treats an empty project id as a filter, not as "no filter"', async () => {
    expect((await get('/api/runs?project=')).statusCode).toBe(400)
  })

  it('rejects a repeated project parameter instead of failing with a 500', async () => {
    expect((await get('/api/runs?project=p1&project=p2')).statusCode).toBe(400)
  })

  // A run points at the exact questionnaire VERSION that was used. When that
  // version is superseded the run still belongs to the project — the client-side
  // filter it replaces used latest-version ids and silently hid such runs.
  it('keeps a run on a superseded questionnaire version under its project', async () => {
    db.prepare('INSERT INTO questionnaires (id, project_id, lineage_id, name, version) VALUES (?,?,?,?,?)').run(
      'qn1v2', 'p1', 'qn1', 'Első kérdőív', 2
    )
    db.prepare('INSERT INTO runs (id, questionnaire_id, name, config_json) VALUES (?,?,?,?)').run(
      'r4', 'qn1v2', 'Újabb futás', JSON.stringify({ model: 'm1', temperature: 1, seeds: [0] })
    )
    const runs = (await get('/api/runs?project=p1')).json().data as { id: string }[]
    expect(runs.map((r) => r.id).sort()).toEqual(['r1', 'r4'])
  })

  // The join must filter and nothing else: a duplicated row or a swallowed
  // aggregate would misreport how much data a run actually holds.
  it('carries the response counts through the join, one row per run', async () => {
    db.prepare(
      `INSERT INTO responses (id, run_id, persona_id, question_id, model_requested, temperature, seed,
         permutation_json, prompt_rendered, raw_response, is_valid)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    ).run('resp1', 'r1', null, 'qn1-q', 'm1', 1, 0, '[0,1]', 'p', 'r', 0)
    const filtered = (await get('/api/runs?project=p1')).json().data as {
      id: string
      response_count: number
      invalid_count: number
    }[]
    expect(filtered).toHaveLength(1)
    expect(filtered[0]).toMatchObject({ id: 'r1', response_count: 1, invalid_count: 1 })
  })
})

describe('GET /api/questionnaires', () => {
  it('carries the questions of each returned questionnaire, and no others', async () => {
    const data = (await get('/api/questionnaires?project=p1')).json().data as {
      id: string
      questions: { text: string }[]
    }[]
    // the project own questionnaire plus the global one
    expect(data.map((q) => q.id).sort()).toEqual(['qn1', 'qn3'])
    for (const questionnaire of data) {
      expect(questionnaire.questions).toHaveLength(1)
      expect(questionnaire.questions[0]!.text).toContain('kérdése?')
    }
    // no question from the other project leaked in
    expect(JSON.stringify(data)).not.toContain('Másik kérdőív kérdése')
  })

  it('returns an empty question list for a questionnaire that has none', async () => {
    db.prepare('INSERT INTO questionnaires (id, project_id, lineage_id, name) VALUES (?,?,?,?)').run(
      'qn4', 'p1', 'qn4', 'Üres kérdőív'
    )
    const data = (await get('/api/questionnaires?project=p1')).json().data as { id: string; questions: unknown[] }[]
    expect(data.find((q) => q.id === 'qn4')!.questions).toEqual([])
  })
})
