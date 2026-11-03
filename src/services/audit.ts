import type { RequestContext } from '../actor.ts';
import type { Db } from '../db/db.ts';

export type AuditEntry = {
  id: number;
  actorType: 'user' | 'token' | 'system';
  userId: number | null;
  tokenId: number | null;
  action: string;
  target: string | null;
  details: Record<string, unknown>;
  ip: string | null;
  ts: string;
};

type AuditRow = {
  id: number;
  actor_type: AuditEntry['actorType'];
  user_id: number | null;
  token_id: number | null;
  action: string;
  target: string | null;
  details: string;
  ip: string | null;
  ts: string;
};

export class AuditLog {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /**
   * Records a change. Call it inside the same transaction as the change, so
   * either both are saved or neither is. `details` must never hold secret values.
   */
  record(ctx: RequestContext, action: string, target: string | null, details: Record<string, unknown> = {}): void {
    const { actor } = ctx;
    this.#db.run(
      `INSERT INTO audit_log (actor_type, user_id, token_id, action, target, details, ip)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      actor.type,
      actor.type === 'user' ? actor.userId : null,
      actor.type === 'token' ? actor.tokenId : null,
      action,
      target,
      JSON.stringify(details),
      ctx.ip ?? null,
    );
  }

  /** Newest first. Pass the last id seen as `beforeId` to page back. */
  list(opts: { limit?: number; beforeId?: number } = {}): AuditEntry[] {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
    const rows = this.#db.all<AuditRow>(
      `SELECT * FROM audit_log WHERE id < ? ORDER BY id DESC LIMIT ?`,
      opts.beforeId ?? Number.MAX_SAFE_INTEGER,
      limit,
    );
    return rows.map((r) => ({
      id: r.id,
      actorType: r.actor_type,
      userId: r.user_id,
      tokenId: r.token_id,
      action: r.action,
      target: r.target,
      details: JSON.parse(r.details) as Record<string, unknown>,
      ip: r.ip,
      ts: r.ts,
    }));
  }
}
