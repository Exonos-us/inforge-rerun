import { Hono } from 'hono'
import { rm, writeFile, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { Readable } from 'node:stream'
import { createAgentSchema, duplicateAgentSchema, mcpTokenSchema, updateAgentKeysSchema, updateAgentMcpServersSchema } from '@rerun/contracts'
import { dropScreenSecretMeta, listScreenSecretMeta, saveScreenSecretMeta } from '../../desktop/screen-secrets.js'
import { clearToken, saveToken } from '../../tools/mcp-auth.js'
import { probeMcpStatuses } from '../../tools/mcp-status.js'
import { agentMcpSpawn } from '../../tools/mcp-pool.js'
import { createAgent } from '../../agents/factory.js'
import { agentConfigSchema, BRIDGE_SERVER_NAME, MCP_SERVER_NAME_RE } from '../../agents/types.js'
import { readAgentEnv, writeAgentEnv } from '../../agents/env.js'
import { reloadAgent, unloadAgent } from '../../agents/registry.js'
import { agentExists, loadAgentFromDisk, loadAgentView, readAgentConfig } from '../../agents/loader.js'
import { withAgentLock } from '../../agents/lock.js'
import { buildArchive, planArchive } from '../../agents/archive.js'
import { importAgent } from '../../agents/import.js'
import { duplicateAgent } from '../../agents/duplicate.js'
import { activateAutomations } from '../../agents/automations.js'
import { replaceDisplayName, rewriteRenamedAgentReferences } from '../../agents/rename-references.js'
import { badRequest } from '../../lib/errors.js'
import { writeAgentConfig, mergeMcpServers, ReservedMcpServerNameError, InvalidMcpServerNameError } from '../../agents/config-write.js'
import { deleteAgentIndex, listAgentIndex, updateAgentIndex } from '../../db/repos/agents.js'
import { closeSystemDb } from '../../db/systemDb.js'
import { closeAgentDb } from '../../db/agentDb.js'
import { stopDesktop } from '../../desktop/session.js'
import { finishTakeover } from '../../desktop/takeover.js'
import { agentDir, configPath, installPath, soulPath } from '../../config/paths.js'
import { agentToolCatalog } from '../../tools/catalog.js'
import type { RunModel } from '../../agents/availability.js'

export const agentRoutes = new Hono()

function publicView(id: string, config: unknown, soul: string, install: string, resolved: RunModel) {
    return { id, config, soul, install, resolvedConnectionId: resolved.connection?.id ?? null, resolvedProvider: resolved.provider, resolvedModel: resolved.model }
}

agentRoutes.get('/', async c => {
    const index = await listAgentIndex()
    return c.json({ agents: index })
})

agentRoutes.post('/', async c => {
    const body = createAgentSchema.parse(await c.req.json())
    const agent = await createAgent({ config: body.config, soul: body.soul, install: body.install, keys: body.keys })
    return c.json(publicView(agent.id, agent.config, agent.soul, agent.install, agent.resolved), 201)
})

// The body is the gzipped folder itself rather than a multipart field: an archive runs to
// 150 MB and `parseBody` would hold all of it in memory before anything is written.
agentRoutes.post('/import', async c => {
    const name = c.req.query('name')
    if (!name) throw badRequest('An import needs a `name` for the copy')
    const body = c.req.raw.body
    if (!body) throw badRequest('Expected a gzipped agent archive as the request body')
    return c.json(await importAgent({ body, name, displayName: c.req.query('displayName') }), 201)
})

agentRoutes.get('/:id', async c => {
    const id = c.req.param('id')
    if (!agentExists(id)) return c.json({ error: 'agent not found' }, 404)
    const agent = await loadAgentView(id)
    return c.json(publicView(id, agent.config, agent.soul, agent.install, agent.resolved))
})

agentRoutes.get('/:id/tools', async c => {
    const id = c.req.param('id')
    if (!agentExists(id)) return c.json({ error: 'agent not found' }, 404)
    return c.json({ families: agentToolCatalog(await readAgentConfig(id)) })
})

// The host's way of closing an installation the user skipped: `install_complete` is the agent's,
// and a skipped setup never reaches it.
agentRoutes.post('/:id/automations/activate', async c => {
    const id = c.req.param('id')
    if (!agentExists(id)) return c.json({ error: 'agent not found' }, 404)
    return c.json(await activateAutomations(await loadAgentFromDisk(id)))
})

// A copy on this same box, which is why it takes a JSON body and not a tarball: nothing leaves
// the engine, so nothing has to be packed, redacted or re-authorized on the way.
agentRoutes.post('/:id/duplicate', async c => {
    const id = c.req.param('id')
    if (!agentExists(id)) return c.json({ error: 'agent not found' }, 404)
    const body = duplicateAgentSchema.parse(await c.req.json())
    return c.json(await duplicateAgent(id, body), 201)
})

agentRoutes.get('/:id/archive/plan', async c => {
    const id = c.req.param('id')
    if (!agentExists(id)) return c.json({ error: 'agent not found' }, 404)
    return c.json(await planArchive(id, c.req.queries('exclude') ?? []))
})

agentRoutes.get('/:id/archive', async c => {
    const id = c.req.param('id')
    if (!agentExists(id)) return c.json({ error: 'agent not found' }, 404)
    const { stream, bytes } = await buildArchive(id, c.req.queries('exclude') ?? [])
    return new Response(Readable.toWeb(stream) as ReadableStream, {
        headers: {
            'Content-Type': 'application/gzip',
            'Content-Length': String(bytes),
            'Content-Disposition': `attachment; filename="${id}.tar.gz"`,
        },
    })
})

agentRoutes.patch('/:id', async c => {
    const id = c.req.param('id')
    if (!agentExists(id)) return c.json({ error: 'agent not found' }, 404)
    const body = (await c.req.json()) as Record<string, unknown>
    if ('mcpServers' in body) return c.json({ error: 'mcpServers cannot be set here; use PATCH /agents/:id/mcp-servers with { upsert, remove }' }, 400)
    // `.partial()` makes every field optional but still materialises its `.default()`, so parsing
    // `{ verbosity }` hands back a full config where provider, model and description have silently
    // reverted. Keep only the fields the caller actually sent, or a PATCH would reset the rest.
    const validated = agentConfigSchema.partial().parse(body) as Record<string, unknown>
    const patch = Object.fromEntries(Object.entries(validated).filter(([field]) => field in body))
    const agent = await withAgentLock(id, async () => {
        const current = agentConfigSchema.parse(JSON.parse(await readFile(configPath(id), 'utf8')))
        const next = agentConfigSchema.parse({
            ...current,
            ...patch,
            mcpServers: current.mcpServers,
            tools: { ...current.tools, ...(body.tools as object | undefined) },
            selfImprovement: { ...current.selfImprovement, ...(body.selfImprovement as object | undefined) },
            setup: { ...current.setup, ...(body.setup as object | undefined) },
        })
        await writeAgentConfig(id, next)
        if (next.name !== current.name) {
            await updateAgentIndex(id, next.name)
        }
        if (typeof body.soul === 'string' && body.soul.trim().length > 0) {
            await writeFile(soulPath(id), `${body.soul.trim()}\n`, 'utf8')
        } else if (next.displayName && current.displayName?.trim() && next.displayName !== current.displayName && existsSync(soulPath(id))) {
            // The soul is written once, at creation, with the name the agent had then.
            const soul = await readFile(soulPath(id), 'utf8')
            const renamed = replaceDisplayName(soul, current.displayName.trim(), next.displayName)
            if (renamed !== soul) await writeFile(soulPath(id), renamed, 'utf8')
        }
        // Unlike the soul, an install prompt has to be erasable: answering "no setup needed"
        // means the file goes away, not that the previous instructions stay behind.
        if (typeof body.install === 'string') {
            const install = body.install.trim()
            if (install.length > 0) await writeFile(installPath(id), `${install}\n`, 'utf8')
            else await rm(installPath(id), { force: true })
        }
        return { renamedFrom: next.name !== current.name ? current.name : null, loaded: await reloadAgent(id) }
    })
    // Outside the lock: the rewrite takes every other agent's lock in turn, and two renames each
    // holding their own while waiting on the other's would never finish.
    if (agent.renamedFrom) await rewriteRenamedAgentReferences(id, agent.renamedFrom, agent.loaded.config.name)
    const view = agent.renamedFrom ? await reloadAgent(id) : agent.loaded
    return c.json(publicView(id, view.config, view.soul, view.install, view.resolved))
})

agentRoutes.patch('/:id/mcp-servers', async c => {
    const id = c.req.param('id')
    if (!agentExists(id)) return c.json({ error: 'agent not found' }, 404)
    const { upsert, remove } = updateAgentMcpServersSchema.parse(await c.req.json())
    if (upsert?.some(server => server.name === BRIDGE_SERVER_NAME)) return c.json({ error: new ReservedMcpServerNameError().message }, 400)
    const invalid = upsert?.find(server => !MCP_SERVER_NAME_RE.test(server.name))
    if (invalid) return c.json({ error: new InvalidMcpServerNameError(invalid.name).message }, 400)
    const agent = await withAgentLock(id, async () => {
        const current = agentConfigSchema.parse(JSON.parse(await readFile(configPath(id), 'utf8')))
        current.mcpServers = mergeMcpServers(current.mcpServers, { upsert, remove })
        await writeAgentConfig(id, current)
        return reloadAgent(id)
    })
    return c.json(publicView(id, agent.config, agent.soul, agent.install, agent.resolved))
})

// Dials every server for real, so it is slow by nature: a caller asks for the names it needs.
agentRoutes.get('/:id/mcp-servers/status', async c => {
    const id = c.req.param('id')
    if (!agentExists(id)) return c.json({ error: 'agent not found' }, 404)
    const names = c.req.queries('name')
    const [config, env] = await Promise.all([readAgentConfig(id), readAgentEnv(id)])
    const servers = config.mcpServers.filter(server => server.name !== BRIDGE_SERVER_NAME && (!names || names.includes(server.name)))
    return c.json({ servers: await probeMcpStatuses(id, servers, env, agentMcpSpawn({ id, env, config })) })
})

agentRoutes.put('/:id/mcp/:name/token', async c => {
    const id = c.req.param('id')
    if (!agentExists(id)) return c.json({ error: 'agent not found' }, 404)
    const token = mcpTokenSchema.parse(await c.req.json())
    await saveToken(id, c.req.param('name'), { ...token, obtainedAt: token.obtainedAt ?? Date.now() })
    return c.json({ ok: true })
})

agentRoutes.delete('/:id/mcp/:name/token', async c => {
    const id = c.req.param('id')
    if (!agentExists(id)) return c.json({ error: 'agent not found' }, 404)
    await clearToken(id, c.req.param('name'))
    return c.json({ ok: true })
})

agentRoutes.get('/:id/keys', async c => {
    const id = c.req.param('id')
    if (!agentExists(id)) return c.json({ error: 'agent not found' }, 404)
    const env = await readAgentEnv(id)
    const engineKeys = Object.keys(process.env)
        .filter(key => key.startsWith('RERUN_') && process.env[key])
        .sort()
    return c.json({ keys: Object.keys(env).sort(), engineKeys, screen: await listScreenSecretMeta(id) })
})

agentRoutes.patch('/:id/keys', async c => {
    const id = c.req.param('id')
    if (!agentExists(id)) return c.json({ error: 'agent not found' }, 404)
    const { set, remove, screen } = updateAgentKeysSchema.parse(await c.req.json())
    const keys = await withAgentLock(id, async () => {
        const next = await readAgentEnv(id)
        for (const key of remove) delete next[key]
        for (const [key, value] of Object.entries(set)) next[key] = value
        await writeAgentEnv(id, next)
        // Metadata rides along with a value, never ahead of one: a site labelling a key that holds
        // nothing would let a later value inherit a scope nobody confirmed for it.
        await dropScreenSecretMeta(id, remove)
        for (const [key, meta] of Object.entries(screen)) {
            if (key in next) await saveScreenSecretMeta(id, key, meta)
        }
        await reloadAgent(id)
        return Object.keys(next).sort()
    })
    return c.json({ keys })
})

agentRoutes.delete('/:id', async c => {
    const id = c.req.param('id')
    if (!agentExists(id)) return c.json({ error: 'agent not found' }, 404)
    await finishTakeover(id)
    await stopDesktop(id)
    unloadAgent(id)
    closeSystemDb(id)
    closeAgentDb(id)
    await deleteAgentIndex(id)
    await rm(agentDir(id), { recursive: true, force: true })
    return c.json({ deleted: id })
})
