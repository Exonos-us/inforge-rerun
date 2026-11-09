import { actorFromContext, callableEngineAgentIds } from '@/app/api/_auth/access'
import { requireWorkspaceContext } from '@/app/api/_auth/ownership'
import { createSessionRow, ensureSessionRow, findGeneralSession, GeneralAlreadyOpenError, getAgentChatTarget, getExistingSession, updateSessionStatus } from '@/app/api/_services/chat.service'
import { messageAuthorOf } from '@/app/api/_services/me.service'
import { recordSessionParticipant, recordSessionRead } from '@/app/api/_services/notification-audience.service'
import type { Database } from '@/app/api/database.types'
import { generateSessionTitle } from '@/lib/ai/generate-title'
import { cancelRun, reconnectRun } from '@/lib/engine/client'
import { QUEUED_RETRY_DELAYS_MS, startChat } from '@/lib/chat/start-chat'
import { stripAttachmentsRef } from '@/lib/chat/attachments-marker'
import { installSessionTitle, parseInstallMessage } from '@/lib/chat/install-marker'
import { preferredLanguage } from '@/lib/foreman/language'
import { stripVoiceMarker } from '@/lib/voice/marker'
import { createServiceRoleClient } from '@/supabase/serviceRole'
import { ENGINE_SESSION_NOT_FOUND, SESSION_NOT_FOUND, type MessageAuthor, type SessionKind, type SessionSource } from '@rerun/contracts'

type ChatRequestBody = {
    agentId?: unknown
    sessionId?: string
    text?: unknown
    connectionId?: string
    model?: string
    source?: SessionSource
    queued?: boolean
    // `general` opens the coworker's main conversation when no `sessionId` names it yet. Read only
    // on a new conversation; an install always runs in a thread of its own.
    kind?: SessionKind
}

// A code rather than the engine's sentence: the chat turns it into a notice that opens a new
// conversation, instead of a red box quoting the engine.
const sessionNotFound = () => Response.json({ error: SESSION_NOT_FOUND }, { status: 404 })

export async function POST(request: Request) {
    // Reject unauthenticated callers up front. getAgentChatTarget below also
    // enforces that the agent belongs to this workspace (defense in depth).
    let author: MessageAuthor
    let callablePromise: Promise<string[] | undefined>
    try {
        const ctx = await requireWorkspaceContext()
        author = messageAuthorOf(ctx)
        // Read alongside the body and awaited inside the engine call's try: a failure fails the send
        // rather than letting it through with every coworker callable.
        callablePromise = callableEngineAgentIds(actorFromContext(ctx))
        callablePromise.catch(() => {})
    } catch {
        return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // A malformed body is not exceptional here: the Next proxy truncates anything over its
    // 10MB cap, and an unhandled parse error would answer 500 with an empty body, which the
    // AI SDK turns into an Error with no message at all.
    let body: ChatRequestBody
    try {
        body = await request.json()
    } catch {
        return Response.json({ error: 'Invalid request body' }, { status: 400 })
    }

    const { agentId, connectionId, model, source, queued } = body
    let { sessionId } = body

    if (typeof agentId !== 'string') {
        return Response.json({ error: 'Missing coworker id' }, { status: 400 })
    }

    const text = typeof body.text === 'string' ? body.text : ''

    if (!text) {
        return Response.json({ error: 'Missing message text' }, { status: 400 })
    }

    const target = await getAgentChatTarget(agentId).catch(() => null)
    if (!target) {
        return Response.json({ error: 'Coworker not configured or not found' }, { status: 400 })
    }

    // A voice message carries its audio as a marker appended to the transcript; the session title
    // is about what was said, not about the file. An install is named after the setup it starts,
    // never after a summary of its guide.
    const install = parseInstallMessage(text)
    const sessionTitleSeed = install ? installSessionTitle(install.agentName) : stripVoiceMarker(stripAttachmentsRef(text))

    // A tab that opens General before anyone spoke in it has no session id: the row may still exist,
    // written by another tab or another member a moment ago, and then it is the one to continue.
    const general = body.kind === 'general' && !sessionId && !install
    if (general) {
        const existing = await findGeneralSession(agentId).catch(() => null)
        if (existing) sessionId = existing.id
    }

    // Resolve the engine session id for an existing conversation.
    let engineSessionId: string | undefined
    if (sessionId) {
        let existing: Awaited<ReturnType<typeof getExistingSession>>
        try {
            existing = await getExistingSession(sessionId)
        } catch {
            return Response.json({ error: 'Failed to resolve session' }, { status: 500 })
        }
        // A tab of one coworker holding another one's conversation: the engine would answer with a
        // raw 404, since the session lives in the other coworker's database.
        if (existing.agentId !== agentId) {
            console.warn(`[CHAT SESSION MISMATCH] agent=${agentId} session=${sessionId} owner=${existing.agentId}`)
            return sessionNotFound()
        }
        engineSessionId = existing.engineSessionId ?? undefined
    }

    let engineRes!: Response
    let supabaseSessionId!: string
    // Two passes at most: when another tab opened General between the lookup above and the insert
    // below, the message is sent again on the General that won.
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            console.log(`[CHAT START] agent=${agentId} session=${sessionId ?? '(new)'} inputLength=${text.length}${queued ? ' queued' : ''}`)
            engineRes = await startChat(target.conn, target.engineAgentId, { sessionId: engineSessionId, message: text, connectionId, model, source, author, callableAgentIds: await callablePromise, install: !!install && !sessionId, userLanguage: install && !sessionId ? (preferredLanguage(request.headers.get('accept-language')) ?? undefined) : undefined }, queued ? QUEUED_RETRY_DELAYS_MS : null)
        } catch (err) {
            return Response.json({ error: `Engine error: ${err instanceof Error ? err.message : 'Failed to start chat'}` }, { status: 502 })
        }

        // The engine allows a single live run per conversation. A 409 means this send raced one that
        // is already under way — nearly always the same answer delivered twice by an interactive block.
        // Tail the run in flight instead of starting a second one: the caller gets a normal stream, and
        // the duplicate text is dropped on purpose (it would only repeat what the agent is answering).
        if (engineRes.status === 409) {
            const busy = (await engineRes.json().catch(() => null)) as { code?: string; sessionId?: string; runId?: string; startedAt?: string | null; authorId?: string | null } | null
            // The agent's install already runs in another conversation: the chat opens that one rather
            // than a second install. Its row is mirrored here in case the run that opened it never got
            // that far.
            if (busy?.code === 'install_in_flight' && busy.sessionId && install) {
                const installSessionId = await ensureSessionRow(agentId, busy.sessionId, sessionTitleSeed, { source })
                return Response.json({ error: 'install_in_flight', sessionId: installSessionId }, { status: 409 })
            }
            console.warn(`[CHAT BUSY] agent=${agentId} session=${sessionId ?? '(new)'} run=${busy?.runId ?? '?'} input=${JSON.stringify(text.slice(0, 200))}`)
            // `run_in_flight` rather than a sentence: the chat turns it into a notice with a Stop
            // button and puts the text back in the composer, instead of a red box with nothing to click.
            // A run a teammate started is answering their message, not this one: tailing it would drop
            // text nobody has read. The chat queues it behind that run instead.
            const heldByTeammate = Boolean(busy?.authorId) && busy?.authorId !== author.id
            const busyResponse = () => Response.json({ error: 'run_in_flight', runId: busy?.runId ?? null, startedAt: busy?.startedAt ?? null, heldByTeammate }, { status: 409 })
            // A queued message carries text nobody has read yet, so it is never dropped: the chat puts
            // it back in the queue and sends it again once the conversation frees up. The same goes
            // for a message sent again on the General that won a race: the run it meets there is
            // answering the other tab's text, not a copy of this one.
            if (queued || heldByTeammate || !busy?.runId || attempt > 0) return busyResponse()
            engineRes = await reconnectRun(target.conn, target.engineAgentId, busy.runId).catch(() => new Response(null, { status: 204 }))
            if (engineRes.status === 204 || !engineRes.ok || !engineRes.body) {
                return busyResponse()
            }
            const headers = new Headers()
            headers.set('Content-Type', engineRes.headers.get('content-type') ?? 'text/event-stream')
            headers.set('x-vercel-ai-ui-message-stream', engineRes.headers.get('x-vercel-ai-ui-message-stream') ?? 'v1')
            if (sessionId) headers.set('X-Session-Id', sessionId)
            headers.set('X-Run-Id', busy.runId)
            return new Response(engineRes.body, { headers })
        }

        if (!engineRes.ok || !engineRes.body) {
            const errBody = await engineRes.text().catch(() => '')
            if (engineRes.status === 404 && errBody.includes(ENGINE_SESSION_NOT_FOUND)) {
                console.warn(`[CHAT SESSION GONE] agent=${agentId} session=${sessionId ?? '(new)'} engineSession=${engineSessionId ?? '?'}`)
                return sessionNotFound()
            }
            return Response.json({ error: `Engine error: ${engineRes.status} ${errBody}` }, { status: 502 })
        }

        // The engine returns the (possibly newly created) session id as a header.
        const resolvedEngineSessionId = engineRes.headers.get('x-session-id') ?? engineSessionId

        // Map to the Supabase session row the UI tracks.
        if (!sessionId) {
            if (!resolvedEngineSessionId) {
                return Response.json({ error: 'Engine did not return a session id' }, { status: 502 })
            }
            try {
                supabaseSessionId = await createSessionRow(agentId, resolvedEngineSessionId, sessionTitleSeed, null, source, general ? 'general' : 'thread', install ? null : sessionTitleSeed)
            } catch (err) {
                // Another tab opened General a moment ago: the run just started belongs to no row. It is
                // cancelled, and the message starts over on the General that won.
                if (err instanceof GeneralAlreadyOpenError && attempt === 0) {
                    console.warn(`[CHAT GENERAL RACE] agent=${agentId} orphan=${resolvedEngineSessionId} general=${err.general.engineSessionId}`)
                    void engineRes.body?.cancel().catch(() => {})
                    const orphanRunId = engineRes.headers.get('x-run-id')
                    if (orphanRunId) void cancelRun(target.conn, target.engineAgentId, orphanRunId).catch(() => {})
                    sessionId = err.general.id
                    engineSessionId = err.general.engineSessionId
                    continue
                }
                return Response.json({ error: 'Failed to persist session' }, { status: 500 })
            }
            // General keeps its name; a thread is named after what it opens with.
            if (!install && !general) {
                generateSessionTitle(sessionTitleSeed)
                    .then(async title => {
                        const supabase = createServiceRoleClient()
                        await supabase.from('sessions').update<Database['public']['Tables']['sessions']['Update']>({ title }).eq('id', supabaseSessionId)
                    })
                    .catch(() => {})
            }
        } else {
            supabaseSessionId = sessionId
            if (resolvedEngineSessionId && resolvedEngineSessionId !== engineSessionId) {
                // Backfill the engine session id if we didn't have it yet.
                const supabase = createServiceRoleClient()
                await supabase.from('sessions').update<Database['public']['Tables']['sessions']['Update']>({ engine_session_id: resolvedEngineSessionId }).eq('id', supabaseSessionId).then()
            }
        }
        break
    }

    await updateSessionStatus(supabaseSessionId, 'working')
    await Promise.all([recordSessionParticipant(supabaseSessionId, author.id), recordSessionRead(supabaseSessionId, author.id)])

    const headers = new Headers()
    headers.set('Content-Type', engineRes.headers.get('content-type') ?? 'text/event-stream')
    headers.set('x-vercel-ai-ui-message-stream', engineRes.headers.get('x-vercel-ai-ui-message-stream') ?? 'v1')
    headers.set('X-Session-Id', supabaseSessionId)
    const runId = engineRes.headers.get('x-run-id')
    if (runId) headers.set('X-Run-Id', runId)

    return new Response(engineRes.body, { headers })
}
