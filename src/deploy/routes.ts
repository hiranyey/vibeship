import type { CaddyApi, RouteSpec } from '../caddy/client.ts';
import type { Db } from '../db/db.ts';

/**
 * Keeps Caddy's routes equal to the database. Runs on boot and then on a
 * timer, so a restarted Caddy (which comes back with only its base config) is
 * rebuilt within one interval.
 */
export class RouteSync {
  readonly #db: Db;
  readonly #caddy: CaddyApi;
  #timer: NodeJS.Timeout | null = null;
  #failing = false;

  constructor(deps: { db: Db; caddy: CaddyApi }) {
    this.#db = deps.db;
    this.#caddy = deps.caddy;
  }

  /** Routes for projects that have a healthy version to serve. */
  desired(): RouteSpec[] {
    return this.#db.all<RouteSpec>(
      `SELECT r.id AS routeId, r.hostname, r.upstream
       FROM routes r
       JOIN projects p ON p.id = r.project_id
       LEFT JOIN image_sources i ON i.project_id = p.id
       WHERE (i.current_digest IS NOT NULL OR p.current_compose_version_id IS NOT NULL) AND p.status != 'stopped'
       ORDER BY r.id`,
    );
  }

  async reconcile(): Promise<boolean> {
    const changed = await this.#caddy.reconcile(this.desired());
    if (changed) console.log('Caddy routes rebuilt from the database');
    return changed;
  }

  start(intervalMs = 10_000): void {
    const tick = async () => {
      try {
        await this.reconcile();
        if (this.#failing) console.log('Caddy route sync recovered');
        this.#failing = false;
      } catch (err) {
        // Log once per outage rather than every interval.
        if (!this.#failing) console.error(`Caddy route sync failed: ${(err as Error).message}`);
        this.#failing = true;
      }
    };
    void tick();
    this.#timer ??= setInterval(tick, intervalMs);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }
}
