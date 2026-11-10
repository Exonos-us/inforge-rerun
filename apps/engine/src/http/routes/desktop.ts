import { Hono } from 'hono'
import { desktopAppRequestSchema, desktopRecordingRequestSchema, desktopSessionRequestSchema, takeoverRequestSchema, type DesktopStatus } from '@rerun/contracts'
import { agentExists } from '../../agents/loader.js'
import { openDesktopApp } from '../../desktop/apps.js'
import { releaseScreenHold, takeScreenHold } from '../../desktop/hold.js'
import { listScreenSessions, pauseScreenRecording, resumeScreenRecording, screenRecordingPaused } from '../../desktop/recording.js'
import { desktopAvailable, ensureDesktop, humanHolding, runningDesktops } from '../../desktop/session.js'
import { activeTakeovers, finishTakeover, handBackTakeover, startTakeover } from '../../desktop/takeover.js'
import { notFound } from '../../lib/errors.js'
import { agentsOnScreen } from '../../tools/builtin/computer.js'

function status(): DesktopStatus {
    const takeovers = new Set(activeTakeovers())
    const driving = new Set(agentsOnScreen())
    return {
        available: desktopAvailable(),
        screens: runningDesktops().map(screen => ({
            ...screen,
            takeover: takeovers.has(screen.agentId),
            agentDriving: driving.has(screen.agentId),
            humanHolding: humanHolding(screen.agentId),
            recordingPaused: screenRecordingPaused(screen.agentId),
        })),
    }
}

export const desktopRoutes = new Hono()

desktopRoutes.get('/', c => c.json(status()))

export const agentDesktopRoutes = new Hono()

agentDesktopRoutes.use('*', async (c, next) => {
    if (!agentExists(c.req.param('id')!)) throw notFound('agent')
    await next()
})

agentDesktopRoutes.post('/session', async c => {
    const { timeZone } = desktopSessionRequestSchema.parse(await c.req.json().catch(() => ({})))
    await ensureDesktop(c.req.param('id')!, { timeZone })
    return c.json(status())
})

agentDesktopRoutes.post('/apps', async c => {
    const { app } = desktopAppRequestSchema.parse(await c.req.json())
    await openDesktopApp(c.req.param('id')!, app)
    return c.json(status())
})

// The explicit "Take over": while held the agent keeps its hands off the screen, even when the
// person pauses. Taking it again renews it; it expires on its own when the app stops renewing.
agentDesktopRoutes.post('/hold', async c => {
    await takeScreenHold(c.req.param('id')!)
    return c.json(status())
})

agentDesktopRoutes.delete('/hold', c => {
    releaseScreenHold(c.req.param('id')!)
    return c.json(status())
})

// Pauses or resumes the capture of the running screen session, for the moment the person on the
// screen types a credential. Each resume starts a new segment file.
agentDesktopRoutes.post('/recording', async c => {
    const { capturing } = desktopRecordingRequestSchema.parse(await c.req.json())
    const id = c.req.param('id')!
    if (capturing) resumeScreenRecording(id)
    else await pauseScreenRecording(id)
    return c.json(status())
})

agentDesktopRoutes.post('/takeover', async c => {
    const { url } = takeoverRequestSchema.parse(await c.req.json().catch(() => ({})))
    await startTakeover(c.req.param('id')!, url)
    return c.json(status())
})

// keepOpen: the person hands the browser back to the run that asked for it, which carries on in it.
agentDesktopRoutes.delete('/takeover', async c => {
    const id = c.req.param('id')!
    return c.json(await (c.req.query('keepOpen') === '1' ? handBackTakeover(id) : finishTakeover(id)))
})

// The evidence of what happened on the agent's screen, derived from its workspace `screen/` folder.
// The frames and the recording themselves are served by the agent's files routes.
export const agentScreenRoutes = new Hono()

agentScreenRoutes.use('*', async (c, next) => {
    if (!agentExists(c.req.param('id')!)) throw notFound('agent')
    await next()
})

agentScreenRoutes.get('/sessions', async c => c.json({ sessions: await listScreenSessions(c.req.param('id')!) }))
