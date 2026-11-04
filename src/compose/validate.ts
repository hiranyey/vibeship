import { parseDocument } from 'yaml';
import { DATA_DIR, ENV_FILE, WEB_NETWORK } from '../deploy/layout.ts';
import { HEADER, toYaml, type Yaml } from '../deploy/render.ts';
import { AppError } from '../errors.ts';

// Vibeship holds the Docker socket, so a compose file amounts to root on the
// host unless it is fenced in. This is an allowlist: every key that is not
// listed here is rejected, with the offending key named in the error.
//
// The YAML is parsed, checked, patched and then written out again from the
// parsed value, so Docker never sees the user's text: YAML tags, anchors and
// merge keys can't smuggle anything past the check.

type Obj = { [key: string]: Yaml };

export const SERVICE_KEYS: ReadonlySet<string> = new Set([
  'image', 'command', 'entrypoint', 'environment', 'env_file', 'ports', 'volumes', 'depends_on',
  'healthcheck', 'restart', 'working_dir', 'user', 'labels', 'mem_limit', 'cpus', 'networks',
]);
export const TOP_KEYS: ReadonlySet<string> = new Set(['services', 'volumes', 'networks']);
/** Accepted and dropped: `version` is obsolete, and `x-` blocks only hold YAML anchors, already resolved. */
export const IGNORED_TOP_KEY = (k: string) => k === 'version' || k.startsWith('x-');

export const NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/;
export const HEALTHCHECK_KEYS: ReadonlySet<string> = new Set(['test', 'interval', 'timeout', 'retries', 'start_period', 'start_interval', 'disable']);
export const PORT_KEYS: ReadonlySet<string> = new Set(['target', 'published', 'host_ip', 'protocol', 'name', 'app_protocol']);
export const VOLUME_KEYS: ReadonlySet<string> = new Set(['type', 'source', 'target', 'read_only']);
export const DEPENDS_KEYS: ReadonlySet<string> = new Set(['condition', 'restart', 'required']);
export const CONDITIONS: ReadonlySet<string> = new Set(['service_started', 'service_healthy', 'service_completed_successfully']);
export const RESERVED_LABEL = /^(com\.docker\.|dev\.vibeship\.)/;
/** The only host address a compose port may be published on. */
export const LOOPBACK = '127.0.0.1';
/** Keys a top-level named volume may have. */
export const TOP_VOLUME_KEYS: ReadonlySet<string> = new Set(['labels']);
/** Keys a top-level network may have. */
export const TOP_NETWORK_KEYS: ReadonlySet<string> = new Set(['internal', 'labels']);
/** Keys a service's entry under `networks` may have. */
export const SERVICE_NETWORK_KEYS: ReadonlySet<string> = new Set(['aliases']);
/** The only bind mount sources allowed: the project's data folder itself. */
export const BIND_SOURCES: ReadonlySet<string> = new Set([`./${DATA_DIR}`, `./${DATA_DIR}/`]);
/** The only env_file values allowed: the project's own .env. */
export const ENV_FILES: ReadonlySet<string> = new Set([ENV_FILE, `./${ENV_FILE}`]);
/** Keys in which `$` interpolation is refused, since compose resolves it after the check. */
export const NO_INTERPOLATION_KEYS = ['ports', 'volumes', 'networks'] as const;
export const RESTART_POLICY = /^(no|always|unless-stopped|on-failure(:\d+)?)$/;
/** Aliases resolved per document; more is refused. */
export const MAX_YAML_ALIASES = 100;
const PORT_SPEC = '\\d{1,5}(?:-\\d{1,5})?';
const SHORT_PORT = new RegExp(`^127\\.0\\.0\\.1:${PORT_SPEC}:${PORT_SPEC}(?:/(?:tcp|udp))?$`);

export type ComposeCheck = {
  /** The parsed file, checked against the allowlist. */
  file: { services: Record<string, Obj>; volumes: Obj; networks: Obj };
  routedService: string;
};

function fail(path: string, message: string): never {
  throw new AppError('validation', `${path}: ${message}`, { path });
}

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isScalar = (v: unknown) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';

function obj(v: unknown, path: string): Obj {
  if (!isObj(v)) fail(path, 'must be a mapping');
  return v;
}

function onlyKeys(v: Obj, allowed: ReadonlySet<string>, path: string, hint = 'is not allowed'): void {
  for (const k of Object.keys(v)) {
    if (k === '<<') fail(`${path}.<<`, 'YAML merge keys are not supported; write the keys out, or use an anchor for a whole value');
    if (!allowed.has(k)) fail(`${path}.${k}`, hint);
  }
}

function str(v: unknown, path: string): string {
  if (typeof v !== 'string' || v === '') fail(path, 'must be a non-empty string');
  return v;
}

function strOrList(v: unknown, path: string): void {
  if (typeof v === 'string') return;
  if (Array.isArray(v) && v.every(isScalar)) return;
  fail(path, 'must be a string or a list of strings');
}

/** Interpolation (`${VAR}`) is resolved by compose after this check, so it isn't allowed where it could change what is mounted or exposed. */
function noInterpolation(v: unknown, path: string): void {
  if (typeof v === 'string' && v.includes('$')) fail(path, '$ (variable interpolation) is not allowed here');
  if (Array.isArray(v)) v.forEach((x, i) => noInterpolation(x, `${path}[${i}]`));
  else if (isObj(v)) for (const [k, x] of Object.entries(v)) noInterpolation(x, `${path}.${k}`);
}

/** Parses compose YAML into plain values, refusing anything YAML-specific that could hide a key. */
export function parseComposeYaml(text: string): Obj {
  const doc = parseDocument(text, { uniqueKeys: true, merge: false, prettyErrors: false });
  const problem = doc.errors[0] ?? doc.warnings[0];
  if (problem) fail('yaml', problem.message.split('\n')[0]!);
  let value: unknown;
  try {
    value = doc.toJS({ maxAliasCount: MAX_YAML_ALIASES });
  } catch (err) {
    fail('yaml', (err as Error).message);
  }
  return obj(value, 'top level');
}

/**
 * Checks a compose file against the allowlist and that `routedService` exists.
 * Throws a `validation` AppError naming the first offending key.
 */
export function checkCompose(text: string, routedService: string): ComposeCheck {
  const top = parseComposeYaml(text);
  for (const k of Object.keys(top)) {
    if (!TOP_KEYS.has(k) && !IGNORED_TOP_KEY(k)) {
      fail(k, `top-level key is not allowed (allowed: ${[...TOP_KEYS].join(', ')})`);
    }
  }

  const volumes = top.volumes == null ? {} : obj(top.volumes, 'volumes');
  for (const [name, v] of Object.entries(volumes)) {
    if (!NAME.test(name)) fail(`volumes.${name}`, 'is not a valid volume name');
    if (v === null) continue;
    // `name` and `external` would reach volumes outside this project; `driver` options can mount host paths.
    onlyKeys(obj(v, `volumes.${name}`), TOP_VOLUME_KEYS, `volumes.${name}`, 'is not allowed; volumes are plain named volumes');
  }

  const networks = top.networks == null ? {} : obj(top.networks, 'networks');
  for (const [name, v] of Object.entries(networks)) {
    if (name === WEB_NETWORK) fail(`networks.${WEB_NETWORK}`, `Vibeship attaches the routed service to ${WEB_NETWORK} itself`);
    if (!NAME.test(name)) fail(`networks.${name}`, 'is not a valid network name');
    if (v === null) continue;
    onlyKeys(obj(v, `networks.${name}`), TOP_NETWORK_KEYS, `networks.${name}`, 'is not allowed; networks are private to the project');
  }

  const services = obj(top.services, 'services');
  if (Object.keys(services).length === 0) fail('services', 'must define at least one service');
  for (const [name, s] of Object.entries(services)) {
    if (!NAME.test(name)) fail(`services.${name}`, 'is not a valid service name');
    checkService(name, obj(s, `services.${name}`), { services, volumes, networks });
  }
  if (!(routedService in services)) fail('routedService', `${routedService} is not a service in the compose file`);

  return { file: { services: services as Record<string, Obj>, volumes, networks }, routedService };
}

function checkService(name: string, s: Obj, ctx: { services: Obj; volumes: Obj; networks: Obj }): void {
  const at = `services.${name}`;
  onlyKeys(s, SERVICE_KEYS, at);
  str(s.image, `${at}.image`);

  for (const key of ['command', 'entrypoint'] as const) if (s[key] !== undefined) strOrList(s[key], `${at}.${key}`);
  for (const key of ['working_dir', 'user'] as const) {
    if (s[key] !== undefined && !(typeof s[key] === 'string' || typeof s[key] === 'number')) fail(`${at}.${key}`, 'must be a string');
  }

  if (s.environment !== undefined) {
    const env = s.environment;
    if (Array.isArray(env)) {
      env.forEach((e, i) => { if (typeof e !== 'string') fail(`${at}.environment[${i}]`, 'must be a KEY=value string'); });
    } else {
      for (const [k, v] of Object.entries(obj(env, `${at}.environment`))) {
        if (v !== null && !isScalar(v)) fail(`${at}.environment.${k}`, 'must be a string, number or boolean');
      }
    }
  }

  if (s.env_file !== undefined) {
    // Only the project's own .env, which Vibeship writes; any other path could read host files.
    const files = Array.isArray(s.env_file) ? s.env_file : [s.env_file];
    files.forEach((f, i) => {
      if (typeof f !== 'string' || !ENV_FILES.has(f)) fail(`${at}.env_file${Array.isArray(s.env_file) ? `[${i}]` : ''}`, 'only .env (the project\'s env vars) is allowed');
    });
  }

  if (s.ports !== undefined) {
    noInterpolation(s.ports, `${at}.ports`);
    if (!Array.isArray(s.ports)) fail(`${at}.ports`, 'must be a list');
    s.ports.forEach((p, i) => {
      const path = `${at}.ports[${i}]`;
      if (typeof p === 'string') {
        if (!SHORT_PORT.test(p)) fail(path, `ports must be bound to ${LOOPBACK}, like "${LOOPBACK}:8080:80"`);
        return;
      }
      const o = obj(p, path);
      onlyKeys(o, PORT_KEYS, path);
      if (o.host_ip !== LOOPBACK) fail(`${path}.host_ip`, `must be ${LOOPBACK}`);
      if (typeof o.target !== 'number') fail(`${path}.target`, 'must be a port number');
    });
  }

  if (s.volumes !== undefined) {
    noInterpolation(s.volumes, `${at}.volumes`);
    if (!Array.isArray(s.volumes)) fail(`${at}.volumes`, 'must be a list');
    s.volumes.forEach((v, i) => checkVolume(v, `${at}.volumes[${i}]`, ctx.volumes));
  }

  if (s.depends_on !== undefined) {
    const deps = s.depends_on;
    const names = Array.isArray(deps) ? deps : Object.keys(obj(deps, `${at}.depends_on`));
    names.forEach((d, i) => {
      if (typeof d !== 'string' || !(d in ctx.services) || d === name) fail(`${at}.depends_on[${i}]`, `${String(d)} is not another service in this file`);
    });
    if (isObj(deps)) {
      for (const [d, cond] of Object.entries(deps)) {
        if (cond === null) continue;
        const c = obj(cond, `${at}.depends_on.${d}`);
        onlyKeys(c, DEPENDS_KEYS, `${at}.depends_on.${d}`);
        if (c.condition !== undefined && !CONDITIONS.has(String(c.condition))) fail(`${at}.depends_on.${d}.condition`, `must be one of ${[...CONDITIONS].join(', ')}`);
      }
    }
  }

  if (s.healthcheck !== undefined) onlyKeys(obj(s.healthcheck, `${at}.healthcheck`), HEALTHCHECK_KEYS, `${at}.healthcheck`);

  if (s.restart !== undefined && !RESTART_POLICY.test(String(s.restart))) {
    fail(`${at}.restart`, 'must be no, always, unless-stopped or on-failure[:N]');
  }

  if (s.labels !== undefined) {
    const keys = Array.isArray(s.labels)
      ? s.labels.map((l, i) => (typeof l === 'string' ? l.split('=')[0]! : fail(`${at}.labels[${i}]`, 'must be a key=value string')))
      : Object.keys(obj(s.labels, `${at}.labels`));
    for (const k of keys) if (RESERVED_LABEL.test(k)) fail(`${at}.labels.${k}`, 'com.docker.* and dev.vibeship.* labels are reserved');
  }

  if (s.mem_limit !== undefined && !/^\d+(\.\d+)?\s*[bkmg]?b?$/i.test(String(s.mem_limit))) fail(`${at}.mem_limit`, 'must look like 512m or 1g');
  if (s.cpus !== undefined && !(Number(s.cpus) > 0)) fail(`${at}.cpus`, 'must be a positive number');

  if (s.networks !== undefined) {
    noInterpolation(s.networks, `${at}.networks`);
    const nets = s.networks;
    const names = Array.isArray(nets) ? nets : Object.keys(obj(nets, `${at}.networks`));
    names.forEach((n, i) => {
      if (n === WEB_NETWORK) fail(`${at}.networks`, `${WEB_NETWORK} is added by Vibeship, and only to the routed service`);
      if (typeof n !== 'string' || (n !== 'default' && !(n in ctx.networks))) fail(`${at}.networks[${i}]`, `${String(n)} is not declared under networks`);
    });
    if (isObj(nets)) {
      for (const [n, cfg] of Object.entries(nets)) {
        if (cfg === null) continue;
        const c = obj(cfg, `${at}.networks.${n}`);
        onlyKeys(c, SERVICE_NETWORK_KEYS, `${at}.networks.${n}`);
        if (c.aliases !== undefined && !(Array.isArray(c.aliases) && c.aliases.every((a) => typeof a === 'string' && NAME.test(a)))) {
          fail(`${at}.networks.${n}.aliases`, 'must be a list of names');
        }
      }
    }
  }
}

/**
 * Bind mounts may only use the project's `./data` folder itself. Allowing
 * paths inside it would let a container plant a symlink there that a later
 * deploy follows out to the host.
 */
function checkVolume(v: unknown, path: string, declared: Obj): void {
  const bindHint = 'bind mounts may only use ./data (the project\'s data folder); use a named volume for anything else';
  const checkSource = (source: string, at: string) => {
    if (/^[./~]/.test(source)) {
      if (!BIND_SOURCES.has(source)) fail(at, bindHint);
    } else if (!(source in declared)) {
      fail(at, NAME.test(source) ? `volume ${source} is not declared under volumes` : bindHint);
    }
  };
  const checkTarget = (target: unknown, at: string) => {
    if (typeof target !== 'string' || !target.startsWith('/')) fail(at, 'the container path must be absolute');
  };

  if (typeof v === 'string') {
    const parts = v.split(':');
    if (parts.length === 1) return checkTarget(parts[0], path); // an anonymous volume
    if (parts.length > 3) fail(path, 'must look like source:/path or source:/path:ro');
    const [source, target, mode] = parts as [string, string, string | undefined];
    checkSource(source, path);
    checkTarget(target, path);
    if (mode !== undefined && mode !== 'ro' && mode !== 'rw') fail(path, 'the mode must be ro or rw');
    return;
  }

  const o = obj(v, path);
  onlyKeys(o, VOLUME_KEYS, path);
  checkTarget(o.target, `${path}.target`);
  if (o.read_only !== undefined && typeof o.read_only !== 'boolean') fail(`${path}.read_only`, 'must be true or false');
  if (o.type === 'bind') {
    checkSource(str(o.source, `${path}.source`), `${path}.source`);
    if (!/^[./~]/.test(String(o.source))) fail(`${path}.source`, bindHint);
  } else if (o.type === 'volume') {
    if (o.source !== undefined) checkSource(str(o.source, `${path}.source`), `${path}.source`);
    if (/^[./~]/.test(String(o.source ?? ''))) fail(`${path}.source`, 'a volume source must be a declared volume name');
  } else {
    fail(`${path}.type`, 'must be bind or volume');
  }
}

/**
 * The compose file Vibeship writes for a checked version. The project name is
 * forced, and the routed service is renamed to the project name: Docker adds
 * a service's name as an alias on every network it joins, so on `web` it is
 * then reachable only as `<project>`, and can't shadow Vibeship, Caddy or
 * another project whatever the user called it. Its original name stays an
 * alias on the project's own networks, so the other services still reach it.
 * Only the routed service joins `web`.
 */
export function renderComposeProject(check: ComposeCheck, project: string): string {
  const { file, routedService } = check;
  const rename = (s: string) => (s === routedService ? project : s);
  if (routedService !== project && project in file.services) {
    fail(`services.${project}`, `only the routed service may be named ${project}, the project name`);
  }

  const services: Obj = {};
  for (const [name, original] of Object.entries(file.services)) {
    const s: Obj = { ...original };
    if (s.env_file !== undefined) s.env_file = [ENV_FILE];

    if (s.depends_on !== undefined) {
      s.depends_on = Array.isArray(s.depends_on)
        ? s.depends_on.map((d) => rename(String(d)))
        : Object.fromEntries(Object.entries(s.depends_on as Obj).map(([d, c]) => [rename(d), c]));
    }

    const labels: Obj = Array.isArray(s.labels)
      ? Object.fromEntries((s.labels as string[]).map((l) => [l.split('=')[0]!, l.includes('=') ? l.slice(l.indexOf('=') + 1) : '']))
      : { ...(s.labels as Obj | undefined) };
    labels['dev.vibeship.project'] = project;
    s.labels = labels;

    if (name === routedService) {
      const own: Obj = s.networks === undefined
        ? { default: null }
        : Array.isArray(s.networks)
          ? Object.fromEntries((s.networks as string[]).map((n) => [n, null]))
          : { ...(s.networks as Obj) };
      const networks: Obj = {};
      for (const [n, cfg] of Object.entries(own)) {
        const aliases = ((cfg as Obj | null)?.aliases as string[] | undefined) ?? [];
        networks[n] = { aliases: name === project ? aliases : [...new Set([...aliases, name])] };
      }
      networks[WEB_NETWORK] = { aliases: [project] };
      s.networks = networks;
    }
    services[rename(name)] = s;
  }

  return HEADER + toYaml({
    name: project,
    services,
    ...(Object.keys(file.volumes).length > 0 ? { volumes: file.volumes } : {}),
    networks: { ...file.networks, [WEB_NETWORK]: { external: true } },
  });
}

/** The routed container's name: compose names containers `<project>-<service>-<n>`, and the routed service is renamed to the project. */
export function composeRoutedContainer(project: string): string {
  return `${project}-${project}-1`;
}
