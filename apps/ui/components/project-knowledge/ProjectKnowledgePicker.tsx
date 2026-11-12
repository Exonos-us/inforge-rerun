'use client'

import { linkProjectKnowledgeAction, listKnowledgeEngagementsAction, listKnowledgeSpacesAction } from '@/app/api/_actions/project-knowledge.actions'
import type { KnowledgeEngagementsResult, KnowledgeSpacesResult } from '@/app/api/_services/project-knowledge.service'
import { EmptyPitch, Group } from '@/components/connections/AiProvidersPanel'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { PanelEditorBody, PanelEditorHeader, PanelEditorShell } from '@/components/ui/panel-editor'
import { PanelRow } from '@/components/ui/panel-row'
import { SkeletonPanelRows } from '@/components/ui/skeleton'
import { PanelSteps } from '@/components/ui/panel-steps'
import { BookOpenIcon, ChevronRightIcon, Loader2Icon } from '@/lib/icons'
import { useWorkspaceSettingsStore } from '@/stores/workspace-settings.store'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'

// Pick a Confluence space, then the engagement inside it: the two-step heart of Project
// knowledge, shared by the New Box flow and the Box's own dialog. Only picking is done here;
// the link itself lands on the Box the caller names.

type PickerProps = {
    boxSpaceId: string
    title?: string
    onLinked: () => void
    onCancel: () => void
    cancelLabel?: string
}

function SpaceGlyph() {
    return (
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted">
            <BookOpenIcon className="size-4 text-muted-foreground" />
        </span>
    )
}

export function ProjectKnowledgePicker({ boxSpaceId, title = 'Pick a Confluence space', onLinked, onCancel, cancelLabel = 'Cancel' }: PickerProps) {
    const openWorkspacePanel = useWorkspaceSettingsStore(s => s.openWorkspacePanel)
    const [spaces, setSpaces] = useState<KnowledgeSpacesResult | null>(null)
    const [spaceSearch, setSpaceSearch] = useState('')
    const [picked, setPicked] = useState<{ key: string; name: string } | null>(null)
    const [engagements, setEngagements] = useState<KnowledgeEngagementsResult | null>(null)
    const [engagementSearch, setEngagementSearch] = useState('')
    const [linking, setLinking] = useState<string | null>(null)

    useEffect(() => {
        if (spaces) return
        let active = true
        listKnowledgeSpacesAction().then(result => {
            if (!active) return
            if (result.ok) setSpaces(result.result)
            else toast.error(result.error)
        })
        return () => {
            active = false
        }
    }, [spaces])

    const pickSpace = async (key: string, name: string) => {
        setPicked({ key, name })
        setEngagements(null)
        setEngagementSearch('')
        const result = await listKnowledgeEngagementsAction({ spaceKey: key })
        if (result.ok) setEngagements(result.result)
        else {
            toast.error(result.error)
            setPicked(null)
        }
    }

    const link = async (pageId: string | null, pageTitle: string | null) => {
        if (!picked) return
        setLinking(pageId ?? 'space')
        const result = await linkProjectKnowledgeAction({ spaceId: boxSpaceId, spaceKey: picked.key, pageId, pageTitle })
        setLinking(null)
        if (!result.ok) {
            toast.error(result.error)
            return
        }
        toast.success(`${pageTitle ?? picked.name} linked. Coworkers in this Box now read and feed those pages.`)
        for (const warning of result.warnings) toast.warning(warning)
        onLinked()
    }

    const spaceRows = spaces?.available ? spaces.spaces.filter(space => `${space.name} ${space.key}`.toLowerCase().includes(spaceSearch.trim().toLowerCase())) : []
    const engagementRows = engagements?.engagements.filter(engagement => engagement.title.toLowerCase().includes(engagementSearch.trim().toLowerCase())) ?? []

    return (
        <PanelSteps stepKey={picked ? `engagements-${picked.key}` : 'spaces'} depth={picked ? 1 : 0}>
            {!picked ? (
                <PanelEditorShell>
                    <PanelEditorHeader title={title} onBack={onCancel} />
                    <PanelEditorBody>
                        {spaces === null ? (
                            <SkeletonPanelRows rows={4} leading className="p-0" />
                        ) : !spaces.available ? (
                            <Group title="Confluence">
                                <EmptyPitch
                                    text={
                                        spaces.reason === 'no_connection'
                                            ? 'Connect Atlassian once in Global apps, and every project can point at the client space and engagement it is about.'
                                            : 'The workspace Atlassian account needs a reconnect in Global apps before spaces can be read.'
                                    }
                                    actions={
                                        <Button size="sm" onClick={() => openWorkspacePanel('global_apps')}>
                                            Open Global apps
                                        </Button>
                                    }
                                />
                            </Group>
                        ) : (
                            <div className="space-y-3">
                                <Input aria-label="Search spaces" placeholder="Search spaces" value={spaceSearch} className="h-8 text-sm" onChange={e => setSpaceSearch(e.target.value)} />
                                <div>
                                    {spaceRows.map(space => (
                                        <PanelRow
                                            key={space.key}
                                            onClick={() => void pickSpace(space.key, space.name)}
                                            leading={<SpaceGlyph />}
                                            title={space.name}
                                            description={space.client ? `Client space · ${space.key}` : space.key}
                                            actions={<ChevronRightIcon className="size-4 text-muted-foreground" />}
                                        />
                                    ))}
                                    {spaceRows.length === 0 && <p className="py-6 text-center text-xs text-muted-foreground">No space matches.</p>}
                                </div>
                            </div>
                        )}
                    </PanelEditorBody>
                    <div className="flex justify-end border-t px-4 py-3">
                        <Button size="sm" variant="ghost" onClick={onCancel}>
                            {cancelLabel}
                        </Button>
                    </div>
                </PanelEditorShell>
            ) : (
                <PanelEditorShell>
                    <PanelEditorHeader title={picked.name} onBack={() => setPicked(null)} />
                    <PanelEditorBody>
                        {engagements === null ? (
                            <SkeletonPanelRows rows={3} className="p-0" />
                        ) : (
                            <div className="space-y-3">
                                <p className="text-xs text-muted-foreground">{engagements.fallback ? 'This space has no engagements page, so pick the page tree this project is about.' : 'Pick the engagement this project is about. Coworkers read its pages before working and write back to them.'}</p>
                                <Input aria-label="Search engagements" placeholder="Search engagements" value={engagementSearch} className="h-8 text-sm" onChange={e => setEngagementSearch(e.target.value)} />
                                <div>
                                    {engagementRows.map(engagement => (
                                        <PanelRow
                                            key={engagement.id}
                                            onClick={() => void link(engagement.id, engagement.title)}
                                            title={engagement.title}
                                            description={`${engagement.pageCount} page${engagement.pageCount === 1 ? '' : 's'}`}
                                            actions={linking === engagement.id ? <Loader2Icon className="size-3.5 animate-spin" /> : <ChevronRightIcon className="size-4 text-muted-foreground" />}
                                        />
                                    ))}
                                    {engagementRows.length === 0 && <p className="py-6 text-center text-xs text-muted-foreground">No engagement matches.</p>}
                                    <PanelRow
                                        onClick={() => void link(null, null)}
                                        className="border-dashed"
                                        title={<span className="text-muted-foreground">The whole space</span>}
                                        description={`No single engagement; coworkers see everything in ${picked.name}.`}
                                        actions={linking === 'space' ? <Loader2Icon className="size-3.5 animate-spin" /> : undefined}
                                    />
                                </div>
                            </div>
                        )}
                    </PanelEditorBody>
                </PanelEditorShell>
            )}
        </PanelSteps>
    )
}
