'use client'

import { useChatAppsSummary } from '@/hooks/useChatAppsSummary'

// The one glance the menu owes: whether anything is wired up, without naming an app. Drawn from
// the session-cached summary, so opening the menu never fires a request of its own.
export function ChatAppsConnectedHint() {
    const { summary } = useChatAppsSummary()
    if (!summary?.slack.connected) return null

    return (
        <span className="ml-auto flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <span className={`size-1.5 rounded-full ${summary.slack.healthy ? 'bg-emerald-500' : 'bg-amber-500'}`} aria-hidden="true" />
            1 connected
        </span>
    )
}
