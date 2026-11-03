-- Initial schema. Timestamps are ISO 8601 UTC text. Actor columns hold
-- 'user:<id>', 'token:<id>' or 'system' (see src/actor.ts).

CREATE TABLE users (
  id            INTEGER PRIMARY KEY,
  oidc_sub      TEXT NOT NULL UNIQUE,
  email         TEXT NOT NULL,
  name          TEXT,
  role          TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('admin')),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_login_at TEXT
);

CREATE TABLE sessions (
  id         TEXT PRIMARY KEY, -- SHA-256 hex of the cookie value
  user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at TEXT NOT NULL,
  ip         TEXT,
  user_agent TEXT
);
CREATE INDEX sessions_expires_at ON sessions (expires_at);

CREATE TABLE api_tokens (
  id           INTEGER PRIMARY KEY,
  name         TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE, -- SHA-256 hex
  scope        TEXT NOT NULL CHECK (scope IN ('read', 'deploy', 'admin')),
  project_ids  TEXT, -- JSON array; unused until per-project allowlists
  created_by   INTEGER REFERENCES users (id) ON DELETE SET NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_used_at TEXT,
  expires_at   TEXT,
  revoked_at   TEXT
);

CREATE TABLE registries (
  id              INTEGER PRIMARY KEY,
  name            TEXT NOT NULL UNIQUE,
  url             TEXT NOT NULL,
  username        TEXT,
  token_encrypted TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE projects (
  id                 INTEGER PRIMARY KEY,
  name               TEXT NOT NULL UNIQUE, -- slug: folder, compose project and network alias
  kind               TEXT NOT NULL CHECK (kind IN ('image', 'compose')),
  hostname           TEXT NOT NULL UNIQUE,
  status             TEXT NOT NULL DEFAULT 'created'
                       CHECK (status IN ('created', 'deploying', 'running', 'failed', 'stopped')),
  webhook_token_hash TEXT UNIQUE, -- SHA-256 hex
  created_by         TEXT NOT NULL,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE image_sources (
  project_id     INTEGER PRIMARY KEY REFERENCES projects (id) ON DELETE CASCADE,
  registry_id    INTEGER REFERENCES registries (id) ON DELETE RESTRICT,
  image_ref      TEXT NOT NULL,
  container_port INTEGER NOT NULL CHECK (container_port BETWEEN 1 AND 65535),
  health_path    TEXT,
  mem_limit      TEXT,
  current_digest TEXT
);

CREATE TABLE compose_versions (
  id             INTEGER PRIMARY KEY,
  project_id     INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  version        INTEGER NOT NULL,
  compose_yaml   TEXT NOT NULL,
  routed_service TEXT NOT NULL,
  port           INTEGER NOT NULL CHECK (port BETWEEN 1 AND 65535),
  note           TEXT,
  created_by     TEXT NOT NULL,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (project_id, version)
);

CREATE TABLE routes (
  id         INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  hostname   TEXT NOT NULL UNIQUE,
  upstream   TEXT NOT NULL, -- '<project>:<port>'
  options    TEXT NOT NULL DEFAULT '{}' -- JSON
);

CREATE TABLE env_vars (
  project_id      INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  key             TEXT NOT NULL,
  value_encrypted TEXT NOT NULL,
  is_secret       INTEGER NOT NULL DEFAULT 0 CHECK (is_secret IN (0, 1)),
  updated_by      TEXT NOT NULL,
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (project_id, key)
) WITHOUT ROWID;

CREATE TABLE deploys (
  id                 INTEGER PRIMARY KEY,
  project_id         INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  trigger            TEXT NOT NULL CHECK (trigger IN ('webhook', 'ui', 'api', 'mcp', 'recovery')),
  digest             TEXT,
  compose_version_id INTEGER REFERENCES compose_versions (id) ON DELETE SET NULL,
  status             TEXT NOT NULL DEFAULT 'queued'
                       CHECK (status IN ('queued', 'running', 'healthy', 'failed')),
  failure_reason     TEXT,
  actor              TEXT NOT NULL,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  started_at         TEXT,
  finished_at        TEXT
);
CREATE INDEX deploys_project ON deploys (project_id, id DESC);
CREATE INDEX deploys_status ON deploys (status) WHERE status IN ('queued', 'running');

CREATE TABLE deploy_logs (
  deploy_id INTEGER NOT NULL REFERENCES deploys (id) ON DELETE CASCADE,
  seq       INTEGER NOT NULL,
  ts        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  stream    TEXT NOT NULL CHECK (stream IN ('stdout', 'stderr', 'system')),
  line      TEXT NOT NULL,
  PRIMARY KEY (deploy_id, seq)
) WITHOUT ROWID;

CREATE TABLE audit_log (
  id         INTEGER PRIMARY KEY,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'token', 'system')),
  user_id    INTEGER REFERENCES users (id) ON DELETE SET NULL,
  token_id   INTEGER REFERENCES api_tokens (id) ON DELETE SET NULL,
  action     TEXT NOT NULL,
  target     TEXT,
  details    TEXT NOT NULL DEFAULT '{}', -- JSON, never contains secret values
  ip         TEXT,
  ts         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX audit_log_ts ON audit_log (ts DESC);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;

INSERT INTO settings (key, value) VALUES ('health_timeout_seconds', '60');
