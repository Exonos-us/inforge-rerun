'use client'

import { hireTeamAction, type PresetStoreView } from '@/app/api/_actions/preset.actions'
import type { CoworkerPresetView, TeamPresetView } from '@/app/api/_services/preset.service'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { PanelScroller } from '@/components/ui/panel-list'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { ChevronLeftIcon } from '@/lib/icons'
import { channelNameFor, coworkerNameFor, shortCodeOf, spaceNameFor } from '@/lib/presets/naming'
import { useBoardStore } from '@/stores/board.store'
import { useSession } from '@/supabase/session/SessionProvider'
import { StepperBar, StepTransition, useStepper } from '@rerun/ui/steps'
import { useState } from 'react'
import { toast } from 'sonner'

import { guarded } from './action-guard'
import { nextPresetIcon, presetGlyph } from './preset-icons'

// From "we signed a new engagement" to a working project in four steps: the team, the names, the
// Slack channel, the kickoff. Everything derived (Box name, channel, coworker names) stays
// editable — an edited value stops following.
type RosterDraft = { presetId: string; icon: string | null; nameOverride: string | null }

const STEPS = [
    { title: 'Team', hint: 'Pick a saved team or build the roster from the store.' },
    { title: 'Project', hint: 'The client and the project name everything else.' },
    { title: 'Slack', hint: 'The channel the team answers in.' },
    { title: 'Kickoff', hint: 'Names, project facts, hire.' },
] as const

function rosterFromTeam(team: TeamPresetView, presets: CoworkerPresetView[]): RosterDraft[] {
    return team.members.flatMap(member => {
        const preset = presets.find(candidate => candidate.id === member.presetId)
        if (!preset) return []
        return Array.from({ length: member.count }, () => ({ presetId: preset.id, icon: preset.icon || null, nameOverride: null }))
    })
}

export function StartProjectPage({ store, team, onBack, onDone }: { store: PresetStoreView; team: TeamPresetView | null; onBack: () => void; onDone: () => void }) {
    const { workspace } = useSession()
    const stepper = useStepper(STEPS.length)
    const [teamId, setTeamId] = useState<string | 'scratch' | null>(team?.id ?? (store.teams.length === 0 ? 'scratch' : null))
    const [roster, setRoster] = useState<RosterDraft[]>(() => (team ? rosterFromTeam(team, store.presets) : []))
    const [client, setClient] = useState('')
    const [project, setProject] = useState('')
    const [codeOverride, setCodeOverride] = useState<string | null>(null)
    const [spaceOverride, setSpaceOverride] = useState<string | null>(null)
    const [channelOverride, setChannelOverride] = useState<string | null>(null)
    const [createChannel, setCreateChannel] = useState(store.slackConnected)
    const [isPrivate, setIsPrivate] = useState(false)
    const [answers, setAnswers] = useState<Record<string, string>>({})
    const [hiring, setHiring] = useState(false)

    const presetOf = (presetId: string) => store.presets.find(candidate => candidate.id === presetId)
    const code = codeOverride ?? shortCodeOf(client)
    const spaceName = spaceOverride ?? spaceNameFor(code, project)
    const channelName = channelOverride ?? channelNameFor(code, project)

    const countsByPreset = new Map<string, number>()
    for (const entry of roster) countsByPreset.set(entry.presetId, (countsByPreset.get(entry.presetId) ?? 0) + 1)
    const seen = new Map<string, number>()
    const names = roster.map(entry => {
        const ordinal = (seen.get(entry.presetId) ?? 0) + 1
        seen.set(entry.presetId, ordinal)
        if (entry.nameOverride !== null) return entry.nameOverride
        const preset = presetOf(entry.presetId)
        return coworkerNameFor(code, project, preset?.role || preset?.name || '', ordinal, countsByPreset.get(entry.presetId) ?? 1)
    })

    const questions = roster
        .flatMap(entry => presetOf(entry.presetId)?.questions ?? [])
        .filter((question, index, all) => all.findIndex(other => other.question.trim().toLowerCase() === question.question.trim().toLowerCase()) === index)

    const pickTeam = (candidate: TeamPresetView | 'scratch') => {
        if (candidate === 'scratch') {
            setTeamId('scratch')
            return
        }
        setTeamId(candidate.id)
        setRoster(rosterFromTeam(candidate, store.presets))
    }

    const hire = async () => {
        setHiring(true)
        const result = await guarded(() =>
            hireTeamAction({
                spaceName,
                roster: roster.map((entry, index) => ({ presetId: entry.presetId, name: names[index], icon: entry.icon })),
                channel: createChannel && store.slackConnected ? { name: channelName, isPrivate } : null,
                answers: questions.map(question => ({ question: question.question, answer: answers[question.key] ?? '' })),
            })
        )
        setHiring(false)
        if (!result) return
        if (!result.ok) return toast.error(result.error)
        for (const miss of result.outcome.failed) toast.error(`${miss.name}: ${miss.error}`)
        for (const warning of result.outcome.warnings) toast.warning(warning)
        toast.success(`${result.outcome.agents.length} coworker${result.outcome.agents.length === 1 ? '' : 's'} hired into “${spaceName}”${result.outcome.channelId ? ` · #${channelName} created` : ''}`)
        if (workspace) void useBoardStore.getState().hydrate(workspace.id)
        onDone()
    }

    const nextDisabled = (stepper.index === 0 && roster.length === 0) || (stepper.index === 1 && !spaceName.trim())

    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex items-center gap-3 border-b px-3 py-2.5">
                <Button aria-label="Back to the store" variant="ghost" size="icon-sm" className="shrink-0" onClick={onBack}>
                    <ChevronLeftIcon className="size-4" />
                </Button>
                <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm font-medium">Start a project</span>
                    <span className="truncate text-[11px] text-muted-foreground">
                        Step {stepper.index + 1} of {STEPS.length} · {STEPS[stepper.index].title} — {STEPS[stepper.index].hint}
                    </span>
                </div>
            </div>
            <StepperBar count={STEPS.length} current={stepper.index} className="px-4 pt-3" />

            <StepTransition stepKey={stepper.index} direction={stepper.direction} className="flex min-h-0 flex-1 flex-col">
                <PanelScroller className="flex flex-col gap-5 p-4">
                    {stepper.index === 0 && (
                        <>
                            {store.teams.length > 0 && (
                                <div className="flex flex-col gap-2">
                                    <span className="text-sm font-medium text-muted-foreground">Start from a team</span>
                                    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                                        {store.teams.map(candidate => (
                                            <TeamPickCard key={candidate.id} team={candidate} presets={store.presets} selected={teamId === candidate.id} onPick={() => pickTeam(candidate)} />
                                        ))}
                                        <button
                                            type="button"
                                            aria-pressed={teamId === 'scratch'}
                                            className={`flex min-h-20 flex-col items-center justify-center gap-1 rounded-lg border border-dashed p-3 text-xs text-muted-foreground transition-colors hover:text-foreground ${teamId === 'scratch' ? 'border-foreground text-foreground' : ''}`}
                                            onClick={() => pickTeam('scratch')}
                                        >
                                            <span className="text-lg leading-none">+</span>
                                            Build from scratch
                                        </button>
                                    </div>
                                </div>
                            )}

                            <div className="flex flex-col gap-1.5">
                                <span className="text-sm font-medium text-muted-foreground">Roster</span>
                                {roster.length === 0 ? (
                                    <p className="rounded-md border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">Nobody yet — add coworkers from the store below.</p>
                                ) : (
                                    <div className="overflow-hidden rounded-md border">
                                        {roster.map((entry, index) => {
                                            const preset = presetOf(entry.presetId)
                                            return (
                                                <div key={index} className="flex items-center gap-2.5 border-b px-3 py-2 last:border-b-0">
                                                    <button
                                                        type="button"
                                                        aria-label="Change icon"
                                                        title="Change icon"
                                                        className="grid size-8 shrink-0 place-items-center rounded-md bg-muted text-base"
                                                        onClick={() => setRoster(roster.map((other, otherIndex) => (otherIndex === index ? { ...other, icon: nextPresetIcon(other.icon) } : other)))}
                                                    >
                                                        {presetGlyph(entry.icon)}
                                                    </button>
                                                    <div className="min-w-0 flex-1">
                                                        <div className="truncate text-sm">{preset?.name ?? 'Missing preset'}</div>
                                                        {preset?.role && <div className="truncate text-[11px] text-muted-foreground">{preset.role}</div>}
                                                    </div>
                                                    <Button size="xs" variant="ghost" className="text-muted-foreground" onClick={() => setRoster(roster.filter((_, otherIndex) => otherIndex !== index))}>
                                                        Remove
                                                    </Button>
                                                </div>
                                            )
                                        })}
                                    </div>
                                )}
                                <AddToRoster presets={store.presets} onAdd={preset => setRoster([...roster, { presetId: preset.id, icon: preset.icon || null, nameOverride: null }])} />
                                {teamId !== 'scratch' && teamId !== null && <p className="text-xs text-muted-foreground">The team pre-fills the roster; changing it here does not touch the saved team.</p>}
                            </div>
                        </>
                    )}

                    {stepper.index === 1 && (
                        <>
                            <div className="flex flex-col gap-3 sm:flex-row">
                                <Field label="Client" htmlFor="project-client" className="flex-[2]">
                                    <Input id="project-client" value={client} onChange={e => setClient(e.target.value)} placeholder="Miami Dade County" autoComplete="off" />
                                </Field>
                                <Field label="Short code" htmlFor="project-code" className="w-full sm:w-24">
                                    <Input id="project-code" value={code} onChange={e => setCodeOverride(e.target.value)} autoComplete="off" />
                                </Field>
                                <Field label="Project" htmlFor="project-name" className="flex-1">
                                    <Input id="project-name" value={project} onChange={e => setProject(e.target.value)} placeholder="Water Enforcement" autoComplete="off" />
                                </Field>
                            </div>
                            <Field label="Box name" htmlFor="project-space">
                                <Input id="project-space" value={spaceName} onChange={e => setSpaceOverride(e.target.value)} placeholder="MDC Water Enforcement Project" />
                            </Field>
                            <p className="text-xs text-muted-foreground">The client and project drive everything downstream: the Box, the channel name and each coworker's name. Each stays editable on its own.</p>
                        </>
                    )}

                    {stepper.index === 2 &&
                        (store.slackConnected ? (
                            <>
                                <Field label="Slack channel" htmlFor="project-channel">
                                    <div className="flex items-center gap-2">
                                        <Input id="project-channel" value={channelName} onChange={e => setChannelOverride(e.target.value)} placeholder="mdc-water-enforcement" disabled={!createChannel} />
                                        <Switch checked={createChannel} onCheckedChange={setCreateChannel} aria-label="Create a Slack channel" />
                                    </div>
                                </Field>
                                {createChannel && (
                                    <label className="flex items-center gap-2 text-xs text-muted-foreground">
                                        <Switch checked={isPrivate} onCheckedChange={setIsPrivate} aria-label="Private channel" />
                                        Private channel
                                    </label>
                                )}
                                <p className="text-xs text-muted-foreground">
                                    {createChannel
                                        ? `Everyone on the roster is bound to #${channelName || '…'} and introduces itself there.${isPrivate ? ' Private: you are invited automatically — set “Your Slack email” on the Slack page if your Slack uses another address.' : ''}`
                                        : 'No channel for this project. You can always wire one later from the Slack page under Chat apps.'}
                                </p>
                            </>
                        ) : (
                            <p className="text-xs text-muted-foreground">Slack is not connected, so the team is hired without a channel. Connect it under Chat apps and add them later.</p>
                        ))}

                    {stepper.index === 3 && (
                        <>
                            <div className="flex flex-col gap-1.5">
                                <span className="text-sm font-medium text-muted-foreground">Coworker names</span>
                                <div className="overflow-hidden rounded-md border">
                                    {roster.map((entry, index) => {
                                        const preset = presetOf(entry.presetId)
                                        return (
                                            <div key={index} className="flex items-center gap-2.5 border-b px-3 py-2 last:border-b-0">
                                                <span className="grid size-8 shrink-0 place-items-center rounded-md bg-muted text-base">{presetGlyph(entry.icon)}</span>
                                                <Input className="h-8 flex-1 font-mono text-xs" value={names[index]} onChange={e => setRoster(roster.map((other, otherIndex) => (otherIndex === index ? { ...other, nameOverride: e.target.value } : other)))} aria-label="Coworker name" />
                                                <span className="hidden w-32 truncate text-xs text-muted-foreground sm:block">{preset?.role || preset?.name}</span>
                                            </div>
                                        )
                                    })}
                                </div>
                            </div>

                            {questions.length > 0 && (
                                <div className="flex flex-col gap-3">
                                    <span className="text-sm font-medium text-muted-foreground">Project facts</span>
                                    {questions.map(question => (
                                        <Field key={question.key} label={question.question} htmlFor={`project-${question.key}`}>
                                            {question.multiline ? (
                                                <Textarea id={`project-${question.key}`} rows={2} value={answers[question.key] ?? ''} onChange={e => setAnswers({ ...answers, [question.key]: e.target.value })} />
                                            ) : (
                                                <Input id={`project-${question.key}`} value={answers[question.key] ?? ''} onChange={e => setAnswers({ ...answers, [question.key]: e.target.value })} />
                                            )}
                                        </Field>
                                    ))}
                                    <p className="-mt-1 text-xs text-muted-foreground">Answered once; every coworker of this hire gets it as memory. Left blank, they will ask in the channel.</p>
                                </div>
                            )}

                            <p className="border-t pt-3 text-xs text-muted-foreground">
                                Creates Box “{spaceName || '…'}” · hires {roster.length}
                                {createChannel && store.slackConnected && channelName ? ` · creates #${channelName}${isPrivate ? ' (private)' : ''} and invites everyone` : ''}
                            </p>
                        </>
                    )}
                </PanelScroller>
            </StepTransition>

            <div className="flex items-center justify-end gap-2 border-t px-4 py-3">
                <Button size="sm" variant="ghost" disabled={stepper.isFirst} onClick={stepper.back}>
                    Back
                </Button>
                {stepper.isLast ? (
                    <Button size="sm" disabled={!spaceName.trim() || roster.length === 0} loading={hiring} onClick={hire}>
                        Hire the team
                    </Button>
                ) : (
                    <Button size="sm" disabled={nextDisabled} onClick={stepper.goForward}>
                        Next
                    </Button>
                )}
            </div>
        </div>
    )
}

function TeamPickCard({ team, presets, selected, onPick }: { team: TeamPresetView; presets: CoworkerPresetView[]; selected: boolean; onPick: () => void }) {
    const seats = team.members.reduce((sum, member) => sum + member.count, 0)
    const summary = team.members
        .map(member => {
            const preset = presets.find(candidate => candidate.id === member.presetId)
            return `${member.count > 1 ? `${member.count} × ` : ''}${preset?.role || preset?.name || '?'}`
        })
        .join(' · ')
    const glyphs = team.members.flatMap(member => {
        const preset = presets.find(candidate => candidate.id === member.presetId)
        return Array.from({ length: member.count }, () => presetGlyph(preset?.icon ?? null))
    })

    return (
        <button type="button" aria-pressed={selected} className={`flex flex-col gap-1.5 rounded-lg border p-3 text-left transition-colors ${selected ? 'border-foreground' : 'hover:border-foreground/25'}`} onClick={onPick}>
            <span className="flex">
                {glyphs.slice(0, 5).map((glyph, index) => (
                    <span key={index} className={`grid size-7 place-items-center rounded-full border-2 border-background bg-muted text-sm ${index > 0 ? '-ml-2' : ''}`}>
                        {glyph}
                    </span>
                ))}
            </span>
            <span className="truncate text-sm font-medium">{team.name}</span>
            <span className="truncate text-[11px] text-muted-foreground">
                {seats} coworker{seats === 1 ? '' : 's'} · {summary}
            </span>
        </button>
    )
}

function AddToRoster({ presets, onAdd }: { presets: CoworkerPresetView[]; onAdd: (preset: CoworkerPresetView) => void }) {
    return (
        <Select value="" onValueChange={presetId => onAdd(presets.find(preset => preset.id === presetId) as CoworkerPresetView)}>
            <SelectTrigger className="h-8 w-fit gap-1.5 text-xs text-muted-foreground">
                <SelectValue placeholder="+ Add a coworker from the store" />
            </SelectTrigger>
            <SelectContent>
                {presets.map(preset => (
                    <SelectItem key={preset.id} value={preset.id}>
                        {presetGlyph(preset.icon)} {preset.name}
                        {preset.role ? ` — ${preset.role}` : ''}
                    </SelectItem>
                ))}
            </SelectContent>
        </Select>
    )
}
