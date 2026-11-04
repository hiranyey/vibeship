import { setTimeout as sleep } from 'node:timers/promises';
import type { DockerRunner } from '../docker/runner.ts';

/** One HTTP health request. `ok` means a 2xx or 3xx answer. */
export type HttpProbe = (url: string, timeoutMs: number) => Promise<{ ok: boolean; detail: string }>;

export const fetchProbe: HttpProbe = async (url, timeoutMs) => {
  try {
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    await res.body?.cancel();
    return { ok: res.status >= 200 && res.status < 400, detail: `HTTP ${res.status}` };
  } catch (err) {
    const e = err as Error & { cause?: { code?: string } };
    return { ok: false, detail: e.cause?.code ?? e.message };
  }
};

/** How often a deploy checks the container and the health path. */
export const HEALTH_POLL_MS = 1000;
/** Without a health path or HEALTHCHECK, how long the container must stay up. */
export const HEALTH_STABLE_MS = 5000;
/** The longest a single health request may take. */
export const PROBE_TIMEOUT_MS = 3000;

/**
 * The health URL. Vibeship shares the `web` network, so it reaches the app
 * the same way Caddy does: by the `<project>` alias, not through localhost.
 */
export function healthUrl(project: string, port: number | string, healthPath: string): string {
  return `http://${project}:${port}${healthPath}`;
}

export type HealthTiming = {
  timeoutMs: number;
  /** How often to check the container and the health path. */
  pollMs: number;
  /** Without a health path or HEALTHCHECK, how long the container must stay up. */
  stableMs: number;
};

export class HealthCheckFailed extends Error {
  override name = 'HealthCheckFailed';
}

/**
 * Waits until a freshly started container is healthy, or throws
 * HealthCheckFailed. Healthy means, in order of preference: the health path
 * answers 2xx/3xx; the image's own HEALTHCHECK reports healthy; or the
 * container stays running for `stableMs`. A container that exits, restarts or
 * reports unhealthy fails at once rather than waiting for the timeout.
 */
export async function waitHealthy(opts: {
  docker: DockerRunner;
  probe: HttpProbe;
  container: string;
  url: string | null;
  timing: HealthTiming;
  log: (line: string) => void;
}): Promise<void> {
  const { docker, probe, container, url, timing, log } = opts;
  const deadline = Date.now() + timing.timeoutMs;
  let runningSince: number | null = null;
  let lastProblem = 'container not started yet';
  let lastLogged = '';

  log(url ? `Waiting up to ${timing.timeoutMs / 1000}s for ${url} to answer` : `Waiting up to ${timing.timeoutMs / 1000}s for the container to stay up`);
  while (Date.now() < deadline) {
    const state = await docker.inspectContainer(container);
    if (state) {
      if (state.status === 'exited' || state.status === 'dead') {
        throw new HealthCheckFailed(`container exited with code ${state.exitCode}`);
      }
      if (state.status === 'restarting' || state.restartCount > 0) {
        throw new HealthCheckFailed(`container crashed and is restarting (last exit code ${state.exitCode})`);
      }
      if (state.health === 'unhealthy') throw new HealthCheckFailed('the image HEALTHCHECK reports unhealthy');

      if (state.status === 'running') {
        runningSince ??= Date.now();
        if (url) {
          const r = await probe(url, Math.min(PROBE_TIMEOUT_MS, timing.timeoutMs));
          if (r.ok) return log(`Healthy: ${url} answered ${r.detail}`);
          lastProblem = `${url} answered ${r.detail}`;
        } else if (state.health === 'healthy') {
          return log('Healthy: the image HEALTHCHECK reports healthy');
        } else if (state.health === 'starting') {
          lastProblem = 'the image HEALTHCHECK is still starting';
        } else if (Date.now() - runningSince >= timing.stableMs) {
          return log(`Healthy: the container stayed up for ${timing.stableMs / 1000}s`);
        } else {
          lastProblem = 'container has not been up long enough';
        }
      } else {
        runningSince = null;
        lastProblem = `container is ${state.status}`;
      }
    } else {
      lastProblem = 'container not found';
    }

    if (lastProblem !== lastLogged) {
      log(`Not healthy yet: ${lastProblem}`);
      lastLogged = lastProblem;
    }
    await sleep(Math.max(0, Math.min(timing.pollMs, deadline - Date.now())));
  }
  throw new HealthCheckFailed(`health check timed out after ${timing.timeoutMs / 1000}s: ${lastProblem}`);
}
