import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { createDb, type Db } from '../src/db.js'
import { buildServer } from '../src/server.js'
import type { ChatClient, ChatResult } from '../src/openrouter.js'
import type { AppConfig } from '../src/config.js'

/**
 * Issue #33 requirements 1, 2 and 5: the elicitation template language
 * defaults to the questionnaire's own language (no form the researcher has to
 * fill in), is recorded on the run so it is auditable, and CAN be overridden
 * explicitly — the design permits a future HU-vs-EN comparison without this
 * change implementing that research itself.
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
      content: '{"A": 0.5, "B": 0.5}', modelVersion: model, promptTokens: 10, completionTokens: 5,
      cachedTokens: 0, cacheDiscountUsd: 0, provider: null, costUsd: 0, requestId: 'r1', latencyMs: 1
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

beforeEach(async () => {
  db = createDb(':memory:')
  app = buildServer({ db, config: testConfig, models: testModels, client: new StubClient() })
  await app.ready()
  cookie = await login()
})

afterEach(() => app.close())

async function createQuestionnaire(language?: 'hu' | 'en'): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/questionnaires',
    cookies: cookie,
    payload: {
      name: 'Q',
      questions: [{ text: 'Bízik a bankokban?', options: ['Igen', 'Nem'] }],
      ...(language ? { language } : {})
    }
  })
  expect(res.statusCode).toBe(200)
  return res.json().data.id as string
}

async function createPersona(): Promise<string> {
  const project = await app.inject({ method: 'POST', url: '/api/projects', cookies: cookie, payload: { name: 'Proj' } })
  const projectId = project.json().data.id as string
  const res = await app.inject({
    method: 'POST', url: '/api/personas', cookies: cookie,
    payload: { projectId, name: 'P1', demographics: { kor: 40 }, renderingStyle: 'bulleted_profile' }
  })
  return res.json().data.id as string
}

function runConfigOf(runId: string): Record<string, unknown> {
  const row = db.prepare('SELECT config_json FROM runs WHERE id = ?').get(runId) as { config_json: string }
  return JSON.parse(row.config_json) as Record<string, unknown>
}

describe('POST /api/questionnaires — language', () => {
  it('defaults a new questionnaire to hu', async () => {
    const id = await createQuestionnaire()
    const row = db.prepare('SELECT language FROM questionnaires WHERE id = ?').get(id) as { language: string }
    expect(row.language).toBe('hu')
  })

  it('accepts an explicit language', async () => {
    const id = await createQuestionnaire('en')
    const row = db.prepare('SELECT language FROM questionnaires WHERE id = ?').get(id) as { language: string }
    expect(row.language).toBe('en')
  })

  it('surfaces the language on GET /api/questionnaires', async () => {
    await createQuestionnaire('en')
    const res = await app.inject({ method: 'GET', url: '/api/questionnaires', cookies: cookie })
    const data = res.json().data as { language: string }[]
    expect(data[0]!.language).toBe('en')
  })
})

describe('POST /api/runs — templateLanguage default', () => {
  it('derives templateLanguage from the questionnaire when not given', async () => {
    const questionnaireId = await createQuestionnaire('hu')
    const personaId = await createPersona()
    const run = await app.inject({
      method: 'POST', url: '/api/runs', cookies: cookie,
      payload: { name: 'R', questionnaireId, personaIds: [personaId], seeds: [0] }
    })
    expect(run.statusCode).toBe(200)
    expect(runConfigOf(run.json().data.id)['templateLanguage']).toBe('hu')
  })

  it('follows an English questionnaire to an English template by default', async () => {
    const questionnaireId = await createQuestionnaire('en')
    const personaId = await createPersona()
    const run = await app.inject({
      method: 'POST', url: '/api/runs', cookies: cookie,
      payload: { name: 'R', questionnaireId, personaIds: [personaId], seeds: [0] }
    })
    expect(runConfigOf(run.json().data.id)['templateLanguage']).toBe('en')
  })

  it('honours an explicit override even against the questionnaire language — the comparison hook', async () => {
    const questionnaireId = await createQuestionnaire('hu')
    const personaId = await createPersona()
    const run = await app.inject({
      method: 'POST', url: '/api/runs', cookies: cookie,
      payload: { name: 'R', questionnaireId, personaIds: [personaId], seeds: [0], templateLanguage: 'en' }
    })
    expect(runConfigOf(run.json().data.id)['templateLanguage']).toBe('en')
  })
})

describe('POST /api/models/:model/calibrate — templateLanguage', () => {
  it('derives templateLanguage from the probe questionnaire', async () => {
    const questionnaireId = await createQuestionnaire('hu')
    const res = await app.inject({
      method: 'POST', url: '/api/models/m1/calibrate', cookies: cookie,
      payload: { questionnaireId, seeds: [0] }
    })
    expect(res.statusCode).toBe(200)
    expect(runConfigOf(res.json().data.runId)['templateLanguage']).toBe('hu')
  })
})
