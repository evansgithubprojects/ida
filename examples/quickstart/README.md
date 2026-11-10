# Ida quickstart

A tiny order pipeline (`placed → charge → ship`) that uses Ida exactly as a new user would: installed from npm,
outside the monorepo's workspaces (`examples/` is not in the root `workspaces`), so it never picks up the local
packages by accident.

```bash
npm install            # @ida-dev/core, @ida-dev/cloud, @ida-dev/adapter-eventemitter from npm
cp .env.example .env   # then paste an ingest key from the web app
npm start
```

Without a key the app still runs and says so. With an unreachable endpoint it keeps recording to `.ida/spool`
and the console tells you.

## Setup friction found while building this

Each item is something a first-time user would hit. Fix the docs or the packages, then delete the line.

1. **Silent no-recording without `enable()`** (fixed in the repo, ships with the next publish). The snippets now call
   `enable()`, and both adapters print one console warning when an emit has no recorder to go to
   (`warnIfNoRecorder: false` silences it). The `0.0.0` packages this example installs predate the warning, so
   `src/index.js` calls `enable()` itself.
2. **`endpoint` is required and there is no default**, so the first run needs a server URL a new user doesn't have.
3. **`.ida/spool` appears in the working directory** and isn't mentioned as something to git-ignore.
4. **`^0.0.0` only matches `0.0.0`.** npm's caret on a `0.0.x` version won't pick up `0.0.1`, so a fresh install
   won't see patch releases until the packages move to `0.1.0` or higher.
5. **Node prints `.env not found. Continuing without it.`** from `--env-file-if-exists` on every start without a `.env`.
6. **Uploading to a real project is not covered here.** It needs a project and ingest key from the signed-in web app,
   so this run only exercised install, recording and the offline spool.
