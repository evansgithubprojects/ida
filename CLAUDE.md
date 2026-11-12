# Ida

A debugging tool that makes event-driven JavaScript code easy to follow. It records every event in a time window, shows how events connect, and replays the timeline visually so you can watch pathways light up as events fire.

## Distribution

- Published on npm.
- JavaScript frameworks only for the first version.

## What an "event" is

An event is **who called it and what it called, including payloads**.

- Caller: the emitter (and the handler that was running when it emitted, if any)
- Callee: the handler(s) the event reached
- Payload: the data passed along

## Mental model

- An **event chain** is a linked list: each event points to the event that caused it.
- **Handlers are the nodes** of that list.
- All chains together form a **web of connected nodes**. One handler can appear in many chains.

## Core features

1. **Recording**: log every event within a configurable time window.
2. **Tree / web view**: show handlers as nodes and event routes as pathways between them.
3. **Replay**: play the recorded timeline back visually. Pathways light up when their event fires. Play, pause, and scrub.
4. **Inspection**: the user can highlight and inspect nodes and pathways.
5. **Configurable replay window**: the user chooses which slice of time to replay.
6. **Zoom levels**:
   - Zoom out: processes
   - Zoom into a process: see all of its handlers
   - Zoom into a handler: see what it has been doing (its event history, payloads, timings, errors)

## Storage: templates instead of full copies

Events are grouped into **reference groups (templates)**. Each recorded event is stored as a reference to its template plus the minimum per-occurrence data (timestamp, parent link, ids), instead of storing all of its own data.

- Default: template reference only.
- Opt-in: the user can choose to store full unique data (e.g. full payloads) for specific events.
- Replay uses the template to render each occurrence.

**Open question:** how events get grouped into a template. Candidates to evaluate:
- emitter + event name + handler set
- the above plus payload shape (keys/types, not values)

Grouping must be stable enough that replay stays accurate, and it must be clear in the UI when an occurrence's data is template-only vs fully captured.

## Technical notes from planning

These are suggestions from the planning discussion, not final decisions.

- **Replay does not re-run user code.** It plays back recorded data against the graph, so it is safe and deterministic.
- **Causality (parent links):** track the "currently handling" event inside a wrapped `emit`.
  - Synchronous emits: a simple stack works.
  - Async emits (after `await`, timers): use `AsyncLocalStorage` in Node. Browsers have no built-in equivalent yet (TC39 AsyncContext was still a Stage 2 draft as of mid-2026), so mark async-hop links as "inferred" in the UI. Keep the context layer swappable so AsyncContext can replace it later.
- **Memory:** ring buffer bounded by time or count. Templates help here too.
- **Package shape:**
  - `core`: recorder, buffer, templates, causality, JSON export. No DOM dependency.
  - `ui`: the visual replay viewer (in-page overlay first; DevTools extension later).
  - Adapters: Node `EventEmitter`, DOM `EventTarget`, then buses like mitt / eventemitter3, then framework events (Vue `emit`, React).
- **Setup should be near zero:** hook the dispatcher so one line enables recording, rather than instrumenting each emit call.

## Projects and keyed recorders

- **Recorders are keyed:** `connectRecorder(key)` returns the same recorder for the same key anywhere in an app (no prop drilling). `enable()` is `connectRecorder('default')` and sets it as the default recorder.
- **Routing:** adapters installed without a recorder send each emit to the recorders that `track()` its emitter, else to the default recorder. Several recorders may track one emitter; listeners still run once (`dispatchAll` nests the dispatches). Parent links don't cross recorders.
- **Organizations → projects → people:** every project belongs to an organization. Ida is for teams, so there are no personal orgs: the sign-up form asks for an organization name (Supabase `user_metadata.org_name`), and the server creates that org, with the person as owner, on their very first request (`ensureUser`). People signing up from an invitation skip it, and anyone in no org is asked to create one. Org roles are `owner`, `admin` and `member`. Owners and admins can open every project in their org, create projects, and manage people; only owners rename or delete the org and hand out ownership, and an org always keeps one owner. A `member` opens only the projects they are granted (`project_members`: `viewer` looks, `editor` also manages ingest keys). Someone with no access gets the same 404 as a missing project. Access checks live in `apps/server/src/access.ts` (`projectAccess`) and the `guard` helpers.
- **Invitations:** owners and admins invite an email address (with project grants for members). The server emails a link through Resend (`RESEND_API_KEY`, `MAIL_FROM`, `WEB_APP_URL`); without a key, or when sending fails, the link is shown to the inviting admin. Only a SHA-256 of the token is stored. The invite is accepted by the signed-in user whose token email matches, from the link or from the pending-invites strip; it expires after 7 days, and resending replaces the link. An invite only matches an email address the sign-in provider says is confirmed (`emailVerified`, from Supabase's `email_verified`); an unconfirmed address sees no invites and cannot accept.
- **Projects** are created in the web app (`apps/viewer`), which signs users in with Supabase Auth (sign-in only). Every data request goes to our own server (`apps/server`: Node + Hono + Postgres, PGlite when there is no `DATABASE_URL`).
- **Uploads:** `@ida-dev/cloud` (`configure({ projectKey, endpoint })`) uploads every keyed recorder over plain HTTP with a per-project, write-only ingest key. No Supabase dependency in published packages. Each app run is one session; the shared wire format is `IngestBatch` in core's types.
- **API hardening:** every table has row-level security with no policies and the Supabase `anon`/`authenticated` roles hold no grants (`lockDown` in `apps/server/src/db.ts`, re-run after every migration so future tables are covered); the server connects as the table owner, which bypasses RLS. Live-stream tokens are single-use, 30 s, bound to the person and project they were made for, and an open stream re-checks its viewer's access every 30 s (and a person can hold 20 at once). Failed ingest-key, stream-token and sign-in attempts are limited per client address (`TRUST_PROXY` says how many proxies sit in front, so the address is the real client's); signed-in people get 300 requests a minute; user-API bodies are capped at 64 KiB; a person can create 10 organizations; a session recording returns at most 50,000 events (newest kept, `X-Ida-Truncated: true` when older ones are left out) and takes `from`, `to` and `limit`. Limits are in memory, so with several instances each keeps its own counts.
- **Offline:** failed batches go to a spool (files in Node, IndexedDB in browsers), the developer is told on the console, and batches are uploaded in order on recovery. `(sessionId, seq)` makes replays idempotent; spooled occurrences are marked `late`, and spool overflow is recorded as `gaps`, both shown in the viewer.
- **Clock skew:** each session's `wall_ts` = `started_at + ts + clock_offset + clock_shift`. `clock_offset` is the SDK's round-trip estimate; `clock_shift` is stored at ingest by `settleClocks` (`apps/server/src/clock.ts`), which moves a consuming session later until every message it consumed comes after its publish (only later; limited by links going back the other way). A new clock estimate resets the shift and settles it again. Views read the stored times; batches that move times make the live stream resnapshot.
- The Node adapter ignores Node internals, including the connection pools behind `fetch`, so the uploader never records its own uploads.
- The Node adapter records only emitters the app created, decided by where each emitter's class is defined (outside `node_modules` and Node). An emitter a package or Node created is recorded only for events app code listens to, or when tracked. `includeLibraries` / `isAppFile` override this.
- Not built yet: multi-instance live fan-out (Postgres `LISTEN/NOTIFY`), retention limits, and audit logs for access changes.

## First milestone

- Core recorder with templates
- `EventEmitter` and `EventTarget` adapters
- Synchronous causality only
- Replay viewer: play/pause/scrub, lit-up pathways, click-to-inspect, replay window control, process → handler → activity zoom
- A demo app with a simulated event stream to exercise the viewer

Future idea: AI insights for faster error tracing and root cause location