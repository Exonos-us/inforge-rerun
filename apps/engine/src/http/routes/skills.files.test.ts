import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

process.env.RERUN_DATA_DIR = mkdtempSync(resolve(tmpdir(), 'rerun-skill-files-'))
process.env.RERUN_API_KEY = ''

const { describe, expect, it, beforeAll } = await import('vitest')
const { createServer } = await import('../server.js')
const { skillImportSizeError } = await import('./skills.js')
const { agentConfigSchema } = await import('../../agents/types.js')
const { writeAgentConfig } = await import('../../agents/config-write.js')
const { mkdir } = await import('node:fs/promises')
const { agentDir } = await import('../../config/paths.js')
const { MAX_SKILL_FILE_BYTES, MAX_SKILL_FOLDER_BYTES, TEXT_FILE_PAGE_CHARS } = await import('@rerun/contracts')

const id = 'skillagent'
const app = createServer()

function api(path: string, init?: RequestInit) {
    return app.request(path, init)
}

function json(path: string, method: string, body: unknown) {
    return api(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
}

beforeAll(async () => {
    await mkdir(agentDir(id), { recursive: true })
    await writeAgentConfig(id, agentConfigSchema.parse({ name: 'skill agent' }))
})

describe('skill folders over HTTP', () => {
    it('imports a skill with its bundled files', async () => {
        const res = await json(`/agents/${id}/skills/import`, 'POST', {
            content: '---\nname: Viral Hooks\ndescription: hooks\n---\n\nRead references/hook-bank.md at step 2\n',
            files: [
                { path: 'references/hook-bank.md', content: '# Hook bank\n' },
                { path: 'references/frameworks.md', content: '# Frameworks\n' },
            ],
        })
        expect(res.status).toBe(201)
        const skill = (await res.json()) as { slug: string; files: string[] }
        expect(skill.slug).toBe('viral-hooks')
        expect(skill.files).toEqual(['references/frameworks.md', 'references/hook-bank.md'])
    })

    it('imports a skill whose description holds an unquoted colon', async () => {
        const res = await json(`/agents/${id}/skills/import`, 'POST', {
            content: '---\nname: Viral Post\ndescription: Write the full X post from a settled angle and hook: body, proof, payoff, close.\n---\n\nFill the slots\n',
            files: [{ path: 'references/structure.md', content: '# Structure\n' }],
        })
        expect(res.status).toBe(201)
        const skill = (await res.json()) as { slug: string; description: string; files: string[] }
        expect(skill.slug).toBe('viral-post')
        expect(skill.description).toBe('Write the full X post from a settled angle and hook: body, proof, payoff, close.')
        expect(skill.files).toEqual(['references/structure.md'])

        const reread = (await (await api(`/agents/${id}/skills/viral-post`)).json()) as { description: string }
        expect(reread.description).toBe(skill.description)
    })

    it('rejects a bundled file that escapes the skill folder', async () => {
        const res = await json(`/agents/${id}/skills/import`, 'POST', {
            content: '---\nname: Evil\ndescription: x\n---\n\nbody\n',
            files: [{ path: '../../../etc/passwd', content: 'nope' }],
        })
        expect(res.status).toBe(400)
        const skills = await (await api(`/agents/${id}/skills`)).json() as { skills: { slug: string }[] }
        expect(skills.skills.map(s => s.slug)).not.toContain('evil')
    })

    it('serves the bundled files through the files API', async () => {
        const list = (await (await api(`/agents/${id}/skills/viral-hooks/files?path=references`)).json()) as { entries: { name: string }[] }
        expect(list.entries.map(e => e.name)).toEqual(['frameworks.md', 'hook-bank.md'])

        const read = (await (await api(`/agents/${id}/skills/viral-hooks/files/read?path=references/hook-bank.md`)).json()) as { content: string }
        expect(read.content).toBe('# Hook bank\n')
    })

    it('paginates a reference file and reports how to continue', async () => {
        const content = `${'x'.repeat(TEXT_FILE_PAGE_CHARS)}tail`
        expect((await json(`/agents/${id}/skills/viral-hooks/files`, 'PUT', { path: 'references/large.txt', content })).status).toBe(201)

        const first = (await (await api(`/agents/${id}/skills/viral-hooks/files/read?path=references/large.txt`)).json()) as {
            content: string
            offset: number
            nextOffset: number | null
            totalChars: number
            truncated: boolean
        }
        expect(first).toMatchObject({ offset: 0, nextOffset: TEXT_FILE_PAGE_CHARS, totalChars: content.length, truncated: true })
        expect(first.content).toHaveLength(TEXT_FILE_PAGE_CHARS)

        const last = (await (await api(`/agents/${id}/skills/viral-hooks/files/read?path=references/large.txt&offset=${first.nextOffset}`)).json()) as typeof first
        expect(last).toEqual({ path: 'references/large.txt', content: 'tail', offset: TEXT_FILE_PAGE_CHARS, nextOffset: null, totalChars: content.length, truncated: false })

        const pastEnd = (await (await api(`/agents/${id}/skills/viral-hooks/files/read?path=references/large.txt&offset=${content.length + 10}`)).json()) as typeof first
        expect(pastEnd).toMatchObject({ content: '', offset: content.length + 10, nextOffset: null, totalChars: content.length, truncated: false })
        expect((await api(`/agents/${id}/skills/viral-hooks/files/read?path=references/large.txt&offset=-1`)).status).toBe(400)
        expect((await api(`/agents/${id}/skills/viral-hooks/files?path=references/large.txt`, { method: 'DELETE' })).status).toBe(200)
    })

    it('accepts 10 MB per file and rejects one byte more without changing an existing skill', async () => {
        const exact = 'x'.repeat(MAX_SKILL_FILE_BYTES)
        const created = await json(`/agents/${id}/skills/import`, 'POST', {
            content: '---\nname: Size Target\ndescription: size\n---\n\nOriginal body\n',
            files: [{ path: 'references/corpus.txt', content: exact }],
        })
        expect(created.status).toBe(201)

        const rejected = await json(`/agents/${id}/skills/import`, 'POST', {
            content: '---\nname: Size Target\ndescription: changed\n---\n\nChanged body\n',
            files: [{ path: 'references/corpus.txt', content: `${exact}x` }],
            overwrite: true,
        })
        expect(rejected.status).toBe(400)
        expect(await rejected.json()).toMatchObject({ error: 'references/corpus.txt is too large (max 10 MB per file)' })

        const untouched = (await (await api(`/agents/${id}/skills/size-target`)).json()) as { description: string; body: string }
        expect(untouched).toMatchObject({ description: 'size', body: 'Original body' })
    })

    it('measures UTF-8 bytes and includes SKILL.md in the 50 MB total', () => {
        expect(skillImportSizeError([{ path: 'references/exact.txt', bytes: MAX_SKILL_FILE_BYTES }])).toBeNull()
        expect(skillImportSizeError([{ path: 'references/unicode.txt', bytes: Buffer.byteLength('é'.repeat(MAX_SKILL_FILE_BYTES / 2 + 1), 'utf8') }])).toContain('max 10 MB per file')
        expect(
            skillImportSizeError([
                { path: 'SKILL.md', bytes: 1 },
                { path: 'references/a.txt', bytes: MAX_SKILL_FOLDER_BYTES - 1 },
            ]),
        ).toContain('max 10 MB per file')
        expect(
            skillImportSizeError([
                { path: 'SKILL.md', bytes: MAX_SKILL_FILE_BYTES },
                ...Array.from({ length: 4 }, (_, i) => ({ path: `references/${i}.txt`, bytes: MAX_SKILL_FILE_BYTES })),
            ]),
        ).toBeNull()
        expect(
            skillImportSizeError([
                { path: 'SKILL.md', bytes: MAX_SKILL_FILE_BYTES },
                ...Array.from({ length: 4 }, (_, i) => ({ path: `references/${i}.txt`, bytes: MAX_SKILL_FILE_BYTES })),
                { path: 'references/overflow.txt', bytes: 1 },
            ]),
        ).toBe('Skill folder is too large (max 50 MB)')
    })

    it('writes and deletes a bundled file', async () => {
        expect((await json(`/agents/${id}/skills/viral-hooks/files`, 'PUT', { path: 'references/new.md', content: 'fresh' })).status).toBe(201)
        const afterWrite = (await (await api(`/agents/${id}/skills/viral-hooks`)).json()) as { files: string[] }
        expect(afterWrite.files).toContain('references/new.md')

        expect((await api(`/agents/${id}/skills/viral-hooks/files?path=references/new.md`, { method: 'DELETE' })).status).toBe(200)
        const afterDelete = (await (await api(`/agents/${id}/skills/viral-hooks`)).json()) as { files: string[] }
        expect(afterDelete.files).not.toContain('references/new.md')
    })

    it('refuses to delete SKILL.md through the files API', async () => {
        const res = await api(`/agents/${id}/skills/viral-hooks/files?path=SKILL.md`, { method: 'DELETE' })
        expect(res.status).toBe(400)
    })

    it('keeps bundled files when the procedure is patched', async () => {
        const res = await json(`/agents/${id}/skills/viral-hooks`, 'PATCH', { body: 'Rewritten procedure' })
        const skill = (await res.json()) as { body: string; files: string[] }
        expect(skill.body).toBe('Rewritten procedure')
        expect(skill.files).toEqual(['references/frameworks.md', 'references/hook-bank.md'])
    })

    it('serves the skill as a tar.gz rooted at the slug', async () => {
        const res = await api(`/agents/${id}/skills/viral-hooks/archive`)
        expect(res.status).toBe(200)
        expect(res.headers.get('content-disposition')).toContain('viral-hooks.tar.gz')
        expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(0)
    })

    it('refuses to overwrite an existing skill unless asked', async () => {
        const res = await json(`/agents/${id}/skills/import`, 'POST', {
            content: '---\nname: Viral Hooks\ndescription: hooks\n---\n\nsomething else\n',
        })
        expect(res.status).toBe(409)
        const untouched = (await (await api(`/agents/${id}/skills/viral-hooks`)).json()) as { body: string }
        expect(untouched.body).toBe('Rewritten procedure')
    })

    it('overwrites in place, carrying over the files it was not given', async () => {
        const res = await json(`/agents/${id}/skills/import`, 'POST', {
            content: '---\nname: Viral Hooks\ndescription: better hooks\n---\n\nBrand new procedure\n',
            files: [{ path: 'references/hook-bank.md', content: '# Hook bank v2\n' }],
            overwrite: true,
        })
        expect(res.status).toBe(200)
        const skill = (await res.json()) as { slug: string; description: string; body: string; files: string[] }
        expect(skill.slug).toBe('viral-hooks')
        expect(skill.description).toBe('better hooks')
        expect(skill.body).toBe('Brand new procedure')
        expect(skill.files).toEqual(['references/frameworks.md', 'references/hook-bank.md'])

        const read = (await (await api(`/agents/${id}/skills/viral-hooks/files/read?path=references/hook-bank.md`)).json()) as { content: string }
        expect(read.content).toBe('# Hook bank v2\n')
    })

    it('leaves the existing skill intact when a bundled file is rejected', async () => {
        const res = await json(`/agents/${id}/skills/import`, 'POST', {
            content: '---\nname: Viral Hooks\ndescription: broken\n---\n\nShould never land\n',
            files: [{ path: '../../../etc/passwd', content: 'nope' }],
            overwrite: true,
        })
        expect(res.status).toBe(400)
        const skill = (await (await api(`/agents/${id}/skills/viral-hooks`)).json()) as { description: string; body: string; files: string[] }
        expect(skill.description).toBe('better hooks')
        expect(skill.body).toBe('Brand new procedure')
        expect(skill.files).toEqual(['references/frameworks.md', 'references/hook-bank.md'])
    })

    it('renames a skill in place when targeted by slug', async () => {
        const res = await json(`/agents/${id}/skills/import`, 'POST', {
            content: '---\nname: Viral Hooks Pro\ndescription: renamed\n---\n\nBrand new procedure\n',
            slug: 'viral-hooks',
            overwrite: true,
        })
        expect(res.status).toBe(200)
        const skill = (await res.json()) as { slug: string; name: string; files: string[] }
        expect(skill.slug).toBe('viral-hooks')
        expect(skill.name).toBe('Viral Hooks Pro')
        expect(skill.files).toEqual(['references/frameworks.md', 'references/hook-bank.md'])

        const slugs = ((await (await api(`/agents/${id}/skills`)).json()) as { skills: { slug: string }[] }).skills.map(s => s.slug)
        expect(slugs).not.toContain('viral-hooks-pro')
    })

    it('takes the name and description as fields, so the body can start with a rule', async () => {
        const res = await json(`/agents/${id}/skills/import`, 'POST', {
            content: '---\n---\n\n---\n\nStep 1: do the thing. Colons: and "quotes" included.\n',
            name: 'Edge: the "hard" one',
            description: 'Use it when the body would confuse a frontmatter parser: quotes, colons, dashes.',
        })
        expect(res.status).toBe(201)
        const skill = (await res.json()) as { slug: string; name: string; description: string; body: string }
        expect(skill.name).toBe('Edge: the "hard" one')
        expect(skill.description).toBe('Use it when the body would confuse a frontmatter parser: quotes, colons, dashes.')
        expect(skill.body).toBe('---\n\nStep 1: do the thing. Colons: and "quotes" included.')

        const reread = (await (await api(`/agents/${id}/skills/${skill.slug}`)).json()) as { name: string; description: string; body: string }
        expect(reread).toMatchObject({ name: skill.name, description: skill.description, body: skill.body })
    })

    it('404s on a slug that does not exist when overwrite is not set', async () => {
        const res = await json(`/agents/${id}/skills/import`, 'POST', {
            content: '---\nname: Ghost\ndescription: x\n---\n\nbody\n',
            slug: 'nope',
        })
        expect(res.status).toBe(404)
    })

    it('404s on an unknown agent', async () => {
        expect((await api('/agents/ghost/skills')).status).toBe(404)
        expect((await api('/agents/ghost/skills/viral-hooks/files')).status).toBe(404)
    })
})
