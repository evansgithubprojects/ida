-- Ida is organization-first: sign-up names an organization instead of everyone getting a personal one.
-- Existing personal orgs become ordinary orgs with the same name, members and projects.
drop index if exists orgs_one_personal;
alter table orgs drop column personal;
