-- What Vibeship last wrote into each project folder, so a hand edit on disk
-- (drift) can be told apart from database changes not yet deployed.
CREATE TABLE rendered_files (
  project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  path       TEXT NOT NULL, -- relative to the project folder
  sha256     TEXT NOT NULL,
  written_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (project_id, path)
) WITHOUT ROWID;
