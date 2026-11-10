'use client'

import { bindCoworkerAction, getAgentChannelsAction, unbindCoworkerAction, updateBindingAction, type AgentChannelsView, type SlackBindingView } from '@/app/api/_actions/slack.actions'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { PanelScroller } from '@/components/ui/panel-list'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { HashIcon, PlusIcon, Trash2Icon } from '@/lib/icons'
import type { IsoAgent } from '@/lib/board/types'
import { useWorkspaceSettingsStore } from '@/stores/workspace-settings.store'
import { Badge } from '@rerun/ui/primitives'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'

// The Slack side of one coworker: the channels it reads and answers in, and the face it wears in
// each. Kept per channel rather than per coworker, because the same coworker can be the formal
// one in a client channel and something shorter in the team's own.

const EMOJI_SUGGESTIONS = [':wrench:', ':art:', ':rocket:', ':mag:', ':memo:', ':robot_face:', ':bar_chart:', ':inbox_tray:']

export function AgentPanelChannels({ agent }: { agent: IsoAgent }) {
    const [state, setState] = useState<AgentChannelsView | null>(null)
    const [busy, setBusy] = useState<string | null>(null)
    const openWorkspacePanel = useWorkspaceSettingsStore(s => s.openWorkspacePanel)

    const load = useCallback(async () => {
        const result = await getAgentChannelsAction({ agentId: agent.id })
        if (result.ok) setState(result.state)
        else toast.error(result.error)
    }, [agent.id])

    useEffect(() => {
        void load()
    }, [load])

    if (!state) {
        return (
            <div className="flex flex-col gap-3 p-4">
                <Skeleton className="h-16 w-full rounded-xl" />
                <Skeleton className="h-16 w-full rounded-xl" />
            </div>
        )
    }

    if (!state.connected) {
        return (
            <div className="flex flex-col items-start gap-3 p-4">
                <p className="text-sm text-muted-foreground">
                    Slack is not connected to this workspace yet. Once it is, {agent.name} can read the channels you put it in and answer there under its own name.
                </p>
                <Button size="sm" onClick={() => openWorkspacePanel('slack')}>
                    Connect Slack
                </Button>
            </div>
        )
    }

    return (
        <PanelScroller>
            <div className="flex flex-col gap-4 p-4">
                {state.bindings.length === 0 && (
                    <p className="text-sm text-muted-foreground">
                        {agent.name} is in no Slack channel yet. Add one below — it answers when someone writes there, in a thread of its own.
                    </p>
                )}

                {state.bindings.map(binding => (
                    <ChannelRow key={binding.id} binding={binding} canCustomize={state.canCustomizeIdentity} busy={busy} setBusy={setBusy} reload={load} />
                ))}

                <AddChannel agentId={agent.id} state={state} busy={busy} setBusy={setBusy} reload={load} />

                <p className="text-xs text-muted-foreground">
                    In a channel holding several coworkers, people name the one they want at the start of the message. A thread stays with whoever answered first and keeps the conversation.
                </p>
            </div>
        </PanelScroller>
    )
}

function ChannelRow({ binding, canCustomize, busy, setBusy, reload }: { binding: SlackBindingView; canCustomize: boolean; busy: string | null; setBusy: (b: string | null) => void; reload: () => Promise<void> }) {
    const [name, setName] = useState(binding.name)
    const [emoji, setEmoji] = useState(binding.iconEmoji ?? '')
    const dirty = name !== binding.name || emoji !== (binding.iconEmoji ?? '')

    const save = async () => {
        setBusy(binding.id)
        const result = await updateBindingAction({ bindingId: binding.id, displayName: name, iconEmoji: emoji || null })
        setBusy(null)
        if (!result.ok) return toast.error(result.error)
        toast.success('Saved')
        await reload()
    }

    const remove = async () => {
        setBusy(binding.id)
        const result = await unbindCoworkerAction({ bindingId: binding.id })
        setBusy(null)
        if (!result.ok) return toast.error(result.error)
        await reload()
    }

    return (
        <section className="flex flex-col gap-3 rounded-xl border p-3">
            <div className="flex flex-wrap items-center gap-2">
                <HashIcon className="size-4 text-muted-foreground" />
                <span className="text-sm font-medium">{binding.channelName ?? binding.channelId}</span>
                <Badge tone="green">answers here</Badge>
                <Button variant="ghost" size="sm" className="ml-auto text-muted-foreground" disabled={busy === binding.id} onClick={remove}>
                    <Trash2Icon className="size-3.5" />
                </Button>
            </div>

            <div className="flex flex-col gap-3 sm:flex-row">
                <Field label="Posts as" htmlFor={`name-${binding.id}`} className="flex-1">
                    <Input id={`name-${binding.id}`} value={name} onChange={e => setName(e.target.value)} />
                </Field>
                <Field label="Avatar" htmlFor={`emoji-${binding.id}`} className="sm:w-36">
                    <Input id={`emoji-${binding.id}`} value={emoji} onChange={e => setEmoji(e.target.value)} placeholder=":wrench:" spellCheck={false} />
                </Field>
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
                {EMOJI_SUGGESTIONS.map(suggestion => (
                    <Button key={suggestion} type="button" variant={emoji === suggestion ? 'default' : 'outline'} size="sm" className="h-7 rounded-full px-2.5 font-mono text-xs" onClick={() => setEmoji(suggestion)}>
                        {suggestion}
                    </Button>
                ))}
                {dirty && (
                    <Button size="sm" className="ml-auto" disabled={busy === binding.id} onClick={save}>
                        Save
                    </Button>
                )}
            </div>

            {!canCustomize && <p className="text-xs text-muted-foreground">Slack is ignoring the name and the avatar: the app was installed without chat:write.customize. Add the scope in Slack and reinstall it.</p>}
        </section>
    )
}

function AddChannel({ agentId, state, busy, setBusy, reload }: { agentId: string; state: AgentChannelsView; busy: string | null; setBusy: (b: string | null) => void; reload: () => Promise<void> }) {
    const [channelId, setChannelId] = useState('')

    if (state.channels.length === 0) {
        return <p className="text-xs text-muted-foreground">No other channel to join. In Slack, invite the app to a channel with /invite, or create one from Settings → Slack.</p>
    }

    const add = async () => {
        const channel = state.channels.find(c => c.id === channelId)
        setBusy('add')
        const result = await bindCoworkerAction({ channelId, channelName: channel?.name ?? null, agentId })
        setBusy(null)
        if (!result.ok) return toast.error(result.error)
        setChannelId('')
        await reload()
    }

    return (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <Field label="Add a channel" className="flex-1">
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
            <Button size="sm" className="gap-1" disabled={!channelId || busy === 'add'} onClick={add}>
                <PlusIcon className="size-3.5" /> Add
            </Button>
        </div>
    )
}
