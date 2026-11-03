import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { parseImageRef } from './image-ref.ts';
import type { ComposeTarget, ContainerState, ContainerSummary, DockerRunner, LifecycleAction, LineSink, RegistryAuth } from './runner.ts';

type RunResult = { code: number; stdout: string[]; stderr: string[] };

/**
 * The only variables `docker` sees from Vibeship's environment. Compose
 * interpolates `${VAR}` in compose files from its environment, so passing
 * everything would hand MASTER_KEY to any compose file that asks for it.
 */
const PASSED_ENV = ['PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CERT_PATH', 'DOCKER_TLS_VERIFY', 'DOCKER_CONFIG'];

export function dockerEnv(extra: NodeJS.ProcessEnv = {}, from: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of PASSED_ENV) if (from[k] !== undefined) env[k] = from[k];
  return { ...env, ...extra };
}

/** Writes registry credentials into a throwaway DOCKER_CONFIG, so they never persist on disk. */
function withAuths<T>(auths: RegistryAuth[], fn: (env: NodeJS.ProcessEnv) => Promise<T>): Promise<T> {
  if (auths.length === 0) return fn({});
  const dir = mkdtempSync(join(tmpdir(), 'vibeship-docker-'));
  const config = {
    auths: Object.fromEntries(auths.map((a) => [a.host, { auth: Buffer.from(`${a.username}:${a.password}`).toString('base64') }])),
  };
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config), { mode: 0o600 });
  return fn({ DOCKER_CONFIG: dir }).finally(() => rmSync(dir, { recursive: true, force: true }));
}

/** Runs a `docker` command, streaming each output line to `onLine` and collecting it. */
function docker(
  args: string[],
  opts: { onLine?: LineSink; env?: NodeJS.ProcessEnv; signal?: AbortSignal; keepOutput?: boolean } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, {
      env: dockerEnv(opts.env),
      stdio: ['ignore', 'pipe', 'pipe'],
      signal: opts.signal,
      killSignal: 'SIGTERM',
    });
    const out: RunResult = { code: 0, stdout: [], stderr: [] };
    const keep = opts.keepOutput ?? true;
    const streams = [['stdout', child.stdout], ['stderr', child.stderr]] as const;
    const closed = streams.map(([name, stream]) =>
      new Promise<void>((done) => {
        const rl = createInterface({ input: stream });
        rl.on('line', (line) => {
          // Long-running streams keep only the last few lines, for error messages.
          if (keep || out[name].length < 20) out[name].push(line);
          else out[name] = [...out[name].slice(1), line];
          opts.onLine?.(name, line);
        });
        rl.on('close', done);
      }),
    );
    child.on('error', (err) => {
      if (err.name === 'AbortError') return; // `close` still fires and resolves
      reject(err);
    });
    child.on('close', async (code) => {
      await Promise.all(closed);
      out.code = code ?? 1;
      resolve(out);
    });
  });
}

function failure(args: string[], r: RunResult): Error {
  const last = r.stderr.filter(Boolean).at(-1) ?? r.stdout.filter(Boolean).at(-1) ?? 'no output';
  return new Error(`docker ${args.slice(0, 2).join(' ')} exited with code ${r.code}: ${last}`);
}

function composeArgs(t: ComposeTarget, ...rest: string[]): string[] {
  return ['compose', '--ansi', 'never', '--progress', 'plain', '-p', t.project, '--project-directory', t.dir, '-f', join(t.dir, 'compose.yaml'), ...rest];
}

export class CliDockerRunner implements DockerRunner {
  async pull(ref: string, auth: RegistryAuth | null, onLine: LineSink): Promise<string> {
    return withAuths(auth ? [auth] : [], async (env) => {
      const args = ['pull', ref];
      const r = await docker(args, { onLine, env });
      if (r.code !== 0) throw failure(args, r);

      const pinned = /@(sha256:[a-f0-9]{64})$/.exec(ref)?.[1];
      if (pinned) return pinned;
      const reported = r.stdout.map((l) => /^Digest: (sha256:[a-f0-9]{64})$/.exec(l)?.[1]).find(Boolean);
      if (reported) return reported;
      return await this.#repoDigest(ref);
    });
  }

  async composeConfig(target: ComposeTarget, onLine: LineSink): Promise<void> {
    const args = composeArgs(target, 'config', '--quiet');
    const r = await docker(args, { onLine });
    if (r.code !== 0) throw failure(args, r);
  }

  async composePull(target: ComposeTarget, auths: RegistryAuth[], onLine: LineSink): Promise<void> {
    await withAuths(auths, async (env) => {
      const args = composeArgs(target, 'pull');
      const r = await docker(args, { onLine, env });
      if (r.code !== 0) throw failure(args, r);
    });
  }

  async #repoDigest(ref: string): Promise<string> {
    const args = ['image', 'inspect', '--format', '{{json .RepoDigests}}', ref];
    const r = await docker(args);
    if (r.code !== 0) throw failure(args, r);
    const { repository } = parseImageRef(ref);
    const digests = JSON.parse(r.stdout.join('')) as string[];
    const match = digests.find((d) => d.startsWith(`${repository}@`));
    if (!match) throw new Error(`Could not find the digest of ${ref} after pulling it`);
    return match.slice(repository.length + 1);
  }

  async composeUp(target: ComposeTarget, onLine: LineSink): Promise<void> {
    const args = composeArgs(target, 'up', '-d', '--remove-orphans');
    const r = await docker(args, { onLine });
    if (r.code !== 0) throw failure(args, r);
  }

  async composeDown(target: ComposeTarget, onLine: LineSink, opts: { volumes?: boolean } = {}): Promise<void> {
    const args = composeArgs(target, 'down', '--remove-orphans', ...(opts.volumes ? ['--volumes'] : []));
    const r = await docker(args, { onLine });
    if (r.code !== 0) throw failure(args, r);
  }

  async containerLogs(name: string, opts: { tail: number; follow: boolean; signal?: AbortSignal }, onLine: LineSink): Promise<void> {
    const args = ['logs', '--tail', String(opts.tail), '--timestamps', ...(opts.follow ? ['--follow'] : []), name];
    const r = await docker(args, { onLine, signal: opts.signal, keepOutput: false });
    if (opts.signal?.aborted) return;
    if (r.code !== 0) throw failure(args, r);
  }

  async composeLifecycle(target: ComposeTarget, action: LifecycleAction, onLine: LineSink): Promise<void> {
    const args = composeArgs(target, action);
    const r = await docker(args, { onLine });
    if (r.code !== 0) throw failure(args, r);
  }

  async projectContainers(project: string): Promise<ContainerSummary[]> {
    const args = ['ps', '--all', '--no-trunc', '--filter', `label=com.docker.compose.project=${project}`, '--format', '{{json .}}'];
    const r = await docker(args);
    if (r.code !== 0) throw failure(args, r);
    return r.stdout.filter(Boolean).map((line) => {
      const c = JSON.parse(line) as { Names: string; State: string; Status: string; Image: string; Labels: string };
      const service = /(?:^|,)com\.docker\.compose\.service=([^,]*)/.exec(c.Labels)?.[1] ?? '';
      return { name: c.Names, service, state: c.State, status: c.Status, image: c.Image };
    }).sort((a, b) => a.name.localeCompare(b.name));
  }

  async inspectContainer(name: string): Promise<ContainerState | null> {
    const args = ['container', 'inspect', name];
    const r = await docker(args);
    if (r.code !== 0) {
      if (r.stderr.some((l) => /no such (container|object)/i.test(l))) return null;
      throw failure(args, r);
    }
    const [c] = JSON.parse(r.stdout.join('\n')) as Array<{
      State: { Status: ContainerState['status']; ExitCode: number; Health?: { Status: string } };
      RestartCount: number;
      Config: { Image: string };
    }>;
    if (!c) return null;
    const health = c.State.Health?.Status;
    return {
      status: c.State.Status,
      health: health === 'starting' || health === 'healthy' || health === 'unhealthy' ? health : null,
      exitCode: c.State.ExitCode,
      restartCount: c.RestartCount,
      image: c.Config.Image,
    };
  }
}
