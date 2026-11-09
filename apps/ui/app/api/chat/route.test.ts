import { callableEngineAgentIds } from '@/app/api/_auth/access'
import { createSessionRow, findGeneralSession, GeneralAlreadyOpenError, getAgentChatTarget, getExistingSession } from '@/app/api/_services/chat.service'
import { generateSessionTitle } from '@/lib/ai/generate-title'
import * as engine from '@/lib/engine/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { POST } from './route'

vi.mock('@/app/api/_auth/ownership', () => ({ requireWorkspaceContext: vi.fn().mockResolvedValue({ userId: 'me', authUser: { app_metadata: {}, user_metadata: {} } }) }))
vi.mock('@/app/api/_auth/access', () => ({ actorFromContext: vi.fn(() => ({ kind: 'user', userId: 'me', workspaceId: 7, role: 'member', boxScope: 'assigned' })), callableEngineAgentIds: vi.fn() }))
vi.mock('@/app/api/_services/notification-audience.service', () => ({ recordSessionParticipant: vi.fn(), recordSessionRead: vi.fn() }))
vi.mock('@/app/api/_services/chat.service', async importOriginal => ({
    ...(await importOriginal<typeof import('@/app/api/_services/chat.service')>()),
    getAgentChatTarget: vi.fn(),
    getExistingSession: vi.fn(),
    createSessionRow: vi.fn(),
    findGeneralSession: vi.fn(),
    updateSessionStatus: vi.fn(),
}))
vi.mock('@/lib/ai/generate-title', () => ({ generateSessionTitle: vi.fn().mockResolvedValue('Title') }))
vi.mock('@/supabase/serviceRole', () => ({ createServiceRoleClient: vi.fn() }))
vi.mock('@/lib/engine/client', () => ({ chat: vi.fn(), reconnectRun: vi.fn(), cancelRun: vi.fn().mockResolvedValue(undefined) }))

const busy = () => Response.json({ runId: 'run-1', startedAt: null }, { status: 409 })
const streaming = (runId: string, sessionId = 'engine-session') => new Response('data: {}\n\n', { headers: { 'Content-Type': 'text/event-stream', 'x-run-id': runId, 'x-session-id': sessionId } })

function request(body: Record<string, unknown>) {
    return new Request('https://rerun.test/api/chat', { method: 'POST', body: JSON.stringify({ agentId: 'agent', sessionId: 'session', text: 'ship it', ...body }) })
}

// The route sleeps between retries; without fake timers the queued cases would take 25 seconds.
async function settle(response: Promise<Response>): Promise<Response> {
    await vi.runAllTimersAsync()
    return response
}

describe('POST /api/chat', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        vi.useFakeTimers()
        vi.mocked(getAgentChatTarget).mockResolvedValue({ engineAgentId: 'engine-agent', conn: { baseUrl: 'https://engine.test', apiKey: null }, contentLocked: false })
        vi.mocked(getExistingSession).mockResolvedValue({ sessionId: 'session', agentId: 'agent', engineSessionId: 'engine-session' })
        vi.mocked(callableEngineAgentIds).mockResolvedValue(undefined)
    })

    afterEach(() => {
        vi.useRealTimers()
    })

    it('hands a queued message back rather than tailing the run holding the conversation', async () => {
        vi.mocked(engine.chat).mockImplementation(async () => busy())

        const response = await settle(POST(request({ queued: true })))

        expect(response.status).toBe(409)
        expect(await response.json()).toMatchObject({ error: 'run_in_flight', runId: 'run-1' })
        expect(engine.reconnectRun).not.toHaveBeenCalled()
        expect(vi.mocked(engine.chat).mock.calls.length).toBeGreaterThan(1)
    })

    it('sends a queued message as soon as the engine releases the session', async () => {
        vi.mocked(engine.chat).mockImplementationOnce(async () => busy()).mockImplementationOnce(async () => streaming('run-2'))

        const response = await settle(POST(request({ queued: true })))

        expect(response.status).toBe(200)
        expect(response.headers.get('X-Run-Id')).toBe('run-2')
        expect(engine.chat).toHaveBeenCalledTimes(2)
    })

    it('still tails the run in flight for a message that was not queued', async () => {
        vi.mocked(engine.chat).mockImplementation(async () => busy())
        vi.mocked(engine.reconnectRun).mockResolvedValue(streaming('run-1'))

        const response = await settle(POST(request({})))

        expect(response.status).toBe(200)
        expect(response.headers.get('X-Run-Id')).toBe('run-1')
        expect(engine.chat).toHaveBeenCalledTimes(1)
        expect(engine.reconnectRun).toHaveBeenCalledOnce()
    })

    it('hands the engine the coworkers the author reaches', async () => {
        vi.mocked(callableEngineAgentIds).mockResolvedValue(['engine-agent', 'engine-other'])
        vi.mocked(engine.chat).mockImplementation(async () => streaming('run-3'))

        const response = await settle(POST(request({})))

        expect(response.status).toBe(200)
        expect(vi.mocked(engine.chat).mock.calls[0][2]).toMatchObject({ callableAgentIds: ['engine-agent', 'engine-other'] })
    })

    it('refuses the send when what the author reaches cannot be read, rather than opening every coworker', async () => {
        vi.mocked(callableEngineAgentIds).mockRejectedValue(new Error('database down'))

        const response = await settle(POST(request({})))

        expect(response.status).toBe(502)
        expect(engine.chat).not.toHaveBeenCalled()
    })

    it('refuses a conversation of another coworker without reaching the engine', async () => {
        vi.mocked(getExistingSession).mockResolvedValue({ sessionId: 'session', agentId: 'other-agent', engineSessionId: 'other-engine-session' })

        const response = await settle(POST(request({})))

        expect(response.status).toBe(404)
        expect(await response.json()).toEqual({ error: 'session_not_found' })
        expect(engine.chat).not.toHaveBeenCalled()
    })

    it('answers the engine refusing a session it does not hold with the same code, not its raw text', async () => {
        vi.mocked(engine.chat).mockResolvedValue(Response.json({ error: 'session not found for this agent' }, { status: 404 }))

        const response = await settle(POST(request({})))

        expect(response.status).toBe(404)
        expect(await response.json()).toEqual({ error: 'session_not_found' })
    })

    describe('General', () => {
        beforeEach(() => {
            vi.mocked(engine.chat).mockImplementation(async () => streaming('run-4'))
            vi.mocked(createSessionRow).mockResolvedValue('general-row')
            vi.mocked(findGeneralSession).mockResolvedValue(null)
        })

        it('opens the coworker\'s General on the first message, under its fixed name', async () => {
            const response = await settle(POST(request({ sessionId: undefined, kind: 'general' })))

            expect(response.status).toBe(200)
            expect(response.headers.get('X-Session-Id')).toBe('general-row')
            expect(createSessionRow).toHaveBeenCalledWith('agent', 'engine-session', 'ship it', null, undefined, 'general', 'ship it')
            expect(generateSessionTitle).not.toHaveBeenCalled()
        })

        it('continues the General another tab already opened rather than creating a second one', async () => {
            vi.mocked(findGeneralSession).mockResolvedValue({ id: 'general-row', engineSessionId: 'engine-general' })
            vi.mocked(getExistingSession).mockResolvedValue({ sessionId: 'general-row', agentId: 'agent', engineSessionId: 'engine-general' })
            vi.mocked(engine.chat).mockImplementation(async () => streaming('run-4', 'engine-general'))

            const response = await settle(POST(request({ sessionId: undefined, kind: 'general' })))

            expect(response.status).toBe(200)
            expect(response.headers.get('X-Session-Id')).toBe('general-row')
            expect(vi.mocked(engine.chat).mock.calls[0][2]).toMatchObject({ sessionId: 'engine-general' })
            expect(createSessionRow).not.toHaveBeenCalled()
        })

        it('starts over on the General another tab opened between the lookup and the insert', async () => {
            vi.mocked(createSessionRow).mockRejectedValue(new GeneralAlreadyOpenError({ id: 'general-row', engineSessionId: 'engine-general' }))
            vi.mocked(engine.chat).mockImplementationOnce(async () => streaming('run-4', 'engine-orphan')).mockImplementationOnce(async () => streaming('run-5', 'engine-general'))

            const response = await settle(POST(request({ sessionId: undefined, kind: 'general' })))

            expect(response.status).toBe(200)
            expect(response.headers.get('X-Session-Id')).toBe('general-row')
            expect(response.headers.get('X-Run-Id')).toBe('run-5')
            expect(vi.mocked(engine.chat).mock.calls.map(call => call[2].sessionId)).toEqual([undefined, 'engine-general'])
            expect(engine.cancelRun).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'run-4')
            expect(createSessionRow).toHaveBeenCalledTimes(1)
        })

        it('hands the message back when the General that won is still answering the other tab', async () => {
            vi.mocked(createSessionRow).mockRejectedValue(new GeneralAlreadyOpenError({ id: 'general-row', engineSessionId: 'engine-general' }))
            vi.mocked(engine.chat).mockImplementationOnce(async () => streaming('run-4', 'engine-orphan')).mockImplementationOnce(async () => busy())

            const response = await settle(POST(request({ sessionId: undefined, kind: 'general' })))

            expect(response.status).toBe(409)
            expect(await response.json()).toMatchObject({ error: 'run_in_flight', runId: 'run-1' })
            expect(engine.reconnectRun).not.toHaveBeenCalled()
            expect(engine.cancelRun).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'run-4')
        })

        it('names a thread after its first message, as before, and keeps that message for General', async () => {
            const response = await settle(POST(request({ sessionId: undefined })))

            expect(response.status).toBe(200)
            expect(createSessionRow).toHaveBeenCalledWith('agent', 'engine-session', 'ship it', null, undefined, 'thread', 'ship it')
            expect(generateSessionTitle).toHaveBeenCalledWith('ship it')
        })
    })
})
