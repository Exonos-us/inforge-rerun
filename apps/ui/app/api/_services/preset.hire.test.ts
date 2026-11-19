import type { Database } from '@/app/api/database.types'
import type { SupabaseClient } from '@supabase/supabase-js'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { applyClientExtras, createAgent, createBoxesBatch, createMemory, createSchedule, createSkill, deriveUniqueHandles, getSpaceConnection, importSkill, makeDir, patchAgent, writeFileText } = vi.hoisted(() => ({
    applyClientExtras: vi.fn(),
    createAgent: vi.fn(),
    createBoxesBatch: vi.fn(),
    createMemory: vi.fn(),
    createSchedule: vi.fn(),
    createSkill: vi.fn(),
    deriveUniqueHandles: vi.fn(),
    getSpaceConnection: vi.fn(),
    importSkill: vi.fn(),
    makeDir: vi.fn(),
    patchAgent: vi.fn(),
    writeFileText: vi.fn(),
}))

vi.mock('@/lib/engine/client', () => ({
    createMemory,
    createSchedule,
    createSkill,
    deleteFile: vi.fn(),
    deleteSkill: vi.fn(),
    getAgent: vi.fn(),
    importSkill,
    listSkillSummaries: vi.fn(),
    makeDir,
    patchAgent,
    planAgentArchive: vi.fn(),
    supportsSkillImportCreate: vi.fn().mockResolvedValue(true),
    writeFileText,
}))
vi.mock('@/app/api/_services/space.service', () => ({ getSpaceConnection }))
vi.mock('@/app/api/_services/box.service', () => ({ createBoxesBatch }))
vi.mock('@/app/api/_services/agent.service', () => ({
    createAgent,
    deriveUniqueHandles,
    findFreeCellsInSpace: vi.fn().mockResolvedValue([]),
    importAgent: vi.fn(),
}))
vi.mock('@/supabase/serviceRole', () => ({ createServiceRoleClient: () => supabase }))
vi.mock('@/supabase/supabase-helpers', () => ({ selectMany: vi.fn(), selectMaybeSingle: vi.fn() }))
// Only the install is replaced: reading the Box's client and turning its row into a ClientView is
// the part of the hire this file is testing.
vi.mock('@/app/api/_services/client.service', async () => ({
    ...(await vi.importActual<typeof import('./client.service')>('./client.service')),
    applyClientExtras,
}))

import { selectMany, selectMaybeSingle } from '@/supabase/supabase-helpers'
import { hireFromPreset, hireTeam } from './preset.service'

const MDC = 'a1b8d4fa-0db3-4de6-9305-f1fb9c37ca34'
const ANOTHER_WORKSPACES_CLIENT = 'c9f4d0e1-5a2b-4c3d-8e7f-0a1b2c3d4e5f'
const WITH_CLIENT = 'space-with-client'
const WITHOUT_CLIENT = 'space-without-client'
const FRESH_BOX = 'space-just-created'

const order: string[] = []
const agentWrites: { id: string; payload: Record<string, unknown> }[] = []
const spaceWrites: { id: string; payload: Record<string, unknown> }[] = []

const presetRow = {
    id: 'preset-1',
    archive_path: null,
    soul: 'You run intake.',
    description: 'Intake officer',
    skills: [{ name: 'Intake form', description: 'How intake is filed', body: 'Fill the form.', raw: '', files: [] }],
    routines: [],
    knowledge: [],
    connector_slugs: [],
    hires: 2,
}

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

const supabase = {
    from(table: string) {
        return {
            update(payload: Record<string, unknown>) {
                let id = ''
                const builder = {
                    eq(column: string, value: unknown) {
                        if (column === 'id') id = String(value)
                        return builder
                    },
                    then<T>(onFulfilled: (value: unknown) => T) {
                        if (table === 'agents') agentWrites.push({ id, payload })
                        if (table === 'spaces') spaceWrites.push({ id, payload })
                        return Promise.resolve({ error: null }).then(onFulfilled)
                    },
                }
                return builder
            },
        }
    },
} as unknown as SupabaseClient<Database>

const params = {
    workspaceId: 7,
    actor: { userId: 'user-1', workspaceId: 7 } as never,
    roster: { presetId: 'preset-1', name: 'Ava', icon: null },
    answers: [],
}

const teamParams = {
    workspaceId: 7,
    userId: 'user-1',
    userEmail: null,
    actor: { userId: 'user-1', workspaceId: 7 } as never,
    spaceName: 'MDC Permitting Project',
    roster: [{ presetId: 'preset-1', name: 'Ava', icon: null }],
    channel: null,
    answers: [],
}

beforeEach(() => {
    vi.clearAllMocks()
    order.length = 0
    agentWrites.length = 0
    spaceWrites.length = 0

    getSpaceConnection.mockResolvedValue({ baseUrl: 'https://engine.test', apiKey: 'k' })
    deriveUniqueHandles.mockResolvedValue(['ava'])
    createBoxesBatch.mockResolvedValue([{ ok: true, spaceId: FRESH_BOX, name: 'MDC Permitting Project', colStart: 0, rowStart: 0, colEnd: 4, rowEnd: 4 }])
    createAgent.mockResolvedValue({ id: 'agent-1', name: 'Ava', engine_agent_id: 'engine-1', disabled_at: null })
    createSkill.mockImplementation(async () => {
        order.push('authored')
    })
    applyClientExtras.mockImplementation(async () => {
        order.push('client')
    })
    for (const call of [createMemory, createSchedule, importSkill, makeDir, patchAgent, writeFileText]) call.mockResolvedValue(undefined)

    vi.mocked(selectMany).mockResolvedValue({ data: [presetRow], error: null } as never)
    vi.mocked(selectMaybeSingle).mockImplementation((async (_supabase: unknown, table: string, _columns: unknown, filters: Record<string, unknown>) => {
        if (table === 'spaces') return { data: { client_id: filters.id === WITH_CLIENT ? MDC : null }, error: null }
        // Scoped by workspace, like the real read: a client id from another workspace finds nothing.
        return { data: filters.id === MDC ? clientRow : null, error: null }
    }) as never)
})

describe('hiring into a Box that has a client', () => {
    it('installs the client’s skills after the preset’s, and records the revision that landed', async () => {
        const outcome = await hireFromPreset({ ...params, spaceId: WITH_CLIENT })

        expect(applyClientExtras).toHaveBeenCalledWith(expect.objectContaining({ id: MDC, name: 'Miami-Dade County', revision: 5 }), WITH_CLIENT, expect.objectContaining({ id: 'agent-1' }), outcome.warnings)
        expect(order).toEqual(['authored', 'client'])
        expect(agentWrites).toEqual([{ id: 'agent-1', payload: { client_revision: 5 } }])
    })

    it('does not reach for a client when the Box has none', async () => {
        const outcome = await hireFromPreset({ ...params, spaceId: WITHOUT_CLIENT })

        expect(applyClientExtras).not.toHaveBeenCalled()
        expect(agentWrites).toEqual([])
        expect(outcome.agents).toHaveLength(1)
    })

    // A coworker must still arrive when its client's skills cannot: a hire that threw because an
    // engine was briefly unreachable would be a worse bug than the missing skills, and the
    // unrecorded revision is what brings the sync back for them.
    it('still hires when the client install fails', async () => {
        applyClientExtras.mockRejectedValueOnce(new Error('engine offline'))

        const outcome = await hireFromPreset({ ...params, spaceId: WITH_CLIENT })

        expect(outcome.agents[0]?.id).toBe('agent-1')
        expect(outcome.warnings.length).toBeGreaterThan(0)
        expect(agentWrites).toEqual([])
    })
})

// The Start project wizard is the only caller that knows a client before the Box exists, so the
// pick has to land on the Box between its creation and the first hire — otherwise the roster reads
// a Box with no client and the wizard's promise is copy over nothing.
describe('hiring a team for the client picked in the wizard', () => {
    it('points the fresh Box at the client, so every coworker of the batch inherits it', async () => {
        const outcome = await hireTeam({ ...teamParams, clientId: MDC })

        expect(spaceWrites).toEqual([{ id: FRESH_BOX, payload: { client_id: MDC } }])
        expect(applyClientExtras).toHaveBeenCalledWith(expect.objectContaining({ id: MDC, revision: 5 }), FRESH_BOX, expect.objectContaining({ id: 'agent-1' }), outcome.warnings)
        expect(agentWrites).toEqual([{ id: 'agent-1', payload: { client_revision: 5 } }])
        expect(outcome.warnings).toEqual([])
    })

    it('leaves the Box alone when the wizard sent no client', async () => {
        const outcome = await hireTeam({ ...teamParams, clientId: null })

        expect(spaceWrites).toEqual([])
        expect(applyClientExtras).not.toHaveBeenCalled()
        expect(outcome.agents).toHaveLength(1)
    })

    it('still hires, and warns, when the picked client is not the workspace’s', async () => {
        const outcome = await hireTeam({ ...teamParams, clientId: ANOTHER_WORKSPACES_CLIENT })

        expect(spaceWrites).toEqual([])
        expect(applyClientExtras).not.toHaveBeenCalled()
        expect(outcome.agents).toHaveLength(1)
        expect(outcome.warnings).toHaveLength(1)
    })
})
