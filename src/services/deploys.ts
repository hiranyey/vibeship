import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { actorLabel, type RequestContext } from '../actor.ts';
import type { CaddyApi } from '../caddy/client.ts';
import type { Db } from '../db/db.ts';
import type { DeployEngine, DeployStatus } from '../deploy/engine.ts';
import type { FileDrift, ProjectFiles } from '../deploy/files.ts';
import type { DeployLogs, LogLine } from '../deploy/logs.ts';
import type { DeployQueue } from '../deploy/queue.ts';
import type { DockerRunner } from '../docker/runner.ts';
import { AppError, notFound } from '../errors.ts';
import { DeployInput } from '../schemas.ts';
import type { AuditLog } from './audit.ts';
import type { ProjectService } from './projects.ts';
import { parseInput } from './validate.ts';

export type DeployTrigger = 'webhook' | 'ui' | 'api' | 'mcp' | 'recovery';

export type Deploy = {
  id: number;
  projectId: number;
  trigger: DeployTrigger;
  digest: string | null;
  composeVersionId: number | null;
  status: DeployStatus;
  failureReason: string | null;
  actor: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

type DeployRow = {
  id: number;
  project_id: number;
  trigger: DeployTrigger;
  digest: string | null;
  compose_version_id: number | null;
  status: DeployStatus;
  failure_reason: string | null;
  actor: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
};

export type DriftReport = {
  /** Files on disk that differ from what Vibeship last wrote: hand edits. */
  files: FileDrift[];
  /** True when env or settings changed in the database since the last deploy. */
  pendingChanges: boolean;
};

export class DeployService {
  readonly #db: Db;
  readonly #audit: AuditLog;
  readonly #projects: ProjectService;
  readonly #engine: DeployEngine;
  readonly #queue: DeployQueue;
  readonly #logs: DeployLogs;
  readonly #files: ProjectFiles;
  readonly #docker: DockerRunner;
  readonly #caddy: CaddyApi;

  constructor(deps: {
    db: Db;
    audit: AuditLog;
    projects: ProjectService;
    engine: DeployEngine;
    queue: DeployQueue;
    logs: DeployLogs;
    files: ProjectFiles;
    docker: DockerRunner;
    caddy: CaddyApi;
  }) {
    this.#db = deps.db;
    this.#audit = deps.audit;
    this.#projects = deps.projects;
    this.#engine = deps.engine;
    this.#queue = deps.queue;
    this.#logs = deps.logs;
    this.#files = deps.files;
    this.#docker = deps.docker;
    this.#caddy = deps.caddy;
  }

  /** Queues a deploy and returns at once; follow it with `get` and `logs`. */
  request(ctx: RequestContext, projectId: number, rawInput: unknown, trigger: Exclude<DeployTrigger, 'recovery'>): Deploy {
    const input = parseInput(DeployInput, rawInput ?? {});
    const deploy = this.#db.transaction(() => {
      const project = this.#projects.get(projectId);
      if (project.kind === 'compose') throw new AppError('validation', 'Compose projects can not be deployed yet');
      if (input.composeVersion) throw new AppError('validation', 'composeVersion only applies to compose projects');
      const { lastInsertRowid: id } = this.#db.run(
        'INSERT INTO deploys (project_id, trigger, digest, actor) VALUES (?, ?, ?, ?)',
        projectId, trigger, input.digest ?? null, actorLabel(ctx.actor),
      );
      this.#audit.record(ctx, 'deploy.request', `deploy:${id}`, { project: project.name, digest: input.digest ?? 'latest', trigger });
      return this.get(id);
    });
    this.#queue.kick(projectId);
    return deploy;
  }

  get(id: number): Deploy {
    const row = this.#db.get<DeployRow>('SELECT * FROM deploys WHERE id = ?', id);
    if (!row) throw notFound(`Deploy ${id}`);
    return view(row);
  }

  list(projectId: number, limit = 20): Deploy[] {
    this.#projects.get(projectId);
    return this.#db
      .all<DeployRow>('SELECT * FROM deploys WHERE project_id = ? ORDER BY id DESC LIMIT ?', projectId, Math.min(Math.max(limit, 1), 200))
      .map(view);
  }

  logs(deployId: number, afterSeq = 0): LogLine[] {
    this.get(deployId);
    return this.#logs.list(deployId, afterSeq);
  }

  drift(projectId: number): DriftReport {
    const project = this.#projects.get(projectId);
    const files = this.#files.drift(project.id, project.name);
    const digest = project.image?.currentDigest;
    return {
      files,
      pendingChanges: digest ? this.#files.pending(project.id, this.#engine.render(project, digest)) : false,
    };
  }

  /** Stops the containers, removes the route and generated files, then the rows. Keeps `data/` unless asked. */
  async removeProject(ctx: RequestContext, projectId: number, opts: { deleteData?: boolean } = {}): Promise<void> {
    const project = this.#projects.get(projectId);
    const active = this.#db.get(`SELECT 1 FROM deploys WHERE project_id = ? AND status IN ('queued', 'running')`, projectId);
    if (active || this.#queue.isBusy(projectId)) {
      throw new AppError('conflict', `${project.name} has a deploy in progress; try again when it finishes`);
    }

    const dir = this.#files.dir(project.name);
    if (existsSync(join(dir, 'compose.yaml'))) {
      await this.#docker.composeDown({ project: project.name, dir }, () => {});
    }
    for (const { id } of this.#db.all<{ id: number }>('SELECT id FROM routes WHERE project_id = ?', projectId)) {
      // If Caddy is unreachable, the route sync drops the route once it is back.
      await this.#caddy.deleteRoute(id).catch(() => {});
    }
    this.#files.remove(project.name, { deleteData: opts.deleteData ?? false });
    this.#projects.delete(ctx, projectId);
  }
}

function view(r: DeployRow): Deploy {
  return {
    id: r.id,
    projectId: r.project_id,
    trigger: r.trigger,
    digest: r.digest,
    composeVersionId: r.compose_version_id,
    status: r.status,
    failureReason: r.failure_reason,
    actor: r.actor,
    createdAt: r.created_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  };
}
