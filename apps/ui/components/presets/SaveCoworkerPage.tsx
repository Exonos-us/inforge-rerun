'use client'

import { createPresetAction, duplicatePresetAction, saveAgentAsPresetAction, type PresetStoreView } from '@/app/api/_actions/preset.actions'
import type { CoworkerPresetView } from '@/app/api/_services/preset.service'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { PanelScroller } from '@/components/ui/panel-list'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { CameraIcon, ChevronLeftIcon, CopyPlusIcon, PencilLine, SearchIcon, type LucideIcon } from '@/lib/icons'
import { UNNAMED_BOX_LABEL, type IsoAgent } from '@/lib/board/types'
import { tagTone } from '@/lib/presets/areas'
import { useBoardStore } from '@/stores/board.store'
import { Badge } from '@rerun/ui/primitives'
import { useState } from 'react'
import { toast } from 'sonner'

import { guarded } from './action-guard'
import { presetGlyph } from './preset-icons'

// A new coworker is born in the full editor, never in a lesser form. This page is one question —
// what does it start from? — asked as three big choices; only the chosen one unfolds, searchable,
// because a board can hold a hundred coworkers.
type Mode = 'choose' | 'preset' | 'capture'

export function SaveCoworkerPage({ store, onBack, onCreated, reload }: { store: PresetStoreView | null; onBack: () => void; onCreated: (presetId: string) => void; reload: () => Promise<void> }) {
    const agents = useBoardStore(s => s.agents)
    const spaces = useBoardStore(s => s.spaces)
    const online = useBoardStore(s => s.agentOnlineMap)
    const [mode, setModeRaw] = useState<Mode>('choose')
    const [busy, setBusy] = useState<string | null>(null)
    const [query, setQuery] = useState('')
    const [boxFilter, setBoxFilter] = useState<string>('all')

    const presets = store?.presets ?? []
    const boxName = (spaceId: string) => spaces.find(space => space.id === spaceId)?.name?.trim() || UNNAMED_BOX_LABEL
    const setMode = (next: Mode) => {
        setModeRaw(next)
        setQuery('')
        setBoxFilter('all')
    }

    const open = async (presetId: string) => {
        await reload()
        onCreated(presetId)
    }

    const startBlank = async () => {
        setBusy('blank')
        const result = await guarded(() => createPresetAction({ name: 'New coworker' }))
        setBusy(null)
        if (!result) return
        if (!result.ok) return toast.error(result.error)
        await open(result.preset.id)
    }

    const useAsBase = async (presetId: string, name: string) => {
        setBusy(presetId)
        const result = await guarded(() => duplicatePresetAction({ presetId }))
        setBusy(null)
        if (!result) return
        if (!result.ok) return toast.error(result.error)
        toast.success(`“${name}” copied — this one is yours to reshape.`)
        await open(result.preset.id)
    }

    const capture = async (agentId: string, name: string) => {
        setBusy(agentId)
        // Capturing exports the whole folder from the coworker's machine: slow on a loaded one.
        const result = await guarded(() => saveAgentAsPresetAction({ agentId }))
        setBusy(null)
        if (!result) return
        if (!result.ok) return toast.error(result.error)
        toast.success(`“${name}” captured.`)
        await open(result.preset.id)
    }

    const needle = query.trim().toLowerCase()
    const filteredAgents = agents.filter(agent => {
        if (boxFilter !== 'all' && agent.spaceId !== boxFilter) return false
        if (!needle) return true
        return [agent.name, agent.handle ?? '', agent.description ?? '', boxName(agent.spaceId)].join(' ').toLowerCase().includes(needle)
    })
    const filteredPresets = presets.filter(preset => !needle || [preset.name, preset.role, preset.description, ...preset.tags].join(' ').toLowerCase().includes(needle))

    const subtitle = mode === 'choose' ? 'Pick what it starts from — then shape everything in the editor.' : mode === 'preset' ? 'Pick the preset to copy. The original is never touched.' : 'Pick the live coworker to capture — never credentials, never memory.'

    return (
        <>
            <div className="flex items-center gap-3 border-b px-3 py-2.5">
                <Button aria-label={mode === 'choose' ? 'Back to the store' : 'Back to the choices'} variant="ghost" size="icon-sm" className="shrink-0" onClick={() => (mode === 'choose' ? onBack() : setMode('choose'))}>
                    <ChevronLeftIcon className="size-4" />
                </Button>
                <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm font-medium">New coworker</span>
                    <span className="truncate text-[11px] text-muted-foreground">{subtitle}</span>
                </div>
            </div>

            {mode !== 'choose' && (
                <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2.5">
                    <div className="relative min-w-44 flex-1">
                        <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
                        <Input value={query} onChange={event => setQuery(event.target.value)} placeholder={mode === 'capture' ? 'Search by name, handle, Box or what it does…' : 'Search by name, role, tag or what it does…'} className="h-8 pl-8 text-xs" aria-label="Search" />
                    </div>
                    {mode === 'capture' && spaces.length > 1 && (
                        <Select value={boxFilter} onValueChange={setBoxFilter}>
                            <SelectTrigger className="h-8 w-44 text-xs" aria-label="Filter by Box">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="all">All Boxes</SelectItem>
                                {spaces.map(space => (
                                    <SelectItem key={space.id} value={space.id}>
                                        {space.name?.trim() || UNNAMED_BOX_LABEL}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    )}
                </div>
            )}

            <PanelScroller className="flex flex-col gap-4 p-4">
                {mode === 'choose' && (
                    <div className="flex min-h-full flex-col items-center justify-center gap-6 py-6">
                        <div className="flex flex-col items-center gap-1 text-center">
                            <h3 className="text-lg font-semibold">Where does this coworker start?</h3>
                            <p className="max-w-md text-sm text-muted-foreground">Whichever you pick, it opens in the full editor — nothing is final before you save.</p>
                        </div>
                        <div className="grid w-full max-w-3xl gap-3 sm:grid-cols-3">
                            <ChoiceCard
                                icon={PencilLine}
                                accent="emerald"
                                title={busy === 'blank' ? 'Opening the editor…' : 'Start blank'}
                                description="An empty definition: instructions, skills, routines, apps, knowledge — all yours to write."
                                disabled={busy !== null}
                                onClick={startBlank}
                            />
                            <ChoiceCard
                                icon={CopyPlusIcon}
                                accent="violet"
                                title="From an existing preset"
                                description={presets.length > 0 ? 'Copy one of your presets and reshape the copy; the original is never touched.' : 'No preset in the store yet.'}
                                disabled={busy !== null || presets.length === 0}
                                onClick={() => setMode('preset')}
                            />
                            <ChoiceCard
                                icon={CameraIcon}
                                accent="amber"
                                title="Capture a live coworker"
                                description={agents.length > 0 ? 'Take one from the board as it stands — archive, skills and routines included.' : 'No coworker on the board yet.'}
                                disabled={busy !== null || agents.length === 0}
                                onClick={() => setMode('capture')}
                            />
                        </div>
                    </div>
                )}

                {mode === 'preset' &&
                    (filteredPresets.length === 0 ? (
                        <EmptyMatches query={query} />
                    ) : (
                        <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
                            {filteredPresets.map(preset => (
                                <PresetBaseCard key={preset.id} preset={preset} busy={busy} onUse={() => useAsBase(preset.id, preset.name)} />
                            ))}
                        </div>
                    ))}

                {mode === 'capture' &&
                    (filteredAgents.length === 0 ? (
                        <EmptyMatches query={query} />
                    ) : (
                        <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
                            {filteredAgents.map(agent => (
                                <AgentCard key={agent.id} agent={agent} boxName={boxName(agent.spaceId)} online={!!online[agent.id]} busy={busy} onCapture={() => capture(agent.id, agent.name)} />
                            ))}
                        </div>
                    ))}
            </PanelScroller>
        </>
    )
}

function AgentCard({ agent, boxName, online, busy, onCapture }: { agent: IsoAgent; boxName: string; online: boolean; busy: string | null; onCapture: () => void }) {
    const initials = agent.name
        .split(/\s+/)
        .slice(0, 2)
        .map(word => word[0]?.toUpperCase() ?? '')
        .join('')

    return (
        <div className="flex flex-col gap-2 rounded-lg border bg-card p-3">
            <div className="flex items-center gap-2.5">
                <span className="relative grid size-9 shrink-0 place-items-center rounded-md bg-muted text-xs font-semibold">
                    {initials || '?'}
                    {online && <span className="absolute -right-0.5 -bottom-0.5 size-2 rounded-full bg-emerald-500 ring-2 ring-card" title="Online" />}
                </span>
                <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{agent.name}</div>
                    <div className="truncate text-[11px] text-muted-foreground">{agent.handle ? `@${agent.handle}` : boxName}</div>
                </div>
            </div>
            <p className="line-clamp-2 min-h-8 text-xs text-muted-foreground">{agent.description || 'No description on this coworker yet — the capture still brings its soul, skills and routines.'}</p>
            <div className="mt-auto flex items-center gap-1.5 pt-0.5">
                <Badge size="xs" tone="neutral">
                    {boxName}
                </Badge>
                {agent.disabledAt && (
                    <Badge size="xs" tone="orange">
                        Off
                    </Badge>
                )}
                <span className="flex-1" />
                <Button size="xs" variant="secondary" loading={busy === agent.id} disabled={busy !== null && busy !== agent.id} onClick={onCapture}>
                    Capture
                </Button>
            </div>
        </div>
    )
}

function PresetBaseCard({ preset, busy, onUse }: { preset: CoworkerPresetView; busy: string | null; onUse: () => void }) {
    const skills = preset.summary.skills.length + preset.authoredSkills.length
    const routines = preset.summary.schedules.length + preset.authoredRoutines.length
    const counts = [skills ? `${skills} skill${skills === 1 ? '' : 's'}` : null, routines ? `${routines} routine${routines === 1 ? '' : 's'}` : null, preset.connectorSlugs.length ? `${preset.connectorSlugs.length} app${preset.connectorSlugs.length === 1 ? '' : 's'}` : null]
        .filter(Boolean)
        .join(' · ')

    return (
        <div className="flex flex-col gap-2 rounded-lg border bg-card p-3">
            <div className="flex items-center gap-2.5">
                <span className="grid size-9 shrink-0 place-items-center rounded-md bg-muted text-lg">{presetGlyph(preset.icon)}</span>
                <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{preset.name}</div>
                    <div className="truncate text-[11px] text-muted-foreground">{preset.role || (preset.captured ? 'Captured coworker' : 'Written from scratch')}</div>
                </div>
            </div>
            <p className="line-clamp-2 min-h-8 text-xs text-muted-foreground">{preset.description || 'No description yet — the copy still brings everything the preset carries.'}</p>
            {preset.tags.length > 0 && (
                <div className="flex flex-wrap gap-1">
                    {preset.tags.slice(0, 4).map(tag => (
                        <Badge key={tag} size="xs" tone={tagTone(tag)}>
                            {tag}
                        </Badge>
                    ))}
                    {preset.tags.length > 4 && <span className="text-[10px] text-muted-foreground">+{preset.tags.length - 4}</span>}
                </div>
            )}
            <div className="mt-auto flex items-center gap-2 pt-0.5">
                <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">{counts}</span>
                <Button size="xs" variant="secondary" loading={busy === preset.id} disabled={busy !== null && busy !== preset.id} onClick={onUse}>
                    Use as base
                </Button>
            </div>
        </div>
    )
}

function EmptyMatches({ query }: { query: string }) {
    return <p className="rounded-md border border-dashed px-3 py-8 text-center text-xs text-muted-foreground">Nothing matches{query.trim() ? ` “${query.trim()}”` : ''}.</p>
}

// Static class strings per accent, because Tailwind only ships classes it can read in the source.
const CHOICE_ACCENTS = {
    emerald: { tile: 'bg-emerald-500/10 text-emerald-500 dark:text-emerald-400', card: 'hover:border-emerald-500/50 hover:bg-emerald-500/5' },
    violet: { tile: 'bg-violet-500/10 text-violet-500 dark:text-violet-400', card: 'hover:border-violet-500/50 hover:bg-violet-500/5' },
    amber: { tile: 'bg-amber-500/10 text-amber-600 dark:text-amber-400', card: 'hover:border-amber-500/50 hover:bg-amber-500/5' },
} as const

function ChoiceCard({ icon: ChoiceIcon, accent, title, description, disabled, onClick }: { icon: LucideIcon; accent: keyof typeof CHOICE_ACCENTS; title: string; description: string; disabled: boolean; onClick: () => void }) {
    const tone = CHOICE_ACCENTS[accent]
    return (
        <button
            type="button"
            disabled={disabled}
            className={`group flex min-h-48 flex-col items-center justify-center gap-3 rounded-xl border bg-card p-6 text-center transition-all hover:-translate-y-0.5 disabled:opacity-50 disabled:hover:translate-y-0 disabled:hover:border-border disabled:hover:bg-card ${tone.card}`}
            onClick={onClick}
        >
            <span className={`grid size-11 place-items-center rounded-lg transition-transform group-hover:scale-110 ${tone.tile}`}>
                <ChoiceIcon className="size-5" />
            </span>
            <span className="text-sm font-semibold">{title}</span>
            <span className="text-xs leading-relaxed text-muted-foreground">{description}</span>
        </button>
    )
}
