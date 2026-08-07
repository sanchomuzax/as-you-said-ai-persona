import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { createDb, type Db } from '../src/db.js'
import { buildServer } from '../src/server.js'
import { computeRunResults } from '../src/lib/results.js'
import type { ChatClient, ChatMessage, ChatResult } from '../src/openrouter.js'
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

class InterviewClient implements ChatClient {
  lastMessages: readonly ChatMessage[] | string = ''
  reply = 'Hetente nézem az akciós újságokat.'
  /** Held open by a test that needs two turns to overlap. */
  gate: Promise<void> | null = null

  async complete(
    model: string,
    prompt: string | readonly ChatMessage[]
  ): Promise<ChatResult> {
    if (this.gate) await this.gate
    this.lastMessages = prompt
    return {
      content: this.reply,
      modelVersion: `${model}-2026-05`,
      promptTokens: 40,
      completionTokens: 12,
      cachedTokens: 8,
      cacheDiscountUsd: 0.0001,
      provider: 'DeepInfra',
      costUsd: 0.002,
      requestId: 'req-1',
      latencyMs: 123
    }
  }
}

let app: FastifyInstance
let db: Db
let client: InterviewClient
let cookie: { asys_session: string }

async function login(): Promise<{ asys_session: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/login',
    payload: { username: 'admin', password: 'test-password-123' }
  })
  const token = /asys_session=([^;]+)/.exec(res.headers['set-cookie'] as string)![1]!
  return { asys_session: token }
}

function seedPersona(): { projectId: string; personaId: string } {
  db.prepare('INSERT INTO projects (id, name) VALUES (?,?)').run('proj', 'Startlap')
  db.prepare(
    'INSERT INTO personas (id, project_id, lineage_id, name, demographics_json, biography) VALUES (?,?,?,?,?,?)'
  ).run('persona-1', 'proj', 'persona-1', 'Anna', JSON.stringify({ kor: 34 }), 'Két gyerek mellett dolgozik.')
  return { projectId: 'proj', personaId: 'persona-1' }
}

async function createInterview(personaId = 'persona-1', projectId = 'proj'): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/interviews',
    cookies: cookie,
    payload: { projectId, personaId, title: 'Feltáró beszélgetés', seed: 7, temperature: 0.8 }
  })
  expect(res.statusCode).toBe(200)
  return res.json().data.id as string
}

async function ask(interviewId: string, content: string): Promise<ReturnType<FastifyInstance['inject']>> {
  return app.inject({
    method: 'POST',
    url: `/api/interviews/${interviewId}/messages`,
    cookies: cookie,
    payload: { content }
  })
}

beforeEach(async () => {
  db = createDb(':memory:')
  client = new InterviewClient()
  app = buildServer({ db, config: testConfig, models: testModels, client })
  await app.ready()
  cookie = await login()
  seedPersona()
})

afterEach(() => app.close())

describe('interview creation', () => {
  it('creates an interview for a persona', async () => {
    const id = await createInterview()
    const res = await app.inject({ method: 'GET', url: `/api/interviews/${id}`, cookies: cookie })
    expect(res.statusCode).toBe(200)
    const data = res.json().data
    expect(data.interview.title).toBe('Feltáró beszélgetés')
    expect(data.interview.personaName).toBe('Anna')
    expect(data.messages).toEqual([])
  })

  it('rejects an unknown persona', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/interviews',
      cookies: cookie,
      payload: { personaId: 'nope', title: 'X' }
    })
    expect(res.statusCode).toBe(400)
  })

  it('rejects an unknown model', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/interviews',
      cookies: cookie,
      payload: { personaId: 'persona-1', title: 'X', model: 'made/up' }
    })
    expect(res.statusCode).toBe(400)
  })

  it('lists interviews, newest first, filterable by project', async () => {
    await createInterview()
    const res = await app.inject({ method: 'GET', url: '/api/interviews?project=proj', cookies: cookie })
    expect(res.json().data).toHaveLength(1)
    const other = await app.inject({ method: 'GET', url: '/api/interviews?project=missing', cookies: cookie })
    expect(other.json().data).toHaveLength(0)
  })

  it('requires a session', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/interviews' })
    expect(res.statusCode).toBe(401)
  })
})

describe('interview turns', () => {
  it('records the researcher question and the persona answer as separate turns', async () => {
    const id = await createInterview()
    const res = await ask(id, 'Hogyan tájékozódsz az akciókról?')
    expect(res.statusCode).toBe(200)

    const data = (await app.inject({ method: 'GET', url: `/api/interviews/${id}`, cookies: cookie })).json().data
    expect(data.messages.map((m: { role: string }) => m.role)).toEqual(['researcher', 'persona'])
    expect(data.messages[0].turn).toBe(1)
    expect(data.messages[1].turn).toBe(2)
    expect(data.messages[1].content).toBe('Hetente nézem az akciós újságokat.')
  })

  it('records full provenance on the persona turn', async () => {
    const id = await createInterview()
    await ask(id, 'Kérdés?')
    const message = db
      .prepare("SELECT * FROM interview_messages WHERE role = 'persona'")
      .get() as Record<string, unknown>
    expect(message['model_version']).toBe('deepseek/deepseek-v4-flash-2026-05')
    expect(message['provider']).toBe('DeepInfra')
    expect(message['temperature']).toBe(0.8)
    expect(message['seed']).toBe(7)
    expect(message['prompt_tokens']).toBe(40)
    expect(message['completion_tokens']).toBe(12)
    expect(message['cached_tokens']).toBe(8)
    expect(message['cost_usd']).toBe(0.002)
    expect(message['latency_ms']).toBe(123)
    expect(message['openrouter_request_id']).toBe('req-1')
    expect(message['raw_response']).toBe('Hetente nézem az akciós újságokat.')
    // the exact conversation sent to the model, not a summary of it
    expect(JSON.parse(String(message['prompt_rendered']))).toHaveLength(2)
  })

  it('carries the earlier turns into the next call (memory, unlike a run)', async () => {
    const id = await createInterview()
    await ask(id, 'Első kérdés')
    await ask(id, 'Második kérdés')
    const sent = client.lastMessages as ChatMessage[]
    expect(sent.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user'])
    expect(sent[1]?.content).toBe('Első kérdés')
    expect(sent.at(-1)?.content).toBe('Második kérdés')
  })

  it('marks an abstention as an evidence gap, not an invalid answer', async () => {
    const id = await createInterview()
    client.reply = '[NO BASIS] Ehhez a profilom nem ad alapot.'
    await ask(id, 'Milyen autót vezetsz?')
    const message = db
      .prepare("SELECT abstained, content FROM interview_messages WHERE role = 'persona'")
      .get() as { abstained: number; content: string }
    expect(message.abstained).toBe(1)
    // the raw marker is kept in raw_response; the displayed content is the answer itself
    expect(message.content).toBe('Ehhez a profilom nem ad alapot.')
  })

  it('serves the full provenance of one turn on demand', async () => {
    const id = await createInterview()
    await ask(id, 'Kérdés?')
    const messageId = (db.prepare("SELECT id FROM interview_messages WHERE role = 'persona'").get() as {
      id: string
    }).id
    const res = await app.inject({
      method: 'GET', url: `/api/interviews/${id}/messages/${messageId}`, cookies: cookie
    })
    expect(res.statusCode).toBe(200)
    const data = res.json().data
    expect(JSON.parse(data.prompt_rendered)[0].role).toBe('system')
    expect(data.raw_response).toBe('Hetente nézem az akciós újságokat.')
    expect(
      (await app.inject({ method: 'GET', url: `/api/interviews/${id}/messages/nope`, cookies: cookie })).statusCode
    ).toBe(404)
  })

  // Two questions at once would read the same history, compute the same turn
  // numbers and race the unique index — with the loser's tokens already spent.
  it('refuses a second question while the first is still unanswered', async () => {
    const id = await createInterview()
    let release: (() => void) | null = null
    client.gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const first = ask(id, 'Első')
    await new Promise((resolve) => setTimeout(resolve, 20))
    const second = await ask(id, 'Második')
    expect(second.statusCode).toBe(409)
    release!()
    expect((await first).statusCode).toBe(200)
  })

  it('rejects an empty question', async () => {
    const id = await createInterview()
    expect((await ask(id, '   ')).statusCode).toBe(400)
  })

  it('404s on an unknown interview', async () => {
    expect((await ask('missing', 'Kérdés?')).statusCode).toBe(404)
  })
})

describe('interview budget', () => {
  it('books the spend into the token ledger under the interview scope', async () => {
    const id = await createInterview()
    await ask(id, 'Kérdés?')
    const ledger = db.prepare('SELECT * FROM token_ledger WHERE run_id = ?').get(id) as Record<string, unknown>
    expect(ledger['prompt_tokens']).toBe(40)
    expect(ledger['completion_tokens']).toBe(12)
    expect(ledger['scope']).toBe('interview')
  })

  it('separates exploratory spend from measurement spend in the budget endpoint', async () => {
    const id = await createInterview()
    await ask(id, 'Kérdés?')
    const data = (await app.inject({ method: 'GET', url: '/api/budget', cookies: cookie })).json().data
    expect(data.byScope.interview.totalTokens).toBe(52)
    expect(data.byScope.run.totalTokens).toBe(0)
    // the global counter deliberately spans both: the tokens were spent either way
    expect(data.global.totalTokens).toBe(52)
  })

  it('records the spend even when the transcript write fails', async () => {
    const id = await createInterview()
    await ask(id, 'Első')
    // the provider has already billed by the time the transcript write runs
    db.exec(
      `CREATE TRIGGER block_persona BEFORE INSERT ON interview_messages
         WHEN NEW.role = 'persona' BEGIN SELECT RAISE(ABORT, 'disk full'); END`
    )
    const before = (db.prepare('SELECT COUNT(*) c FROM token_ledger WHERE run_id = ?').get(id) as { c: number }).c
    expect((await ask(id, 'Második')).statusCode).toBe(502)
    db.exec('DROP TRIGGER block_persona')
    const after = (db.prepare('SELECT COUNT(*) c FROM token_ledger WHERE run_id = ?').get(id) as { c: number }).c
    expect(after).toBe(before + 1)
  })

  it('refuses a turn once the global budget is exhausted', async () => {
    const tightApp = buildServer({
      db,
      config: { ...testConfig, TOKEN_BUDGET_GLOBAL: 30 },
      models: testModels,
      client
    })
    await tightApp.ready()
    const tightCookie = cookie
    const created = await tightApp.inject({
      method: 'POST',
      url: '/api/interviews',
      cookies: tightCookie,
      payload: { personaId: 'persona-1', title: 'Keretes' }
    })
    const id = created.json().data.id as string
    expect((await tightApp.inject({
      method: 'POST',
      url: `/api/interviews/${id}/messages`,
      cookies: tightCookie,
      payload: { content: 'Első' }
    })).statusCode).toBe(200)

    const blocked = await tightApp.inject({
      method: 'POST',
      url: `/api/interviews/${id}/messages`,
      cookies: tightCookie,
      payload: { content: 'Második' }
    })
    expect(blocked.statusCode).toBe(429)
    expect(blocked.json().error).toMatch(/keret/i)
    await tightApp.close()
  })
})

describe('interviews stay out of the measurement', () => {
  it('never contributes to run results', async () => {
    // a real run with one response, plus an interview in the same database
    db.prepare('INSERT INTO questionnaires (id, lineage_id, name) VALUES (?,?,?)').run('qn', 'qn', 'Q')
    db.prepare(
      'INSERT INTO questions (id, questionnaire_id, ord, text, options_json) VALUES (?,?,?,?,?)'
    ).run('q1', 'qn', 0, 'Kérdés?', JSON.stringify(['A', 'B']))
    db.prepare('INSERT INTO runs (id, questionnaire_id, name, config_json) VALUES (?,?,?,?)').run(
      'run-1', 'qn', 'Futás', JSON.stringify({ model: 'm', temperature: 1, seeds: [0] })
    )
    db.prepare(
      `INSERT INTO responses (id, run_id, persona_id, question_id, model_requested, temperature, seed,
         permutation_json, prompt_rendered, raw_response, parsed_answer, elicitation_mode)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run('resp-1', 'run-1', 'persona-1', 'q1', 'm', 1, 0, '[0,1]', 'p', 'r', '0', 'single_choice')

    const id = await createInterview()
    await ask(id, 'Kérdés?')

    const results = computeRunResults(db, 'run-1')
    expect(results.totalResponses).toBe(1)
    const serialized = JSON.stringify(results)
    expect(serialized).not.toContain('Hetente nézem')
  })

  it('exports the interview transcript separately from the run CSV', async () => {
    const id = await createInterview()
    await ask(id, 'Hogyan tájékozódsz?')
    const res = await app.inject({ method: 'GET', url: `/api/interviews/${id}/export.csv`, cookies: cookie })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/csv')
    expect(res.body).toContain('Hogyan tájékozódsz?')
    expect(res.body.split('\n')[0]).toContain('model_version')
  })

  // A reply that opens with "=" runs as a formula when the export is opened in
  // Excel; research exports are full of free-form model output.
  it('neutralises a model reply that looks like a spreadsheet formula', async () => {
    const id = await createInterview()
    client.reply = '=cmd|calc'
    await ask(id, 'Kérdés?')
    const res = await app.inject({ method: 'GET', url: `/api/interviews/${id}/export.csv`, cookies: cookie })
    expect(res.body).toContain("'=cmd|calc")
    expect(res.body).not.toMatch(/(^|,)=cmd/m)
  })
})
