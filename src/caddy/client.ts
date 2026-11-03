/** The Caddy server block Vibeship owns; it must exist in Caddy's base config. */
export const CADDY_SERVER = 'vibeship';
/** Routes Vibeship manages carry an `@id` with this prefix; others are left alone. */
const ID_PREFIX = 'vs-route-';

export type RouteSpec = { routeId: number; hostname: string; upstream: string };

export interface CaddyApi {
  upsertRoute(route: RouteSpec): Promise<void>;
  deleteRoute(routeId: number): Promise<void>;
  /** Makes Caddy's managed routes exactly `routes`. Returns true if anything changed. */
  reconcile(routes: RouteSpec[]): Promise<boolean>;
}

type CaddyRoute = {
  '@id'?: string;
  match?: Array<{ host?: string[] }>;
  handle?: Array<{ handler?: string; upstreams?: Array<{ dial?: string }> }>;
};

export function routeJson(r: RouteSpec): CaddyRoute & { terminal: true } {
  return {
    '@id': `${ID_PREFIX}${r.routeId}`,
    match: [{ host: [r.hostname] }],
    handle: [{ handler: 'reverse_proxy', upstreams: [{ dial: r.upstream }] }],
    terminal: true,
  };
}

/** Reduces a route to what Vibeship sets, to compare Caddy's state with the database. */
function summary(r: CaddyRoute): string {
  return JSON.stringify([r['@id'], r.match?.[0]?.host, r.handle?.[0]?.upstreams?.[0]?.dial]);
}

export class CaddyClient implements CaddyApi {
  readonly #base: string;

  constructor(adminUrl: string) {
    this.#base = adminUrl;
  }

  #call(method: string, path: string, body?: unknown): Promise<Response> {
    return fetch(`${this.#base}${path}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
  }

  async #ok(res: Response, what: string): Promise<void> {
    if (!res.ok) throw new Error(`Caddy ${what} failed with ${res.status}: ${(await res.text()).trim()}`);
  }

  #routesPath = `/config/apps/http/servers/${CADDY_SERVER}/routes`;

  async upsertRoute(route: RouteSpec): Promise<void> {
    const id = `${ID_PREFIX}${route.routeId}`;
    // PATCH on an @id replaces that route. A new one is inserted at the front,
    // ahead of the base config's catch-all 404 route.
    const res = await this.#call('PATCH', `/id/${id}`, routeJson(route));
    if (res.status === 404) {
      await this.#ok(await this.#call('PUT', `${this.#routesPath}/0`, routeJson(route)), `adding route ${id}`);
      return;
    }
    await this.#ok(res, `updating route ${id}`);
  }

  async deleteRoute(routeId: number): Promise<void> {
    const id = `${ID_PREFIX}${routeId}`;
    const res = await this.#call('DELETE', `/id/${id}`);
    if (res.status === 404) return;
    await this.#ok(res, `deleting route ${id}`);
  }

  async reconcile(routes: RouteSpec[]): Promise<boolean> {
    const res = await this.#call('GET', this.#routesPath);
    await this.#ok(res, 'reading routes');
    const current = ((await res.json()) as CaddyRoute[] | null) ?? [];

    const others = current.filter((r) => !r['@id']?.startsWith(ID_PREFIX));
    const desired = [...routes.map(routeJson), ...others];
    if (current.map(summary).join('\n') === desired.map(summary).join('\n')) return false;

    // One PATCH replaces the whole list; Caddy validates it before applying.
    await this.#ok(await this.#call('PATCH', this.#routesPath, desired), 'replacing routes');
    return true;
  }
}
