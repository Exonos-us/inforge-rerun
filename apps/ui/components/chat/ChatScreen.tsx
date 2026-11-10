'use client'

import { AnimatePresence } from 'motion/react'
import { useCallback, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'

import type { TakeoverRequestState } from '@/components/chat/TakeoverAsk'
import { DesktopScreenLoader } from '@/components/desktop/DesktopScreenLoader'
import { DesktopViewer } from '@/components/desktop/DesktopViewer'
import { FloatingScreen } from '@/components/desktop/FloatingScreen'
import { ScreenCard } from '@/components/desktop/ScreenCard'
import { ScreenFace } from '@/components/desktop/ScreenFace'
import { ScreenMirror } from '@/components/desktop/ScreenMirror'
import { useAgentScreen } from '@/hooks/useAgentScreen'
import { useSeenInThread } from '@/hooks/useSeenInThread'
import { type TakeoverAskInput, useTakeoverRequest } from '@/hooks/useTakeoverRequest'
import { useBoardStore } from '@/stores/board.store'
import { useDesktopStore } from '@/stores/desktop.store'

type ChatScreenProps = {
    agentId: string
    // Whether this conversation is the one on screen: a hidden one keeps its takeover but no connection.
    active: boolean
    site: string | null
    takeoverAsk: TakeoverAskInput | null
    onTakeoverDone: (summary: string) => void
    onTakeoverSkip: () => void
    scroller: HTMLElement | null
    // The chat's own box, where the thumbnail floats when the thread scrolls away from the screen.
    floatingHost: HTMLElement | null
    arriveRef?: RefObject<HTMLDivElement | null>
    // What the thread shows instead when there is no screen to show: the run's activity loader.
    fallback: ReactNode
}

// The coworker's screen as the last block of the run that uses it, with the takeover it asks for.
export function ChatScreen({ agentId, active, takeoverAsk, onTakeoverDone, onTakeoverSkip, ...block }: ChatScreenProps) {
    const takeover = useTakeoverRequest(agentId, takeoverAsk, onTakeoverDone, onTakeoverSkip)
    const selected = useBoardStore(s => s.selectedAgentId === agentId)
    if (!active || !selected) return block.fallback
    return <ScreenBlock agentId={agentId} takeover={takeover} {...block} />
}

type ScreenBlockProps = Pick<ChatScreenProps, 'agentId' | 'site' | 'scroller' | 'floatingHost' | 'arriveRef' | 'fallback'> & { takeover: TakeoverRequestState | undefined }

function ScreenBlock({ agentId, site, takeover, scroller, floatingHost, arriveRef, fallback }: ScreenBlockProps) {
    const { screen, onDisconnect } = useAgentScreen(agentId)
    const openDesktop = useDesktopStore(s => s.openDesktop)
    const driving = useDesktopStore(s => s.agentId === agentId)
    // While the person holds the screen, the "You have the screen" notice floats where the mini
    // screen would, and says more than the thumbnail.
    const holding = useDesktopStore(s => s.holdingAgentId === agentId)
    const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null)
    const [card, setCard] = useState<HTMLDivElement | null>(null)
    const cardSeen = useSeenInThread(card, scroller)

    const cardRef = useCallback(
        (node: HTMLDivElement | null) => {
            setCard(node)
            if (arriveRef) arriveRef.current = node
        },
        [arriveRef]
    )

    const takeControl = () => (takeover ? takeover.onOpen() : openDesktop(agentId))
    const live = screen.status === 'live'
    const unavailable = screen.status === 'error' || screen.status === 'disconnected'
    if (unavailable && !takeover) return fallback

    return (
        <>
            <ScreenCard
                ref={cardRef}
                live={live}
                site={takeover?.site ?? site}
                screen={<ScreenFace status={screen.status}>{screen.status === 'live' && <DesktopViewer viewOnly socketUrl={screen.socketUrl} onDisconnect={onDisconnect} onCanvas={setCanvas} />}</ScreenFace>}
                takeover={takeover}
                onTakeControl={takeControl}
            />
            {floatingHost &&
                createPortal(
                    <AnimatePresence>
                        {!cardSeen && !driving && !holding && (
                            <FloatingScreen key="mini" className="top-1" takeControlLabel={takeover ? 'Open browser' : 'Take control'} onTakeControl={takeControl}>
                                <ScreenFace status={screen.status}>{canvas ? <ScreenMirror source={canvas} /> : <DesktopScreenLoader compact className="bg-muted/40" />}</ScreenFace>
                            </FloatingScreen>
                        )}
                    </AnimatePresence>,
                    floatingHost
                )}
        </>
    )
}
