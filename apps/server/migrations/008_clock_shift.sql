-- How much later a session's events were moved so that every message it consumed comes after the publish it came
-- from (see `settleClocks` in src/clock.ts). Kept apart from `clock_offset`, the SDK's estimate, so a fresh estimate
-- doesn't erase it: server time = started_at + ts + clock_offset + clock_shift. `wall_ts` includes it.
-- Existing sessions are settled by the server on startup, after this migration runs.
alter table sessions add column clock_shift double precision not null default 0;
