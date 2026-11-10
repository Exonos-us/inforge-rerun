-- The Slack tables were left unusable by their own lock-down.
--
-- `revoke all ... from anon, authenticated` is how every table that holds a secret keeps browsers
-- out, and it is what `20261110170000_slack_coworkers.sql` does. But on a database where the
-- grants came from Supabase's default privileges, that revoke also takes the data privileges off
-- `service_role`, leaving it with `Dxtm` (truncate, references, trigger) and nothing to read or
-- write with. Every path into these tables is service-role — the Slack webhook has no signed-in
-- user at all — so connecting Slack failed with "permission denied for table slack_connections".
--
-- Granting them back explicitly says what is meant instead of depending on what a revoke happens
-- to leave behind.

grant select, insert, update, delete on table public.slack_connections to service_role;
grant select, insert, update, delete on table public.slack_channel_agents to service_role;
grant select, insert, update, delete on table public.slack_threads to service_role;
grant select, insert, update, delete on table public.slack_events to service_role;
