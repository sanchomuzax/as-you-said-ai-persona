import { describe, it, expect } from 'vitest'
import { loadConfig, loadModels } from '../src/config.js'

const validEnv = {
  OPENROUTER_API_KEY: 'key',
  AUTH_USERNAME: 'admin',
  AUTH_PASSWORD: 'password123',
  SESSION_SECRET: 'a-secret-of-16-chars-min'
} as NodeJS.ProcessEnv

describe('loadConfig', () => {
  it('applies defaults for optional values', () => {
    const cfg = loadConfig(validEnv)
    expect(cfg.PORT).toBe(3555)
    expect(cfg.TOKEN_BUDGET_GLOBAL).toBe(5_000_000)
    expect(cfg.OPENROUTER_BASE_URL).toContain('openrouter.ai')
  })

  it('rejects missing API key with a clear message', () => {
    expect(() => loadConfig({ ...validEnv, OPENROUTER_API_KEY: undefined })).toThrow(/OPENROUTER_API_KEY/)
  })

  it('rejects a short password', () => {
    expect(() => loadConfig({ ...validEnv, AUTH_PASSWORD: 'short' })).toThrow(/AUTH_PASSWORD/)
  })

  it('coerces numeric env vars', () => {
    const cfg = loadConfig({ ...validEnv, PORT: '4000', TOKEN_BUDGET_PER_RUN: '1234' })
    expect(cfg.PORT).toBe(4000)
    expect(cfg.TOKEN_BUDGET_PER_RUN).toBe(1234)
  })
})

describe('loadModels', () => {
  it('loads the checked-in models config with deepseek default', () => {
    const models = loadModels()
    expect(models.default).toBe('deepseek/deepseek-v4-flash-0731')
    expect(models.models.some((m) => m.id === models.default)).toBe(true)
  })
})

describe('schema migration', () => {
  it('adds every later column to a database created by an earlier version', async () => {
    const { createDb } = await import('../src/db.js')
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')

    const path = join(mkdtempSync(join(tmpdir(), 'asys-migrate-all-')), 'db.sqlite')
    const before = createDb(path)
    for (const drop of [
      'ALTER TABLE responses DROP COLUMN elicitation_mode',
      'ALTER TABLE responses DROP COLUMN cached_tokens',
      'ALTER TABLE responses DROP COLUMN provider',
      'ALTER TABLE responses DROP COLUMN cache_discount_usd',
      'ALTER TABLE token_ledger DROP COLUMN cached_tokens',
      'ALTER TABLE run_evaluations DROP COLUMN run_status',
      'ALTER TABLE run_evaluations DROP COLUMN done_cells',
      'ALTER TABLE run_evaluations DROP COLUMN total_cells'
    ]) {
      before.exec(drop)
    }
    // a legacy row must survive the migration, including the NOT NULL DEFAULT columns
    before.prepare('INSERT INTO token_ledger (run_id, prompt_tokens, completion_tokens, cost_usd) VALUES (?,?,?,?)').run('r', 10, 2, 0)
    before.close()

    const after = createDb(path)
    const columns = (table: string): string[] =>
      (after.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[]).map((c) => c.name)
    expect(columns('responses')).toEqual(
      expect.arrayContaining(['elicitation_mode', 'cached_tokens', 'provider', 'cache_discount_usd'])
    )
    expect(columns('token_ledger')).toContain('cached_tokens')
    expect(columns('run_evaluations')).toEqual(expect.arrayContaining(['run_status', 'done_cells', 'total_cells']))
    const legacy = after.prepare('SELECT cached_tokens FROM token_ledger').get() as { cached_tokens: number }
    expect(legacy.cached_tokens).toBe(0)
    createDb(path).close() // idempotent
    after.close()
  })

  it('adds elicitation_mode to a database created before the elicitation split', async () => {
    const { createDb } = await import('../src/db.js')
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')

    const path = join(mkdtempSync(join(tmpdir(), 'asys-migrate-')), 'db.sqlite')
    const before = createDb(path)
    before.exec('ALTER TABLE responses DROP COLUMN elicitation_mode')
    expect(
      (before.prepare('PRAGMA table_info(responses)').all() as unknown as { name: string }[])
        .some((c) => c.name === 'elicitation_mode')
    ).toBe(false)
    before.close()

    const after = createDb(path)
    expect(
      (after.prepare('PRAGMA table_info(responses)').all() as unknown as { name: string }[])
        .some((c) => c.name === 'elicitation_mode')
    ).toBe(true)
    // idempotent: opening again must not throw
    createDb(path).close()
    after.close()
  })
})
