import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

process.env.RERUN_DATA_DIR = mkdtempSync(resolve(tmpdir(), 'rerun-skills-import-'))
process.env.RERUN_API_KEY = ''

const { afterEach, beforeAll, describe, expect, it } = await import('vitest')
const { mkdir, rm } = await import('node:fs/promises')
const { createServer } = await import('../server.js')
const { agentConfigSchema } = await import('../../agents/types.js')
const { writeAgentConfig } = await import('../../agents/config-write.js')
const { agentDir, skillsDir } = await import('../../config/paths.js')

const id = 'skillimport'
const app = createServer()
const base = `/agents/${id}/skills`
const SLUG = 'client-a1b8d4fa-doc-format'
const SKILL_MD = '---\nname: Doc Format\ndescription: How this client wants documents written\n---\n\nUse their template.\n'
const SKILL_MD_V2 = '---\nname: Doc Format\ndescription: How this client wants documents written\n---\n\nUse their second template.\n'

function importSkill(body: { content: string; slug?: string; overwrite?: boolean }) {
    return app.request(`${base}/import`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
}

async function listSkillSlugs(): Promise<string[]> {
    const res = await app.request(base)
    return ((await res.json()) as { skills: { slug: string }[] }).skills.map(skill => skill.slug)
}

beforeAll(async () => {
    await mkdir(agentDir(id), { recursive: true })
    await writeAgentConfig(id, agentConfigSchema.parse({ name: 'skill import' }))
})

afterEach(async () => {
    await rm(skillsDir(id), { recursive: true, force: true })
})

describe('POST /agents/:id/skills/import', () => {
    it('creates a skill at an explicit slug when overwrite is set', async () => {
        const res = await importSkill({ content: SKILL_MD, slug: SLUG, overwrite: true })
        expect(res.status).toBe(201)
        expect(((await res.json()) as { slug: string }).slug).toBe(SLUG)
    })

    it('replaces, not duplicates, when the same slug is imported twice', async () => {
        await importSkill({ content: SKILL_MD, slug: SLUG, overwrite: true })
        const res = await importSkill({ content: SKILL_MD_V2, slug: SLUG, overwrite: true })
        expect(res.status).toBe(200)
        expect(((await res.json()) as { body: string }).body).toBe('Use their second template.')
        expect(await listSkillSlugs()).toEqual([SLUG])
    })

    it('still refuses an explicit slug that does not exist when overwrite is not set', async () => {
        const res = await importSkill({ content: SKILL_MD, slug: SLUG })
        expect(res.status).toBe(404)
        expect(await listSkillSlugs()).toEqual([])
    })
})
