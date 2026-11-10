'use client'

import type { DesktopApp, DesktopViewMode } from '@rerun/contracts'
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import { toast } from 'sonner'

import { finishTakeoverAction, holdScreenAction, launchDesktopAppAction, openDesktopAction, releaseScreenHoldAction, setRecordingCaptureAction, startTakeoverAction } from '@/app/api/_actions/desktop.actions'
import { DesktopNotch } from '@/components/desktop/DesktopNotch'
import { DESKTOP_CONNECTING_LABEL, DesktopScreenLoader } from '@/components/desktop/DesktopScreenLoader'
import { DesktopViewer, type DesktopViewerHandle } from '@/components/desktop/DesktopViewer'
import { DesktopDialog } from '@/components/dialogs/DesktopDialog'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { UploadTray } from '@/components/ui/upload-tray'
import { useFileUploads } from '@/hooks/useFileUploads'
import { remoteClipboardReceiver } from '@/lib/desktop/remote-clipboard'
import { entriesFromDataTransfer } from '@/lib/files/upload'
import { MonitorIcon, UploadIcon } from '@/lib/icons'
import { useBoardStore } from '@/stores/board.store'
import { useDesktopStore, type TakeoverTarget } from '@/stores/desktop.store'

type Screen = { status: 'loading' } | { status: 'live'; socketUrl: string; dock: boolean; recordingPaused: boolean } | { status: 'error'; error: string } | { status: 'disconnected' }

const DESKTOP_DESCRIPTION = 'The screen this coworker works on. What you do here, it finds afterwards.'
const TAKEOVER_DESCRIPTION = 'You are in your coworker’s browser. Press Done when it can carry on.'
const TAKEOVER_HOLDS_BROWSER = 'Your coworker’s browser is already open for this request.'

// Renewed well before the engine expires a hold after two minutes without one.
const HOLD_RENEW_MS = 45_000
const CLIPBOARD_PREVIEW_CHARS = 200

const openScreen = (agentId: string, mode: DesktopViewMode) => openDesktopAction(agentId, mode, Intl.DateTimeFormat().resolvedOptions().timeZone)

async function connect(agentId: string, takeover: TakeoverTarget | null): Promise<Screen> {
    if (takeover) {
        const started = await startTakeoverAction(agentId, takeover.url)
        if (!started.ok) return { status: 'error', error: started.error }
    }
    const opened = await openScreen(agentId, 'drive')
    return opened.ok ? { status: 'live', socketUrl: opened.socketUrl, dock: opened.dock, recordingPaused: opened.recordingPaused } : { status: 'error', error: opened.error }
}

// The screen of the agent whose sheet is open, full-screen to use it. Watching it happens in that
// agent's chat. It follows the sheet: another agent, or no sheet at all, closes it.
export function AgentDesktopView() {
    const agentId = useDesktopStore(s => s.agentId)
    const takeover = useDesktopStore(s => s.takeover)
    const close = useDesktopStore(s => s.close)
    const selectedAgentId = useBoardStore(s => s.selectedAgentId)
    const agentName = useBoardStore(s => s.agents.find(agent => agent.id === agentId)?.name)

    useEffect(() => {
        if (agentId && selectedAgentId !== agentId) close()
    }, [agentId, selectedAgentId, close])

    return (
        <>
            <ScreenHoldKeeper />
            <DesktopDialog
                open={!!agentId}
                onOpenChange={open => {
                    if (!open) close()
                }}
                title={takeover ? takeover.reason : agentName ? `${agentName}’s desktop` : 'Desktop'}
                description={takeover ? TAKEOVER_DESCRIPTION : DESKTOP_DESCRIPTION}
            >
                {agentId && <DesktopSession key={`${agentId}:${takeover?.callId ?? 'desktop'}`} agentId={agentId} agentName={agentName} takeover={takeover} />}
            </DesktopDialog>
        </>
    )
}

// Renews the engine hold while the person has a screen, and releases it when the store clears —
// whoever cleared it. The I'm done buttons only clear the store, so there is a single release path.
// A tab that dies without the cleanup leaves the hold to the engine's own expiry.
function ScreenHoldKeeper() {
    const holdingAgentId = useDesktopStore(s => s.holdingAgentId)
    useEffect(() => {
        if (!holdingAgentId) return
        const renew = setInterval(() => void holdScreenAction(holdingAgentId), HOLD_RENEW_MS)
        return () => {
            clearInterval(renew)
            void releaseScreenHoldAction(holdingAgentId)
        }
    }, [holdingAgentId])
    return null
}

function DesktopSession({ agentId, agentName, takeover }: { agentId: string; agentName?: string; takeover: TakeoverTarget | null }) {
    const handBack = useDesktopStore(s => s.handBack)
    const holding = useDesktopStore(s => s.holdingAgentId === agentId)
    const setHolding = useDesktopStore(s => s.setHolding)
    const [screen, setScreen] = useState<Screen>({ status: 'loading' })
    const [busy, setBusy] = useState(false)
    const [browsing, setBrowsing] = useState(false)
    const [capturing, setCapturing] = useState(true)
    const [dragOver, setDragOver] = useState(false)
    const viewerRef = useRef<DesktopViewerHandle>(null)
    // Two clicks on Done would hand the browser back twice, and resume the run twice.
    const finishingRef = useRef(false)
    const browsingRef = useRef(false)

    const uploads = useFileUploads({
        target: useMemo(() => ({ kind: 'agent', agentId }) as const, [agentId]),
        onRejected: message => toast.error(message),
    })

    useEffect(() => {
        let alive = true
        void connect(agentId, takeover).then(result => {
            if (!alive) return
            setScreen(result)
            // A view reopened mid-hold shows the capture the way the engine left it.
            if (result.status === 'live') setCapturing(!result.recordingPaused)
        })
        return () => {
            alive = false
            // A browser opened from the notch holds the agent's profile for as long as it is open, so
            // it closes with the view instead of being left to its fifteen-minute limit.
            if (browsingRef.current) void finishTakeoverAction(agentId)
        }
        // Mounted once per session: the parent remounts this component for another agent or takeover.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    const reconnect = async () => {
        setScreen({ status: 'loading' })
        const result = await connect(agentId, takeover)
        setScreen(result)
        if (result.status === 'live') setCapturing(!result.recordingPaused)
    }

    const run = async (action: () => Promise<{ ok: true } | { ok: false; error: string }>): Promise<boolean> => {
        setBusy(true)
        const result = await action()
        setBusy(false)
        if (!result.ok) toast.error(result.error)
        return result.ok
    }

    const openApp = (app: DesktopApp) => void run(() => launchDesktopAppAction(agentId, app))

    const toggleBrowser = async () => {
        const next = !browsing
        if (!(await run(() => (next ? startTakeoverAction(agentId) : finishTakeoverAction(agentId)))) && next) return
        browsingRef.current = next
        setBrowsing(next)
    }

    const paste = async () => {
        try {
            viewerRef.current?.paste(await navigator.clipboard.readText())
        } catch {
            toast.error('Your browser did not let Rerun read the clipboard.')
        }
    }

    // A paused capture never outlives the person who paused it: leaving resumes it, so the rest of
    // the session is recorded again.
    const resumeCaptureIfPaused = () => {
        if (capturing) return
        setCapturing(true)
        void setRecordingCaptureAction(agentId, true)
    }

    const toggleCapture = async () => {
        const next = !capturing
        if (await run(() => setRecordingCaptureAction(agentId, next))) setCapturing(next)
    }

    const toggleHold = async () => {
        if (!holding) {
            if (await run(() => holdScreenAction(agentId))) setHolding(agentId)
            return
        }
        resumeCaptureIfPaused()
        // The browser the person opened goes back to the agent with its pages still up, like the
        // hand-back after a sign-in.
        if (browsingRef.current) {
            setBusy(true)
            const result = await finishTakeoverAction(agentId, { keepOpen: true })
            setBusy(false)
            if (!result.ok) toast.error(result.error)
            browsingRef.current = false
            setBrowsing(false)
        }
        setHolding(null)
    }

    const done = async () => {
        if (!takeover || finishingRef.current) return
        finishingRef.current = true
        setBusy(true)
        resumeCaptureIfPaused()
        const result = await finishTakeoverAction(agentId, { keepOpen: true })
        setBusy(false)
        if (!result.ok) {
            finishingRef.current = false
            toast.error(result.error)
            return
        }
        if (holding) setHolding(null)
        handBack(takeover.callId, { url: result.url, open: result.open })
    }

    const receiveClipboard = useMemo(
        () =>
            remoteClipboardReceiver({
                write: text => navigator.clipboard.writeText(text),
                show: text =>
                    toast('Copied on the computer', {
                        description: text.length > CLIPBOARD_PREVIEW_CHARS ? `${text.slice(0, CLIPBOARD_PREVIEW_CHARS)}…` : text,
                        action: { label: 'Copy', onClick: () => void navigator.clipboard.writeText(text).catch(() => {}) },
                    }),
            }),
        []
    )
    const onClipboard = useCallback(
        (text: string) => {
            void receiveClipboard(text).then(outcome => {
                if (outcome === 'copied') toast.success('Copied from the computer', { description: text.length > CLIPBOARD_PREVIEW_CHARS ? `${text.slice(0, CLIPBOARD_PREVIEW_CHARS)}…` : text })
            })
        },
        [receiveClipboard]
    )

    const filesDragged = (event: DragEvent) => event.dataTransfer.types.includes('Files')

    const onDrop = async (event: DragEvent) => {
        event.preventDefault()
        setDragOver(false)
        const entries = await entriesFromDataTransfer(event.dataTransfer)
        if (entries.length) uploads.enqueue(entries)
    }

    const onDisconnect = useCallback(() => setScreen({ status: 'disconnected' }), [])
    const live = screen.status === 'live'

    return (
        <div
            className="relative flex min-h-0 flex-1 flex-col bg-muted/40"
            onDragOver={event => {
                if (!filesDragged(event)) return
                event.preventDefault()
                setDragOver(true)
            }}
            onDragLeave={event => {
                if (event.currentTarget.contains(event.relatedTarget as Node)) return
                setDragOver(false)
            }}
            onDrop={event => void onDrop(event)}
        >
            {screen.status === 'loading' && <DesktopScreenLoader label={DESKTOP_CONNECTING_LABEL} />}
            {screen.status === 'live' && <DesktopViewer ref={viewerRef} socketUrl={screen.socketUrl} onDisconnect={onDisconnect} onClipboard={onClipboard} />}
            {screen.status === 'error' && <EmptyState icon={MonitorIcon} title="The screen is not available" description={screen.error} action={<RetryButton onClick={() => void reconnect()} />} />}
            {screen.status === 'disconnected' && <EmptyState icon={MonitorIcon} title="The screen went away" description="The connection to the machine closed. Nothing on it was lost." action={<RetryButton onClick={() => void reconnect()} label="Reconnect" />} />}
            <DesktopNotch
                launchers={screen.status === 'live' && !screen.dock}
                browsing={browsing}
                browserLockedReason={takeover ? TAKEOVER_HOLDS_BROWSER : undefined}
                disabled={!live || busy}
                takeoverReason={takeover?.reason}
                holding={holding}
                onToggleHold={takeover ? undefined : () => void toggleHold()}
                capturing={capturing}
                onToggleCapture={holding || browsing || !!takeover ? () => void toggleCapture() : undefined}
                onOpenApp={openApp}
                onToggleBrowser={() => void toggleBrowser()}
                onPaste={() => void paste()}
                onDone={takeover ? () => void done() : undefined}
            />
            {holding && (
                <div className="pointer-events-none absolute inset-x-4 top-10 z-10 flex justify-center">
                    <p className="truncate rounded-full bg-popover/95 px-3 py-1 text-xs font-medium shadow-sm ring-1 ring-border">You have the screen — {agentName ?? 'your coworker'} is waiting</p>
                </div>
            )}
            {dragOver && (
                <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-primary/10">
                    <p className="flex items-center gap-2 rounded-full bg-popover px-4 py-2 text-sm font-medium shadow ring-1 ring-border">
                        <UploadIcon className="size-4" />
                        Drop to put in {agentName ? `${agentName}’s` : 'the'} workspace
                    </p>
                </div>
            )}
            {uploads.items.length > 0 && (
                <div className="absolute inset-x-0 bottom-0 z-10 mx-auto w-full max-w-md px-3 pb-3">
                    <div className="overflow-hidden rounded-lg bg-popover shadow-lg ring-1 ring-border">
                        <UploadTray items={uploads.items} totalProgress={uploads.totalProgress} onCancel={uploads.cancel} onRetry={uploads.retry} onDismiss={uploads.active ? uploads.cancelAll : uploads.clearFinished} />
                    </div>
                </div>
            )}
        </div>
    )
}

function RetryButton({ onClick, label = 'Try again' }: { onClick: () => void; label?: string }) {
    return (
        <Button size="sm" variant="outline" onClick={onClick}>
            {label}
        </Button>
    )
}
