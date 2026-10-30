import { mkdir, readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/** The little the server needs from Postgres. Implemented over `pg` in production and PGlite in tests and local dev. */
export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Runs `fn` in a transaction: committed when it resolves, rolled back when it throws. */
  transaction<R>(fn: (tx: Pick<Db, 'query'>) => Promise<R>): Promise<R>;
  close(): Promise<void>;
}

/** Postgres at `url` (e.g. Supabase's connection string). */
export async function connectPostgres(url: string): Promise<Db> {
  const { default: pg } = await import('pg');
  // bigint (int8) columns hold epoch milliseconds, which fit a JS number.
  pg.types.setTypeParser(20, (v) => Number(v));
  const pool = new pg.Pool({ connectionString: url });
  return {
    async query(sql, params) {
      return (await pool.query(sql, params)).rows;
    },
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        const out = await fn({ query: async (sql, params) => (await client.query(sql, params)).rows });
        await client.query('commit');
        return out;
      } catch (err) {
        await client.query('rollback');
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

/** Embedded Postgres (PGlite): in memory, or persisted under `dir`. No server or Docker needed. */
export async function openPglite(dir?: string): Promise<Db> {
  const { PGlite, types } = await import('@electric-sql/pglite');
  // PGlite creates only the last path segment, so make the parents first.
  if (dir && !dir.includes('://')) await mkdir(dir, { recursive: true });
  const db = new PGlite(dir, { parsers: { [types.INT8]: (v: string) => Number(v) } });
  await db.waitReady;
  return {
    async query(sql, params) {
      return (await db.query(sql, params)).rows as never;
    },
    transaction: (fn) => db.transaction((tx) => fn({ query: async (sql, params) => (await tx.query(sql, params)).rows as never })),
    close: () => db.close(),
  };
}

const MIGRATIONS = fileURLToPath(new URL('../migrations/', import.meta.url));

/** Applies every migration in `migrations/` that hasn't run yet, in file-name order. */
export async function migrate(db: Db): Promise<string[]> {
  await db.query('create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())');
  const done = new Set((await db.query<{ name: string }>('select name from schema_migrations')).map((r) => r.name));
  const files = (await readdir(MIGRATIONS)).filter((f) => f.endsWith('.sql')).sort();
  const applied: string[] = [];
  for (const name of files) {
    if (done.has(name)) continue;
    const sql = await readFile(MIGRATIONS + name, 'utf8');
    await db.transaction(async (tx) => {
      // Statements one at a time: parameterless multi-statement strings aren't portable across both drivers.
      for (const stmt of sql.split(/;\s*$/m).map((s) => s.trim()).filter((s) => s.replace(/--.*$/gm, '').trim())) await tx.query(stmt);
      await tx.query('insert into schema_migrations (name) values ($1)', [name]);
    });
    applied.push(name);
  }
  return applied;
}
