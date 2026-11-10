import { z } from 'zod'

export const DESKTOP_WS_PATH = '/desktop/ws'

export const DESKTOP_TICKET_TTL_MS = 60_000

// Watching leaves the agent's hands free; driving pauses them. A ticket without a mode comes from a
// hub that predates the distinction, where a screen was mostly opened to drive it.
export const desktopViewModeSchema = z.enum(['watch', 'drive'])
export type DesktopViewMode = z.infer<typeof desktopViewModeSchema>

export const desktopAppSchema = z.enum(['browser', 'files', 'terminal'])
export type DesktopApp = z.infer<typeof desktopAppSchema>

export const desktopAppRequestSchema = z.object({ app: desktopAppSchema })

// The viewer's time zone, for the clock on the screen: a box keeps UTC.
export const desktopSessionRequestSchema = z.object({
    timeZone: z
        .string()
        .regex(/^[A-Za-z0-9_+\-/]+$/)
        .optional()
        .catch(undefined),
})

export const desktopStatusSchema = z.object({
    available: z.boolean(),
    // `dock` says the screen draws its own launcher, so the app leaves that to it.
    // `agentDriving` says a run of the agent has its hands on the screen.
    screens: z.array(z.object({ agentId: z.string(), viewers: z.number(), takeover: z.boolean(), dock: z.boolean().default(false), agentDriving: z.boolean().default(false) })),
})
export type DesktopStatus = z.infer<typeof desktopStatusSchema>

// The page the coworker's own browser opens on: a web page, never a file, a script or the browser's
// own screens.
export const takeoverUrlSchema = z.string().url().refine(url => /^https?:\/\//i.test(url), 'Only a web page can be opened')
export const takeoverRequestSchema = z.object({ url: takeoverUrlSchema.optional() })

// open: the window was left on the agent's screen. An engine that predates it closes the window and leaves it out.
export const takeoverResultSchema = z.object({ url: z.string().nullable(), open: z.boolean().optional() })
export type TakeoverResult = z.infer<typeof takeoverResultSchema>

// One screen session of an agent: the workspace folder `screen/<id>` holding the screenshots of a
// run's actions and the MP4 of the whole session. `endedAt` is null while it is still being written.
export const screenSessionSchema = z.object({
    id: z.string(),
    startedAt: z.string(),
    endedAt: z.string().nullable(),
    frames: z.number().int().nonnegative(),
    recording: z.boolean(),
})
export type ScreenSession = z.infer<typeof screenSessionSchema>

export const screenSessionsSchema = z.object({ sessions: z.array(screenSessionSchema) })
export type ScreenSessions = z.infer<typeof screenSessionsSchema>

// An app's request for a socket to one agent's screen. The ticket in the URL is spent after a minute:
// a reconnect asks again.
export const desktopSocketRequestSchema = desktopSessionRequestSchema.extend({ mode: desktopViewModeSchema })

export const desktopSocketSchema = z.object({ socketUrl: z.string(), dock: z.boolean() })
export type DesktopSocketView = z.infer<typeof desktopSocketSchema>
