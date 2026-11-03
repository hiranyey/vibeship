import { z } from 'zod';
import { type RequestContext } from '../actor.ts';
import type { SecretBox } from '../crypto/secret-box.ts';
import type { Db } from '../db/db.ts';
import { parseImageRef } from '../docker/image-ref.ts';
import type { RegistryAuth } from '../docker/runner.ts';
import { AppError } from '../errors.ts';
import type { AuditLog } from './audit.ts';
import { parseInput } from './validate.ts';

export const CreateRegistryInput = z
  .object({
    name: z.string().trim().min(1).max(100),
    /** The host images are pulled from, e.g. `https://repoflow.hiranyey.dev` or `localhost:5050`. */
    url: z.string().trim().min(1).max(255),
    username: z.string().min(1).max(255).nullable().optional(),
    token: z.string().min(1).max(4096).nullable().optional(),
  })
  .refine((v) => Boolean(v.username) === Boolean(v.token), 'set both username and token, or neither');

export type Registry = { id: number; name: string; url: string; host: string; username: string | null; hasToken: boolean };

type RegistryRow = { id: number; name: string; url: string; username: string | null; token_encrypted: string | null };

/** `https://host:443/x` and `host:443` both become `host:443`; this is how image references name registries. */
export function registryHost(url: string): string {
  const withScheme = /^[a-z]+:\/\//i.test(url) ? url : `https://${url}`;
  try {
    return new URL(withScheme).host;
  } catch {
    throw new AppError('validation', `url: ${url} is not a registry address`);
  }
}

export class RegistryService {
  readonly #db: Db;
  readonly #audit: AuditLog;
  readonly #box: SecretBox;

  constructor(deps: { db: Db; audit: AuditLog; box: SecretBox }) {
    this.#db = deps.db;
    this.#audit = deps.audit;
    this.#box = deps.box;
  }

  list(): Registry[] {
    return this.#db.all<RegistryRow>('SELECT * FROM registries ORDER BY name').map((r) => this.#view(r));
  }

  create(ctx: RequestContext, rawInput: unknown): Registry {
    const input = parseInput(CreateRegistryInput, rawInput);
    const host = registryHost(input.url);
    return this.#db.transaction(() => {
      if (this.#db.get('SELECT 1 FROM registries WHERE name = ?', input.name)) {
        throw new AppError('conflict', `A registry named "${input.name}" already exists`);
      }
      if (this.list().some((r) => r.host === host)) throw new AppError('conflict', `A registry for ${host} already exists`);
      const { lastInsertRowid: id } = this.#db.run(
        'INSERT INTO registries (name, url, username) VALUES (?, ?, ?)',
        input.name, input.url, input.username ?? null,
      );
      if (input.token) {
        this.#db.run('UPDATE registries SET token_encrypted = ? WHERE id = ?', this.#box.seal(input.token, `registry:${id}`), id);
      }
      this.#audit.record(ctx, 'registry.create', `registry:${id}`, { name: input.name, host });
      return this.#view(this.#db.get<RegistryRow>('SELECT * FROM registries WHERE id = ?', id)!);
    });
  }

  /**
   * Credentials for pulling `imageRef`: from the project's registry if it has
   * one, otherwise from the registry whose host matches the image. Null means
   * an anonymous pull.
   */
  authFor(imageRef: string, registryId: number | null): RegistryAuth | null {
    const { host } = parseImageRef(imageRef);
    const rows = registryId != null
      ? this.#db.all<RegistryRow>('SELECT * FROM registries WHERE id = ?', registryId)
      : this.#db.all<RegistryRow>('SELECT * FROM registries');
    const row = rows.find((r) => registryId != null || registryHost(r.url) === host);
    if (!row?.username || !row.token_encrypted) return null;
    return {
      host: host ?? 'https://index.docker.io/v1/',
      username: row.username,
      password: this.#box.open(row.token_encrypted, `registry:${row.id}`),
    };
  }

  /** Credentials for every registry that has them, for `docker compose pull`. */
  allAuths(): RegistryAuth[] {
    return this.#db
      .all<RegistryRow>('SELECT * FROM registries WHERE username IS NOT NULL AND token_encrypted IS NOT NULL ORDER BY id')
      .map((r) => ({ host: registryHost(r.url), username: r.username!, password: this.#box.open(r.token_encrypted!, `registry:${r.id}`) }));
  }

  #view(r: RegistryRow): Registry {
    return { id: r.id, name: r.name, url: r.url, host: registryHost(r.url), username: r.username, hasToken: r.token_encrypted !== null };
  }
}
