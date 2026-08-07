import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDb, type Db } from '../src/db.js'

/**
 * Issue #33 requirement 4: existing runs/profiles must not be discarded or
 * silently reinterpreted. They were made with the old, always-English
 * template regardless of the questionnaire's language — that fact must be
 * recorded so they stay interpretable, not left to an unwritten convention.
 */

function columns(db: Db, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[]).map((c) => c.name)
}

function tmpDbPath(prefix: string): string {
  return join(mkdtempSync(join(tmpdir(), prefix)), 'db.sqlite')
}

describe('questionnaires.language', () => {
  it('exists on a fresh database, defaulting to hu', () => {
    const db = createDb(':memory:')
    expect(columns(db, 'questionnaires')).toContain('language')
    db.prepare('INSERT INTO questionnaires (id, lineage_id, name) VALUES (?,?,?)').run('q1', 'q1', 'Q')
    const row = db.prepare('SELECT language FROM questionnaires WHERE id = ?').get('q1') as { language: string }
    expect(row.language).toBe('hu')
  })

  it('adds the column to a database created before this change', () => {
    const path = tmpDbPath('asys-qn-lang-')
    const before = createDb(path)
    before.exec('ALTER TABLE questionnaires DROP COLUMN language')
    before.close()
    const after = createDb(path)
    expect(columns(after, 'questionnaires')).toContain('language')
  })
})

describe('model_profiles.template_language', () => {
  it('exists on a fresh database', () => {
    const db = createDb(':memory:')
    expect(columns(db, 'model_profiles')).toContain('template_language')
  })

  it('backfills to the legacy sentinel on a database created before this change', () => {
    const path = tmpDbPath('asys-profile-lang-')
    const before = createDb(path)
    before.exec('ALTER TABLE model_profiles DROP COLUMN template_language')
    before.prepare('INSERT INTO questionnaires (id, lineage_id, name) VALUES (?,?,?)').run('q1', 'q1', 'Q')
    before.prepare(
      `INSERT INTO model_profiles
         (id, model_requested, model_version, provider, prompt_template_hash, probe_questionnaire_id,
          language, run_ids_json, metrics_json, valid_until)
       VALUES ('p1','m1','m1-v1','X','hash','q1','hu','[]','{}','2099-01-01 00:00:00')`
    ).run()
    before.close()
    const after = createDb(path)
    const row = after.prepare('SELECT template_language FROM model_profiles WHERE id = ?').get('p1') as {
      template_language: string
    }
    expect(row.template_language).toBe('mixed_legacy')
  })
})

describe('runs.config_json backfill', () => {
  it('stamps templateLanguage: mixed_legacy onto a pre-existing run that never had the field', () => {
    const path = tmpDbPath('asys-run-lang-')
    const before = createDb(path)
    before.prepare('INSERT INTO questionnaires (id, lineage_id, name) VALUES (?,?,?)').run('q1', 'q1', 'Q')
    // Simulates a run written by code before this change: config_json has no
    // templateLanguage key at all.
    before.prepare('INSERT INTO runs (id, questionnaire_id, name, config_json) VALUES (?,?,?,?)').run(
      'old-run', 'q1', 'Régi futás', JSON.stringify({ model: 'm1', temperature: 1, seeds: [0] })
    )
    before.close()

    const after = createDb(path)
    const row = after.prepare('SELECT config_json FROM runs WHERE id = ?').get('old-run') as { config_json: string }
    const config = JSON.parse(row.config_json) as Record<string, unknown>
    expect(config['templateLanguage']).toBe('mixed_legacy')
    // Nothing else about the historical config is touched.
    expect(config['model']).toBe('m1')
    expect(config['seeds']).toEqual([0])
  })

  it('never overwrites a templateLanguage a run already recorded', () => {
    const path = tmpDbPath('asys-run-lang-keep-')
    const before = createDb(path)
    before.prepare('INSERT INTO questionnaires (id, lineage_id, name) VALUES (?,?,?)').run('q1', 'q1', 'Q')
    before.prepare('INSERT INTO runs (id, questionnaire_id, name, config_json) VALUES (?,?,?,?)').run(
      'new-run', 'q1', 'Új futás', JSON.stringify({ model: 'm1', temperature: 1, seeds: [0], templateLanguage: 'hu' })
    )
    before.close()

    const after = createDb(path)
    const row = after.prepare('SELECT config_json FROM runs WHERE id = ?').get('new-run') as { config_json: string }
    expect((JSON.parse(row.config_json) as Record<string, unknown>)['templateLanguage']).toBe('hu')
  })
})
