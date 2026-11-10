'use client'

import { bindCoworkerAction, connectSlackAction, createSlackChannelAction, disconnectSlackAction, getSlackStateAction, unbindCoworkerAction, type SlackStateView } from '@/app/api/_actions/slack.actions'
import { Button } from '@/components/ui/button'
import { Badge } from '@rerun/ui/primitives'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { PanelScroller } from '@/components/ui/panel-list'
import { PanelRow } from '@/components/ui/panel-row'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { createAppUrl, isReachableFromSlack } from '@/lib/slack/manifest'
import { useIsWorkspaceAdmin } from '@/supabase/session/SessionProvider'
import { CheckIcon, ExternalLinkIcon, PlusIcon, Trash2Icon } from '@/lib/icons'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'

// Slack lives at workspace level: one Slack app for the whole board, and each coworker shows up
// in the channels it was put in, under its own name. The two secrets below never come back from
// the server once saved — the panel only ever learns that a connection exists.

type Busy = null | 'connect' | 'disconnect' | 'create' | string

export function SlackPanel() {
    const isAdmin = useIsWorkspaceAdmin()
    const [state, setState] = useState<SlackStateView | null>(null)
    const [busy, setBusy] = useState<Busy>(null)

    const load = useCallback(async () => {
        const result = await getSlackStateAction()
        if (result.ok) setState(result.state)
        else toast.error(result.error)
    }, [])

    useEffect(() => {
        void load()
    }, [load])

    if (!state) return <LoadingRows />

    return (
        <PanelScroller>
            <div className="flex flex-col gap-5 p-4">
                {state.connection ? (
                    <Connected state={state} busy={busy} setBusy={setBusy} reload={load} isAdmin={isAdmin} />
                ) : (
                    <ConnectSteps state={state} busy={busy} setBusy={setBusy} reload={load} isAdmin={isAdmin} />
                )}
            </div>
        </PanelScroller>
    )
}

function LoadingRows() {
    return (
        <div className="flex flex-col gap-3 p-4">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-24 w-full rounded-xl" />
            <Skeleton className="h-16 w-full rounded-xl" />
            <Skeleton className="h-16 w-full rounded-xl" />
        </div>
    )
}

// --- not connected yet ---------------------------------------------------------------------

function ConnectSteps({ state, busy, setBusy, reload, isAdmin }: { state: SlackStateView; busy: Busy; setBusy: (b: Busy) => void; reload: () => Promise<void>; isAdmin: boolean }) {
    const [token, setToken] = useState('')
    const [secret, setSecret] = useState('')
    // Where this app is served is not always where Slack can reach it: a local install is read on
    // localhost and called through a tunnel.
    const [requestUrl, setRequestUrl] = useState(state.requestUrl)

    const connect = async () => {
        setBusy('connect')
        const result = await connectSlackAction({ botToken: token, signingSecret: secret })
        setBusy(null)
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
                    <Button size="sm" className="self-start" disabled={!isAdmin || !token || !secret || busy === 'connect'} onClick={connect}>
                        {busy === 'connect' ? 'Checking with Slack…' : 'Connect'}
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

// --- connected -------------------------------------------------------------------------------

function Connected({ state, busy, setBusy, reload, isAdmin }: { state: SlackStateView; busy: Busy; setBusy: (b: Busy) => void; reload: () => Promise<void>; isAdmin: boolean }) {
    const connection = state.connection
    const byChannel = new Map<string, typeof state.bindings>()
    for (const binding of state.bindings) byChannel.set(binding.channelId, [...(byChannel.get(binding.channelId) ?? []), binding])

    const disconnect = async () => {
        setBusy('disconnect')
        const result = await disconnectSlackAction()
        setBusy(null)
        if (!result.ok) return toast.error(result.error)
        toast.success('Slack disconnected')
        await reload()
    }

    const remove = async (bindingId: string) => {
        setBusy(bindingId)
        const result = await unbindCoworkerAction({ bindingId })
        setBusy(null)
        if (!result.ok) return toast.error(result.error)
        await reload()
    }

    return (
        <>
            <div className="flex flex-wrap items-center gap-2">
                <Badge tone="green" className="gap-1">
                    <CheckIcon className="size-3" /> Connected
                </Badge>
                <span className="text-sm font-medium">{connection?.teamName ?? connection?.teamId}</span>
                {connection && !connection.canCustomizeIdentity && (
                    <Badge tone="orange">Coworkers post as the app — add chat:write.customize in Slack</Badge>
                )}
                {isAdmin && (
                    <Button variant="ghost" size="sm" className="ml-auto text-muted-foreground" disabled={busy === 'disconnect'} onClick={disconnect}>
                        Disconnect
                    </Button>
                )}
            </div>

            {state.slackError && <p className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">{state.slackError}</p>}

            <CreateChannel state={state} busy={busy} setBusy={setBusy} reload={reload} />

            <section className="flex flex-col gap-2">
                <h3 className="text-xs font-medium text-muted-foreground">Channels</h3>
                {byChannel.size === 0 && <p className="text-sm text-muted-foreground">No coworker is in a channel yet. Create one above, or add one to a channel the app was invited to.</p>}
                {[...byChannel.entries()].map(([channelId, bindings]) => (
                    <PanelRow
                        key={channelId}
                        title={`#${bindings[0].channelName ?? channelId}`}
                        description={bindings.map(b => b.name).join(', ')}
                        actions={
                            <div className="flex flex-wrap justify-end gap-1">
                                {bindings.map(binding => (
                                    <Button key={binding.id} variant="ghost" size="sm" className="gap-1 text-muted-foreground" disabled={busy === binding.id} onClick={() => remove(binding.id)}>
                                        {binding.name} <Trash2Icon className="size-3.5" />
                                    </Button>
                                ))}
                            </div>
                        }
                    />
                ))}
            </section>

            <AddToChannel state={state} busy={busy} setBusy={setBusy} reload={reload} />

            <p className="text-xs text-muted-foreground">
                In a channel with several coworkers, start the message with the one you want. A thread keeps its own conversation, so a follow-up needs no reminder of what you were talking about.
            </p>
        </>
    )
}

function CreateChannel({ state, busy, setBusy, reload }: { state: SlackStateView; busy: Busy; setBusy: (b: Busy) => void; reload: () => Promise<void> }) {
    const [name, setName] = useState('')
    const [isPrivate, setIsPrivate] = useState(true)
    const [picked, setPicked] = useState<string[]>([])

    const create = async () => {
        setBusy('create')
        const result = await createSlackChannelAction({ name, isPrivate, agentIds: picked })
        setBusy(null)
        if (!result.ok) return toast.error(result.error)
        toast.success(`#${name} created — your coworkers said hello`)
        setName('')
        setPicked([])
        await reload()
    }

    return (
        <section className="flex flex-col gap-3 rounded-xl border p-4">
            <div className="flex flex-col gap-0.5">
                <h3 className="text-sm font-medium">Give a team its own channel</h3>
                <p className="text-xs text-muted-foreground">Creates it in Slack, puts the coworkers in it and has each one introduce itself.</p>
            </div>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
                <Field label="Channel name" htmlFor="slack-channel-name" className="flex-1">
                    <Input id="slack-channel-name" value={name} onChange={e => setName(e.target.value)} placeholder="mdc-code" autoComplete="off" />
                </Field>
                <Field label="Private" orientation="row" className="sm:pb-2">
                    <Switch checked={isPrivate} onCheckedChange={setIsPrivate} />
                </Field>
            </div>
            <div className="flex flex-wrap gap-1.5">
                {state.coworkers.map(coworker => {
                    const on = picked.includes(coworker.id)
                    return (
                        <Button
                            key={coworker.id}
                            type="button"
                            size="sm"
                            variant={on ? 'default' : 'outline'}
                            className="h-7 rounded-full px-3 text-xs"
                            onClick={() => setPicked(on ? picked.filter(id => id !== coworker.id) : [...picked, coworker.id])}
                        >
                            {on && <CheckIcon className="size-3" />}
                            {coworker.name}
                        </Button>
                    )
                })}
            </div>
            <Button size="sm" className="self-start" disabled={!name || picked.length === 0 || busy === 'create'} onClick={create}>
                {busy === 'create' ? 'Creating…' : 'Create the channel'}
            </Button>
        </section>
    )
}

function AddToChannel({ state, busy, setBusy, reload }: { state: SlackStateView; busy: Busy; setBusy: (b: Busy) => void; reload: () => Promise<void> }) {
    const [channelId, setChannelId] = useState('')
    const [agentId, setAgentId] = useState('')

    const add = async () => {
        const channel = state.channels.find(c => c.id === channelId)
        setBusy('add')
        const result = await bindCoworkerAction({ channelId, channelName: channel?.name ?? null, agentId })
        setBusy(null)
        if (!result.ok) return toast.error(result.error)
        toast.success('Added')
        setAgentId('')
        await reload()
    }

    if (state.channels.length === 0) return null

    return (
        <section className="flex flex-col gap-3 rounded-xl border p-4">
            <div className="flex flex-col gap-0.5">
                <h3 className="text-sm font-medium">Add a coworker to an existing channel</h3>
                <p className="text-xs text-muted-foreground">Only channels the app was invited to — in Slack, type /invite @{state.connection?.teamName ? 'Rerun' : 'Rerun'} in the channel first.</p>
            </div>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
                <Field label="Channel" className="flex-1">
                    <Select value={channelId} onValueChange={setChannelId}>
                        <SelectTrigger className="w-full">
                            <SelectValue placeholder="Pick a channel" />
                        </SelectTrigger>
                        <SelectContent>
                            {state.channels.map(channel => (
                                <SelectItem key={channel.id} value={channel.id}>
                                    #{channel.name}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </Field>
                <Field label="Coworker" className="flex-1">
                    <Select value={agentId} onValueChange={setAgentId}>
                        <SelectTrigger className="w-full">
                            <SelectValue placeholder="Pick a coworker" />
                        </SelectTrigger>
                        <SelectContent>
                            {state.coworkers.map(coworker => (
                                <SelectItem key={coworker.id} value={coworker.id}>
                                    {coworker.name}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </Field>
                <Button size="sm" className="gap-1 sm:mb-0.5" disabled={!channelId || !agentId || busy === 'add'} onClick={add}>
                    <PlusIcon className="size-3.5" /> Add
                </Button>
            </div>
        </section>
    )
}
