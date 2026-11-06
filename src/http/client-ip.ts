import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context } from 'hono';

/** `::ffff:203.0.113.5` and `203.0.113.5` are the same client. */
export function normalizeIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  const v = ip.trim().replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '');
  return isIP(v) ? v.toLowerCase() : null;
}

/**
 * The addresses allowed to tell Vibeship who the client is: Caddy's own.
 * Entries are IPs, or hostnames (Docker service names such as `caddy`)
 * looked up now and every minute, since a container's address can change
 * when it is recreated. Apps share the `web` network with Vibeship and can
 * reach it directly, so a forwarded address from anyone else is ignored.
 */
export class TrustedProxies {
  readonly #literal = new Set<string>();
  readonly #hosts: string[] = [];
  #resolved = new Set<string>();
  #timer: NodeJS.Timeout | undefined;

  constructor(entries: string[]) {
    for (const e of entries) {
      const ip = normalizeIp(e);
      if (ip) this.#literal.add(ip);
      else if (e.trim()) this.#hosts.push(e.trim());
    }
  }

  has(ip: string): boolean {
    return this.#literal.has(ip) || this.#resolved.has(ip);
  }

  /** Looks the hostnames up again; a name that doesn't resolve (not on this network) is skipped. */
  async refresh(): Promise<void> {
    const next = new Set<string>();
    await Promise.all(this.#hosts.map(async (host) => {
      try {
        for (const { address } of await lookup(host, { all: true })) {
          const ip = normalizeIp(address);
          if (ip) next.add(ip);
        }
      } catch {
        // Not resolvable from here, e.g. running outside Docker.
      }
    }));
    this.#resolved = next;
  }

  /** Resolves now and then every `intervalMs`, without keeping the process alive. */
  start(intervalMs = 60_000): void {
    if (this.#hosts.length === 0 || this.#timer) return;
    void this.refresh();
    this.#timer = setInterval(() => void this.refresh(), intervalMs);
    this.#timer.unref();
  }

  stop(): void {
    clearInterval(this.#timer);
    this.#timer = undefined;
  }
}

/**
 * The client address for the audit log and sessions. Caddy works it out
 * (from CF-Connecting-IP when the connection comes from Cloudflare) and
 * sends it as X-Real-Ip; that header counts only when the request really
 * comes from a trusted proxy. Otherwise, the socket peer.
 */
export function clientIp(c: Context, trusted: TrustedProxies): string | null {
  let peer: string | null;
  try {
    peer = normalizeIp(getConnInfo(c).remote.address);
  } catch {
    return null; // No socket, e.g. app.request() in tests.
  }
  if (peer && trusted.has(peer)) {
    const forwarded = normalizeIp(c.req.header('x-real-ip'));
    if (forwarded) return forwarded;
  }
  return peer;
}
