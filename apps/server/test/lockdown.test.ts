import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate, openPglite, type Db } from '../src/db';

let db: Db;
beforeAll(async () => {
  db = await openPglite();
  // The roles Supabase's REST API uses. They only exist there, so make them here to prove the revoke works.
  await db.query('create role anon nologin');
  await db.query('create role authenticated nologin');
  await db.query('grant usage on schema public to anon, authenticated');
  await migrate(db);
}, 30_000);
afterAll(() => db.close());

describe('table lockdown', () => {
  it('enables row-level security on every table, including the migration log', async () => {
    const rows = await db.query<{ tablename: string; rowsecurity: boolean }>(
      `select tablename, rowsecurity from pg_tables where schemaname = current_schema()`,
    );
    expect(rows.length).toBeGreaterThan(10);
    expect(rows.filter((r) => !r.rowsecurity).map((r) => r.tablename)).toEqual([]);
    expect(rows.map((r) => r.tablename)).toContain('schema_migrations');
  });

  it('leaves the REST API roles with no access to any table', async () => {
    const tables = await db.query<{ tablename: string }>(`select tablename from pg_tables where schemaname = current_schema()`);
    for (const { tablename } of tables) {
      for (const role of ['anon', 'authenticated']) {
        const [r] = await db.query<{ ok: boolean }>(
          `select has_table_privilege($1, quote_ident(current_schema()) || '.' || quote_ident($2), 'select, insert, update, delete') as ok`,
          [role, tablename],
        );
        expect(r!.ok, `${role} on ${tablename}`).toBe(false);
      }
    }
  });

  it('also locks down a table a later migration adds, and the owner still reads it', async () => {
    await db.query('create table later (id int)');
    await db.query('grant select on later to anon');
    await migrate(db); // nothing new to apply, but the lockdown runs every pass
    const [t] = await db.query<{ rowsecurity: boolean }>(`select rowsecurity from pg_tables where tablename = 'later'`);
    expect(t!.rowsecurity).toBe(true);
    const [a] = await db.query<{ ok: boolean }>(`select has_table_privilege('anon', 'later', 'select') as ok`);
    expect(a!.ok).toBe(false);
    expect(await db.query('select * from later')).toEqual([]);
  });
});
