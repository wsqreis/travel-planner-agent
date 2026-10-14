import { DatabaseSync } from 'node:sqlite';
import { applyUpdates, emptyProfile, type MemoryUpdate, type Profile } from './profile.ts';

export type MemoryEvent = MemoryUpdate & { at: string };

/**
 * Long-term memory: one profile per user, plus an append-only log of every change,
 * so the traveller can see when and what the assistant learned about them.
 */
export interface ProfileStore {
  get(userId: string): Profile;
  update(userId: string, updates: MemoryUpdate[]): { profile: Profile; applied: MemoryUpdate[] };
  history(userId: string): MemoryEvent[];
  /** Deletes the profile and its history. */
  forget(userId: string): void;
}

export class SqliteProfileStore implements ProfileStore {
  readonly #db: DatabaseSync;
  readonly #now: () => Date;

  /** `path` is a file path, or ":memory:" for tests. */
  constructor(path: string, now: () => Date = () => new Date()) {
    this.#db = new DatabaseSync(path);
    this.#now = now;
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS profiles (
        user_id    TEXT PRIMARY KEY,
        data       TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS profile_events (
        id      INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        op      TEXT NOT NULL,
        field   TEXT NOT NULL,
        value   TEXT,
        at      TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS profile_events_user ON profile_events (user_id, id);
    `);
  }

  get(userId: string): Profile {
    const row = this.#db.prepare('SELECT data FROM profiles WHERE user_id = ?').get(userId) as
      | { data: string }
      | undefined;
    // Merge over an empty profile so fields added in later versions get defaults.
    return row ? { ...emptyProfile(), ...(JSON.parse(row.data) as Partial<Profile>) } : emptyProfile();
  }

  update(userId: string, updates: MemoryUpdate[]): { profile: Profile; applied: MemoryUpdate[] } {
    const result = applyUpdates(this.get(userId), updates);
    if (result.applied.length === 0) return result;

    const at = this.#now().toISOString();
    const log = this.#db.prepare('INSERT INTO profile_events (user_id, op, field, value, at) VALUES (?, ?, ?, ?, ?)');
    this.#db.exec('BEGIN');
    try {
      this.#db
        .prepare(
          `INSERT INTO profiles (user_id, data, updated_at) VALUES (?, ?, ?)
           ON CONFLICT (user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
        )
        .run(userId, JSON.stringify(result.profile), at);
      for (const update of result.applied) log.run(userId, update.op, update.field, update.value, at);
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
    return result;
  }

  history(userId: string): MemoryEvent[] {
    const rows = this.#db
      .prepare('SELECT op, field, value, at FROM profile_events WHERE user_id = ? ORDER BY id')
      .all(userId) as MemoryEvent[];
    // node:sqlite returns null-prototype rows; hand callers ordinary objects.
    return rows.map((row) => ({ op: row.op, field: row.field, value: row.value, at: row.at }));
  }

  forget(userId: string): void {
    this.#db.prepare('DELETE FROM profiles WHERE user_id = ?').run(userId);
    this.#db.prepare('DELETE FROM profile_events WHERE user_id = ?').run(userId);
  }

  close(): void {
    this.#db.close();
  }
}
