import 'server-only'

import { memberActor, workspaceActor, type Actor } from '@/app/api/_auth/access'
import { dispatchAccountTool } from '@/app/api/_services/mcp-account.service'
import { deleteAgent } from '@/app/api/_services/agent.service'
import { ACCOUNT_TOOL_DEFS } from '@/lib/mcp/account-tools'
import { authenticateApiKey, bindImportKey, type AuthenticatedApiKey } from '@/lib/mcp/api-keys'
import { assertImportCall, importToolDefs, isImportKey } from '@/lib/mcp/import-scope'
import { responseTooLarge, tooLargeMessage } from '@/lib/mcp/truncate'

// The "Rerun" MCP server: it lets an external AI agent (Claude Code and friends) shape a
// Rerun account — agents, their prompt, their skills, their scheduled tasks, their
// connectors. A tiny stateless JSON-RPC 2.0 handler rather than the MCP SDK, which
// sidesteps session management, SSE keep-alives and cold starts. Callers authenticate with an account API key.

const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07']
const DEFAULT_PROTOCOL_VERSION = '2025-06-18'

function rpcResult(id: unknown, result: unknown): Response {
    return Response.json({ jsonrpc: '2.0', id, result })
}

function rpcError(id: unknown, code: number, message: string): Response {
    return Response.json({ jsonrpc: '2.0', id, error: { code, message } })
}

const CREATOR_LEFT = 'The member who created this key has left the workspace'

// A key acts with the access of the member who created it, so a hidden Box stays hidden to it. A
// key from before creators were recorded, or one the back-office made, acts as the workspace.
async function keyActor(key: AuthenticatedApiKey): Promise<Actor | null> {
    return key.createdByUserId ? memberActor(key.workspaceId, key.createdByUserId) : workspaceActor(key.workspaceId)
}

// An import key creates one coworker and stays on it. Losing the race to a second create_agent on
// the same key means another coworker already holds it, so the one just made is taken back.
async function bindCreatedAgent(key: AuthenticatedApiKey, out: unknown): Promise<void> {
    const agentId = (out as { agentId?: unknown }).agentId
    if (typeof agentId !== 'string') return
    if (await bindImportKey(key.keyId, agentId)) return
    await deleteAgent(agentId)
    throw new Error('This import key already created its coworker. Keep writing to that one.')
}

export function bearerToken(req: Request): string {
    const header = req.headers.get('authorization') ?? ''
    return header.startsWith('Bearer ') ? header.slice(7) : ''
}

// `importOnly` is the URL-borne door, for clients that take nothing but a connector URL: a key in
// a URL ends up in histories and logs, so that door refuses the long-lived account keys.
export async function handleAccountMcp(req: Request, token: string, { importOnly = false }: { importOnly?: boolean } = {}): Promise<Response> {
    const key = await authenticateApiKey(token)
    if (!key || (importOnly && !isImportKey(key))) {
        return new Response('Unauthorized', { status: 401 })
    }

    let rpc: { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> }
    try {
        rpc = await req.json()
    } catch {
        return rpcError(null, -32700, 'Parse error')
    }

    const { method, id, params } = rpc

    if (typeof method === 'string' && method.startsWith('notifications/')) {
        return new Response(null, { status: 202 })
    }

    if (method === 'initialize') {
        const requested = params?.protocolVersion
        const protocolVersion = typeof requested === 'string' && SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : DEFAULT_PROTOCOL_VERSION
        return rpcResult(id, {
            protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: 'rerun', version: '1.0.0' },
        })
    }

    if (method === 'tools/list') {
        return rpcResult(id, { tools: isImportKey(key) ? importToolDefs(ACCOUNT_TOOL_DEFS) : ACCOUNT_TOOL_DEFS })
    }

    if (method === 'tools/call') {
        const name = typeof params?.name === 'string' ? params.name : ''
        const args = (params?.arguments ?? {}) as Record<string, unknown>
        const actor = await keyActor(key)
        if (!actor) return rpcError(id, -32001, CREATOR_LEFT)
        try {
            if (isImportKey(key)) assertImportCall(key, name, args)
            const out = await dispatchAccountTool(actor, name, args, { actorUserId: key.createdByUserId })
            if (isImportKey(key) && name === 'create_agent') await bindCreatedAgent(key, out)
            const text = JSON.stringify(out)
            // Backstop under the per-field limits the handlers apply. A tool result stays in the
            // caller's transcript for good, so an oversized one is refused rather than cut: the
            // model can narrow its request, where it could not recover from truncated JSON.
            if (responseTooLarge(text)) {
                const message = tooLargeMessage(name, text.length)
                console.error(`[mcp-account] tools/call ${name} refused:`, message)
                return rpcResult(id, { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true })
            }
            return rpcResult(id, { content: [{ type: 'text', text }], structuredContent: out })
        } catch (err) {
            const message = err instanceof Error ? err.message : 'Tool failed'
            console.error(`[mcp-account] tools/call ${name} failed:`, message)
            // Surface as a tool execution error (isError) rather than a protocol error, so the
            // client model reads the reason and can correct its arguments.
            return rpcResult(id, { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true })
        }
    }

    return rpcError(id, -32601, `Method not found: ${method}`)
}
