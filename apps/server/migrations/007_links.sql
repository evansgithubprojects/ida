-- Cross-service links: a broker message published in one session (service) and consumed in another.

-- Project-wide, wall-clock queries over occurrences (the system view), without joining through every session.
alter table occurrences add column project_id uuid references projects (id) on delete cascade;
alter table occurrences add column wall_ts double precision;
update occurrences o set project_id = r.project_id, wall_ts = s.started_at + o.ts
  from sessions s join recorders r on r.id = s.recorder_id
  where s.id = o.session_id;
alter table occurrences alter column project_id set not null;
alter table occurrences alter column wall_ts set not null;
create index occurrences_project_wall on occurrences (project_id, wall_ts);

-- Which SDK sent a session ({ language, version }), shown next to its runtime.
alter table sessions add column sdk jsonb;

-- The session's clock against ours: server time = started_at + ts + clock_offset, give or take clock_error ms.
-- Estimated by the SDK from upload round trips (or, until one exists, from a single request's send time).
-- `wall_ts` above already includes it; when a better estimate arrives, the session's rows are moved together.
alter table sessions add column clock_offset double precision not null default 0;
alter table sessions add column clock_error double precision;
alter table sessions add column clock_at timestamptz;

-- One row per consume occurrence whose message carried an `ida-parent` header. Stored as sent: the parent may arrive
-- later or never. Readers only follow a link to a parent session in the same project, so a header naming another
-- project's session links to nothing.
create table occurrence_links (
  project_id uuid not null references projects (id) on delete cascade,
  child_session uuid not null references sessions (id) on delete cascade,
  child_id text not null,
  parent_session uuid not null,
  parent_id text not null,
  primary key (child_session, child_id)
);
create index occurrence_links_parent on occurrence_links (project_id, parent_session, parent_id);
