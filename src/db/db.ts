import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';

export type Param = SQLInputValue;

/**
 * A thin wrapper around `DatabaseSync`: cached prepared statements, typed row
 * helpers and transactions. All SQL is written by hand at the call site.
 */
export class Db {
  readonly #db: DatabaseSync;
  readonly #statements = new Map<string, StatementSync>();
  #depth = 0;

  constructor(path: string) {
    this.#db = new DatabaseSync(path);
    this.#db.exec('PRAGMA foreign_keys = ON');
    this.#db.exec('PRAGMA busy_timeout = 5000');
    if (path !== ':memory:') {
      this.#db.exec('PRAGMA journal_mode = WAL');
      this.#db.exec('PRAGMA synchronous = NORMAL');
    }
  }

  #prepare(sql: string): StatementSync {
    let stmt = this.#statements.get(sql);
    if (!stmt) {
      stmt = this.#db.prepare(sql);
      this.#statements.set(sql, stmt);
    }
    return stmt;
  }

  get<T>(sql: string, ...params: Param[]): T | undefined {
    return this.#prepare(sql).get(...params) as T | undefined;
  }

  all<T>(sql: string, ...params: Param[]): T[] {
    return this.#prepare(sql).all(...params) as T[];
  }

  run(sql: string, ...params: Param[]): { changes: number; lastInsertRowid: number } {
    const r = this.#prepare(sql).run(...params);
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }

  /** Runs one or more statements without parameters, e.g. a migration file. */
  exec(sql: string): void {
    this.#db.exec(sql);
  }

  /**
   * Runs `fn` in a transaction and returns its result. Nested calls become
   * savepoints, so a service can call another service inside its own transaction.
   */
  transaction<T>(fn: () => T): T {
    const savepoint = `sp_${this.#depth}`;
    this.#db.exec(this.#depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`);
    this.#depth++;
    try {
      const result = fn();
      this.#depth--;
      this.#db.exec(this.#depth === 0 ? 'COMMIT' : `RELEASE ${savepoint}`);
      return result;
    } catch (err) {
      this.#depth--;
      this.#db.exec(this.#depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
      throw err;
    }
  }

  close(): void {
    this.#statements.clear();
    this.#db.close();
  }
}
