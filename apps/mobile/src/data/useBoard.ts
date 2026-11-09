import type { Box } from '@rerun/contracts'
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { AppState } from 'react-native'

import { fetchBoard, type BoardRead } from '@/api/board'
import { useAuth } from '@/auth/AuthProvider'
import { supabase } from '@/auth/supabase'
import { toHomeCoworkers, type HomeCoworker } from '@/components/home/board'
import { cachedBoard } from '@/data/local-cache'

// `fresh`: read from the hub since the screen opened, not the copy the phone kept from the last visit.
type Board = { state: 'loading' } | { state: 'error' } | { state: 'ready'; coworkers: HomeCoworker[]; boxes: Box[]; fresh: boolean }

const boardOf = ({ agents, overview, boxes }: BoardRead, fresh: boolean): Board => ({ state: 'ready', coworkers: toHomeCoworkers(agents, overview), boxes, fresh })

// Several rows change at once when a run moves (its session, then its agent): one read for the burst.
const BURST_MS = 400

// The coworkers of the active workspace with their latest conversation, read again whenever an agent
// or a session changes in Realtime, and when the app comes back to the foreground, where Realtime
// may have missed what happened while iOS held the app.
export function useBoard(): Board & { reload: () => void } {
    const { session, me } = useAuth()
    const accessToken = session?.access_token
    const workspaceId = me?.workspace.id
    const userId = me?.user.id
    // Tied to the workspace it was read for, so a switch never shows the rows of the one left.
    const [read, setRead] = useState<{ workspaceId: number; board: Board } | null>(null)
    const [version, setVersion] = useState(0)
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

    const reload = useCallback(() => setVersion(current => current + 1), [])
    const reloadSoon = useCallback(() => {
        if (timer.current) clearTimeout(timer.current)
        timer.current = setTimeout(reload, BURST_MS)
    }, [reload])

    useEffect(() => {
        if (!accessToken || !workspaceId) return
        let cancelled = false
        const caller = { accessToken, workspaceId }
        cachedBoard(workspaceId)
            .load(() => fetchBoard(caller))
            .then(fresh => {
                if (!cancelled) setRead({ workspaceId, board: boardOf(fresh, true) })
            })
            .catch(() => {
                if (cancelled) return
                const kept = cachedBoard(workspaceId).read()
                setRead(current => (current?.workspaceId === workspaceId && current.board.state === 'ready' ? current : { workspaceId, board: kept ? boardOf(kept, false) : { state: 'error' } }))
            })
        return () => {
            cancelled = true
        }
    }, [accessToken, workspaceId, version])

    useEffect(() => {
        const foreground = AppState.addEventListener('change', state => {
            if (state === 'active') reload()
        })
        return () => foreground.remove()
    }, [reload])

    // The coworker list can be mounted twice for a moment (the Home leaving the stack as the sidebar of a
    // wide window takes over): supabase.channel() hands back the instance of a topic already taken.
    const channelId = useId()
    useEffect(() => {
        if (!workspaceId) return
        const channel = supabase
            .channel(`home:${workspaceId}:${channelId}`)
            .on('postgres_changes', { event: '*', schema: 'public', table: 'agents', filter: `workspace_id=eq.${workspaceId}` }, reloadSoon)
            // A delete only carries the primary key, so the workspace filter above never lets one through.
            .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'agents' }, reloadSoon)
            .on('postgres_changes', { event: '*', schema: 'public', table: 'sessions' }, reloadSoon)
            .on('postgres_changes', { event: '*', schema: 'public', table: 'spaces', filter: `workspace_id=eq.${workspaceId}` }, reloadSoon)
        // A Box named to the caller or taken back from them: its coworkers appear or leave the home.
        if (userId) channel.on('postgres_changes', { event: '*', schema: 'public', table: 'space_members', filter: `user_id=eq.${userId}` }, reloadSoon)
        channel.subscribe()
        return () => {
            supabase.removeChannel(channel)
            if (timer.current) clearTimeout(timer.current)
        }
    }, [workspaceId, userId, reloadSoon, channelId])

    // A workspace already read opens on its rows, the hub's copy replaces them when it lands.
    const kept = useMemo(() => {
        if (!workspaceId || read?.workspaceId === workspaceId) return null
        const stored = cachedBoard(workspaceId).read()
        return stored ? boardOf(stored, false) : null
    }, [workspaceId, read?.workspaceId])
    const board: Board = read && read.workspaceId === workspaceId ? read.board : (kept ?? { state: 'loading' })
    return { ...board, reload }
}
