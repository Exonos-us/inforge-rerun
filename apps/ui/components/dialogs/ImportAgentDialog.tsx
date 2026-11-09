'use client'

import { createImportKeyAction } from '@/app/api/_actions/api-keys.actions'
import { CopyBlock } from '@/components/dialogs/CopyBlock'
import { CopyLine } from '@/components/dialogs/CopyLine'
import { ImportSourcePicker } from '@/components/dialogs/ImportSourcePicker'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field } from '@/components/ui/field'
import { Skeleton } from '@/components/ui/skeleton'
import { importSource, type ImportSourceId } from '@/lib/agent-import/sources'
import { track } from '@rerun/analytics/client'
import { ScrollFade } from '@rerun/ui/primitives'
import { useRef, useState } from 'react'
import { toast } from 'sonner'

type Prepared = { source: ImportSourceId; connectorUrl: string; prompt: string }

function PreparedSkeleton() {
    return (
        <div className="space-y-3">
            <div className="space-y-1.5">
                <Skeleton className="h-3 w-24" />
                <Skeleton className="h-8 w-full" />
            </div>
            <div className="space-y-1.5">
                <Skeleton className="h-3 w-16" />
                <Skeleton className="h-40 w-full" />
            </div>
        </div>
    )
}

// Each source pick mints its own import key: one key per attempt, so a prompt pasted in the wrong
// agent never shares a coworker with the right one. Closing the dialog drops the key from memory;
// it still expires on its own a day later.
export function ImportAgentDialog({ open, onOpenChange, spaceId = null }: { open: boolean; onOpenChange: (open: boolean) => void; spaceId?: string | null }) {
    const [source, setSource] = useState<ImportSourceId | null>(null)
    const [prepared, setPrepared] = useState<Prepared | null>(null)
    const latest = useRef<ImportSourceId | null>(null)

    const pick = async (next: ImportSourceId) => {
        if (next === source) return
        setSource(next)
        setPrepared(null)
        latest.current = next
        const result = await createImportKeyAction(next, spaceId)
        if (latest.current !== next) return
        if (!result.ok) {
            toast.error(result.error)
            setSource(null)
            return
        }
        track('agent_import_prepared', { source: next })
        setPrepared({ source: next, connectorUrl: result.connectorUrl, prompt: result.prompt })
    }

    const handleOpenChange = (next: boolean) => {
        if (!next) {
            setSource(null)
            setPrepared(null)
            latest.current = null
        }
        onOpenChange(next)
    }

    const connectorStep = source ? importSource(source).connectorStep : undefined

    return (
        <Dialog open={open} onOpenChange={handleOpenChange}>
            <DialogContent className="flex flex-col sm:max-h-[85dvh] sm:max-w-lg sm:overflow-hidden">
                <DialogHeader>
                    <DialogTitle>Import a coworker</DialogTitle>
                    <DialogDescription>Your agent moves itself here, with its skills, tasks and memory.</DialogDescription>
                </DialogHeader>

                <ScrollFade className="-mx-1 min-h-0 flex-1 px-1 py-1">
                    <div className="space-y-4">
                        <ImportSourcePicker value={source} onChange={pick} />

                        {source && !prepared && <PreparedSkeleton />}

                        {prepared && (
                            <div className="space-y-3">
                                <Field label="Connector URL" helperText={connectorStep}>
                                    <CopyLine value={prepared.connectorUrl} label="Copy the connector URL" />
                                </Field>
                                <Field label={`Paste in ${importSource(prepared.source).label}`} helperText="Expires in 24 hours.">
                                    <CopyBlock value={prepared.prompt} label="Copy the prompt" wrap />
                                </Field>
                            </div>
                        )}
                    </div>
                </ScrollFade>
            </DialogContent>
        </Dialog>
    )
}
