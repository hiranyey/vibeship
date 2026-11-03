import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { parseImageRef } from './image-ref.ts';
import type { ComposeTarget, ContainerState, DockerRunner, LineSink, RegistryAuth } from './runner.ts';

type RunResult = { code: number; stdout: string[]; stderr: string[] };

/** Runs a `docker` command, streaming each output line to `onLine` and collecting it. */
function docker(
  args: string[],
  opts: { onLine?: LineSink; env?: NodeJS.ProcessEnv; signal?: AbortSignal; keepOutput?: boolean } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, {
      env: { ...process.env, ...opts.env },
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
    // Credentials go in a throwaway DOCKER_CONFIG so they never persist on disk.
    const configDir = auth ? mkdtempSync(join(tmpdir(), 'vibeship-docker-')) : null;
    try {
      if (auth && configDir) {
        const token = Buffer.from(`${auth.username}:${auth.password}`).toString('base64');
        writeFileSync(join(configDir, 'config.json'), JSON.stringify({ auths: { [auth.host]: { auth: token } } }), { mode: 0o600 });
      }
      const args = ['pull', ref];
      const r = await docker(args, { onLine, env: configDir ? { DOCKER_CONFIG: configDir } : {} });
      if (r.code !== 0) throw failure(args, r);

      const pinned = /@(sha256:[a-f0-9]{64})$/.exec(ref)?.[1];
      if (pinned) return pinned;
      const reported = r.stdout.map((l) => /^Digest: (sha256:[a-f0-9]{64})$/.exec(l)?.[1]).find(Boolean);
      if (reported) return reported;
      return await this.#repoDigest(ref);
    } finally {
      if (configDir) rmSync(configDir, { recursive: true, force: true });
    }
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

  async composeDown(target: ComposeTarget, onLine: LineSink): Promise<void> {
    const args = composeArgs(target, 'down', '--remove-orphans');
    const r = await docker(args, { onLine });
    if (r.code !== 0) throw failure(args, r);
  }

  async containerLogs(name: string, opts: { tail: number; follow: boolean; signal?: AbortSignal }, onLine: LineSink): Promise<void> {
    const args = ['logs', '--tail', String(opts.tail), '--timestamps', ...(opts.follow ? ['--follow'] : []), name];
    const r = await docker(args, { onLine, signal: opts.signal, keepOutput: false });
    if (opts.signal?.aborted) return;
    if (r.code !== 0) throw failure(args, r);
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
