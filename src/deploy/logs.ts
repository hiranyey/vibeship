import type { Db } from '../db/db.ts';

export type LogStream = 'stdout' | 'stderr' | 'system';
export type LogLine = { seq: number; ts: string; stream: LogStream; line: string };

const MAX_LINE = 8 * 1024;
const MAX_LINES_PER_DEPLOY = 20_000;

/** Appends to and reads `deploy_logs`. Lines are numbered per deploy so readers can resume with `afterSeq`. */
export class DeployLogs {
  readonly #db: Db;
  readonly #nextSeq = new Map<number, number>();

  constructor(db: Db) {
    this.#db = db;
  }

  append(deployId: number, stream: LogStream, line: string): void {
    let seq = this.#nextSeq.get(deployId);
    if (seq === undefined) {
      seq = (this.#db.get<{ s: number | null }>('SELECT max(seq) AS s FROM deploy_logs WHERE deploy_id = ?', deployId)?.s ?? 0) + 1;
    }
    if (seq > MAX_LINES_PER_DEPLOY) return;
    const text = seq === MAX_LINES_PER_DEPLOY ? '[log truncated]' : line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)}…` : line;
    this.#db.run('INSERT INTO deploy_logs (deploy_id, seq, stream, line) VALUES (?, ?, ?, ?)', deployId, seq, stream === 'system' || seq === MAX_LINES_PER_DEPLOY ? 'system' : stream, text);
    this.#nextSeq.set(deployId, seq + 1);
  }

  /** Forgets the cached counter once a deploy finishes. */
  close(deployId: number): void {
    this.#nextSeq.delete(deployId);
  }

  list(deployId: number, afterSeq = 0, limit = 1000): LogLine[] {
    return this.#db.all<LogLine>(
      'SELECT seq, ts, stream, line FROM deploy_logs WHERE deploy_id = ? AND seq > ? ORDER BY seq LIMIT ?',
      deployId, afterSeq, Math.min(limit, 5000),
    );
  }
}
