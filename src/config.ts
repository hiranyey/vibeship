import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { parseMasterKey } from './crypto/master-key.ts';

const absolutePath = z.string().refine(isAbsolute, 'must be an absolute path');

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  PUBLIC_URL: z.url(),
  STACK_ROOT: absolutePath,
  DATA_DIR: absolutePath.optional(),
  MASTER_KEY: z
    .string()
    .transform((v, ctx) => {
      const key = parseMasterKey(v);
      if (!key) ctx.addIssue({ code: 'custom', message: 'must be 32 bytes in base64; generate one with `npm run gen-key`' });
      return key ?? Buffer.alloc(0);
    }),
  BASE_DOMAIN: z.string().regex(/^[a-z0-9.-]+$/, 'must be a lowercase domain'),
  TLS_MODE: z.enum(['origin-cert', 'off']).default('origin-cert'),
  CADDY_ADMIN_URL: z.url().default('http://caddy-api:2019'),
  // Login arrives in phase 3; until then these may be empty.
  OIDC_ISSUER: z.url().optional(),
  OIDC_CLIENT_ID: z.string().min(1).optional(),
  OIDC_CLIENT_SECRET: z.string().min(1).optional(),
});

export type Config = {
  nodeEnv: 'development' | 'production' | 'test';
  port: number;
  publicUrl: string;
  stackRoot: string;
  dataDir: string;
  dbPath: string;
  /** Encrypts env values and registry tokens. Losing it makes them unreadable. */
  masterKey: Buffer;
  baseDomain: string;
  tlsMode: 'origin-cert' | 'off';
  caddyAdminUrl: string;
  oidc: { issuer: string; clientId: string; clientSecret: string } | null;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Treat empty strings as unset so `KEY=` lines in .env fall back to defaults.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== ''));
  const parsed = EnvSchema.safeParse(cleaned);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${problems.join('\n')}`);
  }
  const e = parsed.data;
  const dataDir = e.DATA_DIR ?? join(e.STACK_ROOT, 'vibeship', 'data');
  const oidcParts = [e.OIDC_ISSUER, e.OIDC_CLIENT_ID, e.OIDC_CLIENT_SECRET];
  if (oidcParts.some(Boolean) && !oidcParts.every(Boolean)) {
    throw new Error('Invalid configuration:\n  OIDC_*: set all of OIDC_ISSUER, OIDC_CLIENT_ID and OIDC_CLIENT_SECRET, or none');
  }

  return {
    nodeEnv: e.NODE_ENV,
    port: e.PORT,
    publicUrl: e.PUBLIC_URL.replace(/\/+$/, ''),
    stackRoot: e.STACK_ROOT,
    dataDir,
    dbPath: join(dataDir, 'vibeship.db'),
    masterKey: e.MASTER_KEY,
    baseDomain: e.BASE_DOMAIN,
    tlsMode: e.TLS_MODE,
    caddyAdminUrl: e.CADDY_ADMIN_URL.replace(/\/+$/, ''),
    oidc: e.OIDC_ISSUER && e.OIDC_CLIENT_ID && e.OIDC_CLIENT_SECRET
      ? { issuer: e.OIDC_ISSUER, clientId: e.OIDC_CLIENT_ID, clientSecret: e.OIDC_CLIENT_SECRET }
      : null,
  };
}
