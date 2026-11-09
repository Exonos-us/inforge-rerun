import { assertAgentAccess, visibleSpaceIds, type Actor } from '@/app/api/_auth/access'
import { type WorkspaceContext } from '@/app/api/_auth/ownership'
import { createSessionRow, getSessionEngineContext, lastRunError, listSessionRuns, readUsageSeed, resolveAgentTarget } from '@/app/api/_services/chat.service'
import { transformEngineMessages } from '@/lib/chat/engine-history'
import { cancelRun, getSession, getSessionMessages, listRuns, listSessions, listSkillProposals } from '@/lib/engine/client'
import { createClient } from '@/supabase/server'
import { createServiceRoleClient } from '@/supabase/serviceRole'
import { selectMany, selectMaybeSingle } from '@/supabase/supabase-helpers'
import { fakeSupabase } from '@/test/supabase-fake'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { adoptEngineSession, cancelSessionRuns, EMPTY_SESSION_SNAPSHOT, listAgentConversations, listAgentThreads, listWorkspaceConversationOverview, markSessionsHandled, readSessionSnapshot, searchWorkspaceConversations, THREAD_FEED_LIMIT } from './conversation.service'

vi.mock('@/supabase/supabase-helpers', () => ({ selectMany: vi.fn(), selectMaybeSingle: vi.fn() }))
vi.mock('@/supabase/serviceRole', () => ({ createServiceRoleClient: vi.fn() }))
vi.mock('@/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/app/api/_auth/access', async importOriginal => {
    const actual = await importOriginal<typeof import('@/app/api/_auth/access')>()
    return { ...actual, assertAgentAccess: vi.fn(), assertSessionInWorkspace: vi.fn(), visibleSpaceIds: vi.fn(actual.visibleSpaceIds) }
})
vi.mock('@/app/api/_services/chat.service', () => ({ createSessionRow: vi.fn(), resolveAgentTarget: vi.fn(), getSessionEngineContext: vi.fn(), updateSessionStatus: vi.fn(), lastRunError: vi.fn(), listSessionRuns: vi.fn(), readUsageSeed: vi.fn() }))
vi.mock('@/lib/engine/client', () => ({ cancelRun: vi.fn(), getSession: vi.fn(), getSessionMessages: vi.fn(), listRuns: vi.fn(), listSessions: vi.fn(), listSkillProposals: vi.fn() }))
vi.mock('@/lib/chat/engine-history', () => ({ transformEngineMessages: vi.fn() }))

const ctx = { userId: 'admin', role: 'admin', boxScope: 'all', supabase: {}, workspace: { id: 7 } } as unknown as WorkspaceContext
const memberCtx = { ...ctx, userId: 'member', role: 'member' } as WorkspaceContext
const adminActor: Actor = { kind: 'user', userId: 'admin', workspaceId: 7, role: 'admin', boxScope: 'all' }
const reached = (agent = { workspace_id: 7, space_id: 'space-1', engine_agent_id: 'engine-agent' }) => ({ actor: adminActor, access: 'manage' as const, agent })

function session(agentId: string, id: string, updatedAt: string, status = 'idle') {
    return { id, agent_id: agentId, title: `${id} title`, status, updated_at: updatedAt, created_at: updatedAt, engine_session_id: `engine-${id}`, source: 'dashboard', kind: 'thread' }
}

// selectMany is called three times in order: agents, the latest scan, then the pending count.
function answers(agents: { id: string }[], recent: ReturnType<typeof session>[], pending: { agent_id: string }[]) {
    vi.mocked(selectMany)
        .mockResolvedValueOnce({ data: agents, error: null } as never)
        .mockResolvedValueOnce({ data: recent, error: null } as never)
        .mockResolvedValueOnce({ data: pending, error: null } as never)
}

describe('listWorkspaceConversationOverview', () => {
    beforeEach(() => vi.clearAllMocks())

    it('keeps the most recently updated conversation of each agent', async () => {
        answers(
            [{ id: 'a' }, { id: 'b' }],
            [session('a', 's3', '2026-09-18T10:00:00Z'), session('b', 's2', '2026-09-17T10:00:00Z'), session('a', 's1', '2026-09-16T10:00:00Z')],
            []
        )

        const overview = await listWorkspaceConversationOverview(ctx)

        expect(overview.map(row => [row.agentId, row.latest?.id])).toEqual([
            ['a', 's3'],
            ['b', 's2'],
        ])
    })

    it('reports an agent nobody has talked to with a null latest', async () => {
        answers([{ id: 'a' }, { id: 'quiet' }], [session('a', 's1', '2026-09-18T10:00:00Z')], [])

        const overview = await listWorkspaceConversationOverview(ctx)

        expect(overview.find(row => row.agentId === 'quiet')).toEqual({ agentId: 'quiet', latest: null, pending: 0 })
    })

    it('counts the pending conversations per agent', async () => {
        answers([{ id: 'a' }, { id: 'b' }], [session('a', 's1', '2026-09-18T10:00:00Z', 'awaiting_question')], [{ agent_id: 'a' }, { agent_id: 'a' }, { agent_id: 'b' }])

        const overview = await listWorkspaceConversationOverview(ctx)

        expect(overview.map(row => row.pending)).toEqual([2, 1])
    })

    it('asks only for the agents of this workspace, and never touches a Box', async () => {
        answers([{ id: 'a' }], [session('a', 's1', '2026-09-18T10:00:00Z')], [])

        await listWorkspaceConversationOverview(ctx)

        expect(vi.mocked(selectMany).mock.calls[0][3]).toEqual({ workspace_id: 7 })
        expect(vi.mocked(selectMany).mock.calls[1][3]).toEqual({ agent_id: ['a'] })
    })

    it('leaves out the coworkers of a Box the member does not reach, without asking for their conversations', async () => {
        vi.mocked(visibleSpaceIds).mockResolvedValueOnce(new Set(['open']))
        answers([{ id: 'a', space_id: 'open' }, { id: 'hidden', space_id: 'closed' }] as never, [session('a', 's1', '2026-09-18T10:00:00Z')], [])

        const overview = await listWorkspaceConversationOverview(memberCtx)

        expect(overview.map(row => row.agentId)).toEqual(['a'])
        expect(vi.mocked(selectMany).mock.calls[1][3]).toEqual({ agent_id: ['a'] })
        expect(vi.mocked(selectMany).mock.calls[2][3]).toMatchObject({ agent_id: ['a'] })
    })

    it('does not query anything else when the workspace has no agent', async () => {
        vi.mocked(selectMany).mockResolvedValueOnce({ data: [], error: null } as never)

        expect(await listWorkspaceConversationOverview(ctx)).toEqual([])
        expect(selectMany).toHaveBeenCalledTimes(1)
    })
})

describe('markSessionsHandled', () => {
    beforeEach(() => vi.clearAllMocks())

    it('only clears conversations of the workspace agents, even when a foreign session id is passed', async () => {
        const db = fakeSupabase()
        vi.mocked(createServiceRoleClient).mockReturnValue(db.client)
        vi.mocked(selectMany).mockResolvedValueOnce({ data: [{ id: 'a' }, { id: 'b' }], error: null } as never)

        await markSessionsHandled(ctx, ['own-session', 'foreign-session'])

        expect(vi.mocked(selectMany).mock.calls[0][3]).toEqual({ workspace_id: 7 })
        const [write] = db.writes('sessions')
        expect(write.payload).toEqual({ status: 'idle' })
        expect(write.filters.map(call => call.args)).toEqual([
            ['agent_id', ['a', 'b']],
            ['status', expect.arrayContaining(['awaiting_question', 'awaiting_approval', 'awaiting_connector'])],
            ['id', ['own-session', 'foreign-session']],
        ])
    })

    it('clears every waiting conversation of the workspace on all, without an id filter', async () => {
        const db = fakeSupabase()
        vi.mocked(createServiceRoleClient).mockReturnValue(db.client)
        vi.mocked(selectMany).mockResolvedValueOnce({ data: [{ id: 'a' }], error: null } as never)

        await markSessionsHandled(ctx, 'all')

        expect(db.writes('sessions')[0].filters.map(call => call.args[0])).toEqual(['agent_id', 'status'])
    })

    it("never clears a conversation of a coworker outside the member's Boxes, even on all", async () => {
        const db = fakeSupabase()
        vi.mocked(createServiceRoleClient).mockReturnValue(db.client)
        vi.mocked(visibleSpaceIds).mockResolvedValueOnce(new Set(['open']))
        vi.mocked(selectMany).mockResolvedValueOnce({ data: [{ id: 'a', space_id: 'open' }, { id: 'hidden', space_id: 'closed' }], error: null } as never)

        await markSessionsHandled(memberCtx, 'all')

        expect(db.writes('sessions')[0].filters[0].args).toEqual(['agent_id', ['a']])
    })

    it('writes nothing when the workspace has no agent', async () => {
        const db = fakeSupabase()
        vi.mocked(createServiceRoleClient).mockReturnValue(db.client)
        vi.mocked(selectMany).mockResolvedValueOnce({ data: [], error: null } as never)

        await markSessionsHandled(ctx, ['foreign-session'])

        expect(db.writes('sessions')).toHaveLength(0)
    })
})

describe('cancelSessionRuns', () => {
    beforeEach(() => vi.clearAllMocks())

    const conn = { url: 'http://box', key: 'k' }

    it('cancels every running run of the conversation, and only those', async () => {
        vi.mocked(getSessionEngineContext).mockResolvedValue({ conn, engineAgentId: 'engine-agent', engineSessionId: 'es-1' } as never)
        vi.mocked(listRuns).mockResolvedValue([
            { id: 'r1', sessionId: 'es-1', status: 'running' },
            { id: 'r2', sessionId: 'es-1', status: 'completed' },
            { id: 'r3', sessionId: 'es-2', status: 'running' },
            { id: 'r4', sessionId: 'es-1', status: 'running' },
        ] as never)
        vi.mocked(cancelRun).mockResolvedValue(undefined as never)

        await cancelSessionRuns('session-1')

        expect(vi.mocked(cancelRun).mock.calls.map(call => call[2])).toEqual(['r1', 'r4'])
    })

    it('keeps going when one cancellation fails', async () => {
        vi.mocked(getSessionEngineContext).mockResolvedValue({ conn, engineAgentId: 'engine-agent', engineSessionId: 'es-1' } as never)
        vi.mocked(listRuns).mockResolvedValue([
            { id: 'r1', sessionId: 'es-1', status: 'running' },
            { id: 'r2', sessionId: 'es-1', status: 'running' },
        ] as never)
        vi.mocked(cancelRun).mockRejectedValueOnce(new Error('box down')).mockResolvedValueOnce(undefined as never)

        await expect(cancelSessionRuns('session-1')).resolves.toBeUndefined()
        expect(cancelRun).toHaveBeenCalledTimes(2)
    })

    it('does not reach the Box for a conversation it cannot resolve', async () => {
        vi.mocked(getSessionEngineContext).mockResolvedValue(null as never)

        await cancelSessionRuns('session-1')

        expect(listRuns).not.toHaveBeenCalled()
    })
})

describe('adoptEngineSession', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        vi.mocked(createServiceRoleClient).mockReturnValue(fakeSupabase().client)
        vi.mocked(assertAgentAccess).mockResolvedValue(reached())
        vi.mocked(resolveAgentTarget).mockResolvedValue({ conn: {}, engineAgentId: 'engine-agent' } as never)
        vi.mocked(createSessionRow).mockResolvedValue('new-session' as never)
    })

    it('returns the existing mirror row without asking the Box', async () => {
        vi.mocked(selectMaybeSingle).mockResolvedValueOnce({ data: { id: 'mirrored' }, error: null } as never)

        await expect(adoptEngineSession('agent-1', 'es-1', 'Title')).resolves.toBe('mirrored')
        expect(listSessions).not.toHaveBeenCalled()
        expect(createSessionRow).not.toHaveBeenCalled()
    })

    it('mirrors no session the Box does not hold for this agent', async () => {
        vi.mocked(selectMaybeSingle).mockResolvedValueOnce({ data: null, error: null } as never)
        vi.mocked(getSession).mockResolvedValue(null as never)
        vi.mocked(listSessions).mockResolvedValue([] as never)

        await expect(adoptEngineSession('agent-1', 'someone-elses-session', 'Title')).rejects.toThrow('Conversation not found')
        expect(createSessionRow).not.toHaveBeenCalled()
    })

    it('refuses an agent from another workspace before any read', async () => {
        vi.mocked(assertAgentAccess).mockRejectedValueOnce(new Error('Agent not found'))

        await expect(adoptEngineSession('agent-1', 'es-1', 'Title')).rejects.toThrow('Agent not found')
        expect(selectMaybeSingle).not.toHaveBeenCalled()
    })

    it('resolves the origin agent within the workspace only', async () => {
        vi.mocked(selectMaybeSingle)
            .mockResolvedValueOnce({ data: null, error: null } as never)
            .mockResolvedValueOnce({ data: { id: 'origin-agent' }, error: null } as never)
        vi.mocked(getSession).mockResolvedValue({ id: 'es-1', originAgentId: 'engine-origin', source: 'agent' } as never)

        await expect(adoptEngineSession('agent-1', 'es-1', 'Title')).resolves.toBe('new-session')

        expect(assertAgentAccess).toHaveBeenCalledWith('agent-1', 'use', undefined)
        expect(resolveAgentTarget).toHaveBeenCalledWith('agent-1', adminActor)
        expect(listSessions).not.toHaveBeenCalled()

        expect(vi.mocked(selectMaybeSingle).mock.calls[1][1]).toBe('agents')
        expect(vi.mocked(selectMaybeSingle).mock.calls[1][3]).toEqual({ engine_agent_id: 'engine-origin', workspace_id: 7 })
        expect(createSessionRow).toHaveBeenCalledWith('agent-1', 'es-1', 'Title', 'origin-agent', 'agent')
    })

    it('adopts a session with no origin agent without looking one up', async () => {
        vi.mocked(selectMaybeSingle).mockResolvedValueOnce({ data: null, error: null } as never)
        vi.mocked(getSession).mockResolvedValue(null)
        vi.mocked(listSessions).mockResolvedValue([{ id: 'es-1', source: 'dashboard' }] as never)

        await adoptEngineSession('agent-1', 'es-1', 'Title')

        expect(selectMaybeSingle).toHaveBeenCalledTimes(1)
        expect(createSessionRow).toHaveBeenCalledWith('agent-1', 'es-1', 'Title', null, 'dashboard')
    })
})

describe('readSessionSnapshot', () => {
    const conn = { url: 'http://box', key: 'k' }
    const lastDone = { id: 'r1', sessionId: 'es-1', status: 'done' }

    beforeEach(() => {
        vi.clearAllMocks()
        vi.mocked(getSessionEngineContext).mockResolvedValue({ conn, engineAgentId: 'engine-agent', engineSessionId: 'es-1' } as never)
        vi.mocked(getSessionMessages).mockResolvedValue([{ id: 'm1' }] as never)
        vi.mocked(transformEngineMessages).mockReturnValue([{ id: 'h1' }] as never)
        vi.mocked(listSkillProposals).mockResolvedValue([{ id: 'p1' }] as never)
    })

    it('answers the whole conversation from one resolution of the session', async () => {
        vi.mocked(listSessionRuns).mockResolvedValue({ latest: lastDone, lastDone, running: { id: 'r2' } } as never)
        vi.mocked(readUsageSeed).mockResolvedValue({ usage: { inputTokens: 3 }, provider: 'claude' } as never)
        vi.mocked(lastRunError).mockReturnValue(null)

        await expect(readSessionSnapshot('session-1')).resolves.toEqual({ messages: [{ id: 'h1' }], usage: { usage: { inputTokens: 3 }, provider: 'claude' }, lastError: null, activeRunId: 'r2', proposals: [{ id: 'p1' }] })
        expect(getSessionEngineContext).toHaveBeenCalledTimes(1)
        expect(readUsageSeed).toHaveBeenCalledWith(conn, 'engine-agent', lastDone)
    })

    it('keeps the transcript when the runs cannot be read', async () => {
        vi.mocked(listSessionRuns).mockRejectedValue(new Error('box down'))
        vi.mocked(lastRunError).mockReturnValue(null)

        const snapshot = await readSessionSnapshot('session-1')

        expect(snapshot.messages).toEqual([{ id: 'h1' }])
        expect(snapshot.usage).toBeNull()
        expect(snapshot.activeRunId).toBeNull()
        expect(readUsageSeed).not.toHaveBeenCalled()
    })

    it('answers an empty conversation for a session not on the engine yet', async () => {
        vi.mocked(getSessionEngineContext).mockResolvedValue({ conn, engineAgentId: 'engine-agent', engineSessionId: null } as never)

        await expect(readSessionSnapshot('session-1')).resolves.toBe(EMPTY_SESSION_SNAPSHOT)
        expect(getSessionMessages).not.toHaveBeenCalled()
    })
})

describe('searchWorkspaceConversations', () => {
    beforeEach(() => vi.clearAllMocks())

    function found(agents: { id: string }[], rows: ReturnType<typeof session>[]) {
        vi.mocked(selectMany)
            .mockResolvedValueOnce({ data: agents, error: null } as never)
            .mockResolvedValueOnce({ data: rows, error: null } as never)
    }

    it('reads nothing for an empty query across the workspace', async () => {
        expect(await searchWorkspaceConversations(ctx, '  ')).toEqual([])
        expect(selectMany).not.toHaveBeenCalled()
    })

    it("matches titles literally, newest first, within the workspace's agents", async () => {
        found([{ id: 'a' }, { id: 'b' }], [session('a', 's1', '2026-09-18T10:00:00Z')])

        const hits = await searchWorkspaceConversations(ctx, '100%_off')

        expect(vi.mocked(selectMany).mock.calls[1].slice(3)).toEqual([{ agent_id: ['a', 'b'], title: { ilike: '%100  off%' } }, { column: 'updated_at', ascending: false }, 20])
        expect(hits).toEqual([{ id: 's1', agentId: 'a', title: 's1 title', status: 'idle', updatedAt: '2026-09-18T10:00:00Z' }])
    })

    it("lists an agent's latest conversations when nothing is typed", async () => {
        found([{ id: 'a' }, { id: 'b' }], [])

        await searchWorkspaceConversations(ctx, '', 'b')

        expect(vi.mocked(selectMany).mock.calls[1].slice(3)).toEqual([{ agent_id: ['b'] }, { column: 'updated_at', ascending: false }, 8])
    })

    it("finds nothing on a coworker of a Box the member does not reach, without reading its conversations", async () => {
        vi.mocked(visibleSpaceIds).mockResolvedValueOnce(new Set(['open']))
        vi.mocked(selectMany).mockResolvedValueOnce({ data: [{ id: 'a', space_id: 'open' }, { id: 'hidden', space_id: 'closed' }], error: null } as never)

        expect(await searchWorkspaceConversations(memberCtx, 'report', 'hidden')).toEqual([])
        expect(selectMany).toHaveBeenCalledTimes(1)
    })

    it('finds nothing on an agent of another workspace, without reading its conversations', async () => {
        vi.mocked(selectMany).mockResolvedValueOnce({ data: [{ id: 'a' }], error: null } as never)

        expect(await searchWorkspaceConversations(ctx, 'report', 'elsewhere')).toEqual([])
        expect(selectMany).toHaveBeenCalledTimes(1)
    })
})

describe('listAgentConversations', () => {
    const asMember = { ...ctx, userId: 'me' } as WorkspaceContext

    beforeEach(() => {
        vi.clearAllMocks()
        vi.mocked(assertAgentAccess).mockResolvedValue(reached())
        vi.mocked(resolveAgentTarget).mockRejectedValue(new Error('no box'))
        vi.mocked(createServiceRoleClient).mockReturnValue({} as never)
    })

    function rows(...sessions: ReturnType<typeof session>[]) {
        vi.mocked(selectMany).mockResolvedValueOnce({ data: sessions, error: null } as never)
    }

    function unseenRuns(result: { data: { session_id: string; agent_id: string }[] | null; error: unknown }) {
        vi.mocked(createClient).mockResolvedValue({ rpc: vi.fn().mockResolvedValue(result) } as never)
    }

    it('marks a conversation whose run finished since the last read, for this agent only', async () => {
        rows(session('a', 's1', '2026-10-26T10:00:00Z'), session('a', 's2', '2026-10-25T10:00:00Z'))
        unseenRuns({ data: [{ session_id: 's1', agent_id: 'a' }, { session_id: 's2', agent_id: 'b' }], error: null })

        const conversations = await listAgentConversations(asMember, 'a')

        expect(conversations.map(c => [c.id, c.unseen])).toEqual([
            ['s1', true],
            ['s2', false],
        ])
    })

    it('says what a waiting conversation asks, from the notification that flipped it', async () => {
        rows(session('a', 's1', '2026-10-26T10:00:00Z', 'awaiting_approval'), session('a', 's2', '2026-10-25T10:00:00Z'))
        unseenRuns({ data: [], error: null })
        vi.mocked(selectMany).mockResolvedValueOnce({ data: [{ agent_id: 'a', engine_session_id: 'engine-s1', kind: 'approval', message: ' Send the email to Malt? ', metadata: null, recipients: { me: 'mine' } }], error: null } as never)

        const conversations = await listAgentConversations(asMember, 'a')

        expect(conversations.map(c => [c.id, c.ask])).toEqual([
            ['s1', 'Send the email to Malt?'],
            ['s2', null],
        ])
        expect(vi.mocked(selectMany).mock.calls[1][3]).toEqual({ agent_id: { in: ['a'] }, engine_session_id: { in: ['engine-s1'] }, kind: { neq: 'done' } })
    })

    it('leaves unseen out rather than failing when the read state cannot be fetched', async () => {
        rows(session('a', 's1', '2026-10-26T10:00:00Z'))
        unseenRuns({ data: null, error: new Error('rpc down') })

        const [conversation] = await listAgentConversations(asMember, 'a')

        expect(conversation).not.toHaveProperty('unseen')
        expect(selectMany).toHaveBeenCalledTimes(1)
    })
})

describe('listAgentThreads', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        vi.mocked(assertAgentAccess).mockResolvedValue(reached())
        vi.mocked(createServiceRoleClient).mockReturnValue({} as never)
    })

    it('reads the newest threads of the coworker from Supabase alone, General left out', async () => {
        vi.mocked(selectMany).mockResolvedValueOnce({ data: [{ ...session('a', 's2', '2026-11-08T10:00:00Z'), automation_name: 'Daily check', outcome: 'done', origin_agent_id: null, first_message: 'Check the funnel' }], error: null } as never)

        const threads = await listAgentThreads('a', adminActor)

        expect(assertAgentAccess).toHaveBeenCalledWith('a', 'use', adminActor)
        expect(vi.mocked(selectMany).mock.calls[0].slice(3)).toEqual([{ agent_id: 'a', kind: 'thread' }, { column: 'created_at', ascending: false }, THREAD_FEED_LIMIT])
        expect(vi.mocked(resolveAgentTarget)).not.toHaveBeenCalled()
        expect(threads).toEqual([{ id: 's2', title: 's2 title', status: 'idle', source: 'dashboard', createdAt: '2026-11-08T10:00:00Z', updatedAt: '2026-11-08T10:00:00Z', originAgentId: null, automationName: 'Daily check', outcome: 'done', firstMessage: 'Check the funnel' }])
    })

    it('exposes the kind and the opening time of every conversation in the history', async () => {
        vi.mocked(resolveAgentTarget).mockRejectedValue(new Error('no box'))
        vi.mocked(selectMany).mockResolvedValueOnce({ data: [{ ...session('a', 'g', '2026-11-08T10:00:00Z'), kind: 'general' }], error: null } as never)
        vi.mocked(createClient).mockResolvedValue({ rpc: vi.fn().mockResolvedValue({ data: [], error: null }) } as never)

        const conversations = await listAgentConversations({ ...ctx, userId: 'me' } as WorkspaceContext, 'a')

        expect(conversations.map(c => [c.id, c.kind, c.createdAt])).toEqual([['g', 'general', '2026-11-08T10:00:00Z']])
    })
})
