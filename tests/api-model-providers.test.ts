import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { createDb, type Db } from '../src/db.js'
import { buildServer } from '../src/server.js'
import type { ChatClient, ChatResult, CatalogEndpoint } from '../src/openrouter.js'
import type { AppConfig } from '../src/config.js'

/**
 * Issue #28: GET /api/models/:model/providers — the data source behind the
 * provider dropdown. Merges responses.provider (what this deployment has
 * actually seen answer) with OpenRouter's live endpoint catalog when the
 * injected ChatClient supports it.
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

class StubClientNoCatalog implements ChatClient {
  async complete(model: string): Promise<ChatResult> {
    return {
      content: '{}', modelVersion: model, promptTokens: 0, completionTokens: 0, cachedTokens: 0,
      cacheDiscountUsd: 0, provider: null, costUsd: 0, requestId: null, latencyMs: 1
    }
  }
}

class StubClientWithCatalog extends StubClientNoCatalog {
  constructor(private readonly endpoints: CatalogEndpoint[]) {
    super()
  }
  async listEndpoints(): Promise<CatalogEndpoint[]> {
    return this.endpoints
  }
}

class StubClientCatalogFails extends StubClientNoCatalog {
  async listEndpoints(): Promise<CatalogEndpoint[]> {
    throw new Error('OpenRouter HTTP 503')
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

function seedResponse(provider: string | null): void {
  if (!db.prepare('SELECT id FROM questionnaires WHERE id = ?').get('q')) {
    db.prepare('INSERT INTO questionnaires (id, lineage_id, name) VALUES (?,?,?)').run('q', 'q', 'Q')
    db.prepare(
      'INSERT INTO questions (id, questionnaire_id, ord, text, scale_type, options_json, scale_direction) VALUES (?,?,?,?,?,?,?)'
    ).run('q1', 'q', 0, 'Kérdés?', 'nominal', JSON.stringify(['A', 'B']), 'ascending')
    db.prepare('INSERT INTO runs (id, questionnaire_id, name, config_json, status) VALUES (?,?,?,?,?)').run(
      'r', 'q', 'R', JSON.stringify({ model: 'm1', temperature: 1, seeds: [0] }), 'completed'
    )
  }
  db.prepare(
    `INSERT INTO responses (id, run_id, persona_id, question_id, condition, model_requested, model_version,
       provider, temperature, seed, permutation_json, prompt_rendered, raw_response,
       parsed_distribution_json, parsed_answer, elicitation_mode, is_valid, abstained, cost_usd)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    `resp-${Math.random()}`, 'r', null, 'q1', 'baseline', 'm1', 'm1-v1', provider, 1, 0,
    '[0,1]', 'p', 'r', JSON.stringify({ '0': 1, '1': 0 }), 'A', 'single_choice', 1, 0, 0
  )
}

afterEach(() => app?.close())

describe('GET /api/models/:model/providers', () => {
  it('rejects a model that is not in config/models.json', async () => {
    db = createDb(':memory:')
    app = buildServer({ db, config: testConfig, models: testModels, client: new StubClientNoCatalog() })
    await app.ready()
    cookie = await login()
    const res = await app.inject({ method: 'GET', url: '/api/models/ghost-model/providers', cookies: cookie })
    expect(res.statusCode).toBe(400)
  })

  it('returns an empty option list with no observed traffic and no catalog support', async () => {
    db = createDb(':memory:')
    app = buildServer({ db, config: testConfig, models: testModels, client: new StubClientNoCatalog() })
    await app.ready()
    cookie = await login()
    const res = await app.inject({ method: 'GET', url: '/api/models/m1/providers', cookies: cookie })
    expect(res.statusCode).toBe(200)
    const data = res.json().data
    expect(data.options).toEqual([])
    expect(data.catalogAvailable).toBe(false)
    expect(data.catalogError).toBe(false)
  })

  it('lists providers this model has actually been served by, most-seen first', async () => {
    db = createDb(':memory:')
    app = buildServer({ db, config: testConfig, models: testModels, client: new StubClientNoCatalog() })
    await app.ready()
    cookie = await login()
    seedResponse('DeepInfra')
    seedResponse('Fireworks')
    seedResponse('Fireworks')
    seedResponse(null) // unattributed calls must not become a provider named "null"
    const res = await app.inject({ method: 'GET', url: '/api/models/m1/providers', cookies: cookie })
    const data = res.json().data
    expect(data.options.map((o: { providerName: string }) => o.providerName)).toEqual(['Fireworks', 'DeepInfra'])
    expect(data.options[0]).toMatchObject({ observedCount: 2, source: 'observed' })
  })

  it('merges in the live catalog when the client supports it', async () => {
    db = createDb(':memory:')
    app = buildServer({
      db, config: testConfig, models: testModels,
      client: new StubClientWithCatalog([{ tag: 'deepinfra/fp4', providerName: 'DeepInfra', quantization: 'fp4' }])
    })
    await app.ready()
    cookie = await login()
    seedResponse('DeepInfra')
    const res = await app.inject({ method: 'GET', url: '/api/models/m1/providers', cookies: cookie })
    const data = res.json().data
    expect(data.catalogAvailable).toBe(true)
    expect(data.options).toEqual([
      { value: 'deepinfra/fp4', providerName: 'DeepInfra', quantization: 'fp4', observedCount: 1, source: 'both' }
    ])
  })

  it('degrades to the observed list, flagged, when the catalog fetch throws', async () => {
    db = createDb(':memory:')
    app = buildServer({ db, config: testConfig, models: testModels, client: new StubClientCatalogFails() })
    await app.ready()
    cookie = await login()
    seedResponse('DeepInfra')
    const res = await app.inject({ method: 'GET', url: '/api/models/m1/providers', cookies: cookie })
    expect(res.statusCode).toBe(200)
    const data = res.json().data
    expect(data.catalogAvailable).toBe(false)
    expect(data.catalogError).toBe(true)
    expect(data.options).toEqual([
      { value: 'DeepInfra', providerName: 'DeepInfra', quantization: null, observedCount: 1, source: 'observed' }
    ])
  })

  it('requires auth', async () => {
    db = createDb(':memory:')
    app = buildServer({ db, config: testConfig, models: testModels, client: new StubClientNoCatalog() })
    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/api/models/m1/providers' })
    expect(res.statusCode).toBe(401)
  })
})
