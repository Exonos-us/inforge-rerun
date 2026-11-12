-- Project knowledge: a Box can point at the Confluence engagement it is about. The knowledge
-- stays in Confluence (nothing imported, the Company Brain untouched); this row is the pointer,
-- read through the workspace's Atlassian account in global_app_connections. page_id null means
-- the whole space was linked. page_index caches the engagement's page titles for the coworkers'
-- system prompts.

create table public.space_knowledge (
    space_id uuid primary key references public.spaces(id) on delete cascade,
    workspace_id bigint not null references public.workspaces(id) on delete cascade,
    connection_id uuid references public.global_app_connections(id) on delete set null,
    site_url text not null,
    cloud_id text not null,
    space_key text not null,
    space_name text not null,
    page_id text,
    page_title text,
    page_index jsonb not null default '[]'::jsonb,
    index_refreshed_at timestamptz,
    status text not null default 'ok' check (status in ('ok', 'needs_reconnect', 'missing')),
    linked_by uuid references auth.users(id) on delete set null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index space_knowledge_workspace_idx on public.space_knowledge (workspace_id);

alter table public.space_knowledge enable row level security;

revoke all on table public.space_knowledge from anon, authenticated;
-- Nothing secret here (the credential lives on global_app_connections), so members may read rows.
grant select on table public.space_knowledge to authenticated;
grant all on table public.space_knowledge to service_role;
