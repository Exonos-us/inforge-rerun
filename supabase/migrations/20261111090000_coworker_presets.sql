-- Coworker presets: a coworker's whole definition saved for rehire, and teams of them hired in
-- one flow (a space, several coworkers, a Slack channel).
--
-- A preset is a workspace-local capture of an agent folder — the same tarball a template ships —
-- plus the editorial projection the store renders (skills, schedules, connectors) and the
-- questions whose answers are per-project rather than part of the role ("where does the code
-- live?"). Credentials and memory never enter a preset: the archive strips them, every hire
-- starts fresh.

create table public.coworker_presets (
    id uuid primary key default gen_random_uuid(),
    workspace_id bigint not null references public.workspaces(id) on delete cascade,
    name text not null,
    -- The role label the store and the hire roster show ("Project Engineer").
    role text not null default '',
    description text not null default '',
    -- An emoji glyph. It seeds the Slack identity of each hire; agents themselves have no icon.
    icon text not null default '',
    connector_slugs jsonb not null default '[]'::jsonb,
    -- What the archive holds, projected for display: skills, schedules, tools.
    summary jsonb not null default '{}'::jsonb,
    -- Asked at hire: the project facts a role cannot carry. Answers land as memories on the hire.
    questions jsonb not null default '[]'::jsonb,
    -- Object path inside the private agent-archives bucket, not a URL.
    archive_path text not null,
    archive_bytes bigint not null default 0,
    -- Which engine build produced the archive, so a stale one can be spotted later.
    engine_commit text,
    -- The agent it was saved from. Deleting that agent keeps the preset: that is its point.
    source_agent_id uuid references public.agents(id) on delete set null,
    hires integer not null default 0,
    created_by uuid references public.users(id) on delete set null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index coworker_presets_workspace_idx on public.coworker_presets (workspace_id);

-- A team preset is only composition: which coworker presets, how many of each. The member list is
-- jsonb because it is read and written whole, by one screen.
create table public.team_presets (
    id uuid primary key default gen_random_uuid(),
    workspace_id bigint not null references public.workspaces(id) on delete cascade,
    name text not null,
    description text not null default '',
    -- [{ presetId, count }]
    members jsonb not null default '[]'::jsonb,
    created_by uuid references public.users(id) on delete set null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index team_presets_workspace_idx on public.team_presets (workspace_id);

alter table public.coworker_presets enable row level security;
alter table public.team_presets enable row level security;

revoke all on table public.coworker_presets from anon, authenticated;
revoke all on table public.team_presets from anon, authenticated;

-- Reads go straight from the browser; every write walks through a server action that checks the
-- workspace first, so writes stay with service_role. Granted explicitly: on a database whose
-- grants came from default privileges, the revoke above would otherwise strip service_role too
-- (the slack tables learned this the hard way).
grant select on table public.coworker_presets to authenticated;
grant select on table public.team_presets to authenticated;
grant select, insert, update, delete on table public.coworker_presets to service_role;
grant select, insert, update, delete on table public.team_presets to service_role;

create policy "coworker_presets_select_workspace_members"
    on public.coworker_presets
    for select
    to authenticated
    using (workspace_id in (select workspace_members.workspace_id from public.workspace_members where workspace_members.user_id = auth.uid()));

create policy "team_presets_select_workspace_members"
    on public.team_presets
    for select
    to authenticated
    using (workspace_id in (select workspace_members.workspace_id from public.workspace_members where workspace_members.user_id = auth.uid()));
