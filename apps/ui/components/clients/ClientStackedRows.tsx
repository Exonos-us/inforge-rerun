'use client'

import type { ClientListEntry } from '@/app/api/_actions/client.actions'
import { ClientShortCode, ClientStatusBadge, clientSummaryLine, HighlightMatch } from '@/components/clients/ClientCells'
import { PanelRow } from '@/components/ui/panel-row'

// What the table becomes under `sm`: one card per client, its numbers read as a sentence. A table
// that narrow would either scroll sideways or squeeze its columns to nothing.
export function ClientStackedRows({ clients, query, onOpen }: { clients: ClientListEntry[]; query: string; onOpen: (clientId: string) => void }) {
    return (
        <div className="space-y-2 p-3">
            {clients.map(client => (
                <PanelRow
                    key={client.id}
                    onClick={() => onOpen(client.id)}
                    title={
                        <span className="flex min-w-0 items-center gap-1.5">
                            <span className="truncate">
                                <HighlightMatch text={client.name} query={query} />
                            </span>
                            <ClientShortCode code={client.shortCode} />
                        </span>
                    }
                    description={clientSummaryLine(client)}
                    meta={<ClientStatusBadge coworkers={client.coworkers} pending={client.pending} />}
                />
            ))}
        </div>
    )
}
