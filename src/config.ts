import 'dotenv/config'
import { z } from 'zod'
import { readFileSync } from 'node:fs'

const envSchema = z.object({
  OPENROUTER_API_KEY: z.string().min(1, 'OPENROUTER_API_KEY not configured'),
  OPENROUTER_BASE_URL: z.string().url().default('https://openrouter.ai/api/v1'),
  AUTH_USERNAME: z.string().min(1),
  AUTH_PASSWORD: z.string().min(8, 'AUTH_PASSWORD must be at least 8 characters'),
  SESSION_SECRET: z.string().min(16, 'SESSION_SECRET must be at least 16 characters'),
  TOKEN_BUDGET_GLOBAL: z.coerce.number().int().positive().default(5_000_000),
  TOKEN_BUDGET_PER_RUN: z.coerce.number().int().positive().default(500_000),
  PORT: z.coerce.number().int().default(3555),
  DATABASE_PATH: z.string().default('./data/asys.sqlite')
})

export type AppConfig = z.infer<typeof envSchema>

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
    throw new Error(`Invalid configuration: ${issues}`)
  }
  return parsed.data
}

const modelsSchema = z.object({
  default: z.string(),
  models: z.array(z.object({ id: z.string(), label: z.string() })).min(1)
})

export type ModelsConfig = z.infer<typeof modelsSchema>

export function loadModels(path = new URL('../config/models.json', import.meta.url)): ModelsConfig {
  const parsed = modelsSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')))
  if (!parsed.success) throw new Error(`Invalid config/models.json: ${parsed.error.message}`)
  if (!parsed.data.models.some((m) => m.id === parsed.data.default)) {
    throw new Error('config/models.json: default model missing from models list')
  }
  return parsed.data
}
