-- The address Slack was actually given, so the screen can check it instead of guessing.
--
-- A local install is read on localhost and called through a tunnel: the app's own origin is not
-- where events arrive, and showing it as such was a lie. The URL typed when the Slack app was
-- created is now kept on the connection; the Slack screen probes it with Slack's own
-- url_verification handshake and says plainly when nothing answers there any more (a restarted
-- ngrok being the usual culprit).

alter table public.slack_connections add column if not exists request_url text;

grant select (request_url) on table public.slack_connections to authenticated;
