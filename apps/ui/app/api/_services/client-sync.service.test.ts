import type { Database } from '@/app/api/database.types'
import { selectCount, selectMany, selectMaybeSingle } from '@/supabase/supabase-helpers'
import type { SupabaseClient } from '@supabase/supabase-js'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { deleteFile, deleteSkill, getSpaceConnection, importSkill, listSkillSummaries, makeDir, supportsSkillImportCreate, writeFileText } = vi.hoisted(() => ({
    deleteFile: vi.fn(),
    deleteSkill: vi.fn(),
    getSpaceConnection: vi.fn(),
    importSkill: vi.fn(),
    listSkillSummaries: vi.fn(),
    makeDir: vi.fn(),
    supportsSkillImportCreate: vi.fn(),
    writeFileText: vi.fn(),
}))
vi.mock('@/lib/engine/client', () => ({ deleteFile, deleteSkill, importSkill, listSkillSummaries, makeDir, supportsSkillImportCreate, writeFileText }))
vi.mock('@/app/api/_services/space.service', () => ({ getSpaceConnection }))
vi.mock('@/supabase/supabase-helpers', () => ({ selectCount: vi.fn(), selectMany: vi.fn(), selectMaybeSingle: vi.fn() }))

import { pendingSyncCount, syncClient } from './client.service'

const MDC = 'a1b8d4fa-0db3-4de6-9305-f1fb9c37ca34'
const conn = { baseUrl: 'https://engine.test', apiKey: 'k' }

const clientRow = {
    id: MDC,
    name: 'Miami-Dade County',
    short_code: 'mdc',
    skills: [{ name: 'Doc format', description: 'How a memo is laid out', body: 'Use the county template.', raw: '', files: [] }],
    knowledge: [{ path: 'acronyms.md', content: 'BCC is the Board of County Commissioners.' }],
    site_url: null,
    cloud_id: null,
    space_key: null,
    space_name: null,
    revision: 5,
    updated_at: '2026-11-17T09:00:00Z',
}

type AgentRow = { id: string; name: string; space_id: string; engine_agent_id: string | null }

const reads = {
    spaces: [{ id: 's1' }] as { id: string }[],
    agents: [] as AgentRow[],
    counts: [] as number[],
    spaceFilters: null as Record<string, unknown> | null,
    agentFilters: null as Record<string, unknown> | null,
    countFilters: [] as Record<string, unknown>[],
}

const writes = {
    marked: [] as { agentId: string; revision: unknown }[],
    tables: [] as string[],
    filters: [] as [string, unknown][],
    refused: new Set<string>(),
}

function coworker(id: string, overrides: Partial<AgentRow> = {}): AgentRow {
    return { id, name: id.toUpperCase(), space_id: 's1', engine_agent_id: `engine-${id}`, ...overrides }
}

const supabase = {
    from(table: string) {
        writes.tables.push(table)
        return {
            update(payload: Record<string, unknown>) {
                let agentId = ''
                const builder = {
                    eq(column: string, value: unknown) {
                        writes.filters.push([column, value])
                        if (column === 'id') agentId = String(value)
                        return builder
                    },
                    then<T>(onFulfilled: (value: unknown) => T) {
                        const error = writes.refused.has(agentId) ? { message: 'row level security' } : null
                        if (!error) writes.marked.push({ agentId, revision: payload.client_revision })
                        return Promise.resolve({ error }).then(onFulfilled)
                    },
                }
                return builder
            },
        }
    },
} as unknown as SupabaseClient<Database>

beforeEach(() => {
    vi.resetAllMocks()
    for (const call of [deleteFile, deleteSkill, importSkill, makeDir, writeFileText]) call.mockResolvedValue(undefined)
    listSkillSummaries.mockResolvedValue([])
    supportsSkillImportCreate.mockResolvedValue(true)
    getSpaceConnection.mockResolvedValue(conn)

    reads.spaces = [{ id: 's1' }]
    reads.agents = [coworker('a1'), coworker('a2')]
    reads.counts = []
    reads.spaceFilters = null
    reads.agentFilters = null
    reads.countFilters = []
    writes.marked = []
    writes.tables = []
    writes.filters = []
    writes.refused = new Set()

    vi.mocked(selectMaybeSingle).mockResolvedValue({ data: clientRow, error: null } as never)
    vi.mocked(selectMany).mockImplementation((async (_supabase: unknown, table: string, _columns: unknown, filters: Record<string, unknown>) => {
        if (table === 'spaces') {
            reads.spaceFilters = filters
            return { data: reads.spaces, error: null }
        }
        reads.agentFilters = filters
        return { data: reads.agents.filter(agent => agent.engine_agent_id !== null), error: null }
    }) as never)
    vi.mocked(selectCount).mockImplementation((async (_supabase: unknown, _table: string, filters: Record<string, unknown>) => {
        reads.countFilters.push(filters)
        return { data: reads.counts[reads.countFilters.length - 1] ?? 0, error: null }
    }) as never)
})

describe('syncClient', () => {
    it('marks only the coworkers whose install actually landed', async () => {
        importSkill.mockRejectedValueOnce(new Error('offline'))

        const result = await syncClient(supabase, 7, MDC)

        expect(result.synced).toBe(1)
        expect(result.pending).toBe(1)
        expect(writes.marked).toEqual([{ agentId: 'a2', revision: 5 }])
    })

    it('attempts every later coworker after one has failed', async () => {
        reads.agents = [coworker('a1'), coworker('a2'), coworker('a3')]
        importSkill.mockImplementation(async (_conn: unknown, engineAgentId: string) => {
            if (engineAgentId === 'engine-a2') throw new Error('offline')
        })

        const result = await syncClient(supabase, 7, MDC)

        expect(importSkill).toHaveBeenCalledTimes(3)
        expect(writes.marked.map(mark => mark.agentId)).toEqual(['a1', 'a3'])
        expect(result).toMatchObject({ synced: 2, pending: 1 })
    })

    it('survives a coworker whose install throws instead of warning', async () => {
        reads.agents = [coworker('a1'), coworker('a2')]
        supportsSkillImportCreate.mockRejectedValueOnce(new Error('engine unreachable'))

        const result = await syncClient(supabase, 7, MDC)

        expect(writes.marked).toEqual([{ agentId: 'a2', revision: 5 }])
        expect(result).toMatchObject({ synced: 1, pending: 1 })
        expect(result.warnings[0]).toContain('"A1"')
    })

    it('holds the revision back when a knowledge document did not land', async () => {
        reads.agents = [coworker('a1')]
        writeFileText.mockRejectedValueOnce(new Error('disk full'))

        const result = await syncClient(supabase, 7, MDC)

        expect(writes.marked).toEqual([])
        expect(result).toMatchObject({ synced: 0, pending: 1 })
    })

    it('collects the warnings of every coworker that did not land', async () => {
        importSkill.mockRejectedValue(new Error('offline'))

        const result = await syncClient(supabase, 7, MDC)

        expect(result.warnings).toHaveLength(2)
        expect(result.warnings[0]).toContain('"A1"')
        expect(result.warnings[1]).toContain('"A2"')
    })

    it('keeps a coworker pending when the revision write is refused', async () => {
        writes.refused = new Set(['a1'])

        const result = await syncClient(supabase, 7, MDC)

        expect(writes.marked).toEqual([{ agentId: 'a2', revision: 5 }])
        expect(result).toMatchObject({ synced: 1, pending: 1 })
    })

    it('writes the revision the client is at, scoped to the coworker and its workspace', async () => {
        reads.agents = [coworker('a1')]

        await syncClient(supabase, 7, MDC)

        expect(writes.tables).toEqual(['agents'])
        expect(writes.marked).toEqual([{ agentId: 'a1', revision: 5 }])
        expect(writes.filters).toEqual([
            ['id', 'a1'],
            ['workspace_id', 7],
        ])
    })

    it('reads the coworkers of this client only, and only those on a machine', async () => {
        reads.spaces = [{ id: 's1' }, { id: 's2' }]

        await syncClient(supabase, 7, MDC)

        expect(reads.spaceFilters).toEqual({ workspace_id: 7, client_id: MDC })
        expect(reads.agentFilters).toEqual({ workspace_id: 7, space_id: ['s1', 's2'], engine_agent_id: { notNull: true } })
    })

    it('does not reach for an engine when no Box carries the client', async () => {
        reads.spaces = []

        const result = await syncClient(supabase, 7, MDC)

        expect(result).toEqual({ synced: 0, pending: 0, warnings: [] })
        expect(getSpaceConnection).not.toHaveBeenCalled()
        expect(writes.marked).toEqual([])
    })

    it('applies the client in the Box the coworker is in', async () => {
        reads.agents = [coworker('a1', { space_id: 's1' }), coworker('a2', { space_id: 's2' })]

        await syncClient(supabase, 7, MDC)

        expect(getSpaceConnection.mock.calls.map(call => call[0])).toEqual(['s1', 's2'])
    })

    it('throws when the client does not belong to this workspace', async () => {
        vi.mocked(selectMaybeSingle).mockResolvedValue({ data: null, error: null } as never)

        await expect(syncClient(supabase, 7, MDC)).rejects.toThrow()
        expect(writes.marked).toEqual([])
    })
})

describe('pendingSyncCount', () => {
    it('counts the coworkers trailing the revision, whatever their recorded one is', async () => {
        reads.counts = [5, 2]

        await expect(pendingSyncCount(supabase, 7, MDC, 5)).resolves.toBe(3)
    })

    it('counts in the Boxes of this client only, on a machine, level with this revision', async () => {
        reads.spaces = [{ id: 's1' }, { id: 's2' }]
        reads.counts = [4, 1]

        await pendingSyncCount(supabase, 7, MDC, 5)

        expect(reads.countFilters[0]).toEqual({ workspace_id: 7, space_id: ['s1', 's2'], engine_agent_id: { notNull: true } })
        expect(reads.countFilters[1]).toEqual({ workspace_id: 7, space_id: ['s1', 's2'], engine_agent_id: { notNull: true }, client_revision: { gte: 5 } })
    })

    it('is zero when no Box carries the client', async () => {
        reads.spaces = []

        await expect(pendingSyncCount(supabase, 7, MDC, 5)).resolves.toBe(0)
        expect(selectCount).not.toHaveBeenCalled()
    })

    it('never answers a negative count', async () => {
        reads.counts = [1, 3]

        await expect(pendingSyncCount(supabase, 7, MDC, 5)).resolves.toBe(0)
    })

    it('agrees with what a sync left behind', async () => {
        importSkill.mockRejectedValueOnce(new Error('offline'))

        const result = await syncClient(supabase, 7, MDC)
        reads.counts = [reads.agents.length, writes.marked.length]

        await expect(pendingSyncCount(supabase, 7, MDC, 5)).resolves.toBe(result.pending)
    })
})
