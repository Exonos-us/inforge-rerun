import { beforeEach, describe, expect, it, vi } from 'vitest'

const { supportsSkillImportCreate } = vi.hoisted(() => ({ supportsSkillImportCreate: vi.fn() }))
vi.mock('@/lib/engine/client', () => ({ supportsSkillImportCreate }))
vi.mock('@/supabase/supabase-helpers', () => ({ selectMany: vi.fn(), selectMaybeSingle: vi.fn() }))

import { canInstallClientSkills } from './client.service'

const conn = { baseUrl: 'https://engine.test', apiKey: 'k' }
const agent = { name: 'Ava' }

describe('a machine too old for client skills', () => {
    beforeEach(() => {
        supportsSkillImportCreate.mockReset()
    })

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

    // Task 5 writes applyClientExtras. Its knowledge docs are plain file writes and must land on an
    // engine that fails this gate: the gate stands between the skills and nothing else.
    it.todo('writes the knowledge docs even when the gate refuses the skills')
})
