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
import { registerModelProfileRoutes, findProfileForRun, isCalibrationRun } from './model-profiles.js'
import { buildProviderOptions } from './lib/provider-options.js'
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
    const runConfigForEvaluation = JSON.parse(run.config_json) as RunConfig
    const model = runConfigForEvaluation.model
    // Issue #17 M3: judged against the stack THIS RUN'S OWN responses were
    // served by (src/model-profiles.ts's findProfileForRun — see its docstring
    // for why "today's global stack" is the wrong comparison, review HIGH #1),
    // and recorded on the row below so the audit trail reflects what was true
    // AT EVALUATION TIME, not whatever the profile's status is later.
    //
    // Defensive (review HIGH #2): the profile lookup must never fail the
    // evaluation itself. A corrupt/partial model_profiles row degrading to "no
    // profile" is far preferable to losing the whole evaluation silently
    // through the auto-eval path's `.catch(() => undefined)` below.
    let activeProfile: ReturnType<typeof findProfileForRun> = null
    try {
      activeProfile = findProfileForRun(db, runId, model)
    } catch {
      activeProfile = null
    }
    // Issue #35: a calibration run (config_json.calibration === true) has no
    // personas at all — buildEvaluationPrompt needs to know this to pick the
    // calibration-framed prompt instead of the persona-research one. Detected
    // via isCalibrationRun (src/model-profiles.ts), not the run name.
    const prompt = buildEvaluationPrompt(run.name, results, {
      providers: evaluationProviders,
      profile: activeProfile,
      calibration: isCalibrationRun(runConfigForEvaluation)
    })

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
    // 'missing' (not NULL) records that M3 DID look and found nothing — a NULL
    // model_profile_status must stay reserved for rows written before this
    // milestone ever ran, where whether a profile existed is genuinely unknown
    // (review MED #6: NULL must never be read as "there was no profile").
    db.prepare(
      `INSERT INTO run_evaluations
         (id, run_id, model, prompt, content, prompt_tokens, completion_tokens, cost_usd, run_status, done_cells, total_cells,
          model_profile_id, model_profile_status, model_profile_model_version, model_profile_provider,
          model_profile_measured_at, model_profile_reasons_json)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      id, runId, result.modelVersion, prompt, result.content,
      result.promptTokens, result.completionTokens, result.costUsd,
      coverage.status, coverage.done, coverage.total,
      activeProfile?.profile.id ?? null, activeProfile?.status ?? 'missing',
      activeProfile?.profile.modelVersion ?? null, activeProfile?.profile.provider ?? null,
      activeProfile?.profile.createdAt ?? null,
      activeProfile && activeProfile.reasons.length > 0 ? JSON.stringify(activeProfile.reasons) : null
    )
    budget.record(runId, {
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      cachedTokens: result.cachedTokens ?? 0,
      costUsd: result.costUsd
    })
    // Blocker #3: an evaluation books real spend (above) that the run's card
    // (token/cost chips) and the global budget widget must reflect — auto-
    // evaluation (triggered by 'run_finished', not a button click) has no
    // client-side await to hang a refresh off, so it depends entirely on this
    // event. The client's 'evaluation' listener (public/app.js) now refetches
    // /api/runs (which carries usage totals, see GET /api/runs above) and
    // /api/budget on every 'evaluation' event, not only when the evaluation
    // sub-tab happens to be open.
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

  /**
   * Issue #28: the data behind the "Szolgáltató rögzítése" dropdown. Real
   * observed data (responses.provider for this model) always wins over a
   * hardcoded list; OpenRouter's live endpoint catalog is merged in when the
   * injected ChatClient supports it and answers before the client's own
   * timeout — a slow or unreachable catalog degrades to "observed only",
   * never to a 500 that would take the whole form down with it.
   */
  app.get('/api/models/:model/providers', async (req, reply) => {
    const { model } = req.params as { model: string }
    if (!models.models.some((m) => m.id === model)) {
      return reply.code(400).send({ success: false, error: `Ismeretlen modell: ${model}` })
    }
    const observed = (
      db
        .prepare(
          'SELECT provider, COUNT(*) c FROM responses WHERE model_requested = ? AND provider IS NOT NULL GROUP BY provider'
        )
        .all(model) as unknown as { provider: string; c: number }[]
    ).map((r) => ({ provider: r.provider, count: r.c }))
    let catalog: Awaited<ReturnType<NonNullable<typeof client.listEndpoints>>> | null = null
    let catalogError = false
    if (client.listEndpoints) {
      try {
        catalog = await client.listEndpoints(model)
      } catch {
        catalog = null
        catalogError = true
      }
    }
    return {
      success: true,
      data: {
        options: buildProviderOptions(observed, catalog),
        catalogAvailable: catalog !== null,
        catalogError
      }
    }
  })

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
    // Issue #22: the overview and the context sidebar used to get these numbers
    // by fanning out one GET /api/runs/:id/progress per run at boot — each of
    // those is itself totalCells() + staleVersionsOf(), i.e. four more SQL
    // statements per run. Reproduced here as correlated subqueries in the SAME
    // list query instead, so N runs cost one round trip, not up to 4N+1.
    //
    // total_cells mirrors totalCells()'s arithmetic for every run reachable
    // through the zod-validated API (rotations × arms × seeds). It is NOT a
    // universal guarantee: json_extract(...'$.baselineArm') reads any JSON
    // number as itself rather than totalCells()'s strict `=== true` check
    // (only possible on a config_json no API route can produce), and a
    // malformed config_json row would abort this whole query instead of just
    // that one run's field the way totalCells() fails in isolation. Neither
    // is reachable here; tests/api-runs-summary.test.ts asserts the two never
    // disagree for every shape the API can actually produce.
    // stale_versions mirrors staleVersionsOf()'s "used version < latest version
    // in the same lineage" check, for the questionnaire and every run persona.
    //
    // Usage totals (prompt/completion/cached tokens, cost): a non-running run
    // is never polled again after it stops (no /progress fetch at boot, and
    // the 5s timer only targets 'running' rows), so without this the card
    // would show 0 spend forever instead of what it actually cost. Mirrors
    // BudgetTracker.usage() (src/lib/budget.ts) exactly — SUM(prompt_tokens),
    // SUM(completion_tokens), SUM(cached_tokens), SUM(cost_usd), scoped to
    // 'run' the same way (W1: budget.usage() now takes that scope as a
    // required parameter instead of reading everything under the id, so the
    // two truly cannot disagree) — and total_tokens = prompt + completion,
    // cached NOT added again (a cached token is already counted once, inside
    // prompt_tokens). token_ledger also carries interview spend under
    // scope = 'interview', keyed by the interview id, not a run id — the
    // WHERE scope = 'run' below is what keeps that out, not the id space (an
    // interview id could collide with a run id; the scope column cannot).
    //
    // scoped_runs (CTE): the token_ledger aggregate is restricted to run ids
    // actually in this result set — a project-scoped list of 3 runs used to
    // still GROUP BY the entire ledger (every run of every project) to find
    // them. response_count and done_cells are the exact same figure (a
    // "cell" is one response row); computed once here and mirrored in JS
    // below instead of running the identical subquery twice.
    const rows = db
      .prepare(
        `WITH scoped_runs AS (SELECT r.* FROM runs r ${scope})
         SELECT sr.*,
           (SELECT COUNT(*) FROM responses WHERE run_id = sr.id) AS response_count,
           (SELECT COUNT(*) FROM responses WHERE run_id = sr.id AND is_valid = 0) AS invalid_count,
           (SELECT COALESCE(SUM(abstained), 0) FROM responses WHERE run_id = sr.id) AS abstained_count,
           (SELECT COALESCE(SUM(json_array_length(options_json)), 0)
              FROM questions WHERE questionnaire_id = sr.questionnaire_id)
           * (
               (SELECT COUNT(*) FROM run_personas WHERE run_id = sr.id)
               + COALESCE(json_extract(sr.config_json, '$.baselineArm'), 0)
             )
           * COALESCE(json_array_length(sr.config_json, '$.seeds'), 0)
             AS total_cells,
           CASE WHEN (
             (SELECT MAX(q2.version) FROM questionnaires q2
                WHERE q2.lineage_id = (SELECT lineage_id FROM questionnaires WHERE id = sr.questionnaire_id))
               > (SELECT version FROM questionnaires WHERE id = sr.questionnaire_id)
             OR EXISTS (
               SELECT 1 FROM run_personas rp
                 JOIN personas used ON used.id = rp.persona_id
                WHERE rp.run_id = sr.id
                  AND (SELECT MAX(v.version) FROM personas v WHERE v.lineage_id = used.lineage_id) > used.version
             )
           ) THEN 1 ELSE 0 END AS stale_versions,
           COALESCE(tl.prompt_tokens, 0) AS prompt_tokens,
           COALESCE(tl.completion_tokens, 0) AS completion_tokens,
           COALESCE(tl.prompt_tokens, 0) + COALESCE(tl.completion_tokens, 0) AS total_tokens,
           COALESCE(tl.cached_tokens, 0) AS cached_tokens,
           COALESCE(tl.cost_usd, 0) AS cost_usd
         FROM scoped_runs sr
         LEFT JOIN (
           SELECT run_id,
                  SUM(prompt_tokens) AS prompt_tokens,
                  SUM(completion_tokens) AS completion_tokens,
                  SUM(cached_tokens) AS cached_tokens,
                  SUM(cost_usd) AS cost_usd
             FROM token_ledger
            WHERE scope = 'run' AND run_id IN (SELECT id FROM scoped_runs)
            GROUP BY run_id
         ) tl ON tl.run_id = sr.id
         ORDER BY sr.created_at DESC`
      )
    const runs = (project === undefined ? rows.all() : rows.all(project)) as Record<string, unknown>[]
    // done_cells === response_count always (one cell = one response row) — see
    // the comment above on why this is derived here instead of a second,
    // identical subquery in the SQL above.
    return { success: true, data: runs.map((r) => ({ ...r, done_cells: r['response_count'] })) }
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
    return { success: true, data: { run, responses, usage: budget.usage(id, 'run'), staleVersions: staleVersionsOf(id) } }
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
    if (run.status === 'completed') {
      return reply.code(400).send({
        success: false,
        error: 'Nem lehet leállítani egy már befejezett futtatást — elveszne a kalibrációs profilhoz szükséges "completed" állapot'
      })
    }
    if (run.status === 'stopped') {
      return reply.code(400).send({ success: false, error: 'A futtatás már le van állítva' })
    }
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
        // W1: was budget.usage(id) with no scope filter — token_ledger.run_id
        // is shared key-space with interview ids (told apart only by scope),
        // so this used to sum an interview's spend into a run's total on any
        // (currently theoretical) id collision. Same 'run' filter the list
        // query's token_ledger join already uses, so the two can never
        // disagree for the same run.
        usage: budget.usage(id, 'run')
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
        .prepare(
          `SELECT id, model, content, prompt_tokens, completion_tokens, cost_usd, run_status, done_cells, total_cells,
                  model_profile_id, model_profile_status, model_profile_model_version, model_profile_provider,
                  model_profile_measured_at, model_profile_reasons_json, created_at
             FROM run_evaluations WHERE run_id = ? ORDER BY created_at DESC`
        )
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
