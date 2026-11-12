'use client'

import { AddButton, EmptyPitch, Group } from '@/components/connections/AiProvidersPanel'
import { Icon } from '@/components/ui/icon'
import { PanelScroller } from '@/components/ui/panel-list'
import { PanelRow } from '@/components/ui/panel-row'
import { SkeletonPanelRows } from '@/components/ui/skeleton'
import { serviceIconProps } from '@/lib/services/icons'
import type { GlobalAppConnection, GlobalAppStatus } from '@/lib/services/types'
import { ChevronRightIcon } from '@/lib/icons'
import { Badge } from '@rerun/ui/primitives'

const KIND_LABELS: Record<GlobalAppConnection['kind'], string> = {
    key: 'Pasted credential',
    composio: 'Signed in through Rerun',
    oauth: 'Signed in once for the workspace',
}

export function GlobalAppStatusBadge({ status }: { status: GlobalAppStatus }) {
    if (status === 'connected') {
        return (
            <Badge size="xs" tone="green" glow={false}>
                Connected
            </Badge>
        )
    }
    if (status === 'needs_reconnect') {
        return (
            <Badge size="xs" tone="orange" glow={false}>
                Needs reconnect
            </Badge>
        )
    }
    return (
        <Badge size="xs" tone="neutral" glow={false}>
            Connecting
        </Badge>
    )
}

function usedByLine(connection: GlobalAppConnection): string {
    const base = KIND_LABELS[connection.kind]
    const count = connection.agentIds.length
    if (count === 0) return `${base} · not enabled for any coworker yet`
    return `${base} · used by ${count} coworker${count === 1 ? '' : 's'}`
}

export function GlobalAppsList({ connections, onOpen, onConnect }: { connections: GlobalAppConnection[] | null; onOpen: (connectionId: string) => void; onConnect: () => void }) {
    return (
        <PanelScroller className="space-y-6 p-4">
            <Group title="Workspace accounts" addMenu={connections?.length ? <AddButton label="Connect an app" onClick={onConnect} /> : undefined}>
                {connections === null ? (
                    <SkeletonPanelRows rows={3} leading className="p-0" />
                ) : connections.length === 0 ? (
                    <EmptyPitch text="Connect an app once for the workspace, then flip it on per coworker. Nobody signs in twice, and rotating a credential happens in one place." actions={<AddButton label="Connect an app" onClick={onConnect} />} />
                ) : (
                    connections.map(connection => (
                        <PanelRow
                            key={connection.id}
                            onClick={() => onOpen(connection.id)}
                            leading={<Icon {...serviceIconProps(connection.icon, connection.category)} size="sm" />}
                            title={
                                <span className="flex min-w-0 items-center gap-1.5">
                                    <span className="truncate">{connection.name}</span>
                                    <Badge size="xs" tone="neutral" glow={false}>
                                        {connection.label}
                                    </Badge>
                                </span>
                            }
                            description={usedByLine(connection)}
                            actions={
                                <>
                                    <GlobalAppStatusBadge status={connection.status} />
                                    <ChevronRightIcon className="size-4 text-muted-foreground" />
                                </>
                            }
                        />
                    ))
                )}
            </Group>
            <p className="text-xs text-muted-foreground">Coworkers can still sign in with accounts of their own. Those stay on each coworker, in its Apps tab.</p>
        </PanelScroller>
    )
}
