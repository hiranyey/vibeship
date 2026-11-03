import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CaddyApi, RouteSpec } from '../src/caddy/client.ts';
import type { HttpProbe } from '../src/deploy/health.ts';
import { parseImageRef } from '../src/docker/image-ref.ts';
import type { ComposeTarget, ContainerState, DockerRunner, LineSink, RegistryAuth } from '../src/docker/runner.ts';

/** How a fake image behaves once started. */
export type Behavior = 'healthy' | 'crash' | 'unhealthy' | 'never-starts';

type Image = { repository: string; digest: string; behavior: Behavior };
type Container = { image: string; behavior: Behavior };

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

  async composeUp(target: ComposeTarget, onLine: LineSink): Promise<void> {
    this.calls.push(`up ${target.project}`);
    await this.onComposeUp?.(target);
    const compose = readFileSync(join(target.dir, 'compose.yaml'), 'utf8');
    const image = /image: "([^"]+)"/.exec(compose)![1]!;
    const behavior = this.#byDigest.get(image.slice(image.indexOf('@') + 1))!.behavior;
    this.containers.set(target.project, { image, behavior });
    onLine('stderr', `Container ${target.project} Started`);
  }

  async composeDown(target: ComposeTarget): Promise<void> {
    this.calls.push(`down ${target.project}`);
    this.containers.delete(target.project);
  }

  async inspectContainer(name: string): Promise<ContainerState | null> {
    const c = this.containers.get(name);
    if (!c) return null;
    const base = { image: c.image, health: null, exitCode: 0, restartCount: 0 };
    switch (c.behavior) {
      case 'crash':
        return { ...base, status: 'restarting', exitCode: 1, restartCount: 1 };
      case 'never-starts':
        return { ...base, status: 'created' };
      default:
        return { ...base, status: 'running' };
    }
  }

  /** The digest the named container is running, if any. */
  runningDigest(name: string): string | undefined {
    const image = this.containers.get(name)?.image;
    return image?.slice(image.indexOf('@') + 1);
  }

  readonly probe: HttpProbe = async (url) => {
    const host = new URL(url).hostname;
    const c = this.containers.get(host);
    if (!c) return { ok: false, detail: 'ENOTFOUND' };
    return c.behavior === 'healthy' ? { ok: true, detail: 'HTTP 200' } : { ok: false, detail: 'HTTP 500' };
  };
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
