'use client'

import type { DesktopApp } from '@rerun/contracts'

import { Button } from '@/components/ui/button'
import { DialogClose } from '@/components/ui/dialog'
import { TooltipDisabledReason, TooltipLabeled } from '@/components/ui/tooltip'
import { CircleIcon, ClipboardPasteIcon, FolderIcon, GlobeIcon, HandIcon, TerminalIcon, XIcon } from '@/lib/icons'
import { cn } from '@/lib/utils'

type DesktopNotchProps = {
    // False when the screen has a dock of its own: only what it cannot do stays here.
    launchers: boolean
    // The notch opened the agent's browser, so the same button closes it again.
    browsing: boolean
    // Why the notch cannot open the browser, when something else already holds it.
    browserLockedReason?: string
    disabled?: boolean
    takeoverReason?: string
    // The explicit hold: Take over flips to I'm done while the person has the screen.
    holding?: boolean
    onToggleHold?: () => void
    // Whether the screen session is being captured; absent hides the pause control.
    capturing?: boolean
    onToggleCapture?: () => void
    onOpenApp: (app: DesktopApp) => void
    onToggleBrowser: () => void
    onPaste: () => void
    onDone?: () => void
}

const SHOULDER = 'absolute top-0 size-3'

// Everything the app adds to an agent's screen, hung from the top edge of its dialog so nothing
// else covers the screen. Render it inside a positioned box, within the dialog it closes.
export function DesktopNotch({ launchers, browsing, browserLockedReason, disabled, takeoverReason, holding, onToggleHold, capturing, onToggleCapture, onOpenApp, onToggleBrowser, onPaste, onDone }: DesktopNotchProps) {
    const browserLabel = browsing ? 'Close browser' : 'Browser'
    const captureLabel = capturing ? 'Pause recording' : 'Resume recording'

    return (
        <div className="absolute top-0 left-1/2 z-10 flex max-w-[calc(100%-3rem)] -translate-x-1/2 items-center gap-1 rounded-b-xl bg-popover px-1.5 pt-0.5 pb-1.5 text-popover-foreground">
            <span aria-hidden className={`${SHOULDER} right-full bg-[radial-gradient(circle_at_0_100%,transparent_calc(0.75rem-0.5px),var(--popover)_0.75rem)]`} />
            <span aria-hidden className={`${SHOULDER} left-full bg-[radial-gradient(circle_at_100%_100%,transparent_calc(0.75rem-0.5px),var(--popover)_0.75rem)]`} />
            {takeoverReason && <p className="max-w-64 truncate px-1.5 text-xs font-medium max-sm:hidden">{takeoverReason}</p>}
            {launchers && (
                <>
                    <TooltipDisabledReason reason={browserLockedReason} side="bottom">
                        <TooltipLabeled label={browserLabel} side="bottom">
                            <Button aria-label={browserLabel} size="icon-sm" variant={browsing ? 'secondary' : 'ghost'} disabled={disabled || !!browserLockedReason} onClick={onToggleBrowser}>
                                <GlobeIcon className="size-4" />
                            </Button>
                        </TooltipLabeled>
                    </TooltipDisabledReason>
                    <TooltipLabeled label="Files" side="bottom">
                        <Button aria-label="Files" size="icon-sm" variant="ghost" disabled={disabled} onClick={() => onOpenApp('files')}>
                            <FolderIcon className="size-4" />
                        </Button>
                    </TooltipLabeled>
                    <TooltipLabeled label="Terminal" side="bottom">
                        <Button aria-label="Terminal" size="icon-sm" variant="ghost" disabled={disabled} onClick={() => onOpenApp('terminal')}>
                            <TerminalIcon className="size-4" />
                        </Button>
                    </TooltipLabeled>
                </>
            )}
            <TooltipLabeled label="Paste" side="bottom">
                <Button aria-label="Paste" size="icon-sm" variant="ghost" disabled={disabled} onClick={onPaste}>
                    <ClipboardPasteIcon className="size-4" />
                </Button>
            </TooltipLabeled>
            {onToggleCapture && (
                <TooltipLabeled label={captureLabel} side="bottom">
                    <Button aria-label={captureLabel} size="icon-sm" variant="ghost" disabled={disabled} onClick={onToggleCapture}>
                        <CircleIcon className={cn('size-4', capturing ? 'fill-red-500 text-red-500' : 'text-muted-foreground')} />
                    </Button>
                </TooltipLabeled>
            )}
            {onToggleHold &&
                (holding ? (
                    <Button size="sm" disabled={disabled} onClick={onToggleHold}>
                        I’m done
                    </Button>
                ) : (
                    <Button size="sm" variant="secondary" disabled={disabled} onClick={onToggleHold}>
                        <HandIcon className="size-3.5" />
                        Take over
                    </Button>
                ))}
            {onDone && (
                <Button size="sm" disabled={disabled} onClick={onDone}>
                    Done
                </Button>
            )}
            <DialogClose asChild>
                <Button aria-label="Close" size="icon-sm" variant="ghost">
                    <XIcon className="size-4" />
                </Button>
            </DialogClose>
        </div>
    )
}
