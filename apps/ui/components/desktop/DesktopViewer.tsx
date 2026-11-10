'use client'

import type RFB from '@novnc/novnc/lib/rfb'
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react'

import { DESKTOP_CONNECTING_LABEL, DesktopScreenLoader } from '@/components/desktop/DesktopScreenLoader'
import { cn } from '@/lib/utils'

const KEYSYM_CONTROL_LEFT = 0xffe3
const KEYSYM_V = 0x0076
const KEYSYM_RETURN = 0xff0d

// X11 keysyms: Latin-1 is its own code point, anything else is the code point offset into the
// Unicode range, and a line break is Return.
function keysymOf(char: string): number {
    if (char === '\n') return KEYSYM_RETURN
    const codePoint = char.codePointAt(0) ?? 0
    return codePoint <= 0xff ? codePoint : 0x01000000 + codePoint
}

export type DesktopViewerHandle = {
    // The remote clipboard is not this computer's: a paste has to be pushed there, then typed.
    paste: (text: string) => void
    // One key pressed and released, for a keyboard that cannot reach the canvas (a phone's).
    key: (keysym: number, code: string) => void
    // Text typed key by key: unlike a paste, it lands in a terminal as well as in a form.
    type: (text: string) => void
}

type DesktopViewerProps = {
    socketUrl: string
    onDisconnect: () => void
    // A screen to watch: nothing typed or clicked reaches the machine, and the pointer goes through
    // to whatever holds the viewer.
    viewOnly?: boolean
    ref?: Ref<DesktopViewerHandle>
    // The canvas the screen is painted on once connected, null when it goes: what a mirror copies.
    onCanvas?: (canvas: HTMLCanvasElement | null) => void
    // Text copied inside the remote computer, as the VNC server announces it.
    onClipboard?: (text: string) => void
    className?: string
}

export function DesktopViewer({ socketUrl, onDisconnect, viewOnly = false, ref, onCanvas, onClipboard, className }: DesktopViewerProps) {
    const screenRef = useRef<HTMLDivElement>(null)
    const rfbRef = useRef<RFB | null>(null)
    const [connected, setConnected] = useState(false)
    const onDisconnectRef = useRef(onDisconnect)
    const onCanvasRef = useRef(onCanvas)
    const onClipboardRef = useRef(onClipboard)
    useEffect(() => {
        onDisconnectRef.current = onDisconnect
        onCanvasRef.current = onCanvas
        onClipboardRef.current = onClipboard
    }, [onDisconnect, onCanvas, onClipboard])

    useEffect(() => {
        const screen = screenRef.current
        if (!screen) return
        let cancelled = false
        void import('@novnc/novnc/lib/rfb').then(({ default: Client }) => {
            if (cancelled) return
            const rfb = new Client(screen, socketUrl)
            rfb.scaleViewport = true
            rfb.viewOnly = viewOnly
            rfb.focusOnClick = !viewOnly
            rfb.background = 'transparent'
            rfb.addEventListener('connect', () => {
                setConnected(true)
                onCanvasRef.current?.(screen.querySelector('canvas'))
            })
            rfb.addEventListener('clipboard', event => {
                const text = (event as CustomEvent<{ text: string }>).detail?.text
                if (typeof text === 'string') onClipboardRef.current?.(text)
            })
            rfb.addEventListener('disconnect', () => {
                if (rfbRef.current !== rfb) return
                rfbRef.current = null
                setConnected(false)
                onCanvasRef.current?.(null)
                onDisconnectRef.current()
            })
            rfbRef.current = rfb
        })
        return () => {
            cancelled = true
            const rfb = rfbRef.current
            rfbRef.current = null
            rfb?.disconnect()
            setConnected(false)
            onCanvasRef.current?.(null)
        }
    }, [socketUrl, viewOnly])

    useImperativeHandle(ref, () => ({
        paste: text => {
            const rfb = rfbRef.current
            if (!rfb) return
            rfb.clipboardPasteFrom(text)
            rfb.sendKey(KEYSYM_CONTROL_LEFT, 'ControlLeft', true)
            rfb.sendKey(KEYSYM_V, 'KeyV')
            rfb.sendKey(KEYSYM_CONTROL_LEFT, 'ControlLeft', false)
            rfb.focus()
        },
        key: (keysym, code) => rfbRef.current?.sendKey(keysym, code),
        type: text => {
            const rfb = rfbRef.current
            if (!rfb) return
            for (const char of text) rfb.sendKey(keysymOf(char), null)
        },
    }))

    return (
        <div className={cn('relative min-h-0 flex-1 bg-muted/40', className)}>
            <DesktopScreenLoader fading={connected} compact={viewOnly} label={viewOnly ? undefined : DESKTOP_CONNECTING_LABEL} />
            <div ref={screenRef} className={cn('absolute inset-0 transition-opacity duration-300', connected ? 'opacity-100' : 'opacity-0', viewOnly && 'pointer-events-none')} />
        </div>
    )
}
