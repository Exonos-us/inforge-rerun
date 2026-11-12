-- Skills written on the preset itself: [{ name, description, body }]. At hire they are created on
-- the fresh agent beside whatever the archive carries, so a preset's skills are editable without
-- touching the capture.
alter table public.coworker_presets add column skills jsonb not null default '[]'::jsonb;
