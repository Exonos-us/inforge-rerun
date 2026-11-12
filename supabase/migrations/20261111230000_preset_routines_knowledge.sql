-- Routines and knowledge carried by the preset itself, beside what a capture brings.
-- routines: [{ name, cron, body }] — created as schedules on every hire.
-- knowledge: [{ path, content }] — text documents written into every hire's files under knowledge/.
alter table public.coworker_presets add column routines jsonb not null default '[]'::jsonb;
alter table public.coworker_presets add column knowledge jsonb not null default '[]'::jsonb;
