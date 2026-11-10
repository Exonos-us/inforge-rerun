import { execFile } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { BAR_WINDOW_NAME, DOCK_WINDOW_NAME } from './panels.js'
import { SCREEN_CAPTURE_BINARY, desktopEnv, ensureDesktop } from './session.js'

// Past this size a model scales the picture down itself and its coordinates stop matching ours.
const VIEW_MAX_WIDTH = 1280
const VIEW_MAX_HEIGHT = 720
const JPEG_QUALITY = 75
const CAPTURE_MAX_BYTES = 64 * 1024 * 1024
const TYPE_DELAY_MS = '12'
const DOUBLE_CLICK_DELAY_MS = '80'
const PANEL_WINDOW_NAMES = new Set([DOCK_WINDOW_NAME, BAR_WINDOW_NAME])
const BUTTONS = { left: '1', middle: '2', right: '3' } as const
const SCROLL_BUTTONS = { up: '4', down: '5', left: '6', right: '7' } as const
const KEY_COMBO = /^[A-Za-z0-9_]+(\+[A-Za-z0-9_]+)*$/
const FUNCTION_KEY = /^f\d{1,2}$/
const KEY_ALIASES: Record<string, string> = {
    enter: 'Return',
    return: 'Return',
    esc: 'Escape',
    escape: 'Escape',
    backspace: 'BackSpace',
    delete: 'Delete',
    del: 'Delete',
    tab: 'Tab',
    space: 'space',
    up: 'Up',
    down: 'Down',
    left: 'Left',
    right: 'Right',
    arrowup: 'Up',
    arrowdown: 'Down',
    arrowleft: 'Left',
    arrowright: 'Right',
    pageup: 'Page_Up',
    page_up: 'Page_Up',
    pagedown: 'Page_Down',
    page_down: 'Page_Down',
    home: 'Home',
    end: 'End',
    insert: 'Insert',
    ctrl: 'ctrl',
    control: 'ctrl',
    alt: 'alt',
    option: 'alt',
    shift: 'shift',
    super: 'super',
    cmd: 'super',
    command: 'super',
    meta: 'super',
    win: 'super',
}

export type ViewPoint = readonly [number, number]
export type ViewRegion = readonly [number, number, number, number]
export type MouseButton = keyof typeof BUTTONS
export type ScrollDirection = keyof typeof SCROLL_BUTTONS
export type Screenshot = { image: Buffer; mediaType: 'image/jpeg'; width: number; height: number }

// The part of the screen the latest screenshot showed, in screen pixels.
export type ViewRect = { x: number; y: number; width: number; height: number }

// The agent points at what it saw, which is the capture, not the screen: `view` names the screen
// region that capture showed and `scale` how far it was shrunk, together the way back.
export type ScreenControl = { env: NodeJS.ProcessEnv; width: number; height: number; view: ViewRect; scale: number; signal?: AbortSignal }

// Something the agent may not do on its screen, as opposed to something that broke.
export class ControlRefusal extends Error {}

type RunOptions = { signal?: AbortSignal; input?: string }

function run(command: string, args: string[], env: NodeJS.ProcessEnv, { signal, input }: RunOptions = {}): Promise<Buffer> {
    return new Promise((done, failed) => {
        const child = execFile(command, args, { env, signal, encoding: 'buffer', maxBuffer: CAPTURE_MAX_BYTES }, (err, stdout) => (err ? failed(err) : done(stdout)))
        if (input !== undefined) child.stdin?.end(input)
    })
}

const xdotool = (control: ScreenControl, args: string[], options: RunOptions = {}): Promise<Buffer> => run('xdotool', args, control.env, { signal: control.signal, ...options })

const viewScale = (width: number, height: number): number => Math.max(1, width / VIEW_MAX_WIDTH, height / VIEW_MAX_HEIGHT)

export async function controlScreen(agentId: string, signal?: AbortSignal): Promise<ScreenControl> {
    const { display } = await ensureDesktop(agentId)
    const env = desktopEnv(display)
    const [width = 0, height = 0] = (await run('xdotool', ['getdisplaygeometry'], env, { signal })).toString().trim().split(/\s+/).map(Number)
    if (!width || !height) throw new Error('The screen did not report its size.')
    return { env, width, height, view: { x: 0, y: 0, width, height }, scale: viewScale(width, height), signal }
}

// The region is in pixels of the current view, like every coordinate. The zoomed view is captured
// at native resolution up to the same box a full screenshot fits in, so a small region comes back
// magnified compared to the shrunk full-screen picture.
export function zoomedControl(control: ScreenControl, [x, y, width, height]: ViewRegion): ScreenControl {
    if (!(width > 0) || !(height > 0)) throw new ControlRefusal('zoom needs a region with a positive width and height.')
    const left = Math.max(0, Math.min(control.width - 1, Math.round(control.view.x + x * control.scale)))
    const top = Math.max(0, Math.min(control.height - 1, Math.round(control.view.y + y * control.scale)))
    const right = Math.min(control.width, Math.round(control.view.x + (x + width) * control.scale))
    const bottom = Math.min(control.height, Math.round(control.view.y + (y + height) * control.scale))
    if (right - left < 1 || bottom - top < 1) throw new ControlRefusal('That zoom region falls outside the screen.')
    const view = { x: left, y: top, width: right - left, height: bottom - top }
    return { ...control, view, scale: viewScale(view.width, view.height) }
}

const fullScreenView = (control: ScreenControl): boolean => control.view.x === 0 && control.view.y === 0 && control.view.width === control.width && control.view.height === control.height

export async function captureScreen(control: ScreenControl): Promise<Screenshot> {
    const { view } = control
    const geometry = fullScreenView(control) ? [] : ['--geometry', `${view.width}x${view.height}+${view.x}+${view.y}`]
    const png = await run(SCREEN_CAPTURE_BINARY, ['--format', 'png', ...geometry], control.env, { signal: control.signal })
    const { default: sharp } = await import('sharp')
    const width = Math.round(view.width / control.scale)
    const height = Math.round(view.height / control.scale)
    const image = await sharp(png).resize(width, height, { fit: 'fill' }).jpeg({ quality: JPEG_QUALITY }).toBuffer()
    return { image, mediaType: 'image/jpeg', width, height }
}

function onScreen(control: ScreenControl, [x, y]: ViewPoint): [string, string] {
    const clamp = (value: number, offset: number, size: number) => String(Math.min(offset + size - 1, Math.max(offset, offset + Math.round(value * control.scale))))
    return [clamp(x, control.view.x, control.view.width), clamp(y, control.view.y, control.view.height)]
}

// The dock opens the terminal and the files whatever the agent's own switches say, so it is the
// person's to click.
async function refusePanel(control: ScreenControl): Promise<void> {
    const location = (await xdotool(control, ['getmouselocation', '--shell'])).toString()
    const window = /^WINDOW=(\d+)$/m.exec(location)?.[1]
    if (!window) return
    const name = await xdotool(control, ['getwindowname', window]).then(
        out => out.toString().trim(),
        () => '',
    )
    if (PANEL_WINDOW_NAMES.has(name)) throw new ControlRefusal('The dock and the top bar are not yours to click. Open an app with computer_open_app instead.')
}

export async function movePointer(control: ScreenControl, point: ViewPoint): Promise<void> {
    await xdotool(control, ['mousemove', '--sync', ...onScreen(control, point)])
}

export async function click(control: ScreenControl, point: ViewPoint, { button = 'left', clicks = 1 }: { button?: MouseButton; clicks?: number } = {}): Promise<void> {
    await movePointer(control, point)
    await refusePanel(control)
    await xdotool(control, ['click', ...(clicks > 1 ? ['--repeat', String(clicks), '--delay', DOUBLE_CLICK_DELAY_MS] : []), BUTTONS[button]])
}

export async function mouseDown(control: ScreenControl, point: ViewPoint): Promise<void> {
    await movePointer(control, point)
    await refusePanel(control)
    await xdotool(control, ['mousedown', BUTTONS.left])
}

export async function mouseUp(control: ScreenControl, point?: ViewPoint): Promise<void> {
    if (point) await movePointer(control, point)
    // Without the run's signal: a stop between a mouse_down and its mouse_up must still let go.
    await run('xdotool', ['mouseup', BUTTONS.left], control.env)
}

export async function drag(control: ScreenControl, from: ViewPoint, to: ViewPoint): Promise<void> {
    await movePointer(control, from)
    await refusePanel(control)
    try {
        await xdotool(control, ['mousedown', BUTTONS.left])
        await movePointer(control, to)
    } finally {
        // Without the run's signal: a stop in the middle of a drag must still let go of the button.
        await run('xdotool', ['mouseup', BUTTONS.left], control.env).catch(() => {})
    }
}

export async function scroll(control: ScreenControl, point: ViewPoint, direction: ScrollDirection, amount: number): Promise<void> {
    await movePointer(control, point)
    await refusePanel(control)
    await xdotool(control, ['click', '--repeat', String(amount), SCROLL_BUTTONS[direction]])
}

// Through stdin: an argument that happens to be the name of an xdotool command would be run as one.
export async function typeText(control: ScreenControl, text: string): Promise<void> {
    await xdotool(control, ['type', '--delay', TYPE_DELAY_MS, '--file', '-'], { input: text })
}

function keyName(part: string): string {
    const lower = part.toLowerCase()
    if (FUNCTION_KEY.test(lower)) return lower.toUpperCase()
    return KEY_ALIASES[lower] ?? part
}

export function keyCombos(keys: string): string[] {
    const combos = keys.trim().split(/\s+/).filter(Boolean)
    if (combos.length === 0) throw new ControlRefusal('Name the key to press, for example "Return" or "ctrl+a".')
    return combos.map(combo => {
        if (!KEY_COMBO.test(combo)) throw new ControlRefusal(`"${combo}" is not a key. Name keys like "Return", "Escape", "ctrl+a" or "shift+Tab".`)
        return combo.split('+').map(keyName).join('+')
    })
}

// One combo per call, for the same reason the text goes through stdin.
export async function pressKeys(control: ScreenControl, keys: string): Promise<void> {
    for (const combo of keyCombos(keys)) {
        try {
            await xdotool(control, ['key', '--', combo])
        } catch (err) {
            await run('xdotool', ['keyup', '--', combo], control.env).catch(() => {})
            throw err
        }
    }
}

export async function holdKey(control: ScreenControl, keys: string, durationSeconds: number): Promise<void> {
    const combos = keyCombos(keys)
    if (combos.length > 1) throw new ControlRefusal('hold_key holds one key or combination at a time.')
    try {
        await xdotool(control, ['keydown', '--', combos[0]])
        await sleep(durationSeconds * 1000, undefined, { signal: control.signal })
    } finally {
        // Without the run's signal: a stop in the middle of a hold must still release the key.
        await run('xdotool', ['keyup', '--', combos[0]], control.env).catch(() => {})
    }
}
