import type { Context, MiddlewareHandler } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import { getCookie } from 'hono/cookie';
import type { RequestContext } from '../actor.ts';
import type { Config } from '../config.ts';
import { AppError } from '../errors.ts';
import type { TokenScope } from '../schemas.ts';
import type { Services } from '../services/index.ts';
import type { User } from '../services/sessions.ts';
import { type ApiToken, scopeCovers } from '../services/tokens.ts';

/** Who is making the request. A logged-in user is the admin, so a session carries admin scope. */
export type Principal =
  | { kind: 'user'; user: User; scope: 'admin'; ctx: RequestContext }
  | { kind: 'token'; token: ApiToken; scope: TokenScope; ctx: RequestContext };

export type AppEnv = { Variables: { principal: Principal | null; ip: string | null } };

/** Cookie names and flags. Over HTTPS the session cookie uses the `__Host-` prefix, which pins it to this exact host. */
export function cookieSettings(config: Pick<Config, 'publicUrl'>) {
  const secure = config.publicUrl.startsWith('https://');
  return {
    secure,
    session: secure ? '__Host-vs_session' : 'vs_session',
    login: secure ? '__Host-vs_login' : 'vs_login',
  };
}

/**
 * The client address for the audit log: the last hop Caddy added to
 * X-Forwarded-For, else the socket peer. Apps on `web` can reach Vibeship
 * directly and set this header themselves, so it is informational only.
 */
export function clientIp(c: Context): string | null {
  const forwarded = c.req.header('x-forwarded-for');
  if (forwarded) return forwarded.split(',').at(-1)!.trim() || null;
  try {
    return getConnInfo(c).remote.address ?? null;
  } catch {
    return null; // No socket, e.g. app.request() in tests.
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Works out the principal from a bearer token or the session cookie. Every
 * app Vibeship deploys lives on a sibling subdomain, which browsers treat as
 * same-site, so SameSite=Lax alone doesn't stop an app from posting to the
 * API with the admin's cookie: cookie-authenticated writes must also come
 * from Vibeship's own origin.
 */
export function authenticate(config: Pick<Config, 'publicUrl'>, services: Services): MiddlewareHandler<AppEnv> {
  const cookies = cookieSettings(config);
  const origin = new URL(config.publicUrl).origin;

  return async (c, next) => {
    const ip = clientIp(c);
    c.set('ip', ip);
    c.set('principal', null);

    const header = c.req.header('authorization');
    if (header !== undefined) {
      const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
      const token = match ? services.tokens.authenticate(match[1]!) : null;
      // A bad bearer token is an error even if a session cookie came too.
      if (!token) throw new AppError('unauthorized', 'Invalid, expired or revoked API token');
      c.set('principal', { kind: 'token', token, scope: token.scope, ctx: { actor: { type: 'token', tokenId: token.id }, ip } });
      return next();
    }

    const sessionToken = getCookie(c, cookies.session);
    const user = sessionToken ? services.sessions.authenticate(sessionToken) : null;
    if (user) {
      if (!SAFE_METHODS.has(c.req.method) && !sameOrigin(c, origin)) {
        throw new AppError('forbidden', 'Cross-origin request refused');
      }
      c.set('principal', { kind: 'user', user, scope: 'admin', ctx: { actor: { type: 'user', userId: user.id }, ip } });
    }
    return next();
  };
}

function sameOrigin(c: Context, origin: string): boolean {
  const sent = c.req.header('origin');
  if (sent !== undefined) return sent === origin;
  // Browsers send Origin on every cross-origin POST; Sec-Fetch-Site covers the rest.
  return c.req.header('sec-fetch-site') === 'same-origin';
}

/** Refuses the request unless the principal's scope covers `scope`. */
export function requireScope(scope: TokenScope): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const p = c.get('principal');
    if (!p) throw new AppError('unauthorized', 'Log in or send an API token as "Authorization: Bearer <token>"');
    if (!scopeCovers(p.scope, scope)) throw new AppError('forbidden', `This needs a ${scope} token; yours is ${p.scope}`);
    return next();
  };
}

/** The principal of a route behind `requireScope`. */
export function principal(c: Context<AppEnv>): Principal {
  const p = c.get('principal');
  if (!p) throw new AppError('unauthorized', 'Not authenticated');
  return p;
}
