import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const COMPUTER_KEYS = [
    'RERUN_DESKTOP_MAX_SCREENS',
    'RERUN_DESKTOP_IDLE_STOP_MINUTES',
    'RERUN_COMPUTER_RECORDING',
    'RERUN_COMPUTER_RECORDING_MAX_MINUTES',
    'RERUN_COMPUTER_SESSIONS_KEPT',
    'RERUN_COMPUTER_MAX_ACTIONS',
    'RERUN_COMPUTER_MAX_ACTIONS_CLI',
    'RERUN_COMPUTER_SCREENSHOTS_IN_CONTEXT',
]
const KEYS = ['RERUN_DATA_DIR', 'RERUN_PORT', 'RERUN_HOST', 'RERUN_API_KEY', 'RERUN_HUB_BASE_URL', 'RERUN_LOG_LEVEL', 'RERUN_CODEX_PATH', 'RERUN_DESKTOP', ...COMPUTER_KEYS]

const COMPUTER_DEFAULTS = {
    RERUN_DESKTOP_MAX_SCREENS: 20,
    RERUN_DESKTOP_IDLE_STOP_MINUTES: 5,
    RERUN_COMPUTER_RECORDING: 'on',
    RERUN_COMPUTER_RECORDING_MAX_MINUTES: 15,
    RERUN_COMPUTER_SESSIONS_KEPT: 20,
    RERUN_COMPUTER_MAX_ACTIONS: 200,
    RERUN_COMPUTER_MAX_ACTIONS_CLI: 60,
    RERUN_COMPUTER_SCREENSHOTS_IN_CONTEXT: 6,
}

async function freshEnv(values: Record<string, string | undefined> = {}) {
    vi.resetModules()
    for (const key of KEYS) vi.stubEnv(key, values[key])
    const { env } = await import('./env.js')
    return env
}

afterEach(() => {
    vi.unstubAllEnvs()
})

describe('env', () => {
    it('fills the defaults on an empty environment', async () => {
        const env = await freshEnv()
        expect(env()).toEqual({ RERUN_DATA_DIR: resolve(homedir(), '.rerun'), RERUN_PORT: 3000, RERUN_HOST: '0.0.0.0', RERUN_LOG_LEVEL: 'info', ...COMPUTER_DEFAULTS })
    })

    it('reads every variable it knows', async () => {
        const env = await freshEnv({
            RERUN_DATA_DIR: '/data',
            RERUN_PORT: '8080',
            RERUN_HOST: '127.0.0.1',
            RERUN_API_KEY: 'key',
            RERUN_HUB_BASE_URL: 'https://hub.example.com',
            RERUN_LOG_LEVEL: 'debug',
            RERUN_CODEX_PATH: '/usr/local/bin/codex',
        })
        expect(env()).toEqual({
            ...COMPUTER_DEFAULTS,
            RERUN_DATA_DIR: '/data',
            RERUN_PORT: 8080,
            RERUN_HOST: '127.0.0.1',
            RERUN_API_KEY: 'key',
            RERUN_HUB_BASE_URL: 'https://hub.example.com',
            RERUN_LOG_LEVEL: 'debug',
            RERUN_CODEX_PATH: '/usr/local/bin/codex',
        })
    })

    it('reads the computer limits, an empty one as its default, and refuses a zero or an unknown recording switch', async () => {
        const env = await freshEnv({ RERUN_DESKTOP_MAX_SCREENS: '4', RERUN_COMPUTER_RECORDING: 'off', RERUN_COMPUTER_MAX_ACTIONS: '' })
        expect(env()).toMatchObject({ RERUN_DESKTOP_MAX_SCREENS: 4, RERUN_COMPUTER_RECORDING: 'off', RERUN_COMPUTER_MAX_ACTIONS: 200 })
        await expect(freshEnv({ RERUN_DESKTOP_MAX_SCREENS: '0' }).then(env => env())).rejects.toThrow(/RERUN_DESKTOP_MAX_SCREENS/)
        await expect(freshEnv({ RERUN_COMPUTER_RECORDING: 'maybe' }).then(env => env())).rejects.toThrow(/RERUN_COMPUTER_RECORDING/)
    })

    it('reads an empty hub URL as no hub, but keeps an empty API key', async () => {
        const env = await freshEnv({ RERUN_HUB_BASE_URL: '', RERUN_API_KEY: '' })
        expect(env().RERUN_HUB_BASE_URL).toBeUndefined()
        expect(env().RERUN_API_KEY).toBe('')
    })

    it('refuses an invalid hub URL, port or log level, naming the variable', async () => {
        await expect(freshEnv({ RERUN_HUB_BASE_URL: 'not a url' }).then(env => env())).rejects.toThrow(/^Invalid environment: RERUN_HUB_BASE_URL/)
        await expect(freshEnv({ RERUN_PORT: 'eighty' }).then(env => env())).rejects.toThrow(/RERUN_PORT/)
        await expect(freshEnv({ RERUN_PORT: '-1' }).then(env => env())).rejects.toThrow(/RERUN_PORT/)
        await expect(freshEnv({ RERUN_PORT: '80.5' }).then(env => env())).rejects.toThrow(/RERUN_PORT/)
        await expect(freshEnv({ RERUN_LOG_LEVEL: 'verbose' }).then(env => env())).rejects.toThrow(/RERUN_LOG_LEVEL/)
    })

    it('reads an empty port as 0 and refuses it', async () => {
        await expect(freshEnv({ RERUN_PORT: '' }).then(env => env())).rejects.toThrow(/RERUN_PORT/)
    })

    it('parses once and serves the cached value afterwards', async () => {
        const env = await freshEnv({ RERUN_PORT: '4000' })
        const first = env()
        vi.stubEnv('RERUN_PORT', '5000')
        expect(env()).toBe(first)
        expect(env().RERUN_PORT).toBe(4000)
    })

    it('does not cache a failed parse', async () => {
        const env = await freshEnv({ RERUN_LOG_LEVEL: 'verbose' })
        expect(() => env()).toThrow()
        vi.stubEnv('RERUN_LOG_LEVEL', 'warn')
        expect(env().RERUN_LOG_LEVEL).toBe('warn')
    })
})
