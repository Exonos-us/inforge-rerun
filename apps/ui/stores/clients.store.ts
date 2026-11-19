import { create } from 'zustand'
import { toast } from 'sonner'

import { createClientAction, deleteClientAction, listClientsAction, retryClientSyncAction, setBoxClientAction, updateClientAction, type ClientListEntry } from '@/app/api/_actions/client.actions'

// The workspace's clients, read once and shared by everything that shows them: the Clients panel,
// the Box context menu, its picker and the Start project wizard. A right-click on a Box is not a
// reason to go back to the server, so the list is cached — but the menu names the client of a Box,
// and a name that is no longer true is read as configuration rather than as a stale count. So every
// write goes through this store instead of calling its action directly, and the cache cannot be
// left behind by a caller that forgot it.

type ClientsState = {
    clients: ClientListEntry[] | null
    ensure: () => Promise<void>
    reload: () => Promise<void>
    create: typeof createClientAction
    update: typeof updateClientAction
    remove: typeof deleteClientAction
    setBoxClient: typeof setBoxClientAction
    retrySync: typeof retryClientSyncAction
}

export const useClientsStore = create<ClientsState>((set, get) => {
    // The two reads a panel and a menu mounting together would fire are one, and a read a write
    // started always wins over one that left before it.
    let reading: Promise<void> | null = null
    let generation = 0

    const read = async (): Promise<void> => {
        const ticket = ++generation
        const result = await listClientsAction().catch(() => null)
        if (ticket !== generation) return
        if (!result) toast.error('The clients did not load. Reload the page and try again.')
        else if (result.ok) set({ clients: result.clients })
        else toast.error(result.error)
    }

    const reload = (): Promise<void> => {
        const run = read().finally(() => {
            if (reading === run) reading = null
        })
        reading = run
        return run
    }

    // A write that threw halfway may still have changed rows, so the list is read back either way.
    const afterWrite = async <T>(call: Promise<T>): Promise<T> => {
        try {
            return await call
        } finally {
            await reload()
        }
    }

    return {
        clients: null,
        ensure: () => (get().clients !== null ? Promise.resolve() : (reading ?? reload())),
        reload,
        create: params => afterWrite(createClientAction(params)),
        update: params => afterWrite(updateClientAction(params)),
        remove: params => afterWrite(deleteClientAction(params)),
        setBoxClient: params => afterWrite(setBoxClientAction(params)),
        retrySync: params => afterWrite(retryClientSyncAction(params)),
    }
})
