import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { Db } from './db.js'
import type { ChatClient } from './openrouter.js'
import { BudgetTracker } from './lib/budget.js'
import { balancedRotations } from './lib/permutation.js'
import { buildStyleCPrompt, type PersonaInput } from './lib/prompt.js'
import { parseDistribution, elicitationModeFor } from './lib/parse.js'

export interface RunConfig {
  model: string
  temperature: number
  seeds: number[]
  autoEvaluate?: boolean
  /** Pinned upstream provider; part of the experimental configuration. */
  provider?: string
}

/** In-memory control signals; checked between cells. */
const controls = new Map<string, 'pause' | 'stop'>()

export function requestPause(runId: string): void {
  controls.set(runId, 'pause')
}

export function requestStop(runId: string): void {
  controls.set(runId, 'stop')
}

const RESUMABLE = new Set(['paused', 'budget_exhausted', 'failed', 'pending'])

export function isResumable(status: string): boolean {
  return RESUMABLE.has(status)
}

export const runEvents = new EventEmitter()
runEvents.setMaxListeners(100) // each SSE client adds 2 listeners

/**
 * Usage numbers come from an external API: NaN or a negative value would fail the
 * NOT NULL column bind and lose an otherwise good model answer, so they are
 * normalised at the boundary instead.
 */
function toCount(value: unknown): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value as number)) : 0
}

/** Same reasoning for monetary amounts, which are fractional. */
function toAmount(value: unknown): number {
  return Number.isFinite(value) ? Math.max(0, value as number) : 0
}

interface PersonaRow {
  id: string
  name: string
  demographics_json: string
  biography: string | null
  rendering_style: string
}

interface QuestionRow {
  id: string
  text: string
  options_json: string
  scale_type: string
}

/**
 * Executes one run: question x persona x rotation x seed, each cell a stateless
 * API call (per-question memory reset). Budget checked before every call;
 * every call appended to `responses` (invalid outputs kept, flagged).
 */
export class SurveyRunner {
  constructor(
    private readonly db: Db,
    private readonly client: ChatClient,
    private readonly budget: BudgetTracker
  ) {}

  async execute(runId: string): Promise<void> {
    const run = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(runId) as
      | { id: string; questionnaire_id: string; config_json: string; status: string }
      | undefined
    if (!run) throw new Error(`Run not found: ${runId}`)
    const config = JSON.parse(run.config_json) as RunConfig

    const personas = this.db
      .prepare(
        'SELECT p.* FROM personas p JOIN run_personas rp ON rp.persona_id = p.id WHERE rp.run_id = ?'
      )
      .all(runId) as unknown as PersonaRow[]
    const questions = this.db
      .prepare('SELECT * FROM questions WHERE questionnaire_id = ? ORDER BY ord')
      .all(run.questionnaire_id) as unknown as QuestionRow[]

    // Resume support: skip cells that already have a response recorded under the
    // elicitation mode we would use today. A multi-select cell answered before the
    // mode split measured something else, so it does NOT count as done — leaving it
    // would freeze a question at numbers that can never be aggregated. Legacy
    // single-choice rows (mode NULL) are equivalent to today's output and are kept.
    const modeByQuestion = new Map(questions.map((q) => [q.id, elicitationModeFor(q.scale_type)]))
    const recorded = this.db
      .prepare('SELECT question_id, persona_id, permutation_json, seed, elicitation_mode FROM responses WHERE run_id = ?')
      .all(runId) as unknown as {
      question_id: string
      persona_id: string
      permutation_json: string
      seed: number
      elicitation_mode: string | null
    }[]
    const doneCells = new Set(
      recorded
        .filter((r) => {
          const current = modeByQuestion.get(r.question_id)
          if (current === undefined) return true
          return r.elicitation_mode === null ? current === 'single_choice' : r.elicitation_mode === current
        })
        .map((r) => cellKey(r.question_id, r.persona_id, r.permutation_json, r.seed))
    )
    const staleCells = recorded.length - doneCells.size
    if (staleCells > 0) {
      runEvents.emit('status', { runId, staleCellsReelicited: staleCells })
    }

    controls.delete(runId)
    this.setStatus(runId, 'running')
    try {
      for (const question of questions) {
        const options = JSON.parse(question.options_json) as string[]
        const rotations = balancedRotations(options.length)
        for (const personaRow of personas) {
          const persona = toPersonaInput(personaRow)
          for (const rotation of rotations) {
            for (const seed of config.seeds) {
              const control = controls.get(runId)
              if (control) {
                controls.delete(runId)
                this.setStatus(runId, control === 'stop' ? 'stopped' : 'paused')
                return
              }
              if (doneCells.has(cellKey(question.id, personaRow.id, JSON.stringify(rotation), seed))) continue
              if (!this.budget.canSpend(runId)) {
                this.setStatus(runId, 'budget_exhausted')
                return
              }
              await this.executeCell(runId, config, persona, personaRow.id, question, options, rotation, seed)
            }
          }
        }
      }
      this.setStatus(runId, 'completed')
      if (config.autoEvaluate) runEvents.emit('run_finished', { runId })
    } catch (error) {
      this.setStatus(runId, 'failed')
      throw error
    }
  }

  private async executeCell(
    runId: string,
    config: RunConfig,
    persona: PersonaInput,
    personaId: string,
    question: QuestionRow,
    options: string[],
    rotation: number[],
    seed: number
  ): Promise<void> {
    const mode = elicitationModeFor(question.scale_type)
    const { prompt, keyMap, keys } = buildStyleCPrompt(persona, { text: question.text, options }, rotation, mode)
    const result = await this.client.complete(config.model, prompt, {
      temperature: config.temperature,
      seed,
      provider: config.provider
    })
    const parsed = parseDistribution(result.content, keys, mode)

    // De-permute: map letter-keyed distribution back to original option indexes
    const byOption = parsed.distribution
      ? Object.fromEntries(
          Object.entries(parsed.distribution).map(([k, v]) => [String(keyMap[k] ?? k), v])
        )
      : null
    // Single choice: the chosen option index. Multi choice: the whole selected
    // set, so the stability metrics compare selections, not just the strongest one.
    const toOptionIndex = (key: string): string => {
      const index = keyMap[key]
      if (index === undefined) throw new Error(`Unknown option key from parser: ${key}`)
      return String(index)
    }
    const parsedAnswer =
      parsed.selectedKeys !== null
        ? parsed.selectedKeys
            .map(toOptionIndex)
            .sort((a, b) => Number(a) - Number(b))
            .join(',')
        : parsed.topChoice !== null
          ? toOptionIndex(parsed.topChoice)
          : null

    this.db
      .prepare(
        `INSERT INTO responses (
          id, run_id, persona_id, question_id, model_requested, model_version,
          temperature, seed, prompt_style, elicitation_mode, permutation_json, label_style,
          prompt_rendered, raw_response, parsed_distribution_json, parsed_answer,
          is_valid, abstained, prompt_tokens, completion_tokens, cached_tokens, cost_usd,
          cache_discount_usd, latency_ms, openrouter_request_id, provider
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        randomUUID(), runId, personaId, question.id, config.model, result.modelVersion,
        config.temperature, seed, 'style_c', mode, JSON.stringify(rotation), 'letters',
        prompt, result.content, byOption ? JSON.stringify(byOption) : null, parsedAnswer,
        parsed.isValid ? 1 : 0, parsed.abstained ? 1 : 0,
        result.promptTokens, result.completionTokens, toCount(result.cachedTokens),
        result.costUsd, toAmount(result.cacheDiscountUsd),
        result.latencyMs, result.requestId, result.provider ?? null
      )
    this.budget.record(runId, {
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      cachedTokens: toCount(result.cachedTokens),
      costUsd: result.costUsd
    })
    runEvents.emit('response', {
      runId,
      personaId,
      questionId: question.id,
      isValid: parsed.isValid,
      abstained: parsed.abstained,
      parsedAnswer,
      usage: this.budget.usage(runId)
    })
  }

  private setStatus(runId: string, status: string): void {
    this.db.prepare('UPDATE runs SET status = ? WHERE id = ?').run(status, runId)
    runEvents.emit('status', { runId, status })
  }
}

function cellKey(questionId: string, personaId: string, permutationJson: string, seed: number): string {
  return `${questionId}|${personaId}|${permutationJson}|${seed}`
}

function toPersonaInput(row: PersonaRow): PersonaInput {
  return {
    name: row.name,
    demographics: JSON.parse(row.demographics_json) as Record<string, unknown>,
    biography: row.biography ?? undefined,
    renderingStyle:
      row.rendering_style === 'natural_language_sentence'
        ? 'natural_language_sentence'
        : 'bulleted_profile'
  }
}
