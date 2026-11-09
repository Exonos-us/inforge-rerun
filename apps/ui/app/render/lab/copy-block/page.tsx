'use client'

import { ImportAgentDialog } from '@/components/dialogs/ImportAgentDialog'
import { useState } from 'react'

// Temporary lab: the import dialog has no entry in the app yet, this mounts it open so the wrapped
// CopyBlock can be captured with the real prompt. Removed before the commit.
export default function CopyBlockLab() {
    const [open, setOpen] = useState(true)
    return (
        <div className="min-h-dvh bg-background">
            <ImportAgentDialog open={open} onOpenChange={setOpen} />
        </div>
    )
}
