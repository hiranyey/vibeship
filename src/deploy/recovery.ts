import { systemContext } from '../actor.ts';
import type { Db } from '../db/db.ts';
import { pinned } from '../docker/image-ref.ts';
import type { DockerRunner } from '../docker/runner.ts';
import type { AuditLog } from '../services/audit.ts';
import type { ProjectFiles } from './files.ts';

type Interrupted = {
  id: number;
  project_id: number;
  name: string;
  kind: 'image' | 'compose';
  image_ref: string | null;
  current_digest: string | null;
  current_compose_version_id: number | null;
};

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
    `SELECT d.id, d.project_id, p.name, p.kind, i.image_ref, i.current_digest, p.current_compose_version_id
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
    // A compose project's services can't be checked that precisely, so it is always redeployed.
    let serving = false;
    if (d.kind === 'image' && d.current_digest && d.image_ref) {
      const state = await docker.inspectContainer(d.name).catch(() => null);
      serving = state?.status === 'running' && state.health !== 'unhealthy' && state.image === pinned(d.image_ref, d.current_digest);
    }

    if (serving) {
      db.run(`UPDATE projects SET status = 'running' WHERE id = ?`, d.project_id);
      audit.record(systemContext, 'deploy.recovery_not_needed', `project:${d.project_id}`, { project: d.name });
    } else if (d.current_digest || d.current_compose_version_id) {
      const { lastInsertRowid } = db.run(
        `INSERT INTO deploys (project_id, trigger, digest, compose_version_id, actor) VALUES (?, 'recovery', ?, ?, 'system')`,
        d.project_id, d.current_digest, d.current_compose_version_id,
      );
      audit.record(systemContext, 'deploy.recovery', `project:${d.project_id}`, {
        project: d.name,
        deploy: lastInsertRowid,
        ...(d.kind === 'image' ? { digest: d.current_digest } : { composeVersionId: d.current_compose_version_id }),
      });
    } else {
      // An interrupted first deploy: there is nothing healthy to go back to.
      await docker.composeDown({ project: d.name, dir: files.dir(d.name) }, () => {}).catch(() => {});
      db.run(`UPDATE projects SET status = 'failed' WHERE id = ?`, d.project_id);
      audit.record(systemContext, 'deploy.recovery_stopped', `project:${d.project_id}`, { project: d.name });
    }
  }
}
