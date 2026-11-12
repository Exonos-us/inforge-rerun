-- Where a member's Slack account lives under a different address than their Rerun sign-in email:
-- the one Rerun uses to find them in Slack and invite them into private channels it creates.
alter table public.users add column slack_email text;
