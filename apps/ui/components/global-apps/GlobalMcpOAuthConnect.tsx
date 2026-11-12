'use client'

import { Button } from '@/components/ui/button'
import { redirectPendingSignInPopup } from '@/components/services/sign-in-popup'
import { useOAuthPopupResult } from '@/hooks/useOAuthPopupResult'
import { usePopupClosePoll } from '@/hooks/usePopupClosePoll'
import { CheckCircle2Icon, ExternalLinkIcon, Loader2Icon, XCircleIcon } from '@/lib/icons'
import { useEffect, useRef, useState } from 'react'

const RESULT_TYPES = ['mcp-oauth-success', 'mcp-oauth-error'] as const

type GlobalMcpOAuthConnectProps = {
    // The Global apps connection row the sign-in finishes, minted before the popup opens.
    connectionId: string
    name: string
    onAuthorized: () => void
    autoStart?: boolean
    pendingPopup?: Window | null
}

type ConnectState = 'idle' | 'authorizing' | 'authorized' | 'error'

// The workspace-level twin of McpOAuthAuthorize: the provider's own sign-in in a popup, the token
// landing on the workspace connection instead of any one coworker's engine.
export function GlobalMcpOAuthConnect({ connectionId, name, onAuthorized, autoStart, pendingPopup }: GlobalMcpOAuthConnectProps) {
    const [state, setState] = useState<ConnectState>('idle')
    const [error, setError] = useState<string | null>(null)
    const popupRef = useRef<Window | null>(null)

    const armResult = useOAuthPopupResult<{ type: string; serverName?: string; error?: string }>(
        'mcp-oauth',
        RESULT_TYPES,
        data => {
            if (data.type === 'mcp-oauth-success') {
                setState('authorized')
                onAuthorized()
            } else {
                setError(data.error || 'Authorization failed')
                setState('error')
            }
            popupRef.current?.close()
        },
        data => data.serverName === `global:${connectionId}`,
    )

    const watchPopup = usePopupClosePoll(() => setState(s => (s === 'authorizing' ? 'idle' : s)))

    const startAuth = async () => {
        setState('authorizing')
        setError(null)
        armResult()
        try {
            const res = await fetch('/api/oauth/global-mcp/start', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ connectionId }),
            })
            const data = await res.json()
            if (!res.ok) throw new Error(data.error || 'Failed to start the sign-in')

            const w = 500
            const h = 640
            const left = window.screenX + (window.outerWidth - w) / 2
            const top = window.screenY + (window.outerHeight - h) / 2
            popupRef.current = redirectPendingSignInPopup(pendingPopup, data.authorizationUrl) ?? window.open(data.authorizationUrl, 'mcp-oauth', `width=${w},height=${h},left=${left},top=${top},popup=yes`)
            watchPopup(popupRef.current)
        } catch (err) {
            pendingPopup?.close()
            setError(err instanceof Error ? err.message : 'Failed to start the sign-in')
            setState('error')
        }
    }

    const autoStartedRef = useRef(false)
    useEffect(() => {
        if (!autoStart || autoStartedRef.current || !pendingPopup || pendingPopup.closed) return
        autoStartedRef.current = true
        startAuth()
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    if (state === 'authorized') {
        return (
            <div className="flex items-center gap-2 py-1 text-sm text-green-600 dark:text-green-400">
                <CheckCircle2Icon className="size-3.5" />
                <span>Connected</span>
            </div>
        )
    }

    if (state === 'error') {
        return (
            <div className="space-y-2 py-1">
                <div className="flex items-center gap-2 text-sm text-destructive">
                    <XCircleIcon className="size-3.5 shrink-0" />
                    <span className="truncate">{error}</span>
                </div>
                <Button variant="outline" size="sm" onClick={startAuth}>
                    Retry
                </Button>
            </div>
        )
    }

    return (
        <Button variant="outline" size="sm" onClick={startAuth} disabled={state === 'authorizing'} className="w-full">
            {state === 'authorizing' ? <Loader2Icon className="mr-1.5 size-3.5 animate-spin" /> : <ExternalLinkIcon className="mr-1.5 size-3.5" />}
            {state === 'authorizing' ? 'Waiting for authorization…' : `Sign in with ${name}`}
        </Button>
    )
}
