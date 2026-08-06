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
import { SurveyRunner, runEvents, requestPause, requestStop, isResumable, type RunConfig } from './runner.js'
import { computeRunResults } from './lib/results.js'
import { buildEvaluationPrompt } from './lib/evaluate.js'
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

  // Runs left 'running' by a previous process (restart/crash) have no live loop.
  // Mark them paused, then resume automatically: the interruption was operational,
  // not a research decision. Already-recorded cells are skipped and the token
  // budget hard stop still applies, so a resume cannot run away.
  const interrupted = db
    .prepare("SELECT id FROM runs WHERE status = 'running'")
    .all() as unknown as { id: string }[]
  if (interrupted.length > 0) {
    db.prepare("UPDATE runs SET status = 'paused' WHERE status = 'running'").run()
  }

  const totalCells = (runId: string): number => {
    const row = db
      .prepare(
        `SELECT r.config_json,
           (SELECT COUNT(*) FROM run_personas WHERE run_id = r.id) AS personas,
           (SELECT COALESCE(SUM(json_array_length(options_json)), 0)
              FROM questions WHERE questionnaire_id = r.questionnaire_id) AS rotations
         FROM runs r WHERE r.id = ?`
      )
      .get(runId) as { config_json: string; personas: number; rotations: number } | undefined
    if (!row) return 0
    const seeds = (JSON.parse(row.config_json) as RunConfig).seeds.length
    // per question: rotation count = option count; cells = rotations × personas × seeds
    return row.rotations * row.personas * seeds
  }

  const runEvaluation = async (runId: string): Promise<{ id: string } > => {
    const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(runId) as
      | { id: string; name: string; config_json: string }
      | undefined
    if (!run) throw new Error('Run not found')
    const results = computeRunResults(db, runId)
    if (results.totalResponses === 0) throw new Error('No responses to evaluate')
    const prompt = buildEvaluationPrompt(run.name, results)
    const model = (JSON.parse(run.config_json) as RunConfig).model

    // Coverage snapshot, taken BEFORE the model call: the run keeps recording
    // responses during those seconds, and if it finishes meanwhile, a snapshot
    // taken afterwards would call this evaluation complete — exactly the false
    // "everything was covered" claim the snapshot exists to prevent. The count is
    // what the evaluation actually saw, not what the run has by now.
    const coverage = {
      status: (db.prepare('SELECT status FROM runs WHERE id = ?').get(runId) as { status: string }).status,
      done: results.totalResponses,
      total: totalCells(runId)
    }

    const result = await client.complete(model, prompt, { temperature: 0.3, seed: 0 })
    const id = randomUUID()
    db.prepare(
      `INSERT INTO run_evaluations
         (id, run_id, model, prompt, content, prompt_tokens, completion_tokens, cost_usd, run_status, done_cells, total_cells)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      id, runId, result.modelVersion, prompt, result.content,
      result.promptTokens, result.completionTokens, result.costUsd,
      coverage.status, coverage.done, coverage.total
    )
    budget.record(runId, {
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      cachedTokens: result.cachedTokens ?? 0,
      costUsd: result.costUsd
    })
    runEvents.emit('evaluation', { runId, evaluationId: id })
    return { id }
  }

  runEvents.on('run_finished', ({ runId }: { runId: string }) => {
    void runEvaluation(runId).catch(() => undefined)
  })

  for (const { id } of interrupted) {
    void runner.execute(id).catch(() => undefined)
  }

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

  // Projects carry no experimental record, so editing them in place is safe —
  // unlike personas/responses, which are immutable snapshots by design.
  app.put('/api/projects/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = projectSchema.safeParse(req.body)
    if (!body.success) return reply.code(400).send({ success: false, error: body.error.issues[0]?.message })
    const existing = db.prepare('SELECT id FROM projects WHERE id = ?').get(id)
    if (!existing) return reply.code(404).send({ success: false, error: 'Project not found' })
    db.prepare('UPDATE projects SET name = ?, application_domain = ?, target_population = ? WHERE id = ?').run(
      body.data.name, body.data.applicationDomain ?? null, body.data.targetPopulation ?? null, id
    )
    return { success: true, data: { id } }
  })

  // --- Personas (project-scoped) ---
  const personaSchema = z.object({
    projectId: z.string().min(1),
    name: z.string().min(1),
    demographics: z.record(z.unknown()),
    biography: z.string().optional(),
    renderingStyle: z.enum(['bulleted_profile', 'natural_language_sentence']).default('bulleted_profile'),
    /** Where the demographic anchor core came from — surfaced as the Persona Provenance Card. */
    provenance: z.record(z.unknown()).optional()
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
      'INSERT INTO personas (id, project_id, name, demographics_json, biography, rendering_style, provenance_json) VALUES (?,?,?,?,?,?,?)'
    ).run(
      id,
      body.data.projectId,
      body.data.name,
      JSON.stringify(body.data.demographics),
      body.data.biography ?? null,
      body.data.renderingStyle,
      body.data.provenance ? JSON.stringify(body.data.provenance) : null
    )
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
          // A typo here would silently revert a multi-select question to sum-to-1
          // elicitation, so the value is constrained rather than free text.
          scaleType: z.enum(['single_choice', 'multi_choice', 'frequency', 'ordinal', 'categorical']).default('categorical'),
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
    seeds: z.array(z.number().int()).min(1).default([0, 1]),
    autoEvaluate: z.boolean().default(false)
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
      seeds: body.data.seeds,
      autoEvaluate: body.data.autoEvaluate
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
                q.options_json, res.elicitation_mode,
                res.model_version, res.provider, res.seed, res.permutation_json, res.parsed_distribution_json,
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

  // --- Run control ---
  app.post('/api/runs/:id/pause', async (req, reply) => {
    const { id } = req.params as { id: string }
    const run = db.prepare('SELECT status FROM runs WHERE id = ?').get(id) as { status: string } | undefined
    if (!run) return reply.code(404).send({ success: false, error: 'Run not found' })
    if (run.status !== 'running') return reply.code(400).send({ success: false, error: `Cannot pause a ${run.status} run` })
    requestPause(id)
    return { success: true }
  })

  app.post('/api/runs/:id/resume', async (req, reply) => {
    const { id } = req.params as { id: string }
    const run = db.prepare('SELECT status FROM runs WHERE id = ?').get(id) as { status: string } | undefined
    if (!run) return reply.code(404).send({ success: false, error: 'Run not found' })
    if (!isResumable(run.status)) return reply.code(400).send({ success: false, error: `Cannot resume a ${run.status} run` })
    void runner.execute(id).catch(() => undefined)
    return { success: true }
  })

  app.post('/api/runs/:id/stop', async (req, reply) => {
    const { id } = req.params as { id: string }
    const run = db.prepare('SELECT status FROM runs WHERE id = ?').get(id) as { status: string } | undefined
    if (!run) return reply.code(404).send({ success: false, error: 'Run not found' })
    if (run.status === 'running') requestStop(id)
    else db.prepare("UPDATE runs SET status = 'stopped' WHERE id = ?").run(id)
    return { success: true }
  })

  // --- Progress / results / evaluation ---
  app.get('/api/runs/:id/progress', async (req, reply) => {
    const { id } = req.params as { id: string }
    const run = db.prepare('SELECT status FROM runs WHERE id = ?').get(id) as { status: string } | undefined
    if (!run) return reply.code(404).send({ success: false, error: 'Run not found' })
    const counts = db
      .prepare('SELECT COUNT(*) done, COALESCE(SUM(is_valid=0),0) invalid, COALESCE(SUM(abstained),0) abstained, COALESCE(AVG(latency_ms),0) avgLatency FROM responses WHERE run_id = ?')
      .get(id) as { done: number; invalid: number; abstained: number; avgLatency: number }
    return {
      success: true,
      data: {
        status: run.status,
        totalCells: totalCells(id),
        done: counts.done,
        invalid: counts.invalid,
        abstained: counts.abstained,
        avgLatencyMs: Math.round(counts.avgLatency),
        usage: budget.usage(id)
      }
    }
  })

  app.get('/api/runs/:id/results', async (req, reply) => {
    const { id } = req.params as { id: string }
    const run = db.prepare('SELECT id FROM runs WHERE id = ?').get(id)
    if (!run) return reply.code(404).send({ success: false, error: 'Run not found' })
    return { success: true, data: computeRunResults(db, id) }
  })

  app.get('/api/runs/:id/evaluations', async (req) => {
    const { id } = req.params as { id: string }
    return {
      success: true,
      data: db
        .prepare('SELECT id, model, content, prompt_tokens, completion_tokens, cost_usd, run_status, done_cells, total_cells, created_at FROM run_evaluations WHERE run_id = ? ORDER BY created_at DESC')
        .all(id)
    }
  })

  app.post('/api/runs/:id/evaluate', async (req, reply) => {
    const { id } = req.params as { id: string }
    try {
      const result = await runEvaluation(id)
      return { success: true, data: result }
    } catch (error) {
      return reply.code(400).send({ success: false, error: error instanceof Error ? error.message : 'Evaluation failed' })
    }
  })

  app.get('/api/runs/:id/export.csv', async (req, reply) => {
    const { id } = req.params as { id: string }
    const rows = db
      .prepare(`SELECT ${CSV_COLUMNS.join(', ')} FROM responses WHERE run_id = ? ORDER BY created_at`)
      .all(id) as Record<string, unknown>[]
    const header = CSV_COLUMNS
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

/**
 * Explicit column list: `SELECT *` returns migrated columns in a different order
 * than a freshly created database, which would make exports from two machines
 * impossible to diff.
 */
const CSV_COLUMNS = [
  'id', 'run_id', 'persona_id', 'question_id', 'model_requested', 'model_version', 'provider',
  'temperature', 'seed', 'prompt_style', 'elicitation_mode', 'permutation_json', 'label_style',
  'prompt_rendered', 'raw_response', 'parsed_distribution_json', 'parsed_answer', 'is_valid',
  'abstained', 'prompt_tokens', 'completion_tokens', 'cached_tokens', 'cost_usd',
  'cache_discount_usd', 'latency_ms',
  'openrouter_request_id', 'created_at'
]

function rowToPersona(r: Record<string, unknown>): Record<string, unknown> {
  return {
    id: r['id'],
    projectId: r['project_id'],
    name: r['name'],
    demographics: JSON.parse(String(r['demographics_json'])),
    biography: r['biography'],
    renderingStyle: r['rendering_style'],
    provenance: parseJsonOrNull(r['provenance_json']),
    createdAt: r['created_at']
  }
}

/** Provenance is optional and was absent in older rows — a malformed value must not break the list. */
function parseJsonOrNull(value: unknown): unknown {
  if (typeof value !== 'string' || value === '') return null
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function csvEscape(value: unknown): string {
  const s = value === null || value === undefined ? '' : String(value)
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s
}
