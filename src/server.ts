import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import fastifyCookie from '@fastify/cookie'
import fastifyStatic from '@fastify/static'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { Db } from './db.js'
import type { AppConfig, ModelsConfig } from './config.js'
import type { ChatClient } from './openrouter.js'
import { BudgetTracker } from './lib/budget.js'
import { SurveyRunner, runEvents, type RunConfig } from './runner.js'
import {
  checkCredentials,
  createSessionToken,
  verifySessionToken,
  LoginRateLimiter
} from './auth.js'

export interface ServerDeps {
  db: Db
  config: AppConfig
  models: ModelsConfig
  client: ChatClient
}

const SESSION_COOKIE = 'asys_session'

export function buildServer(deps: ServerDeps): FastifyInstance {
  const { db, config, models, client } = deps
  const budget = new BudgetTracker(db, {
    globalBudget: config.TOKEN_BUDGET_GLOBAL,
    perRunBudget: config.TOKEN_BUDGET_PER_RUN
  })
  const runner = new SurveyRunner(db, client, budget)
  const rateLimiter = new LoginRateLimiter()

  const app = Fastify({ logger: false })
  app.register(fastifyCookie)
  app.register(fastifyStatic, {
    root: fileURLToPath(new URL('../public', import.meta.url)),
    prefix: '/'
  })

  const isAuthed = (req: FastifyRequest): boolean => {
    const token = req.cookies[SESSION_COOKIE]
    return !!token && verifySessionToken(token, config.SESSION_SECRET) !== null
  }

  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/') || req.url === '/api/login' || req.url === '/api/session') return
    if (!isAuthed(req)) return reply.code(401).send({ success: false, error: 'Unauthorized' })
  })

  // --- Auth ---
  app.post('/api/login', async (req, reply) => {
    const ip = req.ip
    if (!rateLimiter.allowed(ip)) {
      return reply.code(429).send({ success: false, error: 'Too many attempts, try later' })
    }
    const body = z.object({ username: z.string(), password: z.string() }).safeParse(req.body)
    if (!body.success) return reply.code(400).send({ success: false, error: 'Invalid request' })
    const ok = checkCredentials(
      body.data.username,
      body.data.password,
      config.AUTH_USERNAME,
      config.AUTH_PASSWORD
    )
    if (!ok) {
      rateLimiter.recordFailure(ip)
      return reply.code(401).send({ success: false, error: 'Invalid credentials' })
    }
    // No `secure` flag: the app is exposed only over Tailscale (encrypted overlay,
    // plain HTTP); enabling it without TLS termination would break login entirely.
    reply.setCookie(SESSION_COOKIE, createSessionToken(body.data.username, config.SESSION_SECRET), {
      httpOnly: true,
      sameSite: 'lax',
      path: '/'
    })
    return { success: true }
  })

  app.post('/api/logout', async (_req, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: '/' })
    return { success: true }
  })

  app.get('/api/session', async (req) => ({ success: true, data: { authenticated: isAuthed(req) } }))

  // --- Config / models ---
  app.get('/api/models', async () => ({ success: true, data: models }))

  app.get('/api/budget', async () => ({
    success: true,
    data: { global: budget.globalUsage(), limits: budget.limits() }
  }))

  // --- Projects ---
  const projectSchema = z.object({
    name: z.string().min(1),
    applicationDomain: z.string().optional(),
    targetPopulation: z.string().optional()
  })

  app.get('/api/projects', async () => ({
    success: true,
    data: (db.prepare('SELECT * FROM projects ORDER BY created_at DESC').all() as Record<string, unknown>[]).map((r) => ({
      id: r['id'],
      name: r['name'],
      applicationDomain: r['application_domain'],
      targetPopulation: r['target_population'],
      createdAt: r['created_at']
    }))
  }))

  app.post('/api/projects', async (req, reply) => {
    const body = projectSchema.safeParse(req.body)
    if (!body.success) return reply.code(400).send({ success: false, error: body.error.issues[0]?.message })
    const id = randomUUID()
    db.prepare('INSERT INTO projects (id, name, application_domain, target_population) VALUES (?,?,?,?)').run(
      id, body.data.name, body.data.applicationDomain ?? null, body.data.targetPopulation ?? null
    )
    return { success: true, data: { id } }
  })

  // --- Personas (project-scoped) ---
  const personaSchema = z.object({
    projectId: z.string().min(1),
    name: z.string().min(1),
    demographics: z.record(z.unknown()),
    biography: z.string().optional(),
    renderingStyle: z.enum(['bulleted_profile', 'natural_language_sentence']).default('bulleted_profile')
  })

  app.get('/api/personas', async (req) => {
    const { project } = req.query as { project?: string }
    const rows = project
      ? db.prepare('SELECT * FROM personas WHERE project_id = ? ORDER BY created_at DESC').all(project)
      : db.prepare('SELECT * FROM personas ORDER BY created_at DESC').all()
    return { success: true, data: (rows as Record<string, unknown>[]).map(rowToPersona) }
  })

  app.post('/api/personas', async (req, reply) => {
    const body = personaSchema.safeParse(req.body)
    if (!body.success) return reply.code(400).send({ success: false, error: body.error.issues[0]?.message })
    const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(body.data.projectId)
    if (!project) return reply.code(400).send({ success: false, error: 'Unknown project' })
    const id = randomUUID()
    db.prepare(
      'INSERT INTO personas (id, project_id, name, demographics_json, biography, rendering_style) VALUES (?,?,?,?,?,?)'
    ).run(id, body.data.projectId, body.data.name, JSON.stringify(body.data.demographics), body.data.biography ?? null, body.data.renderingStyle)
    return { success: true, data: { id } }
  })

  // --- Questionnaires ---
  const questionnaireSchema = z.object({
    projectId: z.string().min(1).optional(),
    name: z.string().min(1),
    questions: z
      .array(
        z.object({
          text: z.string().min(1),
          options: z.array(z.string().min(1)).min(2).max(26),
          scaleType: z.string().default('categorical'),
          scaleDirection: z.enum(['ascending', 'descending']).default('ascending')
        })
      )
      .min(1)
  })

  app.get('/api/questionnaires', async (req) => {
    const { project } = req.query as { project?: string }
    const qs = (project
      ? db.prepare('SELECT * FROM questionnaires WHERE project_id = ? OR project_id IS NULL ORDER BY created_at DESC').all(project)
      : db.prepare('SELECT * FROM questionnaires ORDER BY created_at DESC').all()) as unknown as {
      id: string
      name: string
      project_id: string | null
    }[]
    const questions = db.prepare('SELECT * FROM questions ORDER BY ord').all() as {
      questionnaire_id: string
      id: string
      text: string
      options_json: string
    }[]
    return {
      success: true,
      data: qs.map((q) => ({
        id: q.id,
        projectId: q.project_id,
        name: q.name,
        questions: questions
          .filter((x) => x.questionnaire_id === q.id)
          .map((x) => ({ id: x.id, text: x.text, options: JSON.parse(x.options_json) as string[] }))
      }))
    }
  })

  app.post('/api/questionnaires', async (req, reply) => {
    const body = questionnaireSchema.safeParse(req.body)
    if (!body.success) return reply.code(400).send({ success: false, error: body.error.issues[0]?.message })
    const id = randomUUID()
    if (body.data.projectId) {
      const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(body.data.projectId)
      if (!project) return reply.code(400).send({ success: false, error: 'Unknown project' })
    }
    db.exec('BEGIN')
    try {
      db.prepare('INSERT INTO questionnaires (id, project_id, name) VALUES (?,?,?)').run(id, body.data.projectId ?? null, body.data.name)
      body.data.questions.forEach((q, ord) => {
        db.prepare(
          'INSERT INTO questions (id, questionnaire_id, ord, text, scale_type, options_json, scale_direction) VALUES (?,?,?,?,?,?,?)'
        ).run(randomUUID(), id, ord, q.text, q.scaleType, JSON.stringify(q.options), q.scaleDirection)
      })
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    return { success: true, data: { id } }
  })

  // --- Runs ---
  const runSchema = z.object({
    name: z.string().min(1),
    questionnaireId: z.string().min(1),
    personaIds: z.array(z.string()).min(1),
    model: z.string().default(models.default),
    temperature: z.number().min(0).max(2).default(1.0),
    seeds: z.array(z.number().int()).min(1).default([0, 1])
  })

  app.post('/api/runs', async (req, reply) => {
    const body = runSchema.safeParse(req.body)
    if (!body.success) return reply.code(400).send({ success: false, error: body.error.issues[0]?.message })
    if (!models.models.some((m) => m.id === body.data.model)) {
      return reply.code(400).send({ success: false, error: `Unknown model: ${body.data.model}` })
    }
    const runConfig: RunConfig = {
      model: body.data.model,
      temperature: body.data.temperature,
      seeds: body.data.seeds
    }
    const id = randomUUID()
    db.exec('BEGIN')
    try {
      db.prepare('INSERT INTO runs (id, questionnaire_id, name, config_json) VALUES (?,?,?,?)').run(
        id, body.data.questionnaireId, body.data.name, JSON.stringify(runConfig)
      )
      for (const pid of body.data.personaIds) {
        db.prepare('INSERT INTO run_personas (run_id, persona_id) VALUES (?,?)').run(id, pid)
      }
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    // fire-and-forget: progress observable via SSE / polling
    void runner.execute(id).catch((error) => {
      app.log.error?.(error)
    })
    return { success: true, data: { id } }
  })

  app.get('/api/runs', async () => ({
    success: true,
    data: db
      .prepare(
        `SELECT r.*,
           (SELECT COUNT(*) FROM responses WHERE run_id = r.id) AS response_count,
           (SELECT COUNT(*) FROM responses WHERE run_id = r.id AND is_valid = 0) AS invalid_count
         FROM runs r ORDER BY r.created_at DESC`
      )
      .all()
  }))

  app.get('/api/runs/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(id)
    if (!run) return reply.code(404).send({ success: false, error: 'Run not found' })
    const responses = db
      .prepare(
        `SELECT res.id, res.persona_id, p.name AS persona_name, res.question_id, q.text AS question_text,
                res.model_version, res.seed, res.permutation_json, res.parsed_distribution_json,
                res.parsed_answer, res.is_valid, res.abstained, res.prompt_tokens,
                res.completion_tokens, res.cost_usd, res.latency_ms, res.created_at
         FROM responses res
         JOIN personas p ON p.id = res.persona_id
         JOIN questions q ON q.id = res.question_id
         WHERE res.run_id = ? ORDER BY res.created_at`
      )
      .all(id)
    return { success: true, data: { run, responses, usage: budget.usage(id) } }
  })

  app.get('/api/runs/:id/export.csv', async (req, reply) => {
    const { id } = req.params as { id: string }
    const rows = db.prepare('SELECT * FROM responses WHERE run_id = ? ORDER BY created_at').all(id) as Record<string, unknown>[]
    const header = rows.length > 0 ? Object.keys(rows[0]!) : []
    const csv = [
      header.join(','),
      ...rows.map((r) => header.map((h) => csvEscape(r[h])).join(','))
    ].join('\n')
    reply.header('Content-Type', 'text/csv; charset=utf-8')
    reply.header('Content-Disposition', `attachment; filename="run-${id}.csv"`)
    return csv
  })

  // --- SSE live updates ---
  app.get('/api/events', async (req, reply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    })
    const send = (event: string, data: unknown): void => {
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    }
    const onResponse = (d: unknown): void => send('response', d)
    const onStatus = (d: unknown): void => send('status', d)
    runEvents.on('response', onResponse)
    runEvents.on('status', onStatus)
    const heartbeat = setInterval(() => reply.raw.write(': ping\n\n'), 25_000)
    req.raw.on('close', () => {
      clearInterval(heartbeat)
      runEvents.off('response', onResponse)
      runEvents.off('status', onStatus)
    })
    await new Promise(() => undefined) // keep open until client disconnects
  })

  return app
}

function rowToPersona(r: Record<string, unknown>): Record<string, unknown> {
  return {
    id: r['id'],
    projectId: r['project_id'],
    name: r['name'],
    demographics: JSON.parse(String(r['demographics_json'])),
    biography: r['biography'],
    renderingStyle: r['rendering_style'],
    createdAt: r['created_at']
  }
}

function csvEscape(value: unknown): string {
  const s = value === null || value === undefined ? '' : String(value)
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s
}
