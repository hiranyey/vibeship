-- Compose projects: which saved version is live (the image project
-- equivalent is image_sources.current_digest), and an optional health path
-- per version for the routed service.
ALTER TABLE projects ADD COLUMN current_compose_version_id INTEGER REFERENCES compose_versions (id) ON DELETE SET NULL;
ALTER TABLE compose_versions ADD COLUMN health_path TEXT;
