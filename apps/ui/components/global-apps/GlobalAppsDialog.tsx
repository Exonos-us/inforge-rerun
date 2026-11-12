'use client'

import { getGlobalAppsAction } from '@/app/api/_actions/global-apps.actions'
import { PanelDialogContent } from '@/components/dialogs/PanelDialogContent'
import { Dialog, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { PanelSteps } from '@/components/ui/panel-steps'
import type { GlobalAppConnection } from '@/lib/services/types'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'

import { GlobalAppConnectForm } from './GlobalAppConnectForm'
import { GlobalAppConnectPage } from './GlobalAppConnectPage'
import { GlobalAppDetailPage } from './GlobalAppDetailPage'
import { GlobalAppsList } from './GlobalAppsList'

// Global apps: the workspace's shared accounts. One sign-in or pasted credential per account,
// then a switch per coworker. The coworker-level accounts stay on each coworker's Apps tab.
type Page = { kind: 'list' } | { kind: 'detail'; connectionId: string } | { kind: 'connect' } | { kind: 'connect-form'; slug: string }

export function GlobalAppsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
    const [page, setPage] = useState<Page>({ kind: 'list' })
    const [connections, setConnections] = useState<GlobalAppConnection[] | null>(null)

    const load = useCallback(async () => {
        const result = await getGlobalAppsAction().catch(() => null)
        if (!result) {
            toast.error('Global apps did not load. Reload the page and try again.')
            return
        }
        if (result.ok) setConnections(result.connections)
        else toast.error(result.error)
    }, [])

    useEffect(() => {
        if (!open) return
        setPage({ kind: 'list' })
        void load()
    }, [open, load])

    const toList = () => setPage({ kind: 'list' })
    const connection = page.kind === 'detail' ? (connections?.find(candidate => candidate.id === page.connectionId) ?? null) : null

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <PanelDialogContent className="sm:h-[min(48rem,90dvh)] sm:max-w-2xl">
                <DialogHeader className="border-b px-4 py-4">
                    <DialogTitle>Global apps</DialogTitle>
                    <DialogDescription>Apps connected once for the workspace, then enabled per coworker. No second sign-in.</DialogDescription>
                </DialogHeader>

                <div className="flex min-h-0 flex-1 flex-col">
                    <PanelSteps stepKey={pageKey(page)} depth={page.kind === 'list' ? 0 : page.kind === 'connect-form' ? 2 : 1}>
                        {page.kind === 'detail' && connection ? (
                            <GlobalAppDetailPage connection={connection} onBack={toList} reload={load} onDeleted={toList} />
                        ) : page.kind === 'connect' ? (
                            <GlobalAppConnectPage onBack={toList} onPick={slug => setPage({ kind: 'connect-form', slug })} />
                        ) : page.kind === 'connect-form' ? (
                            <GlobalAppConnectForm
                                slug={page.slug}
                                onBack={() => setPage({ kind: 'connect' })}
                                onConnected={async connectionId => {
                                    await load()
                                    setPage({ kind: 'detail', connectionId })
                                }}
                            />
                        ) : (
                            <GlobalAppsList connections={connections} onOpen={connectionId => setPage({ kind: 'detail', connectionId })} onConnect={() => setPage({ kind: 'connect' })} />
                        )}
                    </PanelSteps>
                </div>
            </PanelDialogContent>
        </Dialog>
    )
}

function pageKey(page: Page): string {
    if (page.kind === 'detail') return `detail-${page.connectionId}`
    if (page.kind === 'connect') return 'connect'
    if (page.kind === 'connect-form') return `connect-${page.slug}`
    return 'list'
}
