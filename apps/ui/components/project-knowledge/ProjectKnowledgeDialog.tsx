'use client'

import { enableGlobalAppAction } from '@/app/api/_actions/global-apps.actions'
import { getProjectKnowledgeAction, unlinkProjectKnowledgeAction } from '@/app/api/_actions/project-knowledge.actions'
import type { ProjectKnowledgeView } from '@/app/api/_services/project-knowledge.service'
import { EmptyPitch, Group } from '@/components/connections/AiProvidersPanel'
import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog'
import { PanelDialogContent } from '@/components/dialogs/PanelDialogContent'
import { ProjectKnowledgePicker } from '@/components/project-knowledge/ProjectKnowledgePicker'
import { Button } from '@/components/ui/button'
import { Dialog, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { PanelRow } from '@/components/ui/panel-row'
import { PanelScroller } from '@/components/ui/panel-list'
import { PanelSteps } from '@/components/ui/panel-steps'
import { SkeletonPanelRows } from '@/components/ui/skeleton'
import { useCanManageSpace } from '@/hooks/useBoxAccess'
import { BOX_MANAGE_ACTION_REASON } from '@/lib/board/box-access'
import { BookOpenIcon, ExternalLinkIcon, Loader2Icon } from '@/lib/icons'
import { TooltipDisabledReason } from '@/components/ui/tooltip'
import { Badge } from '@rerun/ui/primitives'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'

// The Box's Project knowledge page: which Confluence engagement this project is about, who in the
// Box reaches it, and the way out (change, unlink). The knowledge itself never leaves Confluence.

function engagementUrl(view: ProjectKnowledgeView): string {
    return view.pageId ? `${view.siteUrl}/wiki/spaces/${view.spaceKey}/pages/${view.pageId}` : `${view.siteUrl}/wiki/spaces/${view.spaceKey}`
}

function StatusBadge({ status }: { status: ProjectKnowledgeView['status'] }) {
    if (status === 'needs_reconnect') {
        return (
            <Badge size="xs" tone="orange" glow={false}>
                Needs reconnect
            </Badge>
        )
    }
    if (status === 'missing') {
        return (
            <Badge size="xs" tone="orange" glow={false}>
                Missing
            </Badge>
        )
    }
    return (
        <Badge size="xs" tone="green" glow={false}>
            Linked
        </Badge>
    )
}

const ATLASSIAN_LINE: Record<ProjectKnowledgeView['agents'][number]['atlassian'], string> = {
    global: 'Atlassian via the workspace account',
    own: 'Atlassian with its own account',
    none: 'No Atlassian access yet',
}

export function ProjectKnowledgeDialog({ spaceId, boxName, open, onOpenChange }: { spaceId: string | null; boxName?: string | null; open: boolean; onOpenChange: (open: boolean) => void }) {
    const [knowledge, setKnowledge] = useState<ProjectKnowledgeView | null>(null)
    const [loaded, setLoaded] = useState(false)
    const [picking, setPicking] = useState(false)
    const [unlinking, setUnlinking] = useState(false)
    const [enabling, setEnabling] = useState<string | null>(null)
    const canManage = useCanManageSpace(spaceId ?? undefined)

    const load = useCallback(async () => {
        if (!spaceId) return
        const result = await getProjectKnowledgeAction({ spaceId })
        if (result.ok) {
            setKnowledge(result.knowledge)
            setLoaded(true)
            if (!result.knowledge) setPicking(true)
        } else toast.error(result.error)
    }, [spaceId])

    useEffect(() => {
        if (!open) return
        setKnowledge(null)
        setLoaded(false)
        setPicking(false)
        void load()
    }, [open, load])

    const unlink = async () => {
        if (!spaceId) return
        setUnlinking(true)
        const result = await unlinkProjectKnowledgeAction({ spaceId })
        setUnlinking(false)
        if (!result.ok) {
            toast.error(result.error)
            return
        }
        toast.success('Unlinked. Nothing changed in Confluence.')
        onOpenChange(false)
    }

    const enable = async (agentId: string) => {
        if (!knowledge?.connectionId) return
        setEnabling(agentId)
        const result = await enableGlobalAppAction({ connectionId: knowledge.connectionId, agentId })
        setEnabling(null)
        if (!result.ok) {
            toast.error(result.error)
            return
        }
        await load()
    }

    if (!spaceId) return null

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <PanelDialogContent className="sm:h-[min(40rem,90dvh)] sm:max-w-xl">
                <DialogHeader className="border-b px-4 py-4">
                    <DialogTitle>Project knowledge</DialogTitle>
                    <DialogDescription>{boxName ? `Where ${boxName} reads and writes its project pages.` : 'Where this Box reads and writes its project pages.'}</DialogDescription>
                </DialogHeader>
                <div className="flex min-h-0 flex-1 flex-col">
                    <PanelSteps stepKey={picking ? 'pick' : 'view'} depth={picking ? 1 : 0}>
                        {picking ? (
                            <ProjectKnowledgePicker
                                boxSpaceId={spaceId}
                                title={knowledge ? 'Change engagement' : 'Pick a Confluence space'}
                                onLinked={() => {
                                    setPicking(false)
                                    void load()
                                }}
                                onCancel={() => (knowledge ? setPicking(false) : onOpenChange(false))}
                                cancelLabel={knowledge ? 'Back' : 'Cancel'}
                            />
                        ) : !loaded ? (
                            <PanelScroller className="p-4">
                                <SkeletonPanelRows rows={3} leading className="p-0" />
                            </PanelScroller>
                        ) : !knowledge ? (
                            <PanelScroller className="p-4">
                                <Group title="Confluence">
                                    <EmptyPitch
                                        text="Point this project at the client space and engagement it is about. Coworkers read those pages before working and write back to them."
                                        actions={
                                            <Button size="sm" onClick={() => setPicking(true)}>
                                                Link an engagement
                                            </Button>
                                        }
                                    />
                                </Group>
                            </PanelScroller>
                        ) : (
                            <>
                                <PanelScroller className="space-y-6 p-4">
                                    <Group title="Engagement">
                                        <PanelRow
                                            leading={
                                                <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted">
                                                    <BookOpenIcon className="size-4 text-muted-foreground" />
                                                </span>
                                            }
                                            title={
                                                <span className="flex min-w-0 items-center gap-1.5">
                                                    <span className="truncate">{knowledge.pageTitle ?? knowledge.spaceName}</span>
                                                    <StatusBadge status={knowledge.status} />
                                                </span>
                                            }
                                            description={knowledge.pageTitle ? `${knowledge.spaceName} · ${knowledge.pageCount} page${knowledge.pageCount === 1 ? '' : 's'}` : `The whole space · ${knowledge.pageCount} page${knowledge.pageCount === 1 ? '' : 's'}`}
                                            actions={
                                                <Button size="sm" variant="outline" onClick={() => window.open(engagementUrl(knowledge), '_blank', 'noopener')}>
                                                    <ExternalLinkIcon className="mr-1.5 size-3.5" />
                                                    Open in Confluence
                                                </Button>
                                            }
                                        />
                                        {knowledge.status === 'needs_reconnect' && <p className="mt-2 text-xs text-muted-foreground">The workspace Atlassian account lost access. Reconnect it in Global apps; the link is kept.</p>}
                                        {knowledge.status === 'missing' && <p className="mt-2 text-xs text-muted-foreground">The engagement page is gone from Confluence. Pick another one with Change engagement.</p>}
                                    </Group>
                                    <Group title="Coworkers in this Box">
                                        {knowledge.agents.length === 0 ? (
                                            <p className="py-4 text-center text-xs text-muted-foreground">No coworker lives here yet. The ones you place in this Box will carry the engagement in their context.</p>
                                        ) : (
                                            knowledge.agents.map(agent => (
                                                <PanelRow
                                                    key={agent.id}
                                                    title={agent.name}
                                                    description={ATLASSIAN_LINE[agent.atlassian]}
                                                    actions={
                                                        agent.atlassian === 'none' && knowledge.connectionId ? (
                                                            <Button size="sm" variant="outline" disabled={enabling === agent.id} onClick={() => void enable(agent.id)}>
                                                                {enabling === agent.id ? <Loader2Icon className="size-3.5 animate-spin" /> : 'Enable Atlassian'}
                                                            </Button>
                                                        ) : (
                                                            <Badge size="xs" tone={agent.atlassian === 'none' ? 'neutral' : 'green'} glow={false}>
                                                                {agent.atlassian === 'none' ? 'No access' : 'Ready'}
                                                            </Badge>
                                                        )
                                                    }
                                                />
                                            ))
                                        )}
                                    </Group>
                                    <p className="text-xs text-muted-foreground">Coworkers read these pages before working and write decisions, meeting preps and open questions back. The pages stay in Confluence; unlinking changes nothing there.</p>
                                </PanelScroller>
                                <div className="flex items-center justify-end gap-2 border-t px-4 py-3">
                                    <TooltipDisabledReason reason={canManage ? undefined : BOX_MANAGE_ACTION_REASON}>
                                        <ConfirmDialog title={`Unlink ${knowledge.pageTitle ?? knowledge.spaceName}?`} description="Coworkers in this Box stop carrying it in their context. Nothing changes in Confluence." confirmLabel="Unlink" pending={unlinking} onConfirm={unlink}>
                                            <Button size="sm" variant="ghost" disabled={!canManage} className="text-destructive">
                                                Unlink
                                            </Button>
                                        </ConfirmDialog>
                                    </TooltipDisabledReason>
                                    <TooltipDisabledReason reason={canManage ? undefined : BOX_MANAGE_ACTION_REASON}>
                                        <Button size="sm" variant="outline" disabled={!canManage} onClick={() => setPicking(true)}>
                                            Change engagement
                                        </Button>
                                    </TooltipDisabledReason>
                                </div>
                            </>
                        )}
                    </PanelSteps>
                </div>
            </PanelDialogContent>
        </Dialog>
    )
}
