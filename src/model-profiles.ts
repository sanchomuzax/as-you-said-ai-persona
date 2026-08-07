import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { Db } from './db.js'
import type { ModelsConfig } from './config.js'
import { RESUMABLE, type SurveyRunner, type RunConfig } from './runner.js'
import {
  computeProfileMetrics,
  profileStatus,
  promptTemplateHash,
  sqliteToIso,
  PROFILE_VALIDITY_DAYS,
  type ProfileKey,
  type ProfileMetrics,
  type ProfileStatus,
  type StoredProfile
} from './lib/profile.js'

/**
 * Model calibration registry (docs/MODEL-CALIBRATION.md, M2).
 *
 * A profile answers one question: what does this model say when nobody tells it
 * who to be? Every persona result is only interpretable against that default, so
 * the registry exists to make the default measurable, dated and auditable —
 * never to correct the raw log, which stays append-only and untouched.
 */

interface ProfileRow {
  id: string
  model_requested: string
  model_version: string
  provider: string | null
  prompt_template_hash: string
  probe_questionnaire_id: string
  language: string
  run_ids_json: string
  metrics_json: string
  created_at: string
  valid_until: string
}

function toStoredProfile(row: ProfileRow): StoredProfile {
  return {
    id: row.id,
    modelRequested: row.model_requested,
    modelVersion: row.model_version,
    provider: row.provider,
    promptTemplateHash: row.prompt_template_hash,
    probeQuestionnaireId: row.probe_questionnaire_id,
    language: row.language,
    runIds: JSON.parse(row.run_ids_json) as string[],
    metrics: JSON.parse(row.metrics_json) as ProfileMetrics,
    createdAt: row.created_at,
    validUntil: row.valid_until
  }
}

/**
 * What the stack looks like RIGHT NOW for one model, read from the most recent
 * call actually made with it. This is how provider drift and a silent upstream
 * version bump are detected: the profile says what was measured, the last
 * response says what is being served.
 */
function observedStack(
  db: Db,
  model: string,
  since: string
): { modelVersion: string | null; provider: string | null } {
  // Every response SINCE the profile was measured, not just the newest one:
  // with only the latest row a single call served by another provider makes
  // the profile stale and the next one makes it valid again, so the drift
  // event would flicker instead of sticking.
  const rows = db
    .prepare(
      `SELECT DISTINCT model_version, provider FROM responses
        WHERE model_requested = ? AND created_at > ? AND model_version IS NOT NULL`
    )
    .all(model, since) as unknown as { model_version: string; provider: string | null }[]
  if (rows.length === 0) return { modelVersion: null, provider: null }
  const version = rows.find((r) => r.model_version !== null)?.model_version ?? null
  // A NULL provider is a call OpenRouter did not attribute — no news, not
  // different news. Only an actual, different provider name counts as drift.
  const named = rows.map((r) => r.provider).filter((p): p is string => p !== null)
  return { modelVersion: version, provider: named[0] ?? null }
}

/**
 * The most recently created profile for a model. Exported (alongside
 * `currentKeyFor` and `findProfileForRun` below) so callers outside this
 * module can look up the same profile without re-implementing the staleness
 * comparison themselves (issue #17 M3).
 */
export function latestProfileFor(db: Db, model: string): StoredProfile | null {
  const row = db
    // rowid breaks the tie: created_at is second-granular, so two profiles
    // stored in the same second would otherwise order arbitrarily.
    .prepare('SELECT * FROM model_profiles WHERE model_requested = ? ORDER BY created_at DESC, rowid DESC LIMIT 1')
    .get(model) as ProfileRow | undefined
  return row ? toStoredProfile(row) : null
}

/**
 * The key the profile is compared against for "is this profile current
 * TODAY" (the "Modellek" tab's question). Where nothing has been observed
 * since the profile was measured, the profile's own values are used: no news
 * is not evidence of drift, and marking a profile stale for lack of traffic
 * would cry wolf.
 */
export function currentKeyFor(db: Db, profile: StoredProfile): ProfileKey {
  const observed = observedStack(db, profile.modelRequested, profile.createdAt)
  return keyFromStack(db, profile, observed)
}

/**
 * The key a profile is compared against for ONE EVALUATED RUN (issue #17 M3
 * review, HIGH 1) — "does this profile describe the calls THIS RUN made",
 * which is a different question than "is it current today". A run answered by
 * Together/m1-2025-01 must never be judged against a later profile measured on
 * DeepInfra/m1-2026-05 just because nothing else has called the model since —
 * that "no news" fallback is correct for the global/"today" question above,
 * but would silently borrow a stack this run never used.
 */
function runKeyFor(db: Db, profile: StoredProfile, runStack: ObservedStack): ProfileKey {
  return keyFromStack(db, profile, runStack)
}

function keyFromStack(db: Db, profile: StoredProfile, observed: ObservedStack): ProfileKey {
  return {
    modelRequested: profile.modelRequested,
    modelVersion: observed.modelVersion ?? profile.modelVersion,
    provider: observed.provider ?? profile.provider,
    promptTemplateHash: promptTemplateHash(),
    // The probe itself is versioned: a newer version of the same lineage means
    // the profile describes questions that have since been reworded.
    probeQuestionnaireId: latestProbeVersionOf(db, profile.probeQuestionnaireId),
    language: profile.language
  }
}

type ObservedStack = { modelVersion: string | null; provider: string | null }

/**
 * The stack ONE RUN's own responses were actually served by — as opposed to
 * `observedStack`, which looks at everything the model has answered globally.
 * This is the fix for HIGH 1: a finished run's evaluation must be judged
 * against what answered THAT run, not against "whatever has been observed
 * since the profile was measured" (which a run that finished earlier than the
 * profile contributes nothing to, making comparisons vacuously pass).
 */
function observedRunStack(db: Db, runId: string): ObservedStack {
  const rows = db
    .prepare(
      `SELECT DISTINCT model_version, provider FROM responses
        WHERE run_id = ? AND model_version IS NOT NULL`
    )
    .all(runId) as unknown as { model_version: string; provider: string | null }[]
  if (rows.length === 0) return { modelVersion: null, provider: null }
  const version = rows.find((r) => r.model_version !== null)?.model_version ?? null
  const named = rows.map((r) => r.provider).filter((p): p is string => p !== null)
  return { modelVersion: version, provider: named[0] ?? null }
}

/**
 * The newest version in the probe's lineage. Spec §2 lists "probe
 * questionnaire revised" as a re-test trigger; without this lookup the
 * comparison would be the profile's own id against itself and could never fire.
 */
function latestProbeVersionOf(db: Db, questionnaireId: string): string {
  const row = db
    .prepare(
      `SELECT latest.id FROM questionnaires used
         JOIN questionnaires latest ON latest.lineage_id = used.lineage_id
        WHERE used.id = ?
        ORDER BY latest.version DESC LIMIT 1`
    )
    .get(questionnaireId) as { id: string } | undefined
  return row?.id ?? questionnaireId
}

/**
 * Why a profile is stale, so the UI/prompt can say the ACTUAL reason instead
 * of a generic list of every possible one. `db` is not needed — both `profile`
 * and `current` are already fully resolved keys by the time this runs.
 */
export function stalenessReasons(profile: StoredProfile, current: ProfileKey, nowIso: string): string[] {
  const reasons: string[] = []
  if (profile.modelVersion !== current.modelVersion) {
    reasons.push(`A modellverzió megváltozott (${profile.modelVersion} → ${current.modelVersion}).`)
  }
  if (profile.provider !== current.provider) {
    reasons.push(
      `A kiszolgáló szolgáltató megváltozott (${profile.provider ?? 'nincs rögzítve'} → ${current.provider ?? 'nincs rögzítve'}).`
    )
  }
  if (profile.promptTemplateHash !== current.promptTemplateHash) {
    reasons.push('Az elicitációs sablon azóta módosult, így a profil egy már nem létező promptot ír le.')
  }
  if (profile.probeQuestionnaireId !== current.probeQuestionnaireId) {
    reasons.push('A próba-kérdőívnek azóta új verziója készült, tehát a profil más kérdéseket ír le.')
  }
  if (Date.parse(sqliteToIso(profile.validUntil)) <= Date.parse(nowIso)) {
    reasons.push(`A profil érvényessége lejárt (${PROFILE_VALIDITY_DAYS} nap).`)
  }
  return reasons
}

/**
 * The single lookup `runEvaluation` (src/server.ts) needs: which profile (if
 * any) is active for the run being evaluated, judged against the STACK THAT
 * RUN ACTUALLY USED (issue #17 M3 review, HIGH 1 — see `runKeyFor` above), not
 * "today's" global stack. Both the profile's own measured stack and the run's
 * own observed stack are returned so the judge prompt can show both.
 *
 * Never throws on a partial/corrupt `metrics_json`: `profile.metrics` may be
 * null or missing fields (older profiles, or a future schema change), and this
 * function only touches the profile KEY (model/provider/template/probe/lang),
 * never `.metrics` — a caller reading `profile.metrics` still needs its own
 * optional chaining (see buildCalibrationSection in src/lib/evaluate.ts).
 */
export function findProfileForRun(
  db: Db,
  runId: string,
  model: string,
  now: () => Date = () => new Date()
): { profile: StoredProfile; status: ProfileStatus; reasons: string[]; runStack: ObservedStack } | null {
  const profile = latestProfileFor(db, model)
  if (!profile) return null
  const runStack = observedRunStack(db, runId)
  const current = runKeyFor(db, profile, runStack)
  const nowIso = now().toISOString()
  const status = profileStatus(profile, current, nowIso)
  const reasons = status === 'stale' ? stalenessReasons(profile, current, nowIso) : []
  return { profile, status, reasons, runStack }
}

/**
 * Every status from which a calibration loop is live or can become live
 * again — the ONE status set the calibrate guard, the resume guard and the
 * client (public/model-card.js, public/model-view.js) all agree defines
 * "active" (issue #29 review round 2, HIGH 1 and MED). Derived from
 * runner.ts's own RESUMABLE rather than re-listing it: RESUMABLE already
 * names every status a run can be launched into a live loop FROM (including
 * `budget_exhausted`, which the budget hard stop sets, and `pending`, which a
 * run never past its first setStatus('running') is left at) — re-listing a
 * narrower copy here is exactly how the original guard went stale. 'running'
 * itself is added because RESUMABLE only lists states a loop can be
 * (re)started FROM, not the currently-executing state itself.
 *
 * The client cannot literally import this — it runs in the browser, this
 * module runs in Node — so public/model-card.js mirrors the same five
 * literal values. That copy drifted narrower once before (round 2's bug,
 * caught only by hand); since round 3 (HIGH 3) a frontend test reads the
 * client's own copy out of the real file and compares it against this
 * export, value for value (tests/frontend-model-calibration-progress.test.ts)
 * — the one assertion that would actually catch the two drifting apart
 * again, which nothing did before that round.
 */
export const ACTIVE_CALIBRATION_STATUSES: ReadonlySet<string> = new Set(['running', ...RESUMABLE])

/**
 * The model a run's CONFIG_JSON marks itself as an active calibration launch
 * for, or null if it carries no `calibration: true` marker at all (see
 * RunConfig, src/runner.ts). Factored out of isCalibrationConfigFor below
 * (issue #29 review round 3, CRITICAL 2) so boot recovery (src/server.ts) can
 * group interrupted runs by model without a third copy of the same
 * malformed-JSON handling.
 *
 * Total over malformed input (issue #29 review round 2, MED): a config_json
 * of the literal text "null" makes `JSON.parse` return `null` rather than
 * throw, so the parse succeeding is not enough — `typeof` after the parse is
 * checked explicitly, otherwise reading `.calibration` off a null config
 * would throw and take the whole caller down with it.
 */
export function calibrationModelOf(configJson: string): string | null {
  let config: unknown
  try {
    config = JSON.parse(configJson)
  } catch {
    return null
  }
  if (config === null || typeof config !== 'object') return null
  const c = config as { model?: unknown; calibration?: unknown }
  return c.calibration === true && typeof c.model === 'string' ? c.model : null
}

/**
 * Whether CONFIG_JSON marks its run as an active calibration launch FOR
 * MODEL. Identity is the `calibration: true` marker plus config.model, never
 * the human-facing run name: a rewording of "Kalibráció — X" must not
 * silently disarm this (issue #29 review CRITICAL #1 / round 2 MED).
 */
function isCalibrationConfigFor(configJson: string, model: string): boolean {
  return calibrationModelOf(configJson) === model
}

export interface ActiveCalibration {
  id: string
  status: string
}

/**
 * The run currently blocking a new or resumed calibration loop for MODEL, if
 * any — the single lookup both entry points share (issue #29 review round 2,
 * HIGH 1): POST /api/models/:model/calibrate (below) and POST
 * /api/runs/:id/resume (src/server.ts). `excludeRunId` lets a resume ignore
 * the very run being resumed, so a model's ONLY calibration can always be
 * resumed even while its own status is one of ACTIVE_CALIBRATION_STATUSES.
 */
export function findActiveCalibration(db: Db, model: string, excludeRunId?: string): ActiveCalibration | null {
  const statuses = [...ACTIVE_CALIBRATION_STATUSES]
  const placeholders = statuses.map(() => '?').join(',')
  const rows = db
    .prepare(`SELECT id, status, config_json FROM runs WHERE status IN (${placeholders})`)
    .all(...statuses) as unknown as { id: string; status: string; config_json: string }[]
  for (const row of rows) {
    if (excludeRunId && row.id === excludeRunId) continue
    if (isCalibrationConfigFor(row.config_json, model)) return { id: row.id, status: row.status }
  }
  return null
}

/**
 * What to call each blocking status in the 409 body (issue #29 review round
 * 2, MED): the old message always said "Már fut", which is simply false for
 * `pending`/`paused`/`budget_exhausted`/`failed` — a researcher reading
 * "already running" about a paused or failed run is being told the wrong
 * story about their own experiment.
 */
const CALIBRATION_STATUS_TEXT: Record<string, string> = {
  running: 'már fut',
  paused: 'szüneteltetve van',
  pending: 'függőben van, még nem indult el',
  budget_exhausted: 'elfogyott a kerete, ezért megállt',
  failed: 'hibára futott'
}

/** The 409 body's message: the actual status, and which run to act on. */
function calibrationBlockedMessage(model: string, blocking: ActiveCalibration): string {
  const statusText = CALIBRATION_STATUS_TEXT[blocking.status] ?? blocking.status
  return `Kalibráció ${statusText} ehhez a modellhez: ${model} (futtatás: ${blocking.id}).`
}

/** The full 409 payload for a blocked calibrate/resume — status and run id as their own fields, not just prose, so the client can act on it without parsing the message. */
export function calibrationBlockedResponse(model: string, blocking: ActiveCalibration): {
  success: false
  error: string
  status: string
  runId: string
} {
  return { success: false, error: calibrationBlockedMessage(model, blocking), status: blocking.status, runId: blocking.id }
}

export interface ProfileDeps {
  db: Db
  models: ModelsConfig
  runner: SurveyRunner
  /** Injectable so a test does not depend on the wall clock. */
  now?: () => Date
}

export function registerModelProfileRoutes(app: FastifyInstance, deps: ProfileDeps): void {
  const { db, models, runner } = deps
  const now = deps.now ?? ((): Date => new Date())

  // Fully optional-chained (HIGH 2, issue #17 M3 review): a partial
  // metrics_json — e.g. {positivityOffset: 0.1} with no priorBias at all,
  // which a future schema change (M4) can produce for every profile M2 ever
  // wrote — must degrade to "not measured", never throw and take the whole
  // request down with it.
  const summarize = (profile: StoredProfile): Record<string, unknown> => {
    const metrics = profile.metrics
    return {
      positivityOffset: metrics?.positivityOffset ?? null,
      priorBiasMaxDeviation: metrics?.priorBias?.maxDeviation ?? null,
      invalidRate: metrics?.invalidRate ?? null,
      abstainRate: metrics?.abstainRate ?? null,
      questionCount: metrics?.perQuestion?.length ?? 0,
      cellCount: metrics?.provenance?.cellCount ?? 0,
      costUsd: metrics?.provenance?.costUsd ?? null
    }
  }

  // One row per CONFIGURED model, including the ones never calibrated: a missing
  // profile is the finding that matters most, and a list of only the measured
  // models would hide it.
  app.get('/api/model-profiles', async () => ({
    success: true,
    data: models.models.map((model) => {
      const profile = latestProfileFor(db, model.id)
      if (!profile) {
        return { model: model.id, label: model.label, status: 'missing', profile: null, reasons: [], summary: null }
      }
      const current = currentKeyFor(db, profile)
      const status = profileStatus(profile, current, now().toISOString())
      return {
        model: model.id,
        label: model.label,
        status,
        reasons: status === 'stale' ? stalenessReasons(profile, current, now().toISOString()) : [],
        summary: summarize(profile),
        profile: {
          id: profile.id,
          modelVersion: profile.modelVersion,
          provider: profile.provider,
          probeQuestionnaireId: profile.probeQuestionnaireId,
          language: profile.language,
          createdAt: profile.createdAt,
          validUntil: profile.validUntil,
          runIds: profile.runIds
        }
      }
    })
  }))

  /** The model card: every measured number plus what it was measured on. */
  app.get('/api/model-profiles/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const row = db.prepare('SELECT * FROM model_profiles WHERE id = ?').get(id) as ProfileRow | undefined
    if (!row) return reply.code(404).send({ success: false, error: 'A modell-profil nem található' })
    const profile = toStoredProfile(row)
    const current = currentKeyFor(db, profile)
    const status = profileStatus(profile, current, now().toISOString())
    const questionnaire = db
      .prepare('SELECT name, version FROM questionnaires WHERE id = ?')
      .get(profile.probeQuestionnaireId) as { name: string; version: number } | undefined
    return {
      success: true,
      data: {
        ...profile,
        status,
        reasons: status === 'stale' ? stalenessReasons(profile, current, now().toISOString()) : [],
        probeName: questionnaire?.name ?? null,
        probeVersion: questionnaire?.version ?? null
      }
    }
  })

  const createSchema = z.object({
    model: z.string().min(1),
    runIds: z.array(z.string().min(1)).min(1).max(50),
    // Part of the profile key, so it is a deliberate choice rather than free text.
    language: z.enum(['hu', 'en']).default('hu')
  })

  /**
   * Turns finished calibration runs into a profile. The measured stack is read
   * back OUT of the responses rather than taken from the request: a profile that
   * claimed a version or provider the calls did not actually use would be a
   * label on the wrong bottle.
   */
  app.post('/api/model-profiles', async (req, reply) => {
    const body = createSchema.safeParse(req.body)
    if (!body.success) return reply.code(400).send({ success: false, error: body.error.issues[0]?.message })

    const placeholders = body.data.runIds.map(() => '?').join(',')

    // The whole position-bias metric rests on the balanced-rotation invariant:
    // every option appears in every position exactly as often. A run stopped
    // halfway satisfies none of that, and the resulting profile would report a
    // content-driven model as position-driven with nothing marking the gap.
    const unfinished = db
      .prepare(`SELECT id, status FROM runs WHERE id IN (${placeholders}) AND status != 'completed'`)
      .all(...body.data.runIds) as unknown as { id: string; status: string }[]
    if (unfinished.length > 0) {
      return reply.code(400).send({
        success: false,
        error: `Csak befejezett futtatásból készíthető profil (${unfinished[0]!.id}: ${unfinished[0]!.status}).`
      })
    }

    const stacks = db
      .prepare(
        `SELECT DISTINCT model_requested, model_version, provider
           FROM responses
          WHERE run_id IN (${placeholders}) AND persona_id IS NULL AND model_version IS NOT NULL`
      )
      .all(...body.data.runIds) as unknown as {
      model_requested: string
      model_version: string
      provider: string | null
    }[]

    if (stacks.length === 0) {
      return reply
        .code(400)
        .send({ success: false, error: 'A megadott futtatásokban nincs perszóna nélküli (kontroll) válasz.' })
    }
    // Several versions or providers in one profile would average two different
    // models into a single number and present it as one measurement.
    const distinct = new Set(stacks.map((s) => `${s.model_requested}|${s.model_version}|${s.provider ?? ''}`))
    if (distinct.size > 1) {
      return reply.code(400).send({
        success: false,
        error:
          'A megadott futtatások több modellverziót vagy szolgáltatót érintenek, ezért nem írhatók le egyetlen profillal.'
      })
    }
    const stack = stacks[0]!
    if (stack.model_requested !== body.data.model) {
      return reply
        .code(400)
        .send({ success: false, error: `A futtatások nem ehhez a modellhez tartoznak: ${stack.model_requested}` })
    }

    const questionnaires = db
      .prepare(
        `SELECT DISTINCT questionnaire_id FROM runs WHERE id IN (${placeholders})`
      )
      .all(...body.data.runIds) as unknown as { questionnaire_id: string }[]
    if (questionnaires.length !== 1) {
      return reply
        .code(400)
        .send({ success: false, error: 'A kalibrációs futtatásoknak ugyanazt a próba-kérdőívet kell használniuk.' })
    }

    const metrics = computeProfileMetrics(db, body.data.runIds)
    // A profile with nothing usable behind it would still be dated, stored and
    // shown as "érvényes" — a measurement-shaped record of a failed measurement.
    const usable = metrics.perQuestion.reduce((sum, q) => sum + q.aggregatedResponseCount, 0)
    if (usable === 0) {
      return reply.code(400).send({
        success: false,
        error: 'A megadott futtatásokban nincs értékelhető válasz (minden cella érvénytelen vagy tartózkodás).'
      })
    }
    const createdAt = now()
    const validUntil = new Date(createdAt.getTime() + PROFILE_VALIDITY_DAYS * 24 * 60 * 60 * 1000)
    const id = randomUUID()
    db.prepare(
      `INSERT INTO model_profiles
         (id, model_requested, model_version, provider, prompt_template_hash,
          probe_questionnaire_id, language, run_ids_json, metrics_json, created_at, valid_until)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      id, stack.model_requested, stack.model_version, stack.provider, promptTemplateHash(),
      questionnaires[0]!.questionnaire_id, body.data.language,
      JSON.stringify(body.data.runIds), JSON.stringify(metrics),
      toSqliteUtc(createdAt), toSqliteUtc(validUntil)
    )
    return { success: true, data: { id } }
  })

  const calibrateSchema = z.object({
    questionnaireId: z.string().min(1),
    provider: z.string().min(1).optional(),
    temperature: z.number().min(0).max(2).default(1),
    seeds: z.array(z.number().int()).min(1).default([0, 1])
  })

  /**
   * Launches a calibration run: the probe questionnaire, no personas, control
   * arm on. The result is a run of persona-free cells — exactly what a profile
   * is computed from. It is an ordinary run in every other respect, so it is
   * visible, pausable and budgeted like the rest.
   */
  app.post('/api/models/:model/calibrate', async (req, reply) => {
    const { model } = req.params as { model: string }
    if (!models.models.some((m) => m.id === model)) {
      return reply.code(400).send({ success: false, error: `Ismeretlen modell: ${model}` })
    }
    const body = calibrateSchema.safeParse(req.body)
    if (!body.success) return reply.code(400).send({ success: false, error: body.error.issues[0]?.message })
    const questionnaire = db
      .prepare('SELECT id, name FROM questionnaires WHERE id = ?')
      .get(body.data.questionnaireId) as { id: string; name: string } | undefined
    if (!questionnaire) return reply.code(400).send({ success: false, error: 'A kérdőív nem található' })

    // CRITICAL (issue #29 review): the only protection used to be the
    // client's `disabled` attribute, computed at render time — a second
    // browser tab, a stale page, a double-click or a plain curl all bypass
    // that. A budget-spending, concurrency-sensitive mutation (issue #16)
    // must be refused server-side, not merely discouraged client-side.
    // Widened to ACTIVE_CALIBRATION_STATUSES (review round 2, HIGH 1): the
    // budget hard stop leaves a run 'budget_exhausted', never 'paused', and a
    // 'failed' run is resumable too — both used to slip through this check.
    const blocking = findActiveCalibration(db, model)
    if (blocking) {
      return reply.code(409).send(calibrationBlockedResponse(model, blocking))
    }

    const config: RunConfig = {
      model,
      temperature: body.data.temperature,
      seeds: body.data.seeds,
      // The whole point: persona-free cells only.
      baselineArm: true,
      // Marks the run as a calibration launch so the model card can list this
      // model's calibration runs without parsing the human-facing run name.
      calibration: true,
      ...(body.data.provider ? { provider: body.data.provider } : {})
    }
    const id = randomUUID()
    // The check above and this insert are one atomic step ONLY because
    // node:sqlite's DatabaseSync is synchronous and nothing here `await`s
    // between them — Node cannot interleave another request's handler in
    // between two synchronous statements on the same turn of the event loop.
    // If an `await` is ever introduced here, this comment stops being true
    // and the check must be re-run (or wrapped in `BEGIN IMMEDIATE` …
    // `COMMIT`) right before the insert (issue #29 review round 2, note).
    db.prepare('INSERT INTO runs (id, questionnaire_id, name, config_json) VALUES (?,?,?,?)').run(
      id, questionnaire.id, `Kalibráció — ${model}`, JSON.stringify(config)
    )
    // No run_personas rows at all: with zero personas and the arm on, the runner
    // fires exactly one control cell per question, rotation and seed.
    void runner.execute(id).catch(() => undefined)
    return { success: true, data: { runId: id } }
  })
}

/** Matches SQLite's own `datetime('now')` format so comparisons stay textual. */
function toSqliteUtc(date: Date): string {
  return date.toISOString().replace('T', ' ').slice(0, 19)
}
