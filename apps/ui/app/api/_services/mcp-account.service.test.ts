import { workspaceActor } from '@/app/api/_auth/access'
import { MAX_TEXT_WRITE_CHARS } from '@rerun/contracts'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { agentFilesBase, chat as engineChat, createMemory, createSchedule, createTrigger, getAgent, importSkill, listConnections, listSchedules, listSkills, listTriggers, patchAgent, updateSchedule, updateTrigger, uploadFile, writeFileText } from '@/lib/engine/client'
import { createServiceRoleClient } from '@/supabase/serviceRole'
import { fakeSupabase, type FakeSupabase, type SupabaseCall } from '@/test/supabase-fake'

import type { ServiceManifest } from '@/lib/services/manifest'
import type { InstalledService } from '@/lib/services/types'

import { changeAgentHandle, createAgent, deleteAgent, renameAgent } from './agent.service'
import { LOCKED_WRITE_ERROR } from './agent-content.service'
import { declareService } from './agent-setup.service'
import { resolveAgentTarget } from './chat.service'
import { dispatchAccountTool } from './mcp-account.service'
import { allocateServiceInstance, listInstalledServices, loadManifest, uninstallService } from './services.service'

vi.mock('@/supabase/serviceRole', () => ({ createServiceRoleClient: vi.fn() }))
vi.mock('@/lib/engine/client')
vi.mock('./workspace-engine.service', () => ({ findWorkspaceEngine: vi.fn(), getConnectionForAgent: vi.fn(), getWorkspaceConnection: vi.fn() }))
vi.mock('./agent.service', () => ({ changeAgentHandle: vi.fn(), createAgent: vi.fn(), deleteAgent: vi.fn(), moveAgentToBox: vi.fn(), renameAgent: vi.fn() }))
vi.mock('./agent-setup.service', () => ({ declareService: vi.fn(), installServiceSlugs: vi.fn() }))
vi.mock('./chat.service', () => ({ ensureSessionRow: vi.fn(), resolveAgentTarget: vi.fn() }))
vi.mock('./services.service', () => ({
    allocateServiceInstance: vi.fn(),
    listCatalogServices: vi.fn(),
    listInstalledServices: vi.fn(),
    loadManifest: vi.fn(),
    searchCatalogServices: vi.fn(),
    toAuthMethodSummaries: vi.fn(() => []),
    uninstallService: vi.fn(),
}))
vi.mock('./mcp-shares.service', () => ({ dispatchShareTool: vi.fn() }))

const WORKSPACE_ID = 7
const FOREIGN_WORKSPACE_ID = 99
// The API key and the foreman act as the workspace itself, which reaches every Box.
const ACTOR = { kind: 'workspace', workspaceId: WORKSPACE_ID }

const AGENTS: Record<string, Record<string, unknown>> = {
    'agent-own': { workspace_id: WORKSPACE_ID, space_id: 'box-own' },
    'agent-foreign': { workspace_id: FOREIGN_WORKSPACE_ID, space_id: 'box-foreign' },
    'agent-sealed': { workspace_id: WORKSPACE_ID, space_id: 'box-own' },
}

const SPACES = [
    { id: 'box-own', name: 'Sales', workspace_id: WORKSPACE_ID, visibility: 'restricted' },
    { id: 'box-foreign', name: 'Theirs', workspace_id: FOREIGN_WORKSPACE_ID, visibility: 'workspace' },
]

function gmailManifest(multiInstance: boolean): ServiceManifest {
    return { slug: 'gmail', name: 'Gmail', multiInstance } as ServiceManifest
}

function installed(key: string, label?: string): InstalledService {
    const [slug, instanceId] = key.split('@')
    return { key, slug, ...(instanceId ? { instanceId } : {}), ...(label ? { label } : {}), name: 'Gmail', icon: null, category: 'productivity', status: 'needs_auth', toolNames: [], installedAt: '2026-10-23T00:00:00.000Z' }
}

function eqValue(calls: readonly SupabaseCall[], column: string): unknown {
    return calls.find(call => call.method === 'eq' && call.args[0] === column)?.args[1]
}

function resolveRow(table: string, calls: readonly SupabaseCall[]) {
    if (table === 'agents') return { data: AGENTS[eqValue(calls, 'id') as string] ?? null }
    if (table === 'spaces' && eqValue(calls, 'id') !== undefined && eqValue(calls, 'workspace_id') === undefined) return { data: SPACES.find(space => space.id === eqValue(calls, 'id')) ?? null }
    if (table === 'spaces') return { data: SPACES.filter(space => space.workspace_id === eqValue(calls, 'workspace_id')) }
    return undefined
}

describe('dispatchAccountTool', () => {
    let db: FakeSupabase

    beforeEach(() => {
        vi.clearAllMocks()
        db = fakeSupabase(resolveRow)
        vi.mocked(createServiceRoleClient).mockReturnValue(db.client)
    })

    describe('send_message', () => {
        const CONN = { baseUrl: 'https://engine.test', apiKey: null }
        const member = { kind: 'user', userId: 'u-member', workspaceId: WORKSPACE_ID, role: 'member', boxScope: 'all' } as const

        beforeEach(() => {
            vi.mocked(resolveAgentTarget).mockResolvedValue({ conn: CONN, engineAgentId: 'engine-own', contentLocked: false } as never)
            vi.mocked(engineChat).mockResolvedValue(new Response('down', { status: 503 }))
        })

        it('hands the engine the coworkers a member reaches, so the coworker cannot call into a Box closed to them', async () => {
            await expect(dispatchAccountTool(member, 'send_message', { agentId: 'agent-own', message: 'hi' })).rejects.toThrow(/could not be reached/)

            expect(vi.mocked(engineChat).mock.calls[0][2]).toMatchObject({ callableAgentIds: [] })
        })

        it('names nobody for an API key, which reaches every Box', async () => {
            await expect(dispatchAccountTool(workspaceActor(WORKSPACE_ID), 'send_message', { agentId: 'agent-own', message: 'hi' })).rejects.toThrow(/could not be reached/)

            expect(vi.mocked(engineChat).mock.calls[0][2]).toMatchObject({ callableAgentIds: undefined })
        })
    })

    describe('delete_agent', () => {
        it('refuses to delete without an explicit confirmation', async () => {
            await expect(dispatchAccountTool(workspaceActor(WORKSPACE_ID), 'delete_agent', { agentId: 'agent-own' })).rejects.toThrow(/confirm: true/)
            await expect(dispatchAccountTool(workspaceActor(WORKSPACE_ID), 'delete_agent', { agentId: 'agent-own', confirm: 'yes' })).rejects.toThrow(/confirm: true/)

            expect(deleteAgent).not.toHaveBeenCalled()
        })

        it('refuses an agent of another workspace even when confirmed', async () => {
            await expect(dispatchAccountTool(workspaceActor(WORKSPACE_ID), 'delete_agent', { agentId: 'agent-foreign', confirm: true })).rejects.toThrow('Coworker not found')

            expect(deleteAgent).not.toHaveBeenCalled()
        })

        it('refuses an agent that does not exist', async () => {
            await expect(dispatchAccountTool(workspaceActor(WORKSPACE_ID), 'delete_agent', { agentId: 'agent-missing', confirm: true })).rejects.toThrow('Coworker not found')

            expect(deleteAgent).not.toHaveBeenCalled()
        })

        it('deletes a confirmed agent of the workspace', async () => {
            await expect(dispatchAccountTool(workspaceActor(WORKSPACE_ID), 'delete_agent', { agentId: 'agent-own', confirm: true })).resolves.toEqual({ agentId: 'agent-own', deleted: true })
            expect(db.chainsOn('space_members')).toEqual([])

            expect(deleteAgent).toHaveBeenCalledWith('agent-own')
        })
    })

    describe('create_agent', () => {
        it('refuses a Box of another workspace', async () => {
            await expect(dispatchAccountTool(workspaceActor(WORKSPACE_ID), 'create_agent', { name: 'Scout', spaceId: 'box-foreign' })).rejects.toThrow('Box not found')

            expect(eqValue(db.chainsOn('spaces')[0], 'workspace_id')).toBe(WORKSPACE_ID)
            expect(createAgent).not.toHaveBeenCalled()
        })

        it('creates the agent in the Box of the workspace it names', async () => {
            vi.mocked(createAgent).mockResolvedValue({ id: 'agent-new', name: 'Scout', handle: 'scout', disabled_at: null } as never)

            await expect(dispatchAccountTool(workspaceActor(WORKSPACE_ID), 'create_agent', { name: 'Scout', spaceId: 'box-own' })).resolves.toMatchObject({ agentId: 'agent-new', spaceId: 'box-own', active: true })

            expect(createAgent).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: WORKSPACE_ID, spaceId: 'box-own', actor: ACTOR }))
        })
    })

    describe('connectors', () => {
        const NEW_ACCOUNT = { key: 'gmail@k3x9ab', instanceId: 'k3x9ab', label: 'Gmail 2' }

        beforeEach(() => {
            vi.mocked(resolveAgentTarget).mockResolvedValue({} as never)
            vi.mocked(declareService).mockResolvedValue('compiled')
            vi.mocked(allocateServiceInstance).mockResolvedValue(NEW_ACCOUNT)
            vi.mocked(listInstalledServices).mockResolvedValue({ services: [installed('gmail', 'me@work.com'), installed('gmail@k3x9ab', 'Gmail 2')] })
        })

        it('lists one row per account, keyed', async () => {
            await expect(dispatchAccountTool(workspaceActor(WORKSPACE_ID), 'list_agent_connectors', { agentId: 'agent-own' })).resolves.toEqual({
                connectors: [
                    { key: 'gmail', slug: 'gmail', name: 'Gmail', label: 'me@work.com', status: 'needs_auth', toolNames: [] },
                    { key: 'gmail@k3x9ab', slug: 'gmail', name: 'Gmail', label: 'Gmail 2', status: 'needs_auth', toolNames: [] },
                ],
            })
        })

        it('declares the base account without newInstance', async () => {
            vi.mocked(loadManifest).mockResolvedValue(gmailManifest(true))

            await expect(dispatchAccountTool(workspaceActor(WORKSPACE_ID), 'attach_connector', { agentId: 'agent-own', slug: 'gmail' })).resolves.toMatchObject({ key: 'gmail', slug: 'gmail', label: 'me@work.com' })

            expect(allocateServiceInstance).not.toHaveBeenCalled()
            expect(resolveAgentTarget).toHaveBeenCalledWith('agent-own', ACTOR, 'manage')
            expect(declareService).toHaveBeenCalledWith('agent-own', gmailManifest(true), ACTOR, undefined)
        })

        it('declares another account of an app that supports several', async () => {
            vi.mocked(loadManifest).mockResolvedValue(gmailManifest(true))

            await expect(dispatchAccountTool(workspaceActor(WORKSPACE_ID), 'attach_connector', { agentId: 'agent-own', slug: 'gmail', newInstance: true })).resolves.toMatchObject({
                key: 'gmail@k3x9ab',
                slug: 'gmail',
                label: 'Gmail 2',
                status: 'needs_auth',
            })

            expect(declareService).toHaveBeenCalledWith('agent-own', gmailManifest(true), ACTOR, NEW_ACCOUNT)
        })

        it('ignores newInstance on an app limited to one account', async () => {
            vi.mocked(loadManifest).mockResolvedValue(gmailManifest(false))

            await expect(dispatchAccountTool(workspaceActor(WORKSPACE_ID), 'attach_connector', { agentId: 'agent-own', slug: 'gmail', newInstance: true })).resolves.toMatchObject({ key: 'gmail' })

            expect(allocateServiceInstance).not.toHaveBeenCalled()
            expect(declareService).toHaveBeenCalledWith('agent-own', gmailManifest(false), ACTOR, undefined)
        })

        it('refuses an app the catalog does not know', async () => {
            vi.mocked(loadManifest).mockResolvedValue(null)

            await expect(dispatchAccountTool(workspaceActor(WORKSPACE_ID), 'attach_connector', { agentId: 'agent-own', slug: 'nope' })).rejects.toThrow('Unknown app "nope"')

            expect(declareService).not.toHaveBeenCalled()
        })

        it('detaches one account by its key', async () => {
            await expect(dispatchAccountTool(workspaceActor(WORKSPACE_ID), 'detach_connector', { agentId: 'agent-own', key: 'gmail@k3x9ab', slug: 'gmail', confirm: true })).resolves.toEqual({ key: 'gmail@k3x9ab', detached: true })

            expect(uninstallService).toHaveBeenCalledWith('agent-own', 'gmail@k3x9ab', ACTOR)
        })

        it('detaches the base account by its slug', async () => {
            await expect(dispatchAccountTool(workspaceActor(WORKSPACE_ID), 'detach_connector', { agentId: 'agent-own', slug: 'gmail', confirm: true })).resolves.toEqual({ key: 'gmail', detached: true })

            expect(uninstallService).toHaveBeenCalledWith('agent-own', 'gmail', ACTOR)
        })
    })

    describe('agent identity and reads', () => {
        const conn = { url: 'https://engine.test', apiKey: 'key' }

        beforeEach(() => {
            vi.mocked(resolveAgentTarget).mockResolvedValue({ conn, engineAgentId: 'engine-own', contentLocked: false } as never)
        })

        it('lists the identity fields a rename wrote in updated', async () => {
            vi.mocked(renameAgent).mockResolvedValue({ name: 'Worker B', handle: 'worker_b', handleChanged: true })

            await expect(dispatchAccountTool(workspaceActor(WORKSPACE_ID), 'update_agent', { agentId: 'agent-own', name: 'Worker B' })).resolves.toMatchObject({
                updated: ['name', 'handle'],
                name: 'Worker B',
                handle: 'worker_b',
            })
        })

        it('leaves handle out of updated when the rename re-derives the same one', async () => {
            vi.mocked(renameAgent).mockResolvedValue({ name: 'Worker A!', handle: 'worker_a', handleChanged: false })

            await expect(dispatchAccountTool(workspaceActor(WORKSPACE_ID), 'update_agent', { agentId: 'agent-own', name: 'Worker A!' })).resolves.toMatchObject({
                updated: ['name'],
                name: 'Worker A!',
                handle: 'worker_a',
            })
        })

        it('refuses upsert_skill naming the same reference file in files and removeFiles, whatever the spelling', async () => {
            await expect(
                dispatchAccountTool(workspaceActor(WORKSPACE_ID), 'upsert_skill', { agentId: 'agent-own', name: 'Fixture', body: 'Body', files: [{ path: 'references/a.md', content: 'x' }], removeFiles: ['references/../references/a.md'] }),
            ).rejects.toThrow('in both files and removeFiles')

            expect(importSkill).not.toHaveBeenCalled()
        })

        it('lists the handle a handle change wrote in updated', async () => {
            vi.mocked(changeAgentHandle).mockResolvedValue({ name: 'Worker A', handle: 'custom_key' })

            await expect(dispatchAccountTool(workspaceActor(WORKSPACE_ID), 'update_agent', { agentId: 'agent-own', handle: 'custom_key' })).resolves.toMatchObject({ updated: ['handle'], handle: 'custom_key' })
        })

        it('keeps listing only the config fields of an update that leaves the identity alone', async () => {
            await expect(dispatchAccountTool(workspaceActor(WORKSPACE_ID), 'update_agent', { agentId: 'agent-own', description: 'Finds leads' })).resolves.toMatchObject({ updated: ['description'] })

            expect(renameAgent).not.toHaveBeenCalled()
            expect(changeAgentHandle).not.toHaveBeenCalled()
        })

        it('names a part get_agent could not read instead of passing it off as empty', async () => {
            vi.mocked(getAgent).mockResolvedValue({ config: { name: 'scout', displayName: 'Scout', setup: { required: false, completedAt: null }, mcpServers: [] }, soul: 'You are Scout.' } as never)
            vi.mocked(listConnections).mockResolvedValue({ connections: [] } as never)
            vi.mocked(listSkills).mockResolvedValue([])
            vi.mocked(listTriggers).mockResolvedValue([])
            vi.mocked(listInstalledServices).mockResolvedValue({ services: [] } as never)

            vi.mocked(listSchedules).mockRejectedValueOnce(new Error('engine GET schedules failed: 500'))
            const failed = await dispatchAccountTool(workspaceActor(WORKSPACE_ID), 'get_agent', { agentId: 'agent-own' })
            expect(failed).toMatchObject({ schedules: [], unavailable: ['schedules'] })

            vi.mocked(listSchedules).mockResolvedValueOnce([])
            const empty = await dispatchAccountTool(workspaceActor(WORKSPACE_ID), 'get_agent', { agentId: 'agent-own' })
            expect(empty).toMatchObject({ schedules: [] })
            expect(empty).not.toHaveProperty('unavailable')
        })

        it('refuses upsert_skill removing the skill folder itself before the body is written', async () => {
            await expect(dispatchAccountTool(workspaceActor(WORKSPACE_ID), 'upsert_skill', { agentId: 'agent-own', name: 'Fixture', body: 'Changed body', removeFiles: ['.'] })).rejects.toThrow('not a file of the skill')

            expect(importSkill).not.toHaveBeenCalled()
        })
    })

    describe('template content lock', () => {
        beforeEach(() => {
            vi.mocked(resolveAgentTarget).mockResolvedValue({ conn: { url: 'https://engine.test', apiKey: 'key' }, engineAgentId: 'engine-sealed', contentLocked: true } as never)
        })

        it('refuses update_agent writing the soul of an agent whose template content is locked', async () => {
            await expect(dispatchAccountTool(workspaceActor(WORKSPACE_ID), 'update_agent', { agentId: 'agent-sealed', soul: 'New soul', name: 'Renamed' })).rejects.toThrow(LOCKED_WRITE_ERROR)

            expect(patchAgent).not.toHaveBeenCalled()
            expect(renameAgent).not.toHaveBeenCalled()
        })

        it('lets update_agent change the rest of a locked agent', async () => {
            await expect(dispatchAccountTool(workspaceActor(WORKSPACE_ID), 'update_agent', { agentId: 'agent-sealed', description: 'Finds leads' })).resolves.toMatchObject({ updated: ['description'] })

            expect(patchAgent).toHaveBeenCalledWith(expect.anything(), 'engine-sealed', { description: 'Finds leads' })
        })

        it('refuses upsert_skill writing a skill on an agent whose template content is locked', async () => {
            await expect(dispatchAccountTool(workspaceActor(WORKSPACE_ID), 'upsert_skill', { agentId: 'agent-sealed', name: 'Outreach', body: 'Rewritten' })).rejects.toThrow(LOCKED_WRITE_ERROR)

            expect(importSkill).not.toHaveBeenCalled()
        })

        it('refuses upsert_schedule writing the body of a scheduled task on an agent whose template content is locked', async () => {
            await expect(dispatchAccountTool(workspaceActor(WORKSPACE_ID), 'upsert_schedule', { agentId: 'agent-sealed', slug: 'daily', body: 'Rewritten' })).rejects.toThrow(LOCKED_WRITE_ERROR)
            await expect(dispatchAccountTool(workspaceActor(WORKSPACE_ID), 'upsert_schedule', { agentId: 'agent-sealed', name: 'Daily', cron: '0 9 * * *', body: 'New' })).rejects.toThrow(LOCKED_WRITE_ERROR)

            expect(updateSchedule).not.toHaveBeenCalled()
            expect(createSchedule).not.toHaveBeenCalled()
        })

        it('lets upsert_schedule pause a scheduled task of a locked agent', async () => {
            await dispatchAccountTool(workspaceActor(WORKSPACE_ID), 'upsert_schedule', { agentId: 'agent-sealed', slug: 'daily', enabled: false })

            expect(updateSchedule).toHaveBeenCalledWith(expect.anything(), 'engine-sealed', 'daily', expect.objectContaining({ enabled: false, body: undefined }))
        })

        it('refuses upsert_trigger writing the body of a trigger on an agent whose template content is locked', async () => {
            await expect(dispatchAccountTool(workspaceActor(WORKSPACE_ID), 'upsert_trigger', { agentId: 'agent-sealed', slug: 'inbound', body: 'Rewritten' })).rejects.toThrow(LOCKED_WRITE_ERROR)
            await expect(dispatchAccountTool(workspaceActor(WORKSPACE_ID), 'upsert_trigger', { agentId: 'agent-sealed', name: 'Inbound', body: 'New' })).rejects.toThrow(LOCKED_WRITE_ERROR)

            expect(updateTrigger).not.toHaveBeenCalled()
            expect(createTrigger).not.toHaveBeenCalled()
        })

        it('lets upsert_trigger disable a trigger of a locked agent', async () => {
            vi.mocked(updateTrigger).mockResolvedValue({ slug: 'inbound', name: 'Inbound', enabled: false, token: null } as never)

            await expect(dispatchAccountTool(workspaceActor(WORKSPACE_ID), 'upsert_trigger', { agentId: 'agent-sealed', slug: 'inbound', enabled: false })).resolves.toMatchObject({ slug: 'inbound', enabled: false })

            expect(updateTrigger).toHaveBeenCalledWith(expect.anything(), 'engine-sealed', 'inbound', expect.objectContaining({ enabled: false, body: undefined }))
        })
    })
    describe('write_memory and upload_workspace_file', () => {
        const CONN = { baseUrl: 'https://engine.test', apiKey: 'key' }
        const actor = workspaceActor(WORKSPACE_ID)

        beforeEach(() => {
            vi.mocked(resolveAgentTarget).mockResolvedValue({ conn: CONN, engineAgentId: 'engine-own', contentLocked: false } as never)
            vi.mocked(agentFilesBase).mockImplementation(id => `/agents/${id}/files`)
        })

        it('writes each memory in order, keeps the ones that worked and reports the ones that failed', async () => {
            vi.mocked(createMemory).mockResolvedValueOnce({ id: 'm1' }).mockRejectedValueOnce(new Error('hub down')).mockResolvedValueOnce({ id: 'm3' })

            const out = await dispatchAccountTool(actor, 'write_memory', {
                agentId: 'agent-own',
                memories: [{ content: 'Prefers tea', kind: 'preference', tags: ['food', 3] }, { content: 'Lives in Lyon' }, { content: 'Runs a bakery', kind: 'fact' }],
            })

            expect(resolveAgentTarget).toHaveBeenCalledWith('agent-own', actor, 'manage')
            expect(vi.mocked(createMemory).mock.calls.map(call => call[2])).toEqual([{ content: 'Prefers tea', kind: 'preference', tags: ['food'] }, { content: 'Lives in Lyon' }, { content: 'Runs a bakery', kind: 'fact' }])
            expect(out).toEqual({ written: 2, ids: ['m1', 'm3'], failed: [{ index: 1, error: 'hub down' }] })
        })

        it('refuses an empty batch, an oversized batch and an oversized memory before writing anything', async () => {
            await expect(dispatchAccountTool(actor, 'write_memory', { agentId: 'agent-own', memories: [] })).rejects.toThrow('non-empty array')
            await expect(dispatchAccountTool(actor, 'write_memory', { agentId: 'agent-own', memories: Array.from({ length: 101 }, () => ({ content: 'x' })) })).rejects.toThrow('At most 100 memories')
            await expect(dispatchAccountTool(actor, 'write_memory', { agentId: 'agent-own', memories: [{ content: 'ok' }, { content: 'x'.repeat(20_001) }] })).rejects.toThrow('memories[1] is over 20000 characters')
            expect(createMemory).not.toHaveBeenCalled()
        })

        it('writes a text file into the coworker workspace', async () => {
            const out = await dispatchAccountTool(actor, 'upload_workspace_file', { agentId: 'agent-own', path: '/notes/clients.md', content: '# Clients' })

            expect(writeFileText).toHaveBeenCalledWith(CONN, '/agents/engine-own/files', 'notes/clients.md', '# Clients')
            expect(out).toEqual({ path: 'notes/clients.md', bytes: 9 })
        })

        it('decodes a base64 file and uploads it under its folder', async () => {
            const out = await dispatchAccountTool(actor, 'upload_workspace_file', { agentId: 'agent-own', path: 'assets/logo.png', content: Buffer.from('png-bytes').toString('base64'), encoding: 'base64' })

            const [conn, base, file, dir] = vi.mocked(uploadFile).mock.calls[0]
            expect([conn, base, dir]).toEqual([CONN, '/agents/engine-own/files', 'assets'])
            expect(file.name).toBe('logo.png')
            expect(Buffer.from(await file.arrayBuffer()).toString()).toBe('png-bytes')
            expect(out).toEqual({ path: 'assets/logo.png', bytes: 9 })
        })

        it('sends a text longer than the JSON write allows through the raw upload', async () => {
            const content = 'x'.repeat(MAX_TEXT_WRITE_CHARS + 1)
            const out = await dispatchAccountTool(actor, 'upload_workspace_file', { agentId: 'agent-own', path: 'notes/long.md', content })

            expect(writeFileText).not.toHaveBeenCalled()
            const [conn, base, file, dir] = vi.mocked(uploadFile).mock.calls[0]
            expect([conn, base, dir, file.name]).toEqual([CONN, '/agents/engine-own/files', 'notes', 'long.md'])
            expect(Buffer.from(await file.arrayBuffer()).toString()).toBe(content)
            expect(out).toEqual({ path: 'notes/long.md', bytes: MAX_TEXT_WRITE_CHARS + 1 })
        })

        it('refuses a file over 5 MB, decoded or as text, before writing anything', async () => {
            const base64 = Buffer.alloc(5 * 1024 * 1024 + 1).toString('base64')
            await expect(dispatchAccountTool(actor, 'upload_workspace_file', { agentId: 'agent-own', path: 'big.bin', content: base64, encoding: 'base64' })).rejects.toThrow('over 5 MB once decoded')

            const text = 'x'.repeat(5 * 1024 * 1024 + 1)
            await expect(dispatchAccountTool(actor, 'upload_workspace_file', { agentId: 'agent-own', path: 'big.md', content: text })).rejects.toThrow('over 5 MB')

            expect(uploadFile).not.toHaveBeenCalled()
            expect(writeFileText).not.toHaveBeenCalled()
        })

        it('refuses both writes on a coworker whose content a template locks', async () => {
            vi.mocked(resolveAgentTarget).mockResolvedValue({ conn: CONN, engineAgentId: 'engine-sealed', contentLocked: true } as never)

            await expect(dispatchAccountTool(actor, 'write_memory', { agentId: 'agent-sealed', memories: [{ content: 'x' }] })).rejects.toThrow(LOCKED_WRITE_ERROR)
            await expect(dispatchAccountTool(actor, 'upload_workspace_file', { agentId: 'agent-sealed', path: 'a.md', content: 'x' })).rejects.toThrow(LOCKED_WRITE_ERROR)
            expect(createMemory).not.toHaveBeenCalled()
            expect(writeFileText).not.toHaveBeenCalled()
        })
    })
})
