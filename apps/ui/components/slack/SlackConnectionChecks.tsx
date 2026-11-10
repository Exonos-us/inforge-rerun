'use client'

import { saveRequestUrlAction, updateSigningSecretAction, type SlackStateView } from '@/app/api/_actions/slack.actions'
import { Group } from '@/components/connections/AiProvidersPanel'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { PanelRow } from '@/components/ui/panel-row'
import { isLocalTunnel } from '@/lib/slack/manifest'
import { Badge } from '@rerun/ui/primitives'
import { useState } from 'react'
import { toast } from 'sonner'

import { relative } from './relative-time'

// The four things a connected Slack depends on, each with its state and, when one is broken, the
// fix right under it. Every silence a coworker can fall into starts on one of these rows.
export function SlackConnectionChecks({ state, reload, isAdmin }: { state: SlackStateView; reload: () => Promise<void>; isAdmin: boolean }) {
    const health = state.health
    const badSignature = health?.state === 'bad_signature'
    const neverCalled = health?.state === 'never_called'

    return (
        <Group title="Connection" addMenu={<RunChecks reload={reload} />}>
            <PanelRow
                title="Bot token"
                description={state.slackError ? undefined : 'Checked against Slack when this screen loaded.'}
                actions={state.slackError ? <Badge size="xs" tone="red">Refused</Badge> : <Badge size="xs" tone="green">Valid</Badge>}
            >
                {state.slackError && (
                    <Alert variant="danger" className="mt-2">
                        <AlertTitle>Slack refused the token</AlertTitle>
                        <AlertDescription>{state.slackError} Reinstall the app from OAuth &amp; Permissions in Slack, then reconnect with the new token.</AlertDescription>
                    </Alert>
                )}
            </PanelRow>

            <PanelRow
                title="Signing secret"
                description={badSignature ? undefined : 'Proves each event really comes from Slack.'}
                actions={badSignature ? <Badge size="xs" tone="red">Wrong secret</Badge> : <Badge size="xs" tone="green">Set</Badge>}
            >
                {badSignature && <SigningSecretFix at={health.at} reload={reload} isAdmin={isAdmin} />}
            </PanelRow>

            <PanelRow
                title="Permissions"
                description={
                    state.connection?.canCustomizeIdentity
                        ? 'The app can post under each coworker’s own name and avatar.'
                        : undefined
                }
                actions={state.connection?.canCustomizeIdentity ? <Badge size="xs" tone="green">Full</Badge> : <Badge size="xs" tone="orange">Limited</Badge>}
            >
                {!state.connection?.canCustomizeIdentity && (
                    <Alert variant="warning" className="mt-2">
                        <AlertTitle>Every coworker is posting as the app</AlertTitle>
                        <AlertDescription>
                            The install is missing <b>chat:write.customize</b>, so Slack ignores the name and avatar each coworker was given. Add the scope under OAuth &amp; Permissions and reinstall the app.
                        </AlertDescription>
                    </Alert>
                )}
            </PanelRow>

            <PanelRow
                title="Event deliveries"
                description={deliveriesDescription(state)}
                actions={<DeliveriesBadge state={state} />}
                footer={
                    state.delivery.url ? (
                        <span className="flex min-w-0 items-baseline gap-1.5">
                            <span className="truncate font-mono">{state.delivery.url}</span>
                            {isLocalTunnel(state.delivery.url) && <span className="shrink-0">· local tunnel</span>}
                        </span>
                    ) : undefined
                }
            >
                {state.delivery.reachable === 'no' && (
                    <Alert variant="danger" className="mt-2">
                        <AlertTitle>Nothing answers at the address Slack calls</AlertTitle>
                        <AlertDescription>
                            <p>
                                The Slack handshake gets no answer at the address above, so no event arrives any more.
                                {isLocalTunnel(state.delivery.url ?? '') && ' It is a local tunnel, and tunnel URLs rotate on every restart: restart it, then put the address it prints in the Slack app under Event Subscriptions and save it here too.'}
                            </p>
                            <RequestUrlFix reload={reload} isAdmin={isAdmin} />
                        </AlertDescription>
                    </Alert>
                )}
                {state.delivery.reachable === 'unknown' && (
                    <Alert variant="warning" className="mt-2">
                        <AlertTitle>Only Slack knows where it delivers</AlertTitle>
                        <AlertDescription>
                            <p>
                                This app is read on an address Slack cannot call, so events come through a tunnel or a public domain — and nobody told this screen which one. Paste the Request URL from the Slack app&apos;s <b>Event Subscriptions</b> page so it can be checked from here.
                            </p>
                            <RequestUrlFix reload={reload} isAdmin={isAdmin} />
                        </AlertDescription>
                    </Alert>
                )}
                {neverCalled && state.delivery.reachable === 'yes' && (
                    <Alert variant="warning" className="mt-2">
                        <AlertTitle>Slack has never called this server</AlertTitle>
                        <AlertDescription>
                            The address answers, but Slack has never delivered to it. In the Slack app, under <b>Event Subscriptions</b>, the Request URL has to be the address above, and the page saved once it verifies.
                        </AlertDescription>
                    </Alert>
                )}
            </PanelRow>
        </Group>
    )
}

function deliveriesDescription(state: SlackStateView): string | undefined {
    const health = state.health
    if (health?.state === 'bad_signature') return 'Slack is calling, and every call is turned away: fix the signing secret above.'
    if (state.delivery.reachable === 'no') return health?.state === 'delivering' ? `The last event got through ${relative(health.at)}; nothing can now.` : undefined
    if (health?.state === 'never_called' || state.delivery.reachable === 'unknown') return undefined
    if (health?.state === 'delivering' || health?.state === 'no_identity') {
        const at = health.state === 'delivering' ? health.at : null
        return at ? `Slack last reached this server ${relative(at)}.` : 'Slack is reaching this server.'
    }
    return undefined
}

function DeliveriesBadge({ state }: { state: SlackStateView }) {
    const health = state.health
    if (health?.state === 'bad_signature') return <Badge size="xs" tone="red">Refused</Badge>
    if (state.delivery.reachable === 'no') return <Badge size="xs" tone="red">Unreachable</Badge>
    if (state.delivery.reachable === 'unknown') return <Badge size="xs" tone="orange">Unchecked</Badge>
    if (health?.state === 'never_called') return <Badge size="xs" tone="orange">Never called</Badge>
    return <Badge size="xs" tone="green">Receiving</Badge>
}

// The address, fixed where its absence is named. Saving probes it first, so what lands in the row
// is an address that answered the handshake seconds ago.
function RequestUrlFix({ reload, isAdmin }: { reload: () => Promise<void>; isAdmin: boolean }) {
    const [url, setUrl] = useState('')
    const [saving, setSaving] = useState(false)

    const save = async () => {
        setSaving(true)
        const result = await saveRequestUrlAction({ requestUrl: url })
        setSaving(false)
        if (!result.ok) return toast.error(result.error)
        toast.success('It answers. Saved.')
        setUrl('')
        await reload()
    }

    return (
        <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-end">
            <Field label="Where Slack delivers" htmlFor="slack-request-url-fix" className="flex-1">
                <Input id="slack-request-url-fix" value={url} onChange={e => setUrl(e.target.value)} placeholder="https://…/api/webhooks/slack" autoComplete="off" spellCheck={false} disabled={!isAdmin} />
            </Field>
            <Button size="sm" disabled={!isAdmin || !url || saving} onClick={save}>
                {saving ? 'Checking…' : 'Check and save'}
            </Button>
        </div>
    )
}

function RunChecks({ reload }: { reload: () => Promise<void> }) {
    const [checking, setChecking] = useState(false)

    const run = async () => {
        setChecking(true)
        await reload()
        setChecking(false)
        toast.success('Checked with Slack')
    }

    return (
        <Button size="xs" variant="ghost" className="text-muted-foreground" disabled={checking} onClick={run}>
            {checking ? 'Checking…' : 'Run checks'}
        </Button>
    )
}

// The fix, where the problem is named: one field, and the connection keeps its channels. Sending
// the user to Disconnect would have taken every binding with it.
function SigningSecretFix({ at, reload, isAdmin }: { at: string; reload: () => Promise<void>; isAdmin: boolean }) {
    const [secret, setSecret] = useState('')
    const [saving, setSaving] = useState(false)

    const save = async () => {
        setSaving(true)
        const result = await updateSigningSecretAction({ signingSecret: secret })
        setSaving(false)
        if (!result.ok) return toast.error(result.error)
        toast.success('Saved. Write to a coworker in Slack to check.')
        setSecret('')
        await reload()
    }

    return (
        <Alert variant="danger" className="mt-2">
            <AlertTitle>Every message is being refused</AlertTitle>
            <AlertDescription>
                <p>
                    The signing secret saved here is not this app&apos;s, so nothing a coworker is told ever reaches it — last refused {relative(at)}. In Slack:
                    <b> Basic Information → App Credentials → Signing Secret → Show</b>. Paste it below; the bot token is fine and your channels stay as they are.
                </p>
                <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-end">
                    <Field label="Signing secret" htmlFor="slack-new-secret" className="flex-1">
                        <Input id="slack-new-secret" value={secret} onChange={e => setSecret(e.target.value)} placeholder="32 characters, digits and a–f" autoComplete="off" spellCheck={false} disabled={!isAdmin} />
                    </Field>
                    <Button size="sm" disabled={!isAdmin || !secret || saving} onClick={save}>
                        {saving ? 'Saving…' : 'Save it'}
                    </Button>
                </div>
                {!isAdmin && <p className="mt-1">Only an admin of this workspace can change it.</p>}
            </AlertDescription>
        </Alert>
    )
}
