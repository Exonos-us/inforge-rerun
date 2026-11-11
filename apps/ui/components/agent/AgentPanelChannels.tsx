'use client'

import { bindCoworkerAction, getAgentChannelsAction, type AgentChannelsView } from '@/app/api/_actions/slack.actions'
import { AgentChannelRow, CHANNEL_GRID } from '@/components/agent/AgentChannelRow'
import { AddButton, EmptyPitch, Group } from '@/components/connections/AiProvidersPanel'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { PanelScroller } from '@/components/ui/panel-list'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import type { IsoAgent } from '@/lib/board/types'
import { cn } from '@/lib/utils'
import { useWorkspaceSettingsStore } from '@/stores/workspace-settings.store'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'

// The chats one coworker answers in: Slack channels today, each with the face it wears there —
// the same coworker can be the formal one in a client channel and something shorter in the
// team's own. Other chat apps land here as sections of their own.

export function AgentPanelChannels({ agent }: { agent: IsoAgent }) {
    const [state, setState] = useState<AgentChannelsView | null>(null)
    const [busy, setBusy] = useState<string | null>(null)
    const [adding, setAdding] = useState(false)
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
            <div className="flex flex-col gap-2 p-4">
                <Skeleton className="h-3 w-16" />
                <div className="space-y-2 rounded-md border p-3">
                    <Skeleton className="h-8 w-full" />
                    <Skeleton className="h-8 w-full" />
                </div>
            </div>
        )
    }

    if (!state.connected) {
        return (
            <div className="flex flex-col items-start gap-3 p-4">
                <p className="text-sm text-muted-foreground">
                    No chat app is connected to this workspace yet. Once Slack is, {agent.name} can read the channels you put it in and answer there under its own name.
                </p>
                <Button size="sm" onClick={() => openWorkspacePanel('chat_apps')}>
                    Open Chat apps
                </Button>
            </div>
        )
    }

    const canAdd = state.channels.length > 0

    return (
        <PanelScroller className="flex flex-col gap-4 p-4">
            <Group title="Slack" addMenu={canAdd && !adding ? <AddButton label="Add to channel" onClick={() => setAdding(true)} /> : undefined}>
                {adding && <AddToChannelCard agentId={agent.id} agentName={agent.name} state={state} busy={busy} setBusy={setBusy} reload={load} onClose={() => setAdding(false)} />}

                {state.bindings.length === 0 && !adding && (
                    <EmptyPitch
                        text={`${agent.name} is in no Slack channel yet. Add it to one the app was invited to, or create a channel from Chat apps.`}
                        actions={
                            <>
                                {canAdd && <AddButton label="Add to channel" onClick={() => setAdding(true)} />}
                                <Button size="xs" variant="ghost" onClick={() => openWorkspacePanel('chat_apps')}>
                                    Open Chat apps
                                </Button>
                            </>
                        }
                    />
                )}

                {state.bindings.length > 0 && (
                    <div className="overflow-hidden rounded-md border bg-muted/20">
                        <div className={cn(CHANNEL_GRID, 'hidden border-b py-2 text-[11.5px] font-medium text-muted-foreground sm:grid')}>
                            <span>Channel</span>
                            <span>Posts as</span>
                            <span>Avatar</span>
                            <span></span>
                        </div>
                        {state.bindings.map(binding => (
                            <AgentChannelRow key={binding.id} binding={binding} busy={busy} setBusy={setBusy} reload={load} />
                        ))}
                    </div>
                )}

                {!state.canCustomizeIdentity && state.bindings.length > 0 && (
                    <p className="text-xs text-muted-foreground">
                        Slack is ignoring the name and the avatar: the app was installed without chat:write.customize. Add the scope in Slack and reinstall it.
                    </p>
                )}
            </Group>

            <p className="text-xs text-muted-foreground">
                In a channel holding several coworkers, people name the one they want at the start of the message. A thread stays with whoever answered first and keeps the conversation.
            </p>
        </PanelScroller>
    )
}

function AddToChannelCard({ agentId, agentName, state, busy, setBusy, reload, onClose }: { agentId: string; agentName: string; state: AgentChannelsView; busy: string | null; setBusy: (b: string | null) => void; reload: () => Promise<void>; onClose: () => void }) {
    const [channelId, setChannelId] = useState('')

    const add = async () => {
        const channel = state.channels.find(c => c.id === channelId)
        setBusy('add')
        const result = await bindCoworkerAction({ channelId, channelName: channel?.name ?? null, agentId })
        setBusy(null)
        if (!result.ok) return toast.error(result.error)
        onClose()
        await reload()
    }

    return (
        <section className="flex flex-col gap-3 rounded-md border p-3.5">
            <h4 className="text-sm font-medium">Add {agentName} to a channel</h4>
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
                <div className="flex justify-end gap-2">
                    <Button size="sm" variant="ghost" onClick={onClose}>
                        Cancel
                    </Button>
                    <Button size="sm" disabled={!channelId || busy === 'add'} onClick={add}>
                        {busy === 'add' ? 'Adding…' : 'Add'}
                    </Button>
                </div>
            </div>
            <p className="text-xs text-muted-foreground">Only channels the app was invited to. It introduces itself when it joins; name and avatar can be edited right after.</p>
        </section>
    )
}
