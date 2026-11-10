'use client'

import { PanelDialogContent } from '@/components/dialogs/PanelDialogContent'
import { SlackPanel } from '@/components/slack/SlackPanel'
import { Dialog, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'

// Slack belongs to the workspace, like the AI providers: one app for the whole board, and each
// coworker appears in the channels it was given.
export function SlackDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <PanelDialogContent className="sm:h-[min(48rem,90dvh)] sm:max-w-2xl">
                <DialogHeader className="border-b px-4 py-4">
                    <DialogTitle>Slack</DialogTitle>
                    <DialogDescription>Put your coworkers in Slack channels and talk to them there.</DialogDescription>
                </DialogHeader>

                <div className="flex min-h-0 flex-1 flex-col">
                    <SlackPanel />
                </div>
            </PanelDialogContent>
        </Dialog>
    )
}
