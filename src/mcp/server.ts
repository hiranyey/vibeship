import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { DeployEngine } from '../deploy/engine.ts';
import { AppError } from '../errors.ts';
import type { Principal } from '../http/auth.ts';
import type { TokenScope } from '../schemas.ts';
import type { Services } from '../services/index.ts';
import type { Project } from '../services/projects.ts';
import { scopeCovers } from '../services/tokens.ts';

const INSTRUCTIONS = `Vibeship deploys apps on one server, each at its own hostname behind Caddy.

Projects are either "image" (a container image from a registry, deployed by digest) or "compose" (a docker compose file you write, checked against an allowlist: no privileged settings, ports only on 127.0.0.1, bind mounts only of ./data).

Typical flow: create_project, set_env if the app needs configuration, then deploy. deploy returns a deploy id at once; follow it with get_deploy_logs (pass afterSeq to read only new lines) until its status is healthy or failed. A failed deploy never stays live: the last healthy version is brought back. To debug, read get_deploy_logs, get_status and get_container_logs, fix the cause (update_project, update_compose or set_env) and deploy again.

Secret env values are write-only: you can set them, but no tool returns them.

For CI-driven deploys of an image project, rotate_webhook (admin) returns a webhook URL once; CI posts the pushed image's digest to it.`;

type Deps = { services: Services; principal: Principal; publicUrl: string };

/** A tool result as pretty JSON text. */
function json(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function error(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

const project = z.string().min(1).describe('Project name (or numeric id)');
const read: ToolAnnotations = { readOnlyHint: true, openWorldHint: false };
const write: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

/**
 * An MCP server for one request, holding only the tools the caller's token
 * may use. Every tool calls the same service layer as the HTTP API, and its
 * changes are audited under the token.
 */
export function createMcpServer({ services: s, principal, publicUrl }: Deps): McpServer {
  const server = new McpServer({ name: 'vibeship', version: '0.1.0' }, { instructions: INSTRUCTIONS });
  const ctx = principal.ctx;

  const find = (ref: string): Project => (/^\d+$/.test(ref) ? s.projects.get(Number(ref)) : s.projects.getByName(ref));

  /** Registers a tool if the token's scope covers it, with errors turned into tool errors. */
  function tool<Shape extends z.ZodRawShape>(
    name: string,
    scope: TokenScope,
    config: { description: string; inputSchema: Shape; annotations: ToolAnnotations },
    run: (args: z.infer<z.ZodObject<Shape>>) => unknown,
  ): void {
    if (!scopeCovers(principal.scope, scope)) return;
    server.registerTool(name, config, (async (args: z.infer<z.ZodObject<Shape>>) => {
      // Listing already hides it; this keeps the check next to the action.
      if (!scopeCovers(principal.scope, scope)) return error(`${name} needs a ${scope} token`);
      try {
        return json(await run(args));
      } catch (err) {
        if (err instanceof AppError) return error(`${err.code}: ${err.message}`);
        console.error(`MCP tool ${name} failed`, err);
        return error('internal error');
      }
    }) as never);
  }

  // Read

  tool('list_projects', 'read', {
    description: 'All projects with their kind, hostname, status and live version.',
    inputSchema: {},
    annotations: read,
  }, () => s.projects.list().map((p) => ({
    id: p.id,
    name: p.name,
    kind: p.kind,
    hostname: p.hostname,
    status: p.status,
    liveVersion: p.kind === 'image' ? p.image?.currentDigest ?? null : p.deployedComposeVersion,
  })));

  tool('get_project', 'read', {
    description: 'A project\'s configuration, route, env vars (secret values are never returned), current version, latest compose file, and any drift between the files on disk and the database.',
    inputSchema: { project },
    annotations: read,
  }, ({ project: ref }) => {
    const p = find(ref);
    return {
      project: p,
      env: s.env.list(p.id),
      composeYaml: p.compose ? s.projects.getComposeVersion(p.id, p.compose.version).composeYaml : undefined,
      drift: s.deploys.drift(p.id),
    };
  });

  tool('list_registries', 'read', {
    description: 'Registry logins for pulling private images: id, name, host, URL, username and whether a token is set (tokens are never returned). An image project uses the registry whose host matches its image; pass registryId to create_project or update_project to pick one explicitly.',
    inputSchema: {},
    annotations: read,
  }, () => s.registries.list());

  tool('get_status', 'read', {
    description: 'Live state from Docker: each of the project\'s containers with its state, plus the last deploy.',
    inputSchema: { project },
    annotations: read,
  }, ({ project: ref }) => s.deploys.status(find(ref).id));

  tool('list_deploys', 'read', {
    description: 'Recent deploys of a project, newest first, with status and failure reason.',
    inputSchema: { project, limit: z.number().int().min(1).max(100).optional().describe('How many, default 10') },
    annotations: read,
  }, ({ project: ref, limit }) => s.deploys.list(find(ref).id, limit ?? 10));

  tool('get_deploy_logs', 'read', {
    description: 'Log lines of one deploy and its current status. Pass afterSeq (the last seq you saw) to get only newer lines; poll until status is healthy or failed.',
    inputSchema: {
      deployId: z.number().int().positive(),
      afterSeq: z.number().int().min(0).optional(),
    },
    annotations: read,
  }, ({ deployId, afterSeq }) => {
    const deploy = s.deploys.get(deployId);
    const lines = s.deploys.logs(deployId, afterSeq ?? 0);
    return {
      deploy,
      finished: deploy.status === 'healthy' || deploy.status === 'failed',
      lines,
      nextAfterSeq: lines.at(-1)?.seq ?? afterSeq ?? 0,
    };
  });

  tool('get_container_logs', 'read', {
    description: 'The tail of a container\'s logs. By default the routed container; for compose projects pass service to read another service.',
    inputSchema: {
      project,
      service: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/).optional().describe('Compose service name'),
      tail: z.number().int().min(1).max(2000).optional().describe('Lines, default 200'),
    },
    annotations: read,
  }, async ({ project: ref, service, tail }) => {
    const p = find(ref);
    let container = DeployEngine.routedContainer(p);
    if (service && p.kind === 'compose' && service !== p.compose?.routedService && service !== p.name) {
      container = `${p.name}-${service}-1`;
    }
    if (!(await s.docker.inspectContainer(container))) throw new AppError('not_found', `No container ${container}; has ${p.name} been deployed?`);
    const lines: Array<{ stream: string; line: string }> = [];
    await s.docker.containerLogs(container, { tail: tail ?? 200, follow: false }, (stream, line) => lines.push({ stream, line }));
    return { container, lines };
  });

  // Deploy

  tool('create_project', 'deploy', {
    description: 'Creates an image or compose project. Image projects need imageRef (without a digest) and containerPort; compose projects need composeYaml, routedService (the service to route to) and port. The hostname defaults to <name>.<base domain>. Nothing runs until you deploy.',
    inputSchema: {
      kind: z.enum(['image', 'compose']),
      name: z.string().describe('Lowercase slug: letters, digits and hyphens, starting with a letter'),
      hostname: z.string().optional(),
      imageRef: z.string().optional().describe('Image projects: e.g. registry.example.com/library/app:latest'),
      containerPort: z.number().int().optional().describe('Image projects: the port the app listens on'),
      registryId: z.number().int().optional().describe('Image projects: a registry id from list_registries; default is the one matching the image host'),
      healthPath: z.string().optional().describe('A path that answers 2xx when the app is healthy, e.g. /health'),
      memLimit: z.string().optional().describe('Image projects: e.g. 512m'),
      composeYaml: z.string().optional().describe('Compose projects: the compose file'),
      routedService: z.string().optional().describe('Compose projects: the service Caddy routes to'),
      port: z.number().int().optional().describe('Compose projects: the routed service\'s port'),
      note: z.string().optional(),
    },
    annotations: write,
  }, (args) => s.projects.create(ctx, defined(args)));

  tool('update_project', 'deploy', {
    description: 'Changes a project\'s hostname, or an image project\'s image, port, health path, registry or memory limit. Takes effect on the next deploy (a hostname change once deployed). Compose files change with update_compose.',
    inputSchema: {
      project,
      hostname: z.string().optional(),
      imageRef: z.string().optional(),
      containerPort: z.number().int().optional(),
      registryId: z.number().int().nullable().optional().describe('A registry id from list_registries, or null to match by image host'),
      healthPath: z.string().nullable().optional(),
      memLimit: z.string().nullable().optional(),
    },
    annotations: write,
  }, ({ project: ref, ...changes }) => s.projects.update(ctx, find(ref).id, defined(changes)));

  tool('update_compose', 'deploy', {
    description: 'Saves a new numbered version of a compose project\'s file, checked against the allowlist. It goes live when you deploy.',
    inputSchema: {
      project,
      composeYaml: z.string(),
      routedService: z.string(),
      port: z.number().int(),
      healthPath: z.string().optional(),
      note: z.string().optional(),
    },
    annotations: write,
  }, ({ project: ref, ...version }) => s.projects.addComposeVersion(ctx, find(ref).id, defined(version)));

  tool('set_env', 'deploy', {
    description: 'Sets and unsets env vars; keys not mentioned are left alone. Mark secrets with secret: true; their values can never be read back. Takes effect on the next deploy.',
    inputSchema: {
      project,
      set: z.record(z.string(), z.object({ value: z.string(), secret: z.boolean().optional() })).optional(),
      unset: z.array(z.string()).optional(),
    },
    annotations: write,
  }, ({ project: ref, set, unset }) => s.env.set(ctx, find(ref).id, defined({ set, unset })));

  tool('deploy', 'deploy', {
    description: 'Queues a deploy and returns its id at once. Image projects deploy the latest image for their tag, or a given digest; compose projects deploy their latest version, or a given composeVersion. Follow progress with get_deploy_logs.',
    inputSchema: {
      project,
      digest: z.string().optional().describe('Image projects: sha256:…'),
      composeVersion: z.number().int().optional().describe('Compose projects: a saved version number'),
    },
    annotations: write,
  }, ({ project: ref, digest, composeVersion }) => {
    const d = s.deploys.request(ctx, find(ref).id, defined({ digest, composeVersion }), 'mcp');
    return { deployId: d.id, status: d.status, next: `Call get_deploy_logs with deployId ${d.id} until it is healthy or failed.` };
  });

  for (const action of ['restart', 'stop', 'start'] as const) {
    tool(action, 'deploy', {
      description: {
        restart: 'Restarts a deployed project\'s containers.',
        stop: 'Stops a deployed project\'s containers; its hostname answers 404 until start.',
        start: 'Starts a stopped project\'s containers again.',
      }[action],
      inputSchema: { project },
      annotations: { ...write, destructiveHint: action === 'stop' },
    }, ({ project: ref }) => s.deploys.lifecycle(ctx, find(ref).id, action));
  }

  // Admin

  tool('delete_project', 'admin', {
    description: 'Removes a project\'s containers, route and database rows. Its data/ folder and named volumes are kept unless deleteData is true.',
    inputSchema: { project, deleteData: z.boolean().optional() },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }, async ({ project: ref, deleteData }) => {
    const p = find(ref);
    await s.deploys.removeProject(ctx, p.id, { deleteData: deleteData ?? false });
    return { deleted: p.name, dataDeleted: deleteData ?? false };
  });

  tool('rotate_webhook', 'admin', {
    description: 'Creates the deploy webhook URL for an image project, or replaces the existing one (the old URL stops working at once). CI posts {"digest": "sha256:..."} to it after pushing the image. The URL is returned only this once; store it as a CI secret.',
    inputSchema: { project },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, ({ project: ref }) => {
    const p = find(ref);
    const replaced = p.hasWebhook;
    const { token, project: updated } = s.projects.rotateWebhook(ctx, p.id);
    return { url: `${publicUrl}/hooks/deploy/${token}`, replaced, project: updated.name };
  });

  return server;
}

/** Drops undefined fields, so the service schemas see only what the agent sent. */
function defined<T extends Record<string, unknown>>(v: T): Partial<T> {
  return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined)) as Partial<T>;
}
