import type { Db } from '../db.js'

export interface BudgetConfig {
  globalBudget: number
  perRunBudget: number
}

export interface SpendRecord {
  promptTokens: number
  completionTokens: number
  costUsd: number
}

export interface Usage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  costUsd: number
}

/** Token ledger with hard budget stops, checked BEFORE every model call. */
export class BudgetTracker {
  constructor(
    private readonly db: Db,
    private readonly config: BudgetConfig
  ) {}

  record(runId: string, spend: SpendRecord): void {
    this.db
      .prepare(
        'INSERT INTO token_ledger (run_id, prompt_tokens, completion_tokens, cost_usd) VALUES (?, ?, ?, ?)'
      )
      .run(runId, spend.promptTokens, spend.completionTokens, spend.costUsd)
  }

  canSpend(runId: string): boolean {
    return (
      this.usage(runId).totalTokens < this.config.perRunBudget &&
      this.globalUsage().totalTokens < this.config.globalBudget
    )
  }

  usage(runId: string): Usage {
    return this.sumRow(
      this.db
        .prepare(
          'SELECT COALESCE(SUM(prompt_tokens),0) p, COALESCE(SUM(completion_tokens),0) c, COALESCE(SUM(cost_usd),0) cost FROM token_ledger WHERE run_id = ?'
        )
        .get(runId)
    )
  }

  globalUsage(): Usage {
    return this.sumRow(
      this.db
        .prepare(
          'SELECT COALESCE(SUM(prompt_tokens),0) p, COALESCE(SUM(completion_tokens),0) c, COALESCE(SUM(cost_usd),0) cost FROM token_ledger'
        )
        .get()
    )
  }

  limits(): BudgetConfig {
    return { ...this.config }
  }

  private sumRow(row: unknown): Usage {
    const r = row as { p: number; c: number; cost: number }
    return {
      promptTokens: r.p,
      completionTokens: r.c,
      totalTokens: r.p + r.c,
      costUsd: r.cost
    }
  }
}
