import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

process.env.RERUN_DATA_DIR = mkdtempSync(resolve(tmpdir(), 'rerun-agents-crud-'))
process.env.RERUN_API_KEY = ''
process.env.RERUN_HUB_BASE_URL = ''

const { describe, expect, it, beforeAll } = await import('vitest')
const { createServer } = await import('../server.js')
const { migrate } = await import('../../db/migrate.js')
const { agentDir } = await import('../../config/paths.js')
const { listAgentIndex } = await import('../../db/repos/agents.js')
const { loadToken } = await import('../../tools/mcp-auth.js')
const { readAgentEnv } = await import('../../agents/env.js')

const app = createServer()

type Detail = { id: string; config: { name: string } }

function send(method: string, path: string, body?: unknown) {
    return app.request(path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
}

async function createAgent(name: string): Promise<string> {
    const res = await send('POST', '/agents', { config: { name } })
    expect(res.status).toBe(201)
    return ((await res.json()) as Detail).id
}

beforeAll(() => migrate())

describe('agent routes on an unknown agent', () => {
    it.each([
        ['GET', '/agents/ghost', undefined],
        ['GET', '/agents/ghost/tools', undefined],
        ['POST', '/agents/ghost/automations/activate', undefined],
        ['POST', '/agents/ghost/duplicate', { name: 'copy' }],
        ['GET', '/agents/ghost/archive/plan', undefined],
        ['GET', '/agents/ghost/archive', undefined],
        ['PATCH', '/agents/ghost', { name: 'x' }],
        ['PATCH', '/agents/ghost/mcp-servers', { upsert: [] }],
        ['PUT', '/agents/ghost/mcp/linear/token', { accessToken: 't' }],
        ['DELETE', '/agents/ghost/mcp/linear/token', undefined],
        ['GET', '/agents/ghost/keys', undefined],
        ['PATCH', '/agents/ghost/keys', { set: { A: '1' } }],
        ['DELETE', '/agents/ghost', undefined],
    ])('%s %s answers 404', async (method, path, body) => {
        const res = await send(method, path, body)
        expect(res.status).toBe(404)
        expect(await res.json()).toEqual({ error: 'agent not found' })
        expect(existsSync(agentDir('ghost'))).toBe(false)
    })
})

describe('agent index', () => {
    it('lists the agents it created', async () => {
        const id = await createAgent('Listed')
        const res = await send('GET', '/agents')
        expect(res.status).toBe(200)
        const { agents } = (await res.json()) as { agents: { id: string; name: string; status: string }[] }
        expect(agents).toContainEqual(expect.objectContaining({ id, name: 'Listed', status: 'idle' }))
    })

    it('renames the agent in the index', async () => {
        const id = await createAgent('Before')
        const res = await send('PATCH', `/agents/${id}`, { name: 'After' })
        expect(((await res.json()) as Detail).config.name).toBe('After')
        expect((await listAgentIndex()).find(a => a.id === id)?.name).toBe('After')
    })

    it('deletes the folder and the index entry', async () => {
        const id = await createAgent('Doomed')
        await send('GET', `/agents/${id}/sessions`)
        const res = await send('DELETE', `/agents/${id}`)
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ deleted: id })
        expect(existsSync(agentDir(id))).toBe(false)
        expect((await listAgentIndex()).map(a => a.id)).not.toContain(id)
        expect((await send('GET', `/agents/${id}`)).status).toBe(404)
    })

    it('serves the tool catalog of an agent', async () => {
        const id = await createAgent('Tools')
        const res = await send('GET', `/agents/${id}/tools`)
        expect(res.status).toBe(200)
        expect(((await res.json()) as { families: unknown[] }).families.length).toBeGreaterThan(0)
    })
})

describe('agent import', () => {
    it('needs a name for the copy', async () => {
        const res = await app.request('/agents/import', { method: 'POST', body: new Uint8Array([1, 2, 3]) })
        expect(res.status).toBe(400)
        expect(await res.json()).toEqual({ error: 'An import needs a `name` for the copy' })
    })

    it('needs an archive as the body', async () => {
        const res = await app.request('/agents/import?name=copy', { method: 'POST' })
        expect(res.status).toBe(400)
        expect(await res.json()).toEqual({ error: 'Expected a gzipped agent archive as the request body' })
    })
})

describe('agent archive', () => {
    it('streams a gzip named after the agent with its exact length', async () => {
        const id = await createAgent('Archived')
        const res = await send('GET', `/agents/${id}/archive`)
        expect(res.status).toBe(200)
        expect(res.headers.get('content-type')).toBe('application/gzip')
        expect(res.headers.get('content-disposition')).toBe(`attachment; filename="${id}.tar.gz"`)
        const bytes = new Uint8Array(await res.arrayBuffer())
        expect(Number(res.headers.get('content-length'))).toBe(bytes.byteLength)
        expect([bytes[0], bytes[1]]).toEqual([0x1f, 0x8b])
    })

    it('plans the archive before building it', async () => {
        const id = await createAgent('Planned')
        const res = await send('GET', `/agents/${id}/archive/plan`)
        expect(res.status).toBe(200)
    })
})

describe('MCP tokens', () => {
    it('stores a token, stamping when it was obtained', async () => {
        const id = await createAgent('Tokens')
        const before = Date.now()
        const res = await send('PUT', `/agents/${id}/mcp/linear/token`, { accessToken: 'at', refreshToken: 'rt' })
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ ok: true })
        const token = await loadToken(id, 'linear')
        expect(token).toMatchObject({ accessToken: 'at', refreshToken: 'rt' })
        expect(token?.obtainedAt).toBeGreaterThanOrEqual(before)
    })

    it('keeps the obtainedAt the caller sent', async () => {
        const id = await createAgent('Tokens again')
        await send('PUT', `/agents/${id}/mcp/linear/token`, { accessToken: 'at', obtainedAt: 1234 })
        expect((await loadToken(id, 'linear'))?.obtainedAt).toBe(1234)
    })

    it('refuses a token without an access token', async () => {
        const id = await createAgent('Bad token')
        expect((await send('PUT', `/agents/${id}/mcp/linear/token`, { refreshToken: 'rt' })).status).toBe(400)
    })

    it('clears a token, and clearing nothing is fine', async () => {
        const id = await createAgent('Clear token')
        await send('PUT', `/agents/${id}/mcp/linear/token`, { accessToken: 'at' })
        expect((await send('DELETE', `/agents/${id}/mcp/linear/token`)).status).toBe(200)
        expect(await loadToken(id, 'linear')).toBeNull()
        expect((await send('DELETE', `/agents/${id}/mcp/linear/token`)).status).toBe(200)
    })
})

describe('PATCH /agents/:id/keys', () => {
    it('removes before it sets, so a key in both ends up set', async () => {
        const id = await createAgent('Keys')
        await send('PATCH', `/agents/${id}/keys`, { set: { OLD: 'x', KEEP: 'y' } })
        const res = await send('PATCH', `/agents/${id}/keys`, { set: { BOTH: 'new' }, remove: ['OLD', 'BOTH'] })
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ keys: ['BOTH', 'KEEP'] })
        expect(await readAgentEnv(id)).toEqual({ BOTH: 'new', KEEP: 'y' })
    })

    it('saves screen-secret metadata beside a value and lists it back, never the value', async () => {
        const id = await createAgent('ScreenKeys')
        const res = await send('PATCH', `/agents/${id}/keys`, { set: { GH_PASSWORD: 'hunter2', PLAIN: 'x' }, screen: { GH_PASSWORD: { site: 'https://www.GitHub.com/login', allowAlways: true } } })
        expect(res.status).toBe(200)
        const listed = (await (await send('GET', `/agents/${id}/keys`)).json()) as { keys: string[]; screen: Record<string, unknown> }
        expect(listed.keys).toEqual(['GH_PASSWORD', 'PLAIN'])
        expect(listed.screen).toEqual({ GH_PASSWORD: { site: 'github.com', allowAlways: true } })
        expect(JSON.stringify(listed)).not.toContain('hunter2')
    })

    it('drops the metadata with the key and ignores metadata for a key that holds no value', async () => {
        const id = await createAgent('ScreenKeysDrop')
        await send('PATCH', `/agents/${id}/keys`, { set: { GH_PASSWORD: 'v' }, screen: { GH_PASSWORD: { site: 'site.example' } } })
        const res = await send('PATCH', `/agents/${id}/keys`, { remove: ['GH_PASSWORD'], screen: { NEVER_SET: { site: 'evil.example' } } })
        expect(res.status).toBe(200)
        const listed = (await (await send('GET', `/agents/${id}/keys`)).json()) as { screen: Record<string, unknown> }
        expect(listed.screen).toEqual({})
    })

    it('labels an already-stored key without re-sending its value', async () => {
        const id = await createAgent('ScreenKeysLate')
        await send('PATCH', `/agents/${id}/keys`, { set: { EXISTING: 'v' } })
        const res = await send('PATCH', `/agents/${id}/keys`, { screen: { EXISTING: { site: 'late.example' } } })
        expect(res.status).toBe(200)
        const listed = (await (await send('GET', `/agents/${id}/keys`)).json()) as { screen: Record<string, unknown> }
        expect(listed.screen).toEqual({ EXISTING: { site: 'late.example', allowAlways: false } })
    })

    it('refuses metadata whose site is not a site', async () => {
        const id = await createAgent('ScreenKeysBadSite')
        const res = await send('PATCH', `/agents/${id}/keys`, { set: { KEY: 'v' }, screen: { KEY: { site: 'not a site' } } })
        expect(res.status).toBe(400)
    })
})
