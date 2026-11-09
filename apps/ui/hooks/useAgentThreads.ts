'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { listAgentThreadsAction } from '@/app/api/_actions/session.actions'
import type { ThreadRow } from '@/app/api/_services/conversation.service'
import { useBoardStore } from '@/stores/board.store'

// Several rows of the same coworker change within a second when a run ends: one read covers them.
const REFRESH_DEBOUNCE_MS = 500

/**
 * The threads General hangs under its messages. Read once; `refresh` reads again, debounced, and
 * the panel calls it from the one realtime channel it already holds on the coworker's sessions (a
 * new thread, a title, an outcome). What runs right now comes from the board's live statuses, like
 * the dots of the tabs, so a thread that starts or finishes moves without waiting for that read.
 */
export function useAgentThreads(agentId: string): { threads: ThreadRow[]; refresh: () => void } {
    const [rows, setRows] = useState<ThreadRow[]>([])
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

    const refresh = useCallback(() => {
        if (timer.current) clearTimeout(timer.current)
        timer.current = setTimeout(() => {
            timer.current = null
            void listAgentThreadsAction(agentId).then(setRows)
        }, REFRESH_DEBOUNCE_MS)
    }, [agentId])

    useEffect(() => {
        let alive = true
        setRows([])
        listAgentThreadsAction(agentId).then(threads => alive && setRows(threads))
        return () => {
            alive = false
            if (timer.current) clearTimeout(timer.current)
        }
    }, [agentId])

    const sessions = useBoardStore(s => s.sessions)
    const statusById = useMemo(() => new Map(sessions.map(session => [session.id, session.status])), [sessions])

    const threads = useMemo(() => rows.map(row => ({ ...row, status: statusById.get(row.id) ?? row.status })), [rows, statusById])
    return { threads, refresh }
}
