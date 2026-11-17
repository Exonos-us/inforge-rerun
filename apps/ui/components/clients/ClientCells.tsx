import type { ClientListEntry } from '@/app/api/_actions/client.actions'
import { Badge } from '@rerun/ui/primitives'
import type { ReactNode } from 'react'

// The small pieces the table and the stacked rows both draw, kept in one place so a client reads
// the same whichever of the two the viewport picked.

// Three states and no more: a client no Box points at, one every coworker is level with, and one
// a number of coworkers are trailing behind.
export function ClientStatusBadge({ coworkers, pending }: { coworkers: number; pending: number }) {
    if (pending > 0) {
        return (
            <Badge size="xs" tone="orange" glow={false} className="font-medium">
                {pending} to sync
            </Badge>
        )
    }
    if (coworkers === 0) {
        return (
            <Badge size="xs" tone="neutral" glow={false} className="font-medium">
                Not in use
            </Badge>
        )
    }
    return (
        <Badge size="xs" tone="green" glow={false} className="font-medium">
            Synced
        </Badge>
    )
}

export function ClientShortCode({ code }: { code: string }) {
    return (
        <Badge size="xs" tone="neutral" glow={false} className="font-mono">
            {code}
        </Badge>
    )
}

export function plural(count: number, noun: string): string {
    return `${count} ${noun}${count === 1 ? '' : 's'}`
}

export function clientSummaryLine(client: ClientListEntry): string {
    return [
        client.skills.length ? plural(client.skills.length, 'skill') : 'no skill',
        client.knowledgeDocs.length ? plural(client.knowledgeDocs.length, 'doc') : 'no doc',
        client.coworkers ? plural(client.coworkers, 'coworker') : 'no coworker',
    ].join(' · ')
}

export function boxCount(count: number): string {
    return count === 1 ? '1 Box' : `${count} Boxes`
}

export function clientUsageLine(client: ClientListEntry): string {
    if (client.boxes.length === 0) return 'No Box points at this client yet.'
    return `Used by ${plural(client.coworkers, 'coworker')} across ${boxCount(client.boxes.length)}: ${client.boxes.map(box => box.name).join(', ')}.`
}

export function HighlightMatch({ text, query }: { text: string; query: string }): ReactNode {
    const needle = query.trim().toLowerCase()
    const at = needle ? text.toLowerCase().indexOf(needle) : -1
    if (at < 0) return text
    return (
        <>
            {text.slice(0, at)}
            <mark className="rounded-xs bg-foreground/15 text-inherit">{text.slice(at, at + needle.length)}</mark>
            {text.slice(at + needle.length)}
        </>
    )
}
