-- An invitation to join an org by email. Only a hash of the emailed token is stored, as with ingest keys.
-- `projects` lists the grants a new member gets: [{"projectId": "...", "role": "editor" | "viewer"}].
create table invites (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs (id) on delete cascade,
  email text not null,
  org_role text not null check (org_role in ('admin', 'member')),
  projects jsonb not null default '[]',
  token_hash text not null unique,
  invited_by text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  accepted_at timestamptz,
  revoked_at timestamptz
);

-- One open invite per person per org; sending again replaces the token instead.
create unique index invites_one_open on invites (org_id, email) where accepted_at is null and revoked_at is null;

create index invites_email on invites (email) where accepted_at is null and revoked_at is null
