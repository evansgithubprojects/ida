-- People can go by a different name in each organization. Empty means they go by their email until they pick one.
alter table org_members add column display_name text;
