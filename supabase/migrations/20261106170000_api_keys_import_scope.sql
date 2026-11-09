-- An import key: handed to an outside agent (OpenClaw, Hermes, Grok) so it can rebuild itself as a
-- coworker. It lives 24 hours, reaches only the import tools, and once its first create_agent
-- succeeds it is bound to that coworker and to nothing else. Deleting the coworker deletes the key.
alter table public.api_keys
    add column if not exists expires_at timestamptz,
    add column if not exists scope text not null default 'account',
    add column if not exists bound_agent_id uuid references public.agents(id) on delete cascade;

do $$
begin
    if not exists (select 1 from pg_constraint where conname = 'api_keys_scope_check') then
        alter table public.api_keys add constraint api_keys_scope_check check (scope in ('account', 'agent_import'));
    end if;
end $$;
