import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parse } from 'yaml';
import { checkCompose, renderComposeProject } from '../src/compose/validate.ts';
import { dockerEnv } from '../src/docker/cli-runner.ts';
import { AppError } from '../src/errors.ts';

const svc = (extra: string) => `services:\n  app:\n    image: nginx:1.29\n${extra}`;

/** Compose files that must be accepted. */
const good: Array<[string, string]> = [
  ['the minimum', svc('')],
  ['obsolete version and x- anchors', `version: "3.9"\nx-env: &env\n  A: "1"\nservices:\n  app:\n    image: nginx\n    environment: *env\n`],
  ['every allowed service key', svc(`    command: ["node", "server.js"]
    entrypoint: /bin/sh -c
    environment: { A: "1", B: 2, C: true, D: null, E: "\${FROM_PROJECT_ENV}" }
    env_file: .env
    ports: ["127.0.0.1:8080:80", "127.0.0.1:9000-9001:9000-9001/udp", { target: 81, published: 8081, host_ip: 127.0.0.1 }]
    volumes: ["./data:/data", "./data/:/more:ro", "cache:/cache", "/anonymous", { type: bind, source: ./data, target: /x, read_only: true }, { type: volume, source: cache, target: /y }]
    depends_on: { db: { condition: service_healthy } }
    healthcheck: { test: ["CMD", "true"], interval: 5s, retries: 3 }
    restart: on-failure:3
    working_dir: /srv
    user: "1000:1000"
    labels: { com.example.team: blog }
    mem_limit: 512m
    cpus: 0.5
    networks: { back: { aliases: [api] }, default: null }
  db:
    image: postgres:18
    env_file: [./.env]
    depends_on: [cache-warmer]
    labels: ["com.example.role=db"]
  cache-warmer:
    image: busybox
    networks: [back]
volumes:
  cache:
  logs: { labels: { a: b } }
networks:
  back: { internal: true }
`)],
];

/** Compose files that must be refused, and the path the error must name. */
const bad: Array<[string, string, string]> = [
  ...['privileged: true', 'network_mode: host', 'pid: host', 'ipc: host', 'cap_add: [SYS_ADMIN]', 'devices: ["/dev/sda:/dev/sda"]',
    'security_opt: ["seccomp:unconfined"]', 'userns_mode: host', 'build: .', 'extends: { file: x.yaml, service: y }',
    'container_name: caddy', 'hostname: x', 'sysctls: { a: 1 }', 'deploy: {}', 'volumes_from: [db]', 'links: [db]', 'tmpfs: /tmp',
    'cgroup_parent: x', 'extra_hosts: ["a:1.2.3.4"]', 'profiles: [x]', 'secrets: [s]', 'configs: [c]', 'expose: ["80"]']
    .map((line): [string, string, string] => [line.split(':')[0]!, svc(`    ${line}\n`), `services.app.${line.split(':')[0]}`]),
  ...['name: other', 'secrets: { s: { file: /etc/shadow } }', 'configs: { c: { file: /etc/passwd } }', 'include: [x.yaml]', 'services2: {}']
    .map((line): [string, string, string] => [`top-level ${line.split(':')[0]}`, `${svc('')}${line}\n`, line.split(':')[0]!]),
  ['volume driver', `${svc('')}volumes:\n  v: { driver: local, driver_opts: { type: none, device: /, o: bind } }\n`, 'volumes.v.driver'],
  ['external volume', `${svc('')}volumes:\n  v: { external: true }\n`, 'volumes.v.external'],
  ['volume named after another project', `${svc('')}volumes:\n  v: { name: other_db }\n`, 'volumes.v.name'],
  ['external network', `${svc('')}networks:\n  n: { external: true }\n`, 'networks.n.external'],
  ['network driver', `${svc('')}networks:\n  n: { driver: macvlan }\n`, 'networks.n.driver'],
  ['declaring web', `${svc('')}networks:\n  web: { external: true }\n`, 'networks.web'],
  ['joining web', svc('    networks: [web]\n'), 'services.app.networks'],
  ['undeclared network', svc('    networks: [nope]\n'), 'services.app.networks[0]'],
  ['port on all interfaces', svc('    ports: ["8080:80"]\n'), 'services.app.ports[0]'],
  ['bare port', svc('    ports: ["80"]\n'), 'services.app.ports[0]'],
  ['port as a number', svc('    ports: [80]\n'), 'services.app.ports[0]'],
  ['long port without loopback', svc('    ports: [{ target: 80, published: 80 }]\n'), 'services.app.ports[0].host_ip'],
  ['interpolated port', svc('    ports: ["${P}:80"]\n'), 'services.app.ports[0]'],
  ['host path', svc('    volumes: ["/etc:/etc"]\n'), 'services.app.volumes[0]'],
  ['docker socket', svc('    volumes: ["/var/run/docker.sock:/var/run/docker.sock"]\n'), 'services.app.volumes[0]'],
  ['parent folder', svc('    volumes: ["../vibeship:/x"]\n'), 'services.app.volumes[0]'],
  ['escape through data', svc('    volumes: ["./data/../../vibeship:/x"]\n'), 'services.app.volumes[0]'],
  ['a folder inside data', svc('    volumes: ["./data/db:/x"]\n'), 'services.app.volumes[0]'],
  ['home folder', svc('    volumes: ["~/.ssh:/x"]\n'), 'services.app.volumes[0]'],
  ['interpolated bind', svc('    volumes: ["./data${X}:/x"]\n'), 'services.app.volumes[0]'],
  ['undeclared named volume', svc('    volumes: ["db:/x"]\n'), 'services.app.volumes[0]'],
  ['long bind to the host', svc('    volumes: [{ type: bind, source: /, target: /host }]\n'), 'services.app.volumes[0].source'],
  ['long volume with bind propagation', svc('    volumes: [{ type: bind, source: ./data, target: /x, bind: { propagation: rshared } }]\n'), 'services.app.volumes[0].bind'],
  ['tmpfs volume', svc('    volumes: [{ type: tmpfs, target: /x }]\n'), 'services.app.volumes[0].type'],
  ['a mount mode beyond ro and rw', svc('    volumes: ["./data:/x:rshared"]\n'), 'services.app.volumes[0]'],
  ['another env file', svc('    env_file: /opt/stack/vibeship/.env\n'), 'services.app.env_file'],
  ['another env file in a list', svc('    env_file: [.env, ../x/.env]\n'), 'services.app.env_file[1]'],
  ['compose labels', svc('    labels: { com.docker.compose.project: other }\n'), 'services.app.labels.com.docker.compose.project'],
  ['vibeship labels', svc('    labels: ["dev.vibeship.project=other"]\n'), 'services.app.labels.dev.vibeship.project'],
  ['depends on a missing service', svc('    depends_on: [db]\n'), 'services.app.depends_on[0]'],
  ['no image', 'services:\n  app:\n    command: x\n', 'services.app.image'],
  ['no services', 'volumes: {}\n', 'services'],
  ['merge keys', `x-base: &base\n  privileged: true\nservices:\n  app:\n    image: x\n    <<: *base\n`, 'services.app.<<'],
  ['an unknown YAML tag', svc('    command: !reset []\n'), 'yaml'],
  ['duplicate keys', 'services:\n  app:\n    image: x\n    image: y\n', 'yaml'],
  ['a bad restart policy', svc('    restart: sometimes\n'), 'services.app.restart'],
];

for (const [what, yaml] of good) {
  test(`compose: accepts ${what}`, () => {
    checkCompose(yaml, 'app');
  });
}

for (const [what, yaml, path] of bad) {
  test(`compose: rejects ${what}, naming ${path}`, () => {
    assert.throws(() => checkCompose(yaml, 'app'), (err: unknown) => {
      assert.ok(err instanceof AppError, String(err));
      assert.equal(err.code, 'validation');
      assert.equal(err.details?.path, path, err.message);
      return true;
    });
  });
}

test('compose: the routed service must exist and the project name is kept for it', () => {
  assert.throws(() => checkCompose(svc(''), 'web'), /routedService: web is not a service/);
  const twoNamed = 'services:\n  app:\n    image: x\n  blog:\n    image: y\n';
  assert.throws(() => renderComposeProject(checkCompose(twoNamed, 'app'), 'blog'), /only the routed service may be named blog/);
});

test('compose: the patch forces the name and puts only the routed service on web, renamed to the project', () => {
  const yaml = `name: ignored-anyway
services:
  vibeship:
    image: app
    depends_on: [db]
    networks: [back]
    labels: ["team=x"]
  db:
    image: postgres
    env_file: ./.env
  worker:
    image: worker
    depends_on: { vibeship: { condition: service_started } }
networks:
  back:
`.replace('name: ignored-anyway\n', '');
  const out = renderComposeProject(checkCompose(yaml, 'vibeship'), 'blog');
  assert.match(out, /^# Generated by Vibeship/);
  const file = parse(out) as { name: string; services: Record<string, Record<string, unknown>>; networks: Record<string, unknown> };

  assert.equal(file.name, 'blog');
  // A service called vibeship would otherwise be an alias for Vibeship's own name on web.
  assert.deepEqual(Object.keys(file.services), ['blog', 'db', 'worker']);
  assert.deepEqual(file.services.blog!.networks, { back: { aliases: ['vibeship'] }, web: { aliases: ['blog'] } });
  assert.equal(file.services.db!.networks, undefined);
  assert.equal(file.services.worker!.networks, undefined);
  assert.deepEqual(file.services.worker!.depends_on, { blog: { condition: 'service_started' } });
  assert.deepEqual(file.services.db!.env_file, ['.env']);
  assert.deepEqual(file.services.blog!.labels, { team: 'x', 'dev.vibeship.project': 'blog' });
  assert.deepEqual(file.networks, { back: null, web: { external: true } });

  // With no networks of its own, the routed service stays on the default network too.
  const simple = parse(renderComposeProject(checkCompose(svc(''), 'app'), 'blog')) as typeof file;
  assert.deepEqual(simple.services.blog!.networks, { default: { aliases: ['app'] }, web: { aliases: ['blog'] } });
});

test('compose: keys that are not plain words are quoted in the output', () => {
  const out = renderComposeProject(checkCompose(svc('    environment:\n      "A: b": "1"\n      "#x": "2"\n'), 'app'), 'blog');
  const env = (parse(out) as { services: { blog: { environment: Record<string, string> } } }).services.blog.environment;
  assert.deepEqual(env, { 'A: b': '1', '#x': '2' });
});

test('docker commands see no Vibeship secrets, so compose cannot interpolate them', () => {
  const env = dockerEnv({ DOCKER_CONFIG: '/tmp/x' }, { PATH: '/bin', HOME: '/root', MASTER_KEY: 'k', OIDC_CLIENT_SECRET: 's', DOCKER_HOST: 'unix:///s' });
  assert.deepEqual(env, { PATH: '/bin', HOME: '/root', DOCKER_HOST: 'unix:///s', DOCKER_CONFIG: '/tmp/x' });
});
