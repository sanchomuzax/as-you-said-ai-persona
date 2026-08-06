import { describe, it, expect, beforeEach } from 'vitest'
import { createDb, type Db } from '../src/db.js'
import { BudgetTracker } from '../src/lib/budget.js'

let db: Db

beforeEach(() => {
  db = createDb(':memory:')
})

describe('BudgetTracker', () => {
  it('allows spending under budget and blocks when run budget exhausted', () => {
    const t = new BudgetTracker(db, { globalBudget: 1000, perRunBudget: 100 })
    expect(t.canSpend('run1')).toBe(true)
    t.record('run1', { promptTokens: 60, completionTokens: 39, costUsd: 0.001 })
    expect(t.canSpend('run1')).toBe(true)
    t.record('run1', { promptTokens: 1, completionTokens: 1, costUsd: 0 })
    expect(t.canSpend('run1')).toBe(false)
  })

  it('enforces the global budget across runs', () => {
    const t = new BudgetTracker(db, { globalBudget: 100, perRunBudget: 1000 })
    t.record('run1', { promptTokens: 50, completionTokens: 50, costUsd: 0 })
    expect(t.canSpend('run2')).toBe(false)
  })

  it('reports usage totals', () => {
    const t = new BudgetTracker(db, { globalBudget: 1000, perRunBudget: 500 })
    t.record('run1', { promptTokens: 10, completionTokens: 5, costUsd: 0.002 })
    t.record('run1', { promptTokens: 10, completionTokens: 5, costUsd: 0.001 })
    const u = t.usage('run1')
    expect(u.totalTokens).toBe(30)
    expect(u.costUsd).toBeCloseTo(0.003)
    expect(t.globalUsage().totalTokens).toBe(30)
  })
})
