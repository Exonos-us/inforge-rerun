import { requireAdminContext } from '@/app/api/_auth/ownership'
import { globalComposioContext } from '@/app/api/_services/global-apps.service'
import { composioConfigured, composioGlobalUserId, initiateConnectedAccount } from '@/lib/composio/client'
import { COMPOSIO_COOKIE_PATH, COMPOSIO_COOKIE_PREFIX, createComposioState, encodeGlobalComposioContext, globalComposioCallbackUrl, type GlobalComposioOAuthContext } from '@/lib/composio/oauth'
import { describeSignInError } from '@/lib/net/network-error'
import { NextResponse } from 'next/server'

// Begin the Composio connect flow of a Global apps account: the user id is keyed by the
// connection row, never by a coworker, so the signed-in account belongs to the workspace. Only an
// admin starts it, matching who may create the connection in the first place.
export async function POST(req: Request) {
    try {
        const ctx = await requireAdminContext('Only an admin can connect a workspace account')
        const { connectionId } = (await req.json()) as { connectionId: string }
        if (!connectionId) return NextResponse.json({ error: 'Missing connectionId' }, { status: 400 })

        if (!composioConfigured()) return NextResponse.json({ error: 'Composio connections are not configured on this server.' }, { status: 400 })

        const { toolkit, authConfigId } = await globalComposioContext(ctx.workspace.id, connectionId)

        const state = createComposioState()
        const userId = composioGlobalUserId(connectionId)
        const { connectedAccountId, redirectUrl } = await initiateConnectedAccount(userId, authConfigId, globalComposioCallbackUrl(req, state))

        const oauthCtx: GlobalComposioOAuthContext = { connectionId, toolkit, authConfigId, connectedAccountId }

        const res = NextResponse.json({ authorizationUrl: redirectUrl })
        res.cookies.set(COMPOSIO_COOKIE_PREFIX + state, encodeGlobalComposioContext(oauthCtx), {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'lax',
            path: COMPOSIO_COOKIE_PATH,
            maxAge: 600,
        })
        return res
    } catch (err) {
        return NextResponse.json({ error: describeSignInError(err, 'Failed to start the connection') }, { status: 400 })
    }
}
