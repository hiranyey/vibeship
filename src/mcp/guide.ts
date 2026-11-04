// The deploy guide that `get_deploy_guide`, the `vibeship://guide` resource
// and the server instructions are built from. Every number, path and rule in
// it comes from the constants the deploy code itself uses, so the guide can't
// describe a different system from the one that runs (test/guide.test.ts
// checks the two against each other).
//
// It must never contain a secret: no env values, webhook URLs or tokens, and
// no registry passwords. Project snapshots carry key names and flags only.

import { CADDY_PUBLIC_PORT } from '../caddy/base-config.ts';
import {
  BIND_SOURCES, CONDITIONS, DEPENDS_KEYS, ENV_FILES, HEALTHCHECK_KEYS, LOOPBACK, MAX_YAML_ALIASES, NO_INTERPOLATION_KEYS,
  PORT_KEYS, SERVICE_KEYS, SERVICE_NETWORK_KEYS, TOP_KEYS, TOP_NETWORK_KEYS, TOP_VOLUME_KEYS, VOLUME_KEYS,
  checkCompose, composeRoutedContainer,
} from '../compose/validate.ts';
import { dataOwnerFailure, dataOwnerLogLine } from '../deploy/engine.ts';
import { HEALTH_POLL_MS, HEALTH_STABLE_MS, PROBE_TIMEOUT_MS, healthUrl } from '../deploy/health.ts';
import { COMPOSE_FILE, DATA_DIR, ENV_FILE, ENV_FILE_MODE, IMAGE_DATA_MOUNT, WEB_NETWORK } from '../deploy/layout.ts';
import { ROUTE_SYNC_INTERVAL_MS } from '../deploy/routes.ts';
import { parseImageRef, pinned } from '../docker/image-ref.ts';
import { WEBHOOK_BODY_LIMIT_BYTES } from '../http/hooks.ts';
import { COMPOSE_DATA_OWNER_MESSAGE, DIGEST_PATTERN, ENV_KEY_PATTERN, ENV_VALUE_MAX_BYTES, RESERVED_ENV_PREFIXES, RESERVED_NAMES } from '../schemas.ts';
import type { Services } from '../services/index.ts';
import type { Project, ProjectKind } from '../services/projects.ts';
import { HEALTH_TIMEOUT_SECONDS } from '../services/settings.ts';

/**
 * Where image projects keep their image, one repository per project:
 * `<base>/<project>`. A convention for CI, not a rule: Vibeship deploys
 * whatever `imageRef` a project names.
 */
export const IMAGE_REPOSITORY_BASE = 'api.repoflow.io/hiranyeyg-6713/vibes';

/** The repository secrets the CI workflow reads. */
export const CI_SECRETS = { username: 'REPOFLOW_USERNAME', password: 'REPOFLOW_PASSWORD', webhook: 'WEBHOOK_URL' } as const;

/** Explicitly named in the guide as refused; the allowlist refuses every other unlisted key too. */
export const REFUSED_SERVICE_KEYS_EXAMPLES = [
  'privileged', 'network_mode', 'pid', 'ipc', 'cap_add', 'devices', 'security_opt', 'userns_mode', 'build', 'extends',
] as const;

export const exampleRepository = (project: string) => `${IMAGE_REPOSITORY_BASE}/${project}`;

/** What the guide needs from the running server. */
export type GuideContext = {
  baseDomain: string;
  /** `<STACK_ROOT>/<project>` for a project name. */
  projectDir: (name: string) => string;
  healthTimeoutSeconds: number;
};

export function guideContext(s: Services, baseDomain: string): GuideContext {
  return {
    baseDomain,
    projectDir: (name) => s.files.dir(name),
    healthTimeoutSeconds: s.settings.get('health_timeout_seconds'),
  };
}

/** A project as the guide shows it: configuration, key names and flags, never a secret value. */
export type ProjectSnapshot = {
  name: string;
  kind: ProjectKind;
  hostname: string;
  status: Project['status'];
  port: number;
  healthPath: string | null;
  routedContainer: string;
  dataHostPath: string;
  image: {
    imageRef: string;
    repository: string;
    tag: string;
    currentDigest: string | null;
    memLimit: string | null;
    dataOwner: string | null;
    registry: { id: number; name: string; host: string; hasLogin: boolean } | null;
    registryIdSet: boolean;
  } | null;
  compose: {
    latestVersion: number;
    deployedVersion: number | null;
    routedService: string;
    /** Where each service mounts `./data`, from the latest version. */
    dataMounts: Array<{ service: string; target: string }>;
    namedVolumes: string[];
  } | null;
  env: Array<{ key: string; isSecret: boolean }>;
  hasWebhook: boolean;
  /** Env or settings changed in the database since the live version was deployed. */
  pendingChanges: boolean;
  lastDeploy: {
    id: number;
    status: string;
    trigger: string;
    digest: string | null;
    failureReason: string | null;
    finishedAt: string | null;
  } | null;
};

export function snapshotProject(s: Services, p: Project): ProjectSnapshot {
  const [last] = s.deploys.list(p.id, 1);
  let compose: ProjectSnapshot['compose'] = null;
  if (p.compose) {
    const version = s.projects.getComposeVersion(p.id, p.compose.version);
    let file: ReturnType<typeof checkCompose>['file'] | null = null;
    try {
      file = checkCompose(version.composeYaml, version.routedService).file;
    } catch {
      // A version saved under older rules; the deploy will refuse it and say why.
    }
    compose = {
      latestVersion: p.compose.version,
      deployedVersion: p.deployedComposeVersion,
      routedService: p.compose.routedService,
      dataMounts: Object.entries(file?.services ?? {}).flatMap(([service, svc]) => dataTargets(svc.volumes).map((target) => ({ service, target }))),
      namedVolumes: Object.keys(file?.volumes ?? {}),
    };
  }
  const registry = p.image ? s.registries.matchFor(p.image.imageRef, p.image.registryId) : null;
  return {
    name: p.name,
    kind: p.kind,
    hostname: p.hostname,
    status: p.status,
    port: p.image?.containerPort ?? p.compose!.port,
    healthPath: p.image ? p.image.healthPath : p.compose!.healthPath,
    routedContainer: p.kind === 'image' ? p.name : composeRoutedContainer(p.name),
    dataHostPath: `${s.files.dir(p.name)}/${DATA_DIR}`,
    image: p.image
      ? {
          imageRef: p.image.imageRef,
          repository: parseImageRef(p.image.imageRef).repository,
          tag: parseImageRef(p.image.imageRef).tag,
          currentDigest: p.image.currentDigest,
          memLimit: p.image.memLimit,
          dataOwner: p.image.dataOwner,
          registry: registry ? { id: registry.id, name: registry.name, host: registry.host, hasLogin: Boolean(registry.username && registry.hasToken) } : null,
          registryIdSet: p.image.registryId !== null,
        }
      : null,
    compose,
    env: s.env.list(p.id).map((e) => ({ key: e.key, isSecret: e.isSecret })),
    hasWebhook: p.hasWebhook,
    pendingChanges: s.deploys.drift(p.id).pendingChanges,
    lastDeploy: last
      ? { id: last.id, status: last.status, trigger: last.trigger, digest: last.digest, failureReason: last.failureReason, finishedAt: last.finishedAt }
      : null,
  };
}

/** The container paths a service mounts `./data` at, from checked compose volumes. */
function dataTargets(volumes: unknown): string[] {
  if (!Array.isArray(volumes)) return [];
  return volumes.flatMap((v) => {
    if (typeof v === 'string') {
      const [source, target] = v.split(':');
      return target && source && BIND_SOURCES.has(source) ? [target] : [];
    }
    const o = v as { type?: string; source?: string; target?: string };
    return o.type === 'bind' && o.source && BIND_SOURCES.has(o.source) && o.target ? [o.target] : [];
  });
}

// Rendering

const c = (s: string | number) => `\`${s}\``;
const list = (items: Iterable<string>) => [...items].map(c).join(', ');
const either = (items: Iterable<string>) => [...items].map(c).join(' or ');
/** A GitHub Actions `${{ … }}` expression, kept out of JS template interpolation. */
const gh = (expr: string) => `\${{ ${expr} }}`;
const kib = (bytes: number) => `${bytes / 1024} KiB`;

type Kind = ProjectKind | 'both';

export type GuideOptions = { ctx: GuideContext; kind?: ProjectKind; project?: ProjectSnapshot };

/** The deploy guide as markdown: general, for one kind, or filled in for one project. */
export function renderDeployGuide({ ctx, kind, project }: GuideOptions): string {
  const k: Kind = project?.kind ?? kind ?? 'both';
  const name = project?.name ?? '<project>';
  const title = project ? `Deploying ${project.name} (${project.kind} project) to Vibeship` : `Deploying to Vibeship${kind ? ` (${kind} projects)` : ''}`;
  const sections = [
    `# ${title}`,
    'Everything here is generated from the constants and settings the deploy code uses. Secret values, webhook URLs, API tokens and registry passwords never appear in it.',
    ...(project ? [projectSection(project, ctx)] : []),
    imageSection(k, name),
    dataSection(k, name, ctx, project),
    envSection(k, name, ctx),
    networkSection(k, name, ctx),
    healthSection(k, name, ctx, project),
    ...(k === 'image' ? [] : [composeSection(name)]),
    webhookSection(k, name, project),
    troubleshootingSection(k, name, ctx),
  ];
  return `${sections.join('\n\n')}\n`;
}

function imageSection(k: Kind, name: string): string {
  const repo = exampleRepository(name);
  const lines = ['## Image and registry'];
  if (k !== 'compose') {
    lines.push(
      `- **One image per project**, by convention at ${c(repo)}, pushed by CI with two tags: ${c(':latest')} and ${c(':<git sha>')}. Create the project with ${c(`imageRef: "${repo}:latest"`)}. Vibeship doesn't enforce the path: any \`imageRef\` without a digest works, such as \`host/path/name:tag\` (255 characters at most; the tag defaults to \`latest\`).`,
      `- **Pinned by digest.** A deploy resolves one digest and writes ${c(`image: ${pinned(repo, 'sha256:…')}`)} into the project's ${c(COMPOSE_FILE)}. A webhook or \`deploy\` with \`digest\` pulls exactly \`<repository>@<digest>\`, ignoring the tag. \`deploy\` without a digest pulls the tag in \`imageRef\` and pins whatever digest it resolves to. The live digest is \`project.image.currentDigest\` in \`get_project\`.`,
      '- **registryId and pull credentials.** The pull uses the registry `registryId` names, if set. Otherwise it uses the registry whose host matches the image\'s first path segment (a segment counts as a host when it contains `.` or `:` or is `localhost`). With no match, or a registry without a login, the pull is anonymous. `list_registries` shows each registry\'s id, host and whether a token is set; tokens are never returned.',
      '- Credentials are written to a throwaway Docker config for the length of the pull and deleted afterwards. The deploy log says `Pulling <ref> as <username>` when a login was used and `Pulling <ref>` when the pull is anonymous.',
      '- Build for `linux/amd64`, the architecture of the server (`platforms` in the example workflow). Vibeship never builds images.',
    );
  }
  if (k !== 'image') {
    lines.push(
      '- **Compose projects** pull every image in the file with `docker compose pull`, using the login of every registry that has one. Compose images are pinned by tag, not by digest: a compose project\'s version is its saved, numbered compose file, and each deploy pulls its tags again. Falling back to an earlier compose version does not pull, so it runs whatever those tags point at locally, which may be the image the failed deploy just pulled. `build:` is refused, so push images first.',
    );
  }
  return lines.join('\n');
}

function dataSection(k: Kind, name: string, ctx: GuideContext, project?: ProjectSnapshot): string {
  const host = project?.dataHostPath ?? `${ctx.projectDir(name)}/${DATA_DIR}`;
  const lines = ['## Persistent data', `- Each project has one host folder for data, ${c(host)} (\`<STACK_ROOT>/<project>/${DATA_DIR}\`). Vibeship creates it before the first start.`];
  if (k !== 'compose') {
    lines.push(`- **Image projects:** the folder is mounted read-write at ${c(IMAGE_DATA_MOUNT)} (${c(`./${DATA_DIR}:${IMAGE_DATA_MOUNT}`)} in the generated file). It is the only path that persists. Write databases, uploads and other state under ${c(IMAGE_DATA_MOUNT)}. Image projects cannot declare other volumes.`);
  }
  if (k !== 'image') {
    lines.push(
      `- **Compose projects** mount it themselves: a bind mount whose source is exactly ${either(BIND_SOURCES)}, at any absolute container path, e.g. ${c(`./${DATA_DIR}:/var/lib/app`)} or ${c(`./${DATA_DIR}:/seed:ro`)}. Paths inside it (\`./${DATA_DIR}/x\`), absolute paths, \`~\` and every other relative path are refused, because a container could plant a symlink that a later deploy follows out to the host. For anything else, use a named volume declared under top-level \`volumes\` (only ${list(TOP_VOLUME_KEYS)} allowed; no \`driver\`, \`name\` or \`external\`), or an anonymous volume (\`- /path\`). \`$\` is refused in volumes.`,
    );
  }
  lines.push(
    `- **Ownership.** Vibeship runs as root and creates ${c(DATA_DIR + '/')} without changing its mode, so by default the folder belongs to root (with the usual umask, only root can write to it). A process running as a non-root user cannot write to it until it is chowned.`,
  );
  if (k !== 'compose') {
    lines.push(
      `- **\`dataOwner\` (image projects).** If the image runs as a non-root user (a \`USER\` line; \`USER node\` in the official Node images is uid 1000), set ${c('dataOwner: "<uid>:<gid>"')} on \`create_project\` or \`update_project\`, e.g. ${c('dataOwner: "1000:1000"')}. Each deploy then gives ${c(DATA_DIR + '/')} to that owner before starting the container, and logs ${c(dataOwnerLogLine('<uid>:<gid>'))}. If the folder had a different owner (the first deploy after setting or changing it), everything inside is chowned too, so files an earlier version wrote as root become writable; otherwise only the folder itself is, so deploys stay cheap. Symlinks are never followed and nothing outside ${c(DATA_DIR + '/')} is touched. Changing \`dataOwner\` is a pending change (\`drift.pendingChanges: true\`) and applies on the next deploy, like env. It does not set \`user:\` on the container: the image's own \`USER\` still decides who runs. \`null\` (the default) leaves the owner alone: a new folder stays owned by root, and clearing \`dataOwner\` does not give it back to root (chown it by hand if needed).`,
      `- If the chown fails, the deploy fails before anything is started, with ${c(dataOwnerFailure('<uid>:<gid>') + ': <reason>')}, and the running version keeps serving.`,
      `- **A \`chown\` in the Dockerfile has no effect on ${c(IMAGE_DATA_MOUNT)}:** the bind mount hides whatever the image had at that path.`,
      `- **If you can't use \`dataOwner\`** (for example the app picks its uid at runtime), leave \`USER\` out of the Dockerfile so the container starts as root, and use an entrypoint that chowns ${c(IMAGE_DATA_MOUNT)} and then drops privileges before starting the app, e.g. ${c(`chown -R 1000:1000 ${IMAGE_DATA_MOUNT} && exec setpriv --reuid=1000 --regid=1000 --init-groups node server.js`)} (or \`exec gosu node node server.js\`).`,
    );
  }
  if (k !== 'image') {
    lines.push(`- **Compose projects** have no \`dataOwner\` (it is refused with ${c(`validation: dataOwner: ${COMPOSE_DATA_OWNER_MESSAGE}`)}). A compose service can set \`user:\`; a named volume is the alternative for a non-root service.`);
  }
  lines.push(
    '- **What survives:**',
    `  - *A redeploy:* ${c(DATA_DIR + '/')} and named volumes survive. A deploy runs \`docker compose up -d\`, which recreates a container whose image or config changed, and everything outside the mounts is lost when that happens. A failed deploy's fallback does not roll data back: the previous version sees whatever the failed one wrote.`,
    '  - *`restart`, `stop` and `start`:* the same containers are restarted, so everything survives, including the container filesystem.',
    `  - *\`delete_project\`:* containers, route, rows, ${c(COMPOSE_FILE)} and ${c(ENV_FILE)} are removed; ${c(DATA_DIR + '/')} and named volumes are **kept**. A project created later with the same name finds them again. \`deleteData: true\` also runs \`docker compose down --volumes\` and deletes the whole project folder.`,
  );
  return lines.join('\n');
}

function envSection(k: Kind, name: string, ctx: GuideContext): string {
  const lines = [
    '## Env vars and secrets',
    '- `set_env { project, set: { KEY: { value, secret? } }, unset: [KEY] }` sets some keys and removes others; keys it doesn\'t mention are left alone. A key cannot be in both `set` and `unset`. It returns every key, with secret values as `null`.',
    `- Keys must match ${c(ENV_KEY_PATTERN.source)}. Names starting with ${RESERVED_ENV_PREFIXES.map((p) => c(p + '*')).join(' or ')} (any case) are refused, because compose reads them as its own settings. Values can be up to ${kib(ENV_VALUE_MAX_BYTES)} and must not contain NUL.`,
    '- **Secrets.** Every value is encrypted at rest. A value set with `secret: true` is write-only: no tool, API or UI page ever returns it, and `get_project` shows it as `value: null, isSecret: true`. Set it again to change it. Setting a key without `secret: true` stores it as a plain value.',
    `- **When changes take effect:** on the next deploy, not before. ${c(ENV_FILE)} is written only by a deploy. \`restart\` and \`start\` reuse the existing containers and their environment. \`get_project\` reports \`drift.pendingChanges: true\` while the database differs from what is live. To apply new env without changing version, call \`deploy\` with ${k === 'compose' ? '`composeVersion` set to `project.deployedComposeVersion`' : k === 'image' ? '`digest` set to `project.image.currentDigest`' : '`digest: project.image.currentDigest` (image) or `composeVersion: project.deployedComposeVersion` (compose)'}.${k !== 'compose' ? ' A `deploy` without a digest pulls the tag again and may pick up a newer image.' : ''}`,
    `- **Nothing is injected.** Vibeship sets no variables of its own: there is no \`PORT\`, \`DATA_DIR\`, \`HOST\` or similar. \`PORT\` and \`DATA_DIR\` are ordinary names you may set yourself; only the ${RESERVED_ENV_PREFIXES.map((p) => c(p + '*')).join(' and ')} names are reserved. If the app reads \`PORT\`, set it to the project's port.`,
    `- **Where it lives:** ${c(`${ctx.projectDir(name)}/${ENV_FILE}`)} on the host, mode ${c('0' + ENV_FILE_MODE.toString(8))}. Each deploy writes it from the database with every value decrypted, secrets included. Values are double-quoted and escaped, so \`$\` is literal. Hand edits are overwritten on the next deploy and show up as drift until then.`,
  ];
  if (k !== 'compose') lines.push(`- **Image projects** always load it into the container (${c(`env_file: [${ENV_FILE}]`)}).`);
  if (k !== 'image') {
    lines.push(`- **Compose projects:** a service gets the variables only if it declares ${c(`env_file: ${ENV_FILE}`)}; ${either(ENV_FILES)} are the only values allowed. \`\${VAR}\` anywhere outside ${list(NO_INTERPOLATION_KEYS)} is filled in from the same file, and only from it, so Vibeship's own environment can't leak into a compose file.`);
  }
  return lines.join('\n');
}

function networkSection(k: Kind, name: string, ctx: GuideContext): string {
  const lines = [
    '## Networking',
    `- **Port.** ${k === 'compose' ? '`port`, the routed service\'s port' : k === 'image' ? '`containerPort`' : '`containerPort` (image) or `port`, the routed service\'s port (compose)'} is the port the app listens on inside the container. Caddy proxies to ${c(`${name}:<port>`)} over the ${c(WEB_NETWORK)} network. Listen on all interfaces (\`0.0.0.0\`), not \`127.0.0.1\`: both Caddy and the health check connect over the network.`,
    `- **Hostname.** The default is ${c(`<project>.${ctx.baseDomain}`)}. Override it with \`hostname\` on \`create_project\` or \`update_project\`. It must be exactly one label under ${c(ctx.baseDomain)}, because the TLS certificate covers \`*.${ctx.baseDomain}\` only. The labels ${list(RESERVED_NAMES)} are reserved, and each hostname belongs to one project.`,
    `- A route exists only once the project has a healthy version and isn't stopped. Changes to the hostname or port made with \`update_project\` reach Caddy within ${ROUTE_SYNC_INTERVAL_MS / 1000}s, even before a redeploy, so deploy promptly after changing the port.`,
    `- **Shared network:** ${c(WEB_NETWORK)}, an external Docker network. Caddy, Vibeship and each project's routed container join it; the routed container joins under the alias ${c('<project>')}.`,
  ];
  if (k !== 'image') {
    lines.push(`- Compose projects: only the routed service joins ${c(WEB_NETWORK)}. Vibeship renames it to the project name, and its container becomes ${c(composeRoutedContainer(name))}. Its original service name stays an alias on the project's own networks, so the other services still reach it by that name. The other services stay on the project's default network, or on networks declared under top-level \`networks\` (only ${list(TOP_NETWORK_KEYS)} allowed). You can't declare or join ${c(WEB_NETWORK)} yourself.`);
  }
  lines.push(
    `- **Nothing publishes on 0.0.0.0.** Caddy is the only process that listens publicly: port ${CADDY_PUBLIC_PORT['origin-cert']} in production (TLS with the Cloudflare origin certificate), or ${CADDY_PUBLIC_PORT.off} when TLS is off on local runs. ${k !== 'compose' ? 'Image projects have no `ports`. ' : ''}${k !== 'image' ? `Compose \`ports\` must bind ${c(LOOPBACK)}, as in ${c(`"${LOOPBACK}:8080:80"`)} or with \`host_ip: ${LOOPBACK}\`. ` : ''}HTTP traffic never needs a published port.`,
    `- **Reaching other projects:** from a routed container, use ${c('http://<other-project>:<its port>')} over ${c(WEB_NETWORK)} (plain HTTP), or the other project's public \`https://<hostname>\`. ${k !== 'image' ? 'A compose project\'s non-routed services are not on `web` and can reach other projects only through public hostnames. ' : ''}Every routed container can reach every other one on ${c(WEB_NETWORK)}, Vibeship included, and Vibeship's API still requires a token.`,
  );
  return lines.join('\n');
}

function healthSection(k: Kind, name: string, ctx: GuideContext, project?: ProjectSnapshot): string {
  const container = project ? c(project.routedContainer) : k === 'image' ? c(name) : k === 'compose' ? c(composeRoutedContainer(name)) : `${c(name)} for image projects, ${c(composeRoutedContainer(name))} for compose`;
  const url = project?.healthPath ? healthUrl(project.name, project.port, project.healthPath) : healthUrl(name, '<port>', '<healthPath>');
  return [
    '## Health checks',
    `- After \`docker compose up -d\`, Vibeship watches the routed container (${container}) every ${HEALTH_POLL_MS / 1000}s for up to **${ctx.healthTimeoutSeconds}s**. That limit is the \`health_timeout_seconds\` admin setting: default ${HEALTH_TIMEOUT_SECONDS.default}, allowed ${HEALTH_TIMEOUT_SECONDS.min} to ${HEALTH_TIMEOUT_SECONDS.max}.`,
    `- **With \`healthPath\`:** a GET request to ${c(url)} from Vibeship over ${c(WEB_NETWORK)}. Each request has a ${PROBE_TIMEOUT_MS / 1000}s timeout and redirects are not followed. Any 2xx or 3xx response counts as healthy. There is no fixed retry count: the request repeats every ${HEALTH_POLL_MS / 1000}s until it succeeds or the deadline passes.`,
    `- **Without \`healthPath\`:** healthy when the image's own \`HEALTHCHECK\` reports healthy. If the image has no HEALTHCHECK, healthy once the container has stayed running for ${HEALTH_STABLE_MS / 1000}s.`,
    '- **Fails at once** (no waiting for the deadline) when the container exits (`container exited with code <n>`), restarts even once (`container crashed and is restarting (last exit code <n>)`), or the image HEALTHCHECK reports unhealthy (`the image HEALTHCHECK reports unhealthy`), with or without a `healthPath`.',
    `- **Timeout:** \`health check timed out after ${ctx.healthTimeoutSeconds}s: <last problem>\`, for example \`… ${url} answered HTTP 404\` or \`… answered ECONNREFUSED\`.`,
    '- **The previous container is replaced in place** before the check, so the app is briefly down, and the route already points at the new container while it is checked. The Caddy route is updated only after the check passes.',
    '- **On failure, the last healthy version comes back.** If nothing was started yet (a failed pull or `docker compose config`), the running version is never touched. Otherwise Vibeship rewrites the last healthy version\'s files, runs `up -d` again and health-checks it (`Bringing back the last healthy version, <digest or compose version>`, then `The last healthy version is serving again`). It renders the **current** env from the database, so if the failure came from an env change, the fallback can fail too. If there is no earlier healthy version, the broken containers are stopped (`No earlier healthy version to bring back; stopping the broken containers`). The deploy is marked `failed` with its `failureReason`, and its logs are kept.',
    '- Deploys of one project run one at a time, oldest first. A deploy cut off by a Vibeship restart is marked failed (`interrupted by restart`), and a `recovery` deploy brings back the last healthy version if it isn\'t running.',
  ].join('\n');
}

function composeSection(name: string): string {
  return [
    '## Compose projects',
    'Vibeship holds the Docker socket, so a compose file amounts to root on the host. Validation is therefore an **allowlist**: any key not listed below is refused, and the error names it, e.g. `validation: services.app.privileged: is not allowed`. The file is checked when saved (`create_project`, `update_compose`) and again at every deploy, then checked by `docker compose config` before anything starts. Docker never sees your text: the file is rewritten from the parsed value.',
    `- **Top level:** ${list(TOP_KEYS)}. \`version\` and \`x-*\` blocks are accepted and dropped. YAML anchors work (up to ${MAX_YAML_ALIASES} aliases); merge keys (\`<<\`) are refused.`,
    `- **Service keys:** ${list(SERVICE_KEYS)}. \`image\` is required.`,
    `  - \`env_file\`: only ${either(ENV_FILES)}.`,
    `  - \`ports\`: bound to ${c(LOOPBACK)} only. In the long form only ${list(PORT_KEYS)} are allowed, \`host_ip\` must be ${c(LOOPBACK)} and \`target\` must be a number.`,
    `  - \`volumes\`: bind mounts of ${either(BIND_SOURCES)} only, declared named volumes, or anonymous volumes. In the long form only ${list(VOLUME_KEYS)} are allowed, with \`type\` set to \`bind\` or \`volume\`.`,
    `  - \`depends_on\`: other services in the file; keys ${list(DEPENDS_KEYS)}; \`condition\` must be one of ${list(CONDITIONS)}.`,
    `  - \`healthcheck\`: ${list(HEALTHCHECK_KEYS)}.`,
    '  - `restart`: `no`, `always`, `unless-stopped` or `on-failure[:N]`.',
    '  - `labels`: anything except `com.docker.*` and `dev.vibeship.*`.',
    '  - `mem_limit`: like `512m` or `1g`. `cpus`: a positive number.',
    `  - \`networks\`: \`default\` or networks declared at the top level, each with only ${list(SERVICE_NETWORK_KEYS)}; never ${c(WEB_NETWORK)}.`,
    `- **\`$\` interpolation** is refused in ${list(NO_INTERPOLATION_KEYS)}, because compose resolves it after the check. Elsewhere it is filled in from the project's ${c(ENV_FILE)}.`,
    `- **Refused**, among others: ${list(REFUSED_SERVICE_KEYS_EXAMPLES)}, as well as top-level keys such as \`configs\` and \`secrets\`, and volumes or networks with \`external\`, \`name\` or a \`driver\`.`,
    '- Names of services, volumes and networks must match `^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$`. `routedService` must be a service in the file. No other service may use the project\'s name, because the routed service is renamed to it.',
    '',
    '**Example** (`routedService: app`, `port: 3000`, `healthPath: /health`; set `DB_PASSWORD` with `set_env` as a secret):',
    '',
    '```yaml',
    exampleCompose(name).trimEnd(),
    '```',
  ].join('\n');
}

/** The compose example in the guide; test/guide.test.ts checks that Vibeship accepts it. */
export function exampleCompose(project: string): string {
  return `services:
  app:
    image: ${exampleRepository(project)}:latest
    env_file: ${ENV_FILE}
    environment:
      DATABASE_URL: postgres://app:\${DB_PASSWORD}@db:5432/app
    volumes:
      - ./${DATA_DIR}:/app/uploads
    depends_on:
      db:
        condition: service_healthy
    restart: unless-stopped
  db:
    image: postgres:17
    environment:
      POSTGRES_USER: app
      POSTGRES_DB: app
      POSTGRES_PASSWORD: \${DB_PASSWORD}
    volumes:
      - dbdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD", "pg_isready", "-U", "app"]
      interval: 5s
      retries: 10
    restart: unless-stopped
volumes:
  dbdata: {}
`;
}

function webhookSection(k: Kind, name: string, project?: ProjectSnapshot): string {
  const repository = project?.image?.repository ?? exampleRepository(name);
  const lines = ['## Webhook and CI'];
  if (k === 'compose') {
    lines.push('Webhooks deploy images that CI pushed, so only image projects have one. A compose project deploys with `update_compose`, then `deploy`. To ship a new app image for a compose project, push the image, then `deploy`: compose pulls the tags again on every deploy.');
    return lines.join('\n');
  }
  lines.push(
    '- `rotate_webhook` (admin scope) creates the project\'s webhook URL, or replaces it; an old URL stops working at once. **The URL is returned only once.** Store it straight away as the `WEBHOOK_URL` repository secret and never print, log or commit it: anyone holding it can deploy the project. Afterwards, `get_project` shows only `hasWebhook: true`.',
    `- CI sends \`POST <webhook URL>\` with \`Content-Type: application/json\` and the body ${c('{"digest":"sha256:<64 hex>","image":"<repository>"}')}. The digest must match ${c(DIGEST_PATTERN.source)}. \`image\` is optional; when sent, it must be the project's repository (${c(repository)}), and a mismatch is refused before anything is queued. The body may be at most ${kib(WEBHOOK_BODY_LIMIT_BYTES)}.`,
    `- The deploy pulls ${c(`${repository}@<digest>`)}, so a digest that isn't in this project's repository fails at the pull, and the running version keeps serving.`,
    '- **Responses:** `202 {"deploy":{"id","status":"queued","digest"}}` means the deploy was only queued, so CI succeeding does not mean the deploy did; check it with `list_deploys`. `400` with `Send JSON like {"digest": "sha256:…"}` means the body was missing or wasn\'t JSON. `400 digest: must be sha256:<64 hex characters>` means a malformed digest. `400 image: this webhook deploys <repository>, not <image>` means the wrong image. `400 The request body is too large`, and `404 Unknown webhook` for a wrong or rotated URL (the same answer for both).',
    `- **Repository secrets:** ${c(CI_SECRETS.username)} and ${c(CI_SECRETS.password)} (a registry login that can push to ${c(repository)}), and ${c(CI_SECRETS.webhook)} (the URL from \`rotate_webhook\`).`,
    '',
    '`.github/workflows/deploy.yml`:',
    '',
    '```yaml',
    githubWorkflow(repository).trimEnd(),
    '```',
  );
  return lines.join('\n');
}

/**
 * The GitHub Actions workflow for an image project: build, push `:latest`
 * and `:<sha>`, check the digest and post it to the webhook without ever
 * printing the URL. `examples/github-actions/deploy.yml` is this with the
 * example repository (a test keeps them equal).
 */
export function githubWorkflow(repository: string): string {
  const host = parseImageRef(`${repository}:latest`).host;
  return `# Builds the app, pushes it with two tags (:latest and :<git sha>) and asks
# Vibeship to deploy that exact digest. Copy it to .github/workflows/deploy.yml
# in the app's repository.
#
# Repository secrets (Settings > Secrets and variables > Actions):
#   ${CI_SECRETS.username}, ${CI_SECRETS.password}  a registry login that can push IMAGE
#   ${CI_SECRETS.webhook}  the URL rotate_webhook returned once. It is a secret:
#                anyone holding it can deploy the project, so never echo it.
#
# The webhook only queues the deploy. Vibeship pulls IMAGE@<digest>, health
# checks it and only then routes traffic to it; if it fails, the previous
# version keeps serving. Check the outcome with list_deploys or get_deploy_logs.
name: Deploy

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read

# One deploy at a time; a newer push waits for the one in flight.
concurrency:
  group: deploy
  cancel-in-progress: false

env:
  IMAGE: ${repository}

jobs:
  deploy:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v5

      - uses: docker/setup-buildx-action@v3

      - uses: docker/login-action@v3
        with:
${host ? `          registry: ${host}\n` : ''}          username: ${gh(`secrets.${CI_SECRETS.username}`)}
          password: ${gh(`secrets.${CI_SECRETS.password}`)}

      - name: Build and push
        id: build
        uses: docker/build-push-action@v6
        with:
          context: .
          push: true
          # The server's architecture.
          platforms: linux/amd64
          # A plain image manifest, without attestations, so the digest is the image's.
          provenance: false
          tags: |
            ${gh('env.IMAGE')}:latest
            ${gh('env.IMAGE')}:${gh('github.sha')}
          cache-from: type=gha
          cache-to: type=gha,mode=max

      - name: Deploy
        shell: bash
        env:
          ${CI_SECRETS.webhook}: ${gh(`secrets.${CI_SECRETS.webhook}`)}
          DIGEST: ${gh('steps.build.outputs.digest')}
        run: |
          set -euo pipefail
          if [[ -z "$${CI_SECRETS.webhook}" ]]; then echo "::error::Add the ${CI_SECRETS.webhook} repository secret"; exit 1; fi
          if [[ ! "$DIGEST" =~ ${DIGEST_PATTERN.source} ]]; then echo "::error::Unexpected image digest: $DIGEST"; exit 1; fi
          body=$(jq -nc --arg digest "$DIGEST" --arg image "$IMAGE" '{digest: $digest, image: $image}')
          # The URL is passed from the environment and never printed.
          curl -fsS --retry 3 -X POST -H 'Content-Type: application/json' -d "$body" "$${CI_SECRETS.webhook}"
          echo
          echo "Queued a deploy of $IMAGE@$DIGEST" >> "$GITHUB_STEP_SUMMARY"
`;
}

function troubleshootingSection(k: Kind, name: string, ctx: GuideContext): string {
  const items: string[] = [];
  if (k !== 'compose') {
    items.push(
      '- **Digest from the wrong image.** The webhook answers `400 image: this webhook deploys <repository>, not <image>` when `image` is sent. Without `image`, the deploy fails at the pull with `docker pull exited with code <n>: <Docker\'s last line>`. Make sure CI pushes to the project\'s `imageRef` repository. Tools: `list_deploys` (`failureReason`), `get_deploy_logs`.',
      '- **Registry 401 / unauthorized.** `docker pull exited with code <n>: <Docker\'s last line>`. Look at the deploy log line before it: `Pulling <ref>` with no `as <username>` means no registry login matched the image host. Check `list_registries` (host, `hasToken`), and set `registryId` with `update_project` if the host doesn\'t match. A login that exists but is rejected needs a new token, which an admin sets under Registries in the UI or with `PATCH /api/registries/:id`. Tools: `get_deploy_logs`, `list_registries`.',
    );
  }
  if (k !== 'image') {
    items.push(
      '- **Compose pull or config failure.** `docker compose --ansi exited with code <n>: <Docker\'s last line>`. Nothing was started, so the running version keeps serving. Tool: `get_deploy_logs`.',
      '- **Compose file refused.** `validation: <path>: <reason>`, e.g. `validation: services.app.privileged: is not allowed`, on `create_project` or `update_compose`. Remove or replace the named key (see Compose projects).',
    );
  }
  items.push(
    `- **Health check timeout.** \`health check timed out after ${ctx.healthTimeoutSeconds}s: <last problem>\`. With \`… answered HTTP <status>\`, the path exists but doesn't return 2xx or 3xx. With \`… answered ECONNREFUSED\` (or another network error), nothing is listening on that port. Tools: \`get_deploy_logs\`, then \`get_container_logs\` for the app's own output.`,
    `- **Port mismatch.** With a \`healthPath\`, it shows up as the timeout above with \`http://${name}:<port>… answered ECONNREFUSED\`. Without one, the deploy passes (the container stays up) but requests to the hostname fail, because Caddy can't connect to \`${name}:<port>\`. Fix the port with \`update_project\` (image) or \`update_compose\` (compose), or make the app listen on the configured port on \`0.0.0.0\`, then deploy. Tools: \`get_project\` (\`project.upstream\`), \`get_container_logs\`.`,
    `- **Permission denied on ${k === 'compose' ? 'the data mount' : IMAGE_DATA_MOUNT}.** The app crashes, so the deploy fails with \`container crashed and is restarting (last exit code <n>)\` or \`container exited with code <n>\`. The "permission denied" text appears only in the app's own logs, because ${c(DATA_DIR + '/')} is owned by root (see Persistent data). ${k === 'compose' ? 'Set `user:` on the service to match the folder, or use a named volume.' : `First fix: ${c(`update_project { dataOwner: "1000:1000" }`)} (the uid:gid the image's \`USER\` runs as), then \`deploy\`; the log shows ${c(dataOwnerLogLine('1000:1000'))}.${k === 'both' ? ' For compose, set `user:` on the service or use a named volume.' : ''}`} Tools: \`get_container_logs\`, \`get_status\`.`,
    '- **Crash on start.** `container exited with code <n>`, or `container crashed and is restarting (last exit code <n>)`. Tool: `get_container_logs` (for compose projects, pass `service` to read a service other than the routed one).',
    '- **`<project> has a deploy in progress; try again when it finishes`** from `restart`, `stop`, `start` or `delete_project`: wait for `get_deploy_logs` to show the deploy as `finished`. **`<project> has not been deployed yet`** from `restart`, `stop` or `start`: deploy first.',
    `- **\`hostname must be a single label under ${ctx.baseDomain}, like app.${ctx.baseDomain}\`**: use one label, e.g. \`${name}.${ctx.baseDomain}\`.`,
    '- **Is it live?** `get_status` shows the containers as Docker reports them, `liveVersion` and the last deploy. `list_deploys` shows recent deploys with `failureReason`.',
  );
  return ['## Troubleshooting', ...items].join('\n');
}

function projectSection(p: ProjectSnapshot, ctx: GuideContext): string {
  const lines = [
    `## This project: ${p.name}`,
    `- Kind: ${c(p.kind)}; status: ${c(p.status)}`,
    `- Hostname: ${c(p.hostname)}${p.hostname === `${p.name}.${ctx.baseDomain}` ? ' (the default)' : ''}`,
    `- Port: ${c(p.port)}; Caddy upstream: ${c(`${p.name}:${p.port}`)}; routed container: ${c(p.routedContainer)}`,
    `- Health path: ${p.healthPath ? `${c(p.healthPath)}, checked at ${c(healthUrl(p.name, p.port, p.healthPath))}` : `none, so healthy means the image HEALTHCHECK passes or the container stays up for ${HEALTH_STABLE_MS / 1000}s`}; timeout ${ctx.healthTimeoutSeconds}s`,
  ];
  if (p.image) {
    const reg = p.image.registry;
    lines.push(
      `- Image: ${c(p.image.imageRef)} (repository ${c(p.image.repository)}, tag ${c(p.image.tag)})${p.image.repository === exampleRepository(p.name) ? '' : `. This doesn't follow the ${c(exampleRepository(p.name))} convention, which is fine, but CI must push to this repository`}`,
      `- Live digest: ${p.image.currentDigest ? c(p.image.currentDigest) : 'none yet (never deployed healthy)'}`,
      `- Registry: ${reg ? `${c(reg.name)} (id ${reg.id}, host ${c(reg.host)}, ${p.image.registryIdSet ? 'set by registryId' : 'matched by host'}), ${reg.hasLogin ? 'pulls with its login' : 'no login, so pulls are anonymous'}` : 'none matches, so pulls are anonymous'}`,
      `- Memory limit: ${p.image.memLimit ? c(p.image.memLimit) : 'none'}`,
      `- Data: ${c(p.dataHostPath)} mounted at ${c(IMAGE_DATA_MOUNT)}; data owner: ${p.image.dataOwner ? `${c(p.image.dataOwner)} (applied on each deploy)` : 'not set, so owned by root (set `dataOwner` if the image runs as a non-root user)'}`,
      `- Webhook: ${p.hasWebhook ? 'exists (the URL is not shown; `rotate_webhook` replaces it with a new one)' : 'none yet; create it with `rotate_webhook` (admin) and store the URL as the WEBHOOK_URL repository secret'}`,
    );
  }
  if (p.compose) {
    lines.push(
      `- Compose version: latest ${p.compose.latestVersion}, live ${p.compose.deployedVersion ?? 'none yet'}; routed service ${c(p.compose.routedService)}`,
      `- Data: ${c(p.dataHostPath)}${p.compose.dataMounts.length > 0 ? `, mounted by ${p.compose.dataMounts.map((m) => `${c(m.service)} at ${c(m.target)}`).join(', ')}` : ', not mounted by any service'}`,
      `- Named volumes: ${p.compose.namedVolumes.length > 0 ? list(p.compose.namedVolumes) : 'none'}`,
      '- Webhook: not available for compose projects',
    );
  }
  lines.push(
    `- Env keys: ${p.env.length > 0 ? p.env.map((e) => `${c(e.key)}${e.isSecret ? ' (secret)' : ''}`).join(', ') : 'none'} (values are not shown)`,
    `- Undeployed env or settings changes: ${p.pendingChanges ? 'yes, so deploy to apply them' : 'no'}`,
    `- Last deploy: ${p.lastDeploy ? `#${p.lastDeploy.id} ${c(p.lastDeploy.status)} (${p.lastDeploy.trigger}${p.lastDeploy.digest ? `, ${c(p.lastDeploy.digest)}` : ''}${p.lastDeploy.finishedAt ? `, finished ${p.lastDeploy.finishedAt}` : ''})${p.lastDeploy.failureReason ? `: ${c(p.lastDeploy.failureReason)}` : ''}` : 'none yet'}`,
  );
  return lines.join('\n');
}

/** The MCP server instructions: the contract in short, pointing to the full guide. */
export function serverInstructions(baseDomain: string): string {
  return `Vibeship deploys apps on one server, each at its own hostname (default <project>.${baseDomain}) behind Caddy. Before shipping anything, call get_deploy_guide: it has the full contract, and given a project it fills in that project's real values.

Projects are "image" (one container from a registry image, deployed pinned by digest) or "compose" (a compose file you write, checked against an allowlist).

Image project contract:
- One image per project at ${IMAGE_REPOSITORY_BASE}/<project>, pushed as :latest and :<git sha>; create the project with imageRef <that repository>:latest.
- The app listens on containerPort on 0.0.0.0. Vibeship injects no env vars (no PORT). Only ${IMAGE_DATA_MOUNT} persists.
- If the image runs as a non-root user, set dataOwner (e.g. "1000:1000") so it can write ${IMAGE_DATA_MOUNT}.
- CI POSTs {"digest":"sha256:<64 hex>","image":"<repository>"} as JSON to the project's webhook URL. A request with no JSON body or a malformed digest is rejected (400). "image", if sent, must be the project's repository. The deploy pulls <repository>@<digest>, so a digest from any other repository fails at the pull and the running version keeps serving.

Setup order:
1. create_project.
2. set_env if the app needs config; secret: true values are write-only and never returned.
3. rotate_webhook (admin scope). The URL is shown only once: store it straight away as the ${CI_SECRETS.webhook} repository secret (with ${CI_SECRETS.username} and ${CI_SECRETS.password}) and never print it.
4. Push to trigger the first CI build and webhook deploy (or call deploy).
5. Verify with list_deploys and get_status; read get_deploy_logs if a deploy failed.

deploy returns an id at once: poll get_deploy_logs (pass afterSeq) until healthy or failed. A failed deploy brings back the last healthy version. Env changes apply on the next deploy, not on restart. For debugging, use get_deploy_logs, get_container_logs and get_status.`;
}

/** The ship_new_app prompt: the setup order as steps for an agent. */
export function shipNewAppPrompt(project: string, kind: ProjectKind, baseDomain: string): string {
  const repo = exampleRepository(project);
  const steps = kind === 'image'
    ? [
        `Call get_deploy_guide with { "kind": "image" } and read it, especially "Persistent data", "Env vars and secrets" and "Webhook and CI".`,
        `Check that the app listens on 0.0.0.0 on a fixed port, writes its state only under ${IMAGE_DATA_MOUNT}, and can write there (${IMAGE_DATA_MOUNT} is owned by root unless dataOwner is set). If the Dockerfile has a non-root USER (e.g. USER node, uid 1000), note its uid:gid for dataOwner. If possible, give it an HTTP health endpoint that answers 2xx.`,
        `Call create_project with { "kind": "image", "name": "${project}", "imageRef": "${repo}:latest", "containerPort": <port>, "healthPath": "<path>" }, adding "dataOwner": "<uid>:<gid>" (e.g. "1000:1000") when the image runs as a non-root user. The hostname defaults to ${project}.${baseDomain}. Use list_registries to check that a registry with a login matches the image host.`,
        `Set any configuration with set_env, marking secrets with "secret": true. If the app reads PORT, set it to the same port: Vibeship injects nothing.`,
        `Call rotate_webhook for "${project}" (needs an admin token). The URL is returned only once. Store it straight away as the ${CI_SECRETS.webhook} GitHub repository secret, for example with \`gh secret set ${CI_SECRETS.webhook}\` reading it from stdin, and never print it, log it, commit it or repeat it back.`,
        `Make sure the repository has the ${CI_SECRETS.username} and ${CI_SECRETS.password} secrets for a registry login that can push to ${repo}.`,
        `Call get_deploy_guide with { "project": "${project}" }, and commit its workflow as .github/workflows/deploy.yml.`,
        'Push to main to run the first CI build. The webhook only queues the deploy.',
        `Check it with list_deploys for "${project}" and get_deploy_logs until the status is healthy or failed, then confirm with get_status. If it failed, follow the guide's Troubleshooting section, fix the cause and push again.`,
      ]
    : [
        'Call get_deploy_guide with { "kind": "compose" } and read it, especially "Compose projects" and "Persistent data".',
        `Push every image the file needs (build: is refused). By convention the app image goes to ${repo}.`,
        `Write the compose file within the allowlist: mount ./${DATA_DIR} for persistent files, use named volumes for databases, publish no ports (or only on ${LOOPBACK}), and give services that need the project's env vars \`env_file: ${ENV_FILE}\`.`,
        `Call create_project with { "kind": "compose", "name": "${project}", "composeYaml": <file>, "routedService": <service>, "port": <port>, "healthPath": "<path>" }. The hostname defaults to ${project}.${baseDomain}. If the file is refused, the error names the key; fix it and try again.`,
        'Set any configuration with set_env, marking secrets with "secret": true.',
        `Call deploy for "${project}", then poll get_deploy_logs until the status is healthy or failed, and confirm with get_status.`,
        'To change it later, use update_compose and then deploy. Compose projects have no webhook.',
      ];
  return `Ship a new ${kind} app called "${project}" to Vibeship. Follow these steps in order:\n\n${steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n\nNever output secret env values, the webhook URL, API tokens or registry passwords.`;
}
