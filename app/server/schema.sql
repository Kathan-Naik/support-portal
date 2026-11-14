PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS customers (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  business_type    TEXT NOT NULL,
  timezone         TEXT NOT NULL,
  booking_system   TEXT NOT NULL,
  integration      TEXT NOT NULL,
  business_hours   TEXT NOT NULL,
  staff_json       TEXT NOT NULL,
  go_live          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  email          TEXT NOT NULL UNIQUE,
  name           TEXT NOT NULL,
  title          TEXT,
  role           TEXT NOT NULL CHECK (role IN ('admin', 'client')),
  customer_id    TEXT REFERENCES customers(id),
  password_hash  TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  CHECK ((role = 'admin' AND customer_id IS NULL) OR (role = 'client' AND customer_id IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  TEXT NOT NULL
);

-- One row per call record as ingested, plus fields derived at seed time.
CREATE TABLE IF NOT EXISTS calls (
  call_id             TEXT PRIMARY KEY,
  telephony_sid       TEXT NOT NULL,
  customer_id         TEXT NOT NULL REFERENCES customers(id),
  direction           TEXT NOT NULL,
  started_at          TEXT NOT NULL,
  started_local       TEXT NOT NULL,
  duration_sec        INTEGER NOT NULL,
  caller_name         TEXT,
  caller_phone_last4  TEXT,
  intent_tag          TEXT,
  outcome             TEXT NOT NULL,
  transferred         INTEGER NOT NULL,
  appointment_id      TEXT,
  transcript          TEXT NOT NULL,
  ingested_at         TEXT NOT NULL,
  ingest_lag_sec      INTEGER NOT NULL,
  is_duplicate        INTEGER NOT NULL DEFAULT 0,
  duplicate_of        TEXT,
  write_op            TEXT,
  write_status        TEXT NOT NULL DEFAULT 'none' CHECK (write_status IN ('none', 'written', 'failed', 'unknown')),
  write_http          TEXT,
  write_attempts      INTEGER NOT NULL DEFAULT 0,
  external_id         TEXT,
  said_not_written    INTEGER NOT NULL DEFAULT 0,
  intent_mismatch     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_calls_customer ON calls(customer_id, started_at);
CREATE INDEX IF NOT EXISTS idx_calls_sid ON calls(telephony_sid);
CREATE INDEX IF NOT EXISTS idx_calls_appt ON calls(appointment_id);

-- One row per integration.log line, key=value pairs promoted to columns.
CREATE TABLE IF NOT EXISTS log_events (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  ts                 TEXT NOT NULL,
  level              TEXT NOT NULL,
  service            TEXT NOT NULL,
  customer_id        TEXT,
  op                 TEXT,
  event              TEXT,
  appointment_id     TEXT,
  status             TEXT,
  error              TEXT,
  error_description  TEXT,
  attempt            INTEGER,
  final              INTEGER NOT NULL DEFAULT 0,
  action             TEXT,
  latency_ms         INTEGER,
  external_id        TEXT,
  sid                TEXT,
  fields_json        TEXT NOT NULL,
  raw                TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_logs_ts ON log_events(ts);
CREATE INDEX IF NOT EXISTS idx_logs_customer ON log_events(customer_id, service, ts);
CREATE INDEX IF NOT EXISTS idx_logs_appt ON log_events(appointment_id);



-- A ticket is one problem being worked: a client's request, or something support or the debug bot found.
-- customer_id NULL = internal ticket (no client ever sees it). Alerts link here through flags.ticket_id.
CREATE TABLE IF NOT EXISTS tickets (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  key          TEXT NOT NULL UNIQUE,
  customer_id  TEXT REFERENCES customers(id),
  created_by   INTEGER NOT NULL REFERENCES users(id),
  origin       TEXT NOT NULL DEFAULT 'portal' CHECK (origin IN ('portal', 'bot')),
  assignee_id  INTEGER REFERENCES users(id),
  subject      TEXT NOT NULL,
  category     TEXT NOT NULL DEFAULT 'general',
  status       TEXT NOT NULL CHECK (status IN ('open', 'pending', 'resolved', 'closed')),
  priority     TEXT NOT NULL CHECK (priority IN ('urgent', 'high', 'normal', 'low')),
  -- What the reporter gave as evidence: { started_at, examples: [{ caller, phone_last4, when, what }] }
  evidence_json TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

-- Flags are produced by the detectors in server/detect.ts.
CREATE TABLE IF NOT EXISTS flags (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  rule           TEXT NOT NULL,
  severity       TEXT NOT NULL CHECK (severity IN ('critical', 'high', 'medium', 'low')),
  customer_id    TEXT REFERENCES customers(id),
  title          TEXT NOT NULL,
  summary        TEXT NOT NULL,
  analysis       TEXT NOT NULL,
  recommendation TEXT NOT NULL,
  evidence_json  TEXT NOT NULL,
  count          INTEGER NOT NULL,
  first_seen     TEXT NOT NULL,
  last_seen      TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved')),
  ticket_id      INTEGER REFERENCES tickets(id) ON DELETE SET NULL,  -- the ticket handling this alert
  created_at     TEXT NOT NULL,
  UNIQUE (rule, customer_id)
);

-- Every message to or from a client lives on a ticket. Support writing to a client first opens a ticket.
--   internal = 1           note for staff only, never returned to a client
--   status   = 'draft'     a reply waiting for an admin to send it (admins or the debug bot write drafts)
--   read_at                when the client first saw a sent support reply
CREATE TABLE IF NOT EXISTS ticket_messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id   INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  author_id   INTEGER REFERENCES users(id),
  author_kind TEXT NOT NULL DEFAULT 'user' CHECK (author_kind IN ('user', 'bot')),
  body        TEXT NOT NULL,
  internal    INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('draft', 'sent')),
  created_at  TEXT NOT NULL,
  read_at     TEXT,
  CHECK (NOT (internal = 1 AND status = 'draft'))
);
CREATE INDEX IF NOT EXISTS idx_ticket_messages_ticket ON ticket_messages(ticket_id, created_at);

-- Files attached to a ticket message (screenshots, exports). Stored under data/uploads; visible to whoever can see the message.
CREATE TABLE IF NOT EXISTS ticket_attachments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id  INTEGER NOT NULL REFERENCES ticket_messages(id) ON DELETE CASCADE,
  filename    TEXT NOT NULL,
  mime        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  stored_as   TEXT NOT NULL UNIQUE,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ticket_attachments_message ON ticket_attachments(message_id);

CREATE TABLE IF NOT EXISTS bot_sessions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  ticket_id   INTEGER REFERENCES tickets(id) ON DELETE SET NULL,  -- set when the investigation was started from a ticket
  title       TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- Pi AgentMessage objects, stored verbatim so a session can be resumed.
CREATE TABLE IF NOT EXISTS bot_messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  INTEGER NOT NULL REFERENCES bot_sessions(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  message_json TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  actor       TEXT NOT NULL,
  action      TEXT NOT NULL,
  target      TEXT,
  detail      TEXT,
  created_at  TEXT NOT NULL
);
