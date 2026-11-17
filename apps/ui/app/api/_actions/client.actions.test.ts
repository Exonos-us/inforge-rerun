import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ClientView } from '@/app/api/_services/client.service'

const mocks = vi.hoisted(() => ({
    requireWorkspaceContext: vi.fn(),
    assertSpaceAccess: vi.fn(),
    listClients: vi.fn(),
    getClient: vi.fn(),
    createClient: vi.fn(),
    updateClient: vi.fn(),
    deleteClient: vi.fn(),
    applyClientExtras: vi.fn(),
    removeClientExtras: vi.fn(),
    syncClient: vi.fn(),
    pendingSyncCount: vi.fn(),
    getSpaceConnection: vi.fn(),
    listSkillSummaries: vi.fn(),
    selectMany: vi.fn(),
    selectMaybeSingle: vi.fn(),
}))

vi.mock('@/app/api/_auth/ownership', () => ({ requireWorkspaceContext: mocks.requireWorkspaceContext }))
vi.mock('@/app/api/_auth/access', () => ({ assertSpaceAccess: mocks.assertSpaceAccess }))
vi.mock('@/app/api/_services/client.service', () => ({
    applyClientExtras: mocks.applyClientExtras,
    createClient: mocks.createClient,
    deleteClient: mocks.deleteClient,
    getClient: mocks.getClient,
    listClients: mocks.listClients,
    pendingSyncCount: mocks.pendingSyncCount,
    removeClientExtras: mocks.removeClientExtras,
    syncClient: mocks.syncClient,
    updateClient: mocks.updateClient,
}))
vi.mock('@/app/api/_services/space.service', () => ({ getSpaceConnection: mocks.getSpaceConnection }))
vi.mock('@/lib/engine/client', () => ({ listSkillSummaries: mocks.listSkillSummaries }))
vi.mock('@/supabase/supabase-helpers', () => ({ selectMany: mocks.selectMany, selectMaybeSingle: mocks.selectMaybeSingle }))

const { createClientAction, deleteClientAction, listClientsAction, retryClientSyncAction, setBoxClientAction, updateClientAction } = await import('./client.actions')

const WORKSPACE_ID = 7
const MDC = 'client-mdc'
const CITY = 'client-city'
const BOX = 'space-1'

type Write = { table: string; payload: Record<string, unknown>; filters: [string, unknown][] }

const writes: Write[] = []

const supabase = {
    from(table: string) {
        return {
            update(payload: Record<string, unknown>) {
                const write: Write = { table, payload, filters: [] }
                const builder = {
                    eq(column: string, value: unknown) {
                        write.filters.push([column, value])
                        return builder
                    },
                    then<T>(onFulfilled: (value: unknown) => T) {
                        writes.push(write)
                        reads.calls.push(table === 'spaces' ? 'point' : `mark:${write.payload.client_revision === null ? 'none' : write.filters.find(([column]) => column === 'id')?.[1]}`)
                        return Promise.resolve({ error: null }).then(onFulfilled)
                    },
                }
                return builder
            },
        }
    },
}

function client(overrides: Partial<ClientView> = {}): ClientView {
    return {
        id: MDC,
        name: 'Miami-Dade County',
        shortCode: 'mdc',
        skills: [{ name: 'Doc format', description: 'How a memo is laid out', body: 'Use the county template.', raw: '', files: [] }],
        knowledgeDocs: [],
        confluence: null,
        revision: 5,
        updatedAt: '2026-11-17T09:00:00Z',
        ...overrides,
    }
}

type AgentRow = { id: string; name: string; space_id: string; engine_agent_id: string | null; client_revision: number | null }
type SpaceRow = { id: string; name: string; client_id: string | null }

const reads = {
    box: null as { id: string; client_id: string | null } | null,
    spaces: [] as SpaceRow[],
    agents: [] as AgentRow[],
    clients: [] as ClientView[],
    calls: [] as string[],
}

function coworker(id: string, overrides: Partial<AgentRow> = {}): AgentRow {
    return { id, name: id.toUpperCase(), space_id: BOX, engine_agent_id: `engine-${id}`, client_revision: null, ...overrides }
}

beforeEach(() => {
    vi.resetAllMocks()
    writes.length = 0
    reads.box = { id: BOX, client_id: null }
    reads.spaces = []
    reads.agents = []
    reads.clients = [client()]
    reads.calls = []

    mocks.requireWorkspaceContext.mockResolvedValue({ userId: 'user-me', workspace: { id: WORKSPACE_ID }, supabase })
    mocks.assertSpaceAccess.mockResolvedValue({ actor: { kind: 'user' }, access: 'manage' })
    mocks.listClients.mockImplementation(async () => reads.clients)
    mocks.getClient.mockImplementation(async (_supabase: unknown, _workspaceId: number, clientId: string) => reads.clients.find(row => row.id === clientId) ?? null)
    mocks.updateClient.mockResolvedValue(undefined)
    mocks.deleteClient.mockResolvedValue(undefined)
    mocks.syncClient.mockResolvedValue({ synced: 0, pending: 0, warnings: [] })
    mocks.pendingSyncCount.mockResolvedValue(0)
    mocks.applyClientExtras.mockImplementation(async (_client: unknown, _spaceId: string, agent: AgentRow) => {
        reads.calls.push(`apply:${agent.id}`)
    })
    mocks.removeClientExtras.mockImplementation(async (_client: unknown, _spaceId: string, agent: AgentRow) => {
        reads.calls.push(`remove:${agent.id}`)
    })
    mocks.getSpaceConnection.mockResolvedValue({ baseUrl: 'https://engine.test', apiKey: 'k' })
    mocks.listSkillSummaries.mockResolvedValue([])
    mocks.selectMaybeSingle.mockImplementation(async () => ({ data: reads.box, error: null }))
    mocks.selectMany.mockImplementation((async (_supabase: unknown, table: string) => {
        if (table === 'spaces') return { data: reads.spaces, error: null }
        return { data: reads.agents.filter(agent => agent.engine_agent_id !== null), error: null }
    }) as never)
})

const pointerWrites = () => writes.filter(write => write.table === 'spaces')
const revisionWrites = () => writes.filter(write => write.table === 'agents')

describe('updateClientAction', () => {
    it('refuses a short code another client holds, on the code input rather than as a toast', async () => {
        reads.clients = [client(), client({ id: CITY, name: 'Miami-Dade City', shortCode: 'mdc2' })]

        const result = await updateClientAction({ clientId: MDC, shortCode: 'MDC2' })

        expect(result).toEqual({ ok: false, error: '"mdc2" is already Miami-Dade City\'s code.', field: 'shortCode' })
        expect(mocks.updateClient).not.toHaveBeenCalled()
    })

    it('leaves a client free to keep its own code', async () => {
        await expect(updateClientAction({ clientId: MDC, shortCode: 'mdc' })).resolves.toMatchObject({ ok: true })
        expect(mocks.updateClient).toHaveBeenCalled()
    })

    it('puts the unique violation on the code input when the collision only shows up in Postgres', async () => {
        mocks.updateClient.mockRejectedValue(new Error('duplicate key value violates unique constraint "clients_workspace_short_code_idx"'))

        await expect(updateClientAction({ clientId: MDC, shortCode: 'mdc3' })).resolves.toEqual({ ok: false, error: 'Another client already uses this code.', field: 'shortCode' })
    })

    it('puts a blank code on the code input too', async () => {
        await expect(updateClientAction({ clientId: MDC, shortCode: '  ' })).resolves.toEqual({ ok: false, error: 'A client needs a short code.', field: 'shortCode' })
        expect(mocks.updateClient).not.toHaveBeenCalled()
    })

    it('keeps an error with no field as a plain refusal', async () => {
        mocks.updateClient.mockRejectedValue(new Error('connection reset'))

        await expect(updateClientAction({ clientId: MDC, name: 'Renamed' })).resolves.toEqual({ ok: false, error: 'connection reset' })
    })

    it('syncs the coworkers after the patch and hands back what landed', async () => {
        mocks.syncClient.mockResolvedValue({ synced: 3, pending: 1, warnings: ['"AVA" did not get "Doc format" from Miami-Dade County.'] })

        const result = await updateClientAction({ clientId: MDC, name: 'Miami-Dade County' })

        expect(result).toMatchObject({ ok: true, sync: { synced: 3, pending: 1 } })
        expect(mocks.updateClient.mock.invocationCallOrder[0]).toBeLessThan(mocks.syncClient.mock.invocationCallOrder[0])
    })

    it('refuses a document that leaves its folder', async () => {
        await expect(updateClientAction({ clientId: MDC, knowledge: [{ path: '../escape.md', content: 'x' }] })).resolves.toEqual({ ok: false, error: 'A document name cannot leave its folder.' })
        expect(mocks.updateClient).not.toHaveBeenCalled()
    })

    it('passes the revision it read, so the bump is never skipped', async () => {
        await updateClientAction({ clientId: MDC, name: 'Renamed' })

        expect(mocks.updateClient).toHaveBeenCalledWith(supabase, WORKSPACE_ID, MDC, { name: 'Renamed' }, 5)
    })
})

describe('setBoxClientAction', () => {
    it('refuses someone who cannot manage the Box, before anything is written', async () => {
        mocks.assertSpaceAccess.mockRejectedValue(new Error('Only an admin or a manager of this Box can do this'))

        await expect(setBoxClientAction({ spaceId: BOX, clientId: MDC })).resolves.toEqual({ ok: false, error: 'Only an admin or a manager of this Box can do this' })
        expect(writes).toHaveLength(0)
        expect(mocks.applyClientExtras).not.toHaveBeenCalled()
    })

    it('asks for manage, not use', async () => {
        await setBoxClientAction({ spaceId: BOX, clientId: MDC })

        expect(mocks.assertSpaceAccess).toHaveBeenCalledWith(BOX, 'manage')
    })

    it('removes the previous client from every coworker before pointing the Box at the new one', async () => {
        reads.box = { id: BOX, client_id: CITY }
        reads.clients = [client(), client({ id: CITY, name: 'Miami-Dade City', shortCode: 'mdc2' })]
        reads.agents = [coworker('a1'), coworker('a2')]

        const result = await setBoxClientAction({ spaceId: BOX, clientId: MDC })

        expect(result).toMatchObject({ ok: true, result: { cleared: 2, applied: 2, pending: 0 } })
        expect(reads.calls).toEqual(['remove:a1', 'remove:a2', 'point', 'mark:none', 'apply:a1', 'mark:a1', 'apply:a2', 'mark:a2'])
    })

    it('only ever removes the client the Box is leaving', async () => {
        reads.box = { id: BOX, client_id: CITY }
        reads.clients = [client(), client({ id: CITY, name: 'Miami-Dade City', shortCode: 'mdc2' })]
        reads.agents = [coworker('a1')]

        await setBoxClientAction({ spaceId: BOX, clientId: MDC })

        expect(mocks.removeClientExtras).toHaveBeenCalledTimes(1)
        expect(mocks.removeClientExtras.mock.calls[0][0]).toMatchObject({ id: CITY })
    })

    it('hands removeClientExtras the slugs the engine actually reports', async () => {
        reads.box = { id: BOX, client_id: CITY }
        reads.clients = [client(), client({ id: CITY, name: 'Miami-Dade City', shortCode: 'mdc2' })]
        reads.agents = [coworker('a1')]
        mocks.listSkillSummaries.mockResolvedValue([{ slug: `client-${CITY}-doc-format` }, { slug: 'own-skill' }])

        await setBoxClientAction({ spaceId: BOX, clientId: MDC })

        expect(mocks.removeClientExtras.mock.calls[0][3]).toEqual([`client-${CITY}-doc-format`, 'own-skill'])
    })

    it('does not let one coworker whose removal failed hold up the rest', async () => {
        reads.box = { id: BOX, client_id: CITY }
        reads.clients = [client(), client({ id: CITY, name: 'Miami-Dade City', shortCode: 'mdc2' })]
        reads.agents = [coworker('a1'), coworker('a2')]
        mocks.removeClientExtras.mockImplementationOnce(async () => {
            throw new Error('engine down')
        })

        const result = await setBoxClientAction({ spaceId: BOX, clientId: MDC })

        expect(result).toMatchObject({ ok: true, result: { cleared: 1 } })
        expect(mocks.removeClientExtras).toHaveBeenCalledTimes(2)
        expect(mocks.applyClientExtras).toHaveBeenCalledTimes(2)
        expect((result as { result: { warnings: string[] } }).result.warnings).toEqual(['"A1" kept Miami-Dade City\'s skills and documents.'])
    })

    it('clears the revision mark, which is not comparable across two clients', async () => {
        reads.box = { id: BOX, client_id: CITY }
        reads.clients = [client(), client({ id: CITY, name: 'Miami-Dade City', shortCode: 'mdc2' })]
        reads.agents = [coworker('a1', { client_revision: 9 })]

        await setBoxClientAction({ spaceId: BOX, clientId: MDC })

        const cleared = revisionWrites().find(write => write.payload.client_revision === null)
        expect(cleared).toMatchObject({
            filters: [
                ['space_id', BOX],
                ['workspace_id', WORKSPACE_ID],
            ],
        })
        expect(revisionWrites().at(-1)).toMatchObject({
            payload: { client_revision: 5 },
            filters: [
                ['id', 'a1'],
                ['workspace_id', WORKSPACE_ID],
            ],
        })
    })

    it('leaves a coworker trailing when its install warned', async () => {
        reads.agents = [coworker('a1'), coworker('a2')]
        mocks.applyClientExtras.mockImplementationOnce(async (_client: unknown, _spaceId: string, _agent: unknown, warnings: string[]) => {
            warnings.push('"A1" did not get "Doc format" from Miami-Dade County.')
        })

        const result = await setBoxClientAction({ spaceId: BOX, clientId: MDC })

        expect(result).toMatchObject({ ok: true, result: { applied: 1, pending: 1 } })
        expect(revisionWrites().filter(write => write.payload.client_revision === 5)).toHaveLength(1)
    })

    it('clears a Box’s client without installing anything', async () => {
        reads.box = { id: BOX, client_id: MDC }
        reads.agents = [coworker('a1')]

        const result = await setBoxClientAction({ spaceId: BOX, clientId: null })

        expect(result).toMatchObject({ ok: true, result: { client: null, cleared: 1 } })
        expect(mocks.applyClientExtras).not.toHaveBeenCalled()
        expect(pointerWrites()).toMatchObject([{ payload: { client_id: null } }])
    })

    it('does nothing when the Box already points at that client', async () => {
        reads.box = { id: BOX, client_id: MDC }
        reads.agents = [coworker('a1')]

        const result = await setBoxClientAction({ spaceId: BOX, clientId: MDC })

        expect(result).toMatchObject({ ok: true, result: { cleared: 0, applied: 0 } })
        expect(writes).toHaveLength(0)
        expect(mocks.removeClientExtras).not.toHaveBeenCalled()
        expect(mocks.applyClientExtras).not.toHaveBeenCalled()
    })

    it('refuses a client that is not this workspace’s', async () => {
        await expect(setBoxClientAction({ spaceId: BOX, clientId: 'client-elsewhere' })).resolves.toEqual({ ok: false, error: 'Could not find the client' })
        expect(writes).toHaveLength(0)
    })
})

describe('deleteClientAction', () => {
    it('names the Boxes and the coworkers the confirm has to mention', async () => {
        reads.spaces = [{ id: BOX, name: 'Permitting', client_id: MDC }]
        reads.agents = [coworker('a1'), coworker('a2')]
        mocks.pendingSyncCount.mockResolvedValue(1)

        const result = await deleteClientAction({ clientId: MDC })

        expect(result).toEqual({ ok: true, usage: { boxes: [{ id: BOX, name: 'Permitting' }], coworkers: 2, pending: 1 } })
    })

    it('leaves the coworkers their skills: deleting a client is tidying a list, not stripping an engagement', async () => {
        reads.spaces = [{ id: BOX, name: 'Permitting', client_id: MDC }]
        reads.agents = [coworker('a1')]

        await deleteClientAction({ clientId: MDC })

        expect(mocks.removeClientExtras).not.toHaveBeenCalled()
        expect(mocks.deleteClient).toHaveBeenCalledWith(supabase, WORKSPACE_ID, MDC)
    })
})

describe('listClientsAction', () => {
    it('counts the Boxes and the coworkers behind each client', async () => {
        reads.clients = [client(), client({ id: CITY, name: 'Miami-Dade City', shortCode: 'mdc2', revision: 2 })]
        reads.spaces = [
            { id: BOX, name: 'Permitting', client_id: MDC },
            { id: 'space-2', name: 'Transit', client_id: CITY },
        ]
        reads.agents = [coworker('a1'), coworker('a2'), coworker('a3', { space_id: 'space-2' }), coworker('a4', { space_id: 'space-3' })]
        mocks.pendingSyncCount.mockResolvedValueOnce(2).mockResolvedValueOnce(0)

        const result = await listClientsAction()

        expect(result).toMatchObject({
            ok: true,
            clients: [
                { id: MDC, boxes: [{ id: BOX, name: 'Permitting' }], coworkers: 2, pending: 2 },
                { id: CITY, boxes: [{ id: 'space-2', name: 'Transit' }], coworkers: 1, pending: 0 },
            ],
        })
    })

    it('reports a client no Box points at as unused', async () => {
        const result = await listClientsAction()

        expect(result).toMatchObject({ ok: true, clients: [{ id: MDC, boxes: [], coworkers: 0, pending: 0 }] })
    })
})

describe('createClientAction and retryClientSyncAction', () => {
    it('refuses a client with no name', async () => {
        await expect(createClientAction({ name: '  ' })).resolves.toEqual({ ok: false, error: 'A client needs a name.' })
        expect(mocks.createClient).not.toHaveBeenCalled()
    })

    it('hands back the client it just created', async () => {
        mocks.createClient.mockResolvedValue(MDC)

        await expect(createClientAction({ name: 'Miami-Dade County' })).resolves.toEqual({ ok: true, client: client() })
    })

    it('retries the sync and returns its counts', async () => {
        mocks.syncClient.mockResolvedValue({ synced: 2, pending: 0, warnings: [] })

        await expect(retryClientSyncAction({ clientId: MDC })).resolves.toEqual({ ok: true, sync: { synced: 2, pending: 0, warnings: [] } })
    })
})
