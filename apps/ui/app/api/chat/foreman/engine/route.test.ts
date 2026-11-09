import { callableEngineAgentIds } from '@/app/api/_auth/access'
import { requireWorkspaceContext } from '@/app/api/_auth/ownership'
import { getWorkspaceConnection } from '@/app/api/_services/workspace-engine.service'
import { startChat } from '@/lib/chat/start-chat'
import { cancelRun } from '@/lib/engine/client'
import { isPhoneStepPending } from '@rerun/cloud/phone.server'
import { cancelForemanSessionRuns, loadForemanConversation } from '@/lib/foreman/conversation'
import { loadForemanState } from '@/lib/foreman/state'
import { resolveForemanSurface } from '@/lib/foreman/surface.server'
import { PHONE_REQUIRED_MESSAGE } from '@rerun/cloud/phone'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DELETE, GET, POST } from './route'

vi.mock('@/app/api/_auth/ownership', () => ({ requireWorkspaceContext: vi.fn() }))
vi.mock('@/app/api/_auth/access', () => ({ actorFromContext: vi.fn(() => ({ kind: 'user', userId: 'user-1', workspaceId: 7, role: 'member', boxScope: 'assigned' })), callableEngineAgentIds: vi.fn() }))
vi.mock('@/lib/foreman/hub-token', () => ({ mintForemanHubToken: vi.fn(() => null) }))
vi.mock('@rerun/cloud/phone.server', () => ({ isPhoneStepPending: vi.fn() }))
vi.mock('@/app/api/_services/me.service', () => ({ messageAuthorOf: vi.fn() }))
vi.mock('@/app/api/_services/workspace-engine.service', () => ({ getWorkspaceConnection: vi.fn(), NoEngineError: class NoEngineError extends Error {} }))
vi.mock('@/lib/chat/start-chat', () => ({ QUEUED_RETRY_DELAYS_MS: [], startChat: vi.fn() }))
vi.mock('@/lib/engine/client', () => ({ cancelRun: vi.fn(), reconnectRun: vi.fn() }))
vi.mock('@/lib/foreman/conversation', () => ({
    cancelForemanSessionRuns: vi.fn(),
    engineSessionOf: vi.fn().mockResolvedValue(null),
    loadForemanConversation: vi.fn(),
    readForemanEngineMessages: vi.fn(),
    startEngineConversation: vi.fn(),
    touchForemanConversation: vi.fn(),
}))
vi.mock('@/lib/foreman/engine-brief', () => ({ foremanEngineBrief: vi.fn() }))
vi.mock('@/lib/foreman/state', () => ({ loadForemanState: vi.fn() }))
vi.mock('@/lib/foreman/surface.server', () => ({ resolveForemanSurface: vi.fn() }))

const URL = 'https://rerun.test/api/chat/foreman/engine'
const post = () => new Request(URL, { method: 'POST', body: JSON.stringify({ sessionId: 'session', text: 'ship it' }) })

describe('/api/chat/foreman/engine', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        vi.mocked(requireWorkspaceContext).mockResolvedValue({ userId: 'user-1', authUser: { is_anonymous: false }, workspace: { id: 7 }, supabase: {} } as never)
        vi.mocked(loadForemanState).mockResolvedValue({ phase: 'onboarding' } as never)
        vi.mocked(resolveForemanSurface).mockResolvedValue('hub' as never)
    })

    it('turns away a message from an account that still owes its phone number', async () => {
        vi.mocked(isPhoneStepPending).mockResolvedValue(true)

        const response = await POST(post())

        expect(response.status).toBe(403)
        expect(await response.json()).toEqual({ error: PHONE_REQUIRED_MESSAGE })
        expect(loadForemanState).not.toHaveBeenCalled()
    })

    it('lets a message from an account that owes nothing through', async () => {
        vi.mocked(isPhoneStepPending).mockResolvedValue(false)

        const response = await POST(post())

        expect(response.status).toBe(409)
        expect(loadForemanState).toHaveBeenCalledOnce()
    })

    it('still reopens the conversation of an account that owes its phone number', async () => {
        vi.mocked(isPhoneStepPending).mockResolvedValue(true)
        vi.mocked(loadForemanConversation).mockResolvedValue(null)

        const response = await GET(new Request(URL))

        expect(response.status).toBe(200)
        expect(isPhoneStepPending).not.toHaveBeenCalled()
    })

    it('hands the engine the coworkers the member reaches, so call_agent names no other', async () => {
        vi.mocked(isPhoneStepPending).mockResolvedValue(false)
        vi.mocked(resolveForemanSurface).mockResolvedValue('engine' as never)
        vi.mocked(getWorkspaceConnection).mockResolvedValue({ baseUrl: 'https://engine.test', apiKey: null } as never)
        vi.mocked(callableEngineAgentIds).mockResolvedValue(['engine-open'])
        vi.mocked(startChat).mockResolvedValue(new Response('', { status: 500 }))

        await POST(post())

        expect(vi.mocked(startChat).mock.calls[0][2]).toMatchObject({ callableAgentIds: ['engine-open'] })
    })

    it('sweeps the session before stopping the run by name, so a message waiting behind it survives', async () => {
        const order: string[] = []
        vi.mocked(getWorkspaceConnection).mockResolvedValue({ baseUrl: 'https://engine.test', apiKey: null } as never)
        vi.mocked(cancelForemanSessionRuns).mockImplementation(async () => void order.push('session'))
        vi.mocked(cancelRun).mockImplementation(async () => void order.push('run'))

        const response = await DELETE(new Request(`${URL}?runId=run-a&sessionId=session`, { method: 'DELETE' }))

        expect(response.status).toBe(200)
        expect(order).toEqual(['session', 'run'])
        expect(cancelRun).toHaveBeenCalledWith(expect.anything(), expect.any(String), 'run-a')
    })

    it('answers 502 when the sweep fails and no run id is left to stop', async () => {
        vi.mocked(cancelForemanSessionRuns).mockRejectedValue(new Error('engine down'))

        const response = await DELETE(new Request(`${URL}?sessionId=session`, { method: 'DELETE' }))

        expect(response.status).toBe(502)
        expect(cancelRun).not.toHaveBeenCalled()
    })
})
