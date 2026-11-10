import { existsSync, readFileSync } from 'node:fs'
import { vi } from 'vitest'

const state = vi.hoisted(() => ({
    env: {} as Record<string, unknown>,
    available: true,
    calls: [] as Array<[string, ...unknown[]]>,
    actedViews: [] as Array<{ x: number; y: number; width: number; height: number }>,
    capturedViews: [] as Array<{ x: number; y: number; width: number; height: number }>,
    captures: 0,
    failure: null as Error | null,
    screenHolds: 0,
    sessionHolds: 0,
    sessionCount: 0,
    sessionRecords: [] as boolean[],
    frames: [] as string[],
    browserHolds: 0,
    openBrowser: false,
    openBrowserHolds: 0,
    browserUrls: [] as Array<string | undefined>,
    apps: [] as string[],
    sleeps: [] as number[],
    driving: false,
    holding: false,
    touched: false,
    drivingAfterTyped: null as number | null,
    drivingForPolls: 0,
    parkLongSleeps: false,
    env: {} as Record<string, string>,
    secretMeta: {} as Record<string, { site: string; allowAlways: boolean }>,
    decisions: [] as Array<[string, string, string, string]>,
    decision: null as 'approved' | 'declined' | null,
    browserSite: null as string | null,
}))

vi.mock('node:timers/promises', () => ({
    setTimeout: async (ms: number, _value: unknown, options?: { signal?: AbortSignal }) => {
        state.sleeps.push(ms)
        if (state.parkLongSleeps && ms >= 60_000) {
            await new Promise((_, reject) => options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
        }
        await Promise.resolve()
        if (options?.signal?.aborted) throw new Error('aborted')
    },
}))

vi.mock('../../desktop/control.js', () => {
    class ControlRefusal extends Error {}
    type MockView = { x: number; y: number; width: number; height: number }
    type MockControl = { view: MockView; scale: number; width: number; height: number }
    const record =
        (name: string) =>
        async (control: MockControl, ...args: unknown[]) => {
            if (state.failure) throw state.failure
            state.calls.push([name, ...args])
            state.actedViews.push(control.view)
        }
    return {
        ControlRefusal,
        controlScreen: async (agentId: string, signal?: AbortSignal) => ({ agentId, signal, width: 1920, height: 1080, view: { x: 0, y: 0, width: 1920, height: 1080 }, scale: 1.5 }),
        // The real math lives in control.test.ts: this one maps the region 1:1 so the tests here can
        // tell which view an action ran and captured under.
        zoomedControl: (control: MockControl, region: [number, number, number, number]) => {
            if (!(region[2] > 0) || !(region[3] > 0)) throw new ControlRefusal('zoom needs a region with a positive width and height.')
            return { ...control, view: { x: region[0], y: region[1], width: region[2], height: region[3] }, scale: 1 }
        },
        captureScreen: async (control: MockControl) => {
            state.capturedViews.push(control.view)
            return { image: Buffer.from(`shot-${++state.captures}`), mediaType: 'image/jpeg', width: Math.round(control.view.width / control.scale), height: Math.round(control.view.height / control.scale) }
        },
        click: record('click'),
        drag: record('drag'),
        holdKey: record('hold_key'),
        mouseDown: record('mouse_down'),
        mouseUp: record('mouse_up'),
        movePointer: record('move'),
        pressKeys: record('key'),
        scroll: record('scroll'),
        typeText: record('type'),
    }
})

vi.mock('../../desktop/session.js', () => ({
    computerAvailable: () => state.available,
    humanDriving: () => state.driving || state.sleeps.filter(ms => ms === 500).length < state.drivingForPolls || (state.drivingAfterTyped !== null && state.calls.filter(([name]) => name === 'type').length >= state.drivingAfterTyped),
    humanHolding: () => state.holding,
    humanTouchedSince: () => state.touched,
    holdDesktop: () => {
        state.screenHolds++
        return () => {
            state.screenHolds--
        }
    },
}))

vi.mock('../../agents/env.js', () => ({
    readAgentEnv: async () => ({ ...state.env }),
}))

vi.mock('../../desktop/screen-secrets.js', () => ({
    screenSecretMeta: async (_agentId: string, key: string) => state.secretMeta[key] ?? null,
    secretUseDecision: async (agentId: string, sessionId: string, key: string, site: string) => {
        state.decisions.push([agentId, sessionId, key, site])
        return state.decision
    },
    typeSecretApprovalAction: (key: string, site: string) => `Type the saved secret ${key} into ${site}`,
}))

vi.mock('../../desktop/takeover.js', () => ({
    currentBrowserSite: async () => state.browserSite,
    holdOpenBrowser: () => {
        if (!state.openBrowser) return () => {}
        state.openBrowserHolds++
        return () => {
            state.openBrowserHolds--
        }
    },
    holdBrowser: async (_agentId: string, url?: string) => {
        state.browserHolds++
        state.browserUrls.push(url)
        return () => {
            state.browserHolds--
        }
    },
}))

vi.mock('../../desktop/apps.js', () => ({
    openDesktopApp: async (_agentId: string, app: string) => {
        state.apps.push(app)
    },
}))

vi.mock('../../desktop/recording.js', () => ({
    holdScreenSession: (agentId: string, { record = true } = {}) => {
        state.sessionHolds++
        state.sessionRecords.push(record)
        const id = `session-${agentId}-${++state.sessionCount}`
        return {
            id,
            saveFrame: async (image: Buffer) => {
                state.frames.push(`${id}:${image.toString()}`)
            },
            release: () => {
                state.sessionHolds--
            },
        }
    },
}))

vi.mock('../../config/env.js', async importOriginal => {
    const actual = await importOriginal<typeof import('../../config/env.js')>()
    return { ...actual, env: () => ({ ...actual.env(), ...state.env }) }
})

const { afterEach, beforeEach, describe, expect, it } = await import('vitest')
const { agentConfigSchema } = await import('../../agents/types.js')
const { ControlRefusal } = await import('../../desktop/control.js')
const { agentsOnScreen, computerTools, offersComputer } = await import('./computer.js')

type Built = ReturnType<typeof computerTools>
const open: Built[] = []

function ctxWith(id = 'a1', tools: Record<string, boolean> = {}, extra: Record<string, unknown> = {}) {
    return { agent: { id, config: agentConfigSchema.parse({ name: 'x', tools: { computer: true, ...tools } }) }, sessionId: 's', ...extra } as any
}

function build(ctx: any): Built {
    const built = computerTools(ctx)
    open.push(built)
    return built
}

const act = (built: Built, input: Record<string, unknown>) => (built.tools.computer as any).execute(input, { toolCallId: 'c', messages: [] })
const openApp = (built: Built, input: Record<string, unknown>) => (built.tools.computer_open_app as any).execute(input, { toolCallId: 'c', messages: [] })

beforeEach(() => {
    state.env = {}
    state.available = true
    state.calls.length = 0
    state.actedViews.length = 0
    state.capturedViews.length = 0
    state.captures = 0
    state.failure = null
    state.sessionHolds = 0
    state.sessionCount = 0
    state.sessionRecords.length = 0
    state.frames.length = 0
    state.browserUrls.length = 0
    state.apps.length = 0
    state.sleeps.length = 0
    state.driving = false
    state.holding = false
    state.touched = false
    state.drivingAfterTyped = null
    state.drivingForPolls = 0
    state.openBrowser = false
    state.parkLongSleeps = false
    state.env = {}
    state.secretMeta = {}
    state.decisions.length = 0
    state.decision = null
    state.browserSite = null
})

afterEach(() => {
    for (const built of open.splice(0)) built.release()
})

const settled = <T>(work: Promise<T>): Promise<T> => work

describe('offersComputer', () => {
    const config = (input: Record<string, unknown> = {}) => agentConfigSchema.parse({ name: 'x', tools: { computer: true }, ...input })

    it('goes to an agent that was handed a computer, on a box that can show its screen', () => {
        expect(offersComputer(config())).toBe(true)
        expect(offersComputer(agentConfigSchema.parse({ name: 'x', tools: { computer: false } }))).toBe(false)
        state.available = false
        expect(offersComputer(config())).toBe(false)
    })

    it('skips a delegate nobody watches and the foreman', () => {
        expect(offersComputer(config({ ephemeral: true }))).toBe(false)
        expect(offersComputer(config({ kind: 'foreman' }))).toBe(false)
    })
})

describe('computer', () => {
    it('looks at the screen and names the picture it kept for the model', async () => {
        const ctx = ctxWith()
        const result = await settled(act(build(ctx), { action: 'screenshot' }))
        expect(result).toEqual({ status: 'done', screenshotId: expect.any(String), screen: [1280, 720], screenSession: 'session-a1-1' })
        expect(ctx.screenshots.get(result.screenshotId).image.toString()).toBe('shot-1')
        expect(state.calls).toEqual([])
        expect(state.sleeps).toEqual([])
    })

    it('keeps every action screenshot in the screen session of the run, released with the screen', async () => {
        const built = build(ctxWith())
        expect(state.sessionHolds).toBe(0)
        await settled(act(built, { action: 'screenshot' }))
        await settled(act(built, { action: 'left_click', coordinate: [1, 1] }))
        expect(state.sessionHolds).toBe(1)
        expect(state.sessionRecords).toEqual([true])
        expect(state.frames).toEqual(['session-a1-1:shot-1', 'session-a1-1:shot-2'])
        built.release()
        expect(state.sessionHolds).toBe(0)
    })

    it('opens no recording for an agent that switched it off', async () => {
        const built = build(ctxWith('a1', { computerRecording: false }))
        await settled(act(built, { action: 'screenshot' }))
        expect(state.sessionRecords).toEqual([false])
        expect(state.frames).toEqual(['session-a1-1:shot-1'])
    })

    it('maps every action onto the screen', async () => {
        const built = build(ctxWith())
        const inputs = [
            { action: 'left_click', coordinate: [10, 20] },
            { action: 'right_click', coordinate: [10, 20] },
            { action: 'double_click', coordinate: [10, 20] },
            { action: 'mouse_move', coordinate: [30, 40] },
            { action: 'left_click_drag', start_coordinate: [1, 2], coordinate: [3, 4] },
            { action: 'scroll', coordinate: [5, 6], scroll_direction: 'down' },
            { action: 'scroll', coordinate: [5, 6], scroll_direction: 'up', scroll_amount: 7 },
            { action: 'type', text: 'hello' },
            { action: 'key', text: 'ctrl+a' },
            { action: 'wait', duration: 2 },
            { action: 'wait' },
        ]
        for (const input of inputs) expect((await settled(act(built, input))).status, input.action).toBe('done')
        expect(state.calls).toEqual([
            ['click', [10, 20]],
            ['click', [10, 20], { button: 'right' }],
            ['click', [10, 20], { clicks: 2 }],
            ['move', [30, 40]],
            ['drag', [1, 2], [3, 4]],
            ['scroll', [5, 6], 'down', 3],
            ['scroll', [5, 6], 'up', 7],
            ['type', 'hello'],
            ['key', 'ctrl+a'],
        ])
        expect(state.sleeps).toEqual([600, 600, 600, 600, 600, 600, 600, 600, 600, 2000, 1000])
    })

    it('says which field an action is missing instead of acting blind', async () => {
        const built = build(ctxWith())
        expect(await settled(act(built, { action: 'left_click' }))).toEqual({ status: 'refused', reason: 'left_click needs coordinate.' })
        expect(await settled(act(built, { action: 'left_click_drag', coordinate: [1, 1] }))).toEqual({ status: 'refused', reason: 'left_click_drag needs start_coordinate.' })
        expect(await settled(act(built, { action: 'scroll', coordinate: [1, 1] }))).toEqual({ status: 'refused', reason: 'scroll needs scroll_direction.' })
        expect(await settled(act(built, { action: 'type' }))).toEqual({ status: 'refused', reason: 'type needs text.' })
        expect(state.calls).toEqual([])
    })

    it('reports what the screen refused and what broke as two different things', async () => {
        const built = build(ctxWith())
        state.failure = new ControlRefusal('not yours')
        expect(await settled(act(built, { action: 'left_click', coordinate: [1, 1] }))).toEqual({ status: 'refused', reason: 'not yours' })
        state.failure = new Error('xdotool is gone')
        expect(await settled(act(built, { action: 'left_click', coordinate: [1, 1] }))).toEqual({ status: 'failed', reason: 'xdotool is gone' })
        state.failure = 'plain' as unknown as Error
        expect(await settled(act(built, { action: 'left_click', coordinate: [1, 1] }))).toEqual({ status: 'failed', reason: 'plain' })
    })

    it('stops with the run instead of answering', async () => {
        const controller = new AbortController()
        const built = build(ctxWith('a1', {}, { abortSignal: controller.signal }))
        const waiting = act(built, { action: 'wait', duration: 5 })
        waiting.catch(() => {})
        controller.abort()
        await expect(settled(waiting)).rejects.toThrow()
    })

    it('keeps the screen up from the first action until the run lets go', async () => {
        const built = build(ctxWith())
        expect(state.screenHolds).toBe(0)
        await settled(act(built, { action: 'screenshot' }))
        await settled(act(built, { action: 'screenshot' }))
        expect(state.screenHolds).toBe(1)
        built.release()
        expect(state.screenHolds).toBe(0)
    })

    it('holds the browser already on the screen, a window handed back after a sign-in, until the run lets go', async () => {
        state.openBrowser = true
        const built = build(ctxWith())
        await settled(act(built, { action: 'screenshot' }))
        await settled(act(built, { action: 'screenshot' }))
        expect(state.openBrowserHolds).toBe(1)
        built.release()
        expect(state.openBrowserHolds).toBe(0)
    })

    it('gives the screen to the first run of an agent and tells the others why they gave up waiting', async () => {
        const first = build(ctxWith())
        const second = build(ctxWith())
        const other = build(ctxWith('a2'))
        expect((await settled(act(first, { action: 'screenshot' }))).status).toBe('done')
        expect(await settled(act(second, { action: 'screenshot' }))).toMatchObject({ status: 'refused', reason: expect.stringContaining('Another run') })
        expect((await settled(act(other, { action: 'screenshot' }))).status).toBe('done')
        second.release()
        expect(await settled(act(second, { action: 'screenshot' }))).toMatchObject({ status: 'refused' })
        first.release()
        expect((await settled(act(second, { action: 'screenshot' }))).status).toBe('done')
        expect(state.sleeps).toContain(5 * 60_000)
    })

    it('hands the screen to a waiting run as soon as the holder ends, one waiter at a time', async () => {
        state.parkLongSleeps = true
        const first = build(ctxWith())
        const second = build(ctxWith())
        const third = build(ctxWith())
        expect((await act(first, { action: 'screenshot' })).status).toBe('done')

        const outcomes: string[] = []
        const secondTurn = act(second, { action: 'screenshot' }).then((r: { status: string }) => outcomes.push(`second:${r.status}`))
        const thirdTurn = act(third, { action: 'screenshot' }).then((r: { status: string }) => outcomes.push(`third:${r.status}`))
        await new Promise(r => setImmediate(r))
        expect(outcomes).toEqual([])

        first.release()
        await secondTurn
        await new Promise(r => setImmediate(r))
        expect(outcomes).toEqual(['second:done'])
        expect(agentsOnScreen()).toEqual(['a1'])

        second.release()
        await thirdTurn
        expect(outcomes).toEqual(['second:done', 'third:done'])
    })

    it('stops waiting for the screen when its run is cancelled', async () => {
        state.parkLongSleeps = true
        const first = build(ctxWith())
        const controller = new AbortController()
        const second = build(ctxWith('a1', {}, { abortSignal: controller.signal }))
        expect((await act(first, { action: 'screenshot' })).status).toBe('done')

        const waiting = act(second, { action: 'screenshot' })
        await new Promise(r => setImmediate(r))
        controller.abort()
        await expect(waiting).rejects.toThrow('aborted')
        first.release()
        expect(agentsOnScreen()).toEqual([])
    })

    it('keeps its hands off while a person drives the screen, and takes it back when they stop', async () => {
        const built = build(ctxWith())
        state.driving = true
        expect(await settled(act(built, { action: 'left_click', coordinate: [1, 1] }))).toMatchObject({ status: 'refused', reason: expect.stringContaining('driving your screen') })
        expect(await settled(openApp(built, { app: 'files' }))).toMatchObject({ status: 'refused' })
        expect(state.calls).toEqual([])
        expect(state.apps).toEqual([])
        state.driving = false
        expect((await settled(act(built, { action: 'left_click', coordinate: [1, 1] }))).status).toBe('done')
    })

    it('waits for a person who clicked in the screen, then carries on', async () => {
        const built = build(ctxWith())
        state.drivingForPolls = 3
        expect((await settled(act(built, { action: 'left_click', coordinate: [1, 1] }))).status).toBe('done')
        expect(state.sleeps).toEqual([500, 500, 500, 600])
        expect(state.calls).toHaveLength(1)
    })

    it('types a long text in pieces and stops where a person takes the screen', async () => {
        const built = build(ctxWith())
        const text = 'x'.repeat(100)
        expect((await settled(act(built, { action: 'type', text }))).status).toBe('done')
        expect(state.calls.map(([, chunk]) => (chunk as string).length)).toEqual([40, 40, 20])
        state.calls.length = 0
        state.drivingAfterTyped = 1
        expect(await settled(act(built, { action: 'type', text }))).toMatchObject({ status: 'refused', reason: expect.stringContaining('driving your screen') })
        expect(state.calls).toHaveLength(1)
    })

    it('tells the model the user took the screen, not that they are driving it, while an explicit hold lasts', async () => {
        const built = build(ctxWith())
        state.driving = true
        state.holding = true
        expect(await settled(act(built, { action: 'left_click', coordinate: [1, 1] }))).toMatchObject({ status: 'refused', reason: expect.stringContaining('took your screen') })
        expect(state.calls).toEqual([])
        state.driving = false
        state.drivingAfterTyped = 1
        expect(await settled(act(built, { action: 'type', text: 'x'.repeat(100) }))).toMatchObject({ status: 'refused', reason: expect.stringContaining('took your screen') })
        expect(state.calls).toHaveLength(1)
        state.holding = false
        state.drivingAfterTyped = null
        expect((await settled(act(built, { action: 'left_click', coordinate: [1, 1] }))).status).toBe('done')
    })

    it('notes that the user touched the screen between two actions, never on the first one', async () => {
        const built = build(ctxWith())
        state.touched = true
        const first = await settled(act(built, { action: 'screenshot' }))
        expect(first.status).toBe('done')
        expect(first.note).toBeUndefined()
        const second = await settled(act(built, { action: 'screenshot' }))
        expect(second).toMatchObject({ status: 'done', note: expect.stringContaining('The user drove the screen since your last action') })
        state.touched = false
        const third = await settled(act(built, { action: 'screenshot' }))
        expect(third.note).toBeUndefined()
    })

    it('names the agents whose run has the screen', async () => {
        const built = build(ctxWith('a7'))
        expect(agentsOnScreen()).not.toContain('a7')
        await settled(act(built, { action: 'screenshot' }))
        expect(agentsOnScreen()).toContain('a7')
        built.release()
        expect(agentsOnScreen()).not.toContain('a7')
    })

    it('hands codex its screenshot as a file to open, and removes the files when the run is over', async () => {
        const ctx = ctxWith('codex-agent', {}, { provider: 'codex' })
        const built = build(ctx)
        const first = await settled(act(built, { action: 'screenshot' }))
        const second = await settled(act(built, { action: 'screenshot' }))
        expect(first).toEqual({ status: 'done', screen: [1280, 720], screenSession: 'session-codex-agent-1', screenshotPath: expect.stringMatching(/rerun-desktop\/screens\/codex-agent\/.+\.jpg$/), next: expect.stringContaining('view_image') })
        expect(readFileSync(first.screenshotPath).toString()).toBe('shot-1')
        expect(second.screenshotPath).not.toBe(first.screenshotPath)
        expect(ctx.screenshots).toBeUndefined()
        built.release()
        await vi.waitFor(() => expect(existsSync(first.screenshotPath)).toBe(false))
    })

    it('gives a run on a CLI fewer actions, since its pictures all stay in its context', async () => {
        const built = build(ctxWith('claude-agent', {}, { provider: 'claude' }))
        for (let i = 0; i < 60; i++) expect((await settled(act(built, { action: 'screenshot' }))).status).toBe('done')
        expect(await settled(act(built, { action: 'screenshot' }))).toMatchObject({ status: 'refused', reason: expect.stringContaining('60 screen actions') })
    })

    it('ends a run that would click forever', async () => {
        const built = build(ctxWith())
        for (let i = 0; i < 200; i++) expect((await settled(act(built, { action: 'screenshot' }))).status).toBe('done')
        expect(await settled(act(built, { action: 'screenshot' }))).toMatchObject({ status: 'refused', reason: expect.stringContaining('200 screen actions') })
    })

    it('takes its action budgets from the box configuration', async () => {
        state.env = { RERUN_COMPUTER_MAX_ACTIONS: 3, RERUN_COMPUTER_MAX_ACTIONS_CLI: 2 }
        const api = build(ctxWith())
        for (let i = 0; i < 3; i++) expect((await settled(act(api, { action: 'screenshot' }))).status).toBe('done')
        expect(await settled(act(api, { action: 'screenshot' }))).toMatchObject({ status: 'refused', reason: expect.stringContaining('3 screen actions') })
        api.release()
        const cli = build(ctxWith('claude-agent', {}, { provider: 'claude' }))
        for (let i = 0; i < 2; i++) expect((await settled(act(cli, { action: 'screenshot' }))).status).toBe('done')
        expect(await settled(act(cli, { action: 'screenshot' }))).toMatchObject({ status: 'refused', reason: expect.stringContaining('2 screen actions') })
    })
})

const FULL_VIEW = { x: 0, y: 0, width: 1920, height: 1080 }
const ZOOMED_VIEW = { x: 100, y: 100, width: 640, height: 360 }

describe('zoom', () => {
    it('magnifies a region and keeps every next action in that frame, until a plain screenshot resets it', async () => {
        const built = build(ctxWith())
        const zoomed = await settled(act(built, { action: 'zoom', region: [100, 100, 640, 360] }))
        expect(zoomed).toMatchObject({ status: 'done', screen: [640, 360] })
        expect(state.capturedViews.at(-1)).toEqual(ZOOMED_VIEW)
        await settled(act(built, { action: 'left_click', coordinate: [10, 10] }))
        expect(state.actedViews.at(-1)).toEqual(ZOOMED_VIEW)
        expect(state.capturedViews.at(-1)).toEqual(ZOOMED_VIEW)
        await settled(act(built, { action: 'left_click_drag', start_coordinate: [1, 2], coordinate: [3, 4] }))
        await settled(act(built, { action: 'scroll', coordinate: [5, 6], scroll_direction: 'down' }))
        expect(state.actedViews.slice(-2)).toEqual([ZOOMED_VIEW, ZOOMED_VIEW])
        await settled(act(built, { action: 'screenshot' }))
        expect(state.capturedViews.at(-1)).toEqual(FULL_VIEW)
        await settled(act(built, { action: 'left_click', coordinate: [10, 10] }))
        expect(state.actedViews.at(-1)).toEqual(FULL_VIEW)
    })

    it('takes no settle pause: looking changes nothing on the screen', async () => {
        const built = build(ctxWith())
        await settled(act(built, { action: 'zoom', region: [0, 0, 10, 10] }))
        expect(state.sleeps).toEqual([])
    })

    it('needs a region, and refuses an empty one through the zoom math', async () => {
        const built = build(ctxWith())
        expect(await settled(act(built, { action: 'zoom' }))).toEqual({ status: 'refused', reason: 'zoom needs region.' })
        expect(await settled(act(built, { action: 'zoom', region: [10, 10, 0, 5] }))).toMatchObject({ status: 'refused', reason: expect.stringContaining('positive width') })
        expect(state.captures).toBe(0)
    })

    it('forgets the zoom when an app opens over it', async () => {
        const built = build(ctxWith())
        await settled(act(built, { action: 'zoom', region: [100, 100, 640, 360] }))
        await settled(openApp(built, { app: 'files' }))
        expect(state.capturedViews.at(-1)).toEqual(FULL_VIEW)
        await settled(act(built, { action: 'left_click', coordinate: [10, 10] }))
        expect(state.actedViews.at(-1)).toEqual(FULL_VIEW)
    })
})

describe('the Anthropic-native computer toolset', () => {
    const nativeCtx = (extra: Record<string, unknown> = {}) => ctxWith('a1', {}, { provider: 'anthropic', model: 'claude-opus-5-5', ...extra })
    const nativeAct = (built: Built, input: Record<string, unknown>, messages: unknown[] = []) => (built.tools.computer as any).execute(input, { toolCallId: 'c', messages })
    const toolsetId = (built: Built) => (built.tools.computer as any).id

    it('replaces the generic tool only on a Claude model the Claude API serves the toolset to', () => {
        for (const model of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-2', 'claude-opus-4-8']) {
            const built = build(nativeCtx({ model }))
            expect(toolsetId(built), model).toBe('anthropic.computer_toolset_20260801')
            expect(Object.keys(built.tools).sort()).toEqual(['computer', 'computer_open_app', 'type_secret'])
        }
        for (const [provider, model] of [
            ['anthropic', 'claude-sonnet-4-6'],
            ['anthropic', 'claude-haiku-4-5'],
            ['rerun', 'claude-opus-5-5'],
            ['openrouter', 'anthropic/claude-opus-5-5'],
        ]) {
            const built = build(ctxWith('a1', {}, { provider, model }))
            expect(toolsetId(built), `${provider}:${model}`).toBeUndefined()
            expect(built.tools.type_secret, `${provider}:${model}`).toBeUndefined()
        }
    })

    it('keeps cursor position switched off in the toolset config', () => {
        expect((build(nativeCtx()).tools.computer as any).args).toEqual({ configs: { cursor_position: { enabled: false } } })
    })

    it('maps the toolset vocabulary onto the one executor', async () => {
        const built = build(nativeCtx())
        const inputs = [
            { action: 'left_click', coordinate: [10, 20] },
            { action: 'middle_click', coordinate: [10, 20] },
            { action: 'triple_click', coordinate: [10, 20] },
            { action: 'left_mouse_down', coordinate: [5, 5] },
            { action: 'left_mouse_up', coordinate: [6, 6] },
            { action: 'left_mouse_up' },
            { action: 'hold_key', text: 'alt', duration: 2 },
            { action: 'key', text: 'Tab', repeat: 3 },
            { action: 'type', text: 'hello' },
        ]
        for (const input of inputs) expect((await settled(nativeAct(built, input))).status, input.action).toBe('done')
        expect(state.calls).toEqual([
            ['click', [10, 20]],
            ['click', [10, 20], { button: 'middle' }],
            ['click', [10, 20], { clicks: 3 }],
            ['mouse_down', [5, 5]],
            ['mouse_up', [6, 6]],
            ['mouse_up', undefined],
            ['hold_key', 'alt', 2],
            ['key', 'Tab'],
            ['key', 'Tab'],
            ['key', 'Tab'],
            ['type', 'hello'],
        ])
    })

    it('reads a zoom region as two corners and never moves the coordinate frame', async () => {
        const built = build(nativeCtx())
        const zoomed = await settled(nativeAct(built, { action: 'zoom', region: [100, 100, 740, 460] }))
        expect(zoomed).toMatchObject({ status: 'done', screen: [640, 360] })
        expect(state.capturedViews.at(-1)).toEqual(ZOOMED_VIEW)
        await settled(nativeAct(built, { action: 'left_click', coordinate: [10, 10] }))
        expect(state.actedViews.at(-1)).toEqual(FULL_VIEW)
        expect(state.capturedViews.at(-1)).toEqual(FULL_VIEW)
        expect(await settled(nativeAct(built, { action: 'zoom' }))).toEqual({ status: 'refused', reason: 'zoom needs region.' })
    })

    it('halts the rest of a turn after a failed action, and runs the next turn normally', async () => {
        const built = build(nativeCtx())
        const turn = [{ role: 'user' }, { role: 'assistant' }]
        state.failure = new ControlRefusal('not yours')
        expect(await settled(nativeAct(built, { action: 'left_click', coordinate: [1, 1] }, turn))).toEqual({ status: 'refused', reason: 'not yours' })
        state.failure = null
        expect(await settled(nativeAct(built, { action: 'left_click', coordinate: [2, 2] }, turn))).toEqual({ status: 'refused', reason: 'Not executed: an earlier computer action in this turn failed.' })
        expect(state.calls).toEqual([])
        const nextTurn = [...turn, { role: 'tool' }]
        expect((await settled(nativeAct(built, { action: 'left_click', coordinate: [3, 3] }, nextTurn))).status).toBe('done')
        expect(state.calls).toEqual([['click', [3, 3]]])
    })

    it('answers the members this computer does not serve with the next step', async () => {
        const built = build(nativeCtx())
        expect(await settled(nativeAct(built, { action: 'cursor_position' }))).toMatchObject({ status: 'refused', reason: expect.stringContaining('cursor_position') })
        expect(await settled(nativeAct(built, { action: 'type_secret' }))).toMatchObject({ status: 'refused', reason: expect.stringContaining('type_secret tool') })
        expect(state.calls).toEqual([])
    })

    it('types a saved secret through the type_secret tool, screenshot withheld', async () => {
        state.env.GH_PASSWORD = 'hunter2-value'
        state.secretMeta.GH_PASSWORD = { site: 'github.com', allowAlways: true }
        state.browserSite = 'github.com'
        const built = build(nativeCtx())
        await settled(nativeAct(built, { action: 'left_click', coordinate: [10, 10] }))
        const result = await settled((built.tools.type_secret as any).execute({ secret: 'GH_PASSWORD' }, { toolCallId: 'c', messages: [] }))
        expect(result).toEqual({ status: 'done', screen: [1280, 720], screenSession: 'session-a1-1', next: expect.stringContaining('withheld for a secret') })
        expect(state.calls).toContainEqual(['type', 'hunter2-value'])
        expect(JSON.stringify(result)).not.toContain('hunter2-value')
        expect(state.captures).toBe(1)
    })
})

describe('type_secret', () => {
    const VALUE = 'hunter2-plaintext-value'
    const armed = () => {
        state.env.GH_PASSWORD = VALUE
        state.secretMeta.GH_PASSWORD = { site: 'github.com', allowAlways: true }
        state.browserSite = 'github.com'
    }
    const typeSecret = (built: Built, secret = 'GH_PASSWORD') => settled(act(built, { action: 'type_secret', secret }))
    const clickFirst = async (built: Built) => {
        await settled(act(built, { action: 'left_click', coordinate: [10, 10] }))
    }

    it('types the saved value and answers without any screenshot, the value nowhere in the result', async () => {
        armed()
        const ctx = ctxWith()
        const built = build(ctx)
        await clickFirst(built)
        const capturesBefore = state.captures
        const framesBefore = state.frames.length
        const result = await typeSecret(built)
        expect(result).toEqual({ status: 'done', screen: [1280, 720], screenSession: 'session-a1-1', next: expect.stringContaining('withheld for a secret') })
        expect(state.calls).toContainEqual(['type', VALUE])
        expect(JSON.stringify(result)).not.toContain(VALUE)
        expect(state.captures).toBe(capturesBefore)
        expect(state.frames.length).toBe(framesBefore)
        expect(result.screenshotId).toBeUndefined()
        expect(result.screenshotPath).toBeUndefined()
    })

    it('keeps the secret out of the evidence frames and the codex screenshot files too', async () => {
        armed()
        const ctx = ctxWith('codex-agent', {}, { provider: 'codex' })
        const built = build(ctx)
        await clickFirst(built)
        const result = await typeSecret(built)
        expect(result.screenshotPath).toBeUndefined()
        expect(JSON.stringify(result)).not.toContain(VALUE)
        expect(state.frames.join()).not.toContain(VALUE)
    })

    it('refuses as the first screen action of a run', async () => {
        armed()
        const result = await typeSecret(build(ctxWith()))
        expect(result).toMatchObject({ status: 'refused', reason: expect.stringContaining('click the password field') })
        expect(state.calls.filter(([name]) => name === 'type')).toEqual([])
    })

    it('needs the secret name', async () => {
        const built = build(ctxWith())
        await clickFirst(built)
        expect(await settled(act(built, { action: 'type_secret' }))).toEqual({ status: 'refused', reason: 'type_secret needs secret.' })
    })

    it('refuses a secret that was never saved', async () => {
        armed()
        delete state.env.GH_PASSWORD
        const built = build(ctxWith())
        await clickFirst(built)
        expect(await typeSecret(built)).toMatchObject({ status: 'refused', reason: expect.stringContaining('no saved secret named GH_PASSWORD') })
    })

    it('refuses a secret saved without a site', async () => {
        armed()
        delete state.secretMeta.GH_PASSWORD
        const built = build(ctxWith())
        await clickFirst(built)
        expect(await typeSecret(built)).toMatchObject({ status: 'refused', reason: expect.stringContaining('not saved for screen use') })
    })

    it('refuses when the engine cannot tell what site the screen shows', async () => {
        armed()
        state.browserSite = null
        const built = build(ctxWith())
        await clickFirst(built)
        expect(await typeSecret(built)).toMatchObject({ status: 'refused', reason: expect.stringContaining('whose site the engine can verify') })
        expect(state.calls.filter(([name]) => name === 'type')).toEqual([])
    })

    it('refuses to type on another site, naming both', async () => {
        armed()
        state.browserSite = 'phishing.example'
        const built = build(ctxWith())
        await clickFirst(built)
        const result = await typeSecret(built)
        expect(result).toMatchObject({ status: 'refused', reason: expect.stringContaining('phishing.example') })
        expect(result.reason).toContain('github.com')
        expect(state.calls.filter(([name]) => name === 'type')).toEqual([])
    })

    it('types on a subdomain of the saved site, never on a lookalike suffix', async () => {
        armed()
        state.browserSite = 'gist.github.com'
        const built = build(ctxWith())
        await clickFirst(built)
        expect((await typeSecret(built)).status).toBe('done')
        state.browserSite = 'not-github.com'
        expect(await typeSecret(built)).toMatchObject({ status: 'refused' })
    })

    it('asks for the exact approval line when the user has not pre-authorized nor approved yet', async () => {
        armed()
        state.secretMeta.GH_PASSWORD = { site: 'github.com', allowAlways: false }
        const built = build(ctxWith())
        await clickFirst(built)
        const result = await typeSecret(built)
        expect(result).toMatchObject({ status: 'refused', reason: expect.stringContaining('request_approval') })
        expect(result.reason).toContain('"Type the saved secret GH_PASSWORD into github.com"')
        expect(state.decisions).toEqual([['a1', 's', 'GH_PASSWORD', 'github.com']])
        expect(state.calls.filter(([name]) => name === 'type')).toEqual([])
    })

    it('types once the user approved it in this run', async () => {
        armed()
        state.secretMeta.GH_PASSWORD = { site: 'github.com', allowAlways: false }
        state.decision = 'approved'
        const built = build(ctxWith())
        await clickFirst(built)
        expect((await typeSecret(built)).status).toBe('done')
        expect(state.calls).toContainEqual(['type', VALUE])
    })

    it('refuses for good what the user declined', async () => {
        armed()
        state.secretMeta.GH_PASSWORD = { site: 'github.com', allowAlways: false }
        state.decision = 'declined'
        const built = build(ctxWith())
        await clickFirst(built)
        expect(await typeSecret(built)).toMatchObject({ status: 'refused', reason: expect.stringContaining('declined') })
        expect(state.calls.filter(([name]) => name === 'type')).toEqual([])
    })

    it('never asks for a decision when the user pre-authorized the site', async () => {
        armed()
        const built = build(ctxWith())
        await clickFirst(built)
        expect((await typeSecret(built)).status).toBe('done')
        expect(state.decisions).toEqual([])
    })

    it('stops mid-secret when a person takes the screen', async () => {
        armed()
        state.env.GH_PASSWORD = 'x'.repeat(100)
        const built = build(ctxWith())
        await clickFirst(built)
        state.drivingAfterTyped = 1
        expect(await typeSecret(built)).toMatchObject({ status: 'refused', reason: expect.stringContaining('driving your screen') })
    })
})

describe('computer_open_app', () => {
    it('opens the browser as a window the run holds open, on the page it asked for', async () => {
        const built = build(ctxWith())
        expect((await settled(openApp(built, { app: 'browser', url: 'https://site.example/' }))).status).toBe('done')
        expect(state.browserUrls).toEqual(['https://site.example/'])
        expect(state.apps).toEqual(['browser'])
        expect(state.browserHolds).toBe(1)
        built.release()
        expect(state.browserHolds).toBe(0)
    })

    it('takes only an http(s) page for the browser', () => {
        const schema = (build(ctxWith()).tools.computer_open_app as any).inputSchema
        expect(schema.safeParse({ app: 'browser', url: 'https://site.example/' }).success).toBe(true)
        expect(schema.safeParse({ app: 'browser' }).success).toBe(true)
        expect(schema.safeParse({ app: 'browser', url: 'file:///etc/passwd' }).success).toBe(false)
        expect(schema.safeParse({ app: 'browser', url: 'javascript:alert(1)' }).success).toBe(false)
    })

    it('opens the files and the terminal without holding a browser', async () => {
        const built = build(ctxWith())
        await settled(openApp(built, { app: 'files' }))
        await settled(openApp(built, { app: 'terminal' }))
        expect(state.apps).toEqual(['files', 'terminal'])
        expect(state.browserHolds).toBe(0)
    })

    it('keeps the terminal and the files behind the switches that already govern them', async () => {
        expect(await settled(openApp(build(ctxWith('a1', { shell: false })), { app: 'terminal' }))).toMatchObject({ status: 'refused', reason: expect.stringContaining('shell tool is disabled') })
        expect(await settled(openApp(build(ctxWith('a2', { filesystem: false })), { app: 'files' }))).toMatchObject({ status: 'refused', reason: expect.stringContaining('filesystem tool is disabled') })
        expect(state.apps).toEqual([])
    })
})
