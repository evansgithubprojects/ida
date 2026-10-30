import { serve } from '@hono/node-server';
import { createApp } from './app';
import { supabaseVerifier } from './auth';
import { connectPostgres, migrate, openPglite } from './db';

/**
 * Environment:
 * - DATABASE_URL: Postgres connection string (Supabase). Without it, an embedded PGlite database under PGLITE_DIR
 *   (default `.data/pglite`) is used, which is enough for local development.
 * - SUPABASE_URL: the Supabase project URL, whose Auth tokens the web-app API accepts. Required.
 * - STREAM_SECRET: signs live-stream tokens. Required in production; a random one is made up locally.
 * - WEB_ORIGINS: comma-separated web-app origins allowed to call the API (default http://localhost:5173).
 * - PORT (default 8787)
 */
// Settings can live in `apps/server/.env` (see `.env.example`); real environment variables win.
try { process.loadEnvFile(); } catch { /* no .env */ }
const env = process.env;
if (!env.SUPABASE_URL) throw new Error('SUPABASE_URL is required: it is the Supabase project whose sign-ins the API accepts');
if (!env.STREAM_SECRET && env.NODE_ENV === 'production') throw new Error('STREAM_SECRET is required in production');

const db = env.DATABASE_URL ? await connectPostgres(env.DATABASE_URL) : await openPglite(env.PGLITE_DIR ?? '.data/pglite');
const applied = await migrate(db);
if (applied.length) console.log(`[server] applied migrations: ${applied.join(', ')}`);

const app = createApp({
  db,
  verifyUser: supabaseVerifier(env.SUPABASE_URL),
  streamSecret: env.STREAM_SECRET ?? crypto.randomUUID() + crypto.randomUUID(),
  webOrigins: (env.WEB_ORIGINS ?? 'http://localhost:5173').split(',').map((s) => s.trim()).filter(Boolean),
});

const port = Number(env.PORT ?? 8787);
serve({ fetch: app.fetch, port }, () => console.log(`[server] listening on http://localhost:${port} (${env.DATABASE_URL ? 'Postgres' : 'PGlite'})`));
