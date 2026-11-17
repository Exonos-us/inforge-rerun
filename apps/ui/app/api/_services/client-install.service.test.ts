import { beforeEach, describe, expect, it, vi } from 'vitest'

const { deleteFile, deleteSkill, importSkill, listSkillSummaries, makeDir, supportsSkillImportCreate, writeFileText } = vi.hoisted(() => ({
    deleteFile: vi.fn(),
    deleteSkill: vi.fn(),
    importSkill: vi.fn(),
    listSkillSummaries: vi.fn(),
    makeDir: vi.fn(),
    supportsSkillImportCreate: vi.fn(),
    writeFileText: vi.fn(),
}))
vi.mock('@/lib/engine/client', () => ({ deleteFile, deleteSkill, importSkill, listSkillSummaries, makeDir, supportsSkillImportCreate, writeFileText }))
vi.mock('@/supabase/supabase-helpers', () => ({ selectMany: vi.fn(), selectMaybeSingle: vi.fn() }))

const conn = { baseUrl: 'https://engine.test', apiKey: 'k' }
vi.mock('@/app/api/_services/space.service', () => ({ getSpaceConnection: async () => conn }))

import { applyClientExtras, canInstallClientSkills, removeClientExtras, type ClientView } from './client.service'

const MDC = 'a1b8d4fa-0db3-4de6-9305-f1fb9c37ca34'
const agent = { name: 'Ava' }
const coworker = { name: 'Ava', engine_agent_id: 'engine-agent-1' }

function client(overrides: Partial<ClientView> = {}): ClientView {
    return {
        id: MDC,
        name: 'Miami-Dade County',
        shortCode: 'mdc',
        skills: [{ name: 'Doc format', description: 'How a memo is laid out', body: 'Use the county template.', raw: '', files: [] }],
        knowledgeDocs: [{ path: 'acronyms.md', content: 'BCC is the Board of County Commissioners.' }],
        confluence: null,
        revision: 3,
        updatedAt: '2026-11-17T09:00:00Z',
        ...overrides,
    }
}

function summaries(...slugs: string[]) {
    return slugs.map(slug => ({ slug, name: slug, description: '' }))
}

function engineAnswers() {
    vi.resetAllMocks()
    for (const call of [deleteFile, deleteSkill, importSkill, makeDir, writeFileText]) call.mockResolvedValue(undefined)
    listSkillSummaries.mockResolvedValue([])
    supportsSkillImportCreate.mockResolvedValue(true)
}

describe('a machine too old for client skills', () => {
    beforeEach(engineAnswers)

    it('refuses the skills with a single warning that names the coworker and what fixes it', async () => {
        supportsSkillImportCreate.mockResolvedValue(false)
        const warnings: string[] = []

        await expect(canInstallClientSkills(conn, agent, warnings)).resolves.toBe(false)

        expect(warnings).toHaveLength(1)
        expect(warnings[0]).toContain('"Ava"')
        expect(warnings[0]).toContain('next update of this machine')
    })

    it('asks the machine once, not once per skill', async () => {
        supportsSkillImportCreate.mockResolvedValue(false)
        const warnings: string[] = []

        await canInstallClientSkills(conn, agent, warnings)

        expect(supportsSkillImportCreate).toHaveBeenCalledTimes(1)
        expect(supportsSkillImportCreate).toHaveBeenCalledWith(conn)
    })

    it('says nothing and lets the skills through on a machine that has the capability', async () => {
        supportsSkillImportCreate.mockResolvedValue(true)
        const warnings: string[] = []

        await expect(canInstallClientSkills(conn, agent, warnings)).resolves.toBe(true)

        expect(warnings).toEqual([])
    })

    it('writes the knowledge docs even when the gate refuses the skills', async () => {
        supportsSkillImportCreate.mockResolvedValue(false)
        const warnings: string[] = []

        await applyClientExtras(client(), 'space-1', coworker, warnings)

        expect(importSkill).not.toHaveBeenCalled()
        expect(writeFileText).toHaveBeenCalledWith(conn, '/agents/engine-agent-1/files', 'knowledge/client-a1b8d4fa/acronyms.md', 'BCC is the Board of County Commissioners.')
        expect(warnings).toHaveLength(1)
        expect(warnings[0]).toContain('next update of this machine')
    })
})

describe('applyClientExtras', () => {
    beforeEach(() => {
        engineAnswers()
        listSkillSummaries.mockResolvedValue(summaries('client-a1b8d4fa-doc-format'))
    })

    it('re-pushes a skill onto its own slug so a second call replaces rather than duplicates', async () => {
        await applyClientExtras(client(), 'space-1', coworker, [])

        expect(importSkill).toHaveBeenCalledWith(conn, 'engine-agent-1', expect.any(String), [], { slug: 'client-a1b8d4fa-doc-format', overwrite: true })
    })

    it('collects a warning instead of throwing when the engine refuses', async () => {
        importSkill.mockRejectedValueOnce(new Error('engine offline'))
        const warnings: string[] = []

        await expect(applyClientExtras(client(), 'space-1', coworker, warnings)).resolves.toBeUndefined()

        expect(warnings).toHaveLength(1)
        expect(warnings[0]).toContain('Doc format')
    })

    it('writes knowledge under the client’s own folder', async () => {
        await applyClientExtras(client(), 'space-1', coworker, [])

        expect(makeDir).toHaveBeenCalledWith(conn, '/agents/engine-agent-1/files', 'knowledge/client-a1b8d4fa')
        expect(writeFileText).toHaveBeenCalledWith(conn, '/agents/engine-agent-1/files', 'knowledge/client-a1b8d4fa/acronyms.md', 'BCC is the Board of County Commissioners.')
    })

    it('does nothing at all for a coworker that has no engine agent', async () => {
        await applyClientExtras(client(), 'space-1', { name: 'Ava', engine_agent_id: null }, [])

        expect(importSkill).not.toHaveBeenCalled()
        expect(writeFileText).not.toHaveBeenCalled()
        expect(deleteSkill).not.toHaveBeenCalled()
    })

    it('removes a skill the client no longer has', async () => {
        listSkillSummaries.mockResolvedValue(summaries('client-a1b8d4fa-doc-format', 'client-a1b8d4fa-old-intake'))

        await applyClientExtras(client(), 'space-1', coworker, [])

        expect(deleteSkill).toHaveBeenCalledTimes(1)
        expect(deleteSkill).toHaveBeenCalledWith(conn, 'engine-agent-1', 'client-a1b8d4fa-old-intake')
    })

    it('never removes a skill outside the client namespace', async () => {
        listSkillSummaries.mockResolvedValue(summaries('permit-intake-triage', 'client-c7e2119b-doc-format', 'client-a1b8d4faXX-doc'))

        await applyClientExtras(client(), 'space-1', coworker, [])

        expect(deleteSkill).not.toHaveBeenCalled()
    })

    it('deletes nothing when the client parses to zero skills', async () => {
        listSkillSummaries.mockResolvedValue(summaries('client-a1b8d4fa-doc-format'))

        await applyClientExtras(client({ skills: [] }), 'space-1', coworker, [])

        expect(deleteSkill).not.toHaveBeenCalled()
        expect(listSkillSummaries).not.toHaveBeenCalled()
    })

    it('pushes every skill before it deletes any', async () => {
        const order: string[] = []
        importSkill.mockImplementation(async () => {
            order.push('import')
        })
        deleteSkill.mockImplementation(async () => {
            order.push('delete')
        })
        listSkillSummaries.mockResolvedValue(summaries('client-a1b8d4fa-old-intake'))

        await applyClientExtras(client(), 'space-1', coworker, [])

        expect(order).toEqual(['import', 'delete'])
    })

    it('keeps the skill and warns when a reconcile delete fails', async () => {
        listSkillSummaries.mockResolvedValue(summaries('client-a1b8d4fa-old-intake'))
        deleteSkill.mockRejectedValueOnce(new Error('engine offline'))
        const warnings: string[] = []

        await expect(applyClientExtras(client(), 'space-1', coworker, warnings)).resolves.toBeUndefined()

        expect(warnings).toHaveLength(1)
        expect(warnings[0]).toContain('client-a1b8d4fa-old-intake')
    })

    it('deletes nothing when the engine cannot say what is installed', async () => {
        listSkillSummaries.mockRejectedValue(new Error('engine offline'))
        const warnings: string[] = []

        await expect(applyClientExtras(client(), 'space-1', coworker, warnings)).resolves.toBeUndefined()

        expect(deleteSkill).not.toHaveBeenCalled()
    })
})

describe('removeClientExtras', () => {
    beforeEach(engineAnswers)

    it('removes the client’s skills and only those', async () => {
        await removeClientExtras(client(), 'space-1', coworker, ['client-a1b8d4fa-doc-format', 'permit-intake-triage'], [])

        expect(deleteSkill).toHaveBeenCalledTimes(1)
        expect(deleteSkill).toHaveBeenCalledWith(conn, 'engine-agent-1', 'client-a1b8d4fa-doc-format')
    })

    it('takes the client’s knowledge folder with it', async () => {
        await removeClientExtras(client(), 'space-1', coworker, ['client-a1b8d4fa-doc-format'], [])

        expect(deleteFile).toHaveBeenCalledWith(conn, '/agents/engine-agent-1/files', 'knowledge/client-a1b8d4fa')
    })

    it('warns instead of throwing when the engine refuses a delete', async () => {
        deleteSkill.mockRejectedValueOnce(new Error('engine offline'))
        const warnings: string[] = []

        await expect(removeClientExtras(client(), 'space-1', coworker, ['client-a1b8d4fa-doc-format'], warnings)).resolves.toBeUndefined()

        expect(warnings).toHaveLength(1)
        expect(warnings[0]).toContain('client-a1b8d4fa-doc-format')
    })

    it('does not reach for the engine for a coworker that has none', async () => {
        await removeClientExtras(client(), 'space-1', { name: 'Ava', engine_agent_id: null }, ['client-a1b8d4fa-doc-format'], [])

        expect(deleteSkill).not.toHaveBeenCalled()
        expect(deleteFile).not.toHaveBeenCalled()
    })
})
