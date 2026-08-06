import { describe, it, expect, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { createDb, type Db } from '../src/db.js'
import { BudgetTracker } from '../src/lib/budget.js'
import { SurveyRunner, requestPause, requestStop } from '../src/runner.js'
import type { ChatClient, ChatResult } from '../src/openrouter.js'

class SlowClient implements ChatClient {
  calls = 0
  onCall: ((n: number) => void) | null = null

  async complete(model: string): Promise<ChatResult> {
    this.calls++
    this.onCall?.(this.calls)
    await new Promise((r) => setTimeout(r, 5))
    return {
      content: '{"A": 1, "B": 0}',
      modelVersion: model,
      promptTokens: 10,
      completionTokens: 5,
      cachedTokens: 0,
      cacheDiscountUsd: 0,
      provider: null,
      costUsd: 0,
      requestId: null,
      latencyMs: 5
    }
  }
}

let db: Db
let client: SlowClient
let runId: string

beforeEach(() => {
  db = createDb(':memory:')
  client = new SlowClient()
  const qid = randomUUID()
  const pid = randomUUID()
  runId = randomUUID()
  db.prepare('INSERT INTO questionnaires (id, name) VALUES (?,?)').run(qid, 'Q')
  db.prepare('INSERT INTO questions (id, questionnaire_id, ord, text, options_json) VALUES (?,?,0,?,?)').run(
    randomUUID(), qid, 'Q1?', JSON.stringify(['a', 'b'])
  )
  db.prepare('INSERT INTO personas (id, name, demographics_json) VALUES (?,?,?)').run(pid, 'P', '{}')
  db.prepare('INSERT INTO runs (id, questionnaire_id, name, config_json) VALUES (?,?,?,?)').run(
    runId, qid, 'R', JSON.stringify({ model: 'm', temperature: 1, seeds: [0, 1] })
  )
  db.prepare('INSERT INTO run_personas (run_id, persona_id) VALUES (?,?)').run(runId, pid)
})

function status(): string {
  return (db.prepare('SELECT status FROM runs WHERE id = ?').get(runId) as { status: string }).status
}

describe('run control', () => {
  it('pauses mid-run and resumes only the remaining cells', async () => {
    const runner = new SurveyRunner(db, client, new BudgetTracker(db, { globalBudget: 1e9, perRunBudget: 1e9 }))
    client.onCall = (n) => {
      if (n === 2) requestPause(runId)
    }
    await runner.execute(runId)
    expect(status()).toBe('paused')
    expect(client.calls).toBe(2)

    client.onCall = null
    await runner.execute(runId) // resume: 4 total cells, 2 already done
    expect(status()).toBe('completed')
    expect(client.calls).toBe(4)
    const rows = db.prepare('SELECT COUNT(*) c FROM responses WHERE run_id = ?').get(runId) as { c: number }
    expect(rows.c).toBe(4) // no duplicated cells
  })

  it('stops a run terminally', async () => {
    const runner = new SurveyRunner(db, client, new BudgetTracker(db, { globalBudget: 1e9, perRunBudget: 1e9 }))
    client.onCall = (n) => {
      if (n === 1) requestStop(runId)
    }
    await runner.execute(runId)
    expect(status()).toBe('stopped')
    expect(client.calls).toBe(1)
  })

  it('resumes a budget-exhausted run after the budget is raised', async () => {
    const small = new SurveyRunner(db, client, new BudgetTracker(db, { globalBudget: 1e9, perRunBudget: 40 }))
    await small.execute(runId)
    expect(status()).toBe('budget_exhausted')
    const doneBefore = client.calls
    expect(doneBefore).toBeLessThan(4)

    const big = new SurveyRunner(db, client, new BudgetTracker(db, { globalBudget: 1e9, perRunBudget: 1e9 }))
    await big.execute(runId)
    expect(status()).toBe('completed')
    expect(client.calls).toBe(4)
  })
})
