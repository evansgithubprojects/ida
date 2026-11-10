# Ida quickstart

An order pipeline (`placed → charge → ship`) built from scratch against the **published** `@ida-dev/*` packages. It
lives in `examples/`, outside the monorepo's workspaces, so `npm install` fetches from npm and never links local code.

```bash
npm install
IDA_PROJECT_KEY=ida_… IDA_ENDPOINT=https://your-server npm start
```

`NO_ENABLE=1 npm start` skips `enable()` to show the warning for an emit that has no recorder.

## Setup friction (second pass, packages 0.1.0)

Found by following the README snippets as written. Nothing open.

Fixed: untracked emitters are no longer dropped silently (the adapter warns once and the snippets call `enable()`);
version ranges resolve (`^0.1.0`); `configure()` now fails at startup with what to do when `projectKey` or `endpoint`
is missing, or the key isn't an ingest key (ships after 0.1.0; the packages this example installs predate it).

Decided, not a problem: the endpoint is required on purpose, so users create a project on the website, and the
`.ida/spool` folder in the working directory is for developers to git-ignore.
