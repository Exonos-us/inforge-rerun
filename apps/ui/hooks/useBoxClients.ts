'use client'

import type { ClientListEntry } from '@/app/api/_actions/client.actions'
import { useClientsStore } from '@/stores/clients.store'
import { useEffect } from 'react'

export function clientOfBox(clients: ClientListEntry[] | null, spaceId: string | null | undefined): ClientListEntry | null {
    if (!clients || !spaceId) return null
    return clients.find(client => client.boxes.some(box => box.id === spaceId)) ?? null
}

// Subscribes to the shared list and asks for it the first time something needs it: a right-click on
// a Box is not a reason to go back to the server. The whole list comes down in one action, and it
// already carries the Boxes each client stands behind, so the client of one Box is found in it
// without a read of its own. Staying fresh is the store's job — every write invalidates it there.
export function useBoxClients(active: boolean): ClientListEntry[] | null {
    const clients = useClientsStore(state => state.clients)
    const ensure = useClientsStore(state => state.ensure)

    useEffect(() => {
        if (active) void ensure()
    }, [active, ensure])

    return clients
}
