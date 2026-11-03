import type { RequestContext } from '../actor.ts';
import { randomToken, sha256Hex } from '../crypto/tokens.ts';
import type { Db } from '../db/db.ts';
import type { AuditLog } from './audit.ts';

export type User = {
  id: number;
  oidcSub: string;
  email: string;
  name: string | null;
  role: 'admin';
  createdAt: string;
  lastLoginAt: string | null;
};

type UserRow = {
  id: number;
  oidc_sub: string;
  email: string;
  name: string | null;
  role: 'admin';
  created_at: string;
  last_login_at: string | null;
};

/** What the identity provider says about the person who just logged in. */
export type OidcIdentity = {
  sub: string;
  email: string;
  /** Whether the provider says the email is verified; ADMIN_EMAILS only accepts verified ones. */
  emailVerified?: boolean;
  name: string | null;
};

export const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;

const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;

/**
 * Users and browser sessions. Anyone who completes the OIDC login is the
 * admin: the Clerk app has signup disabled, so the identity provider is the
 * allowlist. The session cookie holds a random token; only its hash is stored.
 */
export class SessionService {
  readonly #db: Db;
  readonly #audit: AuditLog;

  constructor(deps: { db: Db; audit: AuditLog }) {
    this.#db = deps.db;
    this.#audit = deps.audit;
  }

  /** Records a completed login and starts a session. Returns the cookie value, shown only here. */
  login(identity: OidcIdentity, meta: { ip?: string | null; userAgent?: string | null }): { token: string; user: User; expiresAt: Date } {
    const token = randomToken();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    return this.#db.transaction(() => {
      this.#db.run(
        `INSERT INTO users (oidc_sub, email, name, last_login_at) VALUES (?, ?, ?, ${NOW})
         ON CONFLICT (oidc_sub) DO UPDATE SET email = excluded.email, name = excluded.name, last_login_at = excluded.last_login_at`,
        identity.sub, identity.email, identity.name,
      );
      const user = this.#db.get<UserRow>('SELECT * FROM users WHERE oidc_sub = ?', identity.sub)!;
      this.#db.run(`DELETE FROM sessions WHERE expires_at <= ${NOW}`);
      this.#db.run(
        'INSERT INTO sessions (id, user_id, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?)',
        sha256Hex(token), user.id, expiresAt.toISOString(), meta.ip ?? null, meta.userAgent?.slice(0, 500) ?? null,
      );
      const ctx: RequestContext = { actor: { type: 'user', userId: user.id }, ip: meta.ip ?? null };
      this.#audit.record(ctx, 'auth.login', `user:${user.id}`, { email: user.email });
      return { token, user: view(user), expiresAt };
    });
  }

  /** The user a session cookie belongs to, or null if it is unknown or expired. */
  authenticate(token: string): User | null {
    const row = this.#db.get<UserRow>(
      `SELECT users.* FROM sessions JOIN users ON users.id = sessions.user_id
       WHERE sessions.id = ? AND sessions.expires_at > ${NOW}`,
      sha256Hex(token),
    );
    return row ? view(row) : null;
  }

  logout(ctx: RequestContext, token: string): void {
    this.#db.transaction(() => {
      const { changes } = this.#db.run('DELETE FROM sessions WHERE id = ?', sha256Hex(token));
      if (changes > 0) this.#audit.record(ctx, 'auth.logout', ctx.actor.type === 'user' ? `user:${ctx.actor.userId}` : null);
    });
  }

  getUser(id: number): User | null {
    const row = this.#db.get<UserRow>('SELECT * FROM users WHERE id = ?', id);
    return row ? view(row) : null;
  }
}

function view(r: UserRow): User {
  return {
    id: r.id,
    oidcSub: r.oidc_sub,
    email: r.email,
    name: r.name,
    role: r.role,
    createdAt: r.created_at,
    lastLoginAt: r.last_login_at,
  };
}
