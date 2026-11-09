import { useCallback, useEffect, useRef, useState } from 'react'
import type { WebView, WebViewMessageEvent } from 'react-native-webview'

import { openDesktop } from '@/api/desktop'
import { useAuth } from '@/auth/AuthProvider'
import { mirrorScript, viewerUrl } from '@/desktop/viewer'

const MAX_RECONNECTS = 3
const MIRROR_WIDTH = 480

export type ScreenStatus = 'loading' | 'live' | 'error' | 'disconnected'

// The latest copy of the screen, read by the floating thumbnail alone: eight frames a second through
// React state would redraw the whole conversation each time.
export type ScreenFrames = { subscribe: (listener: () => void) => () => void; current: () => string | null }

function createFrames() {
    let frame: string | null = null
    const listeners = new Set<() => void>()
    return {
        set(next: string | null) {
            frame = next
            listeners.forEach(listener => listener())
        },
        subscribe(listener: () => void) {
            listeners.add(listener)
            return () => listeners.delete(listener)
        },
        current: () => frame,
    }
}

function messageOf(data: string): { type?: unknown; uri?: unknown } {
    try {
        const parsed: unknown = JSON.parse(data)
        return typeof parsed === 'object' && parsed !== null ? parsed : {}
    } catch {
        return {}
    }
}

export type AgentScreen = {
    status: ScreenStatus
    // The viewer page to load, once the hub gave a socket; the screen is live once it painted.
    uri: string | null
    attachWebView: (view: WebView<object> | null) => void
    onMessage: (event: WebViewMessageEvent) => void
    frames: ScreenFrames
    // Copies of the screen for the floating thumbnail, only while it shows.
    mirror: (on: boolean) => void
}

// One connection's state, named by what opened it: a new one starts loading on the render that asks.
type Connection = { key: string | null; status: ScreenStatus; uri: string | null }

// The web's `useAgentScreen`: a connection to watch a coworker's screen, only while `enabled`. Its
// ticket lives a minute, so a dropped socket is reopened with a fresh one, a few times, as the full
// screen does.
export function useAgentScreen(agentId: string, enabled: boolean): AgentScreen {
    const { session, me } = useAuth()
    const accessToken = session?.access_token ?? null
    const workspaceId = me?.workspace.id ?? null
    // A refreshed token must not drop a screen that is already showing.
    const callerRef = useRef<{ accessToken: string; workspaceId: number } | null>(null)
    useEffect(() => {
        callerRef.current = accessToken && workspaceId !== null ? { accessToken, workspaceId } : null
    }, [accessToken, workspaceId])
    const signedIn = accessToken !== null && workspaceId !== null
    const [attempt, setAttempt] = useState(0)
    const key = enabled && signedIn ? `${agentId}#${attempt}` : null
    const [connection, setConnection] = useState<Connection>({ key: null, status: 'loading', uri: null })
    const current = connection.key === key ? connection : { key, status: 'loading' as const, uri: null }
    const webRef = useRef<WebView<object> | null>(null)
    const reconnects = useRef(0)
    const mirroring = useRef(false)
    const [frames] = useState(createFrames)

    useEffect(() => {
        frames.set(null)
        const who = callerRef.current
        if (!key || !who) return
        let alive = true
        openDesktop(who, agentId, 'watch').then(
            ({ socketUrl }) => alive && setConnection({ key, status: 'loading', uri: viewerUrl(socketUrl, 'watch') }),
            () => alive && setConnection({ key, status: 'error', uri: null })
        )
        return () => {
            alive = false
        }
    }, [agentId, key, frames])

    // Enabled again, the screen starts from a connection never seen: the last one's socket is gone.
    useEffect(() => {
        if (enabled) return
        reconnects.current = 0
        setAttempt(count => count + 1)
    }, [enabled])

    const onMessage = useCallback(
        (event: WebViewMessageEvent) => {
            const message = messageOf(event.nativeEvent.data)
            if (message.type === 'frame') {
                if (mirroring.current && typeof message.uri === 'string') frames.set(message.uri)
                return
            }
            if (message.type === 'connected') {
                reconnects.current = 0
                setConnection(state => ({ ...state, status: 'live' }))
                if (mirroring.current) webRef.current?.injectJavaScript(mirrorScript(MIRROR_WIDTH))
                return
            }
            if (message.type !== 'disconnected') return
            reconnects.current += 1
            if (reconnects.current > MAX_RECONNECTS) setConnection(state => ({ ...state, status: 'disconnected', uri: null }))
            else setAttempt(count => count + 1)
        },
        [frames]
    )

    const attachWebView = useCallback((view: WebView<object> | null) => {
        webRef.current = view
    }, [])

    const mirror = useCallback((on: boolean) => {
        if (mirroring.current === on) return
        mirroring.current = on
        webRef.current?.injectJavaScript(mirrorScript(on ? MIRROR_WIDTH : null))
    }, [])

    return { status: current.status, uri: current.uri, attachWebView, onMessage, frames, mirror }
}
