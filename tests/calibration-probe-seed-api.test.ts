import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { createDb, type Db } from '../src/db.js'
import { buildServer } from '../src/server.js'
import type { AppConfig } from '../src/config.js'
import type { ChatClient, ChatResult } from '../src/openrouter.js'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const agentSeeds = path.join(repoRoot, 'agent', 'seed')
const seedScript = path.join(repoRoot, 'scripts', 'seed.ts')
const tsxBin = path.join(repoRoot, 'node_modules', '.bin', 'tsx')

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

class StubClient implements ChatClient {
  async complete(): Promise<ChatResult> {
    throw new Error('not used')
  }
}

let tempDir: string | null = null
let db: Db | null = null
let app: FastifyInstance | null = null

afterEach(async () => {
  await app?.close()
  app = null
  db?.close()
  db = null
  if (tempDir) rmSync(tempDir, { recursive: true, force: true })
  tempDir = null
})

describe('calibration probe seed compatibility (issue #27)', () => {
  it('preserves an existing ordinary explicit true unless the seed explicitly says false', () => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'asys-calibration-probe-existing-'))
    const dbPath = path.join(tempDir, 'seed.sqlite')
    const ordinarySeedPath = path.join(tempDir, 'ordinary.json')
    const baselineSeedPath = path.join(tempDir, 'baseline.json')
    const initial = createDb(dbPath)
    initial.prepare('INSERT INTO projects (id, name) VALUES (?,?)').run('ordinary', 'Általános kutatás')
    initial.prepare('INSERT INTO projects (id, name) VALUES (?,?)').run('baseline', 'Modell-baseline próba')
    initial.prepare(
      'INSERT INTO questionnaires (id, project_id, lineage_id, name, is_calibration_probe) VALUES (?,?,?,?,?)'
    ).run('ordinary-kept', 'ordinary', 'ordinary-kept', 'Kézzel kijelölt próba', 1)
    initial.prepare(
      'INSERT INTO questionnaires (id, project_id, lineage_id, name, is_calibration_probe) VALUES (?,?,?,?,?)'
    ).run('baseline-raised', 'baseline', 'baseline-raised', 'Implicit baseline próba', 0)
    initial.prepare(
      'INSERT INTO questionnaires (id, project_id, lineage_id, name, is_calibration_probe) VALUES (?,?,?,?,?)'
    ).run('baseline-optout', 'baseline', 'baseline-optout', 'Explicit ordinary kontroll', 1)
    initial.close()

    const question = { text: 'Kérdés?', options: ['Igen', 'Nem'], scaleType: 'single_choice' }
    writeFileSync(ordinarySeedPath, JSON.stringify({
      project: { name: 'Általános kutatás' },
      questionnaires: [{ name: 'Kézzel kijelölt próba', questions: [question] }]
    }))
    writeFileSync(baselineSeedPath, JSON.stringify({
      project: { name: 'Modell-baseline próba' },
      questionnaires: [
        { name: 'Implicit baseline próba', questions: [question] },
        { name: 'Explicit ordinary kontroll', isCalibrationProbe: false, questions: [question] }
      ]
    }))

    for (const seedPath of [ordinarySeedPath, baselineSeedPath]) {
      execFileSync(tsxBin, [seedScript, seedPath], {
        cwd: repoRoot,
        env: { ...process.env, DATABASE_PATH: dbPath },
        stdio: 'pipe'
      })
    }

    db = createDb(dbPath)
    const flags = db.prepare(
      'SELECT name, is_calibration_probe FROM questionnaires ORDER BY name'
    ).all() as unknown as { name: string; is_calibration_probe: number }[]
    expect(Object.fromEntries(flags.map((row) => [row.name, row.is_calibration_probe]))).toEqual({
      'Explicit ordinary kontroll': 0,
      'Implicit baseline próba': 1,
      'Kézzel kijelölt próba': 1
    })
  })

  it('exposes every current Modell-baseline probe as designated and an ordinary seed as ordinary', async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'asys-calibration-probe-seed-'))
    const dbPath = path.join(tempDir, 'seed.sqlite')
    const privateProbePaths = existsSync(agentSeeds)
      ? readdirSync(agentSeeds)
          .filter((name) => /^default-persona-probe.*\.json$/.test(name))
          .sort()
          .map((name) => path.join(agentSeeds, name))
      : []
    const syntheticProbePath = path.join(tempDir, 'calibration-probe.json')
    writeFileSync(syntheticProbePath, JSON.stringify({
      project: { name: 'Modell-baseline próba' },
      questionnaires: [{
        name: 'Nyilvános CI próba',
        questions: [{ text: 'Próbakérdés?', options: ['Igen', 'Nem'], scaleType: 'single_choice' }]
      }]
    }))
    const probePaths = privateProbePaths.length > 0 ? privateProbePaths : [syntheticProbePath]

    const probeNames = new Set<string>()
    for (const seedPath of probePaths) {
      const seed = JSON.parse(readFileSync(seedPath, 'utf8')) as {
        project: { name: string }
        questionnaires: { name: string }[]
      }
      expect(seed.project.name).toBe('Modell-baseline próba')
      seed.questionnaires.forEach((q) => probeNames.add(q.name))
      execFileSync(tsxBin, [seedScript, seedPath], {
        cwd: repoRoot,
        env: { ...process.env, DATABASE_PATH: dbPath },
        stdio: 'pipe'
      })
    }

    const privateOrdinarySeedPath = path.join(agentSeeds, 'akcios-ujsag-kerdoiv.json')
    const syntheticOrdinarySeedPath = path.join(tempDir, 'ordinary-questionnaire.json')
    writeFileSync(syntheticOrdinarySeedPath, JSON.stringify({
      project: { name: 'Általános kutatás' },
      questionnaires: [{
        name: 'Nyilvános CI kérdőív',
        questions: [{ text: 'Üzleti kérdés?', options: ['Igen', 'Nem'], scaleType: 'single_choice' }]
      }]
    }))
    const ordinarySeedPath = existsSync(privateOrdinarySeedPath)
      ? privateOrdinarySeedPath
      : syntheticOrdinarySeedPath
    const ordinarySeed = JSON.parse(readFileSync(ordinarySeedPath, 'utf8')) as {
      questionnaires: { name: string }[]
    }
    execFileSync(tsxBin, [seedScript, ordinarySeedPath], {
      cwd: repoRoot,
      env: { ...process.env, DATABASE_PATH: dbPath },
      stdio: 'pipe'
    })

    db = createDb(dbPath)
    app = buildServer({
      db,
      config: { ...testConfig, DATABASE_PATH: dbPath },
      models: { default: 'm1', models: [{ id: 'm1', label: 'Modell 1' }] },
      client: new StubClient()
    })
    await app.ready()
    const login = await app.inject({
      method: 'POST', url: '/api/login', payload: { username: 'admin', password: 'test-password-123' }
    })
    const cookie = { asys_session: /asys_session=([^;]+)/.exec(login.headers['set-cookie'] as string)![1]! }
    const questionnaires = (
      await app.inject({ method: 'GET', url: '/api/questionnaires', cookies: cookie })
    ).json().data as { name: string; isCalibrationProbe?: boolean }[]

    for (const name of probeNames) {
      expect(questionnaires.find((q) => q.name === name), name).toMatchObject({ isCalibrationProbe: true })
    }
    for (const ordinary of ordinarySeed.questionnaires) {
      expect(questionnaires.find((q) => q.name === ordinary.name), ordinary.name).toMatchObject({
        isCalibrationProbe: false
      })
    }
  }, 30_000)
})
