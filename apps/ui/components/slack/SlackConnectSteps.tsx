'use client'

import { connectSlackAction, type SlackStateView } from '@/app/api/_actions/slack.actions'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { createAppUrl, isReachableFromSlack } from '@/lib/slack/manifest'
import { ExternalLinkIcon } from '@/lib/icons'
import { useState } from 'react'
import { toast } from 'sonner'

// Connecting from zero: the workspace creates its own Slack app, so the bot token stays here and
// Rerun never holds it.
export function SlackConnectSteps({ state, reload, isAdmin }: { state: SlackStateView; reload: () => Promise<void>; isAdmin: boolean }) {
    const [token, setToken] = useState('')
    const [secret, setSecret] = useState('')
    const [connecting, setConnecting] = useState(false)
    // Where this app is served is not always where Slack can reach it: a local install is read on
    // localhost and called through a tunnel.
    const [requestUrl, setRequestUrl] = useState(state.requestUrl)

    const connect = async () => {
        setConnecting(true)
        const result = await connectSlackAction({ botToken: token, signingSecret: secret, requestUrl })
        setConnecting(false)
        if (!result.ok) return toast.error(result.error)
        toast.success(`Connected to ${result.teamName}`)
        if (!result.canCustomizeIdentity) toast.warning('Without chat:write.customize every coworker will post as the app. Add the scope in Slack and reinstall.')
        setToken('')
        setSecret('')
        await reload()
    }

    const reachable = isReachableFromSlack(requestUrl)

    return (
        <>
            <p className="text-sm text-muted-foreground">
                Your workspace creates its own Slack app, so the bot token stays here and Rerun never holds it. Two steps, about four minutes.
            </p>

            <Step n={1} title="Create the app in Slack" description="Opens Slack with the scopes, the events and your address already filled in. Press Create, then Install to workspace.">
                <Field
                    label="Where Slack sends its messages"
                    htmlFor="slack-request-url"
                    helperText={
                        reachable
                            ? 'Slack calls this address every time someone writes to a coworker.'
                            : 'Slack cannot reach localhost. Put a public address here — a tunnel (ngrok, cloudflared) or your own domain — and keep using Rerun on localhost.'
                    }
                >
                    <Input id="slack-request-url" value={requestUrl} onChange={e => setRequestUrl(e.target.value)} spellCheck={false} autoComplete="off" />
                </Field>
                <Button asChild size="sm" className="gap-1.5 self-start" disabled={!reachable}>
                    <a href={createAppUrl(requestUrl)} target="_blank" rel="noreferrer noopener">
                        Create the Slack app <ExternalLinkIcon className="size-3.5" />
                    </a>
                </Button>
            </Step>

            <Step n={2} title="Paste its two secrets" description="Bot User OAuth Token from OAuth & Permissions, Signing Secret from Basic Information.">
                <div className="flex flex-col gap-3">
                    <Field label="Bot token" htmlFor="slack-bot-token">
                        <Input id="slack-bot-token" value={token} onChange={e => setToken(e.target.value)} placeholder="xoxb-…" autoComplete="off" spellCheck={false} disabled={!isAdmin} />
                    </Field>
                    <Field label="Signing secret" htmlFor="slack-signing-secret">
                        <Input id="slack-signing-secret" type="password" value={secret} onChange={e => setSecret(e.target.value)} placeholder="••••••••" autoComplete="off" disabled={!isAdmin} />
                    </Field>
                    <Button size="sm" className="self-start" disabled={!isAdmin || !token || !secret || connecting} onClick={connect}>
                        {connecting ? 'Checking with Slack…' : 'Connect'}
                    </Button>
                    {!isAdmin && <p className="text-xs text-muted-foreground">Only an admin of this workspace can connect Slack.</p>}
                </div>
            </Step>
        </>
    )
}

function Step({ n, title, description, children }: { n: number; title: string; description: string; children: React.ReactNode }) {
    return (
        <section className="flex flex-col gap-3 rounded-xl border p-4">
            <div className="flex items-start gap-3">
                <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">{n}</span>
                <div className="flex min-w-0 flex-col gap-0.5">
                    <h3 className="text-sm font-medium">{title}</h3>
                    <p className="text-xs text-muted-foreground">{description}</p>
                </div>
            </div>
            <div className="flex flex-col gap-2 sm:pl-9">{children}</div>
        </section>
    )
}
