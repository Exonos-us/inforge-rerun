import { beforeEach, describe, expect, it, vi } from 'vitest'

import { dispatchAccountTool } from '@/app/api/_services/mcp-account.service'
import { deleteAgent } from '@/app/api/_services/agent.service'
import { hashApiKey } from '@/lib/mcp/api-keys'
import { IMPORT_TOOL_NAMES } from '@/lib/mcp/import-scope'
import { createServiceRoleClient } from '@/supabase/serviceRole'
import { fakeSupabase, writeMethodOf, type FakeSupabase, type SupabaseCall } from '@/test/supabase-fake'

import { POST as accountPOST } from '../route'
import { POST as keyPOST } from './route'

vi.mock('@/supabase/serviceRole', () => ({ createServiceRoleClient: vi.fn() }))
vi.mock('@/app/api/_services/mcp-account.service', () => ({ dispatchAccountTool: vi.fn() }))
vi.mock('@/app/api/_services/agent.service', () => ({ deleteAgent: vi.fn() }))

const WORKSPACE_ID = 7
const ACCOUNT_KEY = 'rk_account-key'
const IMPORT_KEY = 'rk_import-key'
const BOUND_KEY = 'rk_bound-key'
const EXPIRED_KEY = 'rk_expired-key'

const future = () => new Date(Date.now() + 3600_000).toISOString()

const API_KEYS: Record<string, () => Record<string, unknown>> = {
    [hashApiKey(ACCOUNT_KEY)]: () => ({ id: 'key-account', workspace_id: WORKSPACE_ID, revoked_at: null, created_by_user_id: null, expires_at: null, scope: 'account', bound_agent_id: null }),
    [hashApiKey(IMPORT_KEY)]: () => ({ id: 'key-import', workspace_id: WORKSPACE_ID, revoked_at: null, created_by_user_id: null, expires_at: future(), scope: 'agent_import', bound_agent_id: null }),
    [hashApiKey(BOUND_KEY)]: () => ({ id: 'key-bound', workspace_id: WORKSPACE_ID, revoked_at: null, created_by_user_id: null, expires_at: future(), scope: 'agent_import', bound_agent_id: 'agent-mine' }),
    [hashApiKey(EXPIRED_KEY)]: () => ({ id: 'key-expired', workspace_id: WORKSPACE_ID, revoked_at: null, created_by_user_id: null, expires_at: new Date(Date.now() - 1000).toISOString(), scope: 'agent_import', bound_agent_id: null }),
}

let bindWins = true

function resolveRow(table: string, calls: readonly SupabaseCall[]) {
    if (table === 'api_keys' && writeMethodOf(calls) === 'update' && calls.some(call => call.method === 'select')) return { data: bindWins ? [{ id: 'key-import' }] : [] }
    if (table === 'api_keys' && !writeMethodOf(calls)) {
        const hash = calls.find(call => call.method === 'eq' && call.args[0] === 'key_hash')?.args[1] as string
        return { data: API_KEYS[hash]?.() ?? null }
    }
    if (table === 'workspaces') return { data: { subscription_status: 'active', is_sandbox: false } }
    return undefined
}

function rpc(body: unknown, headers: Record<string, string> = {}) {
    return new Request('https://rerun.test/api/mcp/account/x', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })
}

const toolCall = (name: string, args: Record<string, unknown>) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
const viaPath = (key: string, body: unknown) => keyPOST(rpc(body), { params: Promise.resolve({ key }) })

async function toolResult(response: Response) {
    const { result } = (await response.json()) as { result: { isError?: boolean; content: { text: string }[] } }
    return { isError: result.isError ?? false, body: JSON.parse(result.content[0].text) as Record<string, unknown> }
}

describe('the import key on the account MCP', () => {
    let db: FakeSupabase

    beforeEach(() => {
        vi.clearAllMocks()
        vi.spyOn(console, 'error').mockImplementation(() => undefined)
        bindWins = true
        db = fakeSupabase(resolveRow)
        vi.mocked(createServiceRoleClient).mockReturnValue(db.client)
        vi.mocked(dispatchAccountTool).mockResolvedValue({ agentId: 'agent-new' })
    })

    it('lets an import key in through the path, and keeps an account key out of it', async () => {
        expect((await viaPath(IMPORT_KEY, { jsonrpc: '2.0', id: 1, method: 'initialize' })).status).toBe(200)
        expect((await viaPath(ACCOUNT_KEY, { jsonrpc: '2.0', id: 1, method: 'initialize' })).status).toBe(401)
    })

    it('refuses an expired import key', async () => {
        expect((await viaPath(EXPIRED_KEY, { jsonrpc: '2.0', id: 1, method: 'initialize' })).status).toBe(401)
    })

    it('lists only the import tools to an import key, and every tool to an account key', async () => {
        const imported = (await (await viaPath(IMPORT_KEY, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).json()) as { result: { tools: { name: string }[] } }
        expect(imported.result.tools.map(tool => tool.name).sort()).toEqual([...IMPORT_TOOL_NAMES].sort())

        const account = (await (await accountPOST(rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { authorization: `Bearer ${ACCOUNT_KEY}` }))).json()) as { result: { tools: { name: string }[] } }
        expect(account.result.tools.map(tool => tool.name)).toContain('delete_agent')
    })

    it('refuses a tool outside the import scope without running it', async () => {
        const { isError, body } = await toolResult(await viaPath(BOUND_KEY, toolCall('delete_agent', { agentId: 'agent-mine', confirm: true })))

        expect(isError).toBe(true)
        expect(body.error).toBe('"delete_agent" is not available to an import key.')
        expect(dispatchAccountTool).not.toHaveBeenCalled()
    })

    it('binds the key to the coworker its create_agent made', async () => {
        const { isError } = await toolResult(await viaPath(IMPORT_KEY, toolCall('create_agent', { name: 'Atlas' })))

        expect(isError).toBe(false)
        const bind = db.writes('api_keys').find(write => (write.payload as Record<string, unknown>).bound_agent_id)
        expect(bind?.payload).toEqual({ bound_agent_id: 'agent-new' })
        expect(deleteAgent).not.toHaveBeenCalled()
    })

    it('takes back the coworker of a create_agent that lost the race for the key', async () => {
        bindWins = false

        const { isError } = await toolResult(await viaPath(IMPORT_KEY, toolCall('create_agent', { name: 'Atlas' })))

        expect(isError).toBe(true)
        expect(deleteAgent).toHaveBeenCalledWith('agent-new')
    })

    it('refuses a second create_agent and any other coworker once the key is bound', async () => {
        const second = await toolResult(await viaPath(BOUND_KEY, toolCall('create_agent', { name: 'Twin' })))
        expect(second.isError).toBe(true)

        const foreign = await toolResult(await viaPath(BOUND_KEY, toolCall('upsert_skill', { agentId: 'agent-other', name: 'x', body: 'y' })))
        expect(foreign.isError).toBe(true)
        expect(foreign.body.error).toBe('An import key only writes to its own coworker (agentId agent-mine).')

        expect(dispatchAccountTool).not.toHaveBeenCalled()
    })

    it('passes a call on its own coworker through', async () => {
        await viaPath(BOUND_KEY, toolCall('write_memory', { agentId: 'agent-mine', memories: [{ content: 'Likes tea' }] }))

        expect(dispatchAccountTool).toHaveBeenCalledWith({ kind: 'workspace', workspaceId: WORKSPACE_ID }, 'write_memory', { agentId: 'agent-mine', memories: [{ content: 'Likes tea' }] }, { actorUserId: null })
    })

    it('refuses writes before the coworker exists', async () => {
        const { isError, body } = await toolResult(await viaPath(IMPORT_KEY, toolCall('upsert_skill', { agentId: 'agent-any', name: 'x', body: 'y' })))

        expect(isError).toBe(true)
        expect(body.error).toBe('Call create_agent first: an import key only writes to the coworker it creates.')
    })
})
