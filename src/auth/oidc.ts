import { createHash, createPublicKey, type KeyObject, verify, type webcrypto } from 'node:crypto';
import { randomToken } from '../crypto/tokens.ts';
import type { OidcIdentity } from '../services/sessions.ts';

export type OidcSettings = { issuer: string; clientId: string; clientSecret: string; redirectUri: string };

/** What a login has to remember between the redirect to the provider and the callback. */
export type LoginAttempt = { state: string; nonce: string; verifier: string };

/** The two steps of the authorization code flow; a fake stands in for it in tests. */
export interface OidcClient {
  /** Where to send the browser to log in, plus what the callback must check. */
  start(): Promise<{ url: string; attempt: LoginAttempt }>;
  /** Exchanges the code from the callback and verifies the ID token. */
  finish(code: string, attempt: LoginAttempt): Promise<OidcIdentity>;
}

type Discovery = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  userinfo_endpoint?: string;
};

type Jwk = webcrypto.JsonWebKey & { kid?: string; use?: string; alg?: string };

type IdTokenClaims = {
  iss?: string;
  sub?: string;
  aud?: string | string[];
  azp?: string;
  exp?: number;
  iat?: number;
  nonce?: string;
  email?: string;
  /** Clerk sends a boolean; some providers send the string "true". */
  email_verified?: boolean | string;
  name?: string;
  given_name?: string;
  family_name?: string;
};

/** Allowed difference between our clock and the provider's. */
const CLOCK_SKEW_S = 60;
const DISCOVERY_TTL_MS = 60 * 60 * 1000;

/**
 * OIDC authorization code flow with PKCE (S256), for Clerk or any standard
 * provider. The ID token comes straight from the token endpoint over TLS, and
 * its signature, issuer, audience, expiry and nonce are still checked.
 */
export class HttpOidcClient implements OidcClient {
  readonly #s: OidcSettings;
  readonly #fetch: typeof fetch;
  #discovery: { value: Discovery; at: number } | null = null;
  #keys = new Map<string, KeyObject>();

  constructor(settings: OidcSettings, fetchImpl: typeof fetch = fetch) {
    this.#s = { ...settings, issuer: settings.issuer.replace(/\/+$/, '') };
    this.#fetch = fetchImpl;
  }

  async start(): Promise<{ url: string; attempt: LoginAttempt }> {
    const d = await this.#discover();
    const attempt: LoginAttempt = { state: randomToken(), nonce: randomToken(), verifier: randomToken(48) };
    const url = new URL(d.authorization_endpoint);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: this.#s.clientId,
      redirect_uri: this.#s.redirectUri,
      scope: 'openid email profile',
      state: attempt.state,
      nonce: attempt.nonce,
      code_challenge: createHash('sha256').update(attempt.verifier).digest('base64url'),
      code_challenge_method: 'S256',
    }).toString();
    return { url: url.toString(), attempt };
  }

  async finish(code: string, attempt: LoginAttempt): Promise<OidcIdentity> {
    const d = await this.#discover();
    const res = await this.#fetch(d.token_endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
        authorization: `Basic ${Buffer.from(`${encodeURIComponent(this.#s.clientId)}:${encodeURIComponent(this.#s.clientSecret)}`).toString('base64')}`,
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: this.#s.redirectUri,
        code_verifier: attempt.verifier,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json().catch(() => ({}))) as { id_token?: string; access_token?: string; error?: string; error_description?: string };
    if (!res.ok || !body.id_token) {
      throw new Error(`token exchange failed (${res.status}): ${body.error_description ?? body.error ?? 'no ID token returned'}`);
    }
    const claims = await this.#verifyIdToken(body.id_token, d, attempt.nonce);

    let email = claims.email;
    let emailVerified = verified(claims.email_verified);
    let name = claims.name ?? ([claims.given_name, claims.family_name].filter(Boolean).join(' ') || undefined);
    if ((!email || !name) && d.userinfo_endpoint && body.access_token) {
      const info = await this.#userinfo(d.userinfo_endpoint, body.access_token, claims.sub!);
      if (!email && info.email) {
        email = info.email;
        emailVerified = verified(info.email_verified);
      }
      name ??= info.name;
    }
    return { sub: claims.sub!, email: email ?? '', emailVerified: Boolean(email) && emailVerified, name: name ?? null };
  }

  async #userinfo(endpoint: string, accessToken: string, sub: string): Promise<Pick<IdTokenClaims, 'email' | 'email_verified' | 'name'>> {
    const res = await this.#fetch(endpoint, { headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return {};
    const info = (await res.json()) as IdTokenClaims;
    // The spec requires userinfo's subject to match the ID token's.
    return info.sub === sub ? { email: info.email, email_verified: info.email_verified, name: info.name } : {};
  }

  async #discover(): Promise<Discovery> {
    if (this.#discovery && Date.now() - this.#discovery.at < DISCOVERY_TTL_MS) return this.#discovery.value;
    const url = `${this.#s.issuer}/.well-known/openid-configuration`;
    const res = await this.#fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`OIDC discovery at ${url} failed with ${res.status}`);
    const value = (await res.json()) as Discovery;
    if (value.issuer?.replace(/\/+$/, '') !== this.#s.issuer) {
      throw new Error(`OIDC discovery returned issuer ${value.issuer}, expected ${this.#s.issuer}`);
    }
    this.#discovery = { value, at: Date.now() };
    return value;
  }

  async #key(kid: string | undefined, d: Discovery): Promise<KeyObject> {
    const cached = kid ? this.#keys.get(kid) : undefined;
    if (cached) return cached;
    // Unknown key id: the provider may have rotated keys, so fetch them again.
    const res = await this.#fetch(d.jwks_uri, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`fetching signing keys failed with ${res.status}`);
    const { keys } = (await res.json()) as { keys: Jwk[] };
    this.#keys = new Map();
    for (const jwk of keys ?? []) {
      if (jwk.use && jwk.use !== 'sig') continue;
      try {
        this.#keys.set(jwk.kid ?? '', createPublicKey({ key: jwk, format: 'jwk' }));
      } catch {
        // Skip key types node can't load.
      }
    }
    const key = this.#keys.get(kid ?? '') ?? (kid === undefined && this.#keys.size === 1 ? [...this.#keys.values()][0] : undefined);
    if (!key) throw new Error(`ID token signed with unknown key ${kid ?? '(no kid)'}`);
    return key;
  }

  async #verifyIdToken(token: string, d: Discovery, nonce: string): Promise<IdTokenClaims> {
    const parts = token.split('.');
    if (parts.length !== 3) throw new Error('ID token is not a JWT');
    const [h, p, s] = parts as [string, string, string];
    const header = decodeJson(h) as { alg?: string; kid?: string };
    const key = await this.#key(header.kid, d);
    if (!verifySignature(header.alg, key, Buffer.from(`${h}.${p}`), Buffer.from(s, 'base64url'))) {
      throw new Error('ID token signature is invalid');
    }

    const claims = decodeJson(p) as IdTokenClaims;
    const now = Math.floor(Date.now() / 1000);
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (claims.iss?.replace(/\/+$/, '') !== this.#s.issuer) throw new Error(`ID token issuer ${claims.iss} is not ${this.#s.issuer}`);
    if (!aud.includes(this.#s.clientId)) throw new Error('ID token is for another client');
    if (aud.length > 1 && claims.azp !== this.#s.clientId) throw new Error('ID token azp is not this client');
    if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_S < now) throw new Error('ID token has expired');
    if (typeof claims.iat === 'number' && claims.iat - CLOCK_SKEW_S > now) throw new Error('ID token was issued in the future');
    if (claims.nonce !== nonce) throw new Error('ID token nonce does not match this login');
    if (!claims.sub) throw new Error('ID token has no subject');
    return claims;
  }
}

function decodeJson(part: string): unknown {
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch {
    throw new Error('ID token is not valid JSON');
  }
}

/** Only asymmetric algorithms: `none` and HMAC (keyed with the client secret) are refused. */
function verifySignature(alg: string | undefined, key: KeyObject, data: Buffer, sig: Buffer): boolean {
  switch (alg) {
    case 'RS256':
    case 'RS384':
    case 'RS512':
      return key.asymmetricKeyType === 'rsa' && verify(`sha${alg.slice(2)}`, data, key, sig);
    case 'ES256':
    case 'ES384':
    case 'ES512':
      return key.asymmetricKeyType === 'ec' && verify(`sha${alg.slice(2)}`, data, { key, dsaEncoding: 'ieee-p1363' }, sig);
    case 'EdDSA':
      return (key.asymmetricKeyType === 'ed25519' || key.asymmetricKeyType === 'ed448') && verify(null, data, key, sig);
    default:
      throw new Error(`ID token algorithm ${alg ?? '(none)'} is not supported`);
  }
}

const verified = (v: boolean | string | undefined): boolean => v === true || v === 'true';
