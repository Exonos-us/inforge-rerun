'use client'

import { disconnectSlackAction, getSlackStateAction, type SlackStateView } from '@/app/api/_actions/slack.actions'
import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog'
import { Button } from '@/components/ui/button'
import { Icon } from '@/components/ui/icon'
import { PanelScroller } from '@/components/ui/panel-list'
import { Skeleton } from '@/components/ui/skeleton'
import { invalidateChatAppsSummary } from '@/hooks/useChatAppsSummary'
import { ChevronLeftIcon } from '@/lib/icons'
import { serviceIconProps } from '@/lib/services/icons'
import { useIsWorkspaceAdmin } from '@/supabase/session/SessionProvider'
import { Badge } from '@rerun/ui/primitives'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'

import { SlackChannelsSection } from './SlackChannelsSection'
import { SlackIdentitySection } from './SlackIdentitySection'
import { SlackConnectionChecks } from './SlackConnectionChecks'
import { SlackConnectSteps } from './SlackConnectSteps'

// The Slack page of the Chat apps dialog: what state the connection is in, then which coworker
// answers in which channel. It loads its own state, so the hub never waits on the Slack API.
export function SlackSettingsPage({ icon, onBack }: { icon: string | null; onBack: () => void }) {
    const isAdmin = useIsWorkspaceAdmin()
    const [state, setState] = useState<SlackStateView | null>(null)

    const load = useCallback(async () => {
        const result = await getSlackStateAction()
        if (result.ok) {
            setState(result.state)
            invalidateChatAppsSummary()
        } else toast.error(result.error)
    }, [])

    useEffect(() => {
        void load()
    }, [load])

    return (
        <>
            <div className="flex items-center gap-3 border-b px-3 py-2.5">
                <Button aria-label="Back to chat apps" variant="ghost" size="icon-sm" className="shrink-0" onClick={onBack}>
                    <ChevronLeftIcon className="size-4" />
                </Button>
                <Icon {...serviceIconProps(icon, 'productivity')} size="sm" />
                <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm font-medium">Slack</span>
                    <span className="truncate text-[11px] text-muted-foreground">
                        {state?.connection ? (state.connection.teamName ?? state.connection.teamId) : 'Put your coworkers in Slack channels and talk to them there.'}
                    </span>
                </div>
                {state?.connection && <StatusBadge state={state} />}
                {state?.connection && isAdmin && <DisconnectButton onDisconnected={load} />}
            </div>

            {!state ? (
                <SlackSkeleton />
            ) : (
                <PanelScroller className="flex flex-col gap-6 p-4">
                    {state.connection ? (
                        <>
                            <SlackConnectionChecks state={state} reload={load} isAdmin={isAdmin} />
                            <SlackChannelsSection state={state} reload={load} />
                            <SlackIdentitySection state={state} reload={load} />
                            <p className="text-xs text-muted-foreground">
                                In a channel with several coworkers, start the message with the one you want. A thread keeps its own conversation, so a follow-up needs no reminder of what you were talking about.
                            </p>
                        </>
                    ) : (
                        <SlackConnectSteps state={state} reload={load} isAdmin={isAdmin} />
                    )}
                </PanelScroller>
            )}
        </>
    )
}

function StatusBadge({ state }: { state: SlackStateView }) {
    if (state.slackError || state.health?.state === 'bad_signature') return <Badge size="xs" tone="red">Needs attention</Badge>
    if (state.health?.state === 'never_called' || state.health?.state === 'no_identity') return <Badge size="xs" tone="orange">Needs attention</Badge>
    return <Badge size="xs" tone="green">Connected</Badge>
}

// Disconnecting takes every channel binding with it, so it asks first.
function DisconnectButton({ onDisconnected }: { onDisconnected: () => Promise<void> }) {
    const [pending, setPending] = useState(false)

    const disconnect = async () => {
        setPending(true)
        const result = await disconnectSlackAction()
        setPending(false)
        if (!result.ok) return toast.error(result.error)
        toast.success('Slack disconnected')
        await onDisconnected()
    }

    return (
        <ConfirmDialog
            title="Disconnect Slack?"
            description="Your coworkers leave every channel they were in, and those wirings are not kept. Connecting again starts from a clean slate."
            confirmLabel="Disconnect"
            pending={pending}
            onConfirm={disconnect}
        >
            <Button variant="ghost" size="sm" className="text-muted-foreground">
                Disconnect
            </Button>
        </ConfirmDialog>
    )
}

function SlackSkeleton() {
    return (
        <div className="flex flex-col gap-6 p-4">
            <div className="space-y-2">
                <Skeleton className="h-3 w-24" />
                {Array.from({ length: 4 }, (_, i) => (
                    <div key={i} className="flex items-center justify-between rounded-md border p-3">
                        <div className="space-y-1.5">
                            <Skeleton className="h-3.5 w-28" />
                            <Skeleton className="h-3 w-48" />
                        </div>
                        <Skeleton className="h-4 w-14 rounded-full" />
                    </div>
                ))}
            </div>
            <div className="space-y-2">
                <Skeleton className="h-3 w-20" />
                {Array.from({ length: 2 }, (_, i) => (
                    <div key={i} className="space-y-2 rounded-md border p-3">
                        <Skeleton className="h-3.5 w-36" />
                        <div className="flex gap-1.5">
                            <Skeleton className="h-7 w-24 rounded-full" />
                            <Skeleton className="h-7 w-24 rounded-full" />
                        </div>
                    </div>
                ))}
            </div>
        </div>
    )
}
