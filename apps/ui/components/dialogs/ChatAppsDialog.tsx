'use client'

import { ChatAppsPanel } from '@/components/chat-apps/ChatAppsPanel'
import { PanelDialogContent } from '@/components/dialogs/PanelDialogContent'
import { Dialog, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'

// Chat apps belong to the workspace, like the AI providers: one connection for the whole board,
// and each coworker appears in the channels it was given. Slack today; the hub is where the next
// app lands without the menu changing.
export function ChatAppsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <PanelDialogContent className="sm:h-[min(48rem,90dvh)] sm:max-w-2xl">
                <DialogHeader className="border-b px-4 py-4">
                    <DialogTitle>Chat apps</DialogTitle>
                    <DialogDescription>Where your coworkers talk with your team.</DialogDescription>
                </DialogHeader>

                <div className="flex min-h-0 flex-1 flex-col">
                    <ChatAppsPanel />
                </div>
            </PanelDialogContent>
        </Dialog>
    )
}
