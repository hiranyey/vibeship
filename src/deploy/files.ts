import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256Hex } from '../crypto/tokens.ts';
import type { Db } from '../db/db.ts';

export type RenderedFile = { path: string; content: string; mode: number };

export type DriftState = 'ok' | 'modified' | 'missing';
export type FileDrift = { path: string; state: DriftState };

/**
 * Owns each project's folder under STACK_ROOT. Generated files are a cache of
 * the database: they are written atomically and their hashes recorded, so a
 * hand edit shows up as drift.
 */
export class ProjectFiles {
  readonly #db: Db;
  readonly #stackRoot: string;

  constructor(deps: { db: Db; stackRoot: string }) {
    this.#db = deps.db;
    this.#stackRoot = deps.stackRoot;
  }

  dir(projectName: string): string {
    return join(this.#stackRoot, projectName);
  }

  write(projectId: number, projectName: string, files: RenderedFile[]): void {
    const dir = this.dir(projectName);
    mkdirSync(join(dir, 'data'), { recursive: true });
    for (const f of files) {
      const target = join(dir, f.path);
      const tmp = `${target}.tmp`;
      writeFileSync(tmp, f.content, { mode: f.mode });
      renameSync(tmp, target);
    }
    this.#db.transaction(() => {
      for (const f of files) {
        this.#db.run(
          `INSERT INTO rendered_files (project_id, path, sha256) VALUES (?, ?, ?)
           ON CONFLICT (project_id, path) DO UPDATE SET sha256 = excluded.sha256, written_at = excluded.written_at`,
          projectId, f.path, sha256Hex(f.content),
        );
      }
    });
  }

  /** Compares each file Vibeship wrote with what is on disk now. Empty before the first deploy. */
  drift(projectId: number, projectName: string): FileDrift[] {
    const dir = this.dir(projectName);
    return this.#db
      .all<{ path: string; sha256: string }>('SELECT path, sha256 FROM rendered_files WHERE project_id = ? ORDER BY path', projectId)
      .map(({ path, sha256 }) => {
        const file = join(dir, path);
        if (!existsSync(file)) return { path, state: 'missing' as const };
        return { path, state: sha256Hex(readFileSync(file, 'utf8')) === sha256 ? ('ok' as const) : ('modified' as const) };
      });
  }

  /** True when the database would now render something different from what was last written. */
  pending(projectId: number, files: RenderedFile[]): boolean {
    const written = new Map(
      this.#db.all<{ path: string; sha256: string }>('SELECT path, sha256 FROM rendered_files WHERE project_id = ?', projectId)
        .map((r) => [r.path, r.sha256]),
    );
    return files.some((f) => written.get(f.path) !== sha256Hex(f.content));
  }

  /** Removes the generated files, and `data/` too when asked. */
  remove(projectName: string, opts: { deleteData: boolean }): void {
    const dir = this.dir(projectName);
    if (opts.deleteData) {
      rmSync(dir, { recursive: true, force: true });
      return;
    }
    for (const f of ['compose.yaml', '.env']) rmSync(join(dir, f), { force: true });
  }
}
