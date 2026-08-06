import { describe, it, expect, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { createDb, type Db } from '../src/db.js'
import { BudgetTracker } from '../src/lib/budget.js'
import { SurveyRunner } from '../src/runner.js'
import type { ChatClient, ChatResult } from '../src/openrouter.js'

class FakeClient implements ChatClient {
  calls: { model: string; prompt: string; seed: number }[] = []
  response = '{"A": 0.6, "B": 0.4}'

  async complete(model: string, prompt: string, opts: { temperature: number; seed: number }): Promise<ChatResult> {
    this.calls.push({ model, prompt, seed: opts.seed })
    return {
      content: this.response,
      modelVersion: `${model}-20260801`,
      promptTokens: 100,
      completionTokens: 20,
      costUsd: 0.0001,
      requestId: 'req-' + this.calls.length,
      latencyMs: 5
    }
  }
}

let db: Db
let client: FakeClient

function seedRun(db: Db): string {
  const qid = randomUUID()
  const pid = randomUUID()
  const runId = randomUUID()
  db.prepare('INSERT INTO questionnaires (id, name) VALUES (?,?)').run(qid, 'Q')
  db.prepare(
    'INSERT INTO questions (id, questionnaire_id, ord, text, options_json) VALUES (?,?,0,?,?)'
  ).run(randomUUID(), qid, 'Trust banks?', JSON.stringify(['Yes', 'No']))
  db.prepare('INSERT INTO personas (id, name, demographics_json) VALUES (?,?,?)').run(
    pid, 'P', JSON.stringify({ age: 30 })
  )
  db.prepare('INSERT INTO runs (id, questionnaire_id, name, config_json) VALUES (?,?,?,?)').run(
    runId, qid, 'test-run',
    JSON.stringify({ model: 'deepseek/deepseek-v4-flash', temperature: 1.0, seeds: [0, 1] })
  )
  db.prepare('INSERT INTO run_personas (run_id, persona_id) VALUES (?,?)').run(runId, pid)
  return runId
}

beforeEach(() => {
  db = createDb(':memory:')
  client = new FakeClient()
})

describe('SurveyRunner', () => {
  it('executes question x persona x rotation x seed cells and records everything', async () => {
    const runId = seedRun(db)
    const budget = new BudgetTracker(db, { globalBudget: 1e9, perRunBudget: 1e9 })
    await new SurveyRunner(db, client, budget).execute(runId)

    // 1 question x 1 persona x 2 rotations (2 options) x 2 seeds = 4 calls
    expect(client.calls).toHaveLength(4)
    const rows = db.prepare('SELECT * FROM responses WHERE run_id = ?').all(runId) as Record<string, unknown>[]
    expect(rows).toHaveLength(4)
    const row = rows[0]!
    expect(row['model_version']).toBe('deepseek/deepseek-v4-flash-20260801')
    expect(row['prompt_rendered']).toContain('Trust banks?')
    expect(row['is_valid']).toBe(1)
    expect(JSON.parse(String(row['parsed_distribution_json']))).toHaveProperty('0')
    const status = db.prepare('SELECT status FROM runs WHERE id = ?').get(runId) as { status: string }
    expect(status.status).toBe('completed')
  })

  it('de-permutes answers back to original option indexes', async () => {
    const runId = seedRun(db)
    client.response = '{"A": 1.0, "B": 0}'
    const budget = new BudgetTracker(db, { globalBudget: 1e9, perRunBudget: 1e9 })
    await new SurveyRunner(db, client, budget).execute(runId)
    const rows = db
      .prepare('SELECT permutation_json, parsed_answer FROM responses WHERE run_id = ?')
      .all(runId) as { permutation_json: string; parsed_answer: string }[]
    for (const r of rows) {
      const rotation = JSON.parse(r.permutation_json) as number[]
      // "A" is always the first displayed option = original index rotation[0]
      expect(r.parsed_answer).toBe(String(rotation[0]))
    }
  })

  it('stops with budget_exhausted when the run budget runs out', async () => {
    const runId = seedRun(db)
    const budget = new BudgetTracker(db, { globalBudget: 1e9, perRunBudget: 150 })
    await new SurveyRunner(db, client, budget).execute(runId)
    expect(client.calls.length).toBeLessThan(4)
    const status = db.prepare('SELECT status FROM runs WHERE id = ?').get(runId) as { status: string }
    expect(status.status).toBe('budget_exhausted')
  })

  it('keeps invalid outputs flagged instead of dropping them', async () => {
    const runId = seedRun(db)
    client.response = 'I refuse to answer in JSON.'
    const budget = new BudgetTracker(db, { globalBudget: 1e9, perRunBudget: 1e9 })
    await new SurveyRunner(db, client, budget).execute(runId)
    const rows = db.prepare('SELECT is_valid, raw_response FROM responses WHERE run_id = ?').all(runId) as {
      is_valid: number
      raw_response: string
    }[]
    expect(rows).toHaveLength(4)
    expect(rows.every((r) => r.is_valid === 0)).toBe(true)
    expect(rows[0]!.raw_response).toContain('refuse')
  })
})
