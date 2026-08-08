import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDb, type Db } from '../src/db.js'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const seedScript = path.join(repoRoot, 'scripts', 'seed.ts')
const probeSeedPath = path.join(repoRoot, 'agent', 'seed', 'default-persona-probe-v2.json')
const tsxBin = path.join(repoRoot, 'node_modules', '.bin', 'tsx')

let tempDir: string | null = null
let db: Db | null = null

function columns(database: Db, table: string): { name: string; notnull: number; dflt_value: unknown }[] {
  return database.prepare(`PRAGMA table_info(${table})`).all() as unknown as {
    name: string
    notnull: number
    dflt_value: unknown
  }[]
}

afterEach(() => {
  db?.close()
  db = null
  if (tempDir) rmSync(tempDir, { recursive: true, force: true })
  tempDir = null
})

describe('questions.metadata_json migration (issue #41)', () => {
  it('is nullable and defaults to NULL on a fresh database', () => {
    db = createDb(':memory:')
    const column = columns(db, 'questions').find((c) => c.name === 'metadata_json')
    expect(column).toMatchObject({ name: 'metadata_json', notnull: 0, dflt_value: null })

    db.prepare('INSERT INTO questionnaires (id, lineage_id, name) VALUES (?,?,?)').run('qn', 'qn', 'Q')
    db.prepare('INSERT INTO questions (id, questionnaire_id, ord, text, options_json) VALUES (?,?,?,?,?)').run(
      'q', 'qn', 0, 'Metaadat nélküli kérdés', '["a","b"]'
    )
    const row = db.prepare('SELECT metadata_json FROM questions WHERE id = ?').get('q') as { metadata_json: string | null }
    expect(row.metadata_json).toBeNull()
  })

  it('adds the nullable column without inventing metadata for existing questions', () => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'asys-question-metadata-migration-'))
    const dbPath = path.join(tempDir, 'db.sqlite')
    const before = createDb(dbPath)
    if (columns(before, 'questions').some((c) => c.name === 'metadata_json')) {
      before.exec('ALTER TABLE questions DROP COLUMN metadata_json')
    }
    before.prepare('INSERT INTO questionnaires (id, lineage_id, name) VALUES (?,?,?)').run('qn', 'qn', 'Régi kérdőív')
    before.prepare('INSERT INTO questions (id, questionnaire_id, ord, text, options_json) VALUES (?,?,?,?,?)').run(
      'old-q', 'qn', 0, 'Régi kérdés', '["a","b"]'
    )
    before.close()

    db = createDb(dbPath)
    expect(columns(db, 'questions').map((c) => c.name)).toContain('metadata_json')
    const row = db.prepare('SELECT metadata_json FROM questions WHERE id = ?').get('old-q') as { metadata_json: string | null }
    expect(row.metadata_json).toBeNull()
  })
})

describe('the real seeder preserves probe-v2 question metadata (issue #41)', () => {
  it('stores _reference, _scope, _tier and _torzitas instead of silently dropping them', () => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'asys-question-metadata-seed-'))
    const dbPath = path.join(tempDir, 'seed.sqlite')
    const raw = JSON.parse(readFileSync(probeSeedPath, 'utf8')) as {
      questionnaires: { questions: Record<string, unknown>[] }[]
    }

    execFileSync(tsxBin, [seedScript, probeSeedPath], {
      cwd: repoRoot,
      env: { ...process.env, DATABASE_PATH: dbPath },
      stdio: 'pipe'
    })
    db = createDb(dbPath)

    const examples = ['_reference', '_scope', '_tier', '_torzitas'] as const
    for (const key of examples) {
      const source = raw.questionnaires[0]!.questions.find((q) => q[key] !== undefined)!
      const row = db.prepare('SELECT metadata_json FROM questions WHERE text = ?').get(String(source['text'])) as {
        metadata_json: string | null
      }
      expect(row.metadata_json, `${key} metadata_json`).not.toBeNull()
      const stored = JSON.parse(row.metadata_json!) as Record<string, unknown>
      expect(stored[key], `${key} for ${String(source['text'])}`).toEqual(source[key])
    }
  }, 30_000)
})
