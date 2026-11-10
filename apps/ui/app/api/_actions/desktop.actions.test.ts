import { assertAgentInWorkspace } from '@/app/api/_auth/access'
import { requireWorkspaceContext } from '@/app/api/_auth/ownership'
import { desktopSocketUrl, resolveWorkspaceDesktop } from '@/app/api/_services/desktop.service'
import * as engine from '@/lib/engine/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { finishTakeoverAction, openDesktopAction, startTakeoverAction } from './desktop.actions'

vi.mock('@/app/api/_auth/access', async importOriginal => ({ ...(await importOriginal<typeof import('@/app/api/_auth/access')>()), assertAgentInWorkspace: vi.fn() }))
vi.mock('@/app/api/_auth/ownership', () => ({ requireWorkspaceContext: vi.fn() }))
vi.mock('@/app/api/_services/desktop.service', () => ({
    DesktopUnavailableError: class extends Error {},
    desktopSocketUrl: vi.fn(),
    resolveWorkspaceDesktop: vi.fn(),
}))
vi.mock('@/app/api/_services/workspace-engine.service', () => ({ NoEngineError: class extends Error {} }))
vi.mock('@/lib/engine/client', () => ({ finishTakeover: vi.fn(), openDesktopApp: vi.fn(), startDesktop: vi.fn(), startTakeover: vi.fn() }))

const conn = { baseUrl: 'https://engine.test', apiKey: 'box-key' }

describe('openDesktopAction', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        vi.mocked(requireWorkspaceContext).mockResolvedValue({ authUser: { is_anonymous: false }, workspace: { id: 7 } } as never)
        vi.mocked(assertAgentInWorkspace).mockResolvedValue({ workspace_id: 7, space_id: null, engine_agent_id: 'engine-agent' } as never)
        vi.mocked(resolveWorkspaceDesktop).mockResolvedValue({ conn, socketBase: 'wss://host.test/box/10/desktop/ws' })
        vi.mocked(desktopSocketUrl).mockReturnValue('wss://host.test/box/10/desktop/ws?ticket=t')
    })

    // The web shows the message; the v1 route reads the code back into the 404 or 403 a thrown refusal gives.
    it('folds a refusal into the result with the code the route turns back into a status', async () => {
        const { AuthorizationError } = await import('@/app/api/_auth/errors')
        const { AccessDeniedError } = await import('@/app/api/_auth/access')
        vi.mocked(assertAgentInWorkspace).mockRejectedValueOnce(new AuthorizationError('Coworker not found'))
        expect(await openDesktopAction('agent-1', 'watch')).toEqual({ ok: false, error: 'Coworker not found', code: 'not_found' })
        vi.mocked(assertAgentInWorkspace).mockRejectedValueOnce(new AccessDeniedError())
        expect(await startTakeoverAction('agent-1')).toMatchObject({ ok: false, code: 'forbidden' })
    })

    it('starts the screen on the viewer time zone and says whether it draws its own dock', async () => {
        vi.mocked(engine.startDesktop).mockResolvedValue({
            available: true,
            screens: [
                { agentId: 'other-agent', viewers: 0, takeover: false, dock: false, agentDriving: false, humanHolding: false, recordingPaused: false },
                { agentId: 'engine-agent', viewers: 0, takeover: false, dock: true, agentDriving: false, humanHolding: false, recordingPaused: false },
            ],
        })
        await expect(openDesktopAction('agent', 'watch', 'Europe/Paris')).resolves.toEqual({ ok: true, socketUrl: 'wss://host.test/box/10/desktop/ws?ticket=t', dock: true, recordingPaused: false })
        expect(engine.startDesktop).toHaveBeenCalledWith(conn, 'engine-agent', 'Europe/Paris')
        expect(desktopSocketUrl).toHaveBeenCalledWith(expect.anything(), 'engine-agent', 'watch')
    })

    it('keeps the launchers of the app for a machine that reports no screen of its own', async () => {
        vi.mocked(engine.startDesktop).mockResolvedValue({ available: true, screens: [] })
        await expect(openDesktopAction('agent', 'drive')).resolves.toMatchObject({ ok: true, dock: false })
    })
})

describe('startTakeoverAction', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        vi.mocked(requireWorkspaceContext).mockResolvedValue({ authUser: { is_anonymous: false }, workspace: { id: 7 } } as never)
        vi.mocked(assertAgentInWorkspace).mockResolvedValue({ workspace_id: 7, space_id: null, engine_agent_id: 'engine-agent' } as never)
        vi.mocked(resolveWorkspaceDesktop).mockResolvedValue({ conn, socketBase: 'wss://host.test/box/10/desktop/ws' })
        vi.mocked(engine.startTakeover).mockResolvedValue(undefined)
    })

    it('opens the agent browser on the page it was asked for', async () => {
        await expect(startTakeoverAction('agent', 'https://www.linkedin.com/login')).resolves.toEqual({ ok: true })
        expect(engine.startTakeover).toHaveBeenCalledWith(conn, 'engine-agent', 'https://www.linkedin.com/login')
    })

    it('opens the agent browser without a page when the one asked for is not a URL', async () => {
        await expect(startTakeoverAction('agent', 'not a url')).resolves.toEqual({ ok: true })
        expect(engine.startTakeover).toHaveBeenCalledWith(conn, 'engine-agent', undefined)
    })
})

describe('finishTakeoverAction', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        vi.mocked(requireWorkspaceContext).mockResolvedValue({ authUser: { is_anonymous: false }, workspace: { id: 7 } } as never)
        vi.mocked(assertAgentInWorkspace).mockResolvedValue({ workspace_id: 7, space_id: null, engine_agent_id: 'engine-agent' } as never)
        vi.mocked(resolveWorkspaceDesktop).mockResolvedValue({ conn, socketBase: 'wss://host.test/box/10/desktop/ws' })
    })

    it('asks the machine to leave the window on the screen when the person hands it back to the run', async () => {
        vi.mocked(engine.finishTakeover).mockResolvedValue({ url: 'https://web.whatsapp.com/', open: true })
        await expect(finishTakeoverAction('agent', { keepOpen: true })).resolves.toEqual({ ok: true, url: 'https://web.whatsapp.com/', open: true })
        expect(engine.finishTakeover).toHaveBeenCalledWith(conn, 'engine-agent', { keepOpen: true })
    })

    it('closes the window otherwise, and reports a machine that closed it anyway', async () => {
        vi.mocked(engine.finishTakeover).mockResolvedValue({ url: 'https://web.whatsapp.com/' })
        await expect(finishTakeoverAction('agent')).resolves.toEqual({ ok: true, url: 'https://web.whatsapp.com/', open: undefined })
        expect(engine.finishTakeover).toHaveBeenCalledWith(conn, 'engine-agent', { keepOpen: false })
    })
})
