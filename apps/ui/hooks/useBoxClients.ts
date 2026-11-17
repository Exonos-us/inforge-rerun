'use client'

import { listClientsAction, type ClientListEntry } from '@/app/api/_actions/client.actions'
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'

export function clientOfBox(clients: ClientListEntry[] | null, spaceId: string | null | undefined): ClientListEntry | null {
    if (!clients || !spaceId) return null
    return clients.find(client => client.boxes.some(box => box.id === spaceId)) ?? null
}

// The workspace's clients, read the first time something asks for them and kept until a write asks
// for them again: a right-click on a Box is not a reason to go back to the server. The whole list
// comes down in one action, and it already carries the Boxes each client stands behind, so the
// client of one Box is found in it without a read of its own.
export function useBoxClients(active: boolean): { clients: ClientListEntry[] | null; reload: () => Promise<void> } {
    const [clients, setClients] = useState<ClientListEntry[] | null>(null)
    const reading = useRef(false)

    const reload = useCallback(async (): Promise<void> => {
        reading.current = true
        const result = await listClientsAction().catch(() => null)
        reading.current = false
        if (!result) {
            toast.error('The clients did not load. Reload the page and try again.')
            return
        }
        if (result.ok) setClients(result.clients)
        else toast.error(result.error)
    }, [])

    useEffect(() => {
        if (!active || clients !== null || reading.current) return
        void reload()
    }, [active, clients, reload])

    return { clients, reload }
}
