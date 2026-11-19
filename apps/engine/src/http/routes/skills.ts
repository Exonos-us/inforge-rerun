import { Hono } from 'hono'
import type { Context } from 'hono'
import { Readable } from 'node:stream'
import { z } from 'zod'
import { create } from 'tar'
import { MAX_SKILL_FILE_BYTES, MAX_SKILL_FOLDER_BYTES, MAX_SKILL_REFERENCE_FILES, skillFilePayloadSchema } from '@rerun/contracts'
import { deleteSkill, listSkillSummaries, listSkills, parseSkillMarkdown, readSkill, skillExists, writeSkill, writeSkillFolder } from '../../skills/loader.js'
import { skillDir, skillsDir } from '../../config/paths.js'
import { createFilesRouter } from './files.js'
import { agentExists } from '../../agents/loader.js'
import { badRequest, notFound } from '../../lib/errors.js'
import { slugify } from '../../lib/ids.js'

export const skillRoutes = new Hono()

export function skillImportSizeError(entries: { path: string; bytes: number }[]): string | null {
    let total = 0
    for (const entry of entries) {
        if (entry.bytes > MAX_SKILL_FILE_BYTES) return `${entry.path} is too large (max 10 MB per file)`
        total += entry.bytes
        if (total > MAX_SKILL_FOLDER_BYTES) return 'Skill folder is too large (max 50 MB)'
    }
    return null
}

function requireAgent(c: Context): string {
    const agentId = c.req.param('id')!
    if (!agentExists(agentId)) throw notFound('agent')
    return agentId
}

export function createSkillFilesRouter(): Hono {
    const router = new Hono()
    router.use('*', async (c, next) => {
        const path = c.req.query('path')?.replace(/^\.\//, '')
        if (c.req.method === 'DELETE' && path === 'SKILL.md') throw badRequest('Delete the whole skill instead of its SKILL.md')
        await next()
    })
    router.route(
        '/',
        createFilesRouter(c => {
            const agentId = requireAgent(c)
            const slug = c.req.param('slug')!
            if (!skillExists(agentId, slug)) throw notFound('skill')
            return skillDir(agentId, slug)
        })
    )
    return router
}

skillRoutes.get('/', async c => {
    const agentId = requireAgent(c)
    // The summary leaves out each body and file list: a listing that only shows names reads one
    // frontmatter per skill instead of walking every skill folder.
    if (c.req.query('summary') === '1') return c.json({ skills: await listSkillSummaries(agentId) })
    return c.json({ skills: await listSkills(agentId) })
})

skillRoutes.post('/', async c => {
    const agentId = requireAgent(c)
    const body = z.object({ name: z.string().min(1), description: z.string().default(''), body: z.string().min(1) }).parse(await c.req.json())
    const skill = await writeSkill(agentId, body.name, body.description, body.body)
    return c.json(skill, 201)
})

skillRoutes.post('/import', async c => {
    const agentId = requireAgent(c)
    const input = z
        .object({
            content: z.string().min(1),
            name: z.string().optional(),
            description: z.string().optional(),
            files: z.array(skillFilePayloadSchema).max(MAX_SKILL_REFERENCE_FILES).default([]),
            slug: z.string().optional(),
            overwrite: z.boolean().default(false),
        })
        .parse(await c.req.json())

    const sizeError = skillImportSizeError([
        { path: 'SKILL.md', bytes: Buffer.byteLength(input.content, 'utf8') },
        ...input.files.map(file => ({ path: file.path, bytes: Buffer.byteLength(file.content, 'utf8') })),
    ])
    if (sizeError) return c.json({ error: sizeError }, 400)

    let parsed: { name: string; description: string; body: string }
    try {
        parsed = parseSkillMarkdown(input.content, { name: input.name, description: input.description })
    } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : 'Invalid skill file' }, 400)
    }

    const slug = input.slug ?? slugify(parsed.name)
    const existed = skillExists(agentId, slug)
    // An explicit slug alone must not create: a typo would silently leave a stray skill behind.
    // With `overwrite` the caller is saying "put this skill at this slug, whatever is there", so
    // creating it is the obvious meaning — that is how a client skill lands the first time.
    if (input.slug && !existed && !input.overwrite) return c.json({ error: 'skill not found' }, 404)
    if (existed && !input.overwrite) return c.json({ error: `A skill named "${parsed.name}" already exists` }, 409)

    try {
        const skill = await writeSkillFolder(agentId, { slug, name: parsed.name, description: parsed.description, body: parsed.body, files: input.files })
        return c.json(skill, existed ? 200 : 201)
    } catch (err) {
        return c.json({ error: `Could not import the skill: ${err instanceof Error ? err.message : 'invalid path'}` }, 400)
    }
})

skillRoutes.get('/:slug', async c => {
    const agentId = requireAgent(c)
    const slug = c.req.param('slug')
    if (!skillExists(agentId, slug)) return c.json({ error: 'skill not found' }, 404)
    return c.json(await readSkill(agentId, slug))
})

skillRoutes.get('/:slug/archive', async c => {
    const agentId = requireAgent(c)
    const slug = c.req.param('slug')
    if (!skillExists(agentId, slug)) return c.json({ error: 'skill not found' }, 404)
    const pack = create({ gzip: true, cwd: skillsDir(agentId), portable: true }, [slug]) as unknown as AsyncIterable<Uint8Array>
    return new Response(Readable.toWeb(Readable.from(pack)) as ReadableStream, {
        headers: {
            'Content-Type': 'application/gzip',
            'Content-Disposition': `attachment; filename="${slug}.tar.gz"`,
        },
    })
})

skillRoutes.patch('/:slug', async c => {
    const agentId = requireAgent(c)
    const slug = c.req.param('slug')
    if (!skillExists(agentId, slug)) return c.json({ error: 'skill not found' }, 404)
    const current = await readSkill(agentId, slug)
    const body = z.object({ description: z.string().optional(), body: z.string().optional() }).parse(await c.req.json())
    const skill = await writeSkill(agentId, current.name, body.description ?? current.description, body.body ?? current.body)
    return c.json(skill)
})

skillRoutes.delete('/:slug', async c => {
    const agentId = requireAgent(c)
    const slug = c.req.param('slug')
    if (!skillExists(agentId, slug)) return c.json({ error: 'skill not found' }, 404)
    await deleteSkill(agentId, slug)
    return c.body(null, 204)
})
