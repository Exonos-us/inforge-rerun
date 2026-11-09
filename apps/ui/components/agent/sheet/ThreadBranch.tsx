'use client'

import { Badge, Stripes } from '@rerun/ui/primitives'

import type { ThreadRow } from '@/app/api/_services/conversation.service'
import { StateDot } from '@/components/agent/sheet/OpenChatsTabs'
import { ATTENTION_STATUSES } from '@/lib/board/attention'
import type { SessionStatus } from '@/lib/board/types'
import { CalendarClock, ChevronRightIcon, WebhookIcon } from '@/lib/icons'
import { shortRelativeTime } from '@/lib/time'
import { cn } from '@/lib/utils'
import { useBoardStore } from '@/stores/board.store'

export type ThreadState = 'live' | 'needs' | 'error' | 'done'

export function threadStateOf(status: SessionStatus): ThreadState {
    if (status === 'working') return 'live'
    if (status === 'error') return 'error'
    if (ATTENTION_STATUSES.has(status)) return 'needs'
    return 'done'
}

/** The same tones as the branches of a `call_agent` delegation (`SubRunTree`), plus orange for a thread waiting on us. */
const BRANCH_TONE: Record<ThreadState, string> = {
    live: 'border-brand/70',
    needs: 'border-orange-400/70',
    error: 'border-red-400/70',
    done: 'border-border',
}

const STATE_BADGE: Record<Exclude<ThreadState, 'done' | 'live'>, { label: string; tone: 'orange' | 'red' }> = {
    needs: { label: 'Needs you', tone: 'orange' },
    error: { label: 'Error', tone: 'red' },
}

const THREAD_STRIPES_INK = 'color-mix(in oklab, var(--foreground) 6%, transparent)'

const isAutomated = (thread: ThreadRow) => thread.source === 'schedule' || thread.source === 'trigger'

// What stands in for the opening message when the hub never saw one: a run the engine started, a
// coworker's request, or a thread older than the column that keeps it.
function genericOpener(thread: ThreadRow, originAgentName: string | null): string {
    if (thread.source === 'schedule') return `Scheduled run · ${thread.automationName ?? thread.title}`
    if (thread.source === 'trigger') return `Webhook · ${thread.automationName ?? thread.title}`
    if (thread.source === 'agent' || thread.source === 'delegate') return `Asked by ${originAgentName ?? 'another coworker'}`
    return 'Started a thread'
}

/**
 * A thread in General: the message it opened with, in a small bubble, and under it the thread's
 * row, joined by a curve that leaves the bubble's bottom like a delegation's branches in
 * `SubRunTree`. The row is hatched rather than filled, so it never reads as one more bubble, and a
 * click on it opens the thread in its tab.
 */
export function ThreadBranch({ thread, onOpen }: { thread: ThreadRow; onOpen: () => void }) {
    const state = threadStateOf(thread.status)
    const badge = state === 'needs' || state === 'error' ? STATE_BADGE[state] : null
    const SourceIcon = thread.source === 'trigger' ? WebhookIcon : CalendarClock
    const originAgentName = useBoardStore(s => (thread.originAgentId ? (s.agents.find(agent => agent.id === thread.originAgentId)?.name ?? null) : null))
    const opener = thread.firstMessage ?? genericOpener(thread, originAgentName)
    return (
        <div className="flex w-full flex-col gap-2" data-thread-row={thread.id}>
            {/* The clamp sits on an inner span: on the padded box itself, a third line would show through the bottom padding. Its right padding keeps the overhang of a last italic glyph. */}
            <div className={cn('w-fit max-w-full rounded-2xl rounded-bl-md bg-muted px-3 py-1.5 text-xs text-foreground/80', !thread.firstMessage && 'text-muted-foreground italic')}>
                <span className="line-clamp-2 pr-0.5 break-words">{opener}</span>
            </div>
            <div className="relative w-full pl-7">
                <span aria-hidden className={cn('absolute -top-2 left-3.5 h-6 w-3 rounded-bl-md border-b border-l transition-colors duration-500', BRANCH_TONE[state])} />
                <button type="button" onClick={onOpen} title={thread.automationName && thread.automationName !== thread.title ? thread.automationName : undefined} className="group relative flex h-8 max-w-full items-center gap-2 overflow-hidden rounded-lg border border-border px-2.5 text-left text-sm transition-colors hover:border-foreground/20 [&>:not(:first-child)]:relative">
                    {/* Turned half a turn, the hatch keeps its slant and fades toward the title instead of the chevron. */}
                    <Stripes fade="right" color={THREAD_STRIPES_INK} band={4} period={8} className="rotate-180 opacity-60 transition-opacity group-hover:opacity-100" />
                    {state === 'live' && <StateDot state="live" />}
                    {isAutomated(thread) && <SourceIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />}
                    <span className={cn('min-w-0 truncate font-medium', thread.outcome === 'failed' && 'text-destructive', thread.outcome === 'nothing' && 'text-muted-foreground')}>{thread.title}</span>
                    {badge && (
                        <Badge size="xs" tone={badge.tone} glow={false} className="shrink-0">
                            {badge.label}
                        </Badge>
                    )}
                    <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{shortRelativeTime(thread.createdAt)}</span>
                    <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                </button>
            </div>
        </div>
    )
}
