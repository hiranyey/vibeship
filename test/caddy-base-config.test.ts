import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { caddyBaseConfig } from '../src/caddy/base-config.ts';

test('dev/caddy/caddy.json is the generated config for plain HTTP', () => {
  const dev = JSON.parse(readFileSync(new URL('../dev/caddy/caddy.json', import.meta.url), 'utf8'));
  assert.deepEqual(caddyBaseConfig({ host: 'vibeship.localhost', tlsMode: 'off' }), dev);
});

test('origin-cert serves :443 with the loaded certificate and no ACME', () => {
  const c = caddyBaseConfig({ host: 'vibeship.hiranyey.dev', tlsMode: 'origin-cert', certFile: '/etc/caddy/certs/origin.pem', keyFile: '/etc/caddy/certs/origin.key' }) as any;
  const server = c.apps.http.servers.vibeship;
  assert.deepEqual(server.listen, [':443']);
  assert.deepEqual(server.automatic_https, { disable: true });
  assert.deepEqual(server.tls_connection_policies, [{}]);
  assert.deepEqual(server.protocols, ['h1', 'h2']);
  assert.deepEqual(c.apps.tls.certificates.load_files, [{ certificate: '/etc/caddy/certs/origin.pem', key: '/etc/caddy/certs/origin.key', tags: ['origin-cert'] }]);
  assert.deepEqual(server.routes[0].match, [{ host: ['vibeship.hiranyey.dev'] }]);
  assert.equal(c.admin.listen, '172.31.250.2:2019');
});

test('origin-cert needs both files, and the host must be a hostname', () => {
  assert.throws(() => caddyBaseConfig({ host: 'vibeship.hiranyey.dev', tlsMode: 'origin-cert' }), /certificate and key/);
  assert.throws(() => caddyBaseConfig({ host: 'a"b', tlsMode: 'off' }), /not a hostname/);
});
