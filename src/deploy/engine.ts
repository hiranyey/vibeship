import type { CaddyApi } from '../caddy/client.ts';
import { checkCompose, composeRoutedContainer, renderComposeProject } from '../compose/validate.ts';
import type { Db } from '../db/db.ts';
import { pinned } from '../docker/image-ref.ts';
import type { DockerRunner, LineSink } from '../docker/runner.ts';
import type { EnvService } from '../services/env.ts';
import type { ComposeVersionWithYaml, Project, ProjectService } from '../services/projects.ts';
import type { RegistryService } from '../services/registries.ts';
import type { SettingsService } from '../services/settings.ts';
import type { ProjectFiles, RenderedFile } from './files.ts';
import { HEALTH_POLL_MS, HEALTH_STABLE_MS, type HealthTiming, type HttpProbe, healthUrl, waitHealthy } from './health.ts';
import { parseDataOwner } from '../schemas.ts';
import { COMPOSE_FILE, DATA_DIR, ENV_FILE, ENV_FILE_MODE } from './layout.ts';
import type { DeployLogs } from './logs.ts';
import { renderEnvFile, renderImageCompose } from './render.ts';

/** The deploy log line after `data/` was given to its owner; the guide quotes it. */
export const dataOwnerLogLine = (owner: string) => `Data folder owned by ${owner}`;
/** The start of a deploy's failure reason when that failed; the guide quotes it. */
export const dataOwnerFailure = (owner: string) => `could not give ${DATA_DIR}/ to ${owner}`;

export type DeployStatus = 'queued' | 'running' | 'healthy' | 'failed';

type DeployRow = { id: number; project_id: number; trigger: string; digest: string | null; compose_version_id: number | null; actor: string };

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
 * One version of a project that can be put live: an image digest, or a
 * compose version. Deploys and the fail safe both work in these terms, so
 * both kinds of project go through the same steps.
 */
type Release = {
  /** Identifies the version, to tell whether a fallback would just redeploy the failure. */
  key: string;
  /** For logs: the digest, or "compose version 3". */
  label: string;
  files: RenderedFile[];
  /** The container to health check. */
  container: string;
  port: number;
  healthPath: string | null;
  /** Records this release as the project's healthy version. */
  markCurrent: () => void;
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
      const r = db.get<DeployRow>('SELECT id, project_id, trigger, digest, compose_version_id, actor FROM deploys WHERE id = ?', deployId)!;
      db.run(`UPDATE projects SET status = 'deploying' WHERE id = ?`, r.project_id);
      return r;
    });
    if (!row) return 'failed';

    const system = (line: string) => logs.append(deployId, 'system', line);
    const sink: LineSink = (stream, line) => logs.append(deployId, stream, line);

    let project: Project | undefined;
    let previous: Release | null = null;
    let target: Release | null = null;
    const progress = { wroteFiles: false, started: false };
    try {
      project = this.#d.projects.get(row.project_id);
      system(`Deploy #${deployId} of ${project.name} (${row.trigger}, by ${row.actor})`);
      previous = this.current(project);

      if (project.kind === 'image') {
        const { imageRef, registryId } = project.image!;
        const auth = this.#d.registries.authFor(imageRef, registryId);
        const ref = row.digest ? pinned(imageRef, row.digest) : imageRef;
        system(`Pulling ${ref}${auth ? ` as ${auth.username}` : ''}`);
        const digest = await this.#d.docker.pull(ref, auth, sink);
        db.run('UPDATE deploys SET digest = ? WHERE id = ?', digest, deployId);
        system(`Image digest ${digest}`);
        target = this.#imageRelease(project, digest);
        // Before any file is written, so a failure leaves the running version untouched.
        this.#applyDataOwner(project, system);
        this.#write(project, target, system);
        progress.wroteFiles = true;
      } else {
        const version = row.compose_version_id !== null
          ? this.#d.projects.getComposeVersionById(row.compose_version_id)
          : this.#d.projects.getComposeVersion(project.id, project.compose!.version);
        db.run('UPDATE deploys SET compose_version_id = ? WHERE id = ?', version.id, deployId);
        target = this.#composeRelease(project, version);
        // Compose reads the images from the files, so they are written before pulling.
        this.#write(project, target, system);
        progress.wroteFiles = true;
        system('Checking compose.yaml with docker compose config');
        await this.#d.docker.composeConfig(this.#target(project), sink);
        system('Pulling images');
        await this.#d.docker.composePull(this.#target(project), this.#d.registries.allAuths(), sink);
      }

      progress.started = true;
      system(`Starting ${project.name} (${target.label})`);
      await this.#d.docker.composeUp(this.#target(project), sink);
      await this.#health(project, target, system);
      await this.#route(project, target, system);

      db.transaction(() => {
        db.run(`UPDATE deploys SET status = 'healthy', finished_at = ${NOW} WHERE id = ?`, deployId);
        target!.markCurrent();
        db.run(`UPDATE projects SET status = 'running' WHERE id = ?`, row.project_id);
      });
      system(`Deploy #${deployId} is live`);
      return 'healthy';
    } catch (err) {
      const reason = (err as Error).message;
      system(`Deploy failed: ${reason}`);
      const status = await this.#failSafe(project, previous, target, progress, sink, system);
      db.transaction(() => {
        db.run(`UPDATE deploys SET status = 'failed', failure_reason = ?, finished_at = ${NOW} WHERE id = ?`, reason, deployId);
        db.run('UPDATE projects SET status = ? WHERE id = ?', status, row.project_id);
      });
      return 'failed';
    } finally {
      logs.close(deployId);
    }
  }

  /** The project's last healthy version, or null if it never deployed. */
  current(project: Project): Release | null {
    if (project.kind === 'image') {
      const digest = project.image?.currentDigest;
      return digest ? this.#imageRelease(project, digest) : null;
    }
    const id = this.#d.db.get<{ id: number | null }>('SELECT current_compose_version_id AS id FROM projects WHERE id = ?', project.id)?.id;
    return id ? this.#composeRelease(project, this.#d.projects.getComposeVersionById(id)) : null;
  }

  /** The files the project folder should hold for its live version; null before its first healthy deploy. */
  renderCurrent(project: Project): RenderedFile[] | null {
    return this.current(project)?.files ?? null;
  }

  /** The routed container's name, for health checks and logs. */
  static routedContainer(project: Pick<Project, 'kind' | 'name'>): string {
    return project.kind === 'image' ? project.name : composeRoutedContainer(project.name);
  }

  #envFile(project: Project): RenderedFile {
    return { path: ENV_FILE, content: renderEnvFile(this.#d.env.resolve(project.id)), mode: ENV_FILE_MODE };
  }

  #imageRelease(project: Project, digest: string): Release {
    const image = project.image!;
    return {
      key: `digest:${digest}`,
      label: digest,
      files: [
        {
          path: COMPOSE_FILE,
          content: renderImageCompose({ name: project.name, imageRef: image.imageRef, digest, memLimit: image.memLimit, dataOwner: image.dataOwner }),
          mode: 0o644,
        },
        this.#envFile(project),
      ],
      container: project.name,
      port: image.containerPort,
      healthPath: image.healthPath,
      markCurrent: () => this.#d.db.run('UPDATE image_sources SET current_digest = ? WHERE project_id = ?', digest, project.id),
    };
  }

  #composeRelease(project: Project, version: ComposeVersionWithYaml): Release {
    // Checked again on every render, so a version saved under older rules can't slip through.
    const yaml = renderComposeProject(checkCompose(version.composeYaml, version.routedService), project.name);
    return {
      key: `compose:${version.id}`,
      label: `compose version ${version.version}`,
      files: [{ path: COMPOSE_FILE, content: yaml, mode: 0o644 }, this.#envFile(project)],
      container: composeRoutedContainer(project.name),
      port: version.port,
      healthPath: version.healthPath,
      markCurrent: () => this.#d.db.run('UPDATE projects SET current_compose_version_id = ? WHERE id = ?', version.id, project.id),
    };
  }

  /**
   * After a failure, puts things back as they were: rewrites the last healthy
   * version's files if new ones were written, and restarts it if the broken
   * version was started (or stops the broken one when there is nothing to go
   * back to). Returns the project status to record.
   */
  async #failSafe(
    project: Project | undefined,
    previous: Release | null,
    target: Release | null,
    progress: { wroteFiles: boolean; started: boolean },
    sink: LineSink,
    system: (line: string) => void,
  ): Promise<'running' | 'failed'> {
    if (!project) return 'failed';
    try {
      if (!progress.started) {
        if (progress.wroteFiles) {
          // With no earlier version the new files stay: nothing runs from them.
          if (previous) this.#write(project, previous, system);
          system('Nothing was started; the running version, if any, keeps serving');
        } else {
          system('Nothing was changed; the running version, if any, keeps serving');
        }
        return previous ? 'running' : 'failed';
      }
      if (!previous) {
        system('No earlier healthy version to bring back; stopping the broken containers');
        await this.#d.docker.composeDown(this.#target(project), sink);
        return 'failed';
      }
      if (previous.key === target?.key) {
        system('The failed version is the last healthy one, so there is nothing to fall back to');
        return 'failed';
      }
      system(`Bringing back the last healthy version, ${previous.label}`);
      this.#write(project, previous, system);
      await this.#d.docker.composeUp(this.#target(project), sink);
      await this.#health(project, previous, system);
      system('The last healthy version is serving again');
      return 'running';
    } catch (err) {
      system(`Could not bring back the last healthy version: ${(err as Error).message}`);
      return 'failed';
    }
  }

  #target(project: Project) {
    return { project: project.name, dir: this.#d.files.dir(project.name) };
  }

  /** Gives an image project's `data/` to its dataOwner, if it has one. Throws a deploy failure reason. */
  #applyDataOwner(project: Project, system: (line: string) => void): void {
    const owner = project.image?.dataOwner;
    if (!owner) return;
    let result;
    try {
      result = this.#d.files.applyDataOwner(project.name, parseDataOwner(owner));
    } catch (err) {
      throw new Error(`${dataOwnerFailure(owner)}: ${(err as Error).message}`);
    }
    system(`${dataOwnerLogLine(owner)}${result.recursive && result.entries > 0 ? ` (it had another owner, so ${result.entries} existing ${result.entries === 1 ? 'entry was' : 'entries were'} changed too)` : ''}`);
  }

  #write(project: Project, release: Release, system: (line: string) => void): void {
    system('Writing compose.yaml and .env');
    this.#d.files.write(project.id, project.name, release.files);
  }

  async #health(project: Project, release: Release, system: (line: string) => void): Promise<void> {
    const timeoutMs = this.#d.timing?.timeoutMs ?? this.#d.settings.get('health_timeout_seconds') * 1000;
    await waitHealthy({
      docker: this.#d.docker,
      probe: this.#d.probe,
      container: release.container,
      // Vibeship shares the `web` network, so it reaches the app the same way Caddy does.
      url: release.healthPath ? healthUrl(project.name, release.port, release.healthPath) : null,
      timing: { timeoutMs, pollMs: this.#d.timing?.pollMs ?? HEALTH_POLL_MS, stableMs: this.#d.timing?.stableMs ?? HEALTH_STABLE_MS },
      log: system,
    });
  }

  async #route(project: Project, release: Release, system: (line: string) => void): Promise<void> {
    const route = this.#d.db.get<{ id: number }>('SELECT id FROM routes WHERE project_id = ? ORDER BY id LIMIT 1', project.id);
    if (!route) throw new Error(`Project ${project.name} has no route`);
    // A compose version can change the port, so the route follows what is live.
    const upstream = `${project.name}:${release.port}`;
    this.#d.db.run('UPDATE routes SET upstream = ? WHERE id = ?', upstream, route.id);
    try {
      await this.#d.caddy.upsertRoute({ routeId: route.id, hostname: project.hostname, upstream });
      system(`Routing ${project.hostname} to ${upstream}`);
    } catch (err) {
      // The app is healthy; the periodic route sync will retry, so don't fail the deploy.
      system(`Warning: could not update the Caddy route yet: ${(err as Error).message}`);
    }
  }
}
