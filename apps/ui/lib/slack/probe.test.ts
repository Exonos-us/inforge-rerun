import { afterEach, describe, expect, it, vi } from 'vitest'

import { probeableRequestUrl, probeRequestUrl } from './probe'

describe('probeableRequestUrl', () => {
    it('accepts a public https address', () => {
        expect(probeableRequestUrl('https://f3ab-186-12.ngrok-free.app/api/webhooks/slack')).toBe('https://f3ab-186-12.ngrok-free.app/api/webhooks/slack')
        expect(probeableRequestUrl('https://rerun.example.com/api/webhooks/slack')).toBe('https://rerun.example.com/api/webhooks/slack')
    })

    it('refuses everything Slack itself could not call', () => {
        expect(probeableRequestUrl('http://rerun.example.com/api/webhooks/slack')).toBeNull()
        expect(probeableRequestUrl('https://localhost:3050/api/webhooks/slack')).toBeNull()
        expect(probeableRequestUrl('http://localhost:3050/api/webhooks/slack')).toBeNull()
        expect(probeableRequestUrl('https://127.0.0.1/api/webhooks/slack')).toBeNull()
        expect(probeableRequestUrl('https://10.0.0.8/api/webhooks/slack')).toBeNull()
        expect(probeableRequestUrl('https://[::1]/api/webhooks/slack')).toBeNull()
        expect(probeableRequestUrl('not a url')).toBeNull()
        expect(probeableRequestUrl(null)).toBeNull()
        expect(probeableRequestUrl('')).toBeNull()
    })
})

describe('probeRequestUrl', () => {
    afterEach(() => {
        vi.unstubAllGlobals()
    })

    const answering = (body: (challenge: string) => string, status = 200) =>
        vi.fn(async (_url: string, init: RequestInit) => {
            const challenge = (JSON.parse(init.body as string) as { challenge: string }).challenge
            return new Response(body(challenge), { status })
        })

    it('says ok when the handshake comes back', async () => {
        vi.stubGlobal('fetch', answering(challenge => JSON.stringify({ challenge })))
        await expect(probeRequestUrl('https://tunnel.example/api/webhooks/slack')).resolves.toBe('ok')
    })

    it('says unreachable on a non-200 (a dead ngrok edge answers 404)', async () => {
        vi.stubGlobal('fetch', answering(() => 'ERR_NGROK_3200', 404))
        await expect(probeRequestUrl('https://tunnel.example/api/webhooks/slack')).resolves.toBe('unreachable')
    })

    it('says unreachable when 200 does not echo the challenge (another server lives there now)', async () => {
        vi.stubGlobal('fetch', answering(() => '<html>welcome</html>'))
        await expect(probeRequestUrl('https://tunnel.example/api/webhooks/slack')).resolves.toBe('unreachable')
    })

    it('says unreachable when nothing answers at all', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('ECONNREFUSED'))))
        await expect(probeRequestUrl('https://tunnel.example/api/webhooks/slack')).resolves.toBe('unreachable')
    })
})
