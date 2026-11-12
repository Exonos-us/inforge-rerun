'use client'

import type { PresetStoreView } from '@/app/api/_actions/preset.actions'
import type { CoworkerPresetView, TeamPresetView } from '@/app/api/_services/preset.service'
import { AddButton, EmptyPitch, Group } from '@/components/connections/AiProvidersPanel'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { PanelScroller } from '@/components/ui/panel-list'
import { Skeleton } from '@/components/ui/skeleton'
import { SearchIcon } from '@/lib/icons'
import { hasArea, PRESET_AREAS, tagTone, type PresetArea } from '@/lib/presets/areas'
import { Badge } from '@rerun/ui/primitives'
import { useMemo, useState } from 'react'

import { presetGlyph } from './preset-icons'

// The store's front page: a search, the area filters, then cards — teams first because they are
// the reason the store exists, then every coworker. Built to be browsed at a hundred cards: the
// grid scrolls, the search is how you move.
type StoreKind = 'all' | 'teams' | 'coworkers'

export function PresetStoreList({
    store,
    onOpenPreset,
    onHireTeam,
    onEditTeam,
    onNewTeam,
    onNewCoworker,
}: {
    store: PresetStoreView | null
    onOpenPreset: (presetId: string) => void
    onHireTeam: (teamId: string) => void
    onEditTeam: (teamId: string | null) => void
    onNewTeam: () => void
    onNewCoworker: () => void
}) {
    const [query, setQuery] = useState('')
    const [kind, setKind] = useState<StoreKind>('all')
    const [area, setArea] = useState<PresetArea | null>(null)

    const needle = query.trim().toLowerCase()
    const teams = useMemo(() => (store?.teams ?? []).filter(team => kind !== 'coworkers' && matchesTeam(team, store?.presets ?? [], needle, area)), [store, kind, needle, area])
    const presets = useMemo(() => (store?.presets ?? []).filter(preset => kind !== 'teams' && matchesPreset(preset, needle, area)), [store, kind, needle, area])

    if (!store) return <StoreSkeleton />

    if (store.presets.length === 0 && store.teams.length === 0) {
        return (
            <PanelScroller className="flex flex-col gap-6 p-4">
                <Group title="Coworkers">
                    <EmptyPitch text="The store is empty. Save a live coworker as a preset: its soul, skills and routines become a definition you can hire again." actions={<AddButton label="New coworker" onClick={onNewCoworker} />} />
                </Group>
                <p className="text-xs text-muted-foreground">A preset stores the definition, never credentials and never memory: every hire starts fresh, wired the same way.</p>
            </PanelScroller>
        )
    }

    const filtering = needle !== '' || area !== null

    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex flex-col gap-2 border-b px-4 py-3">
                <div className="flex flex-wrap items-center gap-2">
                    <div className="relative min-w-48 flex-1">
                        <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
                        <Input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search by name, role, tag or what it does…" className="h-8 pl-8 text-xs" aria-label="Search the store" />
                    </div>
                    <div className="flex rounded-md bg-muted p-0.5">
                        {(['all', 'teams', 'coworkers'] as const).map(option => (
                            <button
                                key={option}
                                type="button"
                                aria-pressed={kind === option}
                                className={`rounded-[5px] px-2.5 py-1 text-xs capitalize transition-colors ${kind === option ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
                                onClick={() => setKind(option)}
                            >
                                {option}
                            </button>
                        ))}
                    </div>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                    <AreaChip label="All areas" active={area === null} onClick={() => setArea(null)} />
                    {PRESET_AREAS.map(candidate => (
                        <AreaChip key={candidate} label={candidate} active={area === candidate} onClick={() => setArea(area === candidate ? null : candidate)} />
                    ))}
                </div>
            </div>

            <PanelScroller className="flex flex-col gap-5 p-4">
                {teams.length === 0 && presets.length === 0 ? (
                    <div className="flex flex-col items-center gap-3 py-16 text-center">
                        <p className="text-sm text-muted-foreground">Nothing matches{needle ? ` “${query.trim()}”` : ''}{area ? ` in ${area}` : ''}.</p>
                        <Button
                            size="sm"
                            variant="outline"
                            onClick={() => {
                                setQuery('')
                                setArea(null)
                                setKind('all')
                            }}
                        >
                            Clear the search
                        </Button>
                    </div>
                ) : (
                    <>
                        {(teams.length > 0 || (!filtering && kind !== 'coworkers')) && (
                            <section className="flex flex-col gap-2">
                                <header className="flex items-center gap-2">
                                    <SectionTitle label="Teams" count={teams.length} />
                                    {store.presets.length > 0 && <AddButton label="New team" onClick={onNewTeam} />}
                                </header>
                                {teams.length === 0 ? (
                                    <EmptyPitch
                                        text="Bundle coworkers into a squad — hiring one creates the Box, the coworkers and their Slack channel in one go."
                                        actions={store.presets.length > 0 ? <AddButton label="New team" onClick={onNewTeam} /> : <span className="text-xs text-muted-foreground">Save a coworker as a preset first.</span>}
                                    />
                                ) : (
                                    <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
                                        {teams.map(team => (
                                            <TeamCard key={team.id} team={team} presets={store.presets} onEdit={() => onEditTeam(team.id)} onHire={() => onHireTeam(team.id)} />
                                        ))}
                                    </div>
                                )}
                            </section>
                        )}

                        {presets.length > 0 && (
                            <section className="flex flex-col gap-2">
                                <header className="flex items-center gap-2">
                                    <SectionTitle label="Coworkers" count={presets.length} />
                                    <AddButton label="New coworker" onClick={onNewCoworker} />
                                </header>
                                <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
                                    {presets.map(preset => (
                                        <CoworkerCard key={preset.id} preset={preset} onOpen={() => onOpenPreset(preset.id)} />
                                    ))}
                                </div>
                            </section>
                        )}

                        <p className="text-xs text-muted-foreground">A preset stores the definition, never credentials and never memory: every hire starts fresh, wired the same way.</p>
                    </>
                )}
            </PanelScroller>
        </div>
    )
}

function matchesPreset(preset: CoworkerPresetView, needle: string, area: PresetArea | null): boolean {
    if (area && !hasArea(preset.tags, area)) return false
    if (!needle) return true
    return [preset.name, preset.role, preset.description, ...preset.tags].join(' ').toLowerCase().includes(needle)
}

function matchesTeam(team: TeamPresetView, presets: CoworkerPresetView[], needle: string, area: PresetArea | null): boolean {
    const members = team.members.map(member => presets.find(candidate => candidate.id === member.presetId)).filter(Boolean) as CoworkerPresetView[]
    // A team wears its own tags plus its members' areas: filtering by Engineering finds the squads
    // that contain an engineer even when nobody tagged the team itself.
    if (area && !hasArea(team.tags, area) && !members.some(member => hasArea(member.tags, area))) return false
    if (!needle) return true
    return [team.name, team.description, ...team.tags, ...members.flatMap(member => [member.name, member.role])].join(' ').toLowerCase().includes(needle)
}

function SectionTitle({ label, count }: { label: string; count: number }) {
    return (
        <span className="flex items-center gap-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase">
            {label}
            <span className="rounded-full bg-muted px-1.5 text-[10px] tabular-nums normal-case">{count}</span>
        </span>
    )
}

function AreaChip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
    return (
        <button type="button" aria-pressed={active} className={`rounded-full border px-2.5 py-0.5 text-[11px] transition-colors ${active ? 'border-foreground bg-foreground text-background' : 'text-muted-foreground hover:text-foreground'}`} onClick={onClick}>
            {label}
        </button>
    )
}

function TagRow({ tags }: { tags: string[] }) {
    if (tags.length === 0) return null
    return (
        <div className="flex flex-wrap gap-1">
            {tags.slice(0, 4).map(tag => (
                <Badge key={tag} size="xs" tone={tagTone(tag)}>
                    {tag}
                </Badge>
            ))}
            {tags.length > 4 && <span className="text-[10px] text-muted-foreground">+{tags.length - 4}</span>}
        </div>
    )
}

function CoworkerCard({ preset, onOpen }: { preset: CoworkerPresetView; onOpen: () => void }) {
    const skills = preset.summary.skills.length
    const routines = preset.summary.schedules.length
    const counts = [skills ? `${skills} skill${skills === 1 ? '' : 's'}` : null, routines ? `${routines} routine${routines === 1 ? '' : 's'}` : null].filter(Boolean).join(' · ')

    return (
        <div role="button" tabIndex={0} className="flex cursor-pointer flex-col gap-2 rounded-lg border bg-card p-3 transition-colors hover:border-foreground/25" onClick={onOpen} onKeyDown={event => event.key === 'Enter' && onOpen()}>
            <div className="flex items-center gap-2.5">
                <span className="grid size-9 shrink-0 place-items-center rounded-md bg-muted text-lg">{presetGlyph(preset.icon)}</span>
                <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{preset.name}</div>
                    <div className="truncate text-[11px] text-muted-foreground">{preset.role || 'Coworker'}</div>
                </div>
            </div>
            <p className="line-clamp-2 min-h-8 text-xs text-muted-foreground">{preset.description || 'No description yet — write the card’s pitch on its page.'}</p>
            <TagRow tags={preset.tags} />
            <div className="mt-auto flex items-center gap-2 pt-0.5">
                <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">{counts}</span>
                <Button
                    size="xs"
                    variant="secondary"
                    onClick={event => {
                        event.stopPropagation()
                        onOpen()
                    }}
                >
                    Open
                </Button>
            </div>
        </div>
    )
}

function TeamCard({ team, presets, onEdit, onHire }: { team: TeamPresetView; presets: CoworkerPresetView[]; onEdit: () => void; onHire: () => void }) {
    const members = team.members.map(member => ({ member, preset: presets.find(candidate => candidate.id === member.presetId) }))
    const seats = team.members.reduce((sum, member) => sum + member.count, 0)
    const summary = members.map(({ member, preset }) => `${member.count > 1 ? `${member.count} × ` : ''}${preset?.role || preset?.name || 'Missing preset'}`).join(' · ')
    // The card wears the team's own tags, padded with its members' areas so an untagged team still says what it is.
    const memberAreas = PRESET_AREAS.filter(candidate => members.some(({ preset }) => preset && hasArea(preset.tags, candidate)) && !hasArea(team.tags, candidate))
    const tags = [...team.tags, ...memberAreas]

    return (
        <div role="button" tabIndex={0} className="flex cursor-pointer flex-col gap-2 rounded-lg border bg-gradient-to-b from-muted/40 to-card p-3 transition-colors hover:border-foreground/25" onClick={onEdit} onKeyDown={event => event.key === 'Enter' && onEdit()}>
            <div className="flex items-center gap-2.5">
                <TeamFacepile team={team} presets={presets} />
                <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{team.name}</div>
                    <div className="truncate text-[11px] text-muted-foreground">{summary || 'Empty team'}</div>
                </div>
            </div>
            {team.description && <p className="line-clamp-2 text-xs text-muted-foreground">{team.description}</p>}
            <TagRow tags={tags} />
            <div className="mt-auto flex items-center gap-2 pt-0.5">
                <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
                    {seats} coworker{seats === 1 ? '' : 's'}
                </span>
                <Button
                    size="xs"
                    variant="secondary"
                    onClick={event => {
                        event.stopPropagation()
                        onEdit()
                    }}
                >
                    Edit
                </Button>
                <Button
                    size="xs"
                    onClick={event => {
                        event.stopPropagation()
                        onHire()
                    }}
                >
                    Hire team
                </Button>
            </div>
        </div>
    )
}

function TeamFacepile({ team, presets }: { team: TeamPresetView; presets: CoworkerPresetView[] }) {
    const glyphs = team.members.flatMap(member => {
        const preset = presets.find(candidate => candidate.id === member.presetId)
        return Array.from({ length: member.count }, () => presetGlyph(preset?.icon ?? null))
    })
    return (
        <span className="flex shrink-0">
            {glyphs.slice(0, 5).map((glyph, index) => (
                <span key={index} className={`grid size-8 place-items-center rounded-full border-2 border-background bg-muted text-base ${index > 0 ? '-ml-2.5' : ''}`}>
                    {glyph}
                </span>
            ))}
        </span>
    )
}

function StoreSkeleton() {
    return (
        <div className="flex flex-col gap-4 p-4">
            <div className="flex items-center gap-2">
                <Skeleton className="h-8 flex-1" />
                <Skeleton className="h-8 w-40" />
            </div>
            <div className="flex gap-1.5">
                {Array.from({ length: 6 }, (_, index) => (
                    <Skeleton key={index} className="h-5 w-16 rounded-full" />
                ))}
            </div>
            <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
                {Array.from({ length: 6 }, (_, index) => (
                    <div key={index} className="space-y-2 rounded-lg border p-3">
                        <div className="flex items-center gap-2.5">
                            <Skeleton className="size-9 rounded-md" />
                            <div className="flex-1 space-y-1.5">
                                <Skeleton className="h-3.5 w-24" />
                                <Skeleton className="h-2.5 w-16" />
                            </div>
                        </div>
                        <Skeleton className="h-8 w-full" />
                        <Skeleton className="h-4 w-28 rounded-full" />
                    </div>
                ))}
            </div>
        </div>
    )
}
