import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { Db } from './db.js'
import type { ModelsConfig } from './config.js'
import type { ChatClient } from './openrouter.js'
import type { BudgetTracker } from './lib/budget.js'
import { toCsv } from './lib/csv.js'
import type { PersonaInput } from './lib/prompt.js'
import {
  buildInterviewMessages,
  detectAbstention,
  stripAbstentionMarker,
  type InterviewTurn
} from './lib/interview.js'

export class InterviewNotFoundError extends Error {}
export class BudgetExhaustedError extends Error {}
export class TurnInProgressError extends Error {}

/**
 * One outstanding turn per interview. Two questions sent at once would both read
 * the same history, produce the same turn numbers and race on the unique index —
 * and the loser's tokens would already have been spent.
 */
const askingInterviews = new Set<string>()

interface InterviewRow {
  id: string
  persona_id: string
  model_requested: string
  temperature: number
  seed: number
  provider: string | null
}

interface PersonaRow {
  name: string
  demographics_json: string
  biography: string | null
  rendering_style: string
}

export class InterviewService {
  constructor(
    private readonly db: Db,
    private readonly client: ChatClient,
    private readonly budget: BudgetTracker
  ) {}

  /**
   * One interview turn: the question is recorded together with the answer it
   * produced, never before it. A question stored on its own — because the call
   * failed — would show up in the transcript as something the persona ignored.
   */
  async ask(interviewId: string, question: string): Promise<void> {
    const interview = this.db
      .prepare('SELECT * FROM interviews WHERE id = ?')
      .get(interviewId) as InterviewRow | undefined
    if (!interview) throw new InterviewNotFoundError('Interview not found')

    if (askingInterviews.has(interviewId)) {
      throw new TurnInProgressError('This interview is already waiting for an answer')
    }
    askingInterviews.add(interviewId)
    try {
      await this.askLocked(interview, question)
    } finally {
      askingInterviews.delete(interviewId)
    }
  }

  private async askLocked(interview: InterviewRow, question: string): Promise<void> {
    const persona = this.db
      .prepare('SELECT name, demographics_json, biography, rendering_style FROM personas WHERE id = ?')
      .get(interview.persona_id) as PersonaRow | undefined
    if (!persona) throw new InterviewNotFoundError('Persona not found')

    const history = this.db
      .prepare('SELECT role, content FROM interview_messages WHERE interview_id = ? ORDER BY turn')
      .all(interview.id) as unknown as InterviewTurn[]

    // Checked before the call, like every other model call in the project: the
    // budget is a hard stop, and an interview spends from the same pool.
    if (!this.budget.canSpend(interview.id)) {
      throw new BudgetExhaustedError('Token budget exhausted')
    }

    const messages = buildInterviewMessages(toPersonaInput(persona), history, question)
    const result = await this.client.complete(interview.model_requested, messages, {
      temperature: interview.temperature,
      seed: interview.seed,
      provider: interview.provider ?? undefined
    })

    // Booked BEFORE the transcript write: the tokens were spent the moment the
    // provider answered, so a failed insert must not leave them unrecorded —
    // that is how a hard stop drifts past the configured budget.
    this.budget.record(
      interview.id,
      {
        promptTokens: result.promptTokens,
        completionTokens: result.completionTokens,
        cachedTokens: toCount(result.cachedTokens),
        costUsd: result.costUsd
      },
      'interview'
    )

    const nextTurn =
      ((this.db.prepare('SELECT MAX(turn) t FROM interview_messages WHERE interview_id = ?').get(interview.id) as {
        t: number | null
      }).t ?? 0) + 1

    this.db.exec('BEGIN')
    try {
      this.db
        .prepare('INSERT INTO interview_messages (id, interview_id, turn, role, content) VALUES (?,?,?,?,?)')
        .run(randomUUID(), interview.id, nextTurn, 'researcher', question)
      this.db
        .prepare(
          `INSERT INTO interview_messages (
             id, interview_id, turn, role, content, prompt_rendered, raw_response,
             model_requested, model_version, provider, temperature, seed, abstained,
             prompt_tokens, completion_tokens, cached_tokens, cost_usd, cache_discount_usd,
             latency_ms, openrouter_request_id
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        )
        .run(
          randomUUID(), interview.id, nextTurn + 1, 'persona',
          // The displayed answer drops the bookkeeping marker; `raw_response`
          // keeps the model's output exactly as it arrived.
          stripAbstentionMarker(result.content),
          JSON.stringify(messages), result.content,
          interview.model_requested, result.modelVersion, result.provider,
          interview.temperature, interview.seed, detectAbstention(result.content) ? 1 : 0,
          result.promptTokens, result.completionTokens, toCount(result.cachedTokens),
          result.costUsd, toAmount(result.cacheDiscountUsd), result.latencyMs, result.requestId
        )
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
}

const MESSAGE_COLUMNS = [
  'id', 'interview_id', 'turn', 'role', 'content', 'prompt_rendered', 'raw_response',
  'model_requested', 'model_version', 'provider', 'temperature', 'seed', 'abstained',
  'prompt_tokens', 'completion_tokens', 'cached_tokens', 'cost_usd', 'cache_discount_usd',
  'latency_ms', 'openrouter_request_id', 'created_at'
]

/** Everything the transcript view needs; the large prompt is fetched separately. */
const LIST_COLUMNS = [
  'id', 'turn', 'role', 'content', 'abstained', 'model_version', 'provider',
  'temperature', 'seed', 'prompt_tokens', 'completion_tokens', 'cached_tokens',
  'cost_usd', 'latency_ms', 'openrouter_request_id', 'created_at'
]

export interface InterviewDeps {
  db: Db
  models: ModelsConfig
  client: ChatClient
  budget: BudgetTracker
}

export function registerInterviewRoutes(app: FastifyInstance, deps: InterviewDeps): void {
  const { db, models, budget } = deps
  const service = new InterviewService(db, deps.client, budget)

  const createSchema = z.object({
    projectId: z.string().min(1).optional(),
    personaId: z.string().min(1),
    title: z.string().min(1).max(200),
    model: z.string().default(models.default),
    temperature: z.number().min(0).max(2).default(0.8),
    seed: z.number().int().min(0).max(2_147_483_647).default(0),
    provider: z.string().min(1).optional()
  })

  const interviewOf = (id: string): Record<string, unknown> | undefined =>
    db
      .prepare(
        `SELECT i.*, p.name AS persona_name, p.version AS persona_version, pr.name AS project_name
           FROM interviews i
           JOIN personas p ON p.id = i.persona_id
           LEFT JOIN projects pr ON pr.id = i.project_id
          WHERE i.id = ?`
      )
      .get(id) as Record<string, unknown> | undefined

  const toInterview = (r: Record<string, unknown>): Record<string, unknown> => ({
    id: r['id'],
    projectId: r['project_id'],
    projectName: r['project_name'] ?? null,
    personaId: r['persona_id'],
    personaName: r['persona_name'],
    personaVersion: r['persona_version'],
    title: r['title'],
    model: r['model_requested'],
    temperature: r['temperature'],
    seed: r['seed'],
    provider: r['provider'],
    createdAt: r['created_at'],
    turnCount: r['turn_count'] ?? undefined
  })

  app.post('/api/interviews', async (req, reply) => {
    const body = createSchema.safeParse(req.body)
    if (!body.success) return reply.code(400).send({ success: false, error: body.error.issues[0]?.message })
    if (!models.models.some((m) => m.id === body.data.model)) {
      return reply.code(400).send({ success: false, error: `Ismeretlen modell: ${body.data.model}` })
    }
    const persona = db.prepare('SELECT id FROM personas WHERE id = ?').get(body.data.personaId)
    if (!persona) return reply.code(400).send({ success: false, error: 'Ismeretlen perszóna' })
    if (body.data.projectId) {
      const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(body.data.projectId)
      if (!project) return reply.code(400).send({ success: false, error: 'Ismeretlen projekt' })
    }

    const id = randomUUID()
    db.prepare(
      `INSERT INTO interviews (id, project_id, persona_id, title, model_requested, temperature, seed, provider)
       VALUES (?,?,?,?,?,?,?,?)`
    ).run(
      id, body.data.projectId ?? null, body.data.personaId, body.data.title,
      body.data.model, body.data.temperature, body.data.seed, body.data.provider ?? null
    )
    return { success: true, data: { id } }
  })

  app.get('/api/interviews', async (req) => {
    const { project, persona } = req.query as { project?: string; persona?: string }
    const filters: string[] = []
    const params: string[] = []
    if (project) {
      filters.push('i.project_id = ?')
      params.push(project)
    }
    if (persona) {
      filters.push('i.persona_id = ?')
      params.push(persona)
    }
    const where = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : ''
    const rows = db
      .prepare(
        `SELECT i.*, p.name AS persona_name, p.version AS persona_version, pr.name AS project_name,
                (SELECT COUNT(*) FROM interview_messages m WHERE m.interview_id = i.id) AS turn_count
           FROM interviews i
           JOIN personas p ON p.id = i.persona_id
           LEFT JOIN projects pr ON pr.id = i.project_id
           ${where}
          ORDER BY i.created_at DESC`
      )
      .all(...params) as unknown as Record<string, unknown>[]
    return { success: true, data: rows.map(toInterview) }
  })

  app.get('/api/interviews/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const row = interviewOf(id)
    if (!row) return reply.code(404).send({ success: false, error: 'Az interjú nem található' })
    const messages = db
      .prepare(`SELECT ${LIST_COLUMNS.join(', ')} FROM interview_messages WHERE interview_id = ? ORDER BY turn`)
      .all(id)
    return { success: true, data: { interview: toInterview(row), messages, usage: budget.usage(id) } }
  })

  /** The exact conversation sent for one persona turn — large, so fetched on demand. */
  app.get('/api/interviews/:id/messages/:messageId', async (req, reply) => {
    const { id, messageId } = req.params as { id: string; messageId: string }
    const row = db
      .prepare(`SELECT ${MESSAGE_COLUMNS.join(', ')} FROM interview_messages WHERE id = ? AND interview_id = ?`)
      .get(messageId, id)
    if (!row) return reply.code(404).send({ success: false, error: 'A forduló nem található' })
    return { success: true, data: row }
  })

  app.post('/api/interviews/:id/messages', async (req, reply) => {
    const { id } = req.params as { id: string }
    // Bounded on purpose: every turn is a paid model call, and the whole
    // history is replayed, so one pasted document inflates every later turn too.
    const body = z.object({ content: z.string().trim().min(1).max(4000) }).safeParse(req.body)
    if (!body.success) return reply.code(400).send({ success: false, error: 'A kérdés nem lehet üres' })
    try {
      await service.ask(id, body.data.content)
    } catch (error) {
      if (error instanceof InterviewNotFoundError) {
        return reply.code(404).send({ success: false, error: 'Az interjú nem található' })
      }
      if (error instanceof BudgetExhaustedError) {
        return reply.code(429).send({ success: false, error: 'A token-keret elfogyott, az interjú nem folytatható' })
      }
      if (error instanceof TurnInProgressError) {
        return reply.code(409).send({ success: false, error: 'Az előző kérdés még válaszra vár' })
      }
      // The upstream message carries provider internals and up to 300 bytes of
      // the raw error body; that belongs in the log, not in a Hungarian alert
      // shown to a non-developer.
      app.log.error?.(error)
      return reply
        .code(502)
        .send({ success: false, error: 'A modell nem válaszolt. Próbáld újra, vagy nézd meg a szerver naplóját.' })
    }
    const messages = db
      .prepare(`SELECT ${LIST_COLUMNS.join(', ')} FROM interview_messages WHERE interview_id = ? ORDER BY turn`)
      .all(id)
    return { success: true, data: { messages, usage: budget.usage(id) } }
  })

  app.get('/api/interviews/:id/export.csv', async (req, reply) => {
    const { id } = req.params as { id: string }
    const interview = db.prepare('SELECT id FROM interviews WHERE id = ?').get(id)
    if (!interview) return reply.code(404).send({ success: false, error: 'Az interjú nem található' })
    const rows = db
      .prepare(`SELECT ${MESSAGE_COLUMNS.join(', ')} FROM interview_messages WHERE interview_id = ? ORDER BY turn`)
      .all(id) as Record<string, unknown>[]
    reply.header('Content-Type', 'text/csv; charset=utf-8')
    reply.header('Content-Disposition', `attachment; filename="interview-${id}.csv"`)
    return toCsv(MESSAGE_COLUMNS, rows)
  })
}

function toPersonaInput(row: PersonaRow): PersonaInput {
  return {
    name: row.name,
    demographics: JSON.parse(row.demographics_json) as Record<string, unknown>,
    biography: row.biography ?? undefined,
    renderingStyle:
      row.rendering_style === 'natural_language_sentence' ? 'natural_language_sentence' : 'bulleted_profile'
  }
}

/** Usage numbers come from an external API; a NaN would fail the column bind. */
function toCount(value: unknown): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value as number)) : 0
}

function toAmount(value: unknown): number {
  return Number.isFinite(value) ? Math.max(0, value as number) : 0
}
