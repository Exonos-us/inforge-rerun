import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/supabase/server', () => ({
    createClient: async () => {
        throw new Error('a public route never builds a Supabase client')
    },
    getRequestAccessToken: async () => null,
}))

const { GET } = await import('./route')

const segment = { params: Promise.resolve({}) }

async function clientConfig(url = 'https://app.rerun.build/api/v1/client', headers: Record<string, string> = {}) {
    const res = await GET(new Request(url, { headers }), segment)
    expect(res.status).toBe(200)
    return res.json()
}

async function minBuild(): Promise<number> {
    return (await clientConfig()).minBuild
}

describe('GET /api/v1/client', () => {
    afterEach(() => {
        vi.unstubAllEnvs()
    })

    it('answers without a signed-in caller, so the version gate runs before sign-in', async () => {
        vi.stubEnv('MOBILE_IOS_MIN_BUILD', '12')
        expect(await minBuild()).toBe(12)
    })

    it('lets every build through when the variable is unset or unreadable', async () => {
        vi.stubEnv('MOBILE_IOS_MIN_BUILD', '')
        expect(await minBuild()).toBe(0)
        vi.stubEnv('MOBILE_IOS_MIN_BUILD', 'twelve')
        expect(await minBuild()).toBe(0)
    })

    it('names the Supabase project the hub signs people in with', async () => {
        vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://api.example.com/')
        vi.stubEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_example')
        expect((await clientConfig('https://rerun.example.com/api/v1/client')).server).toEqual({
            supabaseUrl: 'https://api.example.com',
            supabasePublishableKey: 'sb_publishable_example',
        })
    })

    it('points a phone at a local Supabase on the machine it reached the hub on', async () => {
        vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://localhost:54421')
        vi.stubEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_local')
        expect((await clientConfig('http://localhost:3000/api/v1/client', { host: '192.168.1.20:3000' })).server.supabaseUrl).toBe('http://192.168.1.20:54421')
    })

    it('leaves the Supabase project out when the hub has none configured', async () => {
        vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '')
        vi.stubEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', '')
        expect((await clientConfig()).server).toBeUndefined()
    })
})
