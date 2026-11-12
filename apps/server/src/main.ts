import { serve } from '@hono/node-server';
import type { Context } from 'hono';
import { createApp } from './app';
import { settleAllProjects } from './clock';
import { resendMailer } from './mail';
import { supabaseVerifier } from './auth';
import { connectPostgres, migrate, openPglite } from './db';
import { startRetention } from './retention';

/**
 * Environment:
 * - DATABASE_URL: Postgres connection string (Supabase). Without it, an embedded PGlite database under PGLITE_DIR
 *   (default `.data/pglite`) is used, which is enough for local development.
 * - SUPABASE_URL: the Supabase project URL, whose Auth tokens the web-app API accepts. Required.
 * - STREAM_SECRET: signs live-stream tokens. Required in production; a random one is made up locally.
 * - WEB_ORIGINS: comma-separated web-app origins allowed to call the API (default http://localhost:5173).
 * - TRUST_PROXY: how many proxies sit in front of the server (default 0). Needed for per-address limits to see real clients.
 * - PORT (default 8787). Exits with a message when it is taken.
 * - DEV_RETENTION_HOURS (default 24): with the embedded PGlite database, recorded data older than this is deleted
 *   every hour so the dev database stays small. 0 keeps everything. Ignored with DATABASE_URL.
 */
// Settings can live in `apps/server/.env` (see `.env.example`); real environment variables win.
try { process.loadEnvFile(); } catch { /* no .env */ }
const env = process.env;
if (!env.SUPABASE_URL) throw new Error('SUPABASE_URL is required: it is the Supabase project whose sign-ins the API accepts');
if (!env.STREAM_SECRET && env.NODE_ENV === 'production') throw new Error('STREAM_SECRET is required in production');

const db = env.DATABASE_URL ? await connectPostgres(env.DATABASE_URL) : await openPglite(env.PGLITE_DIR ?? '.data/pglite');
const applied = await migrate(db);
if (applied.length) console.log(`[server] applied migrations: ${applied.join(', ')}`);
// Clock shifts are stored from 008 on; settle what was stored before it once, so old recordings line up too.
if (applied.includes('008_clock_shift.sql')) console.log(`[server] settled the clocks of ${await settleAllProjects(db)} sessions`);

const retentionHours = Number(env.DEV_RETENTION_HOURS ?? 24);
if (!(retentionHours >= 0)) throw new Error('DEV_RETENTION_HOURS must be a number of hours, or 0 to keep everything');
const stopRetention = !env.DATABASE_URL && retentionHours > 0 ? startRetention(db, retentionHours) : () => {};

const trustedProxies = Number(env.TRUST_PROXY ?? 0);
if (!Number.isInteger(trustedProxies) || trustedProxies < 0) throw new Error('TRUST_PROXY must be a whole number: how many proxies sit in front of the server');

const app = createApp({
  db,
  verifyUser: supabaseVerifier(env.SUPABASE_URL),
  streamSecret: env.STREAM_SECRET ?? crypto.randomUUID() + crypto.randomUUID(),
  webOrigins: (env.WEB_ORIGINS ?? 'http://localhost:5173').split(',').map((s) => s.trim()).filter(Boolean),
  webAppUrl: env.WEB_APP_URL,
  // Behind proxies the socket address is the last proxy's. TRUST_PROXY=<how many proxies sit in front> reads the real
  // client from X-Forwarded-For instead (the entry that many hops from the end, which the client can't forge).
  ...(trustedProxies > 0 && { clientIp: (c: Context) => c.req.header('x-forwarded-for')?.split(',').map((s) => s.trim()).filter(Boolean).at(-trustedProxies) }),
  sendMail: env.RESEND_API_KEY ? resendMailer({ apiKey: env.RESEND_API_KEY, from: env.MAIL_FROM ?? 'Ida <onboarding@resend.dev>' }) : undefined,
});
if (!env.RESEND_API_KEY) console.log('[server] RESEND_API_KEY is not set: invitation links are logged here and shown to the inviting admin instead of emailed.');

const port = Number(env.PORT ?? 8787);
const server = serve({ fetch: app.fetch, port }, () => console.log(`[server] listening on http://localhost:${port} (${env.DATABASE_URL ? 'Postgres' : 'PGlite'})`));
server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code !== 'EADDRINUSE') throw err;
  console.error(`[server] port ${port} is already in use: another dev server is probably still running (find it with \`lsof -i :${port}\`).`);
  process.exit(1);
});

// Close the database before exiting. A dev restart (`tsx watch`) or Ctrl-C otherwise kills the embedded PGlite
// mid-write, which can leave its data directory unable to open.
let stopping = false;
const shutdown = () => {
  if (stopping) return;
  stopping = true;
  stopRetention();
  if ('closeAllConnections' in server) server.closeAllConnections(); // live streams never end by themselves
  server.close();
  db.close().catch((err) => console.error('[server] closing the database failed:', err)).finally(() => process.exit(0));
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
