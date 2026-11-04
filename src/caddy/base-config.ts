// Caddy's base config: the server block Vibeship adds project routes to, the
// route to Vibeship itself and a catch-all 404. bootstrap.sh writes it with
//
//   node src/caddy/base-config.ts --host vibeship.example.com --tls origin-cert \
//     --cert /etc/caddy/certs/origin.pem --key /etc/caddy/certs/origin.key
//
// and dev/caddy/caddy.json is the same thing for local runs (a test keeps
// them in step).
import { parseArgs } from 'node:util';
import { CADDY_SERVER } from './client.ts';

/** The admin API listens on the internal `caddy-admin` network only, never on `web`. */
export const CADDY_ADMIN_ADDRESS = '172.31.250.2';

/** The only port published on the host, by Caddy: 443 with the origin certificate, 80 with TLS off (local runs). */
export const CADDY_PUBLIC_PORT = { 'origin-cert': 443, off: 80 } as const;

export type BaseConfigOptions = {
  /** Vibeship's own hostname, e.g. vibeship.hiranyey.dev. */
  host: string;
  tlsMode: 'origin-cert' | 'off';
  /** Paths inside the Caddy container; required for origin-cert. */
  certFile?: string;
  keyFile?: string;
};

export function caddyBaseConfig(o: BaseConfigOptions): Record<string, unknown> {
  const tls = o.tlsMode === 'origin-cert';
  if (tls && (!o.certFile || !o.keyFile)) throw new Error('origin-cert needs the certificate and key files');
  if (!/^[a-z0-9.-]+$/.test(o.host)) throw new Error(`not a hostname: ${o.host}`);

  const server: Record<string, unknown> = {
    listen: [`:${CADDY_PUBLIC_PORT[o.tlsMode]}`],
    // Certificates come from the Cloudflare origin certificate, never from ACME,
    // and nothing listens on :80 in production to redirect.
    automatic_https: { disable: true },
    // Cloudflare reaches the origin over TCP, so no HTTP/3 listener on UDP.
    ...(tls ? { tls_connection_policies: [{}], protocols: ['h1', 'h2'] } : {}),
    logs: {},
    routes: [
      {
        '@id': 'vibeship-ui',
        match: [{ host: [o.host] }],
        handle: [
          {
            handler: 'subroute',
            routes: [
              // Webhook URLs are secrets, so they stay out of the access log.
              { match: [{ path: ['/hooks/*'] }], handle: [{ handler: 'vars', log_skip: true }] },
              { handle: [{ handler: 'reverse_proxy', upstreams: [{ dial: 'vibeship:3000' }] }] },
            ],
          },
        ],
        terminal: true,
      },
      {
        '@id': 'not-found',
        handle: [{ handler: 'static_response', status_code: 404, body: 'No app is deployed at this address.\n' }],
      },
    ],
  };

  return {
    admin: { listen: `${CADDY_ADMIN_ADDRESS}:2019`, origins: ['caddy-api:2019'] },
    apps: {
      http: { servers: { [CADDY_SERVER]: server } },
      ...(tls ? { tls: { certificates: { load_files: [{ certificate: o.certFile, key: o.keyFile, tags: ['origin-cert'] }] } } } : {}),
    },
  };
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: { host: { type: 'string' }, tls: { type: 'string', default: 'origin-cert' }, cert: { type: 'string' }, key: { type: 'string' } },
  });
  if (!values.host || (values.tls !== 'origin-cert' && values.tls !== 'off')) {
    console.error('Usage: node src/caddy/base-config.ts --host <vibeship host> [--tls origin-cert|off] [--cert <file> --key <file>]');
    process.exit(2);
  }
  try {
    console.log(JSON.stringify(caddyBaseConfig({ host: values.host, tlsMode: values.tls, certFile: values.cert, keyFile: values.key }), null, 2));
  } catch (err) {
    console.error((err as Error).message);
    process.exit(2);
  }
}
