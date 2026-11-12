-- Tags on the store's cards. An area tag (Engineering, Design, …) drives the store's filters;
-- anything else is a free-form specialty. Stored as a jsonb array of strings like connector_slugs.
alter table public.coworker_presets add column tags jsonb not null default '[]'::jsonb;
alter table public.team_presets add column tags jsonb not null default '[]'::jsonb;
