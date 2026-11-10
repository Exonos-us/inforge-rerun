import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'

const calls = vi.hoisted(() => [] as string[])

vi.mock('../../agents/loader.js', () => ({ agentExists: () => true }))
vi.mock('../../desktop/takeover.js', () => ({
    activeTakeovers: () => [],
    startTakeover: async () => {},
    finishTakeover: async (id: string) => {
        calls.push(`finish:${id}`)
        return { url: null }
    },
    handBackTakeover: async (id: string) => {
        calls.push(`hand back:${id}`)
        return { url: 'https://site.example/inbox', open: true }
    },
}))

vi.mock('../../desktop/recording.js', () => ({
    listScreenSessions: async (id: string) => {
        calls.push(`sessions:${id}`)
        return [{ id: '2026-11-09T14-30-22-ab1c', startedAt: '2026-11-09T14:30:22.000Z', endedAt: null, frames: 3, recording: true }]
    },
}))

const { agentDesktopRoutes, agentScreenRoutes } = await import('./desktop.js')
const app = new Hono().route('/agents/:id/desktop', agentDesktopRoutes).route('/agents/:id/screen', agentScreenRoutes)

describe('DELETE /agents/:id/desktop/takeover', () => {
    it('closes the browser, or leaves it on the screen when the person hands it back to the run', async () => {
        const closed = await app.request('/agents/a1/desktop/takeover', { method: 'DELETE' })
        expect(await closed.json()).toEqual({ url: null })
        const kept = await app.request('/agents/a1/desktop/takeover?keepOpen=1', { method: 'DELETE' })
        expect(await kept.json()).toEqual({ url: 'https://site.example/inbox', open: true })
        expect(calls).toEqual(['finish:a1', 'hand back:a1'])
    })
})

describe('GET /agents/:id/screen/sessions', () => {
    it('lists the screen sessions kept in the agent workspace', async () => {
        const res = await app.request('/agents/a1/screen/sessions')
        expect(await res.json()).toEqual({ sessions: [{ id: '2026-11-09T14-30-22-ab1c', startedAt: '2026-11-09T14:30:22.000Z', endedAt: null, frames: 3, recording: true }] })
        expect(calls).toContain('sessions:a1')
    })
})
