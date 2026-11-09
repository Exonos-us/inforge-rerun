-- A coworker now has one main conversation, General, and every other conversation is a thread of
-- it. Every row that exists is a thread (the default), so no data moves: the first message sent in
-- General creates its row, and the partial index keeps it to one per coworker.
do $$ begin
    create type public.session_kind as enum ('general', 'thread');
exception when duplicate_object then null;
end $$;

alter table public.sessions add column if not exists kind public.session_kind not null default 'thread';

create unique index if not exists sessions_general_per_agent_idx on public.sessions (agent_id) where kind = 'general';
