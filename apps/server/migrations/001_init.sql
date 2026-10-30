-- Projects belong to a Supabase Auth user (the JWT `sub`). Kept as text so the schema doesn't depend on the auth schema.
create table projects (
  id uuid primary key default gen_random_uuid(),
  owner_id text not null,
  name text not null,
  created_at timestamptz not null default now()
);
create index projects_owner on projects (owner_id);

-- Ingest keys look like `eda_<prefix>_<secret>`; only the prefix and a SHA-256 of the whole key are stored.
create table project_keys (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects (id) on delete cascade,
  prefix text not null unique,
  key_hash text not null,
  label text not null default '',
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

-- A recorder is created the first time its key sends data.
create table recorders (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects (id) on delete cascade,
  key text not null,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique (project_id, key)
);

-- One run of a recorder (an app start). Occurrence timestamps are relative to `started_at` (epoch ms).
create table sessions (
  id uuid primary key,
  recorder_id uuid not null references recorders (id) on delete cascade,
  started_at bigint not null,
  runtime text not null default '',
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create index sessions_recorder on sessions (recorder_id, started_at desc);

create table session_processes (
  session_id uuid not null references sessions (id) on delete cascade,
  id text not null,
  data jsonb not null,
  primary key (session_id, id)
);

create table session_nodes (
  session_id uuid not null references sessions (id) on delete cascade,
  id text not null,
  data jsonb not null,
  primary key (session_id, id)
);

create table session_templates (
  session_id uuid not null references sessions (id) on delete cascade,
  id text not null,
  data jsonb not null,
  primary key (session_id, id)
);

-- `late` marks occurrences that reached us from the SDK's offline spool rather than as they happened.
create table occurrences (
  session_id uuid not null references sessions (id) on delete cascade,
  id text not null,
  ts double precision not null,
  data jsonb not null,
  late boolean not null default false,
  received_at timestamptz not null default now(),
  primary key (session_id, id)
);
create index occurrences_ts on occurrences (session_id, ts);

create table findings (
  session_id uuid not null references sessions (id) on delete cascade,
  id text not null,
  data jsonb not null,
  primary key (session_id, id)
);

-- Every accepted batch, so a batch replayed from the spool is acknowledged without being stored twice.
create table ingest_batches (
  session_id uuid not null references sessions (id) on delete cascade,
  seq integer not null,
  received_at timestamptz not null default now(),
  primary key (session_id, seq)
);

-- Data the SDK had to drop because its offline spool was full.
create table session_gaps (
  session_id uuid not null references sessions (id) on delete cascade,
  from_ts double precision not null,
  to_ts double precision not null,
  dropped integer not null,
  recorded_at timestamptz not null default now()
);
