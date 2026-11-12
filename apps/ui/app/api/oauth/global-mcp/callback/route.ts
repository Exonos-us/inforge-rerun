import { markGlobalOauthConnected, type GlobalOauthBundle } from '@/app/api/_services/global-apps.service'
import { GLOBAL_MCP_COOKIE_PATH, GLOBAL_MCP_COOKIE_PREFIX, decodeGlobalMcpContext } from '@/lib/global-apps/oauth'
import { exchangeCode, hubClientSecret } from '@/lib/mcp-oauth'
import { oauthPopupResponse } from '@/lib/oauth/popup-result'
import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'

type CallbackResult = { ok: true } | { ok: false; error: string }

// The popup listener matches on this key, so a page holding several Connect buttons hears its own.
function htmlResult(result: CallbackResult, connectionId?: string): NextResponse {
    const target = connectionId ? { serverName: `global:${connectionId}` } : {}
    return oauthPopupResponse({
        channel: 'mcp-oauth',
        message: result.ok ? { type: 'mcp-oauth-success', ...target } : { type: 'mcp-oauth-error', ...target, error: result.error },
        label: result.ok ? 'Connected. You can close this window.' : `Authorization failed: ${result.error}`,
    })
}

// Finish the workspace-level MCP sign-in: exchange the code and keep the whole bundle on the
// connection row, server-side only — the /api/mcp/global proxy injects and refreshes it from
// there, and no engine ever holds it.
export async function GET(req: Request) {
    const url = new URL(req.url)
    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state')
    const providerError = url.searchParams.get('error')

    let connectionId: string | undefined
    const finish = (result: CallbackResult): NextResponse => {
        const res = htmlResult(result, connectionId)
        if (state) res.cookies.delete({ name: GLOBAL_MCP_COOKIE_PREFIX + state, path: GLOBAL_MCP_COOKIE_PATH })
        return res
    }

    if (providerError) return finish({ ok: false, error: providerError })
    if (!code || !state) return finish({ ok: false, error: 'Missing code or state' })

    const raw = (await cookies()).get(GLOBAL_MCP_COOKIE_PREFIX + state)?.value
    if (!raw) return finish({ ok: false, error: 'Session expired, please retry' })

    try {
        const ctx = decodeGlobalMcpContext(raw)
        connectionId = ctx.connectionId
        const token = await exchangeCode(ctx, code)
        const bundle: GlobalOauthBundle = {
            accessToken: token.accessToken,
            refreshToken: token.refreshToken,
            expiresAt: token.expiresAt,
            scope: token.scope,
            tokenEndpoint: ctx.tokenEndpoint,
            clientId: ctx.clientId,
            // A DCR-issued secret comes back on the context; a pre-registered client's secret is
            // read from the environment here so the row can refresh without re-deriving it.
            clientSecret: ctx.clientSecret ?? hubClientSecret(ctx),
            mcpUrl: ctx.mcpUrl,
            obtainedAt: Date.now(),
        }
        await markGlobalOauthConnected(ctx.connectionId, bundle)
        return finish({ ok: true })
    } catch (err) {
        return finish({ ok: false, error: err instanceof Error ? err.message : 'Authorization failed' })
    }
}
