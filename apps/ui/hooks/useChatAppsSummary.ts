'use client'

import { getChatAppsSummaryAction, type ChatAppsSummary } from '@/app/api/_actions/slack.actions'
import { useCallback, useEffect, useState } from 'react'

// One summary for the whole browser session: the workspace menu and the Chat apps hub both draw
// from it, and the menu must never wait on a fetch of its own every time it opens.
let cached: ChatAppsSummary | null = null
let inFlight: Promise<ChatAppsSummary | null> | null = null
const listeners = new Set<() => void>()

async function fetchSummary(): Promise<ChatAppsSummary | null> {
    const result = await getChatAppsSummaryAction()
    if (result.ok) {
        cached = result.summary
        for (const notify of listeners) notify()
    }
    return cached
}

export function invalidateChatAppsSummary(): void {
    inFlight = fetchSummary().finally(() => {
        inFlight = null
    })
}

export function useChatAppsSummary(): { summary: ChatAppsSummary | null; refresh: () => Promise<void> } {
    const [, setTick] = useState(0)

    useEffect(() => {
        const notify = () => setTick(tick => tick + 1)
        listeners.add(notify)
        if (!cached && !inFlight) invalidateChatAppsSummary()
        return () => {
            listeners.delete(notify)
        }
    }, [])

    const refresh = useCallback(async () => {
        invalidateChatAppsSummary()
        await inFlight
    }, [])

    return { summary: cached, refresh }
}
