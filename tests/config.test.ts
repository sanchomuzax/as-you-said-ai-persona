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
