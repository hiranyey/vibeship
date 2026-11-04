import { existsSync, lchownSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256Hex } from '../crypto/tokens.ts';
import type { Db } from '../db/db.ts';
import { COMPOSE_FILE, DATA_DIR, ENV_FILE } from './layout.ts';

export type RenderedFile = { path: string; content: string; mode: number };

/** Changes the owner of a path itself, never what a symlink points at. Tests swap in a fake, since only root can give files away. */
export type Lchown = (path: string, uid: number, gid: number) => void;

/** What `applyDataOwner` did, for the deploy log. */
export type DataOwnerResult = {
  /** True when the top-level owner differed, so everything inside was chowned too. */
  recursive: boolean;
  /** Entries inside `data/` whose owner was set (0 unless recursive). */
  entries: number;
};

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
  readonly #lchown: Lchown;

  constructor(deps: { db: Db; stackRoot: string; lchown?: Lchown }) {
    this.#db = deps.db;
    this.#stackRoot = deps.stackRoot;
    this.#lchown = deps.lchown ?? lchownSync;
  }

  dir(projectName: string): string {
    return join(this.#stackRoot, projectName);
  }

  write(projectId: number, projectName: string, files: RenderedFile[]): void {
    const dir = this.dir(projectName);
    mkdirSync(join(dir, DATA_DIR), { recursive: true });
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

  /** `<STACK_ROOT>/<project>/data`. */
  dataDir(projectName: string): string {
    return join(this.dir(projectName), DATA_DIR);
  }

  /**
   * Creates `data/` if needed and gives it to `uid:gid`.
   *
   * When the folder already has that owner, only the folder itself is
   * chowned, so a normal deploy costs one syscall whatever the folder holds.
   * When its owner differs (the first deploy after setting or changing
   * dataOwner), everything inside is chowned too, so files an earlier version
   * wrote as root become writable. Files inside that were changed by hand
   * later are not revisited while the top level stays right.
   *
   * Symlinks are never followed: `data/` itself must be a real directory, and
   * inside it links are chowned as links and never descended into. Nothing
   * outside `data/` is touched.
   */
  applyDataOwner(projectName: string, owner: { uid: number; gid: number }): DataOwnerResult {
    const data = this.dataDir(projectName);
    mkdirSync(data, { recursive: true });
    const top = lstatSync(data);
    if (top.isSymbolicLink() || !top.isDirectory()) {
      throw new Error(`${DATA_DIR}/ is ${top.isSymbolicLink() ? 'a symlink' : 'not a directory'}, so its owner is left alone`);
    }
    const recursive = top.uid !== owner.uid || top.gid !== owner.gid;
    let entries = 0;
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        this.#lchown(path, owner.uid, owner.gid);
        entries++;
        // Dirent types come from lstat, so a symlink to a directory is not one here.
        // Checked again right before descending, in case it was swapped for a link.
        if (entry.isDirectory() && lstatSync(path).isDirectory()) walk(path);
      }
    };
    if (recursive) walk(data);
    // The folder itself last, so an interrupted walk leaves the top level
    // different and the next deploy walks again.
    this.#lchown(data, owner.uid, owner.gid);
    return { recursive, entries };
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
    for (const f of [COMPOSE_FILE, ENV_FILE]) rmSync(join(dir, f), { force: true });
  }
}
