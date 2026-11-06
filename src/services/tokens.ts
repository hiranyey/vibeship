import type { RequestContext } from '../actor.ts';
import { randomToken, sha256Hex } from '../crypto/tokens.ts';
import type { Db } from '../db/db.ts';
import { AppError, notFound } from '../errors.ts';
import { CreateTokenInput, type TokenScope } from '../schemas.ts';
import type { AuditLog } from './audit.ts';
import { parseInput } from './validate.ts';

/** API tokens start with this, so they are easy to spot in logs and secret scanners. */
export const TOKEN_PREFIX = 'vs_';

export type ApiToken = {
  id: number;
  name: string;
  scope: TokenScope;
  createdBy: number | null;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
};

type TokenRow = {
  id: number;
  name: string;
  scope: TokenScope;
  created_by: number | null;
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
};

const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;
/** `last_used_at` is refreshed at most this often, so reads don't write on every request. */
const TOUCH_INTERVAL = `'-60 seconds'`;

const order: Record<TokenScope, number> = { read: 0, deploy: 1, admin: 2 };

/** True when `held` covers `needed`: admin covers deploy, which covers read. */
export function scopeCovers(held: TokenScope, needed: TokenScope): boolean {
  return order[held] >= order[needed];
}

/** Bearer API tokens for agents and scripts. Only a SHA-256 hash is stored; the token is shown once. */
export class TokenService {
  readonly #db: Db;
  readonly #audit: AuditLog;

  constructor(deps: { db: Db; audit: AuditLog }) {
    this.#db = deps.db;
    this.#audit = deps.audit;
  }

  /** Returns the token itself once; it can't be read back later. */
  create(ctx: RequestContext, rawInput: unknown): { token: string; apiToken: ApiToken } {
    const input = parseInput(CreateTokenInput, rawInput);
    const token = `${TOKEN_PREFIX}${randomToken()}`;
    const createdBy = ctx.actor.type === 'user' ? ctx.actor.userId : null;
    return this.#db.transaction(() => {
      // Names tell tokens apart in the UI and the audit log, so two usable
      // tokens can't share one. A revoked or expired token's name is free again.
      const taken = this.#db.get<{ id: number }>(
        `SELECT id FROM api_tokens WHERE name = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ${NOW})`,
        input.name,
      );
      if (taken) {
        const why = `A token named "${input.name}" already exists; pick another name or revoke that one first`;
        throw new AppError('conflict', `name: ${why}`, { issues: [{ path: 'name', message: why }] });
      }
      const { lastInsertRowid: id } = this.#db.run(
        'INSERT INTO api_tokens (name, token_hash, scope, created_by, expires_at) VALUES (?, ?, ?, ?, ?)',
        input.name, sha256Hex(token), input.scope, createdBy, input.expiresAt ? new Date(input.expiresAt).toISOString() : null,
      );
      this.#audit.record(ctx, 'token.create', `token:${id}`, { name: input.name, scope: input.scope, expiresAt: input.expiresAt ?? null });
      return { token, apiToken: this.get(id) };
    });
  }

  get(id: number): ApiToken {
    const row = this.#db.get<TokenRow>('SELECT * FROM api_tokens WHERE id = ?', id);
    if (!row) throw notFound(`Token ${id}`);
    return view(row);
  }

  /** Newest first, revoked and expired ones included. */
  list(): ApiToken[] {
    return this.#db.all<TokenRow>('SELECT * FROM api_tokens ORDER BY id DESC').map(view);
  }

  revoke(ctx: RequestContext, id: number): ApiToken {
    return this.#db.transaction(() => {
      const token = this.get(id);
      if (!token.revokedAt) {
        this.#db.run(`UPDATE api_tokens SET revoked_at = ${NOW} WHERE id = ?`, id);
        this.#audit.record(ctx, 'token.revoke', `token:${id}`, { name: token.name });
      }
      return this.get(id);
    });
  }

  /** The token a bearer value belongs to, or null if it is unknown, revoked or expired. */
  authenticate(bearer: string): ApiToken | null {
    if (!bearer.startsWith(TOKEN_PREFIX)) return null;
    const row = this.#db.get<TokenRow>(
      `SELECT * FROM api_tokens
       WHERE token_hash = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ${NOW})`,
      sha256Hex(bearer),
    );
    if (!row) return null;
    this.#db.run(
      `UPDATE api_tokens SET last_used_at = ${NOW}
       WHERE id = ? AND (last_used_at IS NULL OR last_used_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ${TOUCH_INTERVAL}))`,
      row.id,
    );
    return view(row);
  }
}

function view(r: TokenRow): ApiToken {
  return {
    id: r.id,
    name: r.name,
    scope: r.scope,
    createdBy: r.created_by,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
    expiresAt: r.expires_at,
    revokedAt: r.revoked_at,
  };
}
