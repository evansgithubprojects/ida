# eda-debugger server

Receives uploads from [`@eda-debugger/cloud`](../../packages/cloud/README.md), stores them in Postgres, and serves projects, recordings and live streams to the web app (`apps/viewer`). Users sign in with Supabase Auth; the server checks their tokens against the Supabase project's published signing keys.

## Run

```bash
cp apps/server/.env.example apps/server/.env   # set SUPABASE_URL
npm run server                                 # from the repo root: builds core, then watches src/
```

| Variable | | |
| --- | --- | --- |
| `SUPABASE_URL` | required | The Supabase project whose sign-ins the API accepts. |
| `DATABASE_URL` | optional | Postgres connection string (e.g. Supabase's). Without it, an embedded PGlite database under `PGLITE_DIR` (default `.data/pglite`) is used. |
| `STREAM_SECRET` | required in production | Signs live-stream tokens. A random one is made up per start otherwise. |
| `WEB_ORIGINS` | `http://localhost:5173` | Comma-separated web-app origins allowed to call the API. |
| `PORT` | `8787` | |

Migrations in `migrations/` run at startup.

## API

Ingest, authenticated with a project key (`Authorization: Bearer eda_…`):

- `POST /v1/ingest`: one `IngestBatch` (see `@eda-debugger/core`). A repeated `(sessionId, seq)` is acknowledged and not stored again. Limited to 2 MiB per batch and 600 batches per key per minute.

Web app, authenticated with the user's Supabase access token:

- `GET|POST /v1/projects`, `GET|PATCH|DELETE /v1/projects/:id`
- `GET|POST /v1/projects/:id/keys`, `DELETE /v1/projects/:id/keys/:keyId` (a new key is returned once; only its prefix and a hash are stored)
- `GET /v1/projects/:id/recorders`, `GET /v1/projects/:id/recorders/:key/sessions`
- `GET /v1/sessions/:id/recording`: the session as a `Recording` the viewer opens
- `POST /v1/projects/:id/recorders/:key/stream-token`, then `GET /v1/live?token=…`: Server-Sent Events, a snapshot of the newest session followed by each new batch. The token is valid for a minute because `EventSource` can't send headers.

Live fan-out is in-process, so run one instance for now; more than one needs Postgres `LISTEN/NOTIFY` (not built yet).
