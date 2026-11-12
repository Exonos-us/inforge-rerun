'use client'

import { deleteTeamPresetAction, saveTeamPresetAction, type PresetStoreView } from '@/app/api/_actions/preset.actions'
import type { TeamPresetView } from '@/app/api/_services/preset.service'
import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { PanelScroller } from '@/components/ui/panel-list'
import { ChevronLeftIcon } from '@/lib/icons'
import { useState } from 'react'
import { toast } from 'sonner'

import { guarded } from './action-guard'
import { presetGlyph } from './preset-icons'
import { TagsEditor } from './TagsEditor'

// Composing a team is only counting: every coworker preset of the workspace with a stepper. The
// definition of each member lives on its own preset; the team adds nothing but the bundle.
export function TeamPresetFormPage({ store, team, onBack, reload }: { store: PresetStoreView; team: TeamPresetView | null; onBack: () => void; reload: () => Promise<void> }) {
    const [name, setName] = useState(team?.name ?? '')
    const [description, setDescription] = useState(team?.description ?? '')
    const [tags, setTags] = useState<string[]>(team?.tags ?? [])
    const [counts, setCounts] = useState<Record<string, number>>(() => Object.fromEntries((team?.members ?? []).map(member => [member.presetId, member.count])))
    const [saving, setSaving] = useState(false)

    const total = Object.values(counts).reduce((sum, count) => sum + count, 0)

    const setCount = (presetId: string, count: number) => {
        const next = { ...counts }
        if (count <= 0) delete next[presetId]
        else next[presetId] = Math.min(count, 8)
        setCounts(next)
    }

    const save = async () => {
        setSaving(true)
        const result = await guarded(() =>
            saveTeamPresetAction({
                id: team?.id,
                name,
                description,
                tags,
                members: Object.entries(counts).map(([presetId, count]) => ({ presetId, count })),
            })
        )
        setSaving(false)
        if (!result) return
        if (!result.ok) return toast.error(result.error)
        toast.success(team ? 'Team preset saved' : 'Team preset created')
        await reload()
        onBack()
    }

    const remove = async () => {
        if (!team) return
        const result = await guarded(() => deleteTeamPresetAction({ teamId: team.id }))
        if (!result) return
        if (!result.ok) return toast.error(result.error)
        toast.success('Team preset deleted')
        await reload()
        onBack()
    }

    return (
        <>
            <div className="flex items-center gap-3 border-b px-3 py-2.5">
                <Button aria-label="Back to presets" variant="ghost" size="icon-sm" className="shrink-0" onClick={onBack}>
                    <ChevronLeftIcon className="size-4" />
                </Button>
                <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm font-medium">{team ? `Edit “${team.name}”` : 'New team preset'}</span>
                    <span className="truncate text-[11px] text-muted-foreground">{total} coworker{total === 1 ? '' : 's'} in the squad</span>
                </div>
                {team && (
                    <ConfirmDialog title={`Delete “${team.name}”?`} description="Only the bundle goes; the coworker presets inside it stay." confirmLabel="Delete team preset" onConfirm={remove}>
                        <Button size="xs" variant="ghost" className="text-muted-foreground">
                            Delete
                        </Button>
                    </ConfirmDialog>
                )}
            </div>

            <PanelScroller className="flex flex-col gap-4 p-4">
                <div className="flex flex-col gap-3 sm:flex-row">
                    <Field label="Name" htmlFor="team-name" className="flex-1">
                        <Input id="team-name" value={name} onChange={e => setName(e.target.value)} placeholder="Project squad" />
                    </Field>
                    <Field label="Description" htmlFor="team-description" className="flex-[2]">
                        <Input id="team-description" value={description} onChange={e => setDescription(e.target.value)} placeholder="3 Engineers · 1 Product Owner · 1 Architect" />
                    </Field>
                </div>
                <TagsEditor tags={tags} onChange={setTags} idPrefix="team" />

                <div className="flex flex-col gap-1.5">
                    <span className="text-sm font-medium text-muted-foreground">Who is in it</span>
                    <div className="overflow-hidden rounded-md border">
                        {store.presets.map(preset => {
                            const count = counts[preset.id] ?? 0
                            return (
                                <div key={preset.id} className="flex items-center gap-2.5 border-b px-3 py-2 last:border-b-0">
                                    <span className="grid size-8 shrink-0 place-items-center rounded-md bg-muted text-base">{presetGlyph(preset.icon)}</span>
                                    <div className="min-w-0 flex-1">
                                        <div className="truncate text-sm">{preset.name}</div>
                                        {preset.role && <div className="truncate text-[11px] text-muted-foreground">{preset.role}</div>}
                                    </div>
                                    <div className="flex items-center gap-1">
                                        <Button size="icon-sm" variant="outline" aria-label={`One ${preset.name} less`} disabled={count === 0} onClick={() => setCount(preset.id, count - 1)}>
                                            −
                                        </Button>
                                        <span className="w-6 text-center text-sm tabular-nums">{count}</span>
                                        <Button size="icon-sm" variant="outline" aria-label={`One ${preset.name} more`} onClick={() => setCount(preset.id, count + 1)}>
                                            +
                                        </Button>
                                    </div>
                                </div>
                            )
                        })}
                    </div>
                </div>

                <div className="flex justify-end border-t pt-3">
                    <Button size="sm" disabled={!name.trim() || total === 0} loading={saving} onClick={save}>
                        {team ? 'Save team preset' : 'Create team preset'}
                    </Button>
                </div>
            </PanelScroller>
        </>
    )
}
