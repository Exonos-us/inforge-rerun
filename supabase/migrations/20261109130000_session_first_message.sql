-- General shows, above each thread, the message it opened with. The hub keeps no message, so the
-- first one is written here when the thread is created; threads older than this column show a
-- generic line instead.
alter table public.sessions add column if not exists first_message text;
