import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createDb, type Db } from '../src/db.js'

/**
 * Issue #26: seeds/example-project.json — the README's own "try the platform
 * end to end" entry point (`npx tsx scripts/seed.ts seeds/example-project.json`)
 * — failed zod validation on a typo'd scaleType, so a new user's first command
 * crashed. Nothing checked that the seed files shipped with the repo can
 * actually be loaded.
 *
 * This runs the REAL, unmodified scripts/seed.ts as a subprocess — exactly
 * the command the README tells a user to type — against every *.json under
 * the PUBLIC seeds/ directory (globbed, not hard-coded, so a future seed file
 * is covered automatically). Running the real script is what "reuse the real
 * validation, not a copy of it" means here: scripts/seed.ts's zod schema is a
 * local, unexported const, and copying it into this test file would drift out
 * of sync with the real one and silently stop protecting anything. This does
 * NOT touch agent/seed/ — that directory belongs to a separate private repo
 * and is not shipped with this one.
 */

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const seedsDir = path.join(repoRoot, 'seeds')
const seedScript = path.join(repoRoot, 'scripts', 'seed.ts')
const tsxBin = path.join(repoRoot, 'node_modules', '.bin', 'tsx')

interface SeedFile {
  project: { name: string; applicationDomain?: string; targetPopulation?: string }
  personas?: unknown[]
  questionnaires?: { questions: unknown[] }[]
}

/** The PUBLIC seeds/ directory only. */
const seedFiles = readdirSync(seedsDir).filter((f) => f.endsWith('.json'))

let tempDir: string | null = null
let db: Db | null = null

afterEach(() => {
  db = null
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true })
    tempDir = null
  }
})

describe('shipped seed files load via the real seeding script (issue #26)', () => {
  // A guard that silently checks zero files is not a guard — this fails
  // loudly instead of the `for` loop below quietly generating no tests.
  it('finds at least one *.json seed file under seeds/ to check', () => {
    expect(seedFiles.length).toBeGreaterThan(0)
  })

  for (const file of seedFiles) {
    it(`${file}: validates and loads into a fresh database, with the declared project/personas/questionnaires actually present`, () => {
      tempDir = mkdtempSync(path.join(tmpdir(), 'asys-seed-test-'))
      const dbPath = path.join(tempDir, 'seed-test.sqlite')
      const seedPath = path.join(seedsDir, file)
      const raw = JSON.parse(readFileSync(seedPath, 'utf8')) as SeedFile

      // The exact command README.md tells a new user to run, unmodified,
      // pointed at a throwaway database via DATABASE_PATH so this never
      // touches the real ./data/asys.sqlite.
      execFileSync(tsxBin, [seedScript, seedPath], {
        cwd: repoRoot,
        env: { ...process.env, DATABASE_PATH: dbPath },
        stdio: 'pipe'
      })

      db = createDb(dbPath)

      const project = db.prepare('SELECT * FROM projects WHERE name = ?').get(raw.project.name) as
        | { id: string; application_domain: string | null; target_population: string | null }
        | undefined
      expect(project, `project "${raw.project.name}" declared in ${file} was not found afterwards`).toBeDefined()
      expect(project!.application_domain).toBe(raw.project.applicationDomain ?? null)
      expect(project!.target_population).toBe(raw.project.targetPopulation ?? null)

      const personaCount = (
        db.prepare('SELECT COUNT(*) c FROM personas WHERE project_id = ?').get(project!.id) as { c: number }
      ).c
      expect(personaCount, `persona count for ${file}`).toBe((raw.personas ?? []).length)

      const questionnaireCount = (
        db.prepare('SELECT COUNT(*) c FROM questionnaires WHERE project_id = ?').get(project!.id) as { c: number }
      ).c
      expect(questionnaireCount, `questionnaire count for ${file}`).toBe((raw.questionnaires ?? []).length)

      const expectedQuestions = (raw.questionnaires ?? []).reduce((sum, q) => sum + q.questions.length, 0)
      const questionCount = (
        db
          .prepare(
            `SELECT COUNT(*) c FROM questions q
               JOIN questionnaires qn ON qn.id = q.questionnaire_id
              WHERE qn.project_id = ?`
          )
          .get(project!.id) as { c: number }
      ).c
      expect(questionCount, `question count for ${file}`).toBe(expectedQuestions)
    }, 30_000)
  }
})
