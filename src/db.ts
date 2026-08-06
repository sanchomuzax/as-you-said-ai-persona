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
  return db
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS personas (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  demographics_json TEXT NOT NULL,
  biography TEXT,
  rendering_style TEXT NOT NULL DEFAULT 'bulleted_profile',
  provenance_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS questionnaires (
  id TEXT PRIMARY KEY,
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
  is_valid INTEGER NOT NULL DEFAULT 1,
  abstained INTEGER NOT NULL DEFAULT 0,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  cost_usd REAL,
  latency_ms INTEGER,
  openrouter_request_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS token_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  prompt_tokens INTEGER NOT NULL,
  completion_tokens INTEGER NOT NULL,
  cost_usd REAL NOT NULL DEFAULT 0,
  ts TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_responses_run ON responses(run_id);
CREATE INDEX IF NOT EXISTS idx_ledger_run ON token_ledger(run_id);
`
