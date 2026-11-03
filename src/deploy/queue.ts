import type { Db } from '../db/db.ts';
import type { DeployEngine } from './engine.ts';

/**
 * Runs queued deploys one at a time per project, oldest first, with recovery
 * deploys ahead of the rest. The `deploys` table is the queue itself; this
 * class only tracks which projects have a worker running, so nothing is lost
 * when the process restarts.
 */
export class DeployQueue {
  readonly #db: Db;
  readonly #engine: DeployEngine;
  readonly #workers = new Map<number, Promise<void>>();
  readonly #enabled: boolean;
  #timer: NodeJS.Timeout | null = null;

  /** With `enabled: false` (e.g. a CLI sharing the database), deploys are only queued; the server runs them. */
  constructor(deps: { db: Db; engine: DeployEngine; enabled?: boolean }) {
    this.#db = deps.db;
    this.#engine = deps.engine;
    this.#enabled = deps.enabled ?? true;
  }

  /** Starts a worker for the project unless one is already running; it will pick up new rows. */
  kick(projectId: number): void {
    if (!this.#enabled || this.#workers.has(projectId)) return;
    this.#workers.set(projectId, this.#drain(projectId));
  }

  isBusy(projectId: number): boolean {
    return this.#workers.has(projectId);
  }

  async #drain(projectId: number): Promise<void> {
    try {
      for (;;) {
        const next = this.#db.get<{ id: number }>(
          `SELECT id FROM deploys WHERE project_id = ? AND status = 'queued'
           ORDER BY trigger = 'recovery' DESC, id LIMIT 1`,
          projectId,
        );
        // Returning here runs `finally` in the same tick, so a kick() can't slip in between.
        if (!next) return;
        try {
          await this.#engine.run(next.id);
        } catch (err) {
          console.error(`Deploy ${next.id} crashed the worker`, err);
          this.#db.run(`UPDATE deploys SET status = 'failed', failure_reason = ? WHERE id = ? AND status IN ('queued', 'running')`, String(err), next.id);
        }
      }
    } finally {
      this.#workers.delete(projectId);
    }
  }

  /** Kicks every project with queued deploys now, and again every `pollMs` as a safety net. */
  start(pollMs = 2000): void {
    const sweep = () => {
      for (const { project_id } of this.#db.all<{ project_id: number }>(`SELECT DISTINCT project_id FROM deploys WHERE status = 'queued'`)) {
        this.kick(project_id);
      }
    };
    sweep();
    this.#timer ??= setInterval(sweep, pollMs);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  /** Resolves once no worker is running; for tests and shutdown. */
  async idle(): Promise<void> {
    while (this.#workers.size > 0) await Promise.all(this.#workers.values());
  }
}
