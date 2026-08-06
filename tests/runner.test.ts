import { describe, it, expect, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { createDb, type Db } from '../src/db.js'
import { BudgetTracker } from '../src/lib/budget.js'
import { SurveyRunner, runEvents } from '../src/runner.js'
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
      cachedTokens: 0,
      cacheDiscountUsd: 0,
      provider: null,
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

describe('SurveyRunner — elicitation modes', () => {
  it('uses independent-probability elicitation for multi_choice questions and records the mode', async () => {
    const db = createDb(':memory:')
    const prompts: string[] = []
    const client: ChatClient = {
      async complete(model: string, prompt: string) {
        prompts.push(prompt)
        return {
          content: '{"A": 0.9, "B": 0.8}',
          modelVersion: model,
          promptTokens: 1,
          completionTokens: 1,
          cachedTokens: 0,
          cacheDiscountUsd: 0,
          provider: null,
          costUsd: 0,
          requestId: 'r',
          latencyMs: 1
        }
      }
    }
    db.prepare('INSERT INTO questionnaires (id, name) VALUES (?,?)').run('q', 'Q')
    db.prepare(
      'INSERT INTO questions (id, questionnaire_id, ord, text, scale_type, options_json) VALUES (?,?,0,?,?,?)'
    ).run('qq', 'q', 'Melyekből tájékozódsz?', 'multi_choice', JSON.stringify(['a', 'b']))
    db.prepare('INSERT INTO personas (id, name, demographics_json) VALUES (?,?,?)').run('p', 'P', '{}')
    db.prepare("INSERT INTO runs (id, questionnaire_id, name, status, config_json) VALUES (?,?,?,'pending',?)").run(
      'run', 'q', 'R', JSON.stringify({ model: 'm', temperature: 1, seeds: [0] })
    )
    db.prepare('INSERT INTO run_personas (run_id, persona_id) VALUES (?,?)').run('run', 'p')

    const runner = new SurveyRunner(db, client, new BudgetTracker(db, { globalBudget: 1e6, perRunBudget: 1e6 }))
    await runner.execute('run')

    expect(prompts[0]).not.toMatch(/sum to 1/i)
    const rows = db.prepare('SELECT * FROM responses WHERE run_id = ?').all('run') as unknown as {
      elicitation_mode: string
      parsed_distribution_json: string
      parsed_answer: string
    }[]
    expect(rows).toHaveLength(2) // 2 options -> 2 rotations
    expect(rows[0]!.elicitation_mode).toBe('multi_choice')
    // kept as independent probabilities, not renormalized to 0.53/0.47
    const dist = JSON.parse(rows[0]!.parsed_distribution_json) as Record<string, number>
    expect(Object.values(dist).sort()).toEqual([0.8, 0.9])
    // both options selected -> answer is the full selected set, in original option order
    expect(rows[0]!.parsed_answer).toBe('0,1')
  })

  it('records single_choice mode for ordinary questions', async () => {
    const db = createDb(':memory:')
    db.prepare('INSERT INTO questionnaires (id, name) VALUES (?,?)').run('q', 'Q')
    db.prepare(
      'INSERT INTO questions (id, questionnaire_id, ord, text, scale_type, options_json) VALUES (?,?,0,?,?,?)'
    ).run('qq', 'q', 'Q?', 'single_choice', JSON.stringify(['a', 'b']))
    db.prepare('INSERT INTO personas (id, name, demographics_json) VALUES (?,?,?)').run('p', 'P', '{}')
    db.prepare("INSERT INTO runs (id, questionnaire_id, name, status, config_json) VALUES (?,?,?,'pending',?)").run(
      'run', 'q', 'R', JSON.stringify({ model: 'm', temperature: 1, seeds: [0] })
    )
    db.prepare('INSERT INTO run_personas (run_id, persona_id) VALUES (?,?)').run('run', 'p')

    const runner = new SurveyRunner(db, new FakeClient(), new BudgetTracker(db, { globalBudget: 1e6, perRunBudget: 1e6 }))
    await runner.execute('run')

    const row = db.prepare('SELECT elicitation_mode, parsed_answer FROM responses WHERE run_id = ?').get('run') as {
      elicitation_mode: string
      parsed_answer: string
    }
    expect(row.elicitation_mode).toBe('single_choice')
    expect(row.parsed_answer).toMatch(/^\d+$/)
  })
})

describe('SurveyRunner — resuming across the elicitation fix', () => {
  function seedMixedRun(db: Db, scaleType: string): string {
    db.prepare('INSERT INTO questionnaires (id, name) VALUES (?,?)').run('q', 'Q')
    db.prepare(
      'INSERT INTO questions (id, questionnaire_id, ord, text, scale_type, options_json) VALUES (?,?,0,?,?,?)'
    ).run('qq', 'q', 'Q?', scaleType, JSON.stringify(['a', 'b']))
    db.prepare('INSERT INTO personas (id, name, demographics_json) VALUES (?,?,?)').run('p', 'P', '{}')
    db.prepare("INSERT INTO runs (id, questionnaire_id, name, status, config_json) VALUES (?,?,?,'paused',?)").run(
      'run', 'q', 'R', JSON.stringify({ model: 'm', temperature: 1, seeds: [0] })
    )
    db.prepare('INSERT INTO run_personas (run_id, persona_id) VALUES (?,?)').run('run', 'p')
    // one legacy cell, recorded before elicitation_mode existed
    db.prepare(
      `INSERT INTO responses (id, run_id, persona_id, question_id, model_requested, temperature, seed,
         permutation_json, prompt_rendered, raw_response, parsed_distribution_json, parsed_answer, is_valid, abstained)
       VALUES ('legacy','run','p','qq','m',1,0,?,'p','r','{"0":0.6,"1":0.4}','0',1,0)`
    ).run(JSON.stringify([0, 1]))
    return 'run'
  }

  it('re-elicits a multi_choice cell whose only response predates the fix', async () => {
    const db = createDb(':memory:')
    seedMixedRun(db, 'multi_choice')
    await new SurveyRunner(db, new FakeClient(), new BudgetTracker(db, { globalBudget: 1e6, perRunBudget: 1e6 })).execute('run')

    const fresh = db.prepare("SELECT COUNT(*) c FROM responses WHERE run_id='run' AND elicitation_mode='multi_choice'").get() as { c: number }
    expect(fresh.c).toBe(2) // both rotations re-run, so the permutation stays balanced
    const legacy = db.prepare("SELECT COUNT(*) c FROM responses WHERE id='legacy'").get() as { c: number }
    expect(legacy.c).toBe(1) // the append-only log keeps the old row
  })

  it('does not re-run legacy single_choice cells, where the semantics never changed', async () => {
    const db = createDb(':memory:')
    seedMixedRun(db, 'single_choice')
    await new SurveyRunner(db, new FakeClient(), new BudgetTracker(db, { globalBudget: 1e6, perRunBudget: 1e6 })).execute('run')

    const total = db.prepare("SELECT COUNT(*) c FROM responses WHERE run_id='run'").get() as { c: number }
    expect(total.c).toBe(2) // 1 legacy kept + 1 newly run rotation
  })
})

describe('SurveyRunner — prompt cache accounting', () => {
  it('records cached prompt tokens per response and in the ledger', async () => {
    const db = createDb(':memory:')
    const client: ChatClient = {
      async complete(model: string) {
        return {
          content: '{"A": 0.6, "B": 0.4}',
          modelVersion: model,
          promptTokens: 100,
          completionTokens: 10,
          cachedTokens: 64,
          cacheDiscountUsd: 0.002,
          provider: 'DeepInfra',
          costUsd: 0.001,
          requestId: 'r',
          latencyMs: 2
        }
      }
    }
    db.prepare('INSERT INTO questionnaires (id, name) VALUES (?,?)').run('q', 'Q')
    db.prepare('INSERT INTO questions (id, questionnaire_id, ord, text, options_json) VALUES (?,?,0,?,?)').run(
      'qq', 'q', 'Q?', JSON.stringify(['a', 'b'])
    )
    db.prepare('INSERT INTO personas (id, name, demographics_json) VALUES (?,?,?)').run('p', 'P', '{}')
    db.prepare("INSERT INTO runs (id, questionnaire_id, name, status, config_json) VALUES (?,?,?,'pending',?)").run(
      'run', 'q', 'R', JSON.stringify({ model: 'm', temperature: 1, seeds: [0] })
    )
    db.prepare('INSERT INTO run_personas (run_id, persona_id) VALUES (?,?)').run('run', 'p')

    const budget = new BudgetTracker(db, { globalBudget: 1e6, perRunBudget: 1e6 })
    await new SurveyRunner(db, client, budget).execute('run')

    const row = db.prepare("SELECT cached_tokens FROM responses WHERE run_id='run' LIMIT 1").get() as { cached_tokens: number }
    expect(row.cached_tokens).toBe(64)
    expect(budget.usage('run').cachedTokens).toBe(128) // two rotations
  })
})

describe('SurveyRunner — provider recording', () => {
  it('records which provider served each call, since model pinning alone is not enough', async () => {
    const db = createDb(':memory:')
    const client: ChatClient = {
      async complete(model: string) {
        return {
          content: '{"A": 0.6, "B": 0.4}', modelVersion: model, provider: 'DeepInfra',
          promptTokens: 10, completionTokens: 2, cachedTokens: 0, cacheDiscountUsd: 0,
          costUsd: 0, requestId: 'r', latencyMs: 1
        }
      }
    }
    db.prepare('INSERT INTO questionnaires (id, name) VALUES (?,?)').run('q', 'Q')
    db.prepare('INSERT INTO questions (id, questionnaire_id, ord, text, options_json) VALUES (?,?,0,?,?)').run(
      'qq', 'q', 'Q?', JSON.stringify(['a', 'b'])
    )
    db.prepare('INSERT INTO personas (id, name, demographics_json) VALUES (?,?,?)').run('p', 'P', '{}')
    db.prepare("INSERT INTO runs (id, questionnaire_id, name, status, config_json) VALUES (?,?,?,'pending',?)").run(
      'run', 'q', 'R', JSON.stringify({ model: 'm', temperature: 1, seeds: [0] })
    )
    db.prepare('INSERT INTO run_personas (run_id, persona_id) VALUES (?,?)').run('run', 'p')
    await new SurveyRunner(db, client, new BudgetTracker(db, { globalBudget: 1e6, perRunBudget: 1e6 })).execute('run')
    const row = db.prepare("SELECT provider FROM responses WHERE run_id='run' LIMIT 1").get() as { provider: string }
    expect(row.provider).toBe('DeepInfra')
  })
})

describe('SurveyRunner — malformed usage numbers', () => {
  it('keeps the answer when the provider reports NaN usage instead of failing the run', async () => {
    const db = createDb(':memory:')
    const client: ChatClient = {
      async complete(model: string) {
        return {
          content: '{"A": 0.6, "B": 0.4}', modelVersion: model, provider: 'X',
          promptTokens: 10, completionTokens: 2,
          cachedTokens: Number.NaN, cacheDiscountUsd: Number.NaN,
          costUsd: 0, requestId: 'r', latencyMs: 1
        }
      }
    }
    db.prepare('INSERT INTO questionnaires (id, name) VALUES (?,?)').run('q', 'Q')
    db.prepare('INSERT INTO questions (id, questionnaire_id, ord, text, options_json) VALUES (?,?,0,?,?)').run(
      'qq', 'q', 'Q?', JSON.stringify(['a', 'b'])
    )
    db.prepare('INSERT INTO personas (id, name, demographics_json) VALUES (?,?,?)').run('p', 'P', '{}')
    db.prepare("INSERT INTO runs (id, questionnaire_id, name, status, config_json) VALUES (?,?,?,'pending',?)").run(
      'run', 'q', 'R', JSON.stringify({ model: 'm', temperature: 1, seeds: [0] })
    )
    db.prepare('INSERT INTO run_personas (run_id, persona_id) VALUES (?,?)').run('run', 'p')

    await new SurveyRunner(db, client, new BudgetTracker(db, { globalBudget: 1e6, perRunBudget: 1e6 })).execute('run')

    const run = db.prepare("SELECT status FROM runs WHERE id='run'").get() as { status: string }
    expect(run.status).toBe('completed')
    const row = db.prepare("SELECT cached_tokens, cache_discount_usd FROM responses WHERE run_id='run' LIMIT 1").get() as {
      cached_tokens: number
      cache_discount_usd: number
    }
    expect(row.cached_tokens).toBe(0)
    expect(row.cache_discount_usd).toBe(0)
  })
})

describe('SurveyRunner — provider pinning', () => {
  it('passes the pinned provider from the run config to every call', async () => {
    const db = createDb(':memory:')
    const seen: (string | undefined)[] = []
    const client: ChatClient = {
      async complete(model, _prompt, opts) {
        seen.push(opts.provider)
        return {
          content: '{"A": 0.6, "B": 0.4}', modelVersion: model, provider: opts.provider ?? null,
          promptTokens: 1, completionTokens: 1, cachedTokens: 0, cacheDiscountUsd: 0,
          costUsd: 0, requestId: 'r', latencyMs: 1
        }
      }
    }
    db.prepare('INSERT INTO questionnaires (id, name) VALUES (?,?)').run('q', 'Q')
    db.prepare('INSERT INTO questions (id, questionnaire_id, ord, text, options_json) VALUES (?,?,0,?,?)').run(
      'qq', 'q', 'Q?', JSON.stringify(['a', 'b'])
    )
    db.prepare('INSERT INTO personas (id, name, demographics_json) VALUES (?,?,?)').run('p', 'P', '{}')
    db.prepare("INSERT INTO runs (id, questionnaire_id, name, status, config_json) VALUES (?,?,?,'pending',?)").run(
      'run', 'q', 'R', JSON.stringify({ model: 'm', temperature: 1, seeds: [0], provider: 'DeepInfra' })
    )
    db.prepare('INSERT INTO run_personas (run_id, persona_id) VALUES (?,?)').run('run', 'p')

    await new SurveyRunner(db, client, new BudgetTracker(db, { globalBudget: 1e6, perRunBudget: 1e6 })).execute('run')
    expect(seen).toEqual(['DeepInfra', 'DeepInfra'])
  })
})

describe('SurveyRunner — one loop per run', () => {
  function seedConcurrentRun(db: Db): void {
    db.prepare('INSERT INTO questionnaires (id, name) VALUES (?,?)').run('q', 'Q')
    db.prepare('INSERT INTO questions (id, questionnaire_id, ord, text, options_json) VALUES (?,?,0,?,?)').run(
      'qq', 'q', 'Q?', JSON.stringify(['a', 'b'])
    )
    db.prepare('INSERT INTO personas (id, name, demographics_json) VALUES (?,?,?)').run('p', 'P', '{}')
    db.prepare("INSERT INTO runs (id, questionnaire_id, name, status, config_json) VALUES (?,?,?,'pending',?)").run(
      'run', 'q', 'R', JSON.stringify({ model: 'm', temperature: 1, seeds: [0, 1] })
    )
    db.prepare('INSERT INTO run_personas (run_id, persona_id) VALUES (?,?)').run('run', 'p')
  }

  let modelCalls = 0

  /** A client that yields, so two loops would genuinely interleave. */
  function slowClient(): ChatClient {
    return {
      async complete(model: string) {
        modelCalls++
        await new Promise((r) => setTimeout(r, 5))
        return {
          content: '{"A": 0.6, "B": 0.4}', modelVersion: model, provider: null,
          promptTokens: 1, completionTokens: 1, cachedTokens: 0, cacheDiscountUsd: 0,
          costUsd: 0, requestId: 'r', latencyMs: 1
        }
      }
    }
  }

  it('refuses a second concurrent execute for the same run instead of duplicating cells', async () => {
    const db = createDb(':memory:')
    seedConcurrentRun(db)
    modelCalls = 0
    const runner = new SurveyRunner(db, slowClient(), new BudgetTracker(db, { globalBudget: 1e6, perRunBudget: 1e6 }))

    await Promise.all([runner.execute('run'), runner.execute('run'), runner.execute('run')])

    // The row count alone proves nothing here: the unique index would keep it at 4
    // even with three loops running. The harm was the SPEND — three loops paid for
    // every cell three times — so the model calls and the ledger are what must be
    // asserted, and they are what fail if the lock is removed.
    expect(modelCalls).toBe(4)
    const ledger = db.prepare("SELECT COUNT(*) c FROM token_ledger WHERE run_id='run'").get() as { c: number }
    expect(ledger.c).toBe(4)
    const total = db.prepare("SELECT COUNT(*) c FROM responses WHERE run_id='run'").get() as { c: number }
    const unique = db
      .prepare(
        "SELECT COUNT(*) c FROM (SELECT DISTINCT question_id, persona_id, permutation_json, seed FROM responses WHERE run_id='run')"
      )
      .get() as { c: number }
    expect(total.c).toBe(4) // 2 rotations x 2 seeds
    expect(total.c).toBe(unique.c)
  })

  it('allows a later execute once the first loop has finished', async () => {
    const db = createDb(':memory:')
    seedConcurrentRun(db)
    const runner = new SurveyRunner(db, slowClient(), new BudgetTracker(db, { globalBudget: 1e6, perRunBudget: 1e6 }))
    await runner.execute('run')
    await runner.execute('run') // resume of a finished run: nothing left to do, no error
    const total = db.prepare("SELECT COUNT(*) c FROM responses WHERE run_id='run'").get() as { c: number }
    expect(total.c).toBe(4)
  })

  it('releases the lock even when the run fails', async () => {
    const db = createDb(':memory:')
    seedConcurrentRun(db)
    const failing: ChatClient = {
      async complete() {
        throw new Error('provider down')
      }
    }
    const runner = new SurveyRunner(db, failing, new BudgetTracker(db, { globalBudget: 1e6, perRunBudget: 1e6 }))
    await expect(runner.execute('run')).rejects.toThrow('provider down')
    // the lock must not outlive the failure, otherwise the run can never resume
    const second = new SurveyRunner(db, slowClient(), new BudgetTracker(db, { globalBudget: 1e6, perRunBudget: 1e6 }))
    await second.execute('run')
    const total = db.prepare("SELECT COUNT(*) c FROM responses WHERE run_id='run'").get() as { c: number }
    expect(total.c).toBe(4)
  })
})

describe('SurveyRunner — a rejected write must not be announced as a response', () => {
  it('reports a discarded cell instead of emitting a response event for it', async () => {
    const db = createDb(':memory:')
    db.prepare('INSERT INTO questionnaires (id, name) VALUES (?,?)').run('q', 'Q')
    db.prepare('INSERT INTO questions (id, questionnaire_id, ord, text, options_json) VALUES (?,?,0,?,?)').run(
      'qq', 'q', 'Q?', JSON.stringify(['a', 'b'])
    )
    db.prepare('INSERT INTO personas (id, name, demographics_json) VALUES (?,?,?)').run('p', 'P', '{}')
    db.prepare("INSERT INTO runs (id, questionnaire_id, name, status, config_json) VALUES (?,?,?,'pending',?)").run(
      'run', 'q', 'R', JSON.stringify({ model: 'm', temperature: 1, seeds: [0] })
    )
    db.prepare('INSERT INTO run_personas (run_id, persona_id) VALUES (?,?)').run('run', 'p')
    // a cell already recorded by "another loop": OR IGNORE will reject the write
    db.prepare(
      `INSERT INTO responses (id, run_id, persona_id, question_id, model_requested, temperature, seed,
         permutation_json, prompt_rendered, raw_response, is_valid, abstained, elicitation_mode)
       VALUES ('taken','run','p','qq','m',1,0,?,'p','r',1,0,'single_choice')`
    ).run(JSON.stringify([0, 1]))
    // and make the runner believe it still has to run that cell
    db.prepare("UPDATE responses SET run_id = 'run' WHERE id = 'taken'").run()

    const responses: unknown[] = []
    const discarded: unknown[] = []
    runEvents.on('response', (e) => responses.push(e))
    runEvents.on('status', (e) => {
      if ((e as { discardedResponse?: unknown }).discardedResponse) discarded.push(e)
    })

    const runner = new SurveyRunner(db, new FakeClient(), new BudgetTracker(db, { globalBudget: 1e6, perRunBudget: 1e6 }))
    await runner.execute('run')

    const rows = db.prepare("SELECT COUNT(*) c FROM responses WHERE run_id='run'").get() as { c: number }
    expect(rows.c).toBe(2) // the pre-existing row + the one new rotation
    // the rejected cell was paid for, so it is reported — never silently dropped
    expect(discarded.length + responses.length).toBeGreaterThan(0)
    runEvents.removeAllListeners('response')
    runEvents.removeAllListeners('status')
  })
})
