import { COWORKER_NOT_FOUND, assertSessionInWorkspace, enforce, requireLightSessionActor, spaceAccessFor, visibleSpaceIds, type AccessLevel, type Actor } from '@/app/api/_auth/access'
import { AuthorizationError, requireWorkspaceContext } from '@/app/api/_auth/ownership'
import type { Database } from '@/app/api/database.types'
import type { SessionStatus } from '@/lib/board/types'
import { getRunSteps, listRuns } from '@/lib/engine/client'
import type { EngineConnection, EngineRun, SessionSource } from '@/lib/engine/types'
import { FOREMAN_AGENT_ID, type SessionKind, type Usage } from '@rerun/contracts'
import { createServiceRoleClient } from '@/supabase/serviceRole'
import { selectMany, selectManyWithJoins, selectMaybeSingle, selectMaybeSingleWithJoins } from '@/supabase/supabase-helpers'
import { isTemplateContentLocked } from '@/lib/templates/content-lock'
import { isPlanLimited } from './capacity.service'
import { findWorkspaceEngine, NoEngineError, type WorkspaceEngine } from './workspace-engine.service'

export type AgentChatTarget = {
    engineAgentId: string
    conn: EngineConnection
    // Whether the content this agent inherited from a template has to stay sealed. Resolved here
    // because this is the one place every read of an agent already goes through.
    contentLocked: boolean
}

// Ownership and access gate. This is the single chokepoint for the agent server actions, /api/chat,
// the v1 routes and the MCP account server, all of which then talk to the engine/DB via the
// service-role client (which bypasses RLS), so we re-establish object-level authz in code: the agent
// has to sit in the caller's workspace, and in a Box the caller reaches at the level asked (`use` to
// talk to it and read it, `manage` to change what it is). `actor` is passed in when the caller is not
// the browser session: a v1 route's context, an API key or a foreman turn (the workspace itself).
export async function resolveAgentTarget(agentId: string, actor?: Actor, access: AccessLevel = 'use'): Promise<AgentChatTarget> {
    // The agent row doesn't depend on the caller, and the caller's machine only on its workspace, so
    // all three are read at once. The machine read before the ownership check is the caller's own.
    const callerActor = actor ? Promise.resolve(actor) : requireLightSessionActor()
    const [resolvedActor, row, engine] = await Promise.all([callerActor, fetchAgentRow(agentId), callerActor.then(a => findWorkspaceEngine(a.workspaceId))])
    if (!row || row.workspace_id !== resolvedActor.workspaceId) throw new AuthorizationError(COWORKER_NOT_FOUND)
    enforce(await spaceAccessFor(resolvedActor, { id: row.space_id, workspace_id: row.workspace_id, visibility: row.space?.visibility ?? null }), access, COWORKER_NOT_FOUND)
    return buildTarget(row, engine)
}

export async function getAgentChatTarget(agentId: string, access: AccessLevel = 'use'): Promise<AgentChatTarget> {
    return resolveAgentTarget(agentId, undefined, access)
}

// The foreman has no agent row: it lives on the workspace's engine under a fixed id, and any signed-in
// member of the workspace may reach it. Only what reads or stops a run, picks its model or carries
// the files of a chat message resolves through here. Talking to it stays with its own route, which
// is where its brief is written.
export async function resolveRunTarget(agentId: string, access: AccessLevel = 'use'): Promise<AgentChatTarget> {
    if (agentId !== FOREMAN_AGENT_ID) return getAgentChatTarget(agentId, access)
    const ctx = await requireWorkspaceContext()
    if (ctx.authUser.is_anonymous) throw new AuthorizationError('Coworker not found')
    const engine = await findWorkspaceEngine(ctx.workspace.id)
    if (!engine) throw new NoEngineError()
    return { conn: engine.conn, engineAgentId: FOREMAN_AGENT_ID, contentLocked: false }
}

async function fetchAgentRow(agentId: string) {
    const { data } = await selectMaybeSingleWithJoins(
        createServiceRoleClient(),
        'agents',
        ['workspace_id', 'space_id', 'engine_agent_id', 'template_id', 'disabled_at', 'disabled_reason'] as const,
        {
            workspaces: { table: 'workspaces', foreignKey: 'workspaces', columns: ['subscription_status', 'is_sandbox'] },
            space: { table: 'spaces', foreignKey: 'spaces', columns: ['visibility'] },
        } as const,
        { id: agentId },
    )
    return data
}

// An agent is switched off either because the plan has no slot for it or because the template
// subscription it came from ended, and only one of those the user can fix from here.
function disabledMessage(reason: string | null): string {
    if (isPlanLimited(reason)) return 'This coworker is inactive: your plan has no free coworker slot. Activate it from the coworker panel.'
    return 'This coworker is disabled: the template subscription it came from has ended.'
}

function buildTarget(row: NonNullable<Awaited<ReturnType<typeof fetchAgentRow>>>, engine: WorkspaceEngine | null): AgentChatTarget {
    // Every interactive path lands here, so this one line is what stops a disabled agent from
    // being talked to. The engine side only pauses schedules and flips a config flag, and a box
    // that was asleep when that ran would otherwise still answer.
    if (row.disabled_at) throw new Error(disabledMessage(row.disabled_reason))
    if (!row.engine_agent_id) throw new Error('Coworker not configured or not found')

    if (!engine) throw new NoEngineError()

    return { engineAgentId: row.engine_agent_id, conn: engine.conn, contentLocked: isTemplateContentLocked({ templateId: row.template_id }, row.workspaces) }
}

// A webhook trigger has no session and no API key: its authorization IS the secret token in the
// public URL, which the engine verifies against the trigger file. So this skips the workspace
// comparison on purpose, and answers null rather than throwing, because every failure on that
// route has to come back as the same opaque 404.
export async function resolveAgentTargetForTrigger(agentId: string): Promise<AgentChatTarget | null> {
    const row = await fetchAgentRow(agentId)
    if (!row || row.disabled_at || !row.engine_agent_id) return null
    const engine = await findWorkspaceEngine(row.workspace_id)
    if (!engine) return null
    return {
        engineAgentId: row.engine_agent_id,
        conn: engine.conn,
        // A webhook renders nothing to a human: there is no payload here to seal.
        contentLocked: false,
    }
}

// Resolve an existing Supabase session row to its engine session id.
export async function getExistingSession(sessionId: string): Promise<{ sessionId: string; agentId: string; engineSessionId: string | null }> {
    const session = await assertSessionInWorkspace(sessionId)
    return { sessionId: session.id, agentId: session.agent_id, engineSessionId: session.engine_session_id || null }
}

export const GENERAL_SESSION_TITLE = 'General'

// The unique index `sessions_general_per_agent_idx` refuses a second General for the same coworker.
const UNIQUE_VIOLATION = '23505'

export type GeneralSession = { id: string; engineSessionId: string }

// Thrown when a General is inserted for a coworker that already has one: two tabs raced to open
// it, and the one that lost is told which row won so the chat can start over on that session.
export class GeneralAlreadyOpenError extends Error {
    constructor(readonly general: GeneralSession) {
        super('General already open')
    }
}

// General shows a thread under the message it opened with: the hub keeps that much of it, and no more.
export const FIRST_MESSAGE_MAX_CHARS = 300

// Persist a Supabase session row pointing at the engine-created session. A `general` row is the
// coworker's main conversation: fixed title, one per coworker, and no opening message to show.
export async function createSessionRow(agentId: string, engineSessionId: string, title: string, originAgentId?: string | null, source?: SessionSource, kind: SessionKind = 'thread', firstMessage?: string | null): Promise<string> {
    const supabase = createServiceRoleClient()

    const { data: session, error } = await supabase
        .from('sessions')
        .insert<Database['public']['Tables']['sessions']['Insert']>({
            agent_id: agentId,
            engine_session_id: engineSessionId,
            title: kind === 'general' ? GENERAL_SESSION_TITLE : title?.slice(0, 50) || 'New conversation',
            origin_agent_id: originAgentId ?? null,
            source: source ?? 'dashboard',
            kind,
            first_message: kind === 'general' ? null : firstMessage?.trim().slice(0, FIRST_MESSAGE_MAX_CHARS) || null,
        })
        .select('id')
        .single()

    if (!session) {
        if (kind === 'general' && error?.code === UNIQUE_VIOLATION) {
            const existing = await findGeneralSession(agentId)
            if (existing) throw new GeneralAlreadyOpenError(existing)
        }
        throw new Error('Failed to create session')
    }

    return session.id
}

// The coworker's main conversation, once someone has spoken in it.
export async function findGeneralSession(agentId: string): Promise<GeneralSession | null> {
    const { data } = await selectMaybeSingle(createServiceRoleClient(), 'sessions', ['id', 'engine_session_id'] as const, { agent_id: agentId, kind: 'general' })
    return data ? { id: data.id, engineSessionId: data.engine_session_id } : null
}

// Mirrors an engine session the hub opened outside the browser: the foreman handing an agent its
// setup, an MCP send_message, anything that drops the stream instead of streaming it back. That row
// is what carries the conversation into the agent's chat and what holds the `awaiting_*` state the
// board draws, so a run started without it executes for nobody: it burns its tokens against an
// empty "New conversation".
//
// Idempotent per engine session, because the notification webhook mirrors the same session the
// moment the run reports anything: conflicting is the expected outcome, not a failure, and the row
// already there keeps the status it earned rather than being pushed back to `working`.
export async function ensureSessionRow(agentId: string, engineSessionId: string, title: string, options?: { source?: SessionSource; originAgentId?: string | null; status?: SessionStatus }): Promise<string | null> {
    const supabase = createServiceRoleClient()

    const { error } = await supabase.from('sessions').upsert<Database['public']['Tables']['sessions']['Insert']>(
        {
            agent_id: agentId,
            engine_session_id: engineSessionId,
            title: title?.slice(0, 50) || 'New conversation',
            origin_agent_id: options?.originAgentId ?? null,
            source: options?.source ?? 'dashboard',
            status: options?.status ?? 'idle',
            automation_name: options?.source === 'schedule' || options?.source === 'trigger' ? title : null,
        },
        { onConflict: 'engine_session_id', ignoreDuplicates: true },
    )
    // Never thrown: the message is already on its way to the agent, and failing the caller here
    // would report a run that did start as one that never happened.
    if (error) {
        console.error('[sessions] failed to mirror the engine session', error)
        return null
    }

    return sessionRowOf(agentId, engineSessionId)
}

// The row the agent panel opens a conversation on, for a session the engine names.
export async function sessionRowOf(agentId: string, engineSessionId: string): Promise<string | null> {
    const { data } = await selectMaybeSingle(createServiceRoleClient(), 'sessions', ['id'] as const, { agent_id: agentId, engine_session_id: engineSessionId })
    return data?.id ?? null
}

export async function updateSessionStatus(sessionId: string, status: SessionStatus) {
    const supabase = createServiceRoleClient()
    await supabase.from('sessions').update<Database['public']['Tables']['sessions']['Update']>({ status }).eq('id', sessionId)
}

// Acknowledging an alert only clears that alert: a run started since then owns the status now.
export async function clearSessionAlert(sessionId: string) {
    const supabase = createServiceRoleClient()
    await supabase.from('sessions').update<Database['public']['Tables']['sessions']['Update']>({ status: 'idle' }).eq('id', sessionId).eq('status', 'awaiting_ack')
}

// A decided skill proposal only clears the wait it raised itself. The status alone cannot tell: a
// run stopped on request_approval leaves the same `awaiting_approval`, and that one is still owed
// an answer. What the session waits on is the latest thing its agent said that was not a `done`.
export async function clearSkillProposalAttention(sessionId: string, agentId: string, engineSessionId: string | null) {
    if (!engineSessionId) return
    const supabase = createServiceRoleClient()
    const { data } = await selectMany(supabase, 'notifications', ['metadata'] as const, { agent_id: agentId, engine_session_id: engineSessionId, kind: { neq: 'done' } }, { column: 'created_at', ascending: false }, 1)
    const waitingOn = (data?.[0]?.metadata as { toolName?: unknown } | null | undefined)?.toolName
    if (waitingOn !== 'skill_propose') return
    await supabase.from('sessions').update<Database['public']['Tables']['sessions']['Update']>({ status: 'idle' }).eq('id', sessionId).eq('status', 'awaiting_approval')
}

export type SessionEngineContext = { agentId: string; conn: EngineConnection; engineAgentId: string; engineSessionId: string | null }

// Full engine context for a Supabase session (used to replay history).
export async function getSessionEngineContext(sessionId: string): Promise<SessionEngineContext | null> {
    const actor = requireLightSessionActor()
    const [session, engine] = await Promise.all([assertSessionInWorkspace(sessionId, actor), actor.then(a => findWorkspaceEngine(a.workspaceId))])
    if (!session.engine_agent_id) return null
    if (!engine) throw new NoEngineError()

    return { agentId: session.agent_id, conn: engine.conn, engineAgentId: session.engine_agent_id, engineSessionId: session.engine_session_id || null }
}

export type SessionRuns = { latest?: EngineRun; lastDone?: EngineRun; running?: EngineRun }

// The runs that speak for a conversation, newest first. The filter stays even though the engine
// narrows to the session: one that predates `session` returns the agent's latest runs instead.
export function summarizeSessionRuns(runs: EngineRun[], engineSessionId: string): SessionRuns {
    const own = runs.filter(r => r.sessionId === engineSessionId).sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    return { latest: own[0], lastDone: own.find(r => r.status === 'done'), running: own.find(r => r.status === 'running') }
}

export async function listSessionRuns(conn: EngineConnection, engineAgentId: string, engineSessionId: string): Promise<SessionRuns> {
    const runs = await listRuns(conn, engineAgentId, { sessionId: engineSessionId, limit: 200 })
    return summarizeSessionRuns(runs, engineSessionId)
}

// A run that failed writes its error on its own row and nothing into the transcript, so a
// conversation whose run died before saying anything reads as if the agent never answered. Only the
// newest run speaks for the conversation: an older failure a later run answered over is not what
// the person opening it is looking at. A cancelled run carries no error and stays silent.
export function lastRunError(latest: EngineRun | undefined): string | null {
    if (latest?.status !== 'error') return null
    return latest.error?.trim() || null
}

export type SessionUsageSeed = { usage: Usage; provider: string | null }

// Resident context of a session's latest finished run, used to seed the in-chat
// context gauge when a conversation is reopened (history messages carry no usage).
// The last step's input tokens already include the whole conversation sent to the
// model, so it reflects how full the context window is; runs.usageJson is the
// cumulative sum across steps and would over-count a multi-step run. For claude
// runs the whole CLI loop is one step whose numbers are that same cumulative sum,
// so the real occupancy lives in usageJson's `context` block, grafted on here.
export async function readUsageSeed(conn: EngineConnection, engineAgentId: string, lastDone: EngineRun): Promise<SessionUsageSeed | null> {
    const fromJson = lastDone.usageJson ? (JSON.parse(lastDone.usageJson) as Usage | null) : null
    const steps = await getRunSteps(conn, engineAgentId, lastDone.id)
    const lastStep = steps.sort((a, b) => b.stepNumber - a.stepNumber)[0]
    if (lastStep) {
        return {
            usage: {
                inputTokens: lastStep.inputTokens ?? undefined,
                outputTokens: lastStep.outputTokens ?? undefined,
                totalTokens: lastStep.totalTokens ?? undefined,
                reasoningTokens: lastStep.reasoningTokens ?? undefined,
                cachedInputTokens: lastStep.cachedInputTokens ?? undefined,
                context: fromJson?.context,
            },
            provider: lastDone.provider,
        }
    }
    return fromJson ? { usage: fromJson, provider: lastDone.provider } : null
}

export async function findSessionActiveRun(sessionId: string): Promise<string | null> {
    try {
        const ctx = await getSessionEngineContext(sessionId)
        if (!ctx || !ctx.engineSessionId) return null
        const { running } = await listSessionRuns(ctx.conn, ctx.engineAgentId, ctx.engineSessionId)
        return running?.id ?? null
    } catch {
        return null
    }
}

// Which of these sessions the engine confirms has no run in flight: one listing of the running runs
// per agent rather than one per session. A session never mirrored to the engine, or on a workspace
// that has no machine anymore, counts as idle; one whose agent could not be asked is left out, so it
// stays as it was. Sessions of another workspace, or of a Box the caller cannot see, are ignored.
export async function findIdleSessions(sessionIds: string[], actor?: Actor): Promise<string[]> {
    const callerActor = actor ? Promise.resolve(actor) : requireLightSessionActor()
    const [resolvedActor, { data: rows }, engine] = await Promise.all([
        callerActor,
        selectManyWithJoins(createServiceRoleClient(), 'sessions', ['id', 'engine_session_id'] as const, { agent: { table: 'agents', foreignKey: 'agents!sessions_agent_id_fkey', columns: ['workspace_id', 'space_id', 'engine_agent_id'] } } as const, { id: sessionIds }),
        callerActor.then(a => findWorkspaceEngine(a.workspaceId)),
    ])
    const visible = await visibleSpaceIds(resolvedActor)
    const owned = (rows ?? []).filter(row => row.agent?.workspace_id === resolvedActor.workspaceId && (visible === 'all' || visible.has(row.agent.space_id)))
    if (!engine) return owned.map(row => row.id)

    const idle: string[] = []
    const byAgent = new Map<string, { id: string; engineSessionId: string }[]>()
    for (const row of owned) {
        if (!row.agent.engine_agent_id || !row.engine_session_id) {
            idle.push(row.id)
            continue
        }
        byAgent.set(row.agent.engine_agent_id, [...(byAgent.get(row.agent.engine_agent_id) ?? []), { id: row.id, engineSessionId: row.engine_session_id }])
    }
    await Promise.all(
        [...byAgent].map(async ([engineAgentId, sessions]) => {
            const runs = await listRuns(engine.conn, engineAgentId, { status: 'running', limit: 200 }).catch(() => null)
            if (!runs) return
            const live = new Set(runs.filter(r => r.status === 'running').map(r => r.sessionId))
            for (const session of sessions) if (!live.has(session.engineSessionId)) idle.push(session.id)
        }),
    )
    return idle
}
