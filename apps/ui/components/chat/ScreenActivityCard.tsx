'use client'

import { listScreenSessionsAction } from '@/app/api/_actions/desktop.actions'
import { Skeleton } from '@rerun/ui/primitives'
import { agentFileRawUrl } from '@/lib/files/raw-url'
import { ChevronDownIcon, MonitorIcon } from '@/lib/icons'
import { cn } from '@/lib/utils'
import type { ScreenSession } from '@rerun/contracts'
import { useCallback, useRef, useState } from 'react'

type ScreenActivityCardProps = {
    agentId: string
    sessionIds: string[]
}

const frameUrl = (agentId: string, sessionId: string, frame: number) => agentFileRawUrl(agentId, `screen/${sessionId}/${String(frame).padStart(3, '0')}.jpg`)

const recordingUrl = (agentId: string, sessionId: string, file: string) => agentFileRawUrl(agentId, `screen/${sessionId}/${file}`)

/**
 * The evidence a finished run left of its screen work: the recording and the action screenshots the
 * engine kept under `screen/<session>/` in the coworker's workspace. Collapsed by default; nothing
 * is fetched until the user opens it.
 */
export function ScreenActivityCard({ agentId, sessionIds, className }: ScreenActivityCardProps & { className?: string }) {
    const [open, setOpen] = useState(false)
    const [sessions, setSessions] = useState<ScreenSession[] | null>(null)
    const fetched = useRef(false)

    const toggle = useCallback(() => {
        setOpen(current => !current)
        if (fetched.current) return
        fetched.current = true
        void listScreenSessionsAction(agentId).then(all => {
            const wanted = new Set(sessionIds)
            setSessions(all.filter(session => wanted.has(session.id)).sort((a, b) => a.id.localeCompare(b.id)))
        })
    }, [agentId, sessionIds])

    return (
        <div className={cn('w-full max-w-md overflow-hidden rounded-xl border bg-card', className)}>
            <button type="button" onClick={toggle} aria-expanded={open} className="flex min-h-9 w-full items-center gap-2 px-3 py-2 text-left">
                <MonitorIcon className="size-4 shrink-0 text-muted-foreground" />
                <span className="font-medium text-sm">Screen activity</span>
                <ChevronDownIcon className={cn('ml-auto size-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')} />
            </button>
            {open && (
                <div className="flex flex-col gap-3 border-t p-2">
                    {sessions === null && <ScreenSessionSkeleton />}
                    {sessions?.length === 0 && <p className="px-1 py-2 text-muted-foreground text-xs">This screen activity is no longer kept: only the most recent sessions stay in the coworker's workspace.</p>}
                    {sessions?.map(session => <ScreenSessionView key={session.id} agentId={agentId} session={session} />)}
                </div>
            )}
        </div>
    )
}

// The same bones as the open card: a wide frame, then the strip of thumbnails under it.
function ScreenSessionSkeleton() {
    return (
        <div className="flex flex-col gap-2">
            <Skeleton className="aspect-video w-full rounded-lg" />
            <div className="flex gap-1.5 overflow-hidden">
                {Array.from({ length: 5 }).map((_, i) => (
                    <Skeleton key={i} className="aspect-video w-16 shrink-0 rounded" />
                ))}
            </div>
        </div>
    )
}

function ScreenSessionView({ agentId, session }: { agentId: string; session: ScreenSession }) {
    // Null plays the recording when there is one; a number holds that screenshot in the main view.
    const [picked, setPicked] = useState<number | null>(session.recording ? null : 1)
    // A capture paused and resumed left several segment files; an engine that predates the list
    // sends only the boolean, which means the single classic file.
    const recordings = session.recordings ?? (session.recording ? ['recording.mp4'] : [])
    const [segment, setSegment] = useState(0)
    const stripRef = useRef<HTMLDivElement>(null)
    const frames = Array.from({ length: session.frames }, (_, i) => i + 1)
    const showVideo = recordings.length > 0 && picked === null

    // Click lands on a thumbnail; a drag across the strip scrubs through the frames it passes over.
    const scrubTo = useCallback((clientX: number) => {
        for (const child of stripRef.current?.children ?? []) {
            const box = (child as HTMLElement).getBoundingClientRect()
            if (clientX >= box.left && clientX <= box.right) {
                const frame = Number((child as HTMLElement).dataset.frame)
                if (frame) setPicked(frame)
                return
            }
        }
    }, [])

    if (session.frames === 0 && !session.recording) return <p className="px-1 py-2 text-muted-foreground text-xs">Nothing was kept for this session.</p>

    return (
        <div className="flex flex-col gap-2">
            {showVideo ? (
                <video key={segment} controls preload="metadata" playsInline src={recordingUrl(agentId, session.id, recordings[Math.min(segment, recordings.length - 1)]!)} className="aspect-video w-full rounded-lg border bg-black object-contain" aria-label="Screen recording" />
            ) : (
                picked !== null && <img src={frameUrl(agentId, session.id, picked)} alt={`Screenshot ${picked} of ${session.frames}`} loading="lazy" className="aspect-video w-full rounded-lg border bg-muted object-contain" />
            )}
            {session.frames > 0 && (
                <div
                    ref={stripRef}
                    className="flex touch-pan-x gap-1.5 overflow-x-auto pb-1"
                    onPointerDown={event => {
                        event.currentTarget.setPointerCapture(event.pointerId)
                        scrubTo(event.clientX)
                    }}
                    onPointerMove={event => {
                        if (event.buttons > 0) scrubTo(event.clientX)
                    }}
                >
                    {frames.map(n => (
                        <img
                            key={n}
                            data-frame={n}
                            src={frameUrl(agentId, session.id, n)}
                            alt={`Screenshot ${n}`}
                            loading="lazy"
                            draggable={false}
                            onClick={() => setPicked(n)}
                            className={cn('aspect-video w-16 shrink-0 cursor-pointer select-none rounded border object-cover', picked === n && 'ring-2 ring-primary')}
                        />
                    ))}
                </div>
            )}
            <div className="flex min-h-4 flex-wrap items-center justify-between gap-1 px-0.5">
                {picked !== null && session.frames > 1 ? (
                    <p className="text-[11px] text-muted-foreground">
                        {picked} / {session.frames}
                    </p>
                ) : showVideo && recordings.length > 1 ? (
                    <div className="flex items-center gap-1">
                        {recordings.map((file, i) => (
                            <button key={file} type="button" onClick={() => setSegment(i)} className={cn('cursor-pointer rounded-full border px-2 py-0.5 text-[11px]', i === segment ? 'border-primary text-foreground' : 'text-muted-foreground hover:text-foreground')}>
                                Part {i + 1}
                            </button>
                        ))}
                    </div>
                ) : (
                    <span />
                )}
                {session.recording && picked !== null && (
                    <button type="button" onClick={() => setPicked(null)} className="text-[11px] text-muted-foreground underline-offset-2 hover:underline">
                        Back to the recording
                    </button>
                )}
            </div>
        </div>
    )
}
