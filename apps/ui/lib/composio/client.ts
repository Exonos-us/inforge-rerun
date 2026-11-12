// Minimal Composio API client (v3.1). Composio brokers the third-party OAuth and holds the
// tokens; Rerun executes tools scoped by user_id. The org-wide COMPOSIO_API_KEY can act for
// ANY user_id, so this module is server-only and the key never reaches an engine or a manifest.
//
// user_id convention: `<namespace>_agent_<agents.id>` (the Supabase UUID — stable across box
// migrations, unlike engine agent ids which are only unique per engine). Derived server-side
// on every path, never accepted from a caller. The namespace matters because staging runs on
// a clone of the prod database: the same agent id exists in both, and without the prefix a
// staging agent would be handed a real customer's connection. Defaults to 'local' rather than
// 'prod' so forgetting it can only isolate, never collide.
// An extra account of an app (registry key `<slug>@<instanceId>`) gets its own user_id, suffixed
// with the instance id, so Composio holds one connected account per instance.

const COMPOSIO_API_BASE = 'https://backend.composio.dev/api/v3.1'

const TOOLS_CACHE_TTL_MS = 10 * 60 * 1000

export class ComposioApiError extends Error {
    status: number

    constructor(status: number, message: string) {
        super(message)
        this.status = status
    }
}

export function composioUserId(agentId: string, instanceId?: string): string {
    const base = `${process.env.COMPOSIO_USER_NAMESPACE || 'local'}_agent_${agentId}`
    return instanceId ? `${base}_${instanceId}` : base
}

// A Global apps connection holds ONE Composio account for the whole workspace, so its user_id is
// keyed by the connection row, not by any coworker. Same namespace isolation as composioUserId.
export function composioGlobalUserId(connectionId: string): string {
    return `${process.env.COMPOSIO_USER_NAMESPACE || 'local'}_global_${connectionId}`
}

export function composioConfigured(): boolean {
    return Boolean(process.env.COMPOSIO_API_KEY)
}

async function composioFetch<T>(path: string, init?: RequestInit): Promise<T> {
    const key = process.env.COMPOSIO_API_KEY
    if (!key) throw new ComposioApiError(500, 'COMPOSIO_API_KEY is not configured on this server.')
    const res = await fetch(`${COMPOSIO_API_BASE}${path}`, {
        ...init,
        headers: { 'x-api-key': key, 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    })
    if (!res.ok) {
        const detail = await res.text().catch(() => '')
        throw new ComposioApiError(res.status, `Composio ${init?.method ?? 'GET'} ${path} failed (${res.status})${detail ? `: ${detail.slice(0, 300)}` : ''}`)
    }
    return (await res.json()) as T
}

export type ComposioConnectRequest = { connectedAccountId: string; redirectUrl: string }

export async function initiateConnectedAccount(userId: string, authConfigId: string, callbackUrl: string): Promise<ComposioConnectRequest> {
    const data = await composioFetch<{ connected_account_id?: string; redirect_url?: string }>('/connected_accounts/link', {
        method: 'POST',
        body: JSON.stringify({ auth_config_id: authConfigId, user_id: userId, callback_url: callbackUrl }),
    })
    if (!data.connected_account_id || !data.redirect_url) throw new ComposioApiError(502, 'Composio link response is missing the redirect URL')
    return { connectedAccountId: data.connected_account_id, redirectUrl: data.redirect_url }
}

export type ComposioConnectedAccount = {
    id: string
    userId: string
    authConfigId: string
    status: string
    toolkit: string
}

export async function getConnectedAccount(id: string): Promise<ComposioConnectedAccount> {
    const data = await composioFetch<{ id: string; user_id: string; status: string; auth_config?: { id?: string }; toolkit?: { slug?: string } }>(`/connected_accounts/${encodeURIComponent(id)}`)
    return { id: data.id, userId: data.user_id, authConfigId: data.auth_config?.id ?? '', status: data.status, toolkit: data.toolkit?.slug ?? '' }
}

export async function deleteConnectedAccount(id: string): Promise<void> {
    await composioFetch<{ success?: boolean }>(`/connected_accounts/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export type ComposioTool = {
    slug: string
    name: string
    description: string
    inputParameters: Record<string, unknown>
}

type ComposioToolRow = { slug?: string; name?: string; description?: string; input_parameters?: Record<string, unknown> }

const toolsCache = new Map<string, { tools: ComposioTool[]; fetchedAt: number }>()

// A stale list is far better than an agent session with no tools at all, so an expired cache
// entry is served when Composio itself is the thing failing.
export async function listToolkitTools(toolkit: string): Promise<ComposioTool[]> {
    const cached = toolsCache.get(toolkit)
    if (cached && Date.now() - cached.fetchedAt < TOOLS_CACHE_TTL_MS) return cached.tools

    try {
        const tools: ComposioTool[] = []
        let cursor: string | null = null
        do {
            const params = new URLSearchParams({ toolkit_slug: toolkit })
            if (cursor) params.set('cursor', cursor)
            const page: { items?: ComposioToolRow[]; next_cursor?: string | null } = await composioFetch(`/tools?${params.toString()}`)
            for (const t of page.items ?? []) {
                if (!t.slug) continue
                tools.push({ slug: t.slug, name: t.name ?? t.slug, description: t.description ?? '', inputParameters: t.input_parameters ?? { type: 'object', properties: {} } })
            }
            cursor = page.next_cursor ?? null
        } while (cursor)

        toolsCache.set(toolkit, { tools, fetchedAt: Date.now() })
        return tools
    } catch (err) {
        if (cached) {
            console.warn(`[composio] tools/list for ${toolkit} failed, serving stale cache:`, err instanceof Error ? err.message : err)
            return cached.tools
        }
        throw err
    }
}

export type ComposioExecuteResult = { successful: boolean; data: unknown; error: string | null }

export async function executeTool(toolSlug: string, userId: string, args: Record<string, unknown>): Promise<ComposioExecuteResult> {
    const data = await composioFetch<{ successful?: boolean; data?: unknown; error?: string | null }>(`/tools/execute/${encodeURIComponent(toolSlug)}`, {
        method: 'POST',
        body: JSON.stringify({ user_id: userId, arguments: args }),
    })
    return { successful: Boolean(data.successful), data: data.data ?? null, error: data.error ?? null }
}
