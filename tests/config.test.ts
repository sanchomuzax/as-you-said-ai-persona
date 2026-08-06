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
