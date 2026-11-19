import type { Database } from '@/app/api/database.types'
import { selectMany, selectMaybeSingle } from '@/supabase/supabase-helpers'
import type { SupabaseClient } from '@supabase/supabase-js'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createClient, deleteClient, getClient, listClients, toClientViews, updateClient } from './client.service'

vi.mock('@/supabase/supabase-helpers', () => ({ selectMany: vi.fn(), selectMaybeSingle: vi.fn() }))

type ClientRow = Pick<Database['public']['Tables']['clients']['Row'], 'id' | 'name' | 'short_code' | 'skills' | 'knowledge' | 'site_url' | 'cloud_id' | 'space_key' | 'space_name' | 'revision' | 'updated_at'>

function row(overrides: Partial<ClientRow> = {}): ClientRow {
    return {
        id: 'c1',
        name: 'Miami Dade County',
        short_code: 'mdc',
        skills: [],
        knowledge: [],
        site_url: null,
        cloud_id: null,
        space_key: null,
        space_name: null,
        revision: 1,
        updated_at: '2026-11-17T00:00:00Z',
        ...overrides,
    }
}

const writes = {
    table: '',
    inserted: null as Record<string, unknown> | null,
    updated: null as Record<string, unknown> | null,
    deleted: false,
    filters: [] as [string, unknown][],
    insertResult: { data: { id: 'new-client' } as { id: string } | null, error: null as { message: string } | null },
    writeResult: { error: null as { message: string } | null },
}

function chain(result: unknown) {
    const builder = {
        eq(column: string, value: unknown) {
            writes.filters.push([column, value])
            return builder
        },
        select() {
            return builder
        },
        single() {
            return Promise.resolve(result)
        },
        then<T>(onFulfilled: (value: unknown) => T) {
            return Promise.resolve(result).then(onFulfilled)
        },
    }
    return builder
}

const supabase = {
    from(table: string) {
        writes.table = table
        return {
            insert(payload: Record<string, unknown>) {
                writes.inserted = payload
                return chain(writes.insertResult)
            },
            update(payload: Record<string, unknown>) {
                writes.updated = payload
                return chain(writes.writeResult)
            },
            delete() {
                writes.deleted = true
                return chain(writes.writeResult)
            },
        }
    },
} as unknown as SupabaseClient<Database>

function existingCodes(codes: string[]) {
    vi.mocked(selectMany).mockResolvedValue({ data: codes.map(short_code => ({ short_code })), error: null } as never)
}

beforeEach(() => {
    vi.clearAllMocks()
    writes.table = ''
    writes.inserted = null
    writes.updated = null
    writes.deleted = false
    writes.filters = []
    writes.insertResult = { data: { id: 'new-client' }, error: null }
    writes.writeResult = { error: null }
    existingCodes([])
})

describe('toClientViews', () => {
    it('parses a row written by an older build rather than throwing', () => {
        const [client] = toClientViews([row({ skills: 'not-an-array', knowledge: null, revision: 3 })])

        expect(client.skills).toEqual([])
        expect(client.knowledgeDocs).toEqual([])
        expect(client.revision).toBe(3)
    })

    it('keeps the skills and knowledge a current row carries', () => {
        const [client] = toClientViews([
            row({
                skills: [{ name: 'Document format', description: '', body: 'Use the County template.', raw: '', files: [] }],
                knowledge: [{ path: 'acronyms.md', content: 'DERM = ...' }],
            }),
        ])

        expect(client.skills).toEqual([{ name: 'Document format', description: '', body: 'Use the County template.', raw: '', files: [] }])
        expect(client.knowledgeDocs).toEqual([{ path: 'acronyms.md', content: 'DERM = ...' }])
    })

    it('reads the Confluence default space only when there is one', () => {
        const [withSpace] = toClientViews([row({ site_url: 'https://mdc.atlassian.net', cloud_id: 'cloud-1', space_key: 'MDC', space_name: 'Miami Dade' })])
        const [without] = toClientViews([row()])

        expect(withSpace.confluence).toEqual({ siteUrl: 'https://mdc.atlassian.net', cloudId: 'cloud-1', spaceKey: 'MDC', spaceName: 'Miami Dade' })
        expect(without.confluence).toBeNull()
    })
})

describe('listClients', () => {
    it('reads this workspace only, through the typed helper', async () => {
        vi.mocked(selectMany).mockResolvedValue({ data: [row()], error: null } as never)

        const clients = await listClients(supabase, 7)

        expect(clients).toHaveLength(1)
        expect(clients[0].name).toBe('Miami Dade County')
        expect(vi.mocked(selectMany).mock.calls[0][1]).toBe('clients')
        expect(vi.mocked(selectMany).mock.calls[0][3]).toEqual({ workspace_id: 7 })
    })

    it('renders an empty panel when the helper answers nothing', async () => {
        vi.mocked(selectMany).mockResolvedValue({ data: null, error: { message: 'down' } } as never)

        await expect(listClients(supabase, 7)).resolves.toEqual([])
    })
})

describe('getClient', () => {
    it('returns null when the id does not belong to this workspace', async () => {
        vi.mocked(selectMaybeSingle).mockResolvedValue({ data: null, error: null } as never)

        await expect(getClient(supabase, 7, 'c1')).resolves.toBeNull()
        expect(vi.mocked(selectMaybeSingle).mock.calls[0][3]).toEqual({ id: 'c1', workspace_id: 7 })
    })

    it('returns the parsed view when it does', async () => {
        vi.mocked(selectMaybeSingle).mockResolvedValue({ data: row({ revision: 4 }), error: null } as never)

        await expect(getClient(supabase, 7, 'c1')).resolves.toMatchObject({ id: 'c1', shortCode: 'mdc', revision: 4 })
    })
})

describe('createClient', () => {
    it('proposes the initials of the name when nothing holds them', async () => {
        await createClient(supabase, 7, 'user-1', '  Miami Dade County  ')

        expect(writes.inserted).toMatchObject({ workspace_id: 7, name: 'Miami Dade County', short_code: 'mdc', created_by: 'user-1' })
    })

    it('gives the second client a free code when the proposed one is taken', async () => {
        existingCodes(['mdc'])

        await createClient(supabase, 7, 'user-1', 'Miami Dade City')

        expect(writes.inserted?.short_code).toBe('mdc2')
    })

    it('keeps looking until it finds a free code', async () => {
        existingCodes(['mdc', 'mdc2', 'mdc3'])

        await createClient(supabase, 7, 'user-1', 'Monroe Dade Collective')

        expect(writes.inserted?.short_code).toBe('mdc4')
    })

    it('never writes a blank code, whatever the name', async () => {
        await createClient(supabase, 7, 'user-1', '日本語')

        expect(writes.inserted?.short_code).not.toBe('')
    })

    it('still finds a free code when the fallback itself is taken', async () => {
        existingCodes(['client'])

        await createClient(supabase, 7, 'user-1', '日本語')

        expect(writes.inserted?.short_code).toBe('client2')
    })

    it('returns the id of the row it created', async () => {
        await expect(createClient(supabase, 7, 'user-1', 'Broward County')).resolves.toBe('new-client')
    })

    it('throws when the insert is refused', async () => {
        writes.insertResult = { data: null, error: { message: 'duplicate key value' } }

        await expect(createClient(supabase, 7, 'user-1', 'Broward County')).rejects.toThrow('duplicate key value')
    })
})

describe('updateClient', () => {
    it('bumps the revision on every save, so a stale coworker is always countable', async () => {
        await updateClient(supabase, 7, 'c1', { skills: [] }, 4)

        expect(writes.updated?.revision).toBe(5)
    })

    it('writes the revision in the same statement as the payload', async () => {
        const skills = [{ name: 'Document format', description: '', body: 'b', raw: '', files: [] }]

        await updateClient(supabase, 7, 'c1', { skills }, 1)

        expect(writes.updated).toMatchObject({ skills, revision: 2 })
    })

    it('leaves out of the statement what the patch does not carry', async () => {
        await updateClient(supabase, 7, 'c1', { name: '  Broward County  ' }, 1)

        expect(writes.updated).not.toHaveProperty('skills')
        expect(writes.updated).not.toHaveProperty('knowledge')
        expect(writes.updated?.name).toBe('Broward County')
    })

    it('clears the Confluence default space when the patch sets it to null', async () => {
        await updateClient(supabase, 7, 'c1', { confluence: null }, 1)

        expect(writes.updated).toMatchObject({ site_url: null, cloud_id: null, space_key: null, space_name: null })
    })

    it('scopes the write to the client and its workspace', async () => {
        await updateClient(supabase, 7, 'c1', { shortCode: ' bwd ' }, 1)

        expect(writes.updated?.short_code).toBe('bwd')
        expect(writes.filters).toEqual([
            ['id', 'c1'],
            ['workspace_id', 7],
        ])
    })

    it('throws when the write is refused', async () => {
        writes.writeResult = { error: { message: 'short code already taken' } }

        await expect(updateClient(supabase, 7, 'c1', { shortCode: 'mdc' }, 1)).rejects.toThrow('short code already taken')
    })
})

describe('deleteClient', () => {
    it('deletes the row of this workspace only', async () => {
        await deleteClient(supabase, 7, 'c1')

        expect(writes.deleted).toBe(true)
        expect(writes.table).toBe('clients')
        expect(writes.filters).toEqual([
            ['id', 'c1'],
            ['workspace_id', 7],
        ])
    })

    it('throws when the delete is refused', async () => {
        writes.writeResult = { error: { message: 'nope' } }

        await expect(deleteClient(supabase, 7, 'c1')).rejects.toThrow('nope')
    })
})
