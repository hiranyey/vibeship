import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test, type TestContext } from 'node:test';
import { CaddyClient } from '../src/caddy/client.ts';

type Route = { '@id'?: string; [k: string]: unknown };

/** Just enough of Caddy's admin API: the routes list of one server, and `/id/` lookups. */
async function fakeCaddy(t: TestContext, initial: Route[]) {
  /** Set `reject` to make config changes fail the way Caddy reports invalid config. */
  const state = { routes: structuredClone(initial), patches: 0, reject: null as string | null };
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const json = body ? JSON.parse(body) : undefined;
    const send = (status: number, payload?: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(payload === undefined ? '' : JSON.stringify(payload));
    };
    const routesPath = '/config/apps/http/servers/vibeship/routes';
    const idMatch = /^\/id\/(.+)$/.exec(req.url!);

    if (req.url === routesPath && req.method === 'GET') return send(200, state.routes);
    if (state.reject) return send(400, { error: state.reject });
    if (req.url === routesPath && req.method === 'PATCH') {
      state.patches++;
      state.routes = json;
      return send(200);
    }
    const index = new RegExp(`^${routesPath}/(\\d+)$`).exec(req.url!);
    if (index && req.method === 'PUT') {
      state.routes.splice(Number(index[1]), 0, json);
      return send(200);
    }
    if (idMatch) {
      const i = state.routes.findIndex((r) => r['@id'] === idMatch[1]);
      if (i < 0) return send(404, { error: `unknown object ID '${idMatch[1]}'` });
      if (req.method === 'PATCH') state.routes[i] = json;
      if (req.method === 'DELETE') state.routes.splice(i, 1);
      return send(200);
    }
    send(400, { error: `unexpected ${req.method} ${req.url}` });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const client = new CaddyClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  return { client, state };
}

const ui: Route = { '@id': 'vibeship-ui', match: [{ host: ['vibeship.localhost'] }], handle: [{ handler: 'reverse_proxy', upstreams: [{ dial: 'vibeship:3000' }] }] };
const hello = { routeId: 1, hostname: 'hello.localhost', upstream: 'hello:8080' };

const notFound: Route = { '@id': 'not-found', handle: [{ handler: 'static_response', status_code: 404 }] };

test('upsertRoute adds a route ahead of the catch-all, then replaces it in place', async (t) => {
  const { client, state } = await fakeCaddy(t, [ui, notFound]);
  await client.upsertRoute(hello);
  assert.deepEqual(state.routes.map((r) => r['@id']), ['vs-route-1', 'vibeship-ui', 'not-found']);
  assert.deepEqual(state.routes[0], {
    '@id': 'vs-route-1',
    match: [{ host: ['hello.localhost'] }],
    handle: [{ handler: 'reverse_proxy', upstreams: [{ dial: 'hello:8080' }] }],
    terminal: true,
  });

  await client.upsertRoute({ ...hello, upstream: 'hello:9000' });
  assert.equal(state.routes.length, 3);
  assert.deepEqual((state.routes[0] as { handle: unknown }).handle, [{ handler: 'reverse_proxy', upstreams: [{ dial: 'hello:9000' }] }]);
});

test('deleteRoute removes a route and ignores one that is already gone', async (t) => {
  const { client, state } = await fakeCaddy(t, [ui, notFound]);
  await client.upsertRoute(hello);
  await client.deleteRoute(1);
  await client.deleteRoute(1);
  assert.deepEqual(state.routes, [ui, notFound]);
});

test('reconcile rebuilds managed routes, keeps others, and is a no-op when in sync', async (t) => {
  const stale = { '@id': 'vs-route-9', match: [{ host: ['old.localhost'] }], handle: [] };
  const { client, state } = await fakeCaddy(t, [stale, ui, notFound]);
  const blog = { routeId: 2, hostname: 'blog.localhost', upstream: 'blog:80' };

  assert.equal(await client.reconcile([hello, blog]), true);
  assert.deepEqual(state.routes.map((r) => r['@id']), ['vs-route-1', 'vs-route-2', 'vibeship-ui', 'not-found']);
  assert.equal(await client.reconcile([hello, blog]), false);
  assert.equal(state.patches, 1);

  // A restarted Caddy has only its base config.
  state.routes = [ui, notFound];
  assert.equal(await client.reconcile([hello, blog]), true);
  assert.equal(state.routes.length, 4);
});

test('errors from Caddy are reported with its message', async (t) => {
  const { client, state } = await fakeCaddy(t, [ui]);
  state.reject = 'loading new config: invalid dial address';
  await assert.rejects(client.reconcile([hello]), /Caddy replacing routes failed with 400: .*invalid dial address/);
  await assert.rejects(new CaddyClient('http://127.0.0.1:1').reconcile([]));
});
