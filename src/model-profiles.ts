import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { Db } from './db.js'
import type { ModelsConfig } from './config.js'
import type { SurveyRunner, RunConfig } from './runner.js'
import {
  computeProfileMetrics,
  profileStatus,
  promptTemplateHash,
  sqliteToIso,
  PROFILE_VALIDITY_DAYS,
  LEGACY_TEMPLATE_LANGUAGE,
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
  template_language: string
  run_ids_json: string
  metrics_json: string
  created_at: string
  valid_until: string
}

/**
 * Whether a run's config marks it as a calibration launch (issue #35). The
 * single source of truth for reading `RunConfig.calibration` on the backend,
 * so every caller — the evaluation prompt today, anything else tomorrow —
 * checks the SAME flag the SAME way. Deliberately NOT derived from the run
 * name (a human-facing label the researcher can rename) and NOT from "this
 * run happens to have zero personas": an ORDINARY research run can
 * legitimately have zero personas too (e.g. control-arm-only exploration),
 * and reading that as calibration would misclassify it.
 */
export function isCalibrationRun(config: RunConfig): boolean {
  return config.calibration === true
}

/** Minimal runtime shape needed before a stored config can drive execution. */
export function parseStoredRunConfig(value: string): RunConfig | null {
  try {
    const parsed = JSON.parse(value) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const candidate = parsed as Partial<RunConfig>
    if (
      typeof candidate.model !== 'string' || candidate.model.length === 0 ||
      typeof candidate.temperature !== 'number' || !Number.isFinite(candidate.temperature) ||
      !Array.isArray(candidate.seeds) || !candidate.seeds.every(Number.isInteger)
    ) return null
    return candidate as RunConfig
  } catch {
    return null
  }
}

/**
 * Marker-era rows use `calibration:true`. Before that marker existed, the
 * launcher wrote one exact, model-derived name; accept only that exact legacy
 * provenance, never a merely similar researcher-authored name.
 */
export function isCalibrationRunRecord(config: RunConfig, name: string): boolean {
  return isCalibrationRun(config) ||
    (config.calibration === undefined && name === `Kalibráció — ${config.model}`)
}

/**
 * A calibration that can still consume work or be resumed blocks launching a
 * second calibration for the same model. Completed/stopped runs are history,
 * not locks. Kept on the backend because two tabs can bypass any disabled UI.
 */
export const ACTIVE_CALIBRATION_STATUSES = ['pending', 'running', 'paused', 'budget_exhausted', 'failed'] as const

export function activeCalibrationForModel(
  db: Db,
  model: string,
  excludeRunIds: readonly string[] = []
): { id: string; status: string } | null {
  const excluded = new Set(excludeRunIds)
  const rows = db
    .prepare(`SELECT id, name, status, config_json FROM runs WHERE status IN (${ACTIVE_CALIBRATION_STATUSES.map(() => '?').join(',')})`)
    .all(...ACTIVE_CALIBRATION_STATUSES) as unknown as { id: string; name: string; status: string; config_json: string }[]
  for (const row of rows) {
    if (excluded.has(row.id)) continue
    const config = parseStoredRunConfig(row.config_json)
    // Exact legacy launcher provenance is enough to fail closed even when its
    // old config is corrupt: silently launching would risk a second paid run.
    if (!config && row.name === `Kalibráció — ${model}`) return { id: row.id, status: row.status }
    if (config && config.model === model && isCalibrationRunRecord(config, row.name)) {
      return { id: row.id, status: row.status }
    }
  }
  return null
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
    templateLanguage: row.template_language,
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
    language: profile.language,
    // Not something that can "drift" the way model version/provider do — it is
    // an axis of the profile's own identity, so "current" trivially copies it,
    // exactly like `language` above. Staleness from a template edit is carried
    // entirely by promptTemplateHash (see profile.ts), which fingerprints
    // every language at once.
    templateLanguage: profile.templateLanguage
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
    // A profile built before issue #33 (the elicitation template becoming
    // language-dependent) will ALWAYS go stale here — every one of them was
    // measured with the old, always-English framing. That is a one-time,
    // deliberate methodological change, not a defect, so it gets its own
    // wording naming the actual cause instead of the generic "the template
    // changed" message, which would read as something having broken.
    if (profile.templateLanguage === undefined || profile.templateLanguage === LEGACY_TEMPLATE_LANGUAGE) {
      reasons.push(
        'Az elicitációs sablon nyelvfüggővé vált: a kérdés/kérdőív nyelvéhez igazodó sablon váltotta fel az ' +
          'eddigi, mindig angol keretezést (lásd #33) — ez szándékos módszertani változás, nem hiba. A profil ' +
          'a régi, kevert nyelvű sablonnal mért adatot írja le, ezért újramérendő.'
      )
    } else {
      reasons.push('Az elicitációs sablon azóta módosult, így a profil egy már nem létező promptot ír le.')
    }
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
          templateLanguage: profile.templateLanguage,
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

    // The elicitation TEMPLATE's language (issue #33) — read out of each run's
    // OWN config, exactly like model_version/provider above are read out of
    // the responses rather than trusted from the request. A run written before
    // this field existed reads as the legacy sentinel, never as a guess.
    const runConfigs = db
      .prepare(`SELECT config_json FROM runs WHERE id IN (${placeholders})`)
      .all(...body.data.runIds) as unknown as { config_json: string }[]
    const templateLanguages = new Set(
      runConfigs.map((r) => (JSON.parse(r.config_json) as RunConfig).templateLanguage ?? LEGACY_TEMPLATE_LANGUAGE)
    )
    if (templateLanguages.size > 1) {
      return reply.code(400).send({
        success: false,
        error:
          'A megadott futtatások különböző elicitációs sablon-nyelvet használtak, ezért nem írhatók le egyetlen profillal.'
      })
    }
    const templateLanguage = [...templateLanguages][0] ?? LEGACY_TEMPLATE_LANGUAGE

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
          probe_questionnaire_id, language, template_language, run_ids_json, metrics_json, created_at, valid_until)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      id, stack.model_requested, stack.model_version, stack.provider, promptTemplateHash(),
      questionnaires[0]!.questionnaire_id, body.data.language, templateLanguage,
      JSON.stringify(body.data.runIds), JSON.stringify(metrics),
      toSqliteUtc(createdAt), toSqliteUtc(validUntil)
    )
    return { success: true, data: { id } }
  })

  const calibrateSchema = z.object({
    questionnaireId: z.string().min(1),
    provider: z.string().min(1).optional(),
    temperature: z.number().min(0).max(2).default(1),
    seeds: z.array(z.number().int()).min(1).default([0, 1]),
    // Optional override; the default is the probe questionnaire's own
    // language, looked up below — see POST /api/runs for the same rule.
    templateLanguage: z.enum(['hu', 'en']).optional()
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
      .prepare('SELECT id, name, language FROM questionnaires WHERE id = ?')
      .get(body.data.questionnaireId) as { id: string; name: string; language: string } | undefined
    if (!questionnaire) return reply.code(400).send({ success: false, error: 'A kérdőív nem található' })

    const blocking = activeCalibrationForModel(db, model)
    if (blocking) {
      return reply.code(409).send({
        success: false,
        error: `Már van aktív kalibráció ehhez a modellhez (${blocking.status}); előbb folytasd vagy állítsd le.`
      })
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
      templateLanguage: body.data.templateLanguage ?? (questionnaire.language === 'en' ? 'en' : 'hu'),
      ...(body.data.provider ? { provider: body.data.provider } : {})
    }
    const id = randomUUID()
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
