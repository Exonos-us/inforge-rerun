'use client'

import type { ReactNode } from 'react'

import { PanelDialogContent } from '@/components/dialogs/PanelDialogContent'
import { Dialog, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'

type DesktopDialogProps = {
    open: boolean
    onOpenChange: (open: boolean) => void
    title: string
    description: string
    children: ReactNode
}

// Where the screen of an agent is used, full-bleed: the whole window from tablet width up, and the
// bottom sheet grown to its full height on a phone.
export function DesktopDialog({ open, onOpenChange, title, description, children }: DesktopDialogProps) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <PanelDialogContent
                className="max-sm:h-[calc(96dvh-var(--consent-inset))] sm:h-dvh sm:max-h-dvh sm:max-w-full sm:rounded-none"
                showCloseButton={false}
                // Escape belongs to the machine on the screen: it closes a menu there, not this dialog.
                onEscapeKeyDown={event => event.preventDefault()}
            >
                <DialogHeader className="sr-only">
                    <DialogTitle>{title}</DialogTitle>
                    <DialogDescription>{description}</DialogDescription>
                </DialogHeader>
                {children}
            </PanelDialogContent>
        </Dialog>
    )
}
