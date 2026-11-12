// Workspace-level MCP OAuth (Global apps): same PKCE + discovery as lib/mcp-oauth, with the
// connection row in place of a coworker, and the token bundle kept on that row instead of any
// engine. Server-only. Import from route handlers.

import { appOrigin } from '@/lib/managed/oauth'
import type { OAuthContext } from '@/lib/mcp-oauth'
import { openContext, sealContext } from '@/lib/oauth/context-cookie'

export const GLOBAL_MCP_COOKIE_PREFIX = 'global_mcp_oauth_'
export const GLOBAL_MCP_COOKIE_PATH = '/api/oauth/global-mcp'

// The per-agent OAuthContext shape plus the Global apps connection id. `agentId` and `serverName`
// stay in the type so the lib's buildAuthorizeUrl/exchangeCode helpers apply as they are; for a
// workspace sign-in they are always empty.
export type GlobalMcpOAuthContext = OAuthContext & { connectionId: string }

export function globalMcpCallbackUrl(req: Request): string {
    return `${appOrigin(req)}${GLOBAL_MCP_COOKIE_PATH}/callback`
}

export function encodeGlobalMcpContext(ctx: GlobalMcpOAuthContext): string {
    return sealContext(ctx)
}

export function decodeGlobalMcpContext(raw: string): GlobalMcpOAuthContext {
    return openContext<GlobalMcpOAuthContext>(raw)
}
