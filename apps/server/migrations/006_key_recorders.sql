-- Which recorders each ingest key has uploaded for. Filled as batches arrive, so keys used before this existed show none.
create table key_recorders (
  key_id uuid not null references project_keys (id) on delete cascade,
  recorder_id uuid not null references recorders (id) on delete cascade,
  primary key (key_id, recorder_id)
);
