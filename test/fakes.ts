import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import type { CaddyApi, RouteSpec } from '../src/caddy/client.ts';
import type { HttpProbe } from '../src/deploy/health.ts';
import type { CpuTimes, HostSource } from '../src/system/host.ts';
import { parseImageRef } from '../src/docker/image-ref.ts';
import type { ComposeTarget, ContainerState, ContainerStats, ContainerSummary, DockerRunner, LifecycleAction, LineSink, RegistryAuth } from '../src/docker/runner.ts';

/** How a fake image behaves once started. */
export type Behavior = 'healthy' | 'crash' | 'unhealthy' | 'never-starts';

type Image = { repository: string; digest: string; behavior: Behavior };
type Container = { image: string; behavior: Behavior; project: string; stopped?: boolean };

/**
 * A pretend Docker with a built-in registry. Containers behave as their
 * image says; `probe` answers health requests for them.
 */
export class FakeDocker implements DockerRunner {
  readonly #tags = new Map<string, Image>();
  readonly #byDigest = new Map<string, Image>();
  readonly containers = new Map<string, Container>();
  readonly calls: string[] = [];
  readonly pulls: Array<{ ref: string; auth: RegistryAuth | null }> = [];
  /** Lets a test pause inside composeUp, e.g. to observe a deploy mid-flight. */
  onComposeUp: ((target: ComposeTarget) => Promise<void>) | null = null;
  /** Set to make `composeConfig` fail with this message. */
  configError: string | null = null;
  /** The compose.yaml each project was last started or pulled with. */
  readonly composeFiles = new Map<string, string>();

  /** Publishes an image under `repo:tag` and returns its digest. */
  push(refWithTag: string, behavior: Behavior): string {
    const { repository, tag } = parseImageRef(refWithTag);
    const digest = `sha256:${createHash('sha256').update(`${refWithTag}#${behavior}#${this.#tags.size}`).digest('hex')}`;
    const image = { repository, digest, behavior };
    this.#tags.set(`${repository}:${tag}`, image);
    this.#byDigest.set(digest, image);
    return digest;
  }

  async pull(ref: string, auth: RegistryAuth | null, onLine: LineSink): Promise<string> {
    this.calls.push(`pull ${ref}`);
    this.pulls.push({ ref, auth });
    const at = ref.indexOf('@');
    const image = at >= 0 ? this.#byDigest.get(ref.slice(at + 1)) : this.#tags.get(`${parseImageRef(ref).repository}:${parseImageRef(ref).tag}`);
    const repository = at >= 0 ? ref.slice(0, at) : parseImageRef(ref).repository;
    if (!image || image.repository !== repository) throw new Error(`manifest for ${ref} not found`);
    onLine('stdout', `Digest: ${image.digest}`);
    return image.digest;
  }

  /** The image a tag or digest reference points at, if it was pushed. */
  #resolve(ref: string): Image | undefined {
    const at = ref.indexOf('@');
    if (at >= 0) {
      const image = this.#byDigest.get(ref.slice(at + 1));
      return image?.repository === ref.slice(0, at) ? image : undefined;
    }
    const { repository, tag } = parseImageRef(ref);
    return this.#tags.get(`${repository}:${tag}`);
  }

  /** Each service in the project's compose file: its container name and image. */
  #services(target: ComposeTarget): Array<{ container: string; image: string }> {
    const text = readFileSync(join(target.dir, 'compose.yaml'), 'utf8');
    this.composeFiles.set(target.project, text);
    const file = parse(text) as { services: Record<string, { image: string; container_name?: string }> };
    return Object.entries(file.services).map(([name, svc]) => ({
      container: svc.container_name ?? `${target.project}-${name}-1`,
      image: svc.image,
    }));
  }

  async composeConfig(target: ComposeTarget): Promise<void> {
    this.calls.push(`config ${target.project}`);
    if (this.configError) throw new Error(this.configError);
  }

  async composePull(target: ComposeTarget, _auths: RegistryAuth[], onLine: LineSink): Promise<void> {
    this.calls.push(`compose-pull ${target.project}`);
    for (const { image } of this.#services(target)) {
      if (!this.#resolve(image)) throw new Error(`pull access denied for ${image}`);
      onLine('stderr', `${image} Pulled`);
    }
  }

  async composeUp(target: ComposeTarget, onLine: LineSink): Promise<void> {
    this.calls.push(`up ${target.project}`);
    await this.onComposeUp?.(target);
    const services = this.#services(target);
    // Like `up --remove-orphans`: containers of services no longer in the file go away.
    for (const [name, c] of this.containers) if (c.project === target.project) this.containers.delete(name);
    for (const { container, image } of services) {
      const found = this.#resolve(image);
      if (!found) throw new Error(`No such image: ${image}`);
      this.containers.set(container, { image, behavior: found.behavior, project: target.project });
      onLine('stderr', `Container ${container} Started`);
    }
  }

  async composeDown(target: ComposeTarget, _onLine?: LineSink, opts: { volumes?: boolean } = {}): Promise<void> {
    this.calls.push(`down ${target.project}${opts.volumes ? ' --volumes' : ''}`);
    for (const [name, c] of this.containers) if (c.project === target.project) this.containers.delete(name);
  }

  async composeLifecycle(target: ComposeTarget, action: LifecycleAction): Promise<void> {
    this.calls.push(`${action} ${target.project}`);
    const own = [...this.containers.values()].filter((c) => c.project === target.project);
    if (own.length === 0) throw new Error(`no containers for project ${target.project}`);
    for (const c of own) c.stopped = action === 'stop';
  }

  async projectContainers(project: string): Promise<ContainerSummary[]> {
    return [...this.containers.entries()]
      .filter(([, c]) => c.project === project)
      .map(([name, c]) => ({
        name,
        service: name === project ? project : name.slice(project.length + 1).replace(/-\d+$/, ''),
        state: c.stopped ? 'exited' : 'running',
        status: c.stopped ? 'Exited (0)' : 'Up',
        image: c.image,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Log lines per container name, for `containerLogs`. */
  readonly logLines = new Map<string, Array<{ stream: 'stdout' | 'stderr'; line: string }>>();

  async containerLogs(name: string, opts: { tail: number; follow: boolean; signal?: AbortSignal }, onLine: LineSink): Promise<void> {
    if (!this.containers.has(name) && !this.logLines.has(name)) throw new Error(`No such container: ${name}`);
    for (const { stream, line } of (this.logLines.get(name) ?? []).slice(-opts.tail)) onLine(stream, line);
  }

  async inspectContainer(name: string): Promise<ContainerState | null> {
    const c = this.containers.get(name);
    if (!c) return null;
    const base = { image: c.image, health: null, exitCode: 0, restartCount: 0 };
    if (c.stopped) return { ...base, status: 'exited' };
    switch (c.behavior) {
      case 'crash':
        return { ...base, status: 'restarting', exitCode: 1, restartCount: 1 };
      case 'never-starts':
        return { ...base, status: 'created' };
      default:
        return { ...base, status: 'running' };
    }
  }

  /** Resource use per container name; running containers not listed here use 1% CPU and 64 MiB. */
  readonly stats = new Map<string, { cpuPercent: number; memBytes: number }>();
  /** Set to make `containerStats` fail with this message. */
  statsError: string | null = null;

  async containerStats(): Promise<ContainerStats[]> {
    if (this.statsError) throw new Error(this.statsError);
    return [...this.containers.entries()]
      .filter(([, c]) => !c.stopped)
      .map(([name, c]) => {
        const s = this.stats.get(name) ?? { cpuPercent: 1, memBytes: 64 * 1024 ** 2 };
        return {
          name,
          project: c.project,
          service: name === c.project ? c.project : name.slice(c.project.length + 1).replace(/-\d+$/, ''),
          ...s,
          memLimitBytes: 8 * 1024 ** 3,
          netRxBytes: 1000,
          netTxBytes: 2000,
          pids: 3,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** The digest the named container is running, if any. */
  runningDigest(name: string): string | undefined {
    const image = this.containers.get(name)?.image;
    return image?.slice(image.indexOf('@') + 1);
  }

  readonly probe: HttpProbe = async (url) => {
    const host = new URL(url).hostname;
    // `<project>` is an image project's container, or a compose project's routed one.
    const c = this.containers.get(host) ?? this.containers.get(`${host}-${host}-1`);
    if (!c) return { ok: false, detail: 'ENOTFOUND' };
    return c.behavior === 'healthy' ? { ok: true, detail: 'HTTP 200' } : { ok: false, detail: 'HTTP 500' };
  };
}

/** A VM whose CPU and memory a test sets: every reading advances the CPU counters at `cpuPercent`. */
export class FakeHost implements HostSource {
  cpuPercent = 25;
  coreCount = 4;
  totalBytes = 8 * 1024 ** 3;
  availableBytes = 6 * 1024 ** 3;
  settleMs = 0;
  #times: CpuTimes = { idle: 0, total: 0 };

  cpuTimes(): CpuTimes {
    this.#times = { idle: this.#times.idle + 1000 * (1 - this.cpuPercent / 100), total: this.#times.total + 1000 };
    return this.#times;
  }
  memory() { return { totalBytes: this.totalBytes, availableBytes: this.availableBytes }; }
  cores() { return this.coreCount; }
  load(): [number, number, number] { return [0.5, 0.4, 0.3]; }
  uptimeSeconds() { return 3600; }
}

export class FakeCaddy implements CaddyApi {
  readonly routes = new Map<number, RouteSpec>();
  down = false;

  async upsertRoute(route: RouteSpec): Promise<void> {
    if (this.down) throw new Error('connect ECONNREFUSED');
    this.routes.set(route.routeId, route);
  }

  async deleteRoute(routeId: number): Promise<void> {
    if (this.down) throw new Error('connect ECONNREFUSED');
    this.routes.delete(routeId);
  }

  async reconcile(routes: RouteSpec[]): Promise<boolean> {
    if (this.down) throw new Error('connect ECONNREFUSED');
    const before = JSON.stringify([...this.routes.values()]);
    this.routes.clear();
    for (const r of routes) this.routes.set(r.routeId, r);
    return before !== JSON.stringify([...this.routes.values()]);
  }
}
