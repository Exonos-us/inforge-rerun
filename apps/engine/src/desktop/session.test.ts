import { EventEmitter } from 'node:events'
import { vi } from 'vitest'

type FakeChild = EventEmitter & { killed: boolean; killedAt: number; signals: string[]; exitCode: number | null; signalCode: string | null; kill: (signal?: string) => void }

const state = vi.hoisted(() => ({
    spawns: [] as Array<{ command: string; args: string[]; env: Record<string, string> }>,
    children: [] as unknown[],
    displays: {} as Record<string, string | null>,
    displayHolds: 0,
    binaries: true,
    panels: false,
    capture: false,
    vncUp: true,
    portTaken: false,
    vncLingerMs: 0,
}))

function fakeChild(): FakeChild {
    const child = Object.assign(new EventEmitter(), { killed: false, killedAt: 0, signals: [] as string[], exitCode: null, signalCode: null }) as FakeChild
    child.kill = (signal = 'SIGTERM') => {
        if (!child.killed) child.killedAt = Date.now()
        child.killed = true
        child.signals.push(signal)
    }
    return child
}

vi.mock('node:child_process', () => ({
    spawn: (command: string, args: string[], options: { env: Record<string, string> }) => {
        state.spawns.push({ command, args, env: options.env })
        const child = fakeChild()
        state.children.push(child)
        return child
    },
}))

vi.mock('node:fs', async importOriginal => ({
    ...(await importOriginal<typeof import('node:fs')>()),
    existsSync: (path: string) => (/\/(openbox|x11vnc|xdotool)$/.test(path) ? state.binaries : /\/(tint2|hsetroot|curl)$/.test(path) ? state.panels : /\/maim$/.test(path) ? state.capture : false),
    writeFileSync: () => {},
    mkdirSync: () => {},
}))
vi.mock('../agents/loader.js', () => ({ readAgentConfig: async () => ({ name: 'maya', displayName: ' Maya ' }) }))

const stillUp = (child: FakeChild) => !child.killed || Date.now() - child.killedAt < state.vncLingerMs

const vncListening = (port: number) => state.spawns.some((spawned, index) => spawned.command === 'x11vnc' && spawned.args.includes(String(port)) && stillUp(state.children[index] as FakeChild))

vi.mock('node:net', () => ({
    connect: (port: number) => {
        const socket = Object.assign(new EventEmitter(), { destroy() {} })
        const answers = state.portTaken || (state.vncUp && vncListening(port))
        queueMicrotask(() => socket.emit(answers ? 'connect' : 'error', new Error('refused')))
        return socket
    },
}))

vi.mock('../tools/virtual-display.js', () => ({
    holdDisplay: async (agentId: string) => {
        state.displayHolds++
        return {
            display: agentId in state.displays ? state.displays[agentId] : ':42',
            release: () => {
                state.displayHolds--
            },
        }
    },
}))
vi.mock('../lib/logger.js', () => ({ logger: { info() {}, warn() {} } }))

const { afterEach, beforeEach, describe, expect, it } = await import('vitest')

async function freshModule() {
    vi.resetModules()
    return import('./session.js')
}

const up = { startedAt: expect.any(String), uptimeSeconds: expect.any(Number) }

const killed = () => (state.children as FakeChild[]).map(child => child.killed)

beforeEach(() => {
    state.spawns.length = 0
    state.children.length = 0
    state.displays = { a1: ':42', a2: ':43' }
    state.displayHolds = 0
    state.binaries = true
    state.panels = false
    state.capture = false
    state.vncUp = true
    state.portTaken = false
    state.vncLingerMs = 0
    vi.stubEnv('PATH', '/usr/bin')
    vi.stubEnv('RERUN_DESKTOP', 'on')
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    vi.useFakeTimers()
})

afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
})

describe('desktop session', () => {
    it('starts a window manager without key bindings and a VNC server bound to localhost, once per agent', async () => {
        const session = await freshModule()
        expect(await session.ensureDesktop('a1')).toEqual({ display: ':42', vncPort: 5942 })
        expect(await session.ensureDesktop('a1')).toEqual({ display: ':42', vncPort: 5942 })
        expect(state.spawns.map(s => s.command)).toEqual(['openbox', 'x11vnc'])
        expect(state.spawns[1]!.args).toEqual(expect.arrayContaining(['-display', ':42', '-localhost', '-rfbport', '5942']))
        expect(state.spawns[0]!.env.DISPLAY).toBe(':42')
        expect(session.runningDesktops()).toEqual([{ agentId: 'a1', viewers: 0, dock: false, ...up }])
    })

    it('starts the screen processes without the engine configuration', async () => {
        vi.stubEnv('RERUN_API_KEY', 'engine-key')
        vi.stubEnv('RERUN_DATA_DIR', '/data')
        vi.stubEnv('HOME', '/home/rerun')
        const session = await freshModule()
        await session.ensureDesktop('a1')
        for (const spawned of state.spawns) {
            expect(spawned.env).toMatchObject({ DISPLAY: ':42', HOME: '/home/rerun', PATH: '/usr/bin' })
            expect(spawned.env).not.toHaveProperty('RERUN_API_KEY')
            expect(spawned.env).not.toHaveProperty('RERUN_DATA_DIR')
        }
    })

    it('gives two agents two screens, each with its own display and VNC port', async () => {
        const session = await freshModule()
        expect(await session.ensureDesktop('a1')).toEqual({ display: ':42', vncPort: 5942 })
        expect(await session.ensureDesktop('a2')).toEqual({ display: ':43', vncPort: 5943 })
        expect(state.spawns.map(s => `${s.command} ${s.env.DISPLAY}`)).toEqual(['openbox :42', 'x11vnc :42', 'openbox :43', 'x11vnc :43'])
        session.viewerJoined('a2')
        expect(session.runningDesktops()).toEqual([
            { agentId: 'a1', viewers: 0, dock: false, ...up },
            { agentId: 'a2', viewers: 1, dock: false, ...up },
        ])
        expect(session.desktopViewerCount()).toBe(1)
    })

    it('reports no desktop where the packages are missing, and refuses to start one', async () => {
        state.binaries = false
        const session = await freshModule()
        expect(session.desktopAvailable()).toBe(false)
        await expect(session.ensureDesktop('a1')).rejects.toThrow('no desktop installed')
        expect(state.spawns).toEqual([])
    })

    it('reports no desktop on a box where it is switched off, even with the packages installed', async () => {
        vi.stubEnv('RERUN_DESKTOP', 'off')
        state.capture = true
        const session = await freshModule()
        expect(session.desktopAvailable()).toBe(false)
        expect(session.computerAvailable()).toBe(false)
        await expect(session.ensureDesktop('a1')).rejects.toThrow('no desktop installed')
        expect(state.spawns).toEqual([])
    })

    it('lets an agent drive its screen only once the box can also take a picture of it', async () => {
        const waiting = await freshModule()
        expect(waiting.desktopAvailable()).toBe(true)
        expect(waiting.computerAvailable()).toBe(false)
        state.capture = true
        expect(waiting.computerAvailable()).toBe(true)
        state.binaries = false
        expect((await freshModule()).computerAvailable()).toBe(false)
    })

    it('keeps the agent off a screen while a person acts on it, not while they only have it open', async () => {
        const session = await freshModule()
        expect(session.humanDriving('a1')).toBe(false)
        session.driverLeft('a1')
        session.driverActed('a1')
        expect(session.humanDriving('a1')).toBe(false)

        session.driverJoined('a1')
        expect(session.humanDriving('a1')).toBe(false)
        session.driverActed('a1', 200_000)
        expect(session.humanDriving('a1', 200_000 + 4_000)).toBe(true)
        expect(session.humanDriving('a2', 200_000 + 4_000)).toBe(false)
        expect(session.humanDriving('a1', 200_000 + 5_000)).toBe(false)
        session.driverActed('a1', 300_000)
        session.driverLeft('a1')
        expect(session.humanDriving('a1', 300_001)).toBe(false)
        session.driverLeft('a1')
        session.driverJoined('a1')
        expect(session.humanDriving('a1', 300_000 + 5_000)).toBe(false)
    })

    it('keeps the agent off a screen a person explicitly holds, even without input, until it expires', async () => {
        const session = await freshModule()
        session.renewHumanHold('a1', 1_000_000)
        expect(session.humanHolding('a1', 1_000_001)).toBe(true)
        expect(session.humanDriving('a1', 1_000_001)).toBe(true)
        expect(session.humanDriving('a1', 1_000_000 + 2 * 60_000 - 1)).toBe(true)
        expect(session.humanHolding('a1', 1_000_000 + 2 * 60_000)).toBe(false)
        expect(session.humanDriving('a1', 1_000_000 + 2 * 60_000)).toBe(false)
        expect(session.humanHolding('a2', 1_000_001)).toBe(false)
    })

    it('renews a hold on every take and ends it on release', async () => {
        const session = await freshModule()
        session.renewHumanHold('a1', 1_000_000)
        session.renewHumanHold('a1', 1_000_000 + 90_000)
        expect(session.humanHolding('a1', 1_000_000 + 3 * 60_000)).toBe(true)
        session.endHumanHold('a1', 1_000_000 + 95_000)
        expect(session.humanHolding('a1', 1_000_000 + 95_001)).toBe(false)
        session.endHumanHold('zz')
    })

    it('tells a run whether a person touched the screen since its previous action', async () => {
        const session = await freshModule()
        expect(session.humanTouchedSince('a1', 0)).toBe(false)
        session.driverJoined('a1')
        session.driverActed('a1', 500)
        expect(session.humanTouchedSince('a1', 400)).toBe(true)
        expect(session.humanTouchedSince('a1', 500)).toBe(false)
        session.renewHumanHold('a2', 1_000)
        session.endHumanHold('a2', 2_000)
        expect(session.humanTouchedSince('a2', 1_500)).toBe(true)
        expect(session.humanTouchedSince('a2', 2_000)).toBe(false)
    })

    it('refuses to start where the agent has no display, and holds none', async () => {
        state.displays = { a1: null }
        const session = await freshModule()
        await expect(session.ensureDesktop('a1')).rejects.toThrow('no display')
        expect(state.spawns).toEqual([])
        expect(state.displayHolds).toBe(0)
    })

    it('stops five minutes after the last viewer left, and gives the display back', async () => {
        const session = await freshModule()
        await session.ensureDesktop('a1')
        session.viewerJoined('a1')
        await vi.advanceTimersByTimeAsync(10 * 60_000)
        expect(killed()).toEqual([false, false])
        session.viewerLeft('a1')
        await vi.advanceTimersByTimeAsync(4 * 60_000)
        expect(killed()).toEqual([false, false])
        expect(state.displayHolds).toBe(1)
        await vi.advanceTimersByTimeAsync(60_000)
        expect(killed()).toEqual([true, true])
        expect(session.runningDesktops()).toEqual([])
        expect(state.displayHolds).toBe(0)
    })

    it('stops the screen nobody watches and leaves the watched one up', async () => {
        const session = await freshModule()
        await session.ensureDesktop('a1')
        await session.ensureDesktop('a2')
        session.viewerJoined('a2')
        await vi.advanceTimersByTimeAsync(5 * 60_000)
        expect(killed()).toEqual([true, true, false, false])
        expect(session.runningDesktops()).toEqual([{ agentId: 'a2', viewers: 1, dock: false, ...up }])
    })

    it('stays up while a takeover holds it, watched or not', async () => {
        const session = await freshModule()
        await session.ensureDesktop('a1')
        const release = session.holdDesktop('a1')
        await vi.advanceTimersByTimeAsync(30 * 60_000)
        expect(killed()).toEqual([false, false])
        release()
        release()
        await vi.advanceTimersByTimeAsync(5 * 60_000)
        expect(killed()).toEqual([true, true])
    })

    it('stops the apps opened on the screen with it', async () => {
        const session = await freshModule()
        await session.ensureDesktop('a1')
        const app = fakeChild()
        session.trackDesktopChild('a1', app as never)
        await session.stopDesktop('a1')
        expect(app.killed).toBe(true)
    })

    it('forgets a screen whose VNC server died, and starts a fresh one on the next ask', async () => {
        const session = await freshModule()
        await session.ensureDesktop('a1')
        ;(state.children[1] as FakeChild).emit('exit', 1)
        await vi.advanceTimersByTimeAsync(0)
        expect(session.runningDesktops()).toEqual([])
        expect(killed()).toEqual([true, true])
        expect(state.displayHolds).toBe(0)
        expect(await session.ensureDesktop('a1')).toEqual({ display: ':42', vncPort: 5942 })
        expect(state.spawns.map(s => s.command)).toEqual(['openbox', 'x11vnc', 'openbox', 'x11vnc'])
    })

    it('paints the wallpaper, themes the windows and runs a dock and a top bar where their packages are installed', async () => {
        state.panels = true
        vi.stubEnv('RERUN_PORT', '3100')
        vi.stubEnv('RERUN_API_KEY', 'engine-key')
        const session = await freshModule()
        await session.ensureDesktop('a1', { timeZone: 'Europe/Paris' })
        expect(state.spawns.map(s => s.command)).toEqual(['hsetroot', 'openbox', 'x11vnc', 'tint2', 'tint2'])
        expect(state.spawns[0]!.args).toEqual(['-cover', expect.stringMatching(/assets\/desktop\/wallpaper\.png$/)])
        expect(state.spawns[1]!.env.XDG_DATA_DIRS).toMatch(/assets\/desktop:\/usr\/local\/share:\/usr\/share$/)
        expect(state.spawns[2]!.env.XDG_DATA_DIRS).toBeUndefined()
        expect(state.spawns.slice(0, 3).map(s => s.env.RERUN_API_KEY)).toEqual([undefined, undefined, undefined])
        expect(state.spawns.slice(3).map(s => s.args[1])).toEqual([expect.stringMatching(/dock\.tint2rc$/), expect.stringMatching(/bar\.tint2rc$/)])
        expect(state.spawns[3]!.env).toMatchObject({
            DISPLAY: ':42',
            RERUN_API_KEY: 'engine-key',
            RERUN_DESKTOP_AGENT: 'a1',
            RERUN_DESKTOP_AGENT_NAME: 'Maya',
            RERUN_DESKTOP_ENGINE: 'http://127.0.0.1:3100',
            TZ: 'Europe/Paris',
        })
        expect(state.spawns[4]!.env.RERUN_API_KEY).toBe('engine-key')
        expect(session.runningDesktops()).toEqual([{ agentId: 'a1', viewers: 0, dock: true, ...up }])
    })

    it('stays up when the wallpaper is painted or the dock dies, and then says it has no dock', async () => {
        state.panels = true
        const session = await freshModule()
        await session.ensureDesktop('a1')
        ;(state.children[0] as FakeChild).emit('exit', 0)
        ;(state.children[3] as FakeChild).emit('exit', 1)
        await vi.advanceTimersByTimeAsync(0)
        expect(session.runningDesktops()).toEqual([{ agentId: 'a1', viewers: 0, dock: false, ...up }])
        expect(killed()).toEqual([false, false, false, false, false])
        await session.stopDesktop('a1')
        expect(killed()).toEqual([false, true, true, true, true])
    })

    it('counts the viewers of one screen', async () => {
        const session = await freshModule()
        session.viewerJoined('a1')
        expect(session.viewersOf('a1')).toBe(1)
        expect(session.viewersOf('a2')).toBe(0)
    })

    it('starts again after a stop', async () => {
        const session = await freshModule()
        await session.ensureDesktop('a1')
        await session.stopDesktop('a1')
        await session.ensureDesktop('a1')
        expect(state.spawns.map(s => s.command)).toEqual(['openbox', 'x11vnc', 'openbox', 'x11vnc'])
    })

    it('fails, cleans up, and can be retried, when the VNC server never answers', async () => {
        state.vncUp = false
        const session = await freshModule()
        const attempt = session.ensureDesktop('a1')
        const settled = expect(attempt).rejects.toThrow('did not start')
        await vi.advanceTimersByTimeAsync(6_000)
        await settled
        expect(killed()).toEqual([true, true])
        expect(state.displayHolds).toBe(0)
        state.vncUp = true
        expect(await session.ensureDesktop('a1')).toEqual({ display: ':42', vncPort: 5942 })
    })

    it('kills a VNC server that ignores the stop, and spares one that exits in time', async () => {
        const session = await freshModule()
        await session.ensureDesktop('a1')
        const [windowManager, vnc] = state.children as FakeChild[]
        await session.stopDesktop('a1')
        windowManager!.emit('exit', 0)
        await vi.advanceTimersByTimeAsync(1_999)
        expect(vnc!.signals).toEqual(['SIGTERM'])
        await vi.advanceTimersByTimeAsync(1)
        expect(vnc!.signals).toEqual(['SIGTERM', 'SIGKILL'])
        expect(windowManager!.signals).toEqual(['SIGTERM'])
    })

    it('refuses to start on a port another VNC server already holds, holds no display, and starts once it is free', async () => {
        state.portTaken = true
        const session = await freshModule()
        const attempt = session.ensureDesktop('a1')
        const settled = expect(attempt).rejects.toThrow('did not start')
        await vi.advanceTimersByTimeAsync(3_000)
        await settled
        expect(state.spawns).toEqual([])
        expect(state.displayHolds).toBe(0)
        state.portTaken = false
        expect(await session.ensureDesktop('a1')).toEqual({ display: ':42', vncPort: 5942 })
    })

    it('starts again right after a stop, once the old VNC server has left the port', async () => {
        state.vncLingerMs = 1_000
        const session = await freshModule()
        await session.ensureDesktop('a1')
        await session.stopDesktop('a1')
        const restart = session.ensureDesktop('a1')
        await vi.advanceTimersByTimeAsync(1_000)
        expect(await restart).toEqual({ display: ':42', vncPort: 5942 })
        expect(state.spawns.map(s => s.command)).toEqual(['openbox', 'x11vnc', 'openbox', 'x11vnc'])
        expect(state.displayHolds).toBe(1)
    })

    it('gives up on a restart when the old VNC server outlives the kill grace', async () => {
        state.vncLingerMs = 10_000
        const session = await freshModule()
        await session.ensureDesktop('a1')
        await session.stopDesktop('a1')
        const restart = session.ensureDesktop('a1')
        const settled = expect(restart).rejects.toThrow('did not start')
        await vi.advanceTimersByTimeAsync(3_000)
        await settled
        expect(state.spawns.map(s => s.command)).toEqual(['openbox', 'x11vnc'])
        expect(state.displayHolds).toBe(0)
    })

    it('refuses a screen past the box cap with a 503 that names the setting, and starts it once one stops', async () => {
        vi.stubEnv('RERUN_DESKTOP_MAX_SCREENS', '1')
        const session = await freshModule()
        await session.ensureDesktop('a1')
        await expect(session.ensureDesktop('a2')).rejects.toMatchObject({ status: 503, message: expect.stringContaining('RERUN_DESKTOP_MAX_SCREENS=1') })
        expect(await session.ensureDesktop('a1')).toEqual({ display: ':42', vncPort: 5942 })
        await session.stopDesktop('a1')
        expect(await session.ensureDesktop('a2')).toEqual({ display: ':43', vncPort: 5943 })
    })

    it('reports how long each screen has been up', async () => {
        const session = await freshModule()
        const startedAt = Date.now()
        await session.ensureDesktop('a1')
        session.viewerJoined('a1')
        await vi.advanceTimersByTimeAsync(90_000)
        expect(session.runningDesktops()).toEqual([{ agentId: 'a1', viewers: 1, dock: false, startedAt: new Date(startedAt).toISOString(), uptimeSeconds: 90 }])
    })

    it('stops an unwatched screen after the idle minutes the box is configured with', async () => {
        vi.stubEnv('RERUN_DESKTOP_IDLE_STOP_MINUTES', '1')
        const session = await freshModule()
        await session.ensureDesktop('a1')
        await vi.advanceTimersByTimeAsync(59_000)
        expect(killed()).toEqual([false, false])
        await vi.advanceTimersByTimeAsync(1_000)
        expect(killed()).toEqual([true, true])
    })

    it('closes an app opened on a screen that stopped meanwhile', async () => {
        const session = await freshModule()
        const app = fakeChild()
        session.trackDesktopChild('a1', app as never)
        expect(app.killed).toBe(true)
    })

    it('reaps with SIGKILL on engine exit a screen process still in the grace of its own stop', async () => {
        const session = await freshModule()
        const { reapLiveChildren } = await import('../lib/child-reaper.js')
        await session.ensureDesktop('a1')
        const app = fakeChild()
        session.trackDesktopChild('a1', app as never)
        await vi.advanceTimersByTimeAsync(0)
        await session.stopDesktop('a1')
        const [openbox, x11vnc] = state.children as FakeChild[]
        expect(x11vnc!.signals).toEqual(['SIGTERM'])
        reapLiveChildren()
        for (const child of [openbox!, x11vnc!, app]) expect(child.signals.at(-1)).toBe('SIGKILL')
    })
})
