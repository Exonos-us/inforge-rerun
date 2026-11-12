'use client'

import { createGlobalComposioConnectionAction, createGlobalKeyConnectionAction, createGlobalOauthConnectionAction, getShareableServiceAction } from '@/app/api/_actions/global-apps.actions'
import { AuthMethodPicker, methodKindLabel } from '@/components/services/AuthMethodPicker'
import { GlobalComposioConnect } from '@/components/global-apps/GlobalComposioConnect'
import { GlobalMcpOAuthConnect } from '@/components/global-apps/GlobalMcpOAuthConnect'
import { openPendingSignInPopup } from '@/components/services/sign-in-popup'
import { ServiceFields } from '@/components/services/ServiceFields'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { PanelEditorBody, PanelEditorHeader, PanelEditorShell } from '@/components/ui/panel-editor'
import { SkeletonPanelRows } from '@/components/ui/skeleton'
import type { AuthMethodSummary } from '@/lib/services/types'
import type { ShareableServiceDetails } from '@/app/api/_services/global-apps.service'
import { ArrowLeftIcon, Loader2Icon } from '@/lib/icons'
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'

type GlobalAppConnectFormProps = {
    slug: string
    onBack: () => void
    onConnected: (connectionId: string) => void
}

// Connect one app for the workspace: pick the method when there are several, name the account,
// then paste the credential (key) or run the sign-in popup (composio). Nothing is enabled yet;
// the next screen is the coworker list with every switch off.
export function GlobalAppConnectForm({ slug, onBack, onConnected }: GlobalAppConnectFormProps) {
    const [service, setService] = useState<ShareableServiceDetails | null>(null)
    const [methodId, setMethodId] = useState<string | null>(null)
    const [choosing, setChoosing] = useState(false)
    const [label, setLabel] = useState('')
    const [values, setValues] = useState<Record<string, string>>({})
    const [busy, setBusy] = useState(false)
    const [signIn, setSignIn] = useState<{ kind: 'composio' | 'oauth'; connectionId: string; popup: Window | null } | null>(null)

    useEffect(() => {
        let active = true
        getShareableServiceAction({ slug }).then(res => {
            if (!active) return
            if (!res.ok) {
                toast.error(res.error)
                return
            }
            setService(res.service)
            const recommended = res.service.methods.find(m => m.recommended) ?? res.service.methods[0]
            setMethodId(recommended.id)
            setChoosing(res.service.methods.length > 1)
        })
        return () => {
            active = false
        }
    }, [slug])

    const method: AuthMethodSummary | null = useMemo(() => service?.methods.find(m => m.id === methodId) ?? service?.methods[0] ?? null, [service, methodId])
    // A sign-in method gets its secret from the popup; only non-secret pre-auth config shows.
    const isSignIn = method?.kind === 'composio' || method?.kind === 'oauth'
    const visibleInputs = isSignIn ? (method?.inputs.filter(i => !i.secret) ?? []) : (method?.inputs ?? [])
    const missingRequired = visibleInputs.some(i => i.required && !(values[i.key] ?? '').trim()) || !label.trim()

    const connectKey = async () => {
        if (!method) return
        setBusy(true)
        const res = await createGlobalKeyConnectionAction({ slug, authMethodId: method.id, label, values })
        setBusy(false)
        if (!res.ok) {
            toast.error(res.error)
            return
        }
        toast.success(`${service?.name ?? slug} connected for the workspace. Now pick who uses it.`)
        onConnected(res.id)
    }

    const connectSignIn = async (kind: 'composio' | 'oauth') => {
        setBusy(true)
        const popup = openPendingSignInPopup(service?.name ?? slug)
        const res = kind === 'composio' ? await createGlobalComposioConnectionAction({ slug, label }) : await createGlobalOauthConnectionAction({ slug, label, values })
        setBusy(false)
        if (!res.ok) {
            popup?.close()
            toast.error(res.error)
            return
        }
        setSignIn({ kind, connectionId: res.id, popup })
    }

    if (!service || !method) {
        return (
            <PanelEditorShell>
                <PanelEditorHeader title="Connect an app" onBack={onBack} />
                <PanelEditorBody>
                    <SkeletonPanelRows rows={3} className="p-0" />
                </PanelEditorBody>
            </PanelEditorShell>
        )
    }

    if (signIn) {
        return (
            <PanelEditorShell>
                <PanelEditorHeader title={`Connect ${service.name}`} onBack={onBack} />
                <PanelEditorBody>
                    <p className="text-xs text-muted-foreground">Sign in with {service.name}. The account you pick belongs to the workspace; coworkers you enable act as it.</p>
                    {signIn.kind === 'composio' ? (
                        <GlobalComposioConnect connectionId={signIn.connectionId} name={service.name} autoStart pendingPopup={signIn.popup} onAuthorized={() => onConnected(signIn.connectionId)} />
                    ) : (
                        <GlobalMcpOAuthConnect connectionId={signIn.connectionId} name={service.name} autoStart pendingPopup={signIn.popup} onAuthorized={() => onConnected(signIn.connectionId)} />
                    )}
                </PanelEditorBody>
            </PanelEditorShell>
        )
    }

    return (
        <PanelEditorShell>
            <PanelEditorHeader title={`Connect ${service.name}`} onBack={onBack} />
            <PanelEditorBody>
                <p className="text-xs text-muted-foreground">One sign-in for the whole workspace. Coworkers you enable act as this account; nothing is enabled until you flip their switches on the next screen.</p>

                {choosing ? (
                    <div className="space-y-3">
                        <p className="text-sm font-medium">Authentication</p>
                        <AuthMethodPicker
                            methods={service.methods}
                            onSelect={id => {
                                setMethodId(id)
                                setValues({})
                                setChoosing(false)
                            }}
                        />
                    </div>
                ) : (
                    <div className="space-y-3">
                        {service.methods.length > 1 && (
                            <div className="flex items-center gap-1">
                                <Button size="icon-sm" variant="ghost" onClick={() => setChoosing(true)} aria-label="Back to methods" className="-my-1 -ml-1.5 text-muted-foreground">
                                    <ArrowLeftIcon className="size-4" />
                                </Button>
                                <p className="min-w-0 truncate text-sm font-medium">{method.label || methodKindLabel(method.kind)}</p>
                            </div>
                        )}

                        <Field label="Account label" helperText="How the account reads everywhere. Name the account, not the app: inforge-bot, ops@inforge.us.">
                            <Input value={label} placeholder="inforge-bot" className="h-8 text-sm" onChange={e => setLabel(e.target.value)} />
                        </Field>

                        {visibleInputs.length > 0 && <ServiceFields inputs={visibleInputs} values={values} onChange={(key, value) => setValues(prev => ({ ...prev, [key]: value }))} />}

                        <div className="flex justify-end">
                            {isSignIn ? (
                                <Button size="sm" disabled={busy || missingRequired} onClick={() => connectSignIn(method.kind === 'composio' ? 'composio' : 'oauth')}>
                                    {busy ? <Loader2Icon className="size-3.5 animate-spin" /> : `Sign in with ${service.name}`}
                                </Button>
                            ) : (
                                <Button size="sm" disabled={busy || missingRequired} onClick={connectKey}>
                                    {busy ? <Loader2Icon className="size-3.5 animate-spin" /> : 'Connect for the workspace'}
                                </Button>
                            )}
                        </div>
                    </div>
                )}
            </PanelEditorBody>
        </PanelEditorShell>
    )
}
