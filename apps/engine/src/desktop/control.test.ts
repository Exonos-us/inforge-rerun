import { vi } from 'vitest'

type Call = { command: string; args: string[]; input?: string; display?: string; signalled: boolean }

const state = vi.hoisted(() => ({
    calls: [] as Call[],
    geometry: '1920 1080\n',
    pointerWindow: '4194305',
    windowName: 'Chromium',
    windowNameFails: false,
    failing: null as string | null,
    png: Buffer.alloc(0),
}))

vi.mock('node:child_process', () => ({
    execFile: (command: string, args: string[], options: { env: Record<string, string>; signal?: AbortSignal }, done: (err: Error | null, stdout: Buffer) => void) => {
        const call: Call = { command, args, display: options.env.DISPLAY, signalled: !!options.signal }
        state.calls.push(call)
        const answer = () => {
            if (command === 'maim') return done(null, state.png)
            if (state.failing === args[0]) return done(new Error(`${args[0]} failed`), Buffer.alloc(0))
            if (args[0] === 'getdisplaygeometry') return done(null, Buffer.from(state.geometry))
            if (args[0] === 'getmouselocation') return done(null, Buffer.from(`X=10\nY=20\nSCREEN=0\n${state.pointerWindow ? `WINDOW=${state.pointerWindow}\n` : ''}`))
            if (args[0] === 'getwindowname') return state.windowNameFails ? done(new Error('no name'), Buffer.alloc(0)) : done(null, Buffer.from(`${state.windowName}\n`))
            done(null, Buffer.alloc(0))
        }
        queueMicrotask(answer)
        return {
            stdin: {
                end: (input: string) => {
                    call.input = input
                },
            },
        }
    },
}))

vi.mock('./session.js', () => ({
    SCREEN_CAPTURE_BINARY: 'maim',
    ensureDesktop: async () => ({ display: ':42', vncPort: 5942 }),
    desktopEnv: (display: string) => ({ DISPLAY: display }),
}))

const { beforeAll, beforeEach, describe, expect, it } = await import('vitest')
const { default: sharp } = await import('sharp')
const { ControlRefusal, captureScreen, click, controlScreen, drag, holdKey, keyCombos, mouseDown, mouseUp, movePointer, pressKeys, scroll, typeText, zoomedControl } = await import('./control.js')

const xdotoolCalls = () => state.calls.filter(call => call.command === 'xdotool').map(call => call.args.join(' '))
const acted = () => xdotoolCalls().filter(line => !line.startsWith('getdisplaygeometry'))

beforeAll(async () => {
    state.png = await sharp({ create: { width: 1920, height: 1080, channels: 3, background: '#224466' } })
        .png()
        .toBuffer()
})

beforeEach(() => {
    state.calls.length = 0
    state.geometry = '1920 1080\n'
    state.pointerWindow = '4194305'
    state.windowName = 'Chromium'
    state.windowNameFails = false
    state.failing = null
})

describe('controlScreen', () => {
    it('reads the size of the agent screen and how far the picture it sends is scaled down', async () => {
        const control = await controlScreen('a1')
        expect(control).toMatchObject({ width: 1920, height: 1080, scale: 1.5, env: { DISPLAY: ':42' } })
    })

    it('never scales a small screen up', async () => {
        state.geometry = '1024 600\n'
        expect((await controlScreen('a1')).scale).toBe(1)
    })

    it('follows the tighter side of a screen that is not 16:9', async () => {
        state.geometry = '1280 1440\n'
        expect((await controlScreen('a1')).scale).toBe(2)
    })

    it('gives up on a screen that does not say how big it is', async () => {
        state.geometry = '\n'
        await expect(controlScreen('a1')).rejects.toThrow('did not report its size')
    })
})

describe('captureScreen', () => {
    it('sends back a JPEG of the screen at the size the agent points in', async () => {
        const control = await controlScreen('a1')
        const shot = await captureScreen(control)
        expect(state.calls.at(-1)).toMatchObject({ command: 'maim', display: ':42' })
        expect(shot).toMatchObject({ mediaType: 'image/jpeg', width: 1280, height: 720 })
        expect(await sharp(shot.image).metadata()).toMatchObject({ format: 'jpeg', width: 1280, height: 720 })
    })
})

describe('pointer', () => {
    it('moves to where the agent pointed, scaled back to the real screen', async () => {
        await movePointer(await controlScreen('a1'), [100, 200])
        expect(acted()).toEqual(['mousemove --sync 150 300'])
    })

    it('keeps a point outside the picture on the screen', async () => {
        await movePointer(await controlScreen('a1'), [-5, 5000])
        expect(acted()).toEqual(['mousemove --sync 0 1079'])
    })

    it('clicks with the left button once it knows what is under the pointer', async () => {
        await click(await controlScreen('a1'), [10, 10])
        expect(acted()).toEqual(['mousemove --sync 15 15', 'getmouselocation --shell', 'getwindowname 4194305', 'click 1'])
    })

    it('right-clicks, double-clicks and triple-clicks', async () => {
        const control = await controlScreen('a1')
        await click(control, [10, 10], { button: 'right' })
        await click(control, [10, 10], { clicks: 2 })
        await click(control, [10, 10], { clicks: 3 })
        await click(control, [10, 10], { button: 'middle' })
        expect(acted().filter(line => line.startsWith('click'))).toEqual(['click 3', 'click --repeat 2 --delay 80 1', 'click --repeat 3 --delay 80 1', 'click 2'])
    })

    it.each(['rerun-dock', 'rerun-bar'])('refuses to click the %s, which belongs to the person', async name => {
        state.windowName = name
        await expect(click(await controlScreen('a1'), [640, 700])).rejects.toBeInstanceOf(ControlRefusal)
        expect(acted().some(line => line.startsWith('click'))).toBe(false)
    })

    it('clicks the bare desktop, and a window that has no name', async () => {
        const control = await controlScreen('a1')
        state.pointerWindow = ''
        await click(control, [10, 10])
        state.pointerWindow = '77'
        state.windowNameFails = true
        await click(control, [10, 10])
        expect(acted().filter(line => line === 'click 1')).toHaveLength(2)
    })

    it('drags with the button held from one point to the other', async () => {
        await drag(await controlScreen('a1'), [10, 10], [110, 60])
        expect(acted()).toEqual(['mousemove --sync 15 15', 'getmouselocation --shell', 'getwindowname 4194305', 'mousedown 1', 'mousemove --sync 165 90', 'mouseup 1'])
    })

    it('lets go of the button when a drag breaks halfway, without waiting on the run that was stopped', async () => {
        const control = await controlScreen('a1', new AbortController().signal)
        state.failing = 'mousedown'
        await expect(drag(control, [10, 10], [110, 60])).rejects.toThrow('mousedown failed')
        const release = state.calls.at(-1)!
        expect(release.args).toEqual(['mouseup', '1'])
        expect(release.signalled).toBe(false)
        expect(state.calls.find(call => call.args[0] === 'mousedown')!.signalled).toBe(true)
    })

    it('scrolls by notches in each direction', async () => {
        const control = await controlScreen('a1')
        await scroll(control, [10, 10], 'down', 3)
        await scroll(control, [10, 10], 'up', 1)
        await scroll(control, [10, 10], 'left', 2)
        await scroll(control, [10, 10], 'right', 2)
        expect(acted().filter(line => line.startsWith('click'))).toEqual(['click --repeat 3 5', 'click --repeat 1 4', 'click --repeat 2 6', 'click --repeat 2 7'])
    })
})

describe('keyboard', () => {
    it('types through stdin, so a word that names an xdotool command is only ever text', async () => {
        await typeText(await controlScreen('a1'), 'exec rm -rf /')
        const typed = state.calls.at(-1)!
        expect(typed.args).toEqual(['type', '--delay', '12', '--file', '-'])
        expect(typed.input).toBe('exec rm -rf /')
    })

    it('presses each combo in a call of its own, under the names xdotool knows', async () => {
        await pressKeys(await controlScreen('a1'), 'ctrl+a Enter cmd+shift+T F5 Page_Down')
        expect(acted()).toEqual(['key -- ctrl+a', 'key -- Return', 'key -- super+shift+T', 'key -- F5', 'key -- Page_Down'])
    })

    it('refuses what is not a key before pressing anything', async () => {
        const control = await controlScreen('a1')
        await expect(pressKeys(control, 'ctrl+a --window')).rejects.toBeInstanceOf(ControlRefusal)
        await expect(pressKeys(control, '   ')).rejects.toBeInstanceOf(ControlRefusal)
        expect(acted()).toEqual([])
        expect(() => keyCombos('a;b')).toThrow(ControlRefusal)
    })

    it('releases a combo whose press broke, so no modifier stays down', async () => {
        const control = await controlScreen('a1')
        state.failing = 'key'
        await expect(pressKeys(control, 'ctrl+c')).rejects.toThrow('key failed')
        expect(acted()).toEqual(['key -- ctrl+c', 'keyup -- ctrl+c'])
    })

    it('holds one key down for the duration, and always lets go of it', async () => {
        const control = await controlScreen('a1')
        await holdKey(control, 'alt', 0)
        expect(acted()).toEqual(['keydown -- alt', 'keyup -- alt'])
        expect(state.calls.at(-1)!.signalled).toBe(false)
        await expect(holdKey(control, 'a b', 0)).rejects.toBeInstanceOf(ControlRefusal)
        state.failing = 'keydown'
        await expect(holdKey(control, 'ctrl', 0)).rejects.toThrow('keydown failed')
        expect(acted().at(-1)).toBe('keyup -- ctrl')
    })
})

describe('mouse button held', () => {
    it('presses the left button where the agent pointed and releases it where asked', async () => {
        const control = await controlScreen('a1')
        await mouseDown(control, [10, 10])
        await mouseUp(control, [20, 20])
        expect(acted()).toEqual(['mousemove --sync 15 15', 'getmouselocation --shell', 'getwindowname 4194305', 'mousedown 1', 'mousemove --sync 30 30', 'mouseup 1'])
    })

    it('releases in place, without the run signal, so a stopped run never leaves the button down', async () => {
        const control = await controlScreen('a1', new AbortController().signal)
        await mouseUp(control)
        const release = state.calls.at(-1)!
        expect(release.args).toEqual(['mouseup', '1'])
        expect(release.signalled).toBe(false)
    })
})

describe('zoomedControl', () => {
    it('maps a region of the view to screen pixels and shows it at native resolution', async () => {
        const zoomed = zoomedControl(await controlScreen('a1'), [100, 100, 640, 360])
        expect(zoomed.view).toEqual({ x: 150, y: 150, width: 960, height: 540 })
        expect(zoomed.scale).toBe(1)
    })

    it('lands a click after a zoom on the right screen pixel', async () => {
        const zoomed = zoomedControl(await controlScreen('a1'), [100, 100, 640, 360])
        await movePointer(zoomed, [10, 20])
        expect(acted()).toEqual(['mousemove --sync 160 170'])
    })

    it('keeps a click inside the zoomed region, never on the rest of the screen', async () => {
        const zoomed = zoomedControl(await controlScreen('a1'), [100, 100, 640, 360])
        await movePointer(zoomed, [-5, 5000])
        expect(acted()).toEqual(['mousemove --sync 150 689'])
    })

    it('captures just the region, magnified against the shrunk full screen', async () => {
        const zoomed = zoomedControl(await controlScreen('a1'), [0, 0, 320, 180])
        expect(zoomed.view).toEqual({ x: 0, y: 0, width: 480, height: 270 })
        const shot = await captureScreen(zoomed)
        expect(state.calls.at(-1)).toMatchObject({ command: 'maim', args: ['--format', 'png', '--geometry', '480x270+0+0'] })
        expect(shot).toMatchObject({ width: 480, height: 270 })
        expect(await sharp(shot.image).metadata()).toMatchObject({ width: 480, height: 270 })
    })

    it('still caps a huge region at the size the agent points in', async () => {
        const zoomed = zoomedControl(await controlScreen('a1'), [0, 0, 1280, 720])
        expect(zoomed).toMatchObject({ view: { x: 0, y: 0, width: 1920, height: 1080 }, scale: 1.5 })
        const shot = await captureScreen(zoomed)
        expect(state.calls.at(-1)!.args).toEqual(['--format', 'png'])
        expect(shot).toMatchObject({ width: 1280, height: 720 })
    })

    it('clips a region that runs over the edge of the screen', async () => {
        const zoomed = zoomedControl(await controlScreen('a1'), [1200, 650, 200, 200])
        expect(zoomed.view).toEqual({ x: 1800, y: 975, width: 120, height: 105 })
        expect(zoomed.scale).toBe(1)
    })

    it('zooms inside a zoom, the region read in the zoomed view', async () => {
        const first = zoomedControl(await controlScreen('a1'), [100, 100, 640, 360])
        const second = zoomedControl(first, [10, 10, 100, 100])
        expect(second.view).toEqual({ x: 160, y: 160, width: 100, height: 100 })
    })

    it('refuses an empty region and one that falls outside the screen', async () => {
        const control = await controlScreen('a1')
        expect(() => zoomedControl(control, [10, 10, 0, 50])).toThrow(ControlRefusal)
        expect(() => zoomedControl(control, [10, 10, 50, -5])).toThrow(ControlRefusal)
        expect(() => zoomedControl(control, [-200, 0, 100, 100])).toThrow(ControlRefusal)
    })
})
