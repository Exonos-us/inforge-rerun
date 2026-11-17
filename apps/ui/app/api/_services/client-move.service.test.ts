import type { Database } from '@/app/api/database.types'
import type { SupabaseClient } from '@supabase/supabase-js'
import { selectMaybeSingle } from '@/supabase/supabase-helpers'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { deleteFile, deleteSkill, getSpaceConnection, importSkill, listFiles, listSkillSummaries, makeDir, moveAgentToBox, supportsSkillImportCreate, syncAgentProjectNote, writeFileText } = vi.hoisted(() => ({
    deleteFile: vi.fn(),
    deleteSkill: vi.fn(),
    getSpaceConnection: vi.fn(),
    importSkill: vi.fn(),
    listFiles: vi.fn(),
    listSkillSummaries: vi.fn(),
    makeDir: vi.fn(),
    moveAgentToBox: vi.fn(),
    syncAgentProjectNote: vi.fn(),
    supportsSkillImportCreate: vi.fn(),
    writeFileText: vi.fn(),
}))
vi.mock('@/lib/engine/client', async () => ({ ...(await vi.importActual<object>('@/lib/engine/client')), deleteFile, deleteSkill, importSkill, listFiles, listSkillSummaries, makeDir, supportsSkillImportCreate, writeFileText }))
vi.mock('@/app/api/_auth/access', () => ({
    AccessDeniedError: class extends Error {},
    assertAgentInWorkspace: vi.fn(),
    assertSessionInWorkspace: vi.fn(),
    keepVisible: vi.fn(),
    requireLightSessionActor: async () => ({ workspaceId: 7 }),
    visibleAgentIds: vi.fn(),
}))
vi.mock('@/app/api/_services/agent.service', () => ({ deleteAgent: vi.fn(), duplicateAgent: vi.fn(), moveAgentToBox }))
vi.mock('@/app/api/_services/project-knowledge.service', () => ({ syncAgentProjectNote }))
vi.mock('@/app/api/_services/space.service', () => ({ getSpaceConnection }))
vi.mock('@/supabase/serviceRole', () => ({ createServiceRoleClient: () => supabase }))
vi.mock('@/supabase/supabase-helpers', () => ({ selectCount: vi.fn(), selectMany: vi.fn(), selectMaybeSingle: vi.fn() }))

import { moveAgentAction } from '@/app/api/_actions/agent.actions'
import { syncAgentClient } from './client.service'

const MDC = 'a1b8d4fa-0db3-4de6-9305-f1fb9c37ca34'
const ACME = 'b2c9e5fb-1ec4-4ef7-8416-02fc8d48db45'
const MDC_SKILL = 'client-a1b8d4fa-doc-format'
const MDC_DIR = 'client-a1b8d4fa'
const ACME_SKILL = 'client-b2c9e5fb-tone-of-voice'
const ACME_DIR = 'client-b2c9e5fb'
const FILES_BASE = '/agents/engine-a1/files'

const conn = { baseUrl: 'https://engine.test', apiKey: 'k' }

function clientRow(id: string, name: string, skillName: string, revision: number) {
    return {
        id,
        name,
        short_code: name.slice(0, 3).toLowerCase(),
        skills: [{ name: skillName, description: 'House style', body: 'Write it this way.', raw: '', files: [] }],
        knowledge: [{ path: 'acronyms.md', content: `${name} spells them out.` }],
        site_url: null,
        cloud_id: null,
        space_key: null,
        space_name: null,
        revision,
        updated_at: '2026-11-17T09:00:00Z',
    }
}

const clients: Record<string, ReturnType<typeof clientRow>> = {
    [MDC]: clientRow(MDC, 'Miami-Dade County', 'Doc format', 5),
    [ACME]: clientRow(ACME, 'Acme', 'Tone of voice', 1),
}

const reads = {
    agent: null as Record<string, unknown> | null,
    boxClient: null as string | null,
    filters: [] as { table: string; filters: Record<string, unknown> }[],
}

const writes = {
    revisions: [] as { agentId: string; revision: unknown }[],
    tables: [] as string[],
    filters: [] as [string, unknown][],
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
                        writes.revisions.push({ agentId, revision: payload.client_revision })
                        return Promise.resolve({ error: null }).then(onFulfilled)
                    },
                }
                return builder
            },
        }
    },
} as unknown as SupabaseClient<Database>

function summaries(...slugs: string[]) {
    return slugs.map(slug => ({ slug, name: slug, description: '' }))
}

function dirs(...names: string[]) {
    return names.map(name => ({ name, type: 'dir' as const, size: 0 }))
}

beforeEach(() => {
    vi.resetAllMocks()
    for (const call of [deleteFile, deleteSkill, importSkill, makeDir, syncAgentProjectNote, writeFileText]) call.mockResolvedValue(undefined)
    listSkillSummaries.mockResolvedValue(summaries(MDC_SKILL, 'own-skill'))
    listFiles.mockResolvedValue(dirs(MDC_DIR, 'notes'))
    supportsSkillImportCreate.mockResolvedValue(true)
    getSpaceConnection.mockResolvedValue(conn)

    reads.agent = { id: 'a1', name: 'Ava', space_id: 'space-acme', workspace_id: 7, engine_agent_id: 'engine-a1' }
    reads.boxClient = ACME
    reads.filters = []
    writes.revisions = []
    writes.tables = []
    writes.filters = []

    vi.mocked(selectMaybeSingle).mockImplementation((async (_supabase: unknown, table: string, _columns: unknown, filters: Record<string, unknown>) => {
        reads.filters.push({ table, filters })
        if (table === 'agents') return { data: reads.agent, error: null }
        if (table === 'spaces') return { data: { client_id: reads.boxClient }, error: null }
        return { data: clients[String(filters.id)] ?? null, error: null }
    }) as never)
})

describe('syncAgentClient', () => {
    it('leaves nothing of the client the coworker worked for before the move', async () => {
        await syncAgentClient('a1')

        expect(deleteSkill).toHaveBeenCalledWith(conn, 'engine-a1', MDC_SKILL)
        expect(deleteFile).toHaveBeenCalledWith(conn, FILES_BASE, `knowledge/${MDC_DIR}`)
        expect(importSkill).toHaveBeenCalledWith(conn, 'engine-a1', expect.any(String), [], { slug: ACME_SKILL, overwrite: true })
        expect(writes.revisions).toEqual([{ agentId: 'a1', revision: 1 }])
    })

    it('keeps the coworker its own skills and the ones of the client it is joining', async () => {
        listSkillSummaries.mockResolvedValue(summaries(MDC_SKILL, ACME_SKILL, 'own-skill'))
        listFiles.mockResolvedValue(dirs(MDC_DIR, ACME_DIR, 'notes'))

        await syncAgentClient('a1')

        expect(deleteSkill.mock.calls.map(call => call[2])).toEqual([MDC_SKILL])
        expect(deleteFile.mock.calls.map(call => call[2])).toEqual([`knowledge/${MDC_DIR}`])
    })

    it('drops a namespace whose client row no longer exists', async () => {
        listSkillSummaries.mockResolvedValue(summaries('client-deadbeef-intake'))
        listFiles.mockResolvedValue(dirs('client-deadbeef'))

        await syncAgentClient('a1')

        expect(deleteSkill).toHaveBeenCalledWith(conn, 'engine-a1', 'client-deadbeef-intake')
        expect(deleteFile).toHaveBeenCalledWith(conn, FILES_BASE, 'knowledge/client-deadbeef')
    })

    it('strips the old client and clears the revision when the Box it lands in has none', async () => {
        reads.boxClient = null

        await syncAgentClient('a1')

        expect(deleteSkill).toHaveBeenCalledWith(conn, 'engine-a1', MDC_SKILL)
        expect(deleteFile).toHaveBeenCalledWith(conn, FILES_BASE, `knowledge/${MDC_DIR}`)
        expect(importSkill).not.toHaveBeenCalled()
        expect(writes.revisions).toEqual([{ agentId: 'a1', revision: null }])
    })

    it('writes the revision scoped to the coworker and its workspace', async () => {
        await syncAgentClient('a1')

        expect(writes.tables).toEqual(['agents'])
        expect(writes.filters).toEqual([
            ['id', 'a1'],
            ['workspace_id', 7],
        ])
    })

    it('holds the revision back when a skill of the new client did not land', async () => {
        importSkill.mockRejectedValue(new Error('engine offline'))

        await syncAgentClient('a1')

        expect(writes.revisions).toEqual([])
    })

    it('holds the revision back rather than leaving the coworker reading as synced to the old one', async () => {
        getSpaceConnection.mockResolvedValue(null)

        await syncAgentClient('a1')

        expect(writes.revisions).toEqual([])
    })

    it('reads the Box of the coworker inside its own workspace', async () => {
        await syncAgentClient('a1')

        expect(reads.filters[0]).toMatchObject({ table: 'agents', filters: { id: 'a1' } })
        expect(reads.filters[1]).toEqual({ table: 'spaces', filters: { id: 'space-acme', workspace_id: 7 } })
        expect(reads.filters[2]).toEqual({ table: 'clients', filters: { id: ACME, workspace_id: 7 } })
    })

    it('does nothing at all for a coworker that is on no machine', async () => {
        reads.agent = { id: 'a1', name: 'Ava', space_id: 'space-acme', workspace_id: 7, engine_agent_id: null }

        await syncAgentClient('a1')

        expect(getSpaceConnection).not.toHaveBeenCalled()
        expect(deleteSkill).not.toHaveBeenCalled()
        expect(writes.revisions).toEqual([])
    })

    it('does nothing for a coworker that is not there', async () => {
        reads.agent = null

        await expect(syncAgentClient('a1')).resolves.toBeUndefined()

        expect(getSpaceConnection).not.toHaveBeenCalled()
        expect(writes.revisions).toEqual([])
    })

    it('never throws when the machine refuses every call', async () => {
        listSkillSummaries.mockRejectedValue(new Error('engine offline'))
        listFiles.mockRejectedValue(new Error('engine offline'))
        deleteSkill.mockRejectedValue(new Error('engine offline'))
        importSkill.mockRejectedValue(new Error('engine offline'))

        await expect(syncAgentClient('a1')).resolves.toBeUndefined()
    })
})

describe('moving a coworker', () => {
    const MOVE = { agentId: '7f1c2a5e-0a3f-4b2d-8c9a-1d2e3f405162', spaceId: '8e2d3b6f-1b4a-4c3e-9d0b-2e3f40516273' }

    beforeEach(() => {
        moveAgentToBox.mockResolvedValue({ ok: true, position: { col: 1, row: 2 } })
    })

    it('reconciles the client of the Box it joins', async () => {
        await expect(moveAgentAction(MOVE)).resolves.toEqual({ ok: true, position: { col: 1, row: 2 } })

        expect(importSkill).toHaveBeenCalledWith(conn, 'engine-a1', expect.any(String), [], { slug: ACME_SKILL, overwrite: true })
    })

    it('still moves the coworker when the reconcile throws', async () => {
        vi.mocked(selectMaybeSingle).mockRejectedValue(new Error('database unreachable'))

        await expect(moveAgentAction(MOVE)).resolves.toEqual({ ok: true, position: { col: 1, row: 2 } })
    })

    it('leaves the client alone when the move itself was refused', async () => {
        moveAgentToBox.mockResolvedValue({ ok: false, error: 'Coworker not found' })

        await expect(moveAgentAction(MOVE)).resolves.toEqual({ ok: false, error: 'Coworker not found' })

        expect(deleteSkill).not.toHaveBeenCalled()
        expect(importSkill).not.toHaveBeenCalled()
    })
})
