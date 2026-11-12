import { ensureGlobalOauthAccess, globalConnectionForProxy, markGlobalNeedsReconnect, type GlobalOauthBundle } from '@/app/api/_services/global-apps.service'
import { authenticateEngineToken } from '@/app/api/_services/workspace-engine.service'
import { assertPublicUrl } from '@/lib/net/public-fetch'
import { createServiceRoleClient } from '@/supabase/serviceRole'
import { selectMaybeSingle } from '@/supabase/supabase-helpers'

// The MCP front door of an OAuth Global apps connection: a transparent pass-through to the real
// MCP server, with the workspace token injected (and refreshed) here. The engine never holds the
// token; a coworker bound to the connection is compiled with this URL and nothing else.
//
// Auth model mirrors /api/mcp/composio: `x-rerun-key` proves the engine and pins the workspace,
// `x-rerun-agent` is resolved WITHIN that workspace, and the connection id in the path must be a
// connection of that workspace this coworker was enabled on. A forged config can only ever reach
// accounts its own workspace connected.
export const dynamic = 'force-dynamic'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// What travels through: the MCP streamable-http vocabulary, nothing else. Authorization is ours.
const FORWARDED_REQUEST_HEADERS = ['content-type', 'accept', 'mcp-session-id', 'last-event-id', 'mcp-protocol-version']
const FORWARDED_RESPONSE_HEADERS = ['content-type', 'mcp-session-id', 'mcp-protocol-version']

type ProxyTarget = { connectionId: string; url: URL; bundle: GlobalOauthBundle; label: string }

async function resolveTarget(req: Request, connectionId: string): Promise<ProxyTarget | Response> {
    if (!UUID_RE.test(connectionId)) return new Response('Invalid connection id', { status: 400 })

    const engine = await authenticateEngineToken(req.headers.get('x-rerun-key') ?? '')
    if (!engine) return new Response('Unauthorized', { status: 401 })

    const supabase = createServiceRoleClient()
    const engineAgentId = req.headers.get('x-rerun-agent') ?? ''
    const { data: agent } = engineAgentId ? await selectMaybeSingle(supabase, 'agents', ['id'] as const, { engine_agent_id: engineAgentId, workspace_id: engine.workspaceId }) : { data: null }
    if (!agent) return new Response('Coworker does not belong to the authenticated workspace', { status: 403 })

    const row = await globalConnectionForProxy(engine.workspaceId, connectionId)
    if (!row || row.kind !== 'oauth') return new Response('Unknown connection', { status: 404 })

    const { data: binding } = await selectMaybeSingle(supabase, 'global_app_agents', ['agent_id'] as const, { connection_id: row.id, agent_id: agent.id })
    if (!binding) return new Response('This coworker is not enabled on that workspace account', { status: 403 })

    let bundle: GlobalOauthBundle
    try {
        bundle = await ensureGlobalOauthAccess(row)
    } catch (err) {
        await markGlobalNeedsReconnect(row.id).catch(() => {})
        console.warn(`[global-mcp:${row.id}] token unusable:`, err instanceof Error ? err.message : err)
        return new Response(`The workspace account ${row.label} needs to be reconnected in Global apps.`, { status: 502 })
    }

    let url: URL
    try {
        url = await assertPublicUrl(bundle.mcpUrl)
    } catch {
        return new Response('The upstream MCP server is not reachable from here.', { status: 502 })
    }
    return { connectionId: row.id, url, bundle, label: row.label }
}

function forwardHeaders(req: Request, accessToken: string): Headers {
    const headers = new Headers()
    for (const name of FORWARDED_REQUEST_HEADERS) {
        const value = req.headers.get(name)
        if (value) headers.set(name, value)
    }
    headers.set('Authorization', `Bearer ${accessToken}`)
    return headers
}

function passthrough(upstream: Response): Response {
    const headers = new Headers()
    for (const name of FORWARDED_RESPONSE_HEADERS) {
        const value = upstream.headers.get(name)
        if (value) headers.set(name, value)
    }
    return new Response(upstream.body, { status: upstream.status, headers })
}

// The body is buffered (MCP messages are small) so a 401 can be retried once with a fresh token.
// No timeout on the upstream call: a tools/call may legitimately stream for minutes.
async function proxy(req: Request, params: Promise<{ connectionId: string }>): Promise<Response> {
    const { connectionId } = await params
    const target = await resolveTarget(req, connectionId)
    if (target instanceof Response) return target

    const method = req.method
    const body = method === 'GET' || method === 'HEAD' ? undefined : await req.arrayBuffer()
    const send = (accessToken: string) => fetch(target.url, { method, headers: forwardHeaders(req, accessToken), body, redirect: 'manual' })

    let upstream = await send(target.bundle.accessToken)
    if (upstream.status === 401) {
        try {
            const refreshed = await ensureGlobalOauthAccess({ id: target.connectionId, oauth: target.bundle }, { forceRefresh: true })
            upstream = await send(refreshed.accessToken)
        } catch {
            // Fall through: the 401 below flags the connection.
        }
        if (upstream.status === 401) {
            await markGlobalNeedsReconnect(target.connectionId).catch(() => {})
            console.warn(`[global-mcp:${target.connectionId}] upstream still refuses the token; flagged needs_reconnect`)
        }
    }
    return passthrough(upstream)
}

export async function POST(req: Request, { params }: { params: Promise<{ connectionId: string }> }): Promise<Response> {
    return proxy(req, params)
}

export async function GET(req: Request, { params }: { params: Promise<{ connectionId: string }> }): Promise<Response> {
    return proxy(req, params)
}

export async function DELETE(req: Request, { params }: { params: Promise<{ connectionId: string }> }): Promise<Response> {
    return proxy(req, params)
}
