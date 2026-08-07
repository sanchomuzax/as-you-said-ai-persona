import type { Db } from '../db.js'

export interface BudgetConfig {
  globalBudget: number
  perRunBudget: number
}

export interface SpendRecord {
  promptTokens: number
  completionTokens: number
  costUsd: number
  /** Prompt tokens served from the provider's cache; billed, but ~10x cheaper. */
  cachedTokens?: number
}

export interface Usage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  cachedTokens: number
  costUsd: number
}

/** Token ledger with hard budget stops, checked BEFORE every model call. */
export class BudgetTracker {
  constructor(
    private readonly db: Db,
    private readonly config: BudgetConfig
  ) {}

  /**
   * `scope` says what the id refers to: a measured run, or an exploratory
   * interview. Both draw on the same budget — a conversation costs real tokens —
   * but an analysis of what the measurement cost must be able to exclude the
   * interviews, and that is only possible if the ledger records which is which.
   */
  record(runId: string, spend: SpendRecord, scope: 'run' | 'interview' = 'run'): void {
    this.db
      .prepare(
        'INSERT INTO token_ledger (run_id, prompt_tokens, completion_tokens, cached_tokens, cost_usd, scope) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(runId, spend.promptTokens, spend.completionTokens, spend.cachedTokens ?? 0, spend.costUsd, scope)
  }

  /**
   * `scope`: `id` is a run id or an interview id (token_ledger.run_id is
   * shared key-space for both, told apart only by the scope column — see the
   * table comment in src/db.ts). This used to not filter by scope at all,
   * which let this and `usage()` sum across BOTH kinds of spend for whichever
   * id happened to be passed — harmless only because run ids and interview
   * ids never actually collide, not because the query was correct. Every
   * production call site (src/runner.ts, src/interviews.ts, src/server.ts)
   * passes its scope explicitly now; the 'run' default exists only so
   * existing callers that always meant a run (tests/budget.test.ts,
   * tests/runner.test.ts) do not have to state the common case.
   */
  canSpend(id: string, scope: 'run' | 'interview' = 'run'): boolean {
    // A budget of 0 disables the hard stop for that scope.
    const runOk =
      this.config.perRunBudget === 0 ||
      this.usage(id, scope).totalTokens < this.config.perRunBudget
    const globalOk =
      this.config.globalBudget === 0 ||
      this.globalUsage().totalTokens < this.config.globalBudget
    return runOk && globalOk
  }

  usage(id: string, scope: 'run' | 'interview' = 'run'): Usage {
    return this.sumRow(
      this.db
        .prepare(
          'SELECT COALESCE(SUM(prompt_tokens),0) p, COALESCE(SUM(completion_tokens),0) c, COALESCE(SUM(cached_tokens),0) cached, COALESCE(SUM(cost_usd),0) cost FROM token_ledger WHERE run_id = ? AND scope = ?'
        )
        .get(id, scope)
    )
  }

  globalUsage(): Usage {
    return this.sumRow(
      this.db
        .prepare(
          'SELECT COALESCE(SUM(prompt_tokens),0) p, COALESCE(SUM(completion_tokens),0) c, COALESCE(SUM(cached_tokens),0) cached, COALESCE(SUM(cost_usd),0) cost FROM token_ledger'
        )
        .get()
    )
  }

  /**
   * What the measurement cost versus what exploration cost. The global counter
   * deliberately spans both — the money is spent either way — but a reader who
   * sees one number cannot tell how much of it was questionnaire data.
   */
  usageByScope(): { run: Usage; interview: Usage } {
    const forScope = (scope: string): Usage =>
      this.sumRow(
        this.db
          .prepare(
            'SELECT COALESCE(SUM(prompt_tokens),0) p, COALESCE(SUM(completion_tokens),0) c, COALESCE(SUM(cached_tokens),0) cached, COALESCE(SUM(cost_usd),0) cost FROM token_ledger WHERE scope = ?'
          )
          .get(scope)
      )
    return { run: forScope('run'), interview: forScope('interview') }
  }

  limits(): BudgetConfig {
    return { ...this.config }
  }

  private sumRow(row: unknown): Usage {
    const r = row as { p: number; c: number; cached: number; cost: number }
    return {
      promptTokens: r.p,
      completionTokens: r.c,
      // cached tokens are part of prompt_tokens, so they are NOT added again here:
      // they are billed (cheaply), and the budget must reflect real consumption
      totalTokens: r.p + r.c,
      cachedTokens: r.cached,
      costUsd: r.cost
    }
  }
}
