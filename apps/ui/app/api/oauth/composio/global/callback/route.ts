import { markGlobalComposioConnected } from '@/app/api/_services/global-apps.service'
import { composioGlobalUserId, getConnectedAccount } from '@/lib/composio/client'
import { COMPOSIO_COOKIE_PATH, COMPOSIO_COOKIE_PREFIX, decodeGlobalComposioContext, type GlobalComposioOAuthContext } from '@/lib/composio/oauth'
import { oauthPopupResponse } from '@/lib/oauth/popup-result'
import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'

const ACTIVE_POLL_ATTEMPTS = 5
const ACTIVE_POLL_DELAY_MS = 1000

type CallbackResult = { ok: true; accountLabel?: string } | { ok: false; error: string }

// The listener matches on this key, so a page holding several Connect buttons hears its own.
function htmlResult(result: CallbackResult, connectionId?: string): NextResponse {
    const key = connectionId ? { key: `global:${connectionId}` } : {}
    return oauthPopupResponse({
        channel: 'composio-oauth',
        message: result.ok ? { type: 'composio-oauth-success', ...key, accountLabel: result.accountLabel } : { type: 'composio-oauth-error', ...key, error: result.error },
        label: result.ok ? `Connected${result.accountLabel ? ` as ${result.accountLabel}` : ''}. You can close this window.` : `Authorization failed: ${result.error}`,
    })
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}

// Finish the Composio connect of a Global apps account. The query params are not trusted: the
// account id comes from the /start cookie, re-fetched from Composio to prove it belongs to the
// expected per-connection user_id + auth config and is ACTIVE, before the row flips to connected.
export async function GET(req: Request) {
    const url = new URL(req.url)
    const state = url.searchParams.get('state')
    if (!state) return htmlResult({ ok: false, error: 'Missing state' })

    const cookieName = COMPOSIO_COOKIE_PREFIX + state
    const raw = (await cookies()).get(cookieName)?.value

    let connectionId: string | undefined
    const finish = (result: CallbackResult): NextResponse => {
        const res = htmlResult(result, connectionId)
        res.cookies.delete({ name: cookieName, path: COMPOSIO_COOKIE_PATH })
        return res
    }

    if (!raw) return finish({ ok: false, error: 'Session expired, please retry' })

    let ctx: GlobalComposioOAuthContext
    try {
        ctx = decodeGlobalComposioContext(raw)
        connectionId = ctx.connectionId
    } catch {
        return finish({ ok: false, error: 'Session expired, please retry' })
    }

    const status = url.searchParams.get('status')
    if (status && status !== 'success') {
        const detail = url.searchParams.get('error') ?? url.searchParams.get('error_description')
        console.warn('[composio:global] authorize rejected:', Object.fromEntries(url.searchParams))
        return finish({ ok: false, error: detail ?? `Connection ${status}` })
    }

    try {
        const userId = composioGlobalUserId(ctx.connectionId)
        let account = await getConnectedAccount(ctx.connectedAccountId)
        for (let attempt = 1; account.status !== 'ACTIVE' && account.status !== 'FAILED' && attempt < ACTIVE_POLL_ATTEMPTS; attempt++) {
            await sleep(ACTIVE_POLL_DELAY_MS)
            account = await getConnectedAccount(ctx.connectedAccountId)
        }
        if (account.userId !== userId || account.authConfigId !== ctx.authConfigId) {
            console.warn(`[composio:global] connected account ${ctx.connectedAccountId} does not match the pending context`)
            return finish({ ok: false, error: 'Connection mismatch, please retry' })
        }
        if (account.status !== 'ACTIVE') {
            return finish({ ok: false, error: `Connection is not active yet (${account.status}). Please retry.` })
        }

        await markGlobalComposioConnected(ctx.connectionId, ctx.connectedAccountId)
        return finish({ ok: true })
    } catch (err) {
        return finish({ ok: false, error: err instanceof Error ? err.message : 'Authorization failed' })
    }
}
