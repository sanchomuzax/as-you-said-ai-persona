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
  db.exec('UPDATE personas SET lineage_id = id WHERE lineage_id IS NULL')
  db.exec('UPDATE questionnaires SET lineage_id = id WHERE lineage_id IS NULL')
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
  // Older evaluations have no coverage snapshot; NULL means "unknown", which the
  // UI shows as an unmarked evaluation rather than claiming it was complete.
  const evaluationCols = db.prepare('PRAGMA table_info(run_evaluations)').all() as unknown as { name: string }[]
  for (const column of ['run_status TEXT', 'done_cells INTEGER', 'total_cells INTEGER']) {
    const name = column.split(' ')[0]!
    if (!evaluationCols.some((c) => c.name === name)) {
      db.exec(`ALTER TABLE run_evaluations ADD COLUMN ${column}`)
    }
  }
}

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

-- Append-only response log: one row per API call, never updated.
CREATE TABLE IF NOT EXISTS responses (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  persona_id TEXT NOT NULL REFERENCES personas(id),
  question_id TEXT NOT NULL REFERENCES questions(id),
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

CREATE TABLE IF NOT EXISTS token_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  prompt_tokens INTEGER NOT NULL,
  completion_tokens INTEGER NOT NULL,
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  ts TEXT NOT NULL DEFAULT (datetime('now'))
);

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
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_responses_run ON responses(run_id);
CREATE INDEX IF NOT EXISTS idx_ledger_run ON token_ledger(run_id);
`
