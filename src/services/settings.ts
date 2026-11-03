import { z } from 'zod';
import type { RequestContext } from '../actor.ts';
import type { Db } from '../db/db.ts';
import type { AuditLog } from './audit.ts';
import { parseInput } from './validate.ts';

const Schemas = {
  health_timeout_seconds: z.coerce.number().int().min(5).max(900),
};
export type SettingKey = keyof typeof Schemas;
export type Settings = { [K in SettingKey]: z.output<(typeof Schemas)[K]> };

const defaults: Settings = { health_timeout_seconds: 60 };

export class SettingsService {
  readonly #db: Db;
  readonly #audit: AuditLog;

  constructor(deps: { db: Db; audit: AuditLog }) {
    this.#db = deps.db;
    this.#audit = deps.audit;
  }

  get<K extends SettingKey>(key: K): Settings[K] {
    const row = this.#db.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', key);
    const parsed = row ? Schemas[key].safeParse(row.value) : null;
    return parsed?.success ? (parsed.data as Settings[K]) : defaults[key];
  }

  set<K extends SettingKey>(ctx: RequestContext, key: K, raw: unknown): Settings[K] {
    const value = parseInput(Schemas[key], raw) as Settings[K];
    this.#db.transaction(() => {
      this.#db.run(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
        key, String(value),
      );
      this.#audit.record(ctx, 'settings.set', `setting:${key}`, { value });
    });
    return value;
  }
}
