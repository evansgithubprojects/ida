-- Organizations hold projects. People belong to an org with a role; members of an org see only the projects they are
-- granted in project_members, while owners and admins see all of them.

-- Everyone who has signed in, kept from the verified token so invites can match on email.
create table users (
  id text primary key,
  email text,
  name text,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create table orgs (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  personal boolean not null default false,
  created_by text not null,
  created_at timestamptz not null default now()
);
-- One personal org per person, so two first requests at once can't each create one.
create unique index orgs_one_personal on orgs (created_by) where personal;

create table org_members (
  org_id uuid not null references orgs (id) on delete cascade,
  user_id text not null,
  role text not null check (role in ('owner', 'admin', 'member')),
  created_at timestamptz not null default now(),
  primary key (org_id, user_id)
);
create index org_members_user on org_members (user_id);

-- Existing projects move into their owner's personal org.
insert into orgs (name, personal, created_by) select 'Personal', true, owner_id from (select distinct owner_id from projects) o;

insert into org_members (org_id, user_id, role) select id, created_by, 'owner' from orgs where personal;

alter table projects add column org_id uuid references orgs (id) on delete cascade;

alter table projects add column created_by text;

update projects p set org_id = o.id, created_by = p.owner_id from orgs o where o.personal and o.created_by = p.owner_id;

alter table projects alter column org_id set not null;

drop index projects_owner;

alter table projects drop column owner_id;

create index projects_org on projects (org_id);

-- Grants for org members only: owners and admins already see every project in their org.
create table project_members (
  project_id uuid not null references projects (id) on delete cascade,
  user_id text not null,
  role text not null check (role in ('editor', 'viewer')),
  created_at timestamptz not null default now(),
  primary key (project_id, user_id)
);
create index project_members_user on project_members (user_id)
