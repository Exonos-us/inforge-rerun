import { vi } from 'vitest'

const state = vi.hoisted(() => ({
    desktopHolds: 0,
    sessionHolds: 0,
    records: [] as boolean[],
    renews: [] as string[],
    ends: [] as string[],
    resumes: [] as string[],
    recording: true,
    configBroken: false,
}))

vi.mock('./session.js', () => ({
    HOLD_TTL_MS: 2 * 60_000,
    holdDesktop: () => {
        state.desktopHolds++
        return () => {
            state.desktopHolds--
        }
    },
    renewHumanHold: (agentId: string) => state.renews.push(agentId),
    endHumanHold: (agentId: string) => state.ends.push(agentId),
}))

vi.mock('./recording.js', () => ({
    resumeScreenRecording: (agentId: string) => state.resumes.push(agentId),
    holdScreenSession: (_agentId: string, { record = true } = {}) => {
        state.sessionHolds++
        state.records.push(record)
        return {
            id: 'session-1',
            saveFrame: async () => {},
            release: () => {
                state.sessionHolds--
            },
        }
    },
}))

vi.mock('../agents/loader.js', () => ({
    readAgentConfig: async () => {
        if (state.configBroken) throw new Error('no config')
        return { tools: { computerRecording: state.recording } }
    },
}))

const { afterEach, beforeEach, describe, expect, it } = await import('vitest')

async function freshModule() {
    vi.resetModules()
    return import('./hold.js')
}

beforeEach(() => {
    state.desktopHolds = 0
    state.sessionHolds = 0
    state.records.length = 0
    state.renews.length = 0
    state.ends.length = 0
    state.resumes.length = 0
    state.recording = true
    state.configBroken = false
    vi.useFakeTimers()
})

afterEach(() => {
    vi.useRealTimers()
})

describe('screen hold', () => {
    it('takes one hold per agent: the desktop, the screen session with the agent recording flag, and the session state', async () => {
        const hold = await freshModule()
        await hold.takeScreenHold('a1')
        expect(state.desktopHolds).toBe(1)
        expect(state.sessionHolds).toBe(1)
        expect(state.records).toEqual([true])
        expect(state.renews).toEqual(['a1'])
    })

    it('renews instead of stacking when taken again, including two takes racing through the config read', async () => {
        const hold = await freshModule()
        await Promise.all([hold.takeScreenHold('a1'), hold.takeScreenHold('a1')])
        await hold.takeScreenHold('a1')
        expect(state.desktopHolds).toBe(1)
        expect(state.sessionHolds).toBe(1)
        expect(state.renews).toEqual(['a1', 'a1', 'a1'])
    })

    it('releases everything once, resumes a capture left paused, and tolerates a release without a hold', async () => {
        const hold = await freshModule()
        await hold.takeScreenHold('a1')
        hold.releaseScreenHold('a1')
        hold.releaseScreenHold('a1')
        hold.releaseScreenHold('zz')
        expect(state.desktopHolds).toBe(0)
        expect(state.sessionHolds).toBe(0)
        expect(state.ends).toEqual(['a1', 'a1', 'zz'])
        expect(state.resumes).toEqual(['a1'])
    })

    it('expires on its own when nobody renews it, and a renewal pushes the expiry back', async () => {
        const hold = await freshModule()
        await hold.takeScreenHold('a1')
        await vi.advanceTimersByTimeAsync(90_000)
        await hold.takeScreenHold('a1')
        await vi.advanceTimersByTimeAsync(2 * 60_000 - 1)
        expect(state.desktopHolds).toBe(1)
        await vi.advanceTimersByTimeAsync(1)
        expect(state.desktopHolds).toBe(0)
        expect(state.sessionHolds).toBe(0)
        expect(state.ends).toEqual(['a1'])
    })

    it('records by default when the agent config cannot be read, and skips recording when the agent switched it off', async () => {
        state.configBroken = true
        const hold = await freshModule()
        await hold.takeScreenHold('a1')
        state.configBroken = false
        state.recording = false
        await hold.takeScreenHold('a2')
        expect(state.records).toEqual([true, false])
    })
})
