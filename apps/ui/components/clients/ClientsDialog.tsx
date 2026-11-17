'use client'

import { createClientAction, listClientsAction, type ClientListEntry } from '@/app/api/_actions/client.actions'
import { ClientDetail } from '@/components/clients/ClientDetail'
import { ClientsTable } from '@/components/clients/ClientsTable'
import { PanelDialogContent } from '@/components/dialogs/PanelDialogContent'
import { Dialog, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { PanelSteps } from '@/components/ui/panel-steps'
import { Building2 } from '@/lib/icons'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'

// The Clients panel: who the workspace works for, and how each of them likes things done. The
// whole list comes down in one action, so searching and sorting it never goes back to the server.
export function ClientsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
    const [clients, setClients] = useState<ClientListEntry[] | null>(null)
    const [openId, setOpenId] = useState<string | null>(null)
    const [creating, setCreating] = useState(false)

    const load = useCallback(async () => {
        const result = await listClientsAction().catch(() => null)
        if (!result) {
            toast.error('The clients did not load. Reload the page and try again.')
            return
        }
        if (result.ok) setClients(result.clients)
        else toast.error(result.error)
    }, [])

    useEffect(() => {
        if (!open) return
        setOpenId(null)
        setClients(null)
        void load()
    }, [open, load])

    const create = async (name: string) => {
        setCreating(true)
        const result = await createClientAction({ name }).catch(() => null)
        setCreating(false)
        if (!result) {
            toast.error('Could not create the client')
            return
        }
        if (!result.ok) {
            toast.error(result.error)
            return
        }
        await load()
        setOpenId(result.client.id)
    }

    // A client deleted from its own page leaves the panel on the list rather than on a row that
    // no longer reads.
    const client = openId ? (clients?.find(entry => entry.id === openId) ?? null) : null

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <PanelDialogContent className="sm:h-[min(44rem,88dvh)] sm:max-w-3xl">
                <DialogHeader className="border-b px-4 py-4">
                    <div className="flex items-center gap-3">
                        <span className="grid size-9 shrink-0 place-items-center rounded-md bg-muted">
                            <Building2 className="size-4.5 text-muted-foreground" />
                        </span>
                        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                            <DialogTitle>Clients</DialogTitle>
                            <DialogDescription>Who you work for, and how they like things done.</DialogDescription>
                        </div>
                    </div>
                </DialogHeader>
                <div className="flex min-h-0 flex-1 flex-col">
                    <PanelSteps stepKey={client ? client.id : 'list'} depth={client ? 1 : 0}>
                        {client ? <ClientDetail client={client} onBack={() => setOpenId(null)} reload={load} /> : <ClientsTable clients={clients} creating={creating} onOpen={setOpenId} onCreate={create} />}
                    </PanelSteps>
                </div>
            </PanelDialogContent>
        </Dialog>
    )
}
