'use server'

import { desktopAppSchema, desktopViewModeSchema, takeoverUrlSchema, type DesktopApp, type DesktopViewMode, type ScreenSession, type TakeoverResult } from '@rerun/contracts'

import { assertAgentInWorkspace, deniedCode, type DeniedCode } from '@/app/api/_auth/access'
import { requireWorkspaceContext } from '@/app/api/_auth/ownership'
import { DesktopUnavailableError, desktopSocketUrl, resolveWorkspaceDesktop, type WorkspaceDesktop } from '@/app/api/_services/desktop.service'
import { resolveRunTarget } from '@/app/api/_services/chat.service'
import { NoEngineError } from '@/app/api/_services/workspace-engine.service'
import { finishTakeover, listScreenSessions, openDesktopApp, startDesktop, startTakeover } from '@/lib/engine/client'

type Failure = { ok: false; error: string; code?: DeniedCode }

const GENERIC_ERROR = "The machine's screen could not be reached. Try again in a moment."

function failure(err: unknown): Failure {
    if (err instanceof DesktopUnavailableError || err instanceof NoEngineError) return { ok: false, error: err.message }
    const code = deniedCode(err)
    if (code && err instanceof Error) return { ok: false, error: err.message, code }
    console.error('[desktop]', err)
    return { ok: false, error: GENERIC_ERROR }
}

// Every member of the workspace may watch and drive the screens of its agents. A visitor who has not created an
// account yet has a workspace too, and gets none of it.
async function memberDesktop(): Promise<WorkspaceDesktop> {
    const ctx = await requireWorkspaceContext()
    if (ctx.authUser.is_anonymous) throw new DesktopUnavailableError('Create your account to open a desktop.')
    return resolveWorkspaceDesktop(ctx.workspace.id)
}

async function engineAgentId(agentId: string): Promise<string> {
    const agent = await assertAgentInWorkspace(agentId)
    if (!agent.engine_agent_id) throw new DesktopUnavailableError('This coworker is not on the machine yet.')
    return agent.engine_agent_id
}

// `dock` is true when the screen draws its own launcher, which an older machine does not.
export type DesktopSocket = { ok: true; socketUrl: string; dock: boolean } | Failure

// Also what a reconnect calls: the ticket in the URL is spent after a minute. The agent keeps its
// hands off a screen while someone clicks or types in it, so a view that only watches says so.
export async function openDesktopAction(agentId: string, mode: DesktopViewMode, timeZone?: string): Promise<DesktopSocket> {
    try {
        const [desktop, engineId] = await Promise.all([memberDesktop(), engineAgentId(agentId)])
        const { screens } = await startDesktop(desktop.conn, engineId, timeZone)
        const dock = screens.find(screen => screen.agentId === engineId)?.dock ?? false
        return { ok: true, socketUrl: desktopSocketUrl(desktop, engineId, desktopViewModeSchema.parse(mode)), dock }
    } catch (err) {
        return failure(err)
    }
}

export async function launchDesktopAppAction(agentId: string, app: DesktopApp): Promise<{ ok: true } | Failure> {
    try {
        const [desktop, engineId] = await Promise.all([memberDesktop(), engineAgentId(agentId)])
        await openDesktopApp(desktop.conn, engineId, desktopAppSchema.parse(app))
        return { ok: true }
    } catch (err) {
        return failure(err)
    }
}

export async function startTakeoverAction(agentId: string, url?: string): Promise<{ ok: true } | Failure> {
    try {
        const [desktop, engineId] = await Promise.all([memberDesktop(), engineAgentId(agentId)])
        await startTakeover(desktop.conn, engineId, takeoverUrlSchema.optional().safeParse(url).data)
        return { ok: true }
    } catch (err) {
        return failure(err)
    }
}

// The evidence a coworker's screen work left in its workspace. Reads like the files routes do, so it
// needs no running desktop; a coworker without any answers an empty list.
export async function listScreenSessionsAction(agentId: string): Promise<ScreenSession[]> {
    try {
        const target = await resolveRunTarget(agentId)
        return await listScreenSessions(target.conn, target.engineAgentId)
    } catch (err) {
        console.error('[desktop] screen sessions', err)
        return []
    }
}

export async function finishTakeoverAction(agentId: string, { keepOpen = false } = {}): Promise<({ ok: true } & TakeoverResult) | Failure> {
    try {
        const [desktop, engineId] = await Promise.all([memberDesktop(), engineAgentId(agentId)])
        const { url, open } = await finishTakeover(desktop.conn, engineId, { keepOpen })
        return { ok: true, url, open }
    } catch (err) {
        return failure(err)
    }
}
