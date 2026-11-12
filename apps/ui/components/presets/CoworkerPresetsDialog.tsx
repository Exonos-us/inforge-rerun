'use client'

import { getPresetStoreAction, type PresetStoreView } from '@/app/api/_actions/preset.actions'
import { PanelDialogContent } from '@/components/dialogs/PanelDialogContent'
import { Button } from '@/components/ui/button'
import { Dialog, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { PanelSteps } from '@/components/ui/panel-steps'
import { StoreIcon } from '@/lib/icons'
import { useWorkspaceSettingsStore } from '@/stores/workspace-settings.store'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'

import { PresetDetailPage } from './PresetDetailPage'
import { PresetStoreList } from './PresetStoreList'
import { SaveCoworkerPage } from './SaveCoworkerPage'
import { StartProjectPage } from './StartProjectPage'
import { TeamPresetFormPage } from './TeamPresetFormPage'

// The Coworkers Store: saved coworker definitions as cards, the teams made of them, and the two
// ways out — one hire from a coworker's page, or a whole project from the wizard.
type Page = { kind: 'list' } | { kind: 'detail'; presetId: string } | { kind: 'project'; teamId: string | null } | { kind: 'team-form'; teamId: string | null } | { kind: 'save-coworker' }

export function CoworkerPresetsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
    const [page, setPage] = useState<Page>({ kind: 'list' })
    const [store, setStore] = useState<PresetStoreView | null>(null)
    const focus = useWorkspaceSettingsStore(s => s.focus)
    const clearFocus = useWorkspaceSettingsStore(s => s.clearFocus)

    const load = useCallback(async () => {
        const result = await getPresetStoreAction().catch(() => null)
        if (!result) {
            toast.error('The store did not load. Reload the page and try again.')
            return
        }
        if (result.ok) setStore(result.state)
        else toast.error(result.error)
    }, [])

    useEffect(() => {
        if (!open) return
        // The board's "Start a project" button lands straight on the wizard; the menu entry on the front page.
        setPage(focus?.page === 'start_project' ? { kind: 'project', teamId: null } : { kind: 'list' })
        if (focus?.page) clearFocus()
        void load()
        // eslint-disable-next-line react-hooks/exhaustive-deps -- focus is read once at open, not re-acted on
    }, [open, load])

    const toList = () => setPage({ kind: 'list' })
    const close = () => onOpenChange(false)
    const preset = page.kind === 'detail' ? (store?.presets.find(candidate => candidate.id === page.presetId) ?? null) : null
    const team = page.kind === 'project' || page.kind === 'team-form' ? (store?.teams.find(candidate => candidate.id === page.teamId) ?? null) : null

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <PanelDialogContent className="sm:h-[min(52rem,88dvh)] sm:max-w-5xl">
                <DialogHeader className="border-b px-4 py-4">
                    <div className="flex flex-wrap items-center gap-3">
                        <span className="grid size-9 shrink-0 place-items-center rounded-md bg-muted">
                            <StoreIcon className="size-4.5 text-muted-foreground" />
                        </span>
                        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                            <DialogTitle>Coworkers Store</DialogTitle>
                            <DialogDescription>Definitions you hire again and again — alone, or as a whole project with its Box and channel.</DialogDescription>
                        </div>
                        {page.kind === 'list' && store && store.presets.length > 0 && (
                            <Button size="sm" className="mr-6" onClick={() => setPage({ kind: 'project', teamId: null })}>
                                Start a project
                            </Button>
                        )}
                    </div>
                </DialogHeader>

                <div className="flex min-h-0 flex-1 flex-col">
                    <PanelSteps stepKey={pageKey(page)} depth={page.kind === 'list' ? 0 : 1}>
                        {page.kind === 'detail' && preset ? (
                            <PresetDetailPage preset={preset} onBack={toList} reload={load} onHired={close} />
                        ) : page.kind === 'project' && store ? (
                            <StartProjectPage key={page.teamId ?? 'blank'} store={store} team={team} onBack={toList} onDone={close} />
                        ) : page.kind === 'team-form' && store ? (
                            <TeamPresetFormPage store={store} team={team} onBack={toList} reload={load} />
                        ) : page.kind === 'save-coworker' ? (
                            <SaveCoworkerPage store={store} onBack={toList} onCreated={presetId => setPage({ kind: 'detail', presetId })} reload={load} />
                        ) : (
                            <PresetStoreList
                                store={store}
                                onOpenPreset={presetId => setPage({ kind: 'detail', presetId })}
                                onHireTeam={teamId => setPage({ kind: 'project', teamId })}
                                onEditTeam={teamId => setPage({ kind: 'team-form', teamId })}
                                onNewTeam={() => setPage({ kind: 'team-form', teamId: null })}
                                onNewCoworker={() => setPage({ kind: 'save-coworker' })}
                            />
                        )}
                    </PanelSteps>
                </div>
            </PanelDialogContent>
        </Dialog>
    )
}

function pageKey(page: Page): string {
    if (page.kind === 'detail') return `detail-${page.presetId}`
    if (page.kind === 'project') return `project-${page.teamId ?? 'blank'}`
    if (page.kind === 'team-form') return `team-${page.teamId ?? 'new'}`
    if (page.kind === 'save-coworker') return 'save-coworker'
    return 'list'
}
