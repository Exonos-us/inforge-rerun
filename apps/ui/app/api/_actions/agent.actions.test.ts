import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Actor } from '@/app/api/_auth/access'
import { fakeSupabase } from '@/test/supabase-fake'

const mocks = vi.hoisted(() => ({
    getAgentChatTarget: vi.fn(),
    resolveRunTarget: vi.fn(),
    assertAgentInWorkspace: vi.fn(),
    assertSessionInWorkspace: vi.fn(),
    requireLightSessionActor: vi.fn(),
    visibleAgentIds: vi.fn(),
    moveAgentToBox: vi.fn(),
    duplicateAgent: vi.fn(),
    renameAgent: vi.fn(),
    deleteAgent: vi.fn(),
    getWorkspaceConnection: vi.fn(),
}))

class AccessDeniedError extends Error {}

vi.mock('@/app/api/_auth/access', () => ({
    AccessDeniedError,
    assertAgentInWorkspace: mocks.assertAgentInWorkspace,
    assertSessionInWorkspace: mocks.assertSessionInWorkspace,
    requireLightSessionActor: mocks.requireLightSessionActor,
    visibleAgentIds: mocks.visibleAgentIds,
    keepVisible: <T,>(rows: T[], visible: 'all' | Set<string>, idOf: (row: T) => string) => (visible === 'all' ? rows : rows.filter(row => visible.has(idOf(row)))),
}))
vi.mock('@/app/api/_auth/ownership', () => ({ requireWorkspaceId: vi.fn() }))
vi.mock('@/app/api/_services/chat.service', () => ({ getAgentChatTarget: mocks.getAgentChatTarget, resolveRunTarget: mocks.resolveRunTarget, sessionRowOf: vi.fn() }))
vi.mock('@/app/api/_services/agent.service', () => ({ moveAgentToBox: mocks.moveAgentToBox, duplicateAgent: mocks.duplicateAgent, renameAgent: mocks.renameAgent, deleteAgent: mocks.deleteAgent }))
vi.mock('@/app/api/_services/agent-activation.service', () => ({ activateAgent: vi.fn() }))
vi.mock('@/app/api/_services/engine-plan.service', () => ({ assertModelEntitled: vi.fn() }))
vi.mock('@/app/api/_services/workspace-engine.service', () => ({ getWorkspaceConnection: mocks.getWorkspaceConnection }))
vi.mock('@/app/api/_services/notification-audience.service', () => ({ followCoworker: vi.fn() }))
vi.mock('@/supabase/session/getServerSession', () => ({ getServerSession: vi.fn() }))
vi.mock('@/supabase/serviceRole', () => ({ createServiceRoleClient: vi.fn() }))
vi.mock('@/lib/ai/parse-schedule', () => ({ parseSchedule: vi.fn() }))
vi.mock('@/lib/services/registry', () => ({ connectorMcpServerNames: () => new Set(), connectorSkillOwners: vi.fn(), connectorSkillSlugs: vi.fn(), readRegistry: vi.fn() }))
vi.mock('@/lib/chat/engine-history', () => ({ transformEngineMessages: (messages: unknown[]) => messages }))
vi.mock('@/lib/engine/client', () => ({
    createSkill: vi.fn(async () => ({ slug: 'skill' })),
    deleteSchedule: vi.fn(),
    listSkills: vi.fn(async () => []),
    runScheduleNow: vi.fn(async () => ({ runId: 'run-1', sessionId: 'es-1' })),
    patchAgent: vi.fn(),
    updateAgentKeys: vi.fn(),
    getSessionMessages: vi.fn(),
    listSchedules: vi.fn(async () => [{ slug: 'daily', name: 'Daily', cron: '0 9 * * *', runAt: null, timezone: 'UTC', enabled: true, lastRunAt: null }]),
    listRuns: vi.fn(async () => []),
    getAgent: vi.fn(async () => null),
    supportsScheduleRename: vi.fn(async () => true),
}))

const { createServiceRoleClient } = await import('@/supabase/serviceRole')
const engine = await import('@/lib/engine/client')
const actions = await import('./agent.actions')

const conn = { baseUrl: 'https://engine.test', apiKey: 'key' }
const MEMBER: Actor = { kind: 'user', userId: 'user-2', workspaceId: 7, role: 'member', boxScope: 'all' }
const AGENT = 'agent-1'

beforeEach(() => {
    vi.clearAllMocks()
    mocks.getAgentChatTarget.mockResolvedValue({ conn, engineAgentId: 'engine-1', contentLocked: false })
    mocks.resolveRunTarget.mockResolvedValue({ conn, engineAgentId: 'engine-1', contentLocked: false })
    mocks.requireLightSessionActor.mockResolvedValue(MEMBER)
})

describe('the level each action asks of the Box', () => {
    it('takes manage to change what the coworker is', async () => {
        await actions.createSkillAction(AGENT, { name: 'Brief', description: 'd', body: 'b' })
        await actions.deleteScheduleAction(AGENT, 'daily')
        await actions.updateAgentKeysAction(AGENT, { set: { API_KEY: 'x' } })
        await actions.updateAgentConfigAction(AGENT, { verbosity: 'brief' } as never)
        await actions.renameAgentAction(AGENT, 'Scout')
        await actions.deleteAgentAction(AGENT)

        expect(mocks.getAgentChatTarget.mock.calls).toEqual([
            [AGENT, 'manage'],
            [AGENT, 'manage'],
            [AGENT, 'manage'],
        ])
        expect(mocks.resolveRunTarget).toHaveBeenCalledWith(AGENT, 'manage')
        expect(mocks.assertAgentInWorkspace.mock.calls).toEqual([
            [AGENT, 'manage'],
            [AGENT, 'manage'],
        ])
    })

    it('takes manage to read its keys, to delete table rows and to switch its automations on', async () => {
        await actions.getAgentKeysAction(AGENT)
        await actions.deleteAgentTableRowsAction(AGENT, 'leads', [1])
        await actions.activateAgentAutomationsAction(AGENT)

        expect(mocks.getAgentChatTarget.mock.calls).toEqual([
            [AGENT, 'manage'],
            [AGENT, 'manage'],
            [AGENT, 'manage'],
        ])
    })

    it('takes use to read it and to run a routine now', async () => {
        await actions.listSkillsAction(AGENT)
        await actions.testScheduleAction(AGENT, 'daily')

        expect(mocks.getAgentChatTarget.mock.calls).toEqual([[AGENT], [AGENT]])
    })

    it('reports a member who only uses the Box, without reaching the engine', async () => {
        mocks.getAgentChatTarget.mockRejectedValue(new AccessDeniedError('Only an admin or a manager of this Box can do this'))

        await expect(actions.createSkillAction(AGENT, { name: 'Brief', description: 'd', body: 'b' })).resolves.toEqual({ success: false, error: 'Only an admin or a manager of this Box can do this' })
        expect(engine.createSkill).not.toHaveBeenCalled()
    })

    it('hands the session actor to a move and a duplicate, which check both Boxes', async () => {
        const agentId = '11111111-1111-4111-8111-111111111111'
        const spaceId = '22222222-2222-4222-8222-222222222222'
        mocks.moveAgentToBox.mockResolvedValue({ ok: true, position: { col: 0, row: 0 } })
        mocks.duplicateAgent.mockResolvedValue({ agent: { id: 'copy', name: 'Copy', disabled_at: null }, schedules: [], triggers: [] })

        await actions.moveAgentAction({ agentId, spaceId })
        await actions.duplicateAgentAction({ agentId, spaceId })

        expect(mocks.moveAgentToBox).toHaveBeenCalledWith(agentId, spaceId, MEMBER)
        expect(mocks.duplicateAgent).toHaveBeenCalledWith(expect.objectContaining({ actor: MEMBER, agentRowId: agentId, workspaceId: 7, spaceId }))
    })
})

describe('listWorkspaceRoutinesAction', () => {
    it('leaves out the routines of a coworker the member cannot see', async () => {
        const agents = [
            { id: 'agent-seen', engine_agent_id: 'engine-seen', disabled_at: null },
            { id: 'agent-hidden', engine_agent_id: 'engine-hidden', disabled_at: null },
        ]
        vi.mocked(createServiceRoleClient).mockReturnValue(fakeSupabase(table => (table === 'agents' ? { data: agents } : undefined)).client)
        mocks.visibleAgentIds.mockResolvedValue(new Set(['agent-seen']))
        mocks.getWorkspaceConnection.mockResolvedValue(conn)

        const { routines } = await actions.listWorkspaceRoutinesAction()

        expect(mocks.visibleAgentIds).toHaveBeenCalledWith(MEMBER)
        expect(routines.map(routine => routine.agentId)).toEqual(['agent-seen'])
        expect(engine.listSchedules).toHaveBeenCalledTimes(1)
        expect(engine.listSchedules).toHaveBeenCalledWith(conn, 'engine-seen')
    })
})

describe('answerSecretRequestAction', () => {
    const pendingRequest = [{ id: 'm1', role: 'assistant', parts: [{ type: 'tool-request_secret', toolCallId: 'call-1', input: { secrets: [{ key: 'API_KEY', label: 'API key' }] } }] }]

    beforeEach(() => {
        mocks.assertSessionInWorkspace.mockResolvedValue({ id: 'session-1', agent_id: AGENT, engine_session_id: 'es-1', engine_agent_id: 'engine-1' })
        vi.mocked(engine.getSessionMessages).mockResolvedValue(pendingRequest as never)
    })

    it('stores the key the coworker asked for with use alone', async () => {
        await expect(actions.answerSecretRequestAction('session-1', { API_KEY: 'secret' })).resolves.toEqual({ success: true })
        expect(mocks.getAgentChatTarget).toHaveBeenCalledWith(AGENT)
        expect(engine.updateAgentKeys).toHaveBeenCalledWith(conn, 'engine-1', { set: { API_KEY: 'secret' } })
    })

    it('refuses a key the request does not name', async () => {
        await expect(actions.answerSecretRequestAction('session-1', { API_KEY: 'secret', OTHER_KEY: 'x' })).resolves.toEqual({ success: false, error: 'This coworker did not ask for these credentials' })
        expect(engine.updateAgentKeys).not.toHaveBeenCalled()
    })

    it('refuses when the conversation holds no pending request', async () => {
        vi.mocked(engine.getSessionMessages).mockResolvedValue([{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }] as never)

        await expect(actions.answerSecretRequestAction('session-1', { API_KEY: 'secret' })).resolves.toMatchObject({ success: false })
        expect(engine.updateAgentKeys).not.toHaveBeenCalled()
    })

    it('refuses a session the caller cannot use', async () => {
        mocks.assertSessionInWorkspace.mockRejectedValue(new Error('Session not found'))

        await expect(actions.answerSecretRequestAction('session-1', { API_KEY: 'secret' })).resolves.toEqual({ success: false, error: 'Session not found' })
        expect(engine.updateAgentKeys).not.toHaveBeenCalled()
    })

    it('pins a screen secret to the site the request named, never one the caller sends', async () => {
        const screenRequest = [{ id: 'm1', role: 'assistant', parts: [{ type: 'tool-request_secret', toolCallId: 'call-1', input: { secrets: [{ key: 'GH_PASSWORD', label: 'GitHub password', site: 'github.com' }, { key: 'API_KEY', label: 'API key' }] } }] }]
        vi.mocked(engine.getSessionMessages).mockResolvedValue(screenRequest as never)

        await expect(actions.answerSecretRequestAction('session-1', { GH_PASSWORD: 'v', API_KEY: 'k' }, ['GH_PASSWORD', 'API_KEY'])).resolves.toEqual({ success: true })
        expect(engine.updateAgentKeys).toHaveBeenCalledWith(conn, 'engine-1', {
            set: { GH_PASSWORD: 'v', API_KEY: 'k' },
            screen: { GH_PASSWORD: { site: 'github.com', allowAlways: true } },
        })
    })

    it('sends no screen metadata when the user skipped the site-labeled field', async () => {
        const screenRequest = [{ id: 'm1', role: 'assistant', parts: [{ type: 'tool-request_secret', toolCallId: 'call-1', input: { secrets: [{ key: 'GH_PASSWORD', label: 'GitHub password', site: 'github.com' }, { key: 'API_KEY', label: 'API key' }] } }] }]
        vi.mocked(engine.getSessionMessages).mockResolvedValue(screenRequest as never)

        await expect(actions.answerSecretRequestAction('session-1', { API_KEY: 'k' })).resolves.toEqual({ success: true })
        expect(engine.updateAgentKeys).toHaveBeenCalledWith(conn, 'engine-1', { set: { API_KEY: 'k' } })
    })
})
