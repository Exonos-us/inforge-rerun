'use client'

import type { BoxClientResult } from '@/app/api/_actions/client.actions'
import { plural } from '@/components/clients/ClientCells'
import { CheckIcon, TriangleAlertIcon } from '@/lib/icons'
import { PANEL_CARD } from '@/components/ui/panel-row'
import { cn } from '@/lib/utils'

// What a change of client actually did to the coworkers standing in the Box. The counts come back
// per coworker, so a machine that was down reads as its own line rather than being swallowed by a
// success message the user cannot check.

export type BoxClientChange = { previous: string | null; next: string | null; result: BoxClientResult }

const WARNINGS_SHOWN = 3

type ReportLine = { tone: 'ok' | 'warn'; text: string }

function linesOf({ previous, next, result }: BoxClientChange): ReportLine[] {
    const lines: ReportLine[] = []
    if (previous && result.cleared > 0) lines.push({ tone: 'ok', text: `${plural(result.cleared, 'coworker')} no longer carry ${previous}’s skills and documents.` })
    if (next && result.applied > 0) lines.push({ tone: 'ok', text: `${plural(result.applied, 'coworker')} now carry ${next}’s skills and documents.` })
    if (result.pending > 0) lines.push({ tone: 'warn', text: `${plural(result.pending, 'coworker')} did not get them. It lands when their machine is back.` })
    for (const warning of result.warnings.slice(0, WARNINGS_SHOWN)) lines.push({ tone: 'warn', text: warning })
    if (result.warnings.length > WARNINGS_SHOWN) lines.push({ tone: 'warn', text: `${result.warnings.length - WARNINGS_SHOWN} more coworkers in the same state.` })
    if (lines.length === 0) lines.push({ tone: 'ok', text: next ? 'No coworker lives in this Box yet, so there was nothing to install.' : 'This Box no longer has a client.' })
    return lines
}

export function BoxClientSyncReport({ change }: { change: BoxClientChange }) {
    return (
        <div className={cn('flex flex-col gap-2 p-3', PANEL_CARD)}>
            {linesOf(change).map(line => (
                <div key={line.text} className="flex items-start gap-2 text-xs">
                    {line.tone === 'ok' ? <CheckIcon className="mt-0.5 size-3.5 shrink-0 text-emerald-500" /> : <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0 text-amber-500" />}
                    <span className={cn('min-w-0', line.tone === 'ok' ? 'text-foreground' : 'text-muted-foreground')}>{line.text}</span>
                </div>
            ))}
        </div>
    )
}
