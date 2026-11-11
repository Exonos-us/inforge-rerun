'use client'

import { unbindCoworkerAction, updateBindingAction, type SlackBindingView } from '@/app/api/_actions/slack.actions'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { emojiGlyph, EMOJI_CHOICES } from '@/components/slack/slack-emoji'
import { PencilIcon, Trash2Icon } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { useState } from 'react'
import { toast } from 'sonner'

// One chat the coworker answers in: a reading row by default, and the same row expanded into the
// editor when the pencil is pressed. On a phone the grid folds to face + channel + actions, with
// the posted-under name moving beneath the channel.

export const CHANNEL_GRID = 'grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-3.5 sm:grid-cols-[minmax(0,1.3fr)_minmax(0,1.1fr)_64px_72px]'

export function AgentChannelRow({ binding, busy, setBusy, reload }: { binding: SlackBindingView; busy: string | null; setBusy: (b: string | null) => void; reload: () => Promise<void> }) {
    const [editing, setEditing] = useState(false)
    const glyph = emojiGlyph(binding.iconEmoji)

    const remove = async () => {
        setBusy(binding.id)
        const result = await unbindCoworkerAction({ bindingId: binding.id })
        setBusy(null)
        if (!result.ok) return toast.error(result.error)
        await reload()
    }

    return (
        <div className={cn('border-b last:border-b-0', editing && 'bg-muted/20')}>
            <div className={cn(CHANNEL_GRID, 'py-2.5')}>
                <Face glyph={glyph} shortcode={binding.iconEmoji} className="sm:hidden" />
                <div className="min-w-0">
                    <ChannelName name={binding.channelName ?? binding.channelId} />
                    <p className="truncate text-xs text-muted-foreground sm:hidden">Posts as {binding.name}</p>
                </div>
                <span className="hidden truncate text-[13px] text-muted-foreground sm:block">{binding.name}</span>
                <Face glyph={glyph} shortcode={binding.iconEmoji} className="hidden sm:flex" />
                <div className="flex items-center justify-end gap-0.5">
                    <Button variant="ghost" size="icon-sm" aria-label={`Edit how it posts in #${binding.channelName ?? binding.channelId}`} className={cn('text-muted-foreground', editing && 'bg-accent text-foreground')} onClick={() => setEditing(open => !open)}>
                        <PencilIcon className="size-3.5" />
                    </Button>
                    <Button variant="ghost" size="icon-sm" aria-label={`Remove from #${binding.channelName ?? binding.channelId}`} className="text-muted-foreground" disabled={busy === binding.id} onClick={remove}>
                        <Trash2Icon className="size-3.5" />
                    </Button>
                </div>
            </div>
            {editing && <BindingEditor binding={binding} busy={busy} setBusy={setBusy} reload={reload} onClose={() => setEditing(false)} />}
        </div>
    )
}

export function ChannelName({ name }: { name: string }) {
    return (
        <span className="flex min-w-0 items-center gap-0.5 text-sm font-medium">
            <span className="shrink-0 font-normal text-muted-foreground">#</span>
            <span className="truncate">{name}</span>
        </span>
    )
}

// A custom shortcode outside the picker set still shows, as the code Slack stores.
function Face({ glyph, shortcode, className }: { glyph: string | null; shortcode: string | null; className?: string }) {
    if (!glyph && !shortcode) return <span aria-hidden="true" className={cn('text-muted-foreground', className)}>–</span>
    if (!glyph) return <span className={cn('truncate font-mono text-[11px] text-muted-foreground', className)}>{shortcode}</span>
    return <span className={cn('text-lg leading-none', className)}>{glyph}</span>
}

function BindingEditor({ binding, busy, setBusy, reload, onClose }: { binding: SlackBindingView; busy: string | null; setBusy: (b: string | null) => void; reload: () => Promise<void>; onClose: () => void }) {
    const [name, setName] = useState(binding.name)
    const [emoji, setEmoji] = useState(binding.iconEmoji ?? '')

    const save = async () => {
        setBusy(binding.id)
        const result = await updateBindingAction({ bindingId: binding.id, displayName: name, iconEmoji: emoji || null })
        setBusy(null)
        if (!result.ok) return toast.error(result.error)
        toast.success('Saved')
        onClose()
        await reload()
    }

    return (
        <div className="flex flex-col gap-3 px-3.5 pb-3.5 pt-1">
            <div className="flex flex-col gap-3 sm:flex-row">
                <Field label="Posts as" htmlFor={`name-${binding.id}`} className="flex-1">
                    <Input id={`name-${binding.id}`} value={name} onChange={e => setName(e.target.value)} />
                </Field>
                <Field label="Custom avatar (:shortcode:)" htmlFor={`emoji-${binding.id}`} className="sm:w-44">
                    <Input id={`emoji-${binding.id}`} value={emoji} onChange={e => setEmoji(e.target.value)} placeholder=":wrench:" spellCheck={false} className="font-mono" />
                </Field>
            </div>
            <Field label="Avatar">
                <div className="flex flex-wrap gap-1.5">
                    {EMOJI_CHOICES.map(([shortcode, glyph]) => (
                        <Button
                            key={shortcode}
                            type="button"
                            variant={emoji === shortcode ? 'default' : 'outline'}
                            size="icon-sm"
                            className="size-8 text-base"
                            aria-label={shortcode}
                            onClick={() => setEmoji(emoji === shortcode ? '' : shortcode)}
                        >
                            {glyph}
                        </Button>
                    ))}
                </div>
            </Field>
            <div className="flex flex-wrap items-center justify-end gap-2">
                <Button size="sm" variant="ghost" onClick={onClose}>
                    Cancel
                </Button>
                <Button size="sm" disabled={!name.trim() || busy === binding.id} onClick={save}>
                    {busy === binding.id ? 'Saving…' : 'Save'}
                </Button>
            </div>
        </div>
    )
}
