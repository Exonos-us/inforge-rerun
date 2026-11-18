import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ClientListEntry } from '@/app/api/_actions/client.actions'

const actions = vi.hoisted(() => ({
    listClientsAction: vi.fn(),
    createClientAction: vi.fn(),
    updateClientAction: vi.fn(),
    deleteClientAction: vi.fn(),
    setBoxClientAction: vi.fn(),
    retryClientSyncAction: vi.fn(),
}))

vi.mock('@/app/api/_actions/client.actions', () => actions)
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }))

const { useClientsStore } = await import('./clients.store')

const entry = (id: string): ClientListEntry => ({ id, name: id, shortCode: id, skills: [], knowledgeDocs: [], confluence: null, revision: 1, updatedAt: '2026-11-18T00:00:00Z', boxes: [], coworkers: 0, pending: 0 })

const listed = (...clients: ClientListEntry[]) => ({ ok: true as const, clients })

beforeEach(() => {
    vi.clearAllMocks()
    useClientsStore.setState({ clients: null })
})

describe('reading the clients', () => {
    it('reads once for every consumer that mounts, and not again once the list is in', async () => {
        actions.listClientsAction.mockResolvedValue(listed(entry('mdc')))
        const { ensure } = useClientsStore.getState()

        await Promise.all([ensure(), ensure()])
        await ensure()

        expect(actions.listClientsAction).toHaveBeenCalledTimes(1)
        expect(useClientsStore.getState().clients).toEqual([entry('mdc')])
    })
})

describe('a write invalidates the list', () => {
    it('reads the clients back after a delete, so a menu holding the cache loses the client too', async () => {
        actions.listClientsAction.mockResolvedValueOnce(listed(entry('mdc'))).mockResolvedValueOnce(listed())
        actions.deleteClientAction.mockResolvedValue({ ok: true, usage: { boxes: [], coworkers: 0, pending: 0 } })
        const { ensure, remove } = useClientsStore.getState()
        await ensure()

        await remove({ clientId: 'mdc' })

        expect(useClientsStore.getState().clients).toEqual([])
    })

    it('reads them back even when the write threw, because a half-applied write still changed rows', async () => {
        actions.listClientsAction.mockResolvedValue(listed(entry('mdc')))
        actions.setBoxClientAction.mockRejectedValue(new Error('connection reset'))
        const { setBoxClient } = useClientsStore.getState()

        await expect(setBoxClient({ spaceId: 'box', clientId: 'mdc' })).rejects.toThrow('connection reset')
        expect(actions.listClientsAction).toHaveBeenCalledTimes(1)
        expect(useClientsStore.getState().clients).toEqual([entry('mdc')])
    })

    it('never lets a read that left before the write answer the one the write asked for', async () => {
        let settleStale = () => {}
        actions.listClientsAction.mockImplementationOnce(() => new Promise(resolve => (settleStale = () => resolve(listed(entry('mdc')))))).mockResolvedValueOnce(listed())
        actions.deleteClientAction.mockResolvedValue({ ok: true, usage: { boxes: [], coworkers: 0, pending: 0 } })
        const { ensure, remove } = useClientsStore.getState()

        const stale = ensure()
        await remove({ clientId: 'mdc' })
        settleStale()
        await stale

        expect(useClientsStore.getState().clients).toEqual([])
    })
})
