import type { ContainerStats, DockerRunner } from '../docker/runner.ts';
import type { HostMonitor, HostPoint, HostSnapshot } from '../system/host.ts';
import type { ProjectService } from './projects.ts';

/** One project's share of the machine, summed over its running containers. */
export type ProjectUsage = {
  project: string;
  /** Percent of one core, summed: 150 is one and a half cores. */
  cpuPercent: number;
  /** Share of the whole machine's CPU, 0–100. */
  cpuShare: number;
  memBytes: number;
  /** Share of the machine's memory, 0–100. */
  memShare: number;
  containers: number;
};

export type MetricsOverview = {
  host: HostSnapshot;
  history: HostPoint[];
  /** Every project with running containers, busiest CPU first. */
  projects: ProjectUsage[];
  /** All Vibeship projects together. */
  apps: { cpuShare: number; memBytes: number; memShare: number };
  /** Set when Docker could not be asked; host figures are still there. */
  dockerError: string | null;
};

export type ProjectMetrics = {
  host: HostSnapshot;
  usage: ProjectUsage;
  containers: Array<ContainerStats & { cpuShare: number; memShare: number }>;
  dockerError: string | null;
};

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * CPU and memory: the VM from HostMonitor, containers from `docker stats`.
 * `docker stats` takes a second or two, so its result is shared for a few
 * seconds and between concurrent callers.
 */
export class MetricsService {
  readonly #docker: DockerRunner;
  readonly #host: HostMonitor;
  readonly #projects: ProjectService;
  readonly #ttlMs: number;
  #cache: { at: number; result: Promise<ContainerStats[]> } | null = null;

  constructor(deps: { docker: DockerRunner; host: HostMonitor; projects: ProjectService; ttlMs?: number }) {
    this.#docker = deps.docker;
    this.#host = deps.host;
    this.#projects = deps.projects;
    this.#ttlMs = deps.ttlMs ?? 3000;
  }

  #stats(): Promise<ContainerStats[]> {
    const now = Date.now();
    if (!this.#cache || now - this.#cache.at > this.#ttlMs) {
      const result = this.#docker.containerStats();
      // A failure isn't kept, so the next call tries again.
      result.catch(() => { if (this.#cache?.result === result) this.#cache = null; });
      this.#cache = { at: now, result };
    }
    return this.#cache.result;
  }

  async #both(): Promise<{ host: HostSnapshot; stats: ContainerStats[]; dockerError: string | null }> {
    const [host, stats] = await Promise.all([
      this.#host.sample(),
      this.#stats().then((s) => ({ s, err: null }), (err: Error) => ({ s: [] as ContainerStats[], err: err.message })),
    ]);
    return { host, stats: stats.s, dockerError: stats.err };
  }

  #usage(project: string, containers: ContainerStats[], host: HostSnapshot): ProjectUsage {
    const cpuPercent = containers.reduce((a, c) => a + c.cpuPercent, 0);
    const memBytes = containers.reduce((a, c) => a + c.memBytes, 0);
    return {
      project,
      cpuPercent: round1(cpuPercent),
      cpuShare: round1(cpuPercent / Math.max(1, host.cores)),
      memBytes,
      memShare: host.memTotalBytes > 0 ? round1((memBytes / host.memTotalBytes) * 100) : 0,
      containers: containers.length,
    };
  }

  /** The VM, its last hour, and every project's share of it. */
  async overview(): Promise<MetricsOverview> {
    const { host, stats, dockerError } = await this.#both();
    const names = new Set(this.#projects.list().map((p) => p.name));
    const byProject = new Map<string, ContainerStats[]>();
    for (const c of stats) {
      if (!c.project || !names.has(c.project)) continue;
      byProject.set(c.project, [...(byProject.get(c.project) ?? []), c]);
    }
    const projects = [...byProject].map(([name, cs]) => this.#usage(name, cs, host)).sort((a, b) => b.cpuPercent - a.cpuPercent);
    const all = this.#usage('', [...byProject.values()].flat(), host);
    return {
      host,
      history: this.#host.history(),
      projects,
      apps: { cpuShare: all.cpuShare, memBytes: all.memBytes, memShare: all.memShare },
      dockerError,
    };
  }

  /** One project's containers and their share of the VM. */
  async project(projectId: number): Promise<ProjectMetrics> {
    const p = this.#projects.get(projectId);
    const { host, stats, dockerError } = await this.#both();
    const own = stats.filter((c) => c.project === p.name);
    return {
      host,
      usage: this.#usage(p.name, own, host),
      containers: own.map((c) => ({
        ...c,
        cpuShare: round1(c.cpuPercent / Math.max(1, host.cores)),
        memShare: host.memTotalBytes > 0 ? round1((c.memBytes / host.memTotalBytes) * 100) : 0,
      })),
      dockerError,
    };
  }
}
