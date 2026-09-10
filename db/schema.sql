-- db/schema.sql — canonical local SQLite schema, v1 (KIEO-002).
--
-- Conventions:
--   * Timestamps are INTEGER milliseconds since Unix epoch (Date.now()).
--   * IDs are TEXT UUIDs generated in application code.
--   * This file is the readable snapshot. What actually runs on launch is
--     db/migrations/*.sql in version order via db/database.ts runMigrations().
--     Keep the two in sync; db/database.test.ts asserts the migration covers
--     every table declared here.

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool')),
  content TEXT NOT NULL,
  tool_call_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation
  ON messages (conversation_id);

CREATE TABLE IF NOT EXISTS tool_execution_log (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
  tool_name TEXT NOT NULL,
  args_json TEXT NOT NULL,
  classification TEXT NOT NULL CHECK (classification IN ('read_only', 'dangerous')),
  approval_status TEXT NOT NULL CHECK (approval_status IN ('approved', 'denied', 'timeout', 'auto_approved')),
  result_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tool_log_message
  ON tool_execution_log (message_id);

CREATE TABLE IF NOT EXISTS memory_facts (
  id TEXT PRIMARY KEY,
  fact TEXT NOT NULL,
  source_message_id TEXT REFERENCES messages (id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  edited_by_user INTEGER NOT NULL DEFAULT 0 CHECK (edited_by_user IN (0, 1))
);

CREATE TABLE IF NOT EXISTS permissions (
  action_type TEXT PRIMARY KEY,
  level TEXT NOT NULL CHECK (level IN ('always_allow', 'ask_every_time', 'never_allow')),
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
