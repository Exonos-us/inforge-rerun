'use client'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Icon } from '@/components/ui/icon'
import { redirectPendingSignInPopup } from '@/components/services/sign-in-popup'
import { useOAuthPopupResult } from '@/hooks/useOAuthPopupResult'
import { usePopupClosePoll } from '@/hooks/usePopupClosePoll'
import { CheckCircle2Icon, ExternalLinkIcon, Loader2Icon, ShieldCheck, XCircleIcon } from '@/lib/icons'
import { useEffect, useRef, useState } from 'react'

const RESULT_TYPES = ['composio-oauth-success', 'composio-oauth-error'] as const

type GlobalComposioConnectProps = {
    // The Global apps connection row the sign-in finishes, minted before the popup opens.
    connectionId: string
    name: string
    onAuthorized: (accountLabel?: string) => void
    autoStart?: boolean
    pendingPopup?: Window | null
}

type ConnectState = 'idle' | 'authorizing' | 'authorized' | 'error'

// The workspace-level twin of ComposioConnect: same popup, same BroadcastChannel, but the
// account lands on the workspace connection instead of any one coworker.
export function GlobalComposioConnect({ connectionId, name, onAuthorized, autoStart, pendingPopup }: GlobalComposioConnectProps) {
    const [state, setState] = useState<ConnectState>('idle')
    const [accountLabel, setAccountLabel] = useState<string | null>(null)
    const [error, setError] = useState<string | null>(null)
    const popupRef = useRef<Window | null>(null)

    const armResult = useOAuthPopupResult<{ type: string; key?: string; accountLabel?: string; error?: string }>(
        'composio-oauth',
        RESULT_TYPES,
        data => {
            if (data.type === 'composio-oauth-success') {
                setAccountLabel(data.accountLabel ?? null)
                setState('authorized')
                onAuthorized(data.accountLabel)
            } else {
                setError(data.error || 'Authorization failed')
                setState('error')
            }
            popupRef.current?.close()
        },
        data => data.key === `global:${connectionId}`,
    )

    const watchPopup = usePopupClosePoll(() => setState(s => (s === 'authorizing' ? 'idle' : s)))

    const startAuth = async () => {
        setState('authorizing')
        setError(null)
        armResult()
        try {
            const res = await fetch('/api/oauth/composio/global/start', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ connectionId }),
            })
            const data = await res.json()
            if (!res.ok) throw new Error(data.error || 'Failed to start the connection')

            const w = 500
            const h = 640
            const left = window.screenX + (window.outerWidth - w) / 2
            const top = window.screenY + (window.outerHeight - h) / 2
            popupRef.current = redirectPendingSignInPopup(pendingPopup, data.authorizationUrl) ?? window.open(data.authorizationUrl, 'composio-oauth', `width=${w},height=${h},left=${left},top=${top},popup=yes`)
            watchPopup(popupRef.current)
        } catch (err) {
            pendingPopup?.close()
            setError(err instanceof Error ? err.message : 'Failed to start the connection')
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
                <span>{accountLabel ? `Connected as ${accountLabel}` : 'Connected'}</span>
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
        <div className="space-y-2">
            <Alert variant="warning" stripes className="grid-cols-[auto_1fr] gap-x-3 gap-y-0">
                <Icon icon={ShieldCheck} size="sm" className="row-span-2 self-center" />
                <AlertTitle className="col-start-2 leading-tight">Secure connection</AlertTitle>
                <AlertDescription className="col-start-2 leading-snug">The account you sign in belongs to the workspace, not to any one coworker.</AlertDescription>
            </Alert>
            <Button variant="outline" size="sm" onClick={startAuth} disabled={state === 'authorizing'} className="w-full">
                {state === 'authorizing' ? <Loader2Icon className="mr-1.5 size-3.5 animate-spin" /> : <ExternalLinkIcon className="mr-1.5 size-3.5" />}
                {state === 'authorizing' ? 'Waiting for authorization…' : `Sign in with ${name}`}
            </Button>
        </div>
    )
}
