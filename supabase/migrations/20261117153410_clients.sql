-- A client is who the workspace works for, and how they like things done: the skills and
-- knowledge every coworker on that engagement should start with. A Box points at one
-- (spaces.client_id), the way it already points at a Confluence engagement (space_knowledge).
-- The payload columns hold the same shapes a preset holds, so the same parsers read both.

create table public.clients (
    id uuid primary key default gen_random_uuid(),
    workspace_id bigint not null references public.workspaces(id) on delete cascade,
    name text not null,
    -- Names Boxes, channels and coworkers (mdc-permitting-po), so two clients sharing one would
    -- make those names ambiguous to read. It never keys the skills a client installs: that is the
    -- id, which no rename can move. shortCodeOf() is initials-based, so "Miami Dade County" and
    -- "Miami Dade City" both propose "mdc" and one of them has to pick something else.
    short_code text not null,
    skills jsonb not null default '[]'::jsonb,
    knowledge jsonb not null default '[]'::jsonb,
    site_url text,
    cloud_id text,
    space_key text,
    space_name text,
    -- Bumped on every save. An agent records the revision that actually landed on its engine,
    -- so "3 to sync" is a count of agents trailing this number, not a job queue.
    revision integer not null default 1,
    created_by uuid references public.users(id) on delete set null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint clients_short_code_not_blank check (short_code <> '')
);

create index clients_workspace_name_idx on public.clients (workspace_id, name);
create unique index clients_workspace_short_code_idx on public.clients (workspace_id, short_code);

alter table public.spaces add column client_id uuid references public.clients(id) on delete set null;
create index spaces_client_idx on public.spaces (client_id);

alter table public.agents add column client_revision integer;

alter table public.clients enable row level security;

revoke all on table public.clients from anon, authenticated;
-- Readable by every member of the workspace, as coworker_presets is. Writes go through server
-- actions on the service role, whose grant is spelled out because the revoke above would
-- otherwise strip it on a database whose grants came from default privileges — the slack tables
-- learned this the hard way.
grant select on table public.clients to authenticated;
grant select, insert, update, delete on table public.clients to service_role;

create policy "clients_select_workspace_members" on public.clients
    for select to authenticated
    using (workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid()));
