import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { vi } from 'vitest'

type FakeChild = EventEmitter & { signals: string[]; exitCode: number | null; signalCode: string | null; kill: (signal?: string) => void }

const state = vi.hoisted(() => ({
    spawns: [] as Array<{ command: string; args: string[]; env: Record<string, string> }>,
    children: [] as unknown[],
    ffmpeg: true,
    exitOnSigint: true,
    screenBroken: false,
}))

function fakeChild(): FakeChild {
    const child = Object.assign(new EventEmitter(), { signals: [] as string[], exitCode: null, signalCode: null }) as FakeChild
    child.kill = (signal = 'SIGTERM') => {
        child.signals.push(signal)
        if (signal === 'SIGINT' && state.exitOnSigint) {
            queueMicrotask(() => {
                child.exitCode = 0
                child.emit('exit', 0)
            })
        }
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

vi.mock('./session.js', () => ({
    onPath: (binary: string) => binary === 'ffmpeg' && state.ffmpeg,
}))

vi.mock('./control.js', () => ({
    controlScreen: async () => {
        if (state.screenBroken) throw new Error('no screen')
        return { env: { DISPLAY: ':42' }, width: 1920, height: 1080, scale: 1.5 }
    },
}))

vi.mock('../lib/logger.js', () => ({ logger: { info() {}, warn() {} } }))

const { afterEach, beforeEach, describe, expect, it } = await import('vitest')

let dataDir = ''
const workspaceScreenDir = (agentId: string) => join(dataDir, 'agents', agentId, 'workspace', 'screen')

async function freshModule() {
    vi.resetModules()
    return import('./recording.js')
}

const children = () => state.children as FakeChild[]

beforeEach(() => {
    state.spawns.length = 0
    state.children.length = 0
    state.ffmpeg = true
    state.exitOnSigint = true
    state.screenBroken = false
    dataDir = mkdtempSync(join(tmpdir(), 'rerun-recording-'))
    vi.stubEnv('RERUN_DATA_DIR', dataDir)
})

afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
})

describe('screen session recording', () => {
    it('keeps every frame numbered in a session folder of the workspace, and records the screen with ffmpeg', async () => {
        const recording = await freshModule()
        const hold = recording.holdScreenSession('a1')
        await hold.saveFrame(Buffer.from('one'))
        await hold.saveFrame(Buffer.from('two'))
        await vi.waitFor(() => expect(state.spawns).toHaveLength(1))
        expect(state.spawns[0]!.command).toBe('ffmpeg')
        expect(state.spawns[0]!.args).toEqual([
            '-y',
            '-loglevel', 'error',
            '-f', 'x11grab',
            '-framerate', '6',
            '-video_size', '1920x1080',
            '-i', ':42',
            '-vf', 'scale=1280:-2',
            '-c:v', 'libx264',
            '-preset', 'ultrafast',
            '-g', '12',
            '-keyint_min', '12',
            '-pix_fmt', 'yuv420p',
            '-movflags', '+frag_keyframe+empty_moov',
            '-flush_packets', '1',
            resolve(workspaceScreenDir('a1'), hold.id, 'recording.mp4'),
        ])
        expect(state.spawns[0]!.env.DISPLAY).toBe(':42')
        expect(readdirSync(join(workspaceScreenDir('a1'), hold.id)).sort()).toEqual(['001.jpg', '002.jpg'])
        expect(recording.activeScreenSession('a1')).toBe(hold.id)
        hold.release()
        await vi.waitFor(() => expect(children()[0]!.signals).toEqual(['SIGINT']))
        await vi.waitFor(() => expect(recording.activeScreenSession('a1')).toBeNull())
    })

    it('shares one session and one recording between the run and a takeover, until the last holder lets go', async () => {
        const recording = await freshModule()
        const run = recording.holdScreenSession('a1')
        const takeover = recording.holdScreenSession('a1')
        expect(takeover.id).toBe(run.id)
        await vi.waitFor(() => expect(state.spawns).toHaveLength(1))
        run.release()
        run.release()
        expect(children()[0]!.signals).toEqual([])
        takeover.release()
        await vi.waitFor(() => expect(children()[0]!.signals).toEqual(['SIGINT']))
    })

    it('keeps the frames and skips the recording when ffmpeg is missing or the agent switched it off', async () => {
        state.ffmpeg = false
        const recording = await freshModule()
        const hold = recording.holdScreenSession('a1')
        await hold.saveFrame(Buffer.from('one'))
        hold.release()

        state.ffmpeg = true
        const muted = recording.holdScreenSession('a2', { record: false })
        await muted.saveFrame(Buffer.from('one'))
        muted.release()
        expect(state.spawns).toEqual([])
        expect(readdirSync(join(workspaceScreenDir('a1'), hold.id))).toEqual(['001.jpg'])
        expect(readdirSync(join(workspaceScreenDir('a2'), muted.id))).toEqual(['001.jpg'])
    })

    it('still saves frames when the recorder cannot start', async () => {
        state.screenBroken = true
        const recording = await freshModule()
        const hold = recording.holdScreenSession('a1')
        await hold.saveFrame(Buffer.from('one'))
        expect(readdirSync(join(workspaceScreenDir('a1'), hold.id))).toEqual(['001.jpg'])
        hold.release()
        await vi.waitFor(() => expect(recording.activeScreenSession('a1')).toBeNull())
        expect(state.spawns).toEqual([])
    })

    it('kills a recorder that ignores the stop', async () => {
        state.exitOnSigint = false
        const recording = await freshModule()
        const hold = recording.holdScreenSession('a1')
        await vi.waitFor(() => expect(state.spawns).toHaveLength(1))
        vi.useFakeTimers()
        hold.release()
        await vi.advanceTimersByTimeAsync(0)
        expect(children()[0]!.signals).toEqual(['SIGINT'])
        await vi.advanceTimersByTimeAsync(2_000)
        expect(children()[0]!.signals).toEqual(['SIGINT', 'SIGKILL'])
        children()[0]!.emit('exit', 1)
    })

    it('caps a recording at fifteen minutes and never starts a second one over the finalized file', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
        const recording = await freshModule()
        const hold = recording.holdScreenSession('a1')
        await vi.waitFor(() => expect(state.spawns).toHaveLength(1))
        await vi.advanceTimersByTimeAsync(15 * 60_000)
        expect(children()[0]!.signals).toEqual(['SIGINT'])
        vi.useRealTimers()
        const joiner = recording.holdScreenSession('a1')
        expect(joiner.id).toBe(hold.id)
        expect(state.spawns).toHaveLength(1)
        joiner.release()
        hold.release()
    })

    it('records nothing on a box with recording off, whatever the agent asks, and keeps the frames', async () => {
        vi.stubEnv('RERUN_COMPUTER_RECORDING', 'off')
        const recording = await freshModule()
        const hold = recording.holdScreenSession('a1', { record: true })
        await hold.saveFrame(Buffer.from('one'))
        hold.release()
        expect(state.spawns).toEqual([])
        expect(readdirSync(join(workspaceScreenDir('a1'), hold.id))).toEqual(['001.jpg'])
    })

    it('caps a recording at the minutes the box is configured with', async () => {
        vi.stubEnv('RERUN_COMPUTER_RECORDING_MAX_MINUTES', '2')
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
        const recording = await freshModule()
        const hold = recording.holdScreenSession('a1')
        await vi.waitFor(() => expect(state.spawns).toHaveLength(1))
        await vi.advanceTimersByTimeAsync(60_000)
        expect(children()[0]!.signals).toEqual([])
        await vi.advanceTimersByTimeAsync(60_000)
        expect(children()[0]!.signals).toEqual(['SIGINT'])
        hold.release()
    })

    it('keeps as many sessions as the box is configured to', async () => {
        vi.stubEnv('RERUN_COMPUTER_SESSIONS_KEPT', '3')
        const recording = await freshModule()
        const root = workspaceScreenDir('a1')
        for (let i = 10; i < 15; i++) mkdirSync(join(root, `2026-01-01T00-00-${i}-old`), { recursive: true })
        const hold = recording.holdScreenSession('a1', { record: false })
        await hold.saveFrame(Buffer.from('new'))
        hold.release()
        await vi.waitFor(() => expect(readdirSync(root)).toHaveLength(3))
        expect(readdirSync(root).sort()).toEqual(['2026-01-01T00-00-13-old', '2026-01-01T00-00-14-old', hold.id])
    })

    it('pauses the capture into a finalized segment and resumes into the next file', async () => {
        const recording = await freshModule()
        const hold = recording.holdScreenSession('a1')
        await vi.waitFor(() => expect(state.spawns).toHaveLength(1))
        expect(recording.screenRecordingPaused('a1')).toBe(false)
        await recording.pauseScreenRecording('a1')
        expect(recording.screenRecordingPaused('a1')).toBe(true)
        expect(children()[0]!.signals).toEqual(['SIGINT'])
        await recording.pauseScreenRecording('a1')
        recording.resumeScreenRecording('a1')
        expect(recording.screenRecordingPaused('a1')).toBe(false)
        await vi.waitFor(() => expect(state.spawns).toHaveLength(2))
        expect(state.spawns[0]!.args.at(-1)).toBe(resolve(workspaceScreenDir('a1'), hold.id, 'recording.mp4'))
        expect(state.spawns[1]!.args.at(-1)).toBe(resolve(workspaceScreenDir('a1'), hold.id, 'recording-2.mp4'))
        hold.release()
        await vi.waitFor(() => expect(children()[1]!.signals).toEqual(['SIGINT']))
    })

    it('has nothing to pause when the session never recorded or does not exist', async () => {
        const recording = await freshModule()
        const hold = recording.holdScreenSession('a1', { record: false })
        await recording.pauseScreenRecording('a1')
        expect(recording.screenRecordingPaused('a1')).toBe(false)
        recording.resumeScreenRecording('a1')
        expect(state.spawns).toEqual([])
        hold.release()
        await recording.pauseScreenRecording('zz')
        recording.resumeScreenRecording('zz')
        expect(recording.screenRecordingPaused('zz')).toBe(false)
    })

    it('prunes a workspace to its twenty most recent sessions once a session ends', async () => {
        const recording = await freshModule()
        const root = workspaceScreenDir('a1')
        for (let i = 10; i < 35; i++) {
            mkdirSync(join(root, `2026-01-01T00-00-${i}-old`), { recursive: true })
            writeFileSync(join(root, `2026-01-01T00-00-${i}-old`, '001.jpg'), 'x')
        }
        const hold = recording.holdScreenSession('a1', { record: false })
        await hold.saveFrame(Buffer.from('new'))
        hold.release()
        await vi.waitFor(() => expect(readdirSync(root)).toHaveLength(20))
        const kept = readdirSync(root).sort()
        expect(kept).toContain(hold.id)
        expect(kept[0]).toBe('2026-01-01T00-00-16-old')
    })

    it('lists the sessions from the filesystem, newest first, the live one still open', async () => {
        const recording = await freshModule()
        const root = workspaceScreenDir('a1')
        mkdirSync(join(root, '2026-01-02T09-15-00-done'), { recursive: true })
        writeFileSync(join(root, '2026-01-02T09-15-00-done', '001.jpg'), 'x')
        writeFileSync(join(root, '2026-01-02T09-15-00-done', '002.jpg'), 'x')
        writeFileSync(join(root, '2026-01-02T09-15-00-done', 'recording.mp4'), 'x')
        const hold = recording.holdScreenSession('a1', { record: false })
        await hold.saveFrame(Buffer.from('live'))
        const sessions = await recording.listScreenSessions('a1')
        expect(sessions).toHaveLength(2)
        expect(sessions[0]).toMatchObject({ id: hold.id, endedAt: null, frames: 1, recording: false })
        expect(sessions[0]!.startedAt).toBe(recording.sessionStartedAt(hold.id))
        expect(sessions[1]).toMatchObject({ id: '2026-01-02T09-15-00-done', startedAt: '2026-01-02T09:15:00.000Z', frames: 2, recording: true, recordings: ['recording.mp4'] })
        expect(sessions[1]!.endedAt).not.toBeNull()
        hold.release()
        expect(await recording.listScreenSessions('a2')).toEqual([])
    })

    it('lists the segment files of a session whose capture was paused and resumed, in order', async () => {
        const recording = await freshModule()
        const dir = join(workspaceScreenDir('a1'), '2026-01-02T09-15-00-cut')
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, 'recording-2.mp4'), 'x')
        writeFileSync(join(dir, 'recording.mp4'), 'x')
        writeFileSync(join(dir, 'recording-10.mp4'), 'x')
        const sessions = await recording.listScreenSessions('a1')
        expect(sessions[0]).toMatchObject({ recording: true, recordings: ['recording.mp4', 'recording-2.mp4', 'recording-10.mp4'] })
    })

    it('parses a start time out of a session id and refuses garbage', async () => {
        const recording = await freshModule()
        expect(recording.sessionStartedAt('2026-11-09T14-30-22-ab1c')).toBe('2026-11-09T14:30:22.000Z')
        expect(recording.sessionStartedAt('whatever')).toBeNull()
        expect(existsSync(workspaceScreenDir('zz'))).toBe(false)
    })
})
