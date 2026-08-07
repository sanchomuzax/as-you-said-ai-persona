import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import fastifyCookie from '@fastify/cookie'
import fastifyStatic from '@fastify/static'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { cellIndexPresent, type Db } from './db.js'
import type { AppConfig, ModelsConfig } from './config.js'
import type { ChatClient } from './openrouter.js'
import { BudgetTracker } from './lib/budget.js'
import { SurveyRunner, runEvents, requestPause, requestStop, isResumable, type RunConfig } from './runner.js'
import { computeRunResults } from './lib/results.js'
import { buildEvaluationPrompt } from './lib/evaluate.js'
import { toCsv } from './lib/csv.js'
import { registerInterviewRoutes } from './interviews.js'
import { registerCatalogRoutes } from './catalog.js'
import { registerModelProfileRoutes } from './model-profiles.js'
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
    const config = JSON.parse(row.config_json) as RunConfig
    const seeds = config.seeds.length
    // per question: rotation count = option count; cells = rotations × personas × seeds,
    // plus one persona-free control cell per rotation and seed when the arm is on
    const arms = row.personas + (config.baselineArm === true ? 1 : 0)
    return row.rotations * arms * seeds
  }

  /**
   * A run always references the exact persona/questionnaire versions that answered.
   * If those have since been superseded the run stays valid — but the reader must
   * know they are looking at an earlier state of the design. Computed from indexed
   * lookups so it can ride along with the frequently polled progress endpoint.
   */
  const staleVersionsOf = (
    runId: string
  ): {
    questionnaire: { used: number; latest: number } | null
    personas: { id: string; name: string; version: number; latestVersion: number }[]
  } => {
    const questionnaire = db
      .prepare(
        `SELECT used.version AS used,
                (SELECT MAX(q.version) FROM questionnaires q WHERE q.lineage_id = used.lineage_id) AS latest
           FROM runs r JOIN questionnaires used ON used.id = r.questionnaire_id
          WHERE r.id = ?`
      )
      .get(runId) as { used: number; latest: number } | undefined
    const personas = db
      .prepare(
        `SELECT used.id, used.name, used.version,
                (SELECT MAX(v.version) FROM personas v WHERE v.lineage_id = used.lineage_id) AS latestVersion
           FROM run_personas rp JOIN personas used ON used.id = rp.persona_id
          WHERE rp.run_id = ?`
      )
      .all(runId) as unknown as { id: string; name: string; version: number; latestVersion: number }[]
    return {
      questionnaire: questionnaire && questionnaire.latest > questionnaire.used ? questionnaire : null,
      personas: personas.filter((p) => p.latestVersion > p.version)
    }
  }

  const runEvaluation = async (runId: string): Promise<{ id: string } > => {
    const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(runId) as
      | { id: string; name: string; config_json: string }
      | undefined
    if (!run) throw new Error('Run not found')
    const results = computeRunResults(db, runId)
    if (results.totalResponses === 0) throw new Error('No responses to evaluate')
    const evaluationProviders = (
      db
        .prepare('SELECT provider, COUNT(*) c FROM responses WHERE run_id = ? AND provider IS NOT NULL GROUP BY provider')
        .all(runId) as unknown as { provider: string; c: number }[]
    ).map((r) => ({ provider: r.provider, count: r.c }))
    const prompt = buildEvaluationPrompt(run.name, results, { providers: evaluationProviders })
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
    // byScope separates measurement spend from exploratory interview spend: the
    // budget is shared, so the single global number alone would hide which of
    // the two consumed it.
    data: { global: budget.globalUsage(), byScope: budget.usageByScope(), limits: budget.limits() }
  }))

  // --- Projects ---
  const projectSchema = z.object({
    name: z.string().min(1),
    applicationDomain: z.string().optional(),
    targetPopulation: z.string().optional()
  })

  app.get('/api/projects', async () => ({
    success: true,
    data: (db.prepare('SELECT * FROM projects ORDER BY created_at DESC').all() as Record<string, unknown>[]).map(
      rowToProject
    )
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

  // A detail view needs one project, not every project with every field: the
  // list grows with the research corpus and the client used to filter it itself.
  app.get('/api/projects/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Record<string, unknown> | undefined
    if (!row) return reply.code(404).send({ success: false, error: 'A projekt nem található' })
    // Same mapper as the list endpoint: the detail view and the list must not be
    // able to drift into returning different shapes for the same row.
    return { success: true, data: rowToProject(row) }
  })

  // Projects carry no experimental record, so editing them in place is safe —
  // unlike personas/responses, which are immutable snapshots by design.
  app.put('/api/projects/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = projectSchema.safeParse(req.body)
    if (!body.success) return reply.code(400).send({ success: false, error: body.error.issues[0]?.message })
    const existing = db.prepare('SELECT id FROM projects WHERE id = ?').get(id)
    if (!existing) return reply.code(404).send({ success: false, error: 'A projekt nem található' })
    db.prepare('UPDATE projects SET name = ?, application_domain = ?, target_population = ? WHERE id = ?').run(
      body.data.name, body.data.applicationDomain ?? null, body.data.targetPopulation ?? null, id
    )
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
    autoEvaluate: z.boolean().default(false),
    // Pinning the upstream provider makes a run reproducible: the same model id
    // is otherwise served by several providers with different quantization.
    provider: z.string().min(1).optional(),
    // On by default: without an in-run control there is no way to separate a
    // persona effect from the model's default answer.
    baselineArm: z.boolean().default(true)
  })

  app.post('/api/runs', async (req, reply) => {
    const body = runSchema.safeParse(req.body)
    if (!body.success) return reply.code(400).send({ success: false, error: body.error.issues[0]?.message })
    if (!models.models.some((m) => m.id === body.data.model)) {
      return reply.code(400).send({ success: false, error: `Ismeretlen modell: ${body.data.model}` })
    }
    const runConfig: RunConfig = {
      model: body.data.model,
      temperature: body.data.temperature,
      seeds: body.data.seeds,
      autoEvaluate: body.data.autoEvaluate,
      baselineArm: body.data.baselineArm,
      ...(body.data.provider ? { provider: body.data.provider } : {})
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

  // Parsed rather than truthy-checked: `?project=` (empty) used to fall through
  // to the unfiltered branch and answer a request for ONE project's runs with
  // every run in the corpus, and a repeated `?project=a&project=b` arrives as an
  // array that the SQLite bind rejects with a 500.
  const runQuerySchema = z.object({ project: z.string().min(1).optional() })

  app.get('/api/runs', async (req, reply) => {
    const query = runQuerySchema.safeParse(req.query)
    if (!query.success) return reply.code(400).send({ success: false, error: 'Érvénytelen projekt-szűrő' })
    const project = query.data.project
    // A run belongs to a project through the questionnaire version it used, so
    // a run started on a SUPERSEDED version still belongs to that project. A run
    // started on a global (project-less) questionnaire belongs to no project and
    // appears only in the unfiltered list — the project view says so rather than
    // quietly implying the project has no runs.
    const scope =
      project === undefined ? '' : 'JOIN questionnaires q ON q.id = r.questionnaire_id AND q.project_id = ?'
    const rows = db
      .prepare(
        `SELECT r.*,
           (SELECT COUNT(*) FROM responses WHERE run_id = r.id) AS response_count,
           (SELECT COUNT(*) FROM responses WHERE run_id = r.id AND is_valid = 0) AS invalid_count
         FROM runs r ${scope} ORDER BY r.created_at DESC`
      )
    return { success: true, data: project === undefined ? rows.all() : rows.all(project) }
  })

  app.get('/api/runs/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(id)
    if (!run) return reply.code(404).send({ success: false, error: 'A futtatás nem található' })
    const responses = db
      .prepare(
        `SELECT res.id, res.persona_id, p.name AS persona_name, res.question_id, q.text AS question_text,
                q.options_json, res.elicitation_mode, res.condition,
                res.model_version, res.provider, res.seed, res.permutation_json, res.parsed_distribution_json,
                res.parsed_answer, res.is_valid, res.abstained, res.prompt_tokens,
                res.completion_tokens, res.cost_usd, res.latency_ms, res.created_at
         FROM responses res
         LEFT JOIN personas p ON p.id = res.persona_id
         JOIN questions q ON q.id = res.question_id
         WHERE res.run_id = ? ORDER BY res.created_at`
      )
      .all(id)
    return { success: true, data: { run, responses, usage: budget.usage(id), staleVersions: staleVersionsOf(id) } }
  })

  // --- Run control ---
  app.post('/api/runs/:id/pause', async (req, reply) => {
    const { id } = req.params as { id: string }
    const run = db.prepare('SELECT status FROM runs WHERE id = ?').get(id) as { status: string } | undefined
    if (!run) return reply.code(404).send({ success: false, error: 'A futtatás nem található' })
    if (run.status !== 'running') return reply.code(400).send({ success: false, error: `Cannot pause a ${run.status} run` })
    requestPause(id)
    return { success: true }
  })

  app.post('/api/runs/:id/resume', async (req, reply) => {
    const { id } = req.params as { id: string }
    const run = db.prepare('SELECT status FROM runs WHERE id = ?').get(id) as { status: string } | undefined
    if (!run) return reply.code(404).send({ success: false, error: 'A futtatás nem található' })
    if (!isResumable(run.status)) return reply.code(400).send({ success: false, error: `Cannot resume a ${run.status} run` })
    void runner.execute(id).catch(() => undefined)
    return { success: true }
  })

  app.post('/api/runs/:id/stop', async (req, reply) => {
    const { id } = req.params as { id: string }
    const run = db.prepare('SELECT status FROM runs WHERE id = ?').get(id) as { status: string } | undefined
    if (!run) return reply.code(404).send({ success: false, error: 'A futtatás nem található' })
    if (run.status === 'running') requestStop(id)
    else db.prepare("UPDATE runs SET status = 'stopped' WHERE id = ?").run(id)
    return { success: true }
  })

  // --- Progress / results / evaluation ---
  /**
   * Everything that produced one answer: the exact prompt, the raw output and the
   * experimental settings. Kept out of the run's response list on purpose — that
   * list is polled while a run executes, and prompts are large.
   */
  app.get('/api/runs/:runId/responses/:id', async (req, reply) => {
    const { runId, id } = req.params as { runId: string; id: string }
    const row = db
      .prepare(
        `SELECT ${CSV_COLUMNS.map((c) => 'res.' + c).join(', ')},
                p.name AS persona_name, q.text AS question_text, q.options_json, q.scale_type
           FROM responses res
           LEFT JOIN personas p ON p.id = res.persona_id
           JOIN questions q ON q.id = res.question_id
          WHERE res.id = ? AND res.run_id = ?`
      )
      .get(id, runId)
    if (!row) return reply.code(404).send({ success: false, error: 'A válasz nem található' })
    return { success: true, data: row }
  })

  app.get('/api/runs/:id/progress', async (req, reply) => {
    const { id } = req.params as { id: string }
    const run = db.prepare('SELECT status FROM runs WHERE id = ?').get(id) as { status: string } | undefined
    if (!run) return reply.code(404).send({ success: false, error: 'A futtatás nem található' })
    const counts = db
      .prepare('SELECT COUNT(*) done, COALESCE(SUM(is_valid=0),0) invalid, COALESCE(SUM(abstained),0) abstained, COALESCE(AVG(latency_ms),0) avgLatency FROM responses WHERE run_id = ?')
      .get(id) as { done: number; invalid: number; abstained: number; avgLatency: number }
    // Which providers actually served this run: more than one means the answers
    // came from different implementations of the "same" model.
    const providers = (
      db
        .prepare(
          'SELECT provider, COUNT(*) c FROM responses WHERE run_id = ? AND provider IS NOT NULL GROUP BY provider ORDER BY c DESC'
        )
        .all(id) as unknown as { provider: string; c: number }[]
    ).map((r) => ({ provider: r.provider, count: r.c }))

    return {
      success: true,
      data: {
        status: run.status,
        providers,
        staleVersions: staleVersionsOf(id),
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
    if (!run) return reply.code(404).send({ success: false, error: 'A futtatás nem található' })
    return {
      success: true,
      // Whether the database can still enforce one-row-per-cell: on a database
      // carrying pre-fix duplicates the index cannot exist, and then the analysis
      // dedupe is the ONLY protection — the reader has to know which state this is.
      data: { ...computeRunResults(db, id), cellIndexPresent: cellIndexPresent(db) }
    }
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
    reply.header('Content-Type', 'text/csv; charset=utf-8')
    reply.header('Content-Disposition', `attachment; filename="run-${id}.csv"`)
    return toCsv(CSV_COLUMNS, rows)
  })

  // Exploratory interviews: separate tables, separate routes, never aggregated
  // into a run. Registered here so they share the session hook and the budget.
  // Personas and questionnaires: versioned, immutable snapshots.
  registerCatalogRoutes(app, { db })

  registerInterviewRoutes(app, { db, models, client, budget })

  // Model calibration registry: what each model answers with no persona at all.
  // Every persona result is read against that default, so the default has to be
  // measured, dated and auditable rather than assumed.
  registerModelProfileRoutes(app, { db, models, runner })

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

/** Explicit column list — see the note on `toCsv`. */
const CSV_COLUMNS = [
  'id', 'run_id', 'persona_id', 'question_id', 'model_requested', 'model_version', 'provider',
  'temperature', 'seed', 'prompt_style', 'elicitation_mode', 'permutation_json', 'label_style',
  'prompt_rendered', 'raw_response', 'parsed_distribution_json', 'parsed_answer', 'is_valid',
  'abstained', 'prompt_tokens', 'completion_tokens', 'cached_tokens', 'cost_usd',
  'cache_discount_usd', 'latency_ms',
  'openrouter_request_id', 'created_at'
]

function rowToProject(r: Record<string, unknown>): Record<string, unknown> {
  return {
    id: r['id'],
    name: r['name'],
    applicationDomain: r['application_domain'],
    targetPopulation: r['target_population'],
    createdAt: r['created_at']
  }
}
