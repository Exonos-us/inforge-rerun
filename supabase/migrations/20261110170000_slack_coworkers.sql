-- Coworkers in Slack: one Slack app per workspace, posting under each coworker's own name, and a
-- Slack thread carrying one Rerun conversation.
--
-- The Slack app belongs to the workspace, not to Rerun: a self-hosted install creates its own from
-- the manifest the app hands it, which is why the bot token and the signing secret live here. They
-- are the two values the hub needs on every delivery — the secret to verify Slack's signature
-- before anything else happens, the token to answer — so they stay server-side: neither is granted
-- to `authenticated`, exactly like `app_connections.provider_webhook_secret`.

create table public.slack_connections (
    id uuid primary key default gen_random_uuid(),
    workspace_id bigint not null references public.workspaces(id) on delete cascade,
    -- Slack's own ids. `team_id` is what an incoming event names, so it is how a delivery finds
    -- its workspace.
    team_id text not null,
    team_name text,
    -- The app's own user id, so its echo of its own messages can be told from a human's.
    bot_user_id text,
    bot_token text not null,
    signing_secret text not null,
    -- Whether the install carries chat:write.customize. Without it Slack ignores the per-message
    -- name and avatar, and every coworker answers as the app: worth saying in the UI rather than
    -- leaving the user to wonder why they all look alike.
    can_customize_identity boolean not null default false,
    connected_by uuid references public.users(id) on delete set null,
    status text not null default 'connected' check (status in ('connected', 'needs_reconnect', 'disconnected')),
    last_event_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    -- One Slack workspace per Rerun workspace, and one Rerun workspace per Slack team: a second
    -- install of the same team would answer the same events twice.
    unique (workspace_id),
    unique (team_id)
);

-- Which coworkers live in which channel. A coworker can sit in several channels and a channel can
-- hold several coworkers — that is the whole point of #mdc-code.
create table public.slack_channel_agents (
    id uuid primary key default gen_random_uuid(),
    connection_id uuid not null references public.slack_connections(id) on delete cascade,
    channel_id text not null,
    channel_name text,
    agent_id uuid not null references public.agents(id) on delete cascade,
    -- The name people type to address it in Slack, and the name its messages are posted under.
    -- Defaults to the coworker's name, but a channel may want something shorter.
    display_name text,
    -- An emoji avatar costs nothing and reads instantly; an icon url wins when it is set.
    icon_emoji text,
    icon_url text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (connection_id, channel_id, agent_id)
);

create index slack_channel_agents_channel_idx on public.slack_channel_agents (connection_id, channel_id);
create index slack_channel_agents_agent_idx on public.slack_channel_agents (agent_id);

-- A Slack thread is one conversation. Without this row every message would start a fresh one and
-- "and is dev green now?" would come back as "which build?".
create table public.slack_threads (
    connection_id uuid not null references public.slack_connections(id) on delete cascade,
    channel_id text not null,
    thread_ts text not null,
    agent_id uuid not null references public.agents(id) on delete cascade,
    -- The hub's conversation row, so the exchange shows up in the coworker's chat like any other.
    session_id uuid references public.sessions(id) on delete set null,
    -- The engine's own id for it, which is what /chat is called with.
    engine_session_id text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (connection_id, channel_id, thread_ts)
);

create index slack_threads_session_idx on public.slack_threads (session_id);

-- Slack retries any delivery it does not hear back from within three seconds, and a retry of a
-- message already being answered would start a second run. Claimed before the handler, stamped
-- after, like app_webhook_events.
create table public.slack_events (
    event_id text primary key,
    team_id text,
    received_at timestamptz not null default now(),
    processed_at timestamptz
);

alter table public.slack_connections enable row level security;
alter table public.slack_channel_agents enable row level security;
alter table public.slack_threads enable row level security;
alter table public.slack_events enable row level security;

revoke all on table public.slack_connections from anon, authenticated;
revoke all on table public.slack_channel_agents from anon, authenticated;
revoke all on table public.slack_threads from anon, authenticated;
revoke all on table public.slack_events from anon, authenticated;

-- Everything but the two secrets.
grant select (id, workspace_id, team_id, team_name, bot_user_id, can_customize_identity, connected_by, status, last_event_at, created_at, updated_at)
    on table public.slack_connections to authenticated;
grant select on table public.slack_channel_agents to authenticated;
grant select on table public.slack_threads to authenticated;

create policy "slack_connections_select_workspace_members"
    on public.slack_connections
    for select
    to authenticated
    using (workspace_id in (select workspace_members.workspace_id from public.workspace_members where workspace_members.user_id = auth.uid()));

create policy "slack_channel_agents_select_workspace_members"
    on public.slack_channel_agents
    for select
    to authenticated
    using (connection_id in (
        select slack_connections.id from public.slack_connections
        where slack_connections.workspace_id in (select workspace_members.workspace_id from public.workspace_members where workspace_members.user_id = auth.uid())
    ));

create policy "slack_threads_select_workspace_members"
    on public.slack_threads
    for select
    to authenticated
    using (connection_id in (
        select slack_connections.id from public.slack_connections
        where slack_connections.workspace_id in (select workspace_members.workspace_id from public.workspace_members where workspace_members.user_id = auth.uid())
    ));
