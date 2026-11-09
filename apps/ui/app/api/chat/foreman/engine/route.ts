import { FOREMAN_AGENT_ID } from '@rerun/contracts'

import { actorFromContext, callableEngineAgentIds } from '@/app/api/_auth/access'
import { requireWorkspaceContext } from '@/app/api/_auth/ownership'
import { isPhoneStepPending } from '@rerun/cloud/phone.server'
import { messageAuthorOf } from '@/app/api/_services/me.service'
import { getWorkspaceConnection, NoEngineError } from '@/app/api/_services/workspace-engine.service'
import { QUEUED_RETRY_DELAYS_MS, startChat } from '@/lib/chat/start-chat'
import { cancelRun, reconnectRun } from '@/lib/engine/client'
import { cancelForemanSessionRuns, engineSessionOf, loadForemanConversation, readForemanEngineMessages, startEngineConversation, touchForemanConversation } from '@/lib/foreman/conversation'
import { foremanEngineBrief } from '@/lib/foreman/engine-brief'
import { mintForemanHubToken } from '@/lib/foreman/hub-token'
import { loadForemanState } from '@/lib/foreman/state'
import { resolveForemanSurface } from '@/lib/foreman/surface.server'
import { PHONE_REQUIRED_MESSAGE } from '@rerun/cloud/phone'

// The foreman of every workspace past its onboarding, running on the workspace's engine. The loop,
// the model and the transcript are the engine's; the hub only hands it, on every turn, the
// instructions and the tools of where the workspace stands now, then pipes the stream back as it
// does for an agent. The model is picked as
// for an agent, a Claude or Codex subscription included, which the hub cannot reach.

type EngineForemanBody = { sessionId?: unknown; text?: unknown; connectionId?: unknown; model?: unknown; queued?: unknown }

function streamResponse(engineRes: Response, runId: string | null): Response {
    const headers = new Headers()
    headers.set('Content-Type', engineRes.headers.get('content-type') ?? 'text/event-stream')
    headers.set('x-vercel-ai-ui-message-stream', engineRes.headers.get('x-vercel-ai-ui-message-stream') ?? 'v1')
    if (runId) headers.set('X-Run-Id', runId)
    return new Response(engineRes.body, { headers })
}

async function authorize(): Promise<Awaited<ReturnType<typeof requireWorkspaceContext>> | Response> {
    let ctx: Awaited<ReturnType<typeof requireWorkspaceContext>>
    try {
        ctx = await requireWorkspaceContext()
    } catch {
        return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    if (ctx.authUser.is_anonymous) return Response.json({ error: 'Unauthorized' }, { status: 401 })
    return ctx
}

export async function POST(req: Request): Promise<Response> {
    const ctx = await authorize()
    if (ctx instanceof Response) return ctx
    if (await isPhoneStepPending(ctx.supabase, ctx.userId)) return Response.json({ error: PHONE_REQUIRED_MESSAGE }, { status: 403 })

    let body: EngineForemanBody
    try {
        body = (await req.json()) as EngineForemanBody
    } catch {
        return Response.json({ error: 'Invalid request body' }, { status: 400 })
    }

    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
    const text = typeof body.text === 'string' ? body.text.trim() : ''
    if (!sessionId || !text) return Response.json({ error: 'Missing session id or message' }, { status: 400 })
    const connectionId = typeof body.connectionId === 'string' ? body.connectionId : undefined
    const model = typeof body.model === 'string' ? body.model : undefined
    const queued = body.queued === true

    const existing = await engineSessionOf(ctx, sessionId)
    if (existing?.backend === 'hub') return Response.json({ error: 'hub_conversation' }, { status: 409 })

    const state = await loadForemanState(ctx, req.headers.get('accept-language'))
    if (!existing && (await resolveForemanSurface(ctx.workspace.id, state, { canClaim: true })) !== 'engine') return Response.json({ error: 'foreman_unavailable' }, { status: 409 })

    let engineRes: Response
    let conn: Awaited<ReturnType<typeof getWorkspaceConnection>>
    try {
        conn = await getWorkspaceConnection(ctx.workspace.id)
        engineRes = await startChat(conn, FOREMAN_AGENT_ID, { sessionId: existing?.engineSessionId ?? undefined, message: text, connectionId, model, source: 'dashboard', foreman: { ...foremanEngineBrief(state), hubToken: mintForemanHubToken(ctx.workspace.id, ctx.userId) ?? undefined }, author: messageAuthorOf(ctx), callableAgentIds: await callableEngineAgentIds(actorFromContext(ctx)) }, queued ? QUEUED_RETRY_DELAYS_MS : null)
    } catch (err) {
        // The machine went away under a conversation that was already going: the browser hides the
        // foreman, which only exists beside a machine.
        if (err instanceof NoEngineError) return Response.json({ error: 'foreman_unavailable' }, { status: 409 })
        return Response.json({ error: `Engine error: ${err instanceof Error ? err.message : 'Failed to start chat'}` }, { status: 502 })
    }

    // Same contract as an agent chat. A send that raced a run already under way tails that run
    // instead of starting a second one; a queued message carries text nobody has read yet, so it is
    // handed back for the column to queue again rather than dropped.
    if (engineRes.status === 409) {
        const busy = (await engineRes.json().catch(() => null)) as { runId?: string; startedAt?: string | null } | null
        const busyResponse = () => Response.json({ error: 'run_in_flight', runId: busy?.runId ?? null, startedAt: busy?.startedAt ?? null }, { status: 409 })
        if (queued || !busy?.runId) return busyResponse()
        const tail = await reconnectRun(conn, FOREMAN_AGENT_ID, busy.runId).catch(() => null)
        if (!tail || tail.status === 204 || !tail.ok || !tail.body) return busyResponse()
        return streamResponse(tail, busy.runId)
    }
    if (!engineRes.ok || !engineRes.body) {
        const errBody = await engineRes.text().catch(() => '')
        return Response.json({ error: `Engine error: ${engineRes.status} ${errBody}` }, { status: 502 })
    }

    if (existing) {
        await touchForemanConversation(sessionId)
    } else {
        const engineSessionId = engineRes.headers.get('x-session-id')
        if (!engineSessionId) return Response.json({ error: 'Engine did not return a session id' }, { status: 502 })
        try {
            await startEngineConversation(ctx, sessionId, engineSessionId, text)
        } catch {
            return Response.json({ error: 'Failed to persist the conversation' }, { status: 500 })
        }
    }

    return streamResponse(engineRes, engineRes.headers.get('x-run-id'))
}

// The last conversation with the foreman on the engine, for the column to reopen on. With a session
// id, the transcript of that conversation alone: what the column reads again once a run it was
// following is over.
export async function GET(req: Request): Promise<Response> {
    const ctx = await authorize()
    if (ctx instanceof Response) return ctx

    const sessionId = new URL(req.url).searchParams.get('sessionId')
    if (sessionId) return Response.json({ messages: await readForemanEngineMessages(ctx, sessionId).catch(() => []) })

    // A transcript that cannot be read, the machine asleep or gone, is not an error the column can
    // act on: it opens empty.
    const conversation = await loadForemanConversation(ctx, 'engine').catch(err => {
        console.error('[foreman] failed to read the engine conversation:', err)
        return null
    })
    return Response.json(conversation)
}

// Stop. Closing the stream alone would leave the run going on the engine, still spending credit on
// an answer nobody reads.
export async function DELETE(req: Request): Promise<Response> {
    const ctx = await authorize()
    if (ctx instanceof Response) return ctx

    const params = new URL(req.url).searchParams
    const runId = params.get('runId')
    const sessionId = params.get('sessionId')
    if (!runId && !sessionId) return Response.json({ error: 'Missing run id' }, { status: 400 })

    try {
        // The session goes first: cancelling a run frees the conversation on the engine, and a message
        // waiting behind it starts its own run at once. Listed after that, the new run would be swept
        // away too. The run this tab streamed is then stopped by name, which also works on an engine
        // that cannot list the foreman's runs yet.
        if (sessionId) await cancelForemanSessionRuns(ctx, sessionId).catch(err => (runId ? undefined : Promise.reject(err)))
        if (runId) await cancelRun(await getWorkspaceConnection(ctx.workspace.id), FOREMAN_AGENT_ID, runId)
    } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : 'Failed to stop the run' }, { status: 502 })
    }
    return Response.json({ ok: true })
}
