import { Hono } from 'hono'
import { desktopAppRequestSchema, desktopSessionRequestSchema, takeoverRequestSchema, type DesktopStatus } from '@rerun/contracts'
import { agentExists } from '../../agents/loader.js'
import { openDesktopApp } from '../../desktop/apps.js'
import { listScreenSessions } from '../../desktop/recording.js'
import { desktopAvailable, ensureDesktop, runningDesktops } from '../../desktop/session.js'
import { activeTakeovers, finishTakeover, handBackTakeover, startTakeover } from '../../desktop/takeover.js'
import { notFound } from '../../lib/errors.js'
import { agentsOnScreen } from '../../tools/builtin/computer.js'

function status(): DesktopStatus {
    const takeovers = new Set(activeTakeovers())
    const driving = new Set(agentsOnScreen())
    return { available: desktopAvailable(), screens: runningDesktops().map(screen => ({ ...screen, takeover: takeovers.has(screen.agentId), agentDriving: driving.has(screen.agentId) })) }
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
