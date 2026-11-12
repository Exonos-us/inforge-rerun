'use client'

import { bindCoworkerAction, createSlackChannelAction, unbindCoworkerAction, type SlackBindingView, type SlackStateView } from '@/app/api/_actions/slack.actions'
import { AddButton, EmptyPitch, Group } from '@/components/connections/AiProvidersPanel'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { PanelRow } from '@/components/ui/panel-row'
import { Switch } from '@/components/ui/switch'
import { CheckIcon, LockKeyholeIcon, PlusIcon, Trash2Icon } from '@/lib/icons'
import { useState } from 'react'
import { toast } from 'sonner'

import { relative } from './relative-time'

// One row per channel, its coworkers on it: the whole wiring in one glance. A channel the app sits
// in with nobody bound yet is still a row, because that is exactly where "+ Add" is needed.
type ChannelRow = { id: string; name: string; isPrivate: boolean; appIsIn: boolean; bindings: SlackBindingView[] }

function channelRows(state: SlackStateView): ChannelRow[] {
    const rows = new Map<string, ChannelRow>()
    for (const channel of state.channels) rows.set(channel.id, { id: channel.id, name: channel.name, isPrivate: channel.is_private ?? false, appIsIn: true, bindings: [] })
    for (const binding of state.bindings) {
        const row = rows.get(binding.channelId) ?? { id: binding.channelId, name: binding.channelName ?? binding.channelId, isPrivate: false, appIsIn: state.channels.length === 0, bindings: [] }
        row.bindings.push(binding)
        rows.set(binding.channelId, row)
    }
    return [...rows.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export function SlackChannelsSection({ state, reload }: { state: SlackStateView; reload: () => Promise<void> }) {
    const [creating, setCreating] = useState(false)
    const [busy, setBusy] = useState<string | null>(null)
    const rows = channelRows(state)

    const remove = async (bindingId: string) => {
        setBusy(bindingId)
        const result = await unbindCoworkerAction({ bindingId })
        setBusy(null)
        if (!result.ok) return toast.error(result.error)
        await reload()
    }

    const add = async (row: ChannelRow, agentId: string) => {
        setBusy(`${row.id}:add`)
        const result = await bindCoworkerAction({ channelId: row.id, channelName: row.name, agentId })
        setBusy(null)
        if (!result.ok) return toast.error(result.error)
        toast.success('Added')
        await reload()
    }

    return (
        <Group title={rows.length > 0 ? `Channels · ${rows.length}` : 'Channels'} addMenu={!creating ? <AddButton label="New channel" onClick={() => setCreating(true)} /> : undefined}>
            {creating && <CreateChannelCard state={state} onDone={reload} onClose={() => setCreating(false)} />}

            {rows.length === 0 && !creating && (
                <EmptyPitch text="No coworker is in a channel yet. Create one, or invite the app to a channel you already have." actions={<AddButton label="New channel" onClick={() => setCreating(true)} />} />
            )}

            {rows.map(row => (
                <PanelRow
                    key={row.id}
                    title={
                        <span className="inline-flex min-w-0 items-center gap-1.5">
                            {row.isPrivate && <LockKeyholeIcon className="size-3 shrink-0 text-muted-foreground" />}
                            <span className="truncate">#{row.name}</span>
                        </span>
                    }
                    meta={state.channelActivity[row.id] ? <span className="text-[11px] text-muted-foreground">{relative(state.channelActivity[row.id])}</span> : undefined}
                    footer={row.appIsIn ? undefined : 'The app is no longer in this channel. In Slack, type /invite @Rerun there to bring it back.'}
                >
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                        {row.bindings.map(binding => (
                            <Button key={binding.id} variant="outline" size="sm" className="h-7 gap-1 rounded-full px-3 text-xs font-normal" disabled={busy === binding.id} onClick={() => remove(binding.id)} aria-label={`Remove ${binding.name} from #${row.name}`}>
                                {binding.name}
                                <Trash2Icon className="size-3 text-muted-foreground" />
                            </Button>
                        ))}
                        <AddCoworkerMenu row={row} coworkers={state.coworkers} busy={busy === `${row.id}:add`} onAdd={agentId => add(row, agentId)} />
                    </div>
                </PanelRow>
            ))}

            <p className="text-xs text-muted-foreground">
                Missing a channel? In Slack, type <code className="rounded bg-muted px-1 py-0.5 text-[11px]">/invite @Rerun</code> in it — it shows up here once the app is in.
            </p>
        </Group>
    )
}

function AddCoworkerMenu({ row, coworkers, busy, onAdd }: { row: ChannelRow; coworkers: SlackStateView['coworkers']; busy: boolean; onAdd: (agentId: string) => void }) {
    const available = coworkers.filter(coworker => !coworker.disabled && !row.bindings.some(binding => binding.agentId === coworker.id))
    if (available.length === 0) return null

    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="h-7 gap-1 rounded-full border-dashed px-3 text-xs font-normal text-muted-foreground" disabled={busy}>
                    <PlusIcon className="size-3" />
                    {busy ? 'Adding…' : 'Add'}
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
                {available.map(coworker => (
                    <DropdownMenuItem key={coworker.id} onSelect={() => onAdd(coworker.id)}>
                        {coworker.name}
                    </DropdownMenuItem>
                ))}
            </DropdownMenuContent>
        </DropdownMenu>
    )
}

// The create form stays out of sight until "New channel": the everyday visit here is a glance at
// the table, not a creation.
function CreateChannelCard({ state, onDone, onClose }: { state: SlackStateView; onDone: () => Promise<void>; onClose: () => void }) {
    const [name, setName] = useState('')
    const [isPrivate, setIsPrivate] = useState(true)
    const [picked, setPicked] = useState<string[]>([])
    const [creating, setCreating] = useState(false)

    const create = async () => {
        setCreating(true)
        const result = await createSlackChannelAction({ name, isPrivate, agentIds: picked })
        setCreating(false)
        if (!result.ok) return toast.error(result.error)
        if (result.warning) toast.warning(result.warning)
        else toast.success(`#${name} created — your coworkers said hello`)
        onClose()
        await onDone()
    }

    return (
        <section className="flex flex-col gap-3 rounded-xl border p-4">
            <div className="flex items-start justify-between gap-3">
                <div className="flex flex-col gap-0.5">
                    <h3 className="text-sm font-medium">New channel</h3>
                    <p className="text-xs text-muted-foreground">Created in Slack with the coworkers you pick; each one introduces itself.</p>
                </div>
                <Field label="Private" orientation="row">
                    <Switch checked={isPrivate} onCheckedChange={setIsPrivate} />
                </Field>
            </div>
            <Field label="Channel name" htmlFor="slack-channel-name">
                <Input id="slack-channel-name" value={name} onChange={e => setName(e.target.value)} placeholder="mdc-code" autoComplete="off" autoFocus />
            </Field>
            <Field label="Coworkers to invite">
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
            </Field>
            <div className="flex flex-wrap items-center justify-end gap-2">
                <Button size="sm" variant="ghost" onClick={onClose}>
                    Cancel
                </Button>
                <Button size="sm" disabled={!name || picked.length === 0 || creating} onClick={create}>
                    {creating ? 'Creating…' : 'Create channel'}
                </Button>
            </div>
        </section>
    )
}
