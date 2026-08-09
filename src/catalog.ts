import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { Db } from './db.js'

/**
 * Persona and questionnaire routes. Both are immutable, versioned snapshots:
 * editing appends a new version so a finished run always refers to the exact
 * subject and wording that answered. Extracted from server.ts, which had grown
 * past the project's file-size limit.
 */

export interface CatalogDeps {
  db: Db
}

export function registerCatalogRoutes(app: FastifyInstance, deps: CatalogDeps): void {
  const { db } = deps

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

  /**
   * MAX(version) over an empty lineage is NULL, and `null + 1` is 1 in JS — that
   * would create a SECOND version 1 and corrupt the chain silently. A lineage with
   * no rows means the data is already broken, so say so instead.
   */
  const nextVersionFor = (table: 'personas' | 'questionnaires', lineageId: string): number => {
    const row = db.prepare(`SELECT MAX(version) v FROM ${table} WHERE lineage_id = ?`).get(lineageId) as {
      v: number | null
    }
    if (row.v === null) throw new Error(`Corrupt lineage: no ${table} rows for lineage_id ${lineageId}`)
    return row.v + 1
  }

  // Only the newest version of each lineage: older versions stay reachable through
  // the version history, but the working list must not show three "Anna"s.
  const LATEST_PERSONAS = `SELECT p.* FROM personas p
     WHERE p.version = (SELECT MAX(p2.version) FROM personas p2 WHERE p2.lineage_id = p.lineage_id)`

  app.get('/api/personas', async (req) => {
    const { project } = req.query as { project?: string }
    const rows = project
      ? db.prepare(`${LATEST_PERSONAS} AND p.project_id = ? ORDER BY p.created_at DESC`).all(project)
      : db.prepare(`${LATEST_PERSONAS} ORDER BY p.created_at DESC`).all()
    return { success: true, data: (rows as Record<string, unknown>[]).map((r) => ({ ...rowToPersona(r), isLatest: true })) }
  })

  const isLatestVersion = (table: 'personas' | 'questionnaires', row: Record<string, unknown>): boolean =>
    (db
      .prepare(`SELECT MAX(version) v FROM ${table} WHERE lineage_id = ?`)
      .get(String(row['lineage_id'] ?? row['id'])) as { v: number | null }).v === Number(row['version'])

  // Superseded versions stay addressable: a run points at the exact version that
  // answered, so a link to it must keep working after an edit.
  app.get('/api/personas/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const row = db.prepare('SELECT * FROM personas WHERE id = ?').get(id) as Record<string, unknown> | undefined
    if (!row) return reply.code(404).send({ success: false, error: 'A perszóna nem található' })
    return { success: true, data: { ...rowToPersona(row), isLatest: isLatestVersion('personas', row) } }
  })

  app.get('/api/personas/:id/versions', async (req, reply) => {
    const { id } = req.params as { id: string }
    const persona = db.prepare('SELECT lineage_id FROM personas WHERE id = ?').get(id) as { lineage_id: string } | undefined
    if (!persona) return reply.code(404).send({ success: false, error: 'A perszóna nem található' })
    const rows = db
      .prepare('SELECT * FROM personas WHERE lineage_id = ? ORDER BY version')
      .all(persona.lineage_id) as unknown as Record<string, unknown>[]
    const latest = Math.max(...rows.map((r) => Number(r['version'])))
    return {
      success: true,
      data: rows.map((r) => ({ ...rowToPersona(r), isLatest: Number(r['version']) === latest }))
    }
  })

  // Editing a persona in place would retroactively change WHO answered a finished
  // run, so an edit appends a new version and leaves every earlier one untouched.
  app.post('/api/personas/:id/versions', async (req, reply) => {
    const { id } = req.params as { id: string }
    const source = db.prepare('SELECT * FROM personas WHERE id = ?').get(id) as Record<string, unknown> | undefined
    if (!source) return reply.code(404).send({ success: false, error: 'A perszóna nem található' })
    const body = personaSchema.omit({ projectId: true, renderingStyle: true })
      .extend({ renderingStyle: personaSchema.shape.renderingStyle.optional() })
      .safeParse(req.body)
    if (!body.success) return reply.code(400).send({ success: false, error: body.error.issues[0]?.message })
    // Rendering style is an experimental variable: an omitted value must inherit
    // from the source version, never fall back to the schema default.
    const renderingStyle = body.data.renderingStyle ?? String(source['rendering_style'])

    const lineageId = String(source['lineage_id'] ?? source['id'])
    const nextVersion = nextVersionFor('personas', lineageId)
    const newId = randomUUID()
    db.prepare(
      `INSERT INTO personas (id, project_id, lineage_id, name, version, demographics_json, biography, rendering_style, provenance_json)
       VALUES (?,?,?,?,?,?,?,?,?)`
    ).run(
      newId, (source['project_id'] as string | null) ?? null, lineageId, body.data.name, nextVersion,
      JSON.stringify(body.data.demographics), body.data.biography ?? null, renderingStyle,
      body.data.provenance ? JSON.stringify(body.data.provenance) : null
    )
    return { success: true, data: { id: newId, version: nextVersion } }
  })

  app.post('/api/personas', async (req, reply) => {
    const body = personaSchema.safeParse(req.body)
    if (!body.success) return reply.code(400).send({ success: false, error: body.error.issues[0]?.message })
    const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(body.data.projectId)
    if (!project) return reply.code(400).send({ success: false, error: 'Ismeretlen projekt' })
    const id = randomUUID()
    db.prepare(
      'INSERT INTO personas (id, project_id, lineage_id, name, demographics_json, biography, rendering_style, provenance_json) VALUES (?,?,?,?,?,?,?,?)'
    ).run(
      id,
      body.data.projectId,
      id, // a new persona is the root of its own lineage
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
    // CONTENT language of the questions/options (issue #33) — drives the
    // elicitation TEMPLATE's default language for runs against this
    // questionnaire. Defaults to 'hu': this project's whole corpus is
    // Hungarian-market research.
    language: z.enum(['hu', 'en']).default('hu'),
    questions: z
      .array(
        z.object({
          text: z.string().min(1),
          options: z.array(z.string().min(1)).min(2).max(26),
          // A typo here would silently revert a multi-select question to sum-to-1
          // elicitation, so the value is constrained rather than free text.
          scaleType: z.enum(['single_choice', 'multi_choice', 'frequency', 'ordinal', 'categorical']).default('categorical'),
          scaleDirection: z.enum(['ascending', 'descending']).default('ascending'),
          metadata: z.record(z.unknown()).nullable().optional()
        })
      )
      .min(1)
  })

  const LATEST_QUESTIONNAIRES = `SELECT q.*,
       CASE WHEN q.is_calibration_probe = 1 OR EXISTS (
         SELECT 1 FROM projects p WHERE p.id = q.project_id AND p.name = 'Modell-baseline próba'
       ) THEN 1 ELSE 0 END AS effective_calibration_probe
     FROM questionnaires q
     WHERE q.version = (SELECT MAX(q2.version) FROM questionnaires q2 WHERE q2.lineage_id = q.lineage_id)`

  app.get('/api/questionnaires', async (req) => {
    const { project } = req.query as { project?: string }
    const qs = (project
      ? db.prepare(`${LATEST_QUESTIONNAIRES} AND (q.project_id = ? OR q.project_id IS NULL) ORDER BY q.created_at DESC`).all(project)
      : db.prepare(`${LATEST_QUESTIONNAIRES} ORDER BY q.created_at DESC`).all()) as unknown as {
      id: string
      name: string
      project_id: string | null
      language: string
      version: number
      effective_calibration_probe: number
    }[]
    // Scoped to the questionnaires actually being returned: this used to scan
    // the whole questions table on every call and filter in memory.
    const placeholders = qs.map(() => '?').join(',')
    const questions = (qs.length === 0
      ? []
      : db
          .prepare(`SELECT * FROM questions WHERE questionnaire_id IN (${placeholders}) ORDER BY ord`)
          .all(...qs.map((q) => q.id))) as unknown as {
      questionnaire_id: string
      id: string
      text: string
      options_json: string
      scale_type: string
      scale_direction: string
      metadata_json: string | null
    }[]
    return {
      success: true,
      data: qs.map((q) => ({
        id: q.id,
        projectId: q.project_id,
        name: q.name,
        language: q.language,
        version: q.version,
        isCalibrationProbe: q.effective_calibration_probe === 1,
        questions: questions
          .filter((x) => x.questionnaire_id === q.id)
          .map((x) => ({
            id: x.id,
            text: x.text,
            options: JSON.parse(x.options_json) as string[],
            // carried so an edit can round-trip them: dropping scaleType would
            // silently re-ask a multi-select question as a sum-to-1 distribution
            scaleType: x.scale_type,
            scaleDirection: x.scale_direction,
            metadata: parseQuestionMetadata(x.metadata_json)
          }))
      }))
    }
  })

  const questionsOf = (questionnaireId: string): { id: string; text: string; options: string[]; scaleType: string; scaleDirection: string; metadata: Record<string, unknown> | null }[] =>
    (db.prepare('SELECT * FROM questions WHERE questionnaire_id = ? ORDER BY ord').all(questionnaireId) as unknown as {
      id: string
      text: string
      options_json: string
      scale_type: string
      scale_direction: string
      metadata_json: string | null
    }[]).map((x) => ({
      id: x.id,
      text: x.text,
      options: JSON.parse(x.options_json) as string[],
      scaleType: x.scale_type,
      scaleDirection: x.scale_direction,
      metadata: parseQuestionMetadata(x.metadata_json)
    }))

  app.get('/api/questionnaires/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const row = db.prepare('SELECT * FROM questionnaires WHERE id = ?').get(id) as Record<string, unknown> | undefined
    if (!row) return reply.code(404).send({ success: false, error: 'A kérdőív nem található' })
    return {
      success: true,
      data: {
        id: row['id'],
        name: row['name'],
        projectId: row['project_id'],
        language: row['language'],
        version: row['version'],
        createdAt: row['created_at'],
        isLatest: isLatestVersion('questionnaires', row),
        questions: questionsOf(id)
      }
    }
  })

  app.get('/api/questionnaires/:id/versions', async (req, reply) => {
    const { id } = req.params as { id: string }
    const row = db.prepare('SELECT lineage_id FROM questionnaires WHERE id = ?').get(id) as { lineage_id: string } | undefined
    if (!row) return reply.code(404).send({ success: false, error: 'A kérdőív nem található' })
    const versions = db
      .prepare('SELECT * FROM questionnaires WHERE lineage_id = ? ORDER BY version')
      .all(row.lineage_id) as unknown as {
      id: string
      name: string
      version: number
      project_id: string | null
      language: string
      created_at: string
    }[]
    const latest = Math.max(...versions.map((v) => v.version))
    return {
      success: true,
      data: versions.map((v) => ({
        id: v.id,
        name: v.name,
        version: v.version,
        projectId: v.project_id,
        language: v.language,
        createdAt: v.created_at,
        isLatest: v.version === latest,
        questions: questionsOf(v.id)
      }))
    }
  })

  // Editing a question after a run would make the recorded answers uninterpretable
  // (the answer would refer to a text nobody was asked), so edits append a version.
  // A new version must carry every question setting explicitly. Defaulting here
  // would let a form that simply does not know about scale types rewrite a
  // multi-select question into a sum-to-1 one without anybody noticing.
  // `language` is the one exception: left OPTIONAL (no default) so a caller that
  // omits it inherits the SOURCE questionnaire's own language below, instead of
  // an English questionnaire silently reverting to 'hu' on its next edit.
  const questionnaireVersionSchema = questionnaireSchema.omit({ projectId: true, language: true }).extend({
    language: z.enum(['hu', 'en']).optional(),
    sourceQuestionIds: z.array(z.string().min(1).nullable()).optional(),
    questions: z
      .array(
        z.object({
          id: z.string().min(1).optional(),
          text: z.string().min(1),
          options: z.array(z.string().min(1)).min(2).max(26),
          scaleType: z.enum(['single_choice', 'multi_choice', 'frequency', 'ordinal', 'categorical']),
          scaleDirection: z.enum(['ascending', 'descending']),
          metadata: z.record(z.unknown()).nullable().optional()
        })
      )
      .min(1)
  })

  app.post('/api/questionnaires/:id/versions', async (req, reply) => {
    const { id } = req.params as { id: string }
    const source = db.prepare('SELECT * FROM questionnaires WHERE id = ?').get(id) as Record<string, unknown> | undefined
    if (!source) return reply.code(404).send({ success: false, error: 'A kérdőív nem található' })
    const body = questionnaireVersionSchema.safeParse(req.body)
    if (!body.success) return reply.code(400).send({ success: false, error: body.error.issues[0]?.message })

    const sourceQuestions = db.prepare('SELECT id, options_json, metadata_json FROM questions WHERE questionnaire_id = ? ORDER BY ord')
      .all(id) as unknown as { id: string; options_json: string; metadata_json: string | null }[]
    const sourceIds = new Set(sourceQuestions.map((question) => question.id))
    const sidecarIds = body.data.sourceQuestionIds
    const carriesQuestionIds = body.data.questions.some((question) => question.id !== undefined) || sidecarIds !== undefined
    const identityError = (message: string) => reply.code(400).send({
      success: false,
      error: `A kérdésazonosítók hibásak: ${message}. A referencia-opciók biztonsága miatt a verzió nem menthető.`
    })
    if (sidecarIds && sidecarIds.length !== body.data.questions.length) {
      return identityError('a sourceQuestionIds listának minden beküldött kérdéshez egy elemet kell tartalmaznia')
    }
    const mappedIds: (string | null)[] = []
    for (const [index, question] of body.data.questions.entries()) {
      const embedded = question.id ?? null
      const sidecar = sidecarIds?.[index] ?? null
      if (embedded && sidecar && embedded !== sidecar) return identityError('az id és a sourceQuestionIds eltér egymástól')
      const mapped = embedded ?? sidecar
      if (mapped && !sourceIds.has(mapped)) return identityError(`ismeretlen kérdésazonosító: ${mapped}`)
      mappedIds.push(mapped)
    }
    const nonNullIds = mappedIds.filter((value): value is string => value !== null)
    if (new Set(nonNullIds).size !== nonNullIds.length) return identityError('egy kérdésazonosító többször szerepel')
    if (carriesQuestionIds) {
      const unmappedReference = body.data.questions.find((question, index) =>
        question.metadata?.['_reference'] !== undefined && mappedIds[index] === null
      )
      if (unmappedReference) return identityError('referencia-metaadatos kérdéshez hiányzik a forráskérdés azonosítója')
      for (const [index, mappedId] of mappedIds.entries()) {
        if (!mappedId) continue
        const original = sourceQuestions.find((question) => question.id === mappedId)!
        const originalReference = parseQuestionMetadata(original.metadata_json)?.['_reference'] ?? null
        const submittedReference = body.data.questions[index]?.metadata?.['_reference'] ?? null
        if (JSON.stringify(submittedReference) !== JSON.stringify(originalReference)) {
          return identityError('a referencia-metaadat nem egyezik a forráskérdésével')
        }
      }
    }
    for (const [index, original] of sourceQuestions.entries()) {
      const metadata = parseQuestionMetadata(original.metadata_json)
      if (!metadata?.['_reference']) continue
      // Current clients carry the immutable source question id, so deleting an
      // unrelated earlier question cannot shift this comparison. Positional
      // fallback protects older clients that do not know the new field yet.
      const next = carriesQuestionIds
        ? body.data.questions[mappedIds.indexOf(original.id)]
        : body.data.questions[index]
      if (next && JSON.stringify(next.options) !== original.options_json) {
        return reply.code(400).send({
          success: false,
          error: 'Referencia-metaadattal ellátott kérdés válaszopciói nem módosíthatók, mert az opcióindexek elavulnának. Hozz létre új kérdőívet friss referenciával.'
        })
      }
    }

    const lineageId = String(source['lineage_id'] ?? source['id'])
    const nextVersion = nextVersionFor('questionnaires', lineageId)
    const newId = randomUUID()
    const language = body.data.language ?? (source['language'] as string | undefined) ?? 'hu'
    db.exec('BEGIN')
    try {
      db.prepare('INSERT INTO questionnaires (id, project_id, lineage_id, name, version, language, is_calibration_probe) VALUES (?,?,?,?,?,?,?)').run(
        newId, (source['project_id'] as string | null) ?? null, lineageId, body.data.name, nextVersion, language,
        Number(source['is_calibration_probe'] ?? 0)
      )
      body.data.questions.forEach((q, ord) => {
        db.prepare(
          'INSERT INTO questions (id, questionnaire_id, ord, text, scale_type, options_json, scale_direction, metadata_json) VALUES (?,?,?,?,?,?,?,?)'
        ).run(
          randomUUID(), newId, ord, q.text, q.scaleType, JSON.stringify(q.options), q.scaleDirection,
          q.metadata ? JSON.stringify(q.metadata) : null
        )
      })
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    return { success: true, data: { id: newId, version: nextVersion } }
  })

  app.post('/api/questionnaires', async (req, reply) => {
    const body = questionnaireSchema.safeParse(req.body)
    if (!body.success) return reply.code(400).send({ success: false, error: body.error.issues[0]?.message })
    const id = randomUUID()
    if (body.data.projectId) {
      const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(body.data.projectId)
      if (!project) return reply.code(400).send({ success: false, error: 'Ismeretlen projekt' })
    }
    const project = body.data.projectId
      ? db.prepare('SELECT name FROM projects WHERE id = ?').get(body.data.projectId) as { name: string } | undefined
      : undefined
    const isCalibrationProbe = project?.name === 'Modell-baseline próba' ? 1 : 0
    db.exec('BEGIN')
    try {
      db.prepare('INSERT INTO questionnaires (id, project_id, lineage_id, name, language, is_calibration_probe) VALUES (?,?,?,?,?,?)').run(
        id, body.data.projectId ?? null, id, body.data.name, body.data.language, isCalibrationProbe
      )
      body.data.questions.forEach((q, ord) => {
        db.prepare(
          'INSERT INTO questions (id, questionnaire_id, ord, text, scale_type, options_json, scale_direction, metadata_json) VALUES (?,?,?,?,?,?,?,?)'
        ).run(
          randomUUID(), id, ord, q.text, q.scaleType, JSON.stringify(q.options), q.scaleDirection,
          q.metadata ? JSON.stringify(q.metadata) : null
        )
      })
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    return { success: true, data: { id } }
  })
}

function rowToPersona(r: Record<string, unknown>): Record<string, unknown> {
  return {
    id: r['id'],
    projectId: r['project_id'],
    name: r['name'],
    lineageId: r['lineage_id'],
    version: r['version'],
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

/** Question metadata drives analysis, so corruption must fail loudly instead of disappearing. */
function parseQuestionMetadata(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined || value === '') return null
  const parsed = JSON.parse(String(value)) as unknown
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('A kérdés metaadata nem JSON-objektum')
  }
  return parsed as Record<string, unknown>
}
