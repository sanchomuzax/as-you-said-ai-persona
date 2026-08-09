import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createDb } from '../src/db.js'

const tempDirs: string[] = []

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'asys-probe-migration-'))
  tempDirs.push(dir)
  return join(dir, 'db.sqlite')
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('calibration-probe designation migration', () => {
  it('rolls the column addition back when the legacy backfill fails', () => {
    const path = tempDbPath()
    const legacy = createDb(path)
    legacy.prepare('INSERT INTO projects (id, name) VALUES (?,?)').run('baseline', 'Modell-baseline próba')
    legacy.prepare('INSERT INTO questionnaires (id, project_id, lineage_id, name) VALUES (?,?,?,?)')
      .run('legacy-probe', 'baseline', 'legacy-probe', 'Legacy próba')
    legacy.exec('ALTER TABLE questionnaires DROP COLUMN is_calibration_probe')
    // Public-behavior fault injection: the migration's backfill is an UPDATE.
    // If ALTER + UPDATE are one transaction, this trigger aborts both; without
    // that transaction it leaves the newly added column behind with value 0.
    legacy.exec(`CREATE TRIGGER fail_probe_backfill BEFORE UPDATE ON questionnaires
      BEGIN SELECT RAISE(ABORT, 'injected probe-backfill failure'); END`)
    legacy.close()

    expect(() => createDb(path)).toThrow(/injected probe-backfill failure/)

    const inspected = new DatabaseSync(path)
    const columns = inspected.prepare('PRAGMA table_info(questionnaires)').all() as unknown as { name: string }[]
    expect(columns.map((column) => column.name)).not.toContain('is_calibration_probe')
    inspected.close()
  })

  it('backfills an exact legacy baseline project once, then preserves an explicit false on later boots', () => {
    const path = tempDbPath()
    const legacy = createDb(path)
    legacy.prepare('INSERT INTO projects (id, name) VALUES (?,?)').run('baseline', 'Modell-baseline próba')
    legacy.prepare('INSERT INTO questionnaires (id, project_id, lineage_id, name) VALUES (?,?,?,?)')
      .run('ordinary-control', 'baseline', 'ordinary-control', 'Ordinary kontroll')
    legacy.exec('ALTER TABLE questionnaires DROP COLUMN is_calibration_probe')
    legacy.close()

    const migrated = createDb(path)
    expect(migrated.prepare('SELECT is_calibration_probe value FROM questionnaires WHERE id = ?')
      .get('ordinary-control')).toEqual({ value: 1 })
    migrated.prepare('UPDATE questionnaires SET is_calibration_probe = 0 WHERE id = ?').run('ordinary-control')
    migrated.close()

    const reopened = createDb(path)
    expect(reopened.prepare('SELECT is_calibration_probe value FROM questionnaires WHERE id = ?')
      .get('ordinary-control')).toEqual({ value: 0 })
    reopened.close()
  })

  it('does not count an unchanged designated questionnaire as a write on every boot', () => {
    const path = tempDbPath()
    const first = createDb(path)
    first.prepare('INSERT INTO projects (id, name) VALUES (?,?)').run('baseline', 'Modell-baseline próba')
    first.prepare(
      'INSERT INTO questionnaires (id, project_id, lineage_id, name, is_calibration_probe) VALUES (?,?,?,?,?)'
    ).run('probe', 'baseline', 'probe', 'Próba', 1)
    first.close()

    const reopened = createDb(path)
    const changes = reopened.prepare('SELECT total_changes() value').get() as { value: number }
    expect(changes.value).toBe(0)
    reopened.close()
  })
})
