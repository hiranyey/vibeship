import { actorLabel, type RequestContext } from '../actor.ts';
import type { SecretBox } from '../crypto/secret-box.ts';
import type { Db } from '../db/db.ts';
import { AppError, notFound } from '../errors.ts';
import { ReplaceEnvInput, SetEnvInput } from '../schemas.ts';
import type { AuditLog } from './audit.ts';
import { parseInput } from './validate.ts';

export type EnvEntry = {
  key: string;
  /** Always null for secrets: they are write-only. */
  value: string | null;
  isSecret: boolean;
  updatedBy: string;
  updatedAt: string;
};

type EnvRow = {
  key: string;
  value_encrypted: string;
  is_secret: 0 | 1;
  updated_by: string;
  updated_at: string;
};

const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;

/** Env vars for a project. Every value is encrypted at rest; secret values are never returned. */
export class EnvService {
  readonly #db: Db;
  readonly #audit: AuditLog;
  readonly #box: SecretBox;

  constructor(deps: { db: Db; audit: AuditLog; box: SecretBox }) {
    this.#db = deps.db;
    this.#audit = deps.audit;
    this.#box = deps.box;
  }

  list(projectId: number): EnvEntry[] {
    this.#checkProject(projectId);
    return this.#rows(projectId).map((r) => ({
      key: r.key,
      value: r.is_secret ? null : this.#box.open(r.value_encrypted, context(projectId, r.key)),
      isSecret: r.is_secret === 1,
      updatedBy: r.updated_by,
      updatedAt: r.updated_at,
    }));
  }

  /** Sets some keys and unsets others; keys not mentioned are left alone. */
  set(ctx: RequestContext, projectId: number, rawInput: unknown): EnvEntry[] {
    const input = parseInput(SetEnvInput, rawInput);
    this.#db.transaction(() => {
      this.#checkProject(projectId);
      for (const [key, { value, secret }] of Object.entries(input.set)) {
        this.#upsert(ctx, projectId, key, value, secret);
      }
      for (const key of input.unset) {
        this.#db.run('DELETE FROM env_vars WHERE project_id = ? AND key = ?', projectId, key);
      }
      this.#audit.record(ctx, 'env.set', `project:${projectId}`, {
        set: Object.keys(input.set),
        unset: input.unset,
      });
    });
    return this.list(projectId);
  }

  /**
   * Replaces the whole set. An existing secret sent without a value keeps its
   * current value, so the UI can save the form without knowing secrets.
   */
  replace(ctx: RequestContext, projectId: number, rawInput: unknown): EnvEntry[] {
    const input = parseInput(ReplaceEnvInput, rawInput);
    this.#db.transaction(() => {
      this.#checkProject(projectId);
      const existing = new Map(this.#rows(projectId).map((r) => [r.key, r]));

      for (const entry of input) {
        if (entry.value !== undefined) {
          this.#upsert(ctx, projectId, entry.key, entry.value, entry.secret);
          continue;
        }
        const current = existing.get(entry.key);
        if (!current?.is_secret || !entry.secret) {
          throw new AppError('validation', `${entry.key}: a value is required unless keeping an existing secret`);
        }
      }

      const kept = new Set(input.map((e) => e.key));
      const removed = [...existing.keys()].filter((k) => !kept.has(k));
      for (const key of removed) {
        this.#db.run('DELETE FROM env_vars WHERE project_id = ? AND key = ?', projectId, key);
      }
      this.#audit.record(ctx, 'env.replace', `project:${projectId}`, {
        set: input.filter((e) => e.value !== undefined).map((e) => e.key),
        kept: input.filter((e) => e.value === undefined).map((e) => e.key),
        unset: removed,
      });
    });
    return this.list(projectId);
  }

  /** Decrypted values, secrets included, for rendering a project's `.env`. Never expose this to callers. */
  resolve(projectId: number): Record<string, string> {
    this.#checkProject(projectId);
    return Object.fromEntries(
      this.#rows(projectId).map((r) => [r.key, this.#box.open(r.value_encrypted, context(projectId, r.key))]),
    );
  }

  #upsert(ctx: RequestContext, projectId: number, key: string, value: string, secret: boolean): void {
    this.#db.run(
      `INSERT INTO env_vars (project_id, key, value_encrypted, is_secret, updated_by)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (project_id, key) DO UPDATE SET
         value_encrypted = excluded.value_encrypted,
         is_secret = excluded.is_secret,
         updated_by = excluded.updated_by,
         updated_at = ${NOW}`,
      projectId, key, this.#box.seal(value, context(projectId, key)), secret ? 1 : 0, actorLabel(ctx.actor),
    );
  }

  #rows(projectId: number): EnvRow[] {
    return this.#db.all<EnvRow>(
      'SELECT key, value_encrypted, is_secret, updated_by, updated_at FROM env_vars WHERE project_id = ? ORDER BY key',
      projectId,
    );
  }

  #checkProject(projectId: number): void {
    if (!this.#db.get('SELECT 1 FROM projects WHERE id = ?', projectId)) throw notFound(`Project ${projectId}`);
  }
}

/** Binds each ciphertext to its row, so values can't be swapped between keys or projects. */
function context(projectId: number, key: string): string {
  return `env:${projectId}:${key}`;
}
