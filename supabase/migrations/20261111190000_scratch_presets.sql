-- From-scratch presets: written in the store rather than captured from a live coworker. The soul
-- lives on the row and a hire scaffolds a fresh agent from it, so these rows have no archive.
alter table public.coworker_presets alter column archive_path drop not null;
alter table public.coworker_presets add column soul text;
