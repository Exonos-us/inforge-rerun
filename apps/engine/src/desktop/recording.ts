import { spawn, type ChildProcess } from 'node:child_process'
import type { Dirent } from 'node:fs'
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { workspaceDir } from '../config/paths.js'
import { logger } from '../lib/logger.js'
import { newId } from '../lib/ids.js'
import { controlScreen } from './control.js'
import { onPath } from './session.js'

// The evidence of what happened on an agent's screen, in the workspace the user already browses:
// one folder per screen session, holding the action screenshots and an MP4 of the whole session.
export const SCREEN_DIR = 'screen'
export const RECORDING_FILE = 'recording.mp4'
export const RECORDING_BINARY = 'ffmpeg'
const RECORDING_FRAMERATE = 6
const RECORDING_WIDTH = 1280
// One keyframe every 2 s: with frag_keyframe that is the fragment cadence, so a recording killed
// mid-write loses at most the last two seconds.
const KEYFRAME_EVERY_FRAMES = String(2 * RECORDING_FRAMERATE)
// ffmpeg finalizes on SIGINT; one that wedges mid-write is killed, and the fragmented MP4 it leaves
// behind still plays.
const STOP_GRACE_MS = 2_000
const MAX_RECORDING_MS = 15 * 60_000
const KEPT_SESSIONS = 20

type ScreenSession = {
    id: string
    holds: number
    frames: number
    dirReady: Promise<string> | null
    recorder: Promise<ChildProcess | null> | null
    // Stays true once a recording ran: a holder joining after the 15 min cap must not start a
    // second ffmpeg that would overwrite the finalized file.
    recorded: boolean
    capTimer: NodeJS.Timeout | null
}

export type ScreenSessionHold = { id: string; saveFrame: (image: Buffer) => Promise<void>; release: () => void }

export type ScreenSessionInfo = { id: string; startedAt: string; endedAt: string | null; frames: number; recording: boolean }

const sessions = new Map<string, ScreenSession>()
// Read synchronously by the exit hook, where nothing can be awaited.
const liveRecorders = new Set<ChildProcess>()
let exitHooked = false

export const recordingAvailable = (): boolean => onPath(RECORDING_BINARY)

// Sortable and parseable back into a start time, so the listing needs no database.
function sessionStamp(now = new Date()): string {
    return `${now.toISOString().slice(0, 19).replace(/:/g, '-')}-${newId().slice(0, 4)}`
}

export function sessionStartedAt(id: string): string | null {
    const match = /^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-/.exec(id)
    if (!match) return null
    const iso = `${match[1]}:${match[2]}:${match[3]}.000Z`
    return Number.isNaN(Date.parse(iso)) ? null : iso
}

const screenRoot = (agentId: string): string => resolve(workspaceDir(agentId), SCREEN_DIR)

function sessionDir(agentId: string, session: ScreenSession): Promise<string> {
    session.dirReady ??= (async () => {
        const dir = resolve(screenRoot(agentId), session.id)
        await mkdir(dir, { recursive: true })
        return dir
    })()
    return session.dirReady
}

function killRecordersOnExit(): void {
    if (exitHooked) return
    exitHooked = true
    process.once('exit', () => liveRecorders.forEach(child => child.kill('SIGKILL')))
}

async function launchRecorder(agentId: string, session: ScreenSession): Promise<ChildProcess | null> {
    try {
        const control = await controlScreen(agentId)
        const dir = await sessionDir(agentId, session)
        // Fragmented MP4, every fragment flushed to disk as it closes: a recorder that dies without
        // finalizing (SIGKILL, a crash, the box going down) still leaves a playable file. faststart
        // is deliberately absent: it needs a rewrite pass at the end and disables fragmentation,
        // and empty_moov already puts the moov at the front. Verified on a real Xvfb display.
        const args = [
            '-y',
            '-loglevel', 'error',
            '-f', 'x11grab',
            '-framerate', String(RECORDING_FRAMERATE),
            '-video_size', `${control.width}x${control.height}`,
            '-i', String(control.env.DISPLAY),
            '-vf', `scale=${RECORDING_WIDTH}:-2`,
            '-c:v', 'libx264',
            '-preset', 'ultrafast',
            '-g', KEYFRAME_EVERY_FRAMES,
            '-keyint_min', KEYFRAME_EVERY_FRAMES,
            '-pix_fmt', 'yuv420p',
            '-movflags', '+frag_keyframe+empty_moov',
            '-flush_packets', '1',
            resolve(dir, RECORDING_FILE),
        ]
        const child = spawn(RECORDING_BINARY, args, { stdio: 'ignore', env: control.env })
        child.once('error', err => logger.warn({ err: String(err), agentId }, 'screen recording failed'))
        child.once('exit', () => liveRecorders.delete(child))
        liveRecorders.add(child)
        killRecordersOnExit()
        session.capTimer = setTimeout(() => void stopRecorder(session), MAX_RECORDING_MS)
        session.capTimer.unref()
        return child
    } catch (err) {
        logger.warn({ err: String(err), agentId }, 'screen recording did not start')
        return null
    }
}

const hasExited = (child: ChildProcess): boolean => child.exitCode !== null || child.signalCode !== null

async function stopRecorder(session: ScreenSession): Promise<void> {
    const claimed = session.recorder
    session.recorder = null
    if (session.capTimer) clearTimeout(session.capTimer)
    session.capTimer = null
    const child = await claimed?.catch(() => null)
    if (!child || hasExited(child)) return
    const exited = new Promise<void>(done => child.once('exit', () => done()))
    child.kill('SIGINT')
    const forceKill = setTimeout(() => child.kill('SIGKILL'), STOP_GRACE_MS)
    forceKill.unref()
    await exited
    clearTimeout(forceKill)
}

// Sortable stamps: the newest names sort last.
async function pruneSessions(agentId: string): Promise<void> {
    const root = screenRoot(agentId)
    const entries = await readdir(root, { withFileTypes: true }).catch((): Dirent[] => [])
    const live = sessions.get(agentId)?.id
    const stale = entries
        .filter(entry => entry.isDirectory() && entry.name !== live)
        .map(entry => entry.name)
        .sort()
        .reverse()
        .slice(live ? KEPT_SESSIONS - 1 : KEPT_SESSIONS)
    await Promise.all(stale.map(name => rm(resolve(root, name), { recursive: true, force: true }).catch(() => {})))
}

async function writeFrame(agentId: string, session: ScreenSession, frame: number, image: Buffer): Promise<void> {
    try {
        const dir = await sessionDir(agentId, session)
        await writeFile(resolve(dir, `${String(frame).padStart(3, '0')}.jpg`), image)
    } catch (err) {
        logger.warn({ err: String(err), agentId }, 'screen frame not kept')
    }
}

// Refcounted like holdDesktop: a run claiming the screen and a takeover in the middle of it share
// one session, so the folder tells the whole story. The recording starts with the first holder that
// wants one and stops when the last holder lets go.
export function holdScreenSession(agentId: string, { record = true } = {}): ScreenSessionHold {
    let session = sessions.get(agentId)
    if (!session) {
        session = { id: sessionStamp(), holds: 0, frames: 0, dirReady: null, recorder: null, recorded: false, capTimer: null }
        sessions.set(agentId, session)
    }
    session.holds++
    if (record && !session.recorded && recordingAvailable()) {
        session.recorded = true
        session.recorder = launchRecorder(agentId, session)
    }
    const held = session
    let released = false
    return {
        id: held.id,
        saveFrame: image => writeFrame(agentId, held, ++held.frames, image),
        release: () => {
            if (released) return
            released = true
            held.holds = Math.max(0, held.holds - 1)
            if (held.holds > 0) return
            if (sessions.get(agentId) === held) sessions.delete(agentId)
            void stopRecorder(held)
                .then(() => pruneSessions(agentId))
                .catch(err => logger.warn({ err: String(err), agentId }, 'screen session cleanup failed'))
        },
    }
}

export const activeScreenSession = (agentId: string): string | null => sessions.get(agentId)?.id ?? null

async function endedAtOf(dir: string, files: string[]): Promise<string | null> {
    const stats = await Promise.all([dir, ...files.map(file => resolve(dir, file))].map(path => stat(path).catch(() => null)))
    const newest = Math.max(...stats.map(entry => entry?.mtimeMs ?? 0))
    return newest > 0 ? new Date(newest).toISOString() : null
}

// Derived from the filesystem alone, so an archived workspace restored weeks later still lists its
// sessions. The one still being written has no end yet.
export async function listScreenSessions(agentId: string): Promise<ScreenSessionInfo[]> {
    const root = screenRoot(agentId)
    const entries = await readdir(root, { withFileTypes: true }).catch((): Dirent[] => [])
    const live = activeScreenSession(agentId)
    const list = await Promise.all(
        entries
            .filter(entry => entry.isDirectory())
            .map(async entry => {
                const dir = resolve(root, entry.name)
                const files = await readdir(dir).catch((): string[] => [])
                return {
                    id: entry.name,
                    startedAt: sessionStartedAt(entry.name) ?? (await stat(dir).then(s => s.birthtime.toISOString()).catch(() => new Date(0).toISOString())),
                    endedAt: entry.name === live ? null : await endedAtOf(dir, files),
                    frames: files.filter(file => file.endsWith('.jpg')).length,
                    recording: files.includes(RECORDING_FILE),
                }
            })
    )
    return list.sort((a, b) => b.id.localeCompare(a.id))
}
