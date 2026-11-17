'use client'

import { setBoxClientAction, type ClientListEntry } from '@/app/api/_actions/client.actions'
import { BoxClientSyncReport, type BoxClientChange } from '@/components/clients/BoxClientSyncReport'
import { ClientShortCode, ClientStatusBadge, clientSummaryLine, plural } from '@/components/clients/ClientCells'
import { Group } from '@/components/connections/AiProvidersPanel'
import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog'
import { PanelDialogContent } from '@/components/dialogs/PanelDialogContent'
import { Button } from '@/components/ui/button'
import { Dialog, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { PanelScroller } from '@/components/ui/panel-list'
import { PanelRow } from '@/components/ui/panel-row'
import { SkeletonPanelRows } from '@/components/ui/skeleton'
import { TooltipDisabledReason } from '@/components/ui/tooltip'
import { useCanManageSpace } from '@/hooks/useBoxAccess'
import { clientOfBox } from '@/hooks/useBoxClients'
import { BOX_MANAGE_ACTION_REASON } from '@/lib/board/box-access'
import { UNNAMED_BOX_LABEL } from '@/lib/board/types'
import { Building2, SearchIcon } from '@/lib/icons'
import { EmptyState } from '@rerun/ui/primitives'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'

// What this Box works to. Picking a client here is not a label: it installs that client’s skills and
// documents on every coworker standing in the Box, and takes the previous client’s off. So the pick
// asks first, and what comes back is reported per coworker rather than as a flat success.

type BoxClientDialogProps = {
    spaceId: string | null
    boxName?: string | null
    coworkers: number
    clients: ClientListEntry[] | null
    open: boolean
    onOpenChange: (open: boolean) => void
    onChanged: () => Promise<void>
}

// `null` as the next client is the unlink: the Box keeps its coworkers, they lose the client’s part.
type PendingPick = { next: ClientListEntry | null }

function carries(client: ClientListEntry): string {
    const skills = client.skills.length
    const docs = client.knowledgeDocs.length
    if (!skills && !docs) return 'no skill and no document yet'
    if (!docs) return plural(skills, 'skill')
    if (!skills) return plural(docs, 'document')
    return `${plural(skills, 'skill')} and ${plural(docs, 'document')}`
}

function confirmCopy(pick: PendingPick, current: ClientListEntry | null, coworkers: number, boxLabel: string): { title: string; description: string; confirmLabel: string; destructive: boolean } {
    const roster = plural(coworkers, 'coworker')
    if (!pick.next) {
        return {
            title: `Remove ${current?.name ?? 'this client'} from ${roster}?`,
            description: `${current?.name ?? 'The client'}’s skills and documents come off every coworker in ${boxLabel}. Their own skills and instructions stay, and the client itself is not deleted.`,
            confirmLabel: 'Remove',
            destructive: true,
        }
    }
    if (current) {
        return {
            title: `Replace ${current.name} with ${pick.next.name} on ${roster}?`,
            description: `Every coworker in ${boxLabel} loses ${current.name}’s skills and documents and gets ${pick.next.name}’s (${carries(pick.next)}). Their own skills and instructions are untouched.`,
            confirmLabel: 'Replace',
            destructive: false,
        }
    }
    return {
        title: `Install ${pick.next.name} on ${roster}?`,
        description: `Every coworker in ${boxLabel} gets ${pick.next.name}’s ${carries(pick.next)}. Their own skills and instructions are untouched.`,
        confirmLabel: 'Install',
        destructive: false,
    }
}

export function BoxClientDialog({ spaceId, boxName, coworkers, clients, open, onOpenChange, onChanged }: BoxClientDialogProps) {
    const [query, setQuery] = useState('')
    const [pick, setPick] = useState<PendingPick | null>(null)
    const [saving, setSaving] = useState(false)
    const [change, setChange] = useState<BoxClientChange | null>(null)
    const canManage = useCanManageSpace(spaceId ?? undefined)

    useEffect(() => {
        if (!open) return
        setQuery('')
        setPick(null)
        setChange(null)
    }, [open, spaceId])

    if (!spaceId) return null

    const boxLabel = boxName?.trim() || UNNAMED_BOX_LABEL
    const current = clientOfBox(clients, spaceId)
    const manageReason = canManage ? undefined : BOX_MANAGE_ACTION_REASON

    const needle = query.trim().toLowerCase()
    const others = (clients ?? []).filter(client => client.id !== current?.id && (!needle || `${client.name} ${client.shortCode}`.toLowerCase().includes(needle)))

    const apply = async (next: ClientListEntry | null) => {
        setSaving(true)
        const previous = current
        const result = await setBoxClientAction({ spaceId, clientId: next?.id ?? null }).catch(() => null)
        setSaving(false)
        setPick(null)
        if (!result) return toast.error('Could not change the client of this Box')
        if (!result.ok) return toast.error(result.error)
        setChange({ previous: previous?.name ?? null, next: next?.name ?? null, result: result.result })
        await onChanged()
    }

    // A Box nobody stands in has nothing to overwrite, so the confirm would name a count of zero.
    const request = (next: ClientListEntry | null) => (coworkers > 0 ? setPick({ next }) : void apply(next))

    const copy = pick ? confirmCopy(pick, current, coworkers, boxLabel) : null
    const hint = current
        ? `Every coworker placed in ${boxLabel} starts with ${current.name}’s skills and documents, and keeps them while it stands here.`
        : coworkers > 0
          ? `A client carries the skills and documents every coworker on its engagement starts with. Pick one and the ${plural(coworkers, 'coworker')} in ${boxLabel} get them.`
          : `A client carries the skills and documents every coworker on its engagement starts with. The next coworker placed in ${boxLabel} would start with them.`

    return (
        <>
            <Dialog open={open} onOpenChange={onOpenChange}>
                <PanelDialogContent className="sm:h-[min(34rem,88dvh)] sm:max-w-lg">
                    <DialogHeader className="border-b px-4 py-4">
                        <div className="flex items-center gap-3">
                            <span className="grid size-9 shrink-0 place-items-center rounded-md bg-muted">
                                <Building2 className="size-4.5 text-muted-foreground" />
                            </span>
                            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                                <DialogTitle>Client</DialogTitle>
                                <DialogDescription className="line-clamp-2">Who {boxLabel} works for, and the way they like things done.</DialogDescription>
                            </div>
                        </div>
                    </DialogHeader>

                    {(clients === null || clients.length > 0) && (
                        <div className="border-b border-border px-3 py-2">
                            <div className="relative">
                                <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
                                <Input aria-label="Search clients" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search clients" className="h-8 pl-8 text-xs" />
                            </div>
                        </div>
                    )}

                    {clients === null ? (
                        <PanelScroller className="p-0">
                            <SkeletonPanelRows rows={4} badge />
                        </PanelScroller>
                    ) : clients.length === 0 ? (
                        <EmptyState icon={Building2} title="No client yet" description="Clients are created in Settings, under Clients. Make one there and this Box can point at it." />
                    ) : (
                        <PanelScroller className="space-y-5 p-4">
                            {change && <BoxClientSyncReport change={change} />}
                            {current && (
                                <Group title="Client of this Box">
                                    <PanelRow
                                        leading={
                                            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted">
                                                <Building2 className="size-4 text-muted-foreground" />
                                            </span>
                                        }
                                        title={
                                            <span className="flex min-w-0 items-center gap-1.5">
                                                <span className="truncate">{current.name}</span>
                                                <ClientShortCode code={current.shortCode} />
                                            </span>
                                        }
                                        description={clientSummaryLine(current)}
                                        meta={<ClientStatusBadge coworkers={current.coworkers} pending={current.pending} />}
                                    />
                                </Group>
                            )}
                            <Group title={current ? 'Change to' : 'Clients'}>
                                {others.length === 0 ? (
                                    <p className="py-4 text-center text-xs text-muted-foreground">{needle ? `No other client matches “${query.trim()}”.` : 'No other client yet.'}</p>
                                ) : (
                                    others.map(client => (
                                        <PanelRow
                                            key={client.id}
                                            onClick={() => request(client)}
                                            disabled={!canManage || saving}
                                            title={
                                                <span className="flex min-w-0 items-center gap-1.5">
                                                    <span className="truncate">{client.name}</span>
                                                    <ClientShortCode code={client.shortCode} />
                                                </span>
                                            }
                                            description={clientSummaryLine(client)}
                                        />
                                    ))
                                )}
                            </Group>
                            <p className="text-xs text-muted-foreground">{hint}</p>
                        </PanelScroller>
                    )}

                    {current && (
                        <div className="flex flex-wrap items-center justify-end gap-2 border-t px-4 py-3">
                            <TooltipDisabledReason reason={manageReason}>
                                <Button size="sm" variant="ghost" disabled={!canManage || saving} className="text-destructive" onClick={() => request(null)}>
                                    Unlink
                                </Button>
                            </TooltipDisabledReason>
                        </div>
                    )}
                </PanelDialogContent>
            </Dialog>

            {copy && (
                <ConfirmDialog
                    open
                    onOpenChange={next => {
                        if (!next) setPick(null)
                    }}
                    title={copy.title}
                    description={copy.description}
                    confirmLabel={copy.confirmLabel}
                    confirmVariant={copy.destructive ? 'destructive' : 'default'}
                    pending={saving}
                    onConfirm={event => {
                        event.preventDefault()
                        void apply(pick?.next ?? null)
                    }}
                />
            )}
        </>
    )
}
