import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { createDb, type Db } from '../src/db.js'
import { buildServer } from '../src/server.js'
import type { ChatClient, ChatResult } from '../src/openrouter.js'
import type { AppConfig } from '../src/config.js'

/**
 * Issue #22: GET /api/runs carries per-run summary fields (total_cells,
 * done_cells, abstained_count, stale_versions — invalid_count already
 * existed) computed in the list query itself, so the overview and the
 * context sidebar no longer need to fan out one GET /api/runs/:id/progress
 * per run at boot. The per-run progress endpoint stays for the open
 * run-detail view's live polling, so its own totalCells figure must not
 * disagree with the new list-level total_cells for the same run.
 */

const testConfig: AppConfig = {
  OPENROUTER_API_KEY: 'test-key',
  OPENROUTER_BASE_URL: 'https://openrouter.ai/api/v1',
  AUTH_USERNAME: 'admin',
  AUTH_PASSWORD: 'test-password-123',
  SESSION_SECRET: 'test-secret-at-least-16-chars',
  TOKEN_BUDGET_GLOBAL: 1_000_000,
  TOKEN_BUDGET_PER_RUN: 100_000,
  PORT: 0,
  DATABASE_PATH: ':memory:'
}

const testModels = { default: 'm1', models: [{ id: 'm1', label: 'Modell 1' }] }

class StubClient implements ChatClient {
  async complete(model: string): Promise<ChatResult> {
    return {
      content: '{"A": 1}', modelVersion: model, promptTokens: 1, completionTokens: 1,
      cachedTokens: 0, cacheDiscountUsd: 0, provider: null, costUsd: 0, requestId: null, latencyMs: 1
    }
  }
}

let app: FastifyInstance
let db: Db
let cookie: { asys_session: string }

async function login(): Promise<{ asys_session: string }> {
  const res = await app.inject({
    method: 'POST', url: '/api/login', payload: { username: 'admin', password: 'test-password-123' }
  })
  return { asys_session: /asys_session=([^;]+)/.exec(res.headers['set-cookie'] as string)![1]! }
}

async function get(url: string) {
  return app.inject({ method: 'GET', url, cookies: cookie })
}

/** One project, one questionnaire with a single two-option question (so
 * rotations = 2), one persona — the minimum a run needs to be real. */
function seedBase(): void {
  db.prepare('INSERT INTO projects (id, name) VALUES (?,?)').run('p1', 'Startlap')
  db.prepare('INSERT INTO questionnaires (id, project_id, lineage_id, name, version) VALUES (?,?,?,?,?)').run(
    'qn1', 'p1', 'qn1', 'Kérdőív', 1
  )
  db.prepare('INSERT INTO questions (id, questionnaire_id, ord, text, options_json) VALUES (?,?,?,?,?)').run(
    'qn1-q1', 'qn1', 0, 'Kérdés?', JSON.stringify(['A', 'B'])
  )
  db.prepare(
    'INSERT INTO personas (id, project_id, lineage_id, name, version, demographics_json) VALUES (?,?,?,?,?,?)'
  ).run('per1', 'p1', 'per1', 'Anna', 1, '{}')
}

function insertRun(id: string, config: Record<string, unknown>): void {
  db.prepare('INSERT INTO runs (id, questionnaire_id, name, config_json) VALUES (?,?,?,?)').run(
    id, 'qn1', 'Futás — ' + id, JSON.stringify(config)
  )
}

/**
 * `opts.seed`/`opts.permutation` must be varied across calls for the same run —
 * (run_id, question_id, persona_id, permutation_json, seed, elicitation_mode) is
 * a unique cell (idx_responses_cell); inserting the same cell twice throws.
 */
function insertResponse(
  id: string,
  runId: string,
  opts: { abstained?: number; isValid?: number; seed?: number; permutation?: string } = {}
): void {
  db.prepare(
    `INSERT INTO responses (id, run_id, persona_id, question_id, model_requested, temperature, seed,
       permutation_json, prompt_rendered, raw_response, is_valid, abstained)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id, runId, 'per1', 'qn1-q1', 'm1', 1, opts.seed ?? 0,
    opts.permutation ?? '[0,1]', 'p', 'r', opts.isValid ?? 1, opts.abstained ?? 0
  )
}

async function runFromList(runId: string): Promise<Record<string, unknown>> {
  const runs = (await get('/api/runs')).json().data as Array<Record<string, unknown>>
  const run = runs.find((r) => r.id === runId)
  if (!run) throw new Error(`run ${runId} not in GET /api/runs response`)
  return run
}

/**
 * `run_id` doubles as the id of whichever the ledger row is FOR — a run OR an
 * interview — told apart only by `scope` (src/lib/budget.ts's `record()`).
 * There is no FK, so a test can freely reuse a run's own id under
 * `scope: 'interview'` to simulate "spend recorded under this exact key but
 * for something else" without needing a real interview row to exist.
 */
function insertLedger(
  runId: string,
  spend: { promptTokens: number; completionTokens: number; cachedTokens?: number; costUsd: number },
  scope: 'run' | 'interview' = 'run'
): void {
  db.prepare(
    'INSERT INTO token_ledger (run_id, prompt_tokens, completion_tokens, cached_tokens, cost_usd, scope) VALUES (?,?,?,?,?,?)'
  ).run(runId, spend.promptTokens, spend.completionTokens, spend.cachedTokens ?? 0, spend.costUsd, scope)
}

beforeEach(async () => {
  db = createDb(':memory:')
  app = buildServer({ db, config: testConfig, models: testModels, client: new StubClient() })
  await app.ready()
  cookie = await login()
  seedBase()
})

afterEach(() => app.close())

describe('GET /api/runs summary fields', () => {
  it('reports done/abstained cells and a total_cells that agrees with /progress, for a run with responses', async () => {
    insertRun('r1', { model: 'm1', temperature: 1, seeds: [0, 1], baselineArm: false })
    db.prepare('INSERT INTO run_personas (run_id, persona_id) VALUES (?,?)').run('r1', 'per1')
    // Three DISTINCT cells (seed × permutation) out of the 4 the run has —
    // the unique-cell index rejects recording the same cell twice.
    insertResponse('resp1', 'r1', { seed: 0, permutation: '[0,1]' })
    insertResponse('resp2', 'r1', { seed: 1, permutation: '[0,1]', abstained: 1 })
    insertResponse('resp3', 'r1', { seed: 0, permutation: '[1,0]', isValid: 0 })

    const run = await runFromList('r1')
    expect(run.done_cells).toBe(3)
    expect(run.abstained_count).toBe(1)
    expect(run.invalid_count).toBe(1)
    // rotations(2 options) × arms(1 persona) × seeds(2) = 4
    expect(run.total_cells).toBe(4)

    const progress = (await get('/api/runs/r1/progress')).json().data as { totalCells: number }
    expect(run.total_cells).toBe(progress.totalCells)
  })

  it('reports zero counts, not a missing field, for a run with no responses yet', async () => {
    insertRun('r1', { model: 'm1', temperature: 1, seeds: [0], baselineArm: false })
    db.prepare('INSERT INTO run_personas (run_id, persona_id) VALUES (?,?)').run('r1', 'per1')

    const run = await runFromList('r1')
    expect(run.done_cells).toBe(0)
    expect(run.abstained_count).toBe(0)
    expect(run.invalid_count).toBe(0)
    // rotations(2) × arms(1) × seeds(1) = 2
    expect(run.total_cells).toBe(2)

    const progress = (await get('/api/runs/r1/progress')).json().data as { totalCells: number }
    expect(run.total_cells).toBe(progress.totalCells)
  })

  it('reports the control-arm-only total for a zero-persona calibration run', async () => {
    // No run_personas rows at all — exactly how POST /api/models/:model/calibrate
    // creates a run (src/model-profiles.ts).
    insertRun('cal1', { model: 'm1', temperature: 1, seeds: [0, 1], baselineArm: true })

    const run = await runFromList('cal1')
    expect(run.done_cells).toBe(0)
    // rotations(2) × arms(0 personas + 1 baseline) × seeds(2) = 4
    expect(run.total_cells).toBe(4)

    const progress = (await get('/api/runs/cal1/progress')).json().data as { totalCells: number }
    expect(run.total_cells).toBe(progress.totalCells)
  })

  it('does not flag stale_versions when nothing has been superseded', async () => {
    insertRun('r1', { model: 'm1', temperature: 1, seeds: [0], baselineArm: false })
    db.prepare('INSERT INTO run_personas (run_id, persona_id) VALUES (?,?)').run('r1', 'per1')

    const run = await runFromList('r1')
    expect(run.stale_versions).toBeFalsy()
  })

  it('flags stale_versions truthily when the questionnaire version has since been superseded', async () => {
    insertRun('r1', { model: 'm1', temperature: 1, seeds: [0], baselineArm: false })
    db.prepare('INSERT INTO run_personas (run_id, persona_id) VALUES (?,?)').run('r1', 'per1')
    // A newer version under the same lineage — the run still points at v1.
    db.prepare('INSERT INTO questionnaires (id, project_id, lineage_id, name, version) VALUES (?,?,?,?,?)').run(
      'qn1v2', 'p1', 'qn1', 'Kérdőív', 2
    )

    const run = await runFromList('r1')
    expect(run.stale_versions).toBeTruthy()
  })

  it('flags stale_versions truthily when a persona version has since been superseded', async () => {
    insertRun('r1', { model: 'm1', temperature: 1, seeds: [0], baselineArm: false })
    db.prepare('INSERT INTO run_personas (run_id, persona_id) VALUES (?,?)').run('r1', 'per1')
    db.prepare(
      'INSERT INTO personas (id, project_id, lineage_id, name, version, demographics_json) VALUES (?,?,?,?,?,?)'
    ).run('per1v2', 'p1', 'per1', 'Anna', 2, '{}')

    const run = await runFromList('r1')
    expect(run.stale_versions).toBeTruthy()
  })

  it('still carries invalid_count and response_count alongside the new fields', async () => {
    insertRun('r1', { model: 'm1', temperature: 1, seeds: [0], baselineArm: false })
    db.prepare('INSERT INTO run_personas (run_id, persona_id) VALUES (?,?)').run('r1', 'per1')
    insertResponse('resp1', 'r1', { isValid: 0 })

    const run = await runFromList('r1')
    expect(run.response_count).toBe(1)
    expect(run.invalid_count).toBe(1)
  })
})

/**
 * Follow-up to issue #22: a non-running run is never polled any more (only a
 * currently-running row is, and only by the 5s timer), so GET /api/runs/:id/
 * progress's usage figures — the run's real token/cost spend — must also
 * arrive on the list row itself, or a paused/completed run's card silently
 * shows 0 tokens / $0 forever. The two must never disagree, same rule as
 * total_cells.
 */
describe('GET /api/runs usage fields', () => {
  it('reports the same token/cost totals as /progress for a run with ledger spend', async () => {
    insertRun('r1', { model: 'm1', temperature: 1, seeds: [0], baselineArm: false })
    db.prepare('INSERT INTO run_personas (run_id, persona_id) VALUES (?,?)').run('r1', 'per1')
    insertLedger('r1', { promptTokens: 900, completionTokens: 300, cachedTokens: 50, costUsd: 0.05 })
    insertLedger('r1', { promptTokens: 100, completionTokens: 40, cachedTokens: 0, costUsd: 0.01 })

    const run = await runFromList('r1')
    expect(run.prompt_tokens).toBe(1000)
    expect(run.completion_tokens).toBe(340)
    expect(run.cached_tokens).toBe(50)
    expect(run.total_tokens).toBe(1340)
    expect(run.cost_usd as number).toBeCloseTo(0.06)

    const progress = (await get('/api/runs/r1/progress')).json().data as {
      usage: { promptTokens: number; completionTokens: number; cachedTokens: number; totalTokens: number; costUsd: number }
    }
    expect(run.prompt_tokens).toBe(progress.usage.promptTokens)
    expect(run.completion_tokens).toBe(progress.usage.completionTokens)
    expect(run.cached_tokens).toBe(progress.usage.cachedTokens)
    expect(run.total_tokens).toBe(progress.usage.totalTokens)
    expect(run.cost_usd as number).toBeCloseTo(progress.usage.costUsd)
  })

  it('reports zero usage, not a missing field, for a run with no ledger rows yet', async () => {
    insertRun('r1', { model: 'm1', temperature: 1, seeds: [0], baselineArm: false })
    db.prepare('INSERT INTO run_personas (run_id, persona_id) VALUES (?,?)').run('r1', 'per1')

    const run = await runFromList('r1')
    expect(run.prompt_tokens).toBe(0)
    expect(run.completion_tokens).toBe(0)
    expect(run.cached_tokens).toBe(0)
    expect(run.total_tokens).toBe(0)
    expect(run.cost_usd).toBe(0)

    const progress = (await get('/api/runs/r1/progress')).json().data as { usage: { totalTokens: number } }
    expect(run.total_tokens).toBe(progress.usage.totalTokens)
  })

  // token_ledger.run_id is a run id OR an interview id, told apart only by
  // scope (src/lib/budget.ts) — there is no FK to enforce that a query
  // filters by scope. A query that forgot the scope filter (or that a run and
  // an interview happened to share an id) would silently inflate this run's
  // usage with unrelated interview spend.
  // The reviewer reproduced list p:300 vs BudgetTracker.usage() p:1299 for the
  // same run — GET /api/runs (src/server.ts) filters `WHERE scope = 'run'`,
  // but BudgetTracker.usage() (src/lib/budget.ts), which /progress reports as
  // `usage`, has no scope filter at all. The list and the detail must NEVER
  // show different spend for one run — this asserts BOTH definitions, not
  // just the list side, so it cannot be satisfied by fixing only one of them.
  it('and /api/runs/:id/progress must agree on this run’s spend — neither may include interview-scoped spend recorded under the same id', async () => {
    insertRun('r1', { model: 'm1', temperature: 1, seeds: [0], baselineArm: false })
    db.prepare('INSERT INTO run_personas (run_id, persona_id) VALUES (?,?)').run('r1', 'per1')
    insertLedger('r1', { promptTokens: 100, completionTokens: 50, costUsd: 0.01 }, 'run')
    // Same id, but an interview's spend — must be excluded from BOTH screens.
    insertLedger('r1', { promptTokens: 9000, completionTokens: 9000, costUsd: 9.99 }, 'interview')

    const run = await runFromList('r1')
    expect(run.prompt_tokens).toBe(100)
    expect(run.completion_tokens).toBe(50)
    expect(run.total_tokens).toBe(150)
    expect(run.cost_usd as number).toBeCloseTo(0.01)

    const progress = (await get('/api/runs/r1/progress')).json().data as {
      usage: { promptTokens: number; completionTokens: number; totalTokens: number; costUsd: number }
    }
    expect(progress.usage.promptTokens).toBe(100)
    expect(progress.usage.completionTokens).toBe(50)
    expect(progress.usage.totalTokens).toBe(150)
    expect(progress.usage.costUsd).toBeCloseTo(0.01)
    expect(run.prompt_tokens).toBe(progress.usage.promptTokens)
    expect(run.completion_tokens).toBe(progress.usage.completionTokens)
    expect(run.total_tokens).toBe(progress.usage.totalTokens)
  })
})

/**
 * Guard rail for the perf-motivated rewrite (correlated subqueries -> a
 * joined/GROUP BY subquery, per src/server.ts's own comment on the query) —
 * so an aggregation refactor cannot silently change what numbers mean.
 */
describe('GET /api/runs perf-refactor safety net', () => {
  it('keeps done_cells equal to response_count, including invalid and abstained responses', async () => {
    insertRun('r1', { model: 'm1', temperature: 1, seeds: [0, 1], baselineArm: false })
    db.prepare('INSERT INTO run_personas (run_id, persona_id) VALUES (?,?)').run('r1', 'per1')
    insertResponse('resp1', 'r1', { seed: 0, permutation: '[0,1]' })
    insertResponse('resp2', 'r1', { seed: 1, permutation: '[0,1]', abstained: 1 })
    insertResponse('resp3', 'r1', { seed: 0, permutation: '[1,0]', isValid: 0 })

    const run = await runFromList('r1')
    expect(run.done_cells).toBe(3)
    expect(run.done_cells).toBe(run.response_count)
  })

  it('reports identical per-run numbers whether or not the query is scoped to a project', async () => {
    insertRun('r1', { model: 'm1', temperature: 1, seeds: [0, 1], baselineArm: false })
    db.prepare('INSERT INTO run_personas (run_id, persona_id) VALUES (?,?)').run('r1', 'per1')
    insertResponse('resp1', 'r1', { seed: 0, permutation: '[0,1]' })
    insertResponse('resp2', 'r1', { seed: 1, permutation: '[0,1]', abstained: 1 })
    insertResponse('resp3', 'r1', { seed: 0, permutation: '[1,0]', isValid: 0 })
    insertLedger('r1', { promptTokens: 100, completionTokens: 50, cachedTokens: 5, costUsd: 0.01 })
    // A newer questionnaire version, so stale_versions is truthy too — every
    // computed field gets a non-trivial value to compare.
    db.prepare('INSERT INTO questionnaires (id, project_id, lineage_id, name, version) VALUES (?,?,?,?,?)').run(
      'qn1v2', 'p1', 'qn1', 'Kérdőív', 2
    )

    const unfiltered = await runFromList('r1')
    const filteredRuns = (await get('/api/runs?project=p1')).json().data as Array<Record<string, unknown>>
    const filtered = filteredRuns.find((r) => r.id === 'r1')
    expect(filtered).toBeDefined()

    for (const field of [
      'response_count', 'invalid_count', 'done_cells', 'abstained_count', 'total_cells', 'stale_versions',
      'prompt_tokens', 'completion_tokens', 'cached_tokens', 'total_tokens', 'cost_usd'
    ]) {
      expect(filtered![field], field).toBe(unfiltered[field])
    }
  })
})
