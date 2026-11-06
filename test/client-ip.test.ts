import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Hono } from 'hono';
import { CLIENT_IP_HEADER, CLOUDFLARE_RANGES, caddyBaseConfig } from '../src/caddy/base-config.ts';
import { clientIp, normalizeIp, TrustedProxies } from '../src/http/client-ip.ts';
import { providerName } from '../src/http/auth-routes.ts';

const CADDY = '172.31.250.2';
const CLOUDFLARE_EDGE = '172.70.1.2';

/** The address clientIp() sees for a request from `peer` carrying `headers`. */
async function seen(proxies: TrustedProxies, peer: string | null, headers: Record<string, string> = {}): Promise<string | null> {
  const app = new Hono();
  app.get('/', (c) => c.json({ ip: clientIp(c, proxies) }));
  const env = peer === null ? {} : { incoming: { socket: { remoteAddress: peer } } };
  const res = await app.request('/', { headers }, env);
  return ((await res.json()) as { ip: string | null }).ip;
}

test('X-Real-Ip names the client only when the request comes from a trusted proxy', async () => {
  const proxies = new TrustedProxies([CADDY]);
  // From Caddy: its header is the client, behind Cloudflare or not.
  assert.equal(await seen(proxies, CADDY, { 'x-real-ip': '203.0.113.7' }), '203.0.113.7');
  assert.equal(await seen(proxies, `::ffff:${CADDY}`, { 'x-real-ip': '2001:db8::1' }), '2001:db8::1');
  // From an app on the `web` network (or anyone else): the header is ignored.
  assert.equal(await seen(proxies, '172.18.0.9', { 'x-real-ip': '203.0.113.7' }), '172.18.0.9');
  // X-Forwarded-For is never believed: it was what put Cloudflare's edge in the audit log.
  assert.equal(await seen(proxies, CADDY, { 'x-forwarded-for': `203.0.113.7, ${CLOUDFLARE_EDGE}` }), CADDY);
  // A header that is not an address falls back to the peer.
  assert.equal(await seen(proxies, CADDY, { 'x-real-ip': 'not-an-ip' }), CADDY);
  // No socket (app.request in tests): no address.
  assert.equal(await seen(proxies, null, { 'x-real-ip': '203.0.113.7' }), null);
});

test('trusted proxies resolve hostnames, and unresolvable ones are skipped', async () => {
  const proxies = new TrustedProxies(['localhost', 'no-such-host.invalid', '10.0.0.1']);
  assert.ok(proxies.has('10.0.0.1'), 'a literal IP is trusted at once');
  assert.ok(!proxies.has('127.0.0.1'), 'a hostname only once resolved');
  await proxies.refresh();
  assert.ok(proxies.has('127.0.0.1') || proxies.has('::1'));
  assert.ok(!proxies.has('203.0.113.7'));
});

test('normalizeIp strips the IPv4-mapped prefix and refuses non-addresses', () => {
  assert.equal(normalizeIp('::ffff:10.1.2.3'), '10.1.2.3');
  assert.equal(normalizeIp(' 2001:DB8::1 '), '2001:db8::1');
  assert.equal(normalizeIp('example.com'), null);
  assert.equal(normalizeIp(undefined), null);
});

test('behind Cloudflare, Caddy takes the client from CF-Connecting-IP only from Cloudflare, and passes it on', () => {
  const prod = caddyBaseConfig({ host: 'vibeship.hiranyey.dev', tlsMode: 'origin-cert', certFile: '/c', keyFile: '/k' }) as any;
  const server = prod.apps.http.servers.vibeship;
  assert.deepEqual(server.client_ip_headers, ['CF-Connecting-IP']);
  for (const range of ['172.64.0.0/13', '162.158.0.0/15', '104.16.0.0/13']) assert.ok(CLOUDFLARE_RANGES.includes(range), range);
  const proxy = server.routes[0].handle[0].routes.at(-1).handle[0];
  assert.deepEqual(proxy.headers.request.set, { [CLIENT_IP_HEADER]: ['{http.vars.client_ip}'] });

  // Locally there is no Cloudflare: the peer is the client.
  const dev = (caddyBaseConfig({ host: 'vibeship.localhost', tlsMode: 'off' }) as any).apps.http.servers.vibeship;
  assert.deepEqual(dev.routes[0].handle[0].routes.at(-1).handle[0].headers.request.set, { [CLIENT_IP_HEADER]: ['{http.vars.client_ip}'] });
});

test('the login button names the identity provider from its issuer', () => {
  assert.equal(providerName('https://clerk.hiranyey.dev'), 'Clerk');
  assert.equal(providerName('https://happy-cat-12.clerk.accounts.dev'), 'Clerk');
  assert.equal(providerName('https://accounts.google.com'), 'Google');
  assert.equal(providerName('https://login.microsoftonline.com/tenant/v2.0'), 'Microsoft');
  assert.equal(providerName('https://sso.example.com/realms/main'), 'Keycloak');
  assert.equal(providerName('https://id.example.com'), 'SSO');
  assert.equal(providerName(undefined), 'SSO');
});
