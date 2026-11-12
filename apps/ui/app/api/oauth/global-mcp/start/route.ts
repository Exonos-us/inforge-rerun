import { requireAdminContext } from '@/app/api/_auth/ownership'
import { globalMcpOauthContext } from '@/app/api/_services/global-apps.service'
import { GLOBAL_MCP_COOKIE_PATH, GLOBAL_MCP_COOKIE_PREFIX, encodeGlobalMcpContext, globalMcpCallbackUrl, type GlobalMcpOAuthContext } from '@/lib/global-apps/oauth'
import { buildAuthorizeUrl, createPkce, discoverAuthServer, resolveClient } from '@/lib/mcp-oauth'
import { describeSignInError } from '@/lib/net/network-error'
import { NextResponse } from 'next/server'

// Begin the workspace-level sign-in of an OAuth MCP server: same PKCE + discovery as the
// per-coworker flow, but the resulting token lands on the Global apps connection row, and the
// coworkers' calls will carry it through the /api/mcp/global proxy. Admin-only, like connecting.
export async function POST(req: Request) {
    try {
        const ctx = await requireAdminContext('Only an admin can connect a workspace account')
        const { connectionId } = (await req.json()) as { connectionId: string }
        if (!connectionId) return NextResponse.json({ error: 'Missing connectionId' }, { status: 400 })

        const { mcpUrl } = await globalMcpOauthContext(ctx.workspace.id, connectionId)

        const metadata = await discoverAuthServer(mcpUrl)
        const clientInfo = await resolveClient(metadata, mcpUrl, req)
        if (!clientInfo?.clientId) return NextResponse.json({ error: 'No OAuth client available for this provider' }, { status: 400 })

        const { verifier, challenge, state } = createPkce()
        const oauthCtx: GlobalMcpOAuthContext = {
            verifier,
            connectionId,
            agentId: '',
            serverName: '',
            mcpUrl,
            tokenEndpoint: metadata.tokenEndpoint,
            clientId: clientInfo.clientId,
            clientSecret: clientInfo.clientSecret,
            redirectUri: globalMcpCallbackUrl(req),
            scope: metadata.scopesSupported?.join(' '),
        }

        const res = NextResponse.json({ authorizationUrl: buildAuthorizeUrl(metadata, oauthCtx, challenge, state) })
        res.cookies.set(GLOBAL_MCP_COOKIE_PREFIX + state, encodeGlobalMcpContext(oauthCtx), {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'lax',
            path: GLOBAL_MCP_COOKIE_PATH,
            maxAge: 600,
        })
        return res
    } catch (err) {
        return NextResponse.json({ error: describeSignInError(err, 'Failed to start the sign-in') }, { status: 400 })
    }
}
