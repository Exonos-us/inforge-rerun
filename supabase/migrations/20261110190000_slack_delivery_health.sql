-- What Slack is doing, said on the screen instead of in a log.
--
-- The two ways a connected Slack stays silent are invisible from the app: the Request URL was
-- never saved, so nothing is ever delivered; or the signing secret is a neighbouring value copied
-- off the same page, so every delivery is refused. Both look identical from the channel — a
-- coworker that does not answer — and both were found here by reading server logs, which no
-- customer will do.
--
-- The webhook stamps what happened; the Slack screen reads it back and names the fix.

alter table public.slack_connections add column if not exists last_signature_error_at timestamptz;

grant select (last_signature_error_at) on table public.slack_connections to authenticated;
