import type { CaddyApi } from '../caddy/client.ts';
import type { Db } from '../db/db.ts';
import { pinned } from '../docker/image-ref.ts';
import type { DockerRunner, LineSink } from '../docker/runner.ts';
import type { EnvService } from '../services/env.ts';
import type { Project, ProjectService } from '../services/projects.ts';
import type { RegistryService } from '../services/registries.ts';
import type { SettingsService } from '../services/settings.ts';
import type { ProjectFiles, RenderedFile } from './files.ts';
import { type HealthTiming, type HttpProbe, waitHealthy } from './health.ts';
import type { DeployLogs } from './logs.ts';
import { renderEnvFile, renderImageCompose } from './render.ts';

export type DeployStatus = 'queued' | 'running' | 'healthy' | 'failed';

type DeployRow = { id: number; project_id: number; trigger: string; digest: string | null; actor: string };

const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;

export type EngineDeps = {
  db: Db;
  projects: ProjectService;
  env: EnvService;
  registries: RegistryService;
  settings: SettingsService;
  logs: DeployLogs;
  files: ProjectFiles;
  docker: DockerRunner;
  caddy: CaddyApi;
  probe: HttpProbe;
  /** Overrides for tests; the timeout normally comes from settings. */
  timing?: Partial<HealthTiming>;
};

/**
 * Runs one deploy: pull, render, start, health check, route. On failure it
 * brings back the last healthy version. It never throws; the outcome is
 * recorded on the deploy row and in its logs.
 */
export class DeployEngine {
  readonly #d: EngineDeps;

  constructor(deps: EngineDeps) {
    this.#d = deps;
  }

  async run(deployId: number): Promise<DeployStatus> {
    const { db, logs } = this.#d;
    // Claim the deploy atomically, so it runs once even if two processes see it queued.
    const row = db.transaction(() => {
      const claimed = db.run(`UPDATE deploys SET status = 'running', started_at = ${NOW} WHERE id = ? AND status = 'queued'`, deployId);
      if (claimed.changes !== 1) return undefined;
      const r = db.get<DeployRow>('SELECT id, project_id, trigger, digest, actor FROM deploys WHERE id = ?', deployId)!;
      db.run(`UPDATE projects SET status = 'deploying' WHERE id = ?`, r.project_id);
      return r;
    });
    if (!row) return 'failed';

    const system = (line: string) => logs.append(deployId, 'system', line);
    const sink: LineSink = (stream, line) => logs.append(deployId, stream, line);

    let project: Project | undefined;
    let previous: string | null = null;
    let touched = false;
    try {
      project = this.#d.projects.get(row.project_id);
      system(`Deploy #${deployId} of ${project.name} (${row.trigger}, by ${row.actor})`);
      if (project.kind !== 'image' || !project.image) throw new Error('Compose projects can not be deployed yet');
      previous = project.image.currentDigest;

      const { imageRef, registryId } = project.image;
      const auth = this.#d.registries.authFor(imageRef, registryId);
      const ref = row.digest ? pinned(imageRef, row.digest) : imageRef;
      system(`Pulling ${ref}${auth ? ` as ${auth.username}` : ''}`);
      const digest = await this.#d.docker.pull(ref, auth, sink);
      db.run('UPDATE deploys SET digest = ? WHERE id = ?', digest, deployId);
      system(`Image digest ${digest}`);

      touched = true;
      await this.#start(project, digest, sink, system);
      await this.#health(project, system);
      await this.#route(project, system);

      db.transaction(() => {
        db.run(`UPDATE deploys SET status = 'healthy', finished_at = ${NOW} WHERE id = ?`, deployId);
        db.run('UPDATE image_sources SET current_digest = ? WHERE project_id = ?', digest, row.project_id);
        db.run(`UPDATE projects SET status = 'running' WHERE id = ?`, row.project_id);
      });
      system(`Deploy #${deployId} is live`);
      return 'healthy';
    } catch (err) {
      const reason = (err as Error).message;
      system(`Deploy failed: ${reason}`);
      const status = await this.#failSafe(project, previous, touched, row.digest, sink, system);
      db.transaction(() => {
        db.run(`UPDATE deploys SET status = 'failed', failure_reason = ?, finished_at = ${NOW} WHERE id = ?`, reason, deployId);
        db.run('UPDATE projects SET status = ? WHERE id = ?', status, row.project_id);
      });
      return 'failed';
    } finally {
      logs.close(deployId);
    }
  }

  /**
   * After a failure: if anything was changed, bring back the last healthy
   * version, or stop the broken container when there is none. Returns the
   * project status to record.
   */
  async #failSafe(
    project: Project | undefined,
    previous: string | null,
    touched: boolean,
    target: string | null,
    sink: LineSink,
    system: (line: string) => void,
  ): Promise<'running' | 'failed'> {
    if (!project) return 'failed';
    if (!touched) {
      system('Nothing was changed; the running version, if any, keeps serving');
      return previous ? 'running' : 'failed';
    }
    try {
      if (!previous) {
        system('No earlier healthy version to bring back; stopping the broken container');
        await this.#d.docker.composeDown(this.#target(project), sink);
        return 'failed';
      }
      if (previous === target) {
        system('The failed version is the last healthy one, so there is nothing to fall back to');
        return 'failed';
      }
      system(`Bringing back the last healthy version ${previous}`);
      await this.#start(project, previous, sink, system);
      await this.#health(project, system);
      system('The last healthy version is serving again');
      return 'running';
    } catch (err) {
      system(`Could not bring back the last healthy version: ${(err as Error).message}`);
      return 'failed';
    }
  }

  /** The files this project's folder should hold for `digest`. */
  render(project: Project, digest: string): RenderedFile[] {
    if (!project.image) throw new Error(`Project ${project.name} has no image source`);
    return [
      {
        path: 'compose.yaml',
        content: renderImageCompose({ name: project.name, imageRef: project.image.imageRef, digest, memLimit: project.image.memLimit }),
        mode: 0o644,
      },
      { path: '.env', content: renderEnvFile(this.#d.env.resolve(project.id)), mode: 0o600 },
    ];
  }

  #target(project: Project) {
    return { project: project.name, dir: this.#d.files.dir(project.name) };
  }

  async #start(project: Project, digest: string, sink: LineSink, system: (line: string) => void): Promise<void> {
    system('Writing compose.yaml and .env');
    this.#d.files.write(project.id, project.name, this.render(project, digest));
    system(`Starting ${project.name}`);
    await this.#d.docker.composeUp(this.#target(project), sink);
  }

  async #health(project: Project, system: (line: string) => void): Promise<void> {
    const { healthPath, containerPort } = project.image!;
    const timeoutMs = this.#d.timing?.timeoutMs ?? this.#d.settings.get('health_timeout_seconds') * 1000;
    await waitHealthy({
      docker: this.#d.docker,
      probe: this.#d.probe,
      container: project.name,
      // Vibeship shares the `web` network, so it reaches the app the same way Caddy does.
      url: healthPath ? `http://${project.name}:${containerPort}${healthPath}` : null,
      timing: { timeoutMs, pollMs: this.#d.timing?.pollMs ?? 1000, stableMs: this.#d.timing?.stableMs ?? 5000 },
      log: system,
    });
  }

  async #route(project: Project, system: (line: string) => void): Promise<void> {
    const route = this.#d.db.get<{ id: number }>('SELECT id FROM routes WHERE project_id = ? ORDER BY id LIMIT 1', project.id);
    if (!route) throw new Error(`Project ${project.name} has no route`);
    try {
      await this.#d.caddy.upsertRoute({ routeId: route.id, hostname: project.hostname, upstream: project.upstream });
      system(`Routing ${project.hostname} to ${project.upstream}`);
    } catch (err) {
      // The app is healthy; the periodic route sync will retry, so don't fail the deploy.
      system(`Warning: could not update the Caddy route yet: ${(err as Error).message}`);
    }
  }
}
