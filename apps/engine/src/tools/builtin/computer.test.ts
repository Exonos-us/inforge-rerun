import { existsSync, readFileSync } from 'node:fs'
import { vi } from 'vitest'

const state = vi.hoisted(() => ({
    available: true,
    calls: [] as Array<[string, ...unknown[]]>,
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
    const record =
        (name: string) =>
        async (_control: unknown, ...args: unknown[]) => {
            if (state.failure) throw state.failure
            state.calls.push([name, ...args])
        }
    return {
        ControlRefusal,
        controlScreen: async (agentId: string, signal?: AbortSignal) => ({ agentId, signal, width: 1920, height: 1080, scale: 1.5 }),
        captureScreen: async () => ({ image: Buffer.from(`shot-${++state.captures}`), mediaType: 'image/jpeg', width: 1280, height: 720 }),
        click: record('click'),
        drag: record('drag'),
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
    state.available = true
    state.calls.length = 0
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
            ['click', [10, 20], { double: true }],
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
