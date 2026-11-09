import { actorFromContext, assertAgentAccess, assertSessionInWorkspace, keepVisible, visibleSpaceIds, type Actor } from '@/app/api/_auth/access'
import { AuthorizationError, type WorkspaceContext } from '@/app/api/_auth/ownership'
import { createSessionRow, getSessionEngineContext, lastRunError, listSessionRuns, readUsageSeed, resolveAgentTarget, type SessionUsageSeed, updateSessionStatus } from '@/app/api/_services/chat.service'
import { type HistoryMessage, transformEngineMessages } from '@/lib/chat/engine-history'
import { ATTENTION_NOTIFICATION_COLUMNS, attentionDetailsOf, attentionNotificationsFilter } from '@/lib/notifications/attention-details'
import { sanitizeIlike } from '@/lib/search/ilike'
import { cancelRun, getSession, getSessionMessages, listRuns, listSessions, listSkillProposals } from '@/lib/engine/client'
import type { EngineSkillProposal, SessionSource } from '@/lib/engine/types'
import { ATTENTION_STATUSES, needsHuman, sessionStatusSchema, type AgentConversationsOverview, type Conversation, type ConversationHit, type SessionKind, type SessionOutcome, type SessionStatus, type ToHandleList } from '@rerun/contracts'
import type { Database } from '@/app/api/database.types'
import { createClient } from '@/supabase/server'
import { createServiceRoleClient } from '@/supabase/serviceRole'
import { selectCount, selectMany, selectMaybeSingle } from '@/supabase/supabase-helpers'

export type SessionHistoryEntry = {
    id: string | null
    agentId: string
    engineSessionId: string
    title: string
    status: SessionStatus
    updatedAt: string
    source: SessionSource
    originAgentId: string | null
    originAgentName: string | null
    automationName: string | null
    outcome: SessionOutcome | null
    kind: SessionKind
    createdAt: string
}

// Session history for an agent: Supabase-mirrored sessions merged with
// engine-only sessions that were initiated by another agent (call_agent),
// so those show up in the history like regular ones until adopted.
export async function listAgentSessions(agentId: string, actor?: Actor): Promise<SessionHistoryEntry[]> {
    const { actor: caller } = await assertAgentAccess(agentId, 'use', actor)

    const supabase = createServiceRoleClient()

    const [{ data: rows }, target] = await Promise.all([
        selectMany(supabase, 'sessions', ['id', 'title', 'status', 'updated_at', 'created_at', 'engine_session_id', 'origin_agent_id', 'source', 'automation_name', 'outcome', 'kind'] as const, { agent_id: agentId }),
        resolveAgentTarget(agentId, caller).catch(() => null),
    ])
    const supabaseRows = rows ?? []

    const engineSessions = target ? await listSessions(target.conn, target.engineAgentId).catch(() => []) : []

    const mirrored = new Set(supabaseRows.map(r => r.engine_session_id))
    const unmirrored = engineSessions.filter(s => s.originAgentId && !mirrored.has(s.id))

    const engineOriginIds = [...new Set(unmirrored.map(s => s.originAgentId).filter((v): v is string => !!v))]
    const supabaseOriginIds = [...new Set(supabaseRows.map(r => r.origin_agent_id).filter((v): v is string => !!v))]

    const byEngineId = new Map<string, { id: string; name: string }>()
    if (engineOriginIds.length > 0) {
        const { data } = await selectMany(supabase, 'agents', ['id', 'engine_agent_id', 'name'] as const, { engine_agent_id: { in: engineOriginIds } })
        for (const a of data ?? []) if (a.engine_agent_id) byEngineId.set(a.engine_agent_id, { id: a.id, name: a.name })
    }

    const namesById = new Map<string, string>()
    if (supabaseOriginIds.length > 0) {
        const { data } = await selectMany(supabase, 'agents', ['id', 'name'] as const, { id: { in: supabaseOriginIds } })
        for (const a of data ?? []) namesById.set(a.id, a.name)
    }

    const entries: SessionHistoryEntry[] = [
        ...supabaseRows.map(r => ({
            id: r.id,
            agentId,
            engineSessionId: r.engine_session_id,
            title: r.title,
            status: r.status,
            updatedAt: r.updated_at,
            source: (r.source ?? 'dashboard') as SessionSource,
            originAgentId: r.origin_agent_id,
            originAgentName: r.origin_agent_id ? (namesById.get(r.origin_agent_id) ?? 'another coworker') : null,
            automationName: r.automation_name,
            outcome: r.outcome,
            kind: r.kind,
            createdAt: r.created_at,
        })),
        ...unmirrored.map(s => ({
            id: null,
            agentId,
            engineSessionId: s.id,
            title: s.title,
            // The engine's own status only says the session exists ('open'); nothing runs on it
            // from the hub's point of view until it is adopted.
            status: sessionStatusSchema.catch('idle').parse(s.status),
            updatedAt: s.updatedAt,
            source: s.source,
            originAgentId: s.originAgentId ? (byEngineId.get(s.originAgentId)?.id ?? null) : null,
            originAgentName: s.originAgentId ? (byEngineId.get(s.originAgentId)?.name ?? 'another coworker') : null,
            automationName: null,
            outcome: null,
            kind: 'thread' as const,
            createdAt: s.createdAt,
        })),
    ]

    return entries.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
}

export type ThreadRow = {
    id: string
    title: string
    status: SessionStatus
    source: SessionSource
    createdAt: string
    updatedAt: string
    originAgentId: string | null
    automationName: string | null
    outcome: SessionOutcome | null
    // What the thread opened with, when a person typed it in the app; null for a run the engine
    // started and for threads older than the column.
    firstMessage: string | null
}

export const THREAD_COLUMNS = ['id', 'title', 'status', 'source', 'created_at', 'updated_at', 'origin_agent_id', 'automation_name', 'outcome', 'first_message'] as const

// PostgREST caps a select at 1000 rows: General shows the newest threads, the Threads list stays
// the way to every older one.
export const THREAD_FEED_LIMIT = 200

// The threads General hangs under its messages, newest first. Read from Supabase alone: the engine
// mirrors every conversation it opens on its own (`agent.session.created`), and the live state
// comes from the board store, so there is nothing to ask the Box for here.
export async function listAgentThreads(agentId: string, actor?: Actor): Promise<ThreadRow[]> {
    await assertAgentAccess(agentId, 'use', actor)
    const { data, error } = await selectMany(createServiceRoleClient(), 'sessions', THREAD_COLUMNS, { agent_id: agentId, kind: 'thread' }, { column: 'created_at', ascending: false }, THREAD_FEED_LIMIT)
    if (error) throw error
    return (data ?? []).map(row => ({
        id: row.id,
        title: row.title,
        status: row.status,
        source: (row.source ?? 'dashboard') as SessionSource,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        originAgentId: row.origin_agent_id,
        automationName: row.automation_name,
        outcome: row.outcome,
        firstMessage: row.first_message,
    }))
}

// The app's list of a coworker's conversations: the history, plus what the inbox knows of each one,
// whether a run finished since the caller last opened it, and what a waiting one asks.
export async function listAgentConversations(ctx: WorkspaceContext, agentId: string): Promise<Conversation[]> {
    const entries = await listAgentSessions(agentId, actorFromContext(ctx))
    const waiting = entries.flatMap(entry => (entry.id && needsHuman(entry.status) ? [{ id: entry.id, agent_id: entry.agentId, engine_session_id: entry.engineSessionId, title: entry.title, updated_at: entry.updatedAt }] : []))
    const filter = attentionNotificationsFilter(waiting)

    // `unseen_runs` answers for `auth.uid()`: it runs as the caller, not through the service role.
    const asCaller = await createClient()
    const [unseen, notifications] = await Promise.all([
        asCaller.rpc('unseen_runs', { p_workspace_id: ctx.workspace.id }),
        filter ? selectMany(ctx.supabase, 'notifications', ATTENTION_NOTIFICATION_COLUMNS, filter, { column: 'created_at', ascending: false }) : { data: [], error: null },
    ])
    const unseenIds = unseen.error ? null : new Set((unseen.data ?? []).filter(run => run.agent_id === agentId).map(run => run.session_id))
    const details = notifications.error ? {} : attentionDetailsOf(waiting, notifications.data ?? [], ctx.userId)

    return entries.map(entry => ({
        ...entry,
        ...(unseenIds && { unseen: !!entry.id && unseenIds.has(entry.id) }),
        ask: entry.id ? (details[entry.id]?.message ?? null) : null,
    }))
}

// The workspace's coworkers whose Box the caller reaches: every list of conversations stops there.
async function reachableAgents(ctx: WorkspaceContext): Promise<{ id: string; name: string }[]> {
    const [{ data, error }, spaces] = await Promise.all([selectMany(ctx.supabase, 'agents', ['id', 'name', 'space_id'] as const, { workspace_id: ctx.workspace.id }), visibleSpaceIds(actorFromContext(ctx))])
    if (error) throw error
    return keepVisible(data ?? [], spaces, agent => agent.space_id)
}

const OVERVIEW_COLUMNS = ['id', 'agent_id', 'title', 'status', 'updated_at', 'engine_session_id', 'source'] as const

// What the app badges on an agent row: a conversation it cannot move forward without a human. An
// errored one is not counted, the row says "Error" on its own.
const PENDING_STATUSES = ['awaiting_question', 'awaiting_approval', 'awaiting_connector', 'awaiting_ack'] as const

// PostgREST caps a select at 1000 rows, so the scan that finds each agent's latest conversation is
// ordered and bounded explicitly rather than left to that cap (see the board's live sessions, same
// trap). The pending count is a query of its own: filtered on the four statuses it is small by
// construction, and stays exact however many conversations the workspace holds.
const LATEST_SCAN_LIMIT = 1000

// The whole Chats screen in one request. Engine-only conversations (opened on this agent by
// another one, not adopted yet) are left out on purpose: they are always idle, so they change
// neither the count nor the latest row, and skipping them is what keeps this off the Boxes.
export async function listWorkspaceConversationOverview(ctx: WorkspaceContext): Promise<AgentConversationsOverview> {
    const agentIds = (await reachableAgents(ctx)).map(a => a.id)
    if (agentIds.length === 0) return []

    const { data: recent, error: recentError } = await selectMany(ctx.supabase, 'sessions', OVERVIEW_COLUMNS, { agent_id: agentIds }, { column: 'updated_at', ascending: false }, LATEST_SCAN_LIMIT)
    if (recentError) throw recentError

    const { data: pendingRows, error: pendingError } = await selectMany(ctx.supabase, 'sessions', ['agent_id'] as const, { agent_id: agentIds, status: [...PENDING_STATUSES] })
    if (pendingError) throw pendingError

    const latestByAgent = new Map<string, Conversation>()
    for (const row of recent ?? []) {
        if (latestByAgent.has(row.agent_id)) continue
        latestByAgent.set(row.agent_id, {
            id: row.id,
            agentId: row.agent_id,
            engineSessionId: row.engine_session_id,
            title: row.title,
            status: row.status,
            source: (row.source ?? 'dashboard') as SessionSource,
            updatedAt: row.updated_at,
            // Resolving the origin agent would cost a second lookup for a label the row never
            // shows: the Chats screen prints the status, the agent's own history prints the name.
            originAgentName: null,
        })
    }

    const pendingByAgent = new Map<string, number>()
    for (const row of pendingRows ?? []) pendingByAgent.set(row.agent_id, (pendingByAgent.get(row.agent_id) ?? 0) + 1)

    return agentIds.map(agentId => ({ agentId, latest: latestByAgent.get(agentId) ?? null, pending: pendingByAgent.get(agentId) ?? 0 }))
}

const SEARCH_COLUMNS = ['id', 'agent_id', 'title', 'status', 'updated_at'] as const

const SEARCH_LIMIT = 20
const AGENT_RECENT_LIMIT = 8

export type { ConversationHit } from '@rerun/contracts'

// Conversations found by their title, newest first, for the control center. Scoped through the
// coworkers the caller reaches, which is also what proves a given `agentId` is the caller's to read. With
// an agent and no text it lists that agent's latest ones. Engine-only conversations have no row to
// match and are left out, as in the overview above.
export async function searchWorkspaceConversations(ctx: WorkspaceContext, query: string, agentId?: string): Promise<ConversationHit[]> {
    const text = sanitizeIlike(query)
    if (!text && !agentId) return []

    const workspaceAgentIds = (await reachableAgents(ctx)).map(a => a.id)
    const agentIds = agentId ? workspaceAgentIds.filter(id => id === agentId) : workspaceAgentIds
    if (agentIds.length === 0) return []

    const filters = { agent_id: agentIds, ...(text ? { title: { ilike: `%${text}%` } } : {}) }
    const { data, error } = await selectMany(ctx.supabase, 'sessions', SEARCH_COLUMNS, filters, { column: 'updated_at', ascending: false }, text ? SEARCH_LIMIT : AGENT_RECENT_LIMIT)
    if (error) throw error

    return (data ?? []).map(row => ({ id: row.id, agentId: row.agent_id, title: row.title, status: row.status, updatedAt: row.updated_at }))
}

const TO_HANDLE_COLUMNS = ['id', 'agent_id', 'title', 'status', 'updated_at'] as const

// The three requests an agent is blocked on, and the three states it merely leaves behind. They are
// read separately so the blocking ones are never pushed out of the page by a pile of old errors,
// which is exactly what a busy workspace accumulates.
const BLOCKING_STATUSES = ['awaiting_question', 'awaiting_approval', 'awaiting_connector'] as const
const TRAILING_STATUSES = ATTENTION_STATUSES.filter(status => !BLOCKING_STATUSES.includes(status as (typeof BLOCKING_STATUSES)[number]))

// How many rows each half of the page brings back. The count beside them stays exact.
const TO_HANDLE_PAGE = 50

// Everything in the workspace waiting on its human, the list the web's To handle tab shows for one
// agent at a time, bounded and with the blocking requests first.
export async function listWorkspaceToHandle(ctx: WorkspaceContext): Promise<ToHandleList> {
    const namesById = new Map((await reachableAgents(ctx)).map(a => [a.id, a.name]))
    if (namesById.size === 0) return { items: [], total: 0 }

    const agentIds = [...namesById.keys()]
    const newestFirst = { column: 'updated_at', ascending: false } as const

    const [blocking, trailing, counted] = await Promise.all([
        selectMany(ctx.supabase, 'sessions', TO_HANDLE_COLUMNS, { agent_id: agentIds, status: [...BLOCKING_STATUSES] }, newestFirst, TO_HANDLE_PAGE),
        selectMany(ctx.supabase, 'sessions', TO_HANDLE_COLUMNS, { agent_id: agentIds, status: [...TRAILING_STATUSES] }, newestFirst, TO_HANDLE_PAGE),
        selectCount(ctx.supabase, 'sessions', { agent_id: agentIds, status: [...ATTENTION_STATUSES] }),
    ])
    if (blocking.error) throw blocking.error
    if (trailing.error) throw trailing.error
    if (counted.error) throw counted.error

    const items = [...(blocking.data ?? []), ...(trailing.data ?? [])].map(row => ({
        sessionId: row.id,
        agentId: row.agent_id,
        agentName: namesById.get(row.agent_id) ?? 'Coworker',
        title: row.title,
        status: row.status,
        updatedAt: row.updated_at,
    }))

    return { items, total: counted.data ?? items.length }
}

// Acknowledging without answering, the same write the board store makes behind « Mark as read ».
// `'all'` empties what the caller reaches, which is what the button of that name promises even when
// the list it sits above only showed a page. The agent filter is what scopes the write; the
// status filter is the race guard: a conversation back in `working` between the render and the tap
// belongs to its run.
export async function markSessionsHandled(ctx: WorkspaceContext, sessionIds: string[] | 'all'): Promise<void> {
    const agentIds = (await reachableAgents(ctx)).map(a => a.id)
    if (agentIds.length === 0) return

    const supabase = createServiceRoleClient()
    let update = supabase
        .from('sessions')
        .update<Database['public']['Tables']['sessions']['Update']>({ status: 'idle' })
        .in('agent_id', agentIds)
        .in('status', [...ATTENTION_STATUSES])
    if (sessionIds !== 'all') update = update.in('id', sessionIds)
    await update
}

// Creates the Supabase mirror row for an engine-only session so it can be
// opened and continued like a regular session. Idempotent per engine session.
export async function adoptEngineSession(agentId: string, engineSessionId: string, title: string, actor?: Actor): Promise<string> {
    const { actor: caller, agent } = await assertAgentAccess(agentId, 'use', actor)
    const workspaceId = agent.workspace_id
    const supabase = createServiceRoleClient()

    const { data: existing } = await selectMaybeSingle(supabase, 'sessions', ['id'] as const, { agent_id: agentId, engine_session_id: engineSessionId })
    if (existing) return existing.id

    const target = await resolveAgentTarget(agentId, caller)
    const session = (await getSession(target.conn, target.engineAgentId, engineSessionId)) ?? (await listSessions(target.conn, target.engineAgentId)).find(s => s.id === engineSessionId)
    // A row is only ever a mirror of a session this agent holds: the column is unique across
    // workspaces, so a made-up id would otherwise squat another workspace's session.
    if (!session) throw new AuthorizationError('Conversation not found')

    let originAgentId: string | null = null
    if (session?.originAgentId) {
        const { data: origin } = await selectMaybeSingle(supabase, 'agents', ['id'] as const, { engine_agent_id: session.originAgentId, workspace_id: workspaceId })
        originAgentId = origin?.id ?? null
    }

    return createSessionRow(agentId, engineSessionId, title, originAgentId, session?.source)
}

export async function readSessionMessages(sessionId: string): Promise<HistoryMessage[]> {
    const ctx = await getSessionEngineContext(sessionId)
    if (!ctx || !ctx.engineSessionId) return []

    const messages = await getSessionMessages(ctx.conn, ctx.engineAgentId, ctx.engineSessionId)
    return transformEngineMessages(messages)
}

export type SessionSnapshot = {
    messages: HistoryMessage[]
    usage: SessionUsageSeed | null
    lastError: string | null
    activeRunId: string | null
    proposals: EngineSkillProposal[]
}

export const EMPTY_SESSION_SNAPSHOT: SessionSnapshot = { messages: [], usage: null, lastError: null, activeRunId: null, proposals: [] }

// Everything a reopened conversation shows, from one resolution of the session and one read of its
// runs. Each part fails on its own: a transcript with no usage gauge beats no transcript at all.
export async function readSessionSnapshot(sessionId: string): Promise<SessionSnapshot> {
    const ctx = await getSessionEngineContext(sessionId)
    if (!ctx || !ctx.engineSessionId) return EMPTY_SESSION_SNAPSHOT
    const { conn, engineAgentId, engineSessionId } = ctx

    const [messages, runs, proposals] = await Promise.all([
        getSessionMessages(conn, engineAgentId, engineSessionId)
            .then(transformEngineMessages)
            .catch(() => []),
        listSessionRuns(conn, engineAgentId, engineSessionId).catch(() => null),
        listSkillProposals(conn, engineAgentId, engineSessionId).catch(() => []),
    ])
    const usage = runs?.lastDone ? await readUsageSeed(conn, engineAgentId, runs.lastDone).catch(() => null) : null

    return { messages, usage, lastError: lastRunError(runs?.latest), activeRunId: runs?.running?.id ?? null, proposals }
}

// Stop covers the whole conversation, not just the run this client happens to be streaming. A run
// nobody holds the id of anymore — a tab closed mid-stream, a duplicate send that raced — would
// otherwise keep going and write its answer minutes later, on top of what the agent already said.
export async function cancelSessionRuns(sessionId: string): Promise<void> {
    const ctx = await getSessionEngineContext(sessionId)
    if (!ctx || !ctx.engineSessionId) return
    const runs = await listRuns(ctx.conn, ctx.engineAgentId, { sessionId: ctx.engineSessionId, status: 'running', limit: 200 })
    const running = runs.filter(r => r.sessionId === ctx.engineSessionId && r.status === 'running')
    await Promise.all(running.map(r => cancelRun(ctx.conn, ctx.engineAgentId, r.id).catch(() => {})))
}

export async function finalizeSession(sessionId: string, status: 'idle' | 'error'): Promise<void> {
    await assertSessionInWorkspace(sessionId)
    await updateSessionStatus(sessionId, status)
}
