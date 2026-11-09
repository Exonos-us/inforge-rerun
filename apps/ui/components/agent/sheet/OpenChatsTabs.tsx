'use client'

import { BorderBeam } from '@rerun/ui'
import { useScrollFade } from '@rerun/ui/primitives'
import { useEffect, useMemo, useState } from 'react'

import { isGeneralTab, type SessionTab } from '@/hooks/useSessionTabs'
import { ATTENTION_STATUSES } from '@/lib/board/attention'
import type { SessionStatus } from '@/lib/board/types'
import { MessagesSquare, PlusIcon, XIcon } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { useBoardStore } from '@/stores/board.store'

export type TabState = 'live' | 'needs' | 'quiet'

export function tabStateOf(status: SessionStatus | undefined): TabState {
    if (status === 'working') return 'live'
    if (status && ATTENTION_STATUSES.has(status)) return 'needs'
    return 'quiet'
}

type OpenChatsTabsProps = {
    tabs: SessionTab[]
    activeIndex: number
    onSelect: (index: number) => void
    onClose: (index: number) => void
    onCreate: () => void
}

/**
 * The coworker's open conversations, left-aligned under the pills: General pinned first, out of the
 * row that scrolls, then the open threads, the active one on a muted fill, the others as plain text.
 * Too many to fit, the row scrolls and only the edge still hiding a tab fades.
 */
export function OpenChatsTabs({ tabs, activeIndex, onSelect, onClose, onCreate }: OpenChatsTabsProps) {
    const [scroller, setScroller] = useState<HTMLDivElement | null>(null)
    const fadeMask = useScrollFade(scroller, { axis: 'x' })
    const sessions = useBoardStore(s => s.sessions)
    const statusById = useMemo(() => new Map(sessions.map(session => [session.id, session.status])), [sessions])

    useEffect(() => {
        scroller?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' })
    }, [scroller, activeIndex])

    const general = isGeneralTab(tabs[0]) ? tabs[0] : null
    const offset = general ? 1 : 0
    const threads = tabs.slice(offset)

    const stateOf = (tab: SessionTab): TabState => tabStateOf(tab.id ? statusById.get(tab.id) : undefined)

    return (
        <div className="flex w-full items-center gap-1 px-3">
            {general && (
                <>
                    <MainChatTab active={activeIndex === 0} onSelect={() => onSelect(0)} />
                    <span aria-hidden className="mx-0.5 h-4 w-px shrink-0 bg-border" />
                </>
            )}
            <div ref={setScroller} className="min-w-0 overflow-x-auto [scrollbar-width:none]" style={{ maskImage: fadeMask, WebkitMaskImage: fadeMask }}>
                <div className="flex w-max items-center gap-1">
                    {threads.map((tab, i) => {
                        const index = i + offset
                        const active = index === activeIndex
                        return (
                            <div
                                key={tab.uid}
                                data-active={active}
                                className={cn(
                                    'group relative flex h-7 shrink-0 items-center gap-1 rounded-md pl-2.5 pr-1 text-xs transition-colors',
                                    active ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
                                )}
                            >
                                <button
                                    type="button"
                                    onClick={() => onSelect(index)}
                                    className="flex min-w-0 items-center gap-1.5 after:absolute after:inset-0 after:rounded-md after:content-['']"
                                >
                                    <StateDot state={stateOf(tab)} />
                                    <span className="max-w-[160px] truncate">{tab.title}</span>
                                </button>
                                <button
                                    type="button"
                                    aria-label={`Close ${tab.title}`}
                                    onClick={() => onClose(index)}
                                    className={cn('relative z-10 flex size-5 shrink-0 items-center justify-center rounded hover:bg-background/60', !active && 'opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100')}
                                >
                                    <XIcon className="size-3" />
                                </button>
                            </div>
                        )
                    })}
                </div>
            </div>
            <button
                type="button"
                aria-label="New thread"
                onClick={onCreate}
                className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
            >
                <PlusIcon className="size-3.5" />
            </button>
        </div>
    )
}

/**
 * The main chat's tab sits outside the threads' scrolling row, so it never scrolls away nor closes.
 * A beam sets it apart from the threads' tabs: it spins in the brand color while it is the one open,
 * and pauses where it is in the default color otherwise. Two beams fade into each other, so the
 * color changes without the ring jumping.
 */
function MainChatTab({ active, onSelect }: { active: boolean; onSelect: () => void }) {
    const animationPlayState = active ? 'running' : 'paused'
    return (
        <button
            type="button"
            data-general-tab
            data-active={active}
            onClick={onSelect}
            className={cn('relative flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-xs font-semibold transition-colors', active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground')}
        >
            <BorderBeam pattern="arcs" animated className={cn('transition-opacity duration-500', active && 'opacity-0')} style={{ animationPlayState }} />
            <BorderBeam pattern="arcs" tone="brand" animated glow className={cn('transition-opacity duration-500', !active && 'opacity-0')} style={{ animationPlayState }} />
            <MessagesSquare className={cn('size-3.5 transition-colors', active && 'text-brand-text')} />
            General
        </button>
    )
}

export function StateDot({ state, className }: { state: TabState; className?: string }) {
    if (state === 'quiet') return null
    return (
        <span className={cn('relative flex size-1.5 shrink-0', className)}>
            {state === 'live' && <span className="absolute inset-0 animate-ping rounded-full bg-emerald-400/70" />}
            <span className={cn('relative size-1.5 rounded-full', state === 'live' ? 'bg-emerald-400' : 'bg-amber-400')} />
        </span>
    )
}
