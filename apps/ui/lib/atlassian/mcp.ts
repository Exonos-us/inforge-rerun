import { assertPublicUrl } from '@/lib/net/public-fetch'

// A minimal client for Atlassian's hosted MCP server, used server-side with the workspace's
// Global apps OAuth token: the same tools a coworker calls, here powering the Project knowledge
// picker and index refreshes. One session per call group: initialize, then tools/call.

const PROTOCOL_VERSION = '2025-06-18'
const TIMEOUT_MS = 30_000

type JsonRpcResponse = { id?: number; result?: unknown; error?: { code: number; message: string } }

export class AtlassianMcpSession {
    private sessionId: string | null = null
    private initialized = false
    private nextId = 1

    constructor(
        private readonly mcpUrl: string,
        private readonly accessToken: string,
    ) {}

    private async post(message: Record<string, unknown>, expectId?: number): Promise<JsonRpcResponse | null> {
        await assertPublicUrl(this.mcpUrl)
        const res = await fetch(this.mcpUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json, text/event-stream',
                Authorization: `Bearer ${this.accessToken}`,
                ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
            },
            body: JSON.stringify(message),
            signal: AbortSignal.timeout(TIMEOUT_MS),
        })
        this.sessionId = res.headers.get('mcp-session-id') ?? this.sessionId
        if (res.status === 401 || res.status === 403) throw new AtlassianAuthError(`Atlassian refused the workspace account (${res.status})`)
        if (!res.ok) throw new Error(`Atlassian MCP answered ${res.status}`)
        if (expectId === undefined) return null

        const contentType = res.headers.get('content-type') ?? ''
        const raw = await res.text()
        if (contentType.includes('text/event-stream')) {
            for (const line of raw.split('\n')) {
                if (!line.startsWith('data:')) continue
                const event = JSON.parse(line.slice(5).trim()) as JsonRpcResponse
                if (event.id === expectId) return event
            }
            throw new Error('Atlassian MCP stream ended without a response')
        }
        return raw ? (JSON.parse(raw) as JsonRpcResponse) : null
    }

    private async ensureInitialized(): Promise<void> {
        if (this.initialized) return
        const id = this.nextId++
        const res = await this.post(
            {
                jsonrpc: '2.0',
                id,
                method: 'initialize',
                params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'rerun-hub', version: '1.0' } },
            },
            id,
        )
        if (res?.error) throw new Error(`Atlassian MCP rejected the session: ${res.error.message}`)
        await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' })
        this.initialized = true
    }

    async callTool<T>(name: string, args: Record<string, unknown>): Promise<T> {
        await this.ensureInitialized()
        const id = this.nextId++
        const res = await this.post({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }, id)
        if (!res || res.error) throw new Error(`Atlassian tool ${name} failed: ${res?.error?.message ?? 'no response'}`)
        const result = res.result as { isError?: boolean; content?: Array<{ type: string; text?: string }> }
        const text = (result.content ?? [])
            .filter(c => c.type === 'text')
            .map(c => c.text ?? '')
            .join('\n')
        if (result.isError) {
            if (/401|unauthor|forbidden/i.test(text)) throw new AtlassianAuthError(text.slice(0, 200))
            throw new Error(`Atlassian tool ${name} failed: ${text.slice(0, 200)}`)
        }
        return JSON.parse(text) as T
    }
}

// The workspace account can no longer act: the caller flags the Global apps connection instead of
// surfacing a raw upstream error.
export class AtlassianAuthError extends Error {}
