import { readFileSync } from 'node:fs';
import os from 'node:os';

/**
 * CPU and memory of the machine Vibeship runs on. Vibeship runs in a
 * container, but `/proc/stat` and `/proc/meminfo` are not namespaced, so
 * they describe the whole VM, which is what we want here. Elsewhere (macOS
 * in development) Node's `os` module stands in.
 */

export type CpuTimes = { idle: number; total: number };

export type HostSnapshot = {
  /** Busy share of all cores since the previous sample, 0–100. */
  cpuPercent: number;
  cores: number;
  /** 1, 5 and 15 minute load averages. */
  load: [number, number, number];
  memTotalBytes: number;
  /** Total minus what the kernel says is available (page cache counts as free). */
  memUsedBytes: number;
  memPercent: number;
  uptimeSeconds: number;
  /** ISO time of the sample. */
  at: string;
};

export type HostPoint = { at: string; cpuPercent: number; memPercent: number };

export type HostSource = {
  cpuTimes(): CpuTimes;
  memory(): { totalBytes: number; availableBytes: number };
  cores(): number;
  load(): [number, number, number];
  uptimeSeconds(): number;
  /** How long to wait between two CPU readings when there is no recent one; 250 ms by default. */
  settleMs?: number;
};

/** Reads `/proc` when it is there, else `os`. */
export const systemSource: HostSource = {
  cpuTimes() {
    try {
      // First line: "cpu  user nice system idle iowait irq softirq steal guest guest_nice"
      const line = readFileSync('/proc/stat', 'utf8').split('\n', 1)[0]!;
      const f = line.trim().split(/\s+/).slice(1, 9).map(Number);
      const idle = f[3]! + (f[4] ?? 0);
      return { idle, total: f.reduce((a, b) => a + b, 0) };
    } catch {
      let idle = 0;
      let total = 0;
      for (const c of os.cpus()) {
        idle += c.times.idle;
        total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq;
      }
      return { idle, total };
    }
  },
  memory() {
    try {
      const info = readFileSync('/proc/meminfo', 'utf8');
      const kb = (key: string) => Number(new RegExp(`^${key}:\\s+(\\d+)`, 'm').exec(info)?.[1] ?? NaN) * 1024;
      const totalBytes = kb('MemTotal');
      const availableBytes = kb('MemAvailable');
      if (Number.isFinite(totalBytes) && Number.isFinite(availableBytes)) return { totalBytes, availableBytes };
    } catch {
      // Not Linux.
    }
    return { totalBytes: os.totalmem(), availableBytes: os.freemem() };
  },
  cores: () => os.availableParallelism?.() ?? os.cpus().length,
  load: () => os.loadavg() as [number, number, number],
  uptimeSeconds: () => os.uptime(),
};

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Takes host samples. CPU use needs two readings, so each sample is measured
 * against the previous one; with none recent enough, it takes a short one.
 * `start()` samples in the background to keep an hour of history.
 */
export class HostMonitor {
  readonly #source: HostSource;
  readonly #intervalMs: number;
  readonly #keep: number;
  readonly #history: HostPoint[] = [];
  #last: { times: CpuTimes; ms: number } | null = null;
  #latest: HostSnapshot | null = null;
  #timer: NodeJS.Timeout | null = null;
  #pending: Promise<HostSnapshot> | null = null;

  constructor(opts: { source?: HostSource; intervalMs?: number; historyMs?: number } = {}) {
    this.#source = opts.source ?? systemSource;
    this.#intervalMs = opts.intervalMs ?? 15_000;
    this.#keep = Math.ceil((opts.historyMs ?? 3_600_000) / this.#intervalMs);
  }

  start(): void {
    if (this.#timer) return;
    void this.sample().then((s) => this.#record(s));
    this.#timer = setInterval(() => void this.sample().then((s) => this.#record(s)), this.#intervalMs);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  /** Samples taken by `start()`, oldest first. */
  history(): HostPoint[] {
    return [...this.#history];
  }

  /** A fresh sample, or the last one if it is under a second old. Concurrent callers share one. */
  sample(): Promise<HostSnapshot> {
    this.#pending ??= this.#take().finally(() => { this.#pending = null; });
    return this.#pending;
  }

  async #take(): Promise<HostSnapshot> {
    const now = Date.now();
    if (this.#latest && now - Date.parse(this.#latest.at) < 1000) return this.#latest;
    if (!this.#last || now - this.#last.ms > 60_000) {
      this.#last = { times: this.#source.cpuTimes(), ms: now };
      await new Promise((r) => setTimeout(r, this.#source.settleMs ?? 250));
    }
    const times = this.#source.cpuTimes();
    const dTotal = times.total - this.#last.times.total;
    const dIdle = times.idle - this.#last.times.idle;
    const cpu = dTotal > 0 ? (1 - dIdle / dTotal) * 100 : (this.#latest?.cpuPercent ?? 0);
    this.#last = { times, ms: Date.now() };
    const mem = this.#source.memory();
    const used = Math.max(0, mem.totalBytes - mem.availableBytes);
    this.#latest = {
      cpuPercent: round1(Math.min(100, Math.max(0, cpu))),
      cores: this.#source.cores(),
      load: this.#source.load().map(round1) as [number, number, number],
      memTotalBytes: mem.totalBytes,
      memUsedBytes: used,
      memPercent: mem.totalBytes > 0 ? round1((used / mem.totalBytes) * 100) : 0,
      uptimeSeconds: Math.round(this.#source.uptimeSeconds()),
      at: new Date().toISOString(),
    };
    return this.#latest;
  }

  #record(s: HostSnapshot): void {
    const last = this.#history.at(-1);
    if (last?.at === s.at) return;
    this.#history.push({ at: s.at, cpuPercent: s.cpuPercent, memPercent: s.memPercent });
    if (this.#history.length > this.#keep) this.#history.splice(0, this.#history.length - this.#keep);
  }
}
