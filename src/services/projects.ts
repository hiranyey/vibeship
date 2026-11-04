import { actorLabel, type RequestContext } from '../actor.ts';
import { randomToken, sha256Hex } from '../crypto/tokens.ts';
import type { Db } from '../db/db.ts';
import { AppError, notFound } from '../errors.ts';
import { checkCompose, renderComposeProject } from '../compose/validate.ts';
import { COMPOSE_DATA_OWNER_MESSAGE, ComposeVersionFields, CreateProjectInput, RESERVED_NAMES, UpdateProjectInput } from '../schemas.ts';
import type { AuditLog } from './audit.ts';
import { parseInput } from './validate.ts';

export type ProjectKind = 'image' | 'compose';
export type ProjectStatus = 'created' | 'deploying' | 'running' | 'failed' | 'stopped';

export type ImageSource = {
  registryId: number | null;
  imageRef: string;
  containerPort: number;
  healthPath: string | null;
  memLimit: string | null;
  /** "<uid>:<gid>" that owns `data/`, applied on each deploy; null leaves it owned by root. */
  dataOwner: string | null;
  currentDigest: string | null;
};

export type ComposeVersion = {
  id: number;
  version: number;
  routedService: string;
  port: number;
  healthPath: string | null;
  note: string | null;
  createdBy: string;
  createdAt: string;
};

export type Project = {
  id: number;
  name: string;
  kind: ProjectKind;
  hostname: string;
  status: ProjectStatus;
  hasWebhook: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  upstream: string;
  image: ImageSource | null;
  /** The latest saved compose version, for compose projects. */
  compose: ComposeVersion | null;
  /** The compose version that last deployed healthy, for compose projects. */
  deployedComposeVersion: number | null;
};

/** A compose version with its YAML, as the user wrote it. */
export type ComposeVersionWithYaml = ComposeVersion & { composeYaml: string };

type ProjectRow = {
  id: number;
  name: string;
  kind: ProjectKind;
  hostname: string;
  status: ProjectStatus;
  webhook_token_hash: string | null;
  current_compose_version_id: number | null;
  created_by: string;
  created_at: string;
  updated_at: string;
};

type ImageSourceRow = {
  registry_id: number | null;
  image_ref: string;
  container_port: number;
  health_path: string | null;
  mem_limit: string | null;
  data_owner: string | null;
  current_digest: string | null;
};

type ComposeVersionRow = {
  id: number;
  version: number;
  routed_service: string;
  port: number;
  health_path: string | null;
  note: string | null;
  created_by: string;
  created_at: string;
};

const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;

export class ProjectService {
  readonly #db: Db;
  readonly #audit: AuditLog;
  readonly #baseDomain: string;

  constructor(deps: { db: Db; audit: AuditLog; baseDomain: string }) {
    this.#db = deps.db;
    this.#audit = deps.audit;
    this.#baseDomain = deps.baseDomain;
  }

  list(): Project[] {
    return this.#db.all<ProjectRow>('SELECT * FROM projects ORDER BY name').map((r) => this.#hydrate(r));
  }

  get(id: number): Project {
    const row = this.#db.get<ProjectRow>('SELECT * FROM projects WHERE id = ?', id);
    if (!row) throw notFound(`Project ${id}`);
    return this.#hydrate(row);
  }

  getByName(name: string): Project {
    const row = this.#db.get<ProjectRow>('SELECT * FROM projects WHERE name = ?', name);
    if (!row) throw notFound(`Project "${name}"`);
    return this.#hydrate(row);
  }

  create(ctx: RequestContext, rawInput: unknown): Project {
    const input = parseInput(CreateProjectInput, rawInput);
    const hostname = this.#checkHostname(input.hostname ?? `${input.name}.${this.#baseDomain}`);
    const by = actorLabel(ctx.actor);

    return this.#db.transaction(() => {
      if (this.#db.get('SELECT 1 FROM projects WHERE name = ?', input.name)) {
        throw new AppError('conflict', `A project named "${input.name}" already exists`);
      }
      this.#checkHostnameFree(hostname);

      const { lastInsertRowid: id } = this.#db.run(
        'INSERT INTO projects (name, kind, hostname, created_by) VALUES (?, ?, ?, ?)',
        input.name, input.kind, hostname, by,
      );

      let port: number;
      if (input.kind === 'image') {
        if (input.registryId != null) this.#checkRegistry(input.registryId);
        this.#db.run(
          `INSERT INTO image_sources (project_id, registry_id, image_ref, container_port, health_path, mem_limit, data_owner)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          id, input.registryId ?? null, input.imageRef, input.containerPort, input.healthPath ?? null, input.memLimit ?? null, input.dataOwner ?? null,
        );
        port = input.containerPort;
      } else {
        this.#insertComposeVersion(id, input.name, 1, input, by);
        port = input.port;
      }

      this.#db.run(
        'INSERT INTO routes (project_id, hostname, upstream) VALUES (?, ?, ?)',
        id, hostname, upstream(input.name, port),
      );
      this.#audit.record(ctx, 'project.create', `project:${id}`, {
        name: input.name, kind: input.kind, hostname, ...(input.kind === 'image' && input.dataOwner ? { dataOwner: input.dataOwner } : {}),
      });
      return this.get(id);
    });
  }

  update(ctx: RequestContext, id: number, rawInput: unknown): Project {
    const input = parseInput(UpdateProjectInput, rawInput);

    return this.#db.transaction(() => {
      const project = this.get(id);
      const { hostname: newHostname, ...imageFields } = input;
      if (project.kind === 'compose' && imageFields.dataOwner !== undefined) {
        throw new AppError('validation', `dataOwner: ${COMPOSE_DATA_OWNER_MESSAGE}`);
      }
      if (project.kind === 'compose' && Object.keys(imageFields).length > 0) {
        throw new AppError('validation', `Only the hostname of a compose project can be changed here; save a new compose version for the rest`);
      }

      const changes: Record<string, unknown> = {};
      if (newHostname !== undefined && newHostname !== project.hostname) {
        const hostname = this.#checkHostname(newHostname);
        this.#checkHostnameFree(hostname, id);
        this.#db.run('UPDATE projects SET hostname = ? WHERE id = ?', hostname, id);
        changes.hostname = hostname;
      }

      if (project.kind === 'image') {
        if (imageFields.registryId != null) this.#checkRegistry(imageFields.registryId);
        const columns = {
          image_ref: imageFields.imageRef,
          container_port: imageFields.containerPort,
          registry_id: imageFields.registryId,
          health_path: imageFields.healthPath,
          mem_limit: imageFields.memLimit,
          data_owner: imageFields.dataOwner,
        };
        for (const [column, value] of Object.entries(columns)) {
          if (value === undefined) continue;
          // Column names come from the fixed map above, never from input.
          this.#db.run(`UPDATE image_sources SET ${column} = ? WHERE project_id = ?`, value, id);
          changes[column] = value;
        }
      }

      if (Object.keys(changes).length > 0) {
        this.#db.run(`UPDATE projects SET updated_at = ${NOW} WHERE id = ?`, id);
        this.#syncRoute(id);
        this.#audit.record(ctx, 'project.update', `project:${id}`, { name: project.name, changes });
      }
      return this.get(id);
    });
  }

  /**
   * Saves a new numbered compose version after checking it against the
   * allowlist. It goes live on the next deploy.
   */
  addComposeVersion(ctx: RequestContext, id: number, rawInput: unknown): ComposeVersionWithYaml {
    const input = parseInput(ComposeVersionFields, rawInput);
    return this.#db.transaction(() => {
      const project = this.get(id);
      if (project.kind !== 'compose') throw new AppError('validation', 'Only compose projects have compose versions');
      const next = (project.compose?.version ?? 0) + 1;
      this.#insertComposeVersion(id, project.name, next, input, actorLabel(ctx.actor));
      this.#db.run(`UPDATE projects SET updated_at = ${NOW} WHERE id = ?`, id);
      this.#audit.record(ctx, 'compose.version', `project:${id}`, { name: project.name, version: next, routedService: input.routedService, note: input.note ?? null });
      return this.getComposeVersion(id, next);
    });
  }

  /** Newest first, without the YAML. */
  listComposeVersions(id: number): ComposeVersion[] {
    this.get(id);
    return this.#db
      .all<ComposeVersionRow>('SELECT * FROM compose_versions WHERE project_id = ? ORDER BY version DESC', id)
      .map(composeView);
  }

  getComposeVersion(projectId: number, version: number): ComposeVersionWithYaml {
    const row = this.#db.get<ComposeVersionRow & { compose_yaml: string }>(
      'SELECT * FROM compose_versions WHERE project_id = ? AND version = ?', projectId, version,
    );
    if (!row) throw notFound(`Compose version ${version}`);
    return { ...composeView(row), composeYaml: row.compose_yaml };
  }

  getComposeVersionById(id: number): ComposeVersionWithYaml {
    const row = this.#db.get<ComposeVersionRow & { compose_yaml: string }>('SELECT * FROM compose_versions WHERE id = ?', id);
    if (!row) throw notFound(`Compose version #${id}`);
    return { ...composeView(row), composeYaml: row.compose_yaml };
  }

  #insertComposeVersion(projectId: number, projectName: string, version: number, input: ComposeVersionFields, by: string): void {
    // Rendering also checks what only the patch step knows, such as a name clash with the project.
    renderComposeProject(checkCompose(input.composeYaml, input.routedService), projectName);
    this.#db.run(
      `INSERT INTO compose_versions (project_id, version, compose_yaml, routed_service, port, health_path, note, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      projectId, version, input.composeYaml, input.routedService, input.port, input.healthPath ?? null, input.note ?? null, by,
    );
  }

  /**
   * Generates a new webhook token for an image project, replacing any old one
   * so its URL stops working. The token is returned once; only its hash is kept.
   */
  rotateWebhook(ctx: RequestContext, id: number): { token: string; project: Project } {
    const token = randomToken();
    return this.#db.transaction(() => {
      const project = this.get(id);
      if (project.kind !== 'image') {
        throw new AppError('validation', 'Webhooks deploy images pushed by CI, so only image projects have one');
      }
      this.#db.run(`UPDATE projects SET webhook_token_hash = ?, updated_at = ${NOW} WHERE id = ?`, sha256Hex(token), id);
      this.#audit.record(ctx, project.hasWebhook ? 'webhook.rotate' : 'webhook.create', `project:${id}`, { name: project.name });
      return { token, project: this.get(id) };
    });
  }

  /** The project a webhook token belongs to, or null. */
  findByWebhookToken(token: string): Project | null {
    const row = this.#db.get<ProjectRow>('SELECT * FROM projects WHERE webhook_token_hash = ?', sha256Hex(token));
    return row ? this.#hydrate(row) : null;
  }

  /** Removes the project's rows. Callers go through `DeployService.removeProject`, which also stops containers and drops the route. */
  delete(ctx: RequestContext, id: number): void {
    this.#db.transaction(() => {
      const project = this.get(id);
      this.#db.run('DELETE FROM projects WHERE id = ?', id);
      this.#audit.record(ctx, 'project.delete', `project:${id}`, { name: project.name, hostname: project.hostname });
    });
  }

  /** Keeps the project's route row in step with its hostname and port. */
  #syncRoute(id: number): void {
    const p = this.get(id);
    const port = p.image?.containerPort ?? p.compose?.port;
    if (port === undefined) throw new Error(`Project ${id} has no port`);
    this.#db.run('UPDATE routes SET hostname = ?, upstream = ? WHERE project_id = ?', p.hostname, upstream(p.name, port), id);
  }

  /**
   * Hostnames must be one label under the base domain, because the TLS
   * certificate covers `*.<base domain>` only.
   */
  #checkHostname(hostname: string): string {
    const suffix = `.${this.#baseDomain}`;
    const label = hostname.endsWith(suffix) ? hostname.slice(0, -suffix.length) : null;
    if (!label || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) {
      throw new AppError('validation', `hostname must be a single label under ${this.#baseDomain}, like app${suffix}`);
    }
    if ((RESERVED_NAMES as readonly string[]).includes(label)) {
      throw new AppError('validation', `hostname ${hostname} is reserved`);
    }
    return hostname;
  }

  #checkHostnameFree(hostname: string, exceptProjectId?: number): void {
    const taken = this.#db.get<{ project_id: number }>('SELECT project_id FROM routes WHERE hostname = ?', hostname);
    if (taken && taken.project_id !== exceptProjectId) {
      throw new AppError('conflict', `Hostname ${hostname} is already used by another project`);
    }
  }

  #checkRegistry(registryId: number): void {
    if (!this.#db.get('SELECT 1 FROM registries WHERE id = ?', registryId)) {
      throw new AppError('validation', `Registry ${registryId} does not exist`);
    }
  }

  #hydrate(row: ProjectRow): Project {
    const route = this.#db.get<{ upstream: string }>('SELECT upstream FROM routes WHERE project_id = ? ORDER BY id LIMIT 1', row.id);
    const image = row.kind === 'image'
      ? this.#db.get<ImageSourceRow>('SELECT * FROM image_sources WHERE project_id = ?', row.id)
      : undefined;
    const compose = row.kind === 'compose'
      ? this.#db.get<ComposeVersionRow>(
          'SELECT * FROM compose_versions WHERE project_id = ? ORDER BY version DESC LIMIT 1',
          row.id,
        )
      : undefined;

    return {
      id: row.id,
      name: row.name,
      kind: row.kind,
      hostname: row.hostname,
      status: row.status,
      hasWebhook: row.webhook_token_hash !== null,
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      upstream: route?.upstream ?? '',
      image: image
        ? {
            registryId: image.registry_id,
            imageRef: image.image_ref,
            containerPort: image.container_port,
            healthPath: image.health_path,
            memLimit: image.mem_limit,
            dataOwner: image.data_owner,
            currentDigest: image.current_digest,
          }
        : null,
      compose: compose ? composeView(compose) : null,
      deployedComposeVersion: row.current_compose_version_id === null
        ? null
        : this.#db.get<{ version: number }>('SELECT version FROM compose_versions WHERE id = ?', row.current_compose_version_id)?.version ?? null,
    };
  }
}

function composeView(r: ComposeVersionRow): ComposeVersion {
  return {
    id: r.id,
    version: r.version,
    routedService: r.routed_service,
    port: r.port,
    healthPath: r.health_path,
    note: r.note,
    createdBy: r.created_by,
    createdAt: r.created_at,
  };
}

/** Caddy reaches the routed container through its `<project>` alias on `web`. */
function upstream(name: string, port: number): string {
  return `${name}:${port}`;
}
