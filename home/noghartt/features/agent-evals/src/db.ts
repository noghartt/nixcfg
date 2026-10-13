import { Database } from "bun:sqlite";
import { chmodSync, existsSync } from "node:fs";
import { dbPath, ensureStateDir } from "./paths.ts";

export const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS files (
  path TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime_ms INTEGER NOT NULL,
  offset INTEGER NOT NULL DEFAULT 0,
  session_id TEXT,
  skipped TEXT,
  ingested_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  path TEXT NOT NULL,
  cwd TEXT,
  title TEXT,
  started_at TEXT,
  ended_at TEXT,
  models TEXT,
  main_model TEXT,
  main_provider TEXT,
  pool_key TEXT,
  thinking TEXT,
  first_user TEXT,
  n_user INTEGER, n_assistant INTEGER, n_tool_calls INTEGER, n_tool_errors INTEGER,
  n_corrections INTEGER, n_interruptions INTEGER, n_retries INTEGER, n_edits INTEGER,
  tokens_in INTEGER, tokens_out INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER,
  cost REAL, duration_ms INTEGER, active_ms INTEGER
);
CREATE TABLE IF NOT EXISTS turns (
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  uid TEXT NOT NULL,
  role TEXT NOT NULL,
  ts TEXT,
  model TEXT, provider TEXT, thinking TEXT,
  text TEXT,
  tool_calls TEXT,
  tool_name TEXT, tool_call_id TEXT,
  is_error INTEGER NOT NULL DEFAULT 0,
  injected INTEGER NOT NULL DEFAULT 0,
  is_correction INTEGER NOT NULL DEFAULT 0,
  is_interruption INTEGER NOT NULL DEFAULT 0,
  is_retry INTEGER NOT NULL DEFAULT 0,
  stop_reason TEXT,
  tokens_in INTEGER, tokens_out INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER,
  duration_ms INTEGER,
  PRIMARY KEY (session_id, seq)
);
CREATE INDEX IF NOT EXISTS turns_uid ON turns(session_id, uid);
CREATE TABLE IF NOT EXISTS outcomes (
  id INTEGER PRIMARY KEY,
  run TEXT NOT NULL, node TEXT NOT NULL, attempt INTEGER NOT NULL, kind TEXT, ts TEXT,
  host TEXT, harness TEXT, task TEXT, criteria TEXT, repo TEXT, placement TEXT,
  model_key TEXT, model_ref TEXT, thinking TEXT, tier INTEGER, pick_note TEXT,
  verdict TEXT, criteria_scores TEXT, duration_ms INTEGER,
  worker_session TEXT, leader_session TEXT,
  UNIQUE (run, node, attempt, verdict, ts)
);
CREATE TABLE IF NOT EXISTS labels (
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  rating TEXT,
  task_class TEXT,
  notes TEXT,
  preferred TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (target_type, target_id)
);
CREATE TABLE IF NOT EXISTS suggestions (
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  source TEXT NOT NULL,
  task_class TEXT NOT NULL,
  confidence REAL,
  reason TEXT,
  model TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (target_type, target_id, source)
);
CREATE TABLE IF NOT EXISTS replays (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  task TEXT NOT NULL,
  harness TEXT NOT NULL,
  model TEXT NOT NULL,
  thinking TEXT,
  placement TEXT NOT NULL,
  base_rev TEXT,
  dir TEXT NOT NULL,
  status TEXT NOT NULL,
  exit_code INTEGER,
  duration_ms INTEGER,
  diff_stat TEXT,
  final_text TEXT,
  session_path TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
`;

export function openDb(path?: string): Database {
	const file = path ?? dbPath(ensureStateDir());
	const fresh = file !== ":memory:" && !existsSync(file);
	const db = new Database(file, { create: true });
	if (fresh) chmodSync(file, 0o600);
	db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
	db.exec(SCHEMA);
	db.query("INSERT OR REPLACE INTO meta(key, value) VALUES ('schema', ?)").run(String(SCHEMA_VERSION));
	return db;
}

export const nowIso = () => new Date().toISOString();
