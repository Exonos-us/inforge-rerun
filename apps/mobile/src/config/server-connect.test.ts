import { ApiError } from '@/api/client'
import { isLocalNetworkHost, lookUpServer, normalizeServerUrl } from '@/config/server-connect'

describe('normalizeServerUrl', () => {
    it('keeps only the origin of what was typed', () => {
        expect(normalizeServerUrl(' https://rerun.example.com/workspace?x=1 ')).toEqual({ ok: true, origin: 'https://rerun.example.com' })
    })

    it('speaks HTTPS to a public name and HTTP to the local network when no scheme is typed', () => {
        expect(normalizeServerUrl('rerun.example.com')).toEqual({ ok: true, origin: 'https://rerun.example.com' })
        expect(normalizeServerUrl('192.168.1.20:3000')).toEqual({ ok: true, origin: 'http://192.168.1.20:3000' })
        expect(normalizeServerUrl('mac-mini.local:3000')).toEqual({ ok: true, origin: 'http://mac-mini.local:3000' })
    })

    it('refuses plain HTTP outside the local network', () => {
        expect(normalizeServerUrl('http://rerun.example.com')).toEqual({ ok: false, problem: 'insecure' })
        expect(normalizeServerUrl('http://8.8.8.8:3000')).toEqual({ ok: false, problem: 'insecure' })
    })

    it('refuses what is not a web address', () => {
        expect(normalizeServerUrl('')).toEqual({ ok: false, problem: 'invalid' })
        expect(normalizeServerUrl('ftp://rerun.example.com')).toEqual({ ok: false, problem: 'invalid' })
        expect(normalizeServerUrl('http://')).toEqual({ ok: false, problem: 'invalid' })
    })
})

describe('isLocalNetworkHost', () => {
    it('knows the private ranges, Tailscale and local names', () => {
        for (const host of ['10.0.0.4', '172.20.1.1', '192.168.1.20', '169.254.3.3', '100.101.102.103', '127.0.0.1', 'localhost', 'nas.local', 'mac-mini']) {
            expect(isLocalNetworkHost(host)).toBe(true)
        }
        for (const host of ['172.32.0.1', '100.128.0.1', '8.8.8.8', 'rerun.example.com', '192.168.1']) {
            expect(isLocalNetworkHost(host)).toBe(false)
        }
    })
})

describe('lookUpServer', () => {
    const answering = (payload: unknown) => jest.fn(async () => payload)

    it('takes the Supabase project the hub names', async () => {
        const request = answering({ minBuild: 0, server: { supabaseUrl: 'https://api.example.com', supabasePublishableKey: 'sb_publishable_x' } })
        expect(await lookUpServer('https://rerun.example.com', request)).toEqual({
            ok: true,
            server: { apiUrl: 'https://rerun.example.com', supabaseUrl: 'https://api.example.com', supabasePublishableKey: 'sb_publishable_x' },
        })
        expect(request).toHaveBeenCalledWith('/api/v1/client', expect.anything())
    })

    it('tells a hub from before server picking apart from an address that is not a hub', async () => {
        expect(await lookUpServer('https://rerun.example.com', answering({ minBuild: 0 }))).toEqual({ ok: false, problem: 'outdated' })
        expect(await lookUpServer('https://example.com', answering(null))).toEqual({ ok: false, problem: 'not-rerun' })
        const notFound = jest.fn(async () => {
            throw new ApiError(404, 'Not found')
        })
        expect(await lookUpServer('https://example.com', notFound)).toEqual({ ok: false, problem: 'not-rerun' })
    })

    it('reports an address that does not answer', async () => {
        const offline = jest.fn(async () => {
            throw new TypeError('Network request failed')
        })
        expect(await lookUpServer('http://192.168.1.99:3000', offline)).toEqual({ ok: false, problem: 'unreachable' })
    })

    it('refuses a hub whose Supabase the phone could only reach over the open internet in plain HTTP', async () => {
        const request = answering({ minBuild: 0, server: { supabaseUrl: 'http://api.example.com', supabasePublishableKey: 'sb_publishable_x' } })
        expect(await lookUpServer('https://rerun.example.com', request)).toEqual({ ok: false, problem: 'insecure' })
    })
})
