import type { RequestContext } from '../actor.ts';
import type { Db, Param } from '../db/db.ts';

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

export type AuditActor = { type: 'user'; id: number } | { type: 'token'; id: number } | { type: 'system' };

export type AuditFilter = {
  action?: string;
  actor?: AuditActor;
  targetType?: string;
  since?: string;
  until?: string;
  excludeActionPrefixes?: string[];
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

  /**
   * Newest first. Pass the last id seen as `beforeId` to page back. The
   * filters narrow by action, actor, target type (`project` in
   * `project:3`), a time range (ISO, `since` inclusive, `until` exclusive)
   * and can leave out actions by prefix (e.g. `auth.` for sign-ins).
   */
  list(opts: AuditFilter & { limit?: number; beforeId?: number } = {}): AuditEntry[] {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
    const where = ['id < ?'];
    const args: Param[] = [opts.beforeId ?? Number.MAX_SAFE_INTEGER];
    if (opts.action) {
      where.push('action = ?');
      args.push(opts.action);
    }
    if (opts.actor) {
      where.push('actor_type = ?');
      args.push(opts.actor.type);
      if (opts.actor.type === 'user') {
        where.push('user_id = ?');
        args.push(opts.actor.id);
      } else if (opts.actor.type === 'token') {
        where.push('token_id = ?');
        args.push(opts.actor.id);
      }
    }
    if (opts.targetType) {
      // `project:3` and the like; the prefix is matched literally.
      where.push("substr(target, 1, length(?) + 1) = ? || ':'");
      args.push(opts.targetType, opts.targetType);
    }
    if (opts.since) {
      where.push('ts >= ?');
      args.push(opts.since);
    }
    if (opts.until) {
      where.push('ts < ?');
      args.push(opts.until);
    }
    for (const prefix of opts.excludeActionPrefixes ?? []) {
      where.push('substr(action, 1, length(?)) <> ?');
      args.push(prefix, prefix);
    }
    const rows = this.#db.all<AuditRow>(
      `SELECT * FROM audit_log WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`,
      ...args,
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

  /** What there is to filter by: every action, actor and target type seen so far. */
  facets(): { actions: string[]; actors: AuditActor[]; targetTypes: string[] } {
    const actions = this.#db.all<{ action: string }>('SELECT DISTINCT action FROM audit_log ORDER BY action').map((r) => r.action);
    const actors = this.#db.all<{ actor_type: AuditEntry['actorType']; user_id: number | null; token_id: number | null }>(
      'SELECT DISTINCT actor_type, user_id, token_id FROM audit_log ORDER BY actor_type, user_id, token_id',
    ).flatMap((r): AuditActor[] => {
      if (r.actor_type === 'user') return r.user_id === null ? [] : [{ type: 'user', id: r.user_id }];
      if (r.actor_type === 'token') return r.token_id === null ? [] : [{ type: 'token', id: r.token_id }];
      return [{ type: 'system' }];
    });
    const targetTypes = this.#db.all<{ kind: string }>(
      "SELECT DISTINCT substr(target, 1, instr(target, ':') - 1) AS kind FROM audit_log WHERE instr(target, ':') > 1 ORDER BY kind",
    ).map((r) => r.kind);
    return { actions, actors, targetTypes };
  }
}
