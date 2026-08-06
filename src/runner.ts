import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { Db } from './db.js'
import type { ChatClient } from './openrouter.js'
import { BudgetTracker } from './lib/budget.js'
import { balancedRotations } from './lib/permutation.js'
import { buildStyleCPrompt, type PersonaInput } from './lib/prompt.js'
import { parseDistribution } from './lib/parse.js'

export interface RunConfig {
  model: string
  temperature: number
  seeds: number[]
}

export const runEvents = new EventEmitter()
runEvents.setMaxListeners(100) // each SSE client adds 2 listeners

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

    this.setStatus(runId, 'running')
    try {
      for (const question of questions) {
        const options = JSON.parse(question.options_json) as string[]
        const rotations = balancedRotations(options.length)
        for (const personaRow of personas) {
          const persona = toPersonaInput(personaRow)
          for (const rotation of rotations) {
            for (const seed of config.seeds) {
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
    const { prompt, keyMap, keys } = buildStyleCPrompt(persona, { text: question.text, options }, rotation)
    const result = await this.client.complete(config.model, prompt, {
      temperature: config.temperature,
      seed
    })
    const parsed = parseDistribution(result.content, keys)

    // De-permute: map letter-keyed distribution back to original option indexes
    const byOption = parsed.distribution
      ? Object.fromEntries(
          Object.entries(parsed.distribution).map(([k, v]) => [String(keyMap[k] ?? k), v])
        )
      : null
    const parsedAnswer =
      parsed.topChoice !== null ? String(keyMap[parsed.topChoice] ?? parsed.topChoice) : null

    this.db
      .prepare(
        `INSERT INTO responses (
          id, run_id, persona_id, question_id, model_requested, model_version,
          temperature, seed, prompt_style, permutation_json, label_style,
          prompt_rendered, raw_response, parsed_distribution_json, parsed_answer,
          is_valid, abstained, prompt_tokens, completion_tokens, cost_usd,
          latency_ms, openrouter_request_id
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        randomUUID(), runId, personaId, question.id, config.model, result.modelVersion,
        config.temperature, seed, 'style_c', JSON.stringify(rotation), 'letters',
        prompt, result.content, byOption ? JSON.stringify(byOption) : null, parsedAnswer,
        parsed.isValid ? 1 : 0, parsed.abstained ? 1 : 0,
        result.promptTokens, result.completionTokens, result.costUsd,
        result.latencyMs, result.requestId
      )
    this.budget.record(runId, {
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
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
