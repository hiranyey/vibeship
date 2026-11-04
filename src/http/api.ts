import { type Context, Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import type { Config } from '../config.ts';
import { DeployEngine } from '../deploy/engine.ts';
import type { LineSink } from '../docker/runner.ts';
import { AppError } from '../errors.ts';
import type { DeployTrigger } from '../services/deploys.ts';
import type { Services } from '../services/index.ts';
import type { Project } from '../services/projects.ts';
import type { SettingKey } from '../services/settings.ts';
import { parseInput } from '../services/validate.ts';
import { type AppEnv, principal, requireScope } from './auth.ts';

const POLL_MS = 500;
const HEARTBEAT_MS = 15_000;

const read = requireScope('read');
const deploy = requireScope('deploy');
const admin = requireScope('admin');

async function body(c: Context): Promise<unknown> {
  if (!c.req.header('content-type')?.includes('application/json')) {
    throw new AppError('validation', 'Send the request body as JSON with Content-Type: application/json');
  }
  try {
    return await c.req.json();
  } catch {
    throw new AppError('validation', 'The request body is not valid JSON');
  }
}

function intParam(value: string | undefined, what: string): number {
  if (!value || !/^\d{1,15}$/.test(value)) throw new AppError('not_found', `${what} not found`);
  return Number(value);
}

const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional(),
  before: z.coerce.number().int().positive().optional(),
});

const LogsQuery = z.object({
  tail: z.coerce.number().int().min(0).max(10_000).default(200),
  follow: z.enum(['true', 'false', '1', '0']).optional(),
});

const wantsStream = (c: Context) => c.req.header('accept')?.includes('text/event-stream') ?? false;

/**
 * The HTTP API under `/api`. Every route checks the caller's scope and calls
 * the same service layer as the UI and MCP. Projects can be addressed by id
 * or by name.
 */
export function apiRoutes(deps: { config: Config; services: Services }): Hono<AppEnv> {
  const s = deps.services;
  const app = new Hono<AppEnv>();

  const project = (c: Context): Project => {
    const ref = c.req.param('id') ?? '';
    return /^\d+$/.test(ref) ? s.projects.get(Number(ref)) : s.projects.getByName(ref);
  };
  const trigger = (c: Context<AppEnv>): Exclude<DeployTrigger, 'recovery'> => (principal(c).kind === 'user' ? 'ui' : 'api');

  app.get('/me', read, (c) => {
    const p = principal(c);
    return c.json(p.kind === 'user' ? { kind: 'user', scope: p.scope, user: p.user } : { kind: 'token', scope: p.scope, token: p.token });
  });

  // Projects
  app.get('/projects', read, (c) => c.json(s.projects.list()));
  app.post('/projects', deploy, async (c) => c.json(s.projects.create(principal(c).ctx, await body(c)), 201));
  app.get('/projects/:id', read, (c) => c.json(project(c)));
  app.patch('/projects/:id', deploy, async (c) => c.json(s.projects.update(principal(c).ctx, project(c).id, await body(c))));
  app.delete('/projects/:id', admin, async (c) => {
    const p = project(c);
    const deleteData = ['true', '1'].includes(c.req.query('deleteData') ?? '');
    await s.deploys.removeProject(principal(c).ctx, p.id, { deleteData });
    return c.json({ deleted: p.name, dataDeleted: deleteData });
  });

  app.get('/projects/:id/env', read, (c) => c.json(s.env.list(project(c).id)));
  app.put('/projects/:id/env', deploy, async (c) => c.json(s.env.replace(principal(c).ctx, project(c).id, await body(c))));

  // Compose versions: saving one checks it against the allowlist; it goes live on the next deploy.
  app.get('/projects/:id/compose', read, (c) => c.json(s.projects.listComposeVersions(project(c).id)));
  app.post('/projects/:id/compose', deploy, async (c) =>
    c.json(s.projects.addComposeVersion(principal(c).ctx, project(c).id, await body(c)), 201));
  app.get('/projects/:id/compose/:version', read, (c) =>
    c.json(s.projects.getComposeVersion(project(c).id, intParam(c.req.param('version'), 'Compose version'))));

  app.get('/projects/:id/deploys', read, (c) => {
    const { limit } = parseInput(ListQuery, c.req.query());
    return c.json(s.deploys.list(project(c).id, limit ?? 20));
  });
  app.post('/projects/:id/deploy', deploy, async (c) => {
    const raw = c.req.header('content-length') === '0' || !c.req.header('content-type') ? {} : await body(c);
    return c.json(s.deploys.request(principal(c).ctx, project(c).id, raw, trigger(c)), 202);
  });
  app.get('/projects/:id/drift', read, (c) => c.json(s.deploys.drift(project(c).id)));
  app.get('/projects/:id/status', read, async (c) => c.json(await s.deploys.status(project(c).id)));
  app.get('/projects/:id/metrics', read, async (c) => c.json(await s.metrics.project(project(c).id)));
  app.get('/metrics', read, async (c) => c.json(await s.metrics.overview()));
  for (const action of ['stop', 'start', 'restart'] as const) {
    app.post(`/projects/:id/${action}`, deploy, async (c) => c.json(await s.deploys.lifecycle(principal(c).ctx, project(c).id, action)));
  }

  app.post('/projects/:id/webhook', admin, (c) => {
    const { token, project: p } = s.projects.rotateWebhook(principal(c).ctx, project(c).id);
    return c.json({ url: `${deps.config.publicUrl}/hooks/deploy/${token}`, project: p }, 201);
  });

  // Logs of the routed container: the last `tail` lines as JSON, or a live stream with `Accept: text/event-stream`.
  app.get('/projects/:id/logs', read, async (c) => {
    const p = project(c);
    const q = parseInput(LogsQuery, c.req.query());
    const container = DeployEngine.routedContainer(p);
    if (!(await s.docker.inspectContainer(container))) throw new AppError('not_found', `${p.name} has no container; deploy it first`);

    if (!wantsStream(c)) {
      const lines: Array<{ stream: string; line: string }> = [];
      await s.docker.containerLogs(container, { tail: q.tail, follow: false }, (stream, line) => lines.push({ stream, line }));
      return c.json(lines);
    }

    const follow = q.follow === undefined || q.follow === 'true' || q.follow === '1';
    return streamSSE(c, async (stream) => {
      const abort = new AbortController();
      stream.onAbort(() => abort.abort());
      // Lines arrive from a child process; write them in order without blocking it.
      let pending = Promise.resolve();
      const sink: LineSink = (kind, line) => {
        pending = pending
          .then(() => stream.writeSSE({ event: 'log', data: JSON.stringify({ stream: kind, line }) }))
          .catch(() => abort.abort()); // the client went away
      };
      const heartbeat = setInterval(() => {
        pending = pending.then(() => stream.write(': ping\n\n')).then(() => {}, () => abort.abort());
      }, HEARTBEAT_MS);
      try {
        await s.docker.containerLogs(container, { tail: q.tail, follow, signal: abort.signal }, sink);
        await pending;
        if (!abort.signal.aborted) await stream.writeSSE({ event: 'end', data: '{}' });
      } catch (err) {
        await pending;
        await stream.writeSSE({ event: 'error', data: JSON.stringify({ message: (err as Error).message }) });
      } finally {
        clearInterval(heartbeat);
      }
    });
  });

  // Deploys
  app.get('/deploys/:id', read, (c) => c.json(s.deploys.get(intParam(c.req.param('id'), 'Deploy'))));

  // Deploy logs: JSON lines after `after`, or a stream with `Accept: text/event-stream`
  // that sends each line as a `log` event (id = seq) and ends with a `done` event.
  app.get('/deploys/:id/logs', read, (c) => {
    const id = intParam(c.req.param('id'), 'Deploy');
    s.deploys.get(id);
    const lastEventId = c.req.header('last-event-id');
    const after = Number(lastEventId ?? c.req.query('after') ?? 0) || 0;
    if (!wantsStream(c)) return c.json(s.deploys.logs(id, after));

    return streamSSE(c, async (stream) => {
      let seq = after;
      let quietSince = Date.now();
      while (!stream.aborted) {
        const lines = s.deploys.logs(id, seq);
        for (const l of lines) {
          await stream.writeSSE({ event: 'log', id: String(l.seq), data: JSON.stringify(l) });
          seq = l.seq;
        }
        if (lines.length > 0) {
          quietSince = Date.now();
          continue;
        }
        const d = s.deploys.get(id);
        if (d.status === 'healthy' || d.status === 'failed') {
          // One more read in case lines landed between the two queries.
          if (s.deploys.logs(id, seq).length > 0) continue;
          await stream.writeSSE({ event: 'done', data: JSON.stringify({ status: d.status, failureReason: d.failureReason }) });
          return;
        }
        if (Date.now() - quietSince > HEARTBEAT_MS) {
          await stream.write(': ping\n\n');
          quietSince = Date.now();
        }
        await stream.sleep(POLL_MS);
      }
    });
  });

  // API tokens: admin only, since a token could otherwise mint a stronger one.
  app.get('/tokens', admin, (c) => c.json(s.tokens.list()));
  app.post('/tokens', admin, async (c) => c.json(s.tokens.create(principal(c).ctx, await body(c)), 201));
  app.delete('/tokens/:id', admin, (c) => c.json(s.tokens.revoke(principal(c).ctx, intParam(c.req.param('id'), 'Token'))));

  // Registries and settings
  app.get('/registries', read, (c) => c.json(s.registries.list()));
  app.post('/registries', admin, async (c) => c.json(s.registries.create(principal(c).ctx, await body(c)), 201));
  app.patch('/registries/:id', admin, async (c) => c.json(s.registries.update(principal(c).ctx, intParam(c.req.param('id'), 'Registry'), await body(c))));
  app.get('/settings', read, (c) => c.json({ health_timeout_seconds: s.settings.get('health_timeout_seconds') }));
  app.put('/settings/:key', admin, async (c) => {
    const key = c.req.param('key');
    if (key !== 'health_timeout_seconds') throw new AppError('not_found', `Setting ${key} not found`);
    const { value } = parseInput(z.object({ value: z.unknown() }), await body(c));
    return c.json({ [key]: s.settings.set(principal(c).ctx, key as SettingKey, value) });
  });

  app.get('/audit', admin, (c) => {
    const q = parseInput(ListQuery, c.req.query());
    return c.json(s.audit.list({ limit: q.limit, beforeId: q.before }));
  });

  return app;
}
