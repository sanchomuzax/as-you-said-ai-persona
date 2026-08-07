import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export type Db = DatabaseSync

export function createDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(SCHEMA)
  migrate(db)
  return db
}

/** Idempotent migrations for databases created by earlier schema versions. */
function migrate(db: DatabaseSync): void {
  const personaCols = db.prepare('PRAGMA table_info(personas)').all() as unknown as { name: string }[]
  if (!personaCols.some((c) => c.name === 'project_id')) {
    db.exec('ALTER TABLE personas ADD COLUMN project_id TEXT REFERENCES projects(id)')
  }
  const questionnaireCols = db.prepare('PRAGMA table_info(questionnaires)').all() as unknown as { name: string }[]
  if (!questionnaireCols.some((c) => c.name === 'project_id')) {
    db.exec('ALTER TABLE questionnaires ADD COLUMN project_id TEXT REFERENCES projects(id)')
  }
  // Existing rows are each their own lineage root: they were the only version.
  if (!personaCols.some((c) => c.name === 'lineage_id')) {
    db.exec('ALTER TABLE personas ADD COLUMN lineage_id TEXT')
  }
  if (!questionnaireCols.some((c) => c.name === 'lineage_id')) {
    db.exec('ALTER TABLE questionnaires ADD COLUMN lineage_id TEXT')
  }
  // Only touches rows that need it: this runs at every boot, possibly while a run
  // is executing, and an unconditional UPDATE would take a write lock for nothing.
  db.exec('UPDATE personas SET lineage_id = id WHERE lineage_id IS NULL')
  db.exec('UPDATE questionnaires SET lineage_id = id WHERE lineage_id IS NULL')
  // One version number per lineage, enforced by the schema rather than by every
  // query site: a duplicate version would make two rows "latest" at once.
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_personas_lineage_version ON personas(lineage_id, version)')
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_questionnaires_lineage_version ON questionnaires(lineage_id, version)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_questions_questionnaire ON questions(questionnaire_id)')
  // Support the project-scoped run listing (issue #11), which joins a run to its
  // questionnaire and filters on that questionnaire's project.
  db.exec('CREATE INDEX IF NOT EXISTS idx_runs_questionnaire ON runs(questionnaire_id)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_questionnaires_project ON questionnaires(project_id)')
  // GET /api/runs's per-row response_count/done_cells/invalid_count/
  // abstained_count (issue #22) each filter on run_id and aggregate is_valid
  // and/or abstained — idx_responses_run (run_id only) makes SQLite visit the
  // table itself for those two columns on every row of a 200-run list.
  // Covering the actual columns those subqueries touch lets it answer them
  // from the index alone.
  db.exec('CREATE INDEX IF NOT EXISTS idx_responses_run_valid_abstained ON responses(run_id, is_valid, abstained)')
  // Left NULL for existing rows on purpose: their elicitation mode is unknown
  // (and wrong for multi-select questions), which the UI has to be able to say.
  const responseCols = db.prepare('PRAGMA table_info(responses)').all() as unknown as { name: string }[]
  if (!responseCols.some((c) => c.name === 'elicitation_mode')) {
    db.exec('ALTER TABLE responses ADD COLUMN elicitation_mode TEXT')
  }
  if (!responseCols.some((c) => c.name === 'cached_tokens')) {
    db.exec('ALTER TABLE responses ADD COLUMN cached_tokens INTEGER NOT NULL DEFAULT 0')
  }
  if (!responseCols.some((c) => c.name === 'provider')) {
    db.exec('ALTER TABLE responses ADD COLUMN provider TEXT')
  }
  if (!responseCols.some((c) => c.name === 'cache_discount_usd')) {
    db.exec('ALTER TABLE responses ADD COLUMN cache_discount_usd REAL')
  }
  const ledgerCols = db.prepare('PRAGMA table_info(token_ledger)').all() as unknown as { name: string }[]
  if (!ledgerCols.some((c) => c.name === 'cached_tokens')) {
    db.exec('ALTER TABLE token_ledger ADD COLUMN cached_tokens INTEGER NOT NULL DEFAULT 0')
  }
  // Interviews spend from the same budget but are not measurement. Without this
  // column a later "what did the runs cost" query would silently include them;
  // every pre-existing row predates interviews, so the 'run' default is correct.
  if (!ledgerCols.some((c) => c.name === 'scope')) {
    db.exec("ALTER TABLE token_ledger ADD COLUMN scope TEXT NOT NULL DEFAULT 'run'")
  }
  // Older evaluations have no coverage snapshot; NULL means "unknown", which the
  // UI shows as an unmarked evaluation rather than claiming it was complete.
  // model_profile_id/status (issue #17 M3) are NULL for a row written before
  // this milestone — genuinely UNKNOWN whether a profile existed, never to be
  // read as a claim that it didn't (issue #17 M3 review MED #6). A row written
  // BY this milestone that found no profile stores the literal status
  // 'missing' instead of NULL, so the two cases stay distinguishable.
  // model_profile_model_version/provider/measured_at snapshot what the CITED
  // profile itself measured, and model_profile_reasons_json snapshots why it
  // was judged stale — both AT EVALUATION TIME, so the audit trail reflects
  // what was true then even if the profile is later superseded (review MED #5).
  const evaluationCols = db.prepare('PRAGMA table_info(run_evaluations)').all() as unknown as { name: string }[]
  for (const column of [
    'run_status TEXT',
    'done_cells INTEGER',
    'total_cells INTEGER',
    'model_profile_id TEXT REFERENCES model_profiles(id)',
    'model_profile_status TEXT',
    'model_profile_model_version TEXT',
    'model_profile_provider TEXT',
    'model_profile_measured_at TEXT',
    'model_profile_reasons_json TEXT'
  ]) {
    const name = column.split(' ')[0]!
    if (!evaluationCols.some((c) => c.name === name)) {
      db.exec(`ALTER TABLE run_evaluations ADD COLUMN ${column}`)
    }
  }
  addBaselineArmSupport(db)
  // Last: the index keys on elicitation_mode, so it can only be created once every
  // column exists. Created earlier, the first boot after an upgrade would silently
  // run with no database-level protection at all.
  createCellUniqueIndex(db)
}

/**
 * The control arm records cells with no persona, but `persona_id` was created
 * NOT NULL and SQLite cannot relax a constraint in place — so the table is
 * rebuilt once, copying every row. The response log is append-only research
 * data: the copy is verified row-for-row inside the same transaction, and the
 * old table is only dropped if the counts match.
 */
function addBaselineArmSupport(db: DatabaseSync): void {
  const columns = db.prepare('PRAGMA table_info(responses)').all() as unknown as {
    name: string
    notnull: number
  }[]
  const personaId = columns.find((c) => c.name === 'persona_id')
  const needsRebuild = personaId?.notnull === 1 || !columns.some((c) => c.name === 'condition')
  if (!needsRebuild) return

  const names = columns.map((c) => c.name)
  const carried = names.filter((n) => n !== 'condition').join(', ')
  const before = (db.prepare('SELECT COUNT(*) c FROM responses').get() as { c: number }).c

  db.exec('PRAGMA foreign_keys = OFF')
  db.exec('BEGIN')
  try {
    db.exec('DROP INDEX IF EXISTS idx_responses_cell')
    db.exec('DROP INDEX IF EXISTS idx_responses_run')
    db.exec('ALTER TABLE responses RENAME TO responses_old')
    db.exec(RESPONSES_TABLE)
    db.exec(`INSERT INTO responses (${carried}) SELECT ${carried} FROM responses_old`)
    const after = (db.prepare('SELECT COUNT(*) c FROM responses').get() as { c: number }).c
    if (after !== before) throw new Error(`Response table rebuild lost rows: ${before} -> ${after}`)
    db.exec('DROP TABLE responses_old')
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  } finally {
    db.exec('PRAGMA foreign_keys = ON')
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_responses_run ON responses(run_id)')
}

/**
 * One row per experimental cell, enforced by the database itself — the second line
 * of defence behind the runner's per-run lock (issue #16). Databases recorded
 * before the fix may already contain duplicates; those rows are genuine repeated
 * measurements and are NOT deleted, so the index simply cannot be created there.
 * `cellIndexPresent` lets the API report which of the two states a database is in
 * instead of leaving it invisible.
 */
function createCellUniqueIndex(db: DatabaseSync): void {
  try {
    db.exec(
      // The elicitation mode is part of the key on purpose: re-eliciting a cell
      // under a NEW mode (v0.6.0) legitimately adds a second row for the same
      // cell, while a repeat under the SAME mode is the duplication bug.
      // COALESCE makes NULL (pre-v0.6 rows) comparable — SQLite treats bare NULLs
      // as distinct, which would let the old duplicates through.
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_responses_cell
         ON responses(run_id, question_id, persona_id, permutation_json, seed, COALESCE(elicitation_mode, ''))`
    )
  } catch (error) {
    // Pre-fix duplicates are expected and tolerated; anything else is a real fault
    // and must not be hidden behind the same silence.
    const message = error instanceof Error ? error.message : String(error)
    if (!message.includes('UNIQUE constraint failed')) throw error
  }
}

export function cellIndexPresent(db: DatabaseSync): boolean {
  const rows = db.prepare("PRAGMA index_list('responses')").all() as unknown as { name: string }[]
  return rows.some((r) => r.name === 'idx_responses_cell')
}

const RESPONSES_TABLE = `
CREATE TABLE IF NOT EXISTS responses (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  -- NULL for the persona-free control arm: that cell has no subject by design,
  -- and a placeholder persona would show up as a research subject it is not.
  persona_id TEXT REFERENCES personas(id),
  question_id TEXT NOT NULL REFERENCES questions(id),
  -- 'persona' | 'baseline' — never mixed in aggregation
  condition TEXT NOT NULL DEFAULT 'persona',
  model_requested TEXT NOT NULL,
  model_version TEXT,
  temperature REAL NOT NULL,
  seed INTEGER NOT NULL,
  prompt_style TEXT NOT NULL DEFAULT 'style_c',
  permutation_json TEXT NOT NULL,
  label_style TEXT NOT NULL DEFAULT 'letters',
  prompt_rendered TEXT NOT NULL,
  raw_response TEXT NOT NULL,
  parsed_distribution_json TEXT,
  parsed_answer TEXT,
  -- single_choice: distribution summing to 1; multi_choice: independent 0..1
  -- probabilities. NULL marks pre-v0.6 rows, where multi-select questions were
  -- elicited (and normalized) as if their options were mutually exclusive.
  elicitation_mode TEXT,
  is_valid INTEGER NOT NULL DEFAULT 1,
  abstained INTEGER NOT NULL DEFAULT 0,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  -- prompt tokens served from the provider's prompt cache (~10% of the price).
  -- 0 for rows recorded before this was measured: a provider that reports nothing
  -- is indistinguishable from a cache miss anyway, so 0 loses no information.
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL,
  -- saving reported by OpenRouter for the cached part of the prompt
  cache_discount_usd REAL,
  latency_ms INTEGER,
  openrouter_request_id TEXT,
  -- the same model id is served by several providers with different quantization
  -- and caching behaviour, so model pinning is only complete with the provider
  provider TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  application_domain TEXT,
  target_population TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Personas are immutable snapshots: an edit inserts a NEW row sharing the
-- lineage_id, so a finished run still points at the exact persona that answered.
CREATE TABLE IF NOT EXISTS personas (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id),
  lineage_id TEXT,
  name TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  demographics_json TEXT NOT NULL,
  biography TEXT,
  rendering_style TEXT NOT NULL DEFAULT 'bulleted_profile',
  provenance_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Same versioning rule as personas: editing a question after a run would make
-- the recorded answers uninterpretable, so edits create a new version.
CREATE TABLE IF NOT EXISTS questionnaires (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id),
  lineage_id TEXT,
  name TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS questions (
  id TEXT PRIMARY KEY,
  questionnaire_id TEXT NOT NULL REFERENCES questionnaires(id),
  ord INTEGER NOT NULL,
  text TEXT NOT NULL,
  scale_type TEXT NOT NULL DEFAULT 'categorical',
  options_json TEXT NOT NULL,
  scale_direction TEXT NOT NULL DEFAULT 'ascending'
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  questionnaire_id TEXT NOT NULL REFERENCES questionnaires(id),
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  config_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS run_personas (
  run_id TEXT NOT NULL REFERENCES runs(id),
  persona_id TEXT NOT NULL REFERENCES personas(id),
  PRIMARY KEY (run_id, persona_id)
);

${RESPONSES_TABLE}

CREATE TABLE IF NOT EXISTS token_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- a run id or an interview id, told apart by the scope column; the hard stop
  -- and the global budget deliberately span both
  run_id TEXT NOT NULL,
  prompt_tokens INTEGER NOT NULL,
  completion_tokens INTEGER NOT NULL,
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  -- 'run' | 'interview' — exploratory spend must stay separable from measurement
  scope TEXT NOT NULL DEFAULT 'run',
  ts TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Interviews are exploratory conversations WITH memory, the opposite of the
-- per-question memory reset the runner enforces. They therefore live in their
-- own tables: nothing here may ever reach the responses table or the run
-- aggregation.
CREATE TABLE IF NOT EXISTS interviews (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id),
  persona_id TEXT NOT NULL REFERENCES personas(id),
  title TEXT NOT NULL,
  model_requested TEXT NOT NULL,
  temperature REAL NOT NULL,
  seed INTEGER NOT NULL,
  provider TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS interview_messages (
  id TEXT PRIMARY KEY,
  interview_id TEXT NOT NULL REFERENCES interviews(id),
  -- 1-based position in the conversation; the researcher question and the
  -- persona answer are separate turns
  turn INTEGER NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  -- persona turns only: the exact message list sent, and the untouched output
  prompt_rendered TEXT,
  raw_response TEXT,
  model_requested TEXT,
  model_version TEXT,
  provider TEXT,
  temperature REAL,
  seed INTEGER,
  -- an evidence gap, not an error: the persona said the profile gives no basis
  abstained INTEGER NOT NULL DEFAULT 0,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL,
  cache_discount_usd REAL,
  latency_ms INTEGER,
  openrouter_request_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_interview_turn ON interview_messages(interview_id, turn);

-- Measured default behaviour of ONE exact stack (docs/MODEL-CALIBRATION.md M2).
-- Append-only like every other record here: a profile is never edited in place,
-- because it is a measurement of a configuration at a moment in time.
CREATE TABLE IF NOT EXISTS model_profiles (
  id TEXT PRIMARY KEY,
  -- the five key components; any change makes the profile stale
  model_requested TEXT NOT NULL,
  model_version TEXT NOT NULL,
  provider TEXT,
  prompt_template_hash TEXT NOT NULL,
  probe_questionnaire_id TEXT NOT NULL REFERENCES questionnaires(id),
  language TEXT NOT NULL DEFAULT 'hu',
  -- the calibration runs the numbers were computed from
  run_ids_json TEXT NOT NULL,
  -- every metric computed in code from the response log, never by a model
  metrics_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  valid_until TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_model_profiles_model ON model_profiles(model_requested);

CREATE TABLE IF NOT EXISTS run_evaluations (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  model TEXT NOT NULL,
  prompt TEXT NOT NULL,
  content TEXT NOT NULL,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  cost_usd REAL,
  -- coverage at the moment of evaluation: an evaluation of an unfinished run
  -- describes partial data and must be labelled as such
  run_status TEXT,
  done_cells INTEGER,
  total_cells INTEGER,
  -- which model_profiles row (docs/MODEL-CALIBRATION.md M3) the judge prompt was
  -- built against, judged against the STACK THIS RUN OWN CALLS USED (not
  -- today's global stack — issue #17 M3 review HIGH #2), and its status AT
  -- THAT TIME — a profile stale now may have been valid when this evaluation
  -- ran, and the audit trail must say which. model_profile_status NULL means
  -- UNKNOWN (a row written before M3); the literal string 'missing' means M3
  -- looked and genuinely found no profile — the two must stay distinguishable.
  model_profile_id TEXT REFERENCES model_profiles(id),
  model_profile_status TEXT,
  -- snapshot of what the CITED profile itself measured, so the UI can name it
  -- (not just its status) without a second lookup against a row that may have
  -- since been superseded by a newer profile for the same model
  model_profile_model_version TEXT,
  model_profile_provider TEXT,
  model_profile_measured_at TEXT,
  -- the concrete reason(s) it was judged stale FOR THIS RUN, JSON-encoded;
  -- NULL when valid/missing/unknown
  model_profile_reasons_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_responses_run ON responses(run_id);
CREATE INDEX IF NOT EXISTS idx_ledger_run ON token_ledger(run_id);
`
