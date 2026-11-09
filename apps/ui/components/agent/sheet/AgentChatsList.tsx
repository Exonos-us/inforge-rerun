'use client'

import { InboxRow } from '@rerun/ui/inbox'
import { Badge } from '@rerun/ui/primitives'
import { useEffect, useMemo, useState } from 'react'

import { adoptEngineSessionAction, listAgentSessionsAction } from '@/app/api/_actions/session.actions'
import type { SessionHistoryEntry } from '@/app/api/_services/conversation.service'
import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog'
import { Button } from '@/components/ui/button'
import { Chip } from '@/components/ui/chip'
import { Skeleton } from '@/components/ui/skeleton'
import { useAttentionSessions } from '@/hooks/useAttentionSessions'
import { CalendarClock, CheckCheckIcon, LoaderIcon, MessageCircle, PlusIcon, WebhookIcon, XIcon } from '@/lib/icons'
import { messageDayLabel, messageTime } from '@/lib/time'
import { cn } from '@/lib/utils'
import { useBoardStore } from '@/stores/board.store'

export type ChatsFilter = 'all' | 'chats' | 'automations' | 'needs'

const isAutomated = (entry: SessionHistoryEntry) => entry.source === 'schedule' || entry.source === 'trigger'

type AgentChatsListProps = {
    agentId: string
    agentName: string
    activeSessionId: string | null
    initialFilter: ChatsFilter
    onSelect: (sessionId: string, title: string) => void
    onCreateNew: () => void
    onClose: () => void
}

/**
 * One list for the coworker's threads and for what waits on the user: a request is a thread like
 * any other, only marked, and opening it leads back into it. General is not listed: it has its own
 * tab, always there. The filter replaces the inbox the panel used to carry beside the chat.
 */
export function AgentChatsList({ agentId, agentName, activeSessionId, initialFilter, onSelect, onCreateNew, onClose }: AgentChatsListProps) {
    const [filter, setFilter] = useState<ChatsFilter>(initialFilter)
    const [history, setHistory] = useState<SessionHistoryEntry[] | null>(null)
    const [adopting, setAdopting] = useState<string | null>(null)
    const attention = useAttentionSessions(agentId)
    const setSessionStatus = useBoardStore(s => s.setSessionStatus)
    const markSessionsHandled = useBoardStore(s => s.markSessionsHandled)
    // The history is read once per opening: what runs right now comes from the board's live statuses.
    const sessions = useBoardStore(s => s.sessions)

    useEffect(() => {
        let alive = true
        listAgentSessionsAction(agentId)
            .then(entries => alive && setHistory(entries))
            .catch(() => alive && setHistory([]))
        return () => {
            alive = false
        }
    }, [agentId])

    const waitingIds = useMemo(() => new Set(attention.map(item => item.id)), [attention])
    const runningIds = useMemo(() => new Set(sessions.filter(s => s.agentId === agentId && s.status === 'working').map(s => s.id)), [sessions, agentId])
    const others = (history ?? []).filter(entry => entry.kind !== 'general' && (!entry.id || !waitingIds.has(entry.id)))
    const inboxItems = attention.map(item => ({ ...item, agentName }))
    const listsHistory = filter !== 'needs'
    const shown = others.filter(entry => (filter === 'chats' ? !isAutomated(entry) : filter === 'automations' ? isAutomated(entry) : true))
    const days = groupByDay(shown)

    const open = async (entry: SessionHistoryEntry) => {
        if (entry.id) {
            onSelect(entry.id, entry.title)
            return
        }
        // A conversation another coworker started lives on the engine only until someone opens it.
        setAdopting(entry.engineSessionId)
        try {
            onSelect(await adoptEngineSessionAction(agentId, entry.engineSessionId, entry.title), entry.title)
        } catch {
        } finally {
            setAdopting(null)
        }
    }

    return (
        <div className="flex min-h-0 flex-col">
            <div className="flex shrink-0 items-center justify-between gap-2 px-3 pb-1 pt-3">
                <span className="flex items-center gap-2 pl-1 text-sm font-semibold">
                    <MessageCircle className="size-4 text-muted-foreground" />
                    Threads
                </span>
                <div className="flex items-center gap-1.5">
                    <Button variant="outline" size="sm" onClick={onCreateNew}>
                        <PlusIcon className="size-3.5" />
                        New thread
                    </Button>
                    <Button aria-label="Close" variant="ghost" size="icon-sm" onClick={onClose}>
                        <XIcon className="size-4" />
                    </Button>
                </div>
            </div>
            <div className="flex shrink-0 items-center gap-1.5 overflow-x-auto px-3 py-2">
                <Chip selected={filter === 'all'} onClick={() => setFilter('all')}>
                    All
                </Chip>
                <Chip selected={filter === 'chats'} onClick={() => setFilter('chats')}>
                    Chats
                </Chip>
                <Chip selected={filter === 'automations'} onClick={() => setFilter('automations')}>
                    Automations
                </Chip>
                <Chip selected={filter === 'needs'} onClick={() => setFilter('needs')}>
                    Needs you <span className={cn('ml-1 tabular-nums', filter === 'needs' ? 'text-background/60' : 'text-muted-foreground/70')}>{attention.length}</span>
                </Chip>
                {filter === 'needs' && attention.length > 0 && (
                    <ConfirmDialog
                        title="Mark everything as read?"
                        description={`${attention.length} thread${attention.length !== 1 ? 's' : ''} will leave this list. Requests still waiting on an answer are cleared too, without being answered.`}
                        confirmLabel="Mark all as read"
                        confirmVariant="default"
                        onConfirm={() => markSessionsHandled(attention.map(item => item.id))}
                    >
                        <Button size="xs" variant="ghost" className="ml-auto text-muted-foreground">
                            <CheckCheckIcon className="size-3.5" />
                            Mark all as read
                        </Button>
                    </ConfirmDialog>
                )}
            </div>
            <div className="max-h-[420px] min-h-0 space-y-0.5 overflow-y-auto px-2 pb-2">
                {(filter === 'all' || filter === 'needs') &&
                    inboxItems.map(item => <InboxRow key={item.id} item={item} onOpen={() => onSelect(item.id, item.title)} onMarkRead={() => setSessionStatus(item.id, 'idle')} />)}
                {filter === 'needs' && inboxItems.length === 0 && <p className="px-3 py-6 text-center text-xs text-muted-foreground">Nothing waits on you.</p>}
                {listsHistory && history === null && <ChatsSkeleton />}
                {listsHistory &&
                    days.map(({ day, entries }) => (
                        <div key={day} className="pb-1">
                            <p className="px-2.5 pb-1 pt-2 text-[11px] font-medium text-muted-foreground">{day}</p>
                            {entries.map(entry => (
                                <ChatRow
                                    key={entry.engineSessionId}
                                    entry={entry}
                                    active={!!entry.id && entry.id === activeSessionId}
                                    running={!!entry.id && runningIds.has(entry.id)}
                                    adopting={adopting === entry.engineSessionId}
                                    onOpen={() => void open(entry)}
                                />
                            ))}
                        </div>
                    ))}
                {filter === 'all' && history !== null && shown.length === 0 && inboxItems.length === 0 && <p className="px-3 py-6 text-center text-xs text-muted-foreground">No thread yet.</p>}
                {(filter === 'chats' || filter === 'automations') && history !== null && shown.length === 0 && (
                    <p className="px-3 py-6 text-center text-xs text-muted-foreground">{filter === 'chats' ? 'No thread yet.' : 'No automated run yet.'}</p>
                )}
            </div>
        </div>
    )
}

// `history` arrives most recent first, so the days come out in order too.
export function groupByDay(entries: SessionHistoryEntry[]) {
    const now = new Date()
    const days: { day: string; entries: SessionHistoryEntry[] }[] = []
    for (const entry of entries) {
        const day = messageDayLabel(entry.updatedAt, now)
        const last = days.at(-1)
        if (last?.day === day) last.entries.push(entry)
        else days.push({ day, entries: [entry] })
    }
    return days
}

export function ChatRow({ entry, active, running, adopting, onOpen }: { entry: SessionHistoryEntry; active: boolean; running: boolean; adopting: boolean; onOpen: () => void }) {
    const SourceIcon = entry.source === 'trigger' ? WebhookIcon : CalendarClock
    // A run titled before the hub retitled them, or by an engine that sends no final answer, is still
    // named after its routine: the routine line would only repeat it.
    const routine = isAutomated(entry) && entry.automationName && entry.automationName !== entry.title ? entry.automationName : null
    return (
        <button
            type="button"
            disabled={adopting}
            onClick={onOpen}
            className={cn('flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors disabled:opacity-50', active ? 'bg-muted/60' : 'hover:bg-muted/40')}
        >
            <span className="flex min-w-0 flex-1 flex-col">
                <span className="flex min-w-0 items-center gap-1.5">
                    {isAutomated(entry) && !routine && <SourceIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />}
                    <span className={cn('truncate text-sm font-medium', entry.outcome === 'failed' && 'text-destructive', entry.outcome === 'nothing' && 'text-muted-foreground')}>{entry.title}</span>
                    {running && (
                        <Badge size="xs" tone="green" glow={false}>
                            Running
                        </Badge>
                    )}
                </span>
                {routine && (
                    <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
                        <SourceIcon aria-hidden className="size-3 shrink-0" />
                        <span className="truncate">{routine}</span>
                    </span>
                )}
                {entry.originAgentName && <span className="truncate text-xs text-muted-foreground">Started by {entry.originAgentName}</span>}
            </span>
            {adopting ? <LoaderIcon className="size-3.5 shrink-0 animate-spin text-muted-foreground" /> : <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{messageTime(entry.updatedAt)}</span>}
        </button>
    )
}

const SKELETON_WIDTHS = ['w-3/4', 'w-1/2', 'w-2/3', 'w-3/5']

function ChatsSkeleton() {
    return (
        <>
            {SKELETON_WIDTHS.map((width, i) => (
                <div key={i} className="flex items-center gap-2.5 px-2.5 py-2.5">
                    <Skeleton className={cn('h-3.5', width)} />
                    <Skeleton className="ml-auto h-3 w-6 shrink-0" />
                </div>
            ))}
        </>
    )
}
