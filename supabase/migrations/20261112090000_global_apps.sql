-- Global apps: a catalog service's account connected once for the workspace, then enabled per
-- coworker without a second sign-in. Three kinds: 'key' (a pasted credential stored here
-- server-side, like slack_connections.bot_token, compiled onto each enabled coworker — covers
-- stdio servers too), 'composio' (Composio holds the token under a per-connection user id, the
-- proxy routes by the x-rerun-global header), and 'oauth' (the browser sign-in happens once at
-- workspace level, the token bundle lives on the row, and coworker calls go through
-- /api/mcp/global/<id>, which injects and refreshes it).

create table public.global_app_connections (
    id uuid primary key default gen_random_uuid(),
    workspace_id bigint not null references public.workspaces(id) on delete cascade,
    service_slug text not null,
    -- How the account reads everywhere: "inforge-bot", "ops@inforge.us".
    label text not null,
    auth_method_id text not null,
    kind text not null check (kind in ('key', 'composio', 'oauth')),
    -- Non-secret input values of the method, shown back in the UI.
    config jsonb not null default '{}'::jsonb,
    -- Secret input values of a 'key' method. Never granted to authenticated: compiled onto each
    -- enabled coworker's engine .env, server-side only here.
    secrets jsonb not null default '{}'::jsonb,
    -- The Composio connected account behind a 'composio' connection. Server-side only: it is what
    -- a disconnect deletes at Composio to actually revoke access.
    composio_account_id text,
    composio_account_label text,
    -- The token bundle of an 'oauth' connection (access/refresh token, endpoints, client), the
    -- working set of the /api/mcp/global proxy. Server-side only, like `secrets`.
    oauth jsonb,
    status text not null default 'connecting' check (status in ('connecting', 'connected', 'needs_reconnect')),
    connected_by uuid references public.users(id) on delete set null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index global_app_connections_workspace_idx on public.global_app_connections (workspace_id, service_slug);

-- Which coworker runs on which connection. `registry_key` is the entry the enable compiled on the
-- coworker (the bare slug, or slug@instance), so a disable can reverse exactly that one.
create table public.global_app_agents (
    connection_id uuid not null references public.global_app_connections(id) on delete cascade,
    agent_id uuid not null references public.agents(id) on delete cascade,
    registry_key text not null,
    created_at timestamptz not null default now(),
    primary key (connection_id, agent_id)
);

create index global_app_agents_agent_idx on public.global_app_agents (agent_id);
create unique index global_app_agents_agent_key_idx on public.global_app_agents (agent_id, registry_key);

alter table public.global_app_connections enable row level security;
alter table public.global_app_agents enable row level security;

revoke all on table public.global_app_connections from anon, authenticated;
revoke all on table public.global_app_agents from anon, authenticated;

-- The server reads the secrets and writes everything; stated explicitly because the default
-- privileges are not guaranteed to have granted service_role anything on a fresh database.
grant all on table public.global_app_connections to service_role;
grant all on table public.global_app_agents to service_role;

-- The secret columns (secrets, composio ids) stay server-side.
grant select (id, workspace_id, service_slug, label, auth_method_id, kind, config, status, connected_by, created_at, updated_at) on table public.global_app_connections to authenticated;
grant select (connection_id, agent_id, registry_key, created_at) on table public.global_app_agents to authenticated;

create policy "global_app_connections_select_workspace_members"
    on public.global_app_connections
    for select
    to authenticated
    using (workspace_id in (select workspace_members.workspace_id from public.workspace_members where workspace_members.user_id = auth.uid()));

create policy "global_app_agents_select_workspace_members"
    on public.global_app_agents
    for select
    to authenticated
    using (connection_id in (
        select global_app_connections.id from public.global_app_connections
        where global_app_connections.workspace_id in (select workspace_members.workspace_id from public.workspace_members where workspace_members.user_id = auth.uid())
    ));
