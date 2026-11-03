import { systemContext } from '../actor.ts';
import type { Db } from '../db/db.ts';
import { pinned } from '../docker/image-ref.ts';
import type { DockerRunner } from '../docker/runner.ts';
import type { AuditLog } from '../services/audit.ts';
import type { ProjectFiles } from './files.ts';

type Interrupted = { id: number; project_id: number; name: string; image_ref: string; current_digest: string | null };

const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;

/**
 * Runs on boot, before the queue starts. A deploy left `running` was cut off
 * by a restart: it is marked failed, and if its project is not serving its
 * last healthy version, a `recovery` deploy is queued to bring that back.
 * The queue runs recovery deploys before the deploys that were waiting.
 */
export async function recoverInterruptedDeploys(deps: {
  db: Db;
  docker: DockerRunner;
  audit: AuditLog;
  files: ProjectFiles;
}): Promise<void> {
  const { db, docker, audit, files } = deps;
  const interrupted = db.all<Interrupted>(
    `SELECT d.id, d.project_id, p.name, i.image_ref, i.current_digest
     FROM deploys d
     JOIN projects p ON p.id = d.project_id
     LEFT JOIN image_sources i ON i.project_id = p.id
     WHERE d.status = 'running'
     ORDER BY d.id`,
  );

  const handled = new Set<number>();
  for (const d of interrupted) {
    db.transaction(() => {
      db.run(`UPDATE deploys SET status = 'failed', failure_reason = 'interrupted by restart', finished_at = ${NOW} WHERE id = ?`, d.id);
      audit.record(systemContext, 'deploy.interrupted', `deploy:${d.id}`, { project: d.name });
    });
    if (handled.has(d.project_id)) continue;
    handled.add(d.project_id);

    // Serving correctly means the container runs the last healthy image and isn't crashing.
    const state = await docker.inspectContainer(d.name).catch(() => null);
    const expected = d.current_digest ? pinned(d.image_ref, d.current_digest) : null;
    const serving = state?.status === 'running' && state.health !== 'unhealthy' && state.image === expected;

    if (serving) {
      db.run(`UPDATE projects SET status = 'running' WHERE id = ?`, d.project_id);
      audit.record(systemContext, 'deploy.recovery_not_needed', `project:${d.project_id}`, { project: d.name });
    } else if (d.current_digest) {
      const { lastInsertRowid } = db.run(
        `INSERT INTO deploys (project_id, trigger, digest, actor) VALUES (?, 'recovery', ?, 'system')`,
        d.project_id, d.current_digest,
      );
      audit.record(systemContext, 'deploy.recovery', `project:${d.project_id}`, {
        project: d.name, deploy: lastInsertRowid, digest: d.current_digest,
      });
    } else {
      // An interrupted first deploy: there is nothing healthy to go back to.
      await docker.composeDown({ project: d.name, dir: files.dir(d.name) }, () => {}).catch(() => {});
      db.run(`UPDATE projects SET status = 'failed' WHERE id = ?`, d.project_id);
      audit.record(systemContext, 'deploy.recovery_stopped', `project:${d.project_id}`, { project: d.name });
    }
  }
}
