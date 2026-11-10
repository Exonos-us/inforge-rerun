import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

process.env.RERUN_DATA_DIR = mkdtempSync(resolve(tmpdir(), 'rerun-paid-data-'))
process.env.RERUN_API_KEY = 'engine-secret'
process.env.RERUN_HUB_BASE_URL = 'https://hub.example.test/'

const { afterEach, beforeEach, describe, expect, it, vi } = await import('vitest')

const { paidDataTools } = await import('./paid-data.js')
const { PAID_DATA_CAPABILITIES } = await import('@rerun/contracts')
const { workspaceDir } = await import('../../config/paths.js')
const { lookupPaidSources } = await import('../../db/repos/paid-sources.js')
const { HostBreaker } = await import('../host-breaker.js')
const { forgetPriceMultiplier } = await import('../../paid-data/price.js')

const originalFetch = globalThis.fetch

function mockFetch(status: number, body: unknown) {
    const fn = vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }))
    globalThis.fetch = fn as unknown as typeof fetch
    return fn
}

const ctx = { agent: { id: 'prospector', env: {}, config: { tools: { requestApproval: true } } }, sessionId: 's1', logger: { warn: () => {} } } as any

async function run(name: string, args: Record<string, unknown>): Promise<any> {
    return await (paidDataTools(ctx)[name] as any).execute(args, { toolCallId: 'call-1', messages: [] })
}

async function buy(capability: string, params: Record<string, unknown>, toolCallId = 'call-1'): Promise<any> {
    return await (paidDataTools(ctx).paid_data as any).execute({ capability, params }, { toolCallId, messages: [] })
}

afterEach(() => {
    globalThis.fetch = originalFetch
})

describe('paidDataTools', () => {
    it('offers the catalog and the one paid_data tool, with descriptions short enough for every provider, and no spend to ask for', () => {
        const tools = paidDataTools(ctx)
        expect(Object.keys(tools).sort()).toEqual(['paid_data', 'paid_data_catalog', 'paid_data_read'])
        const description = (tools.paid_data as any).description as string
        expect(description.length).toBeLessThan(1000)
        expect(description).toContain('paid_data_catalog')
        expect(description).not.toContain('approv')
        expect(description).not.toContain('- tiktok.user.profile')
        expect(((tools.paid_data_catalog as any).description as string).length).toBeLessThan(1000)
        expect(((tools.paid_data_read as any).description as string).length).toBeLessThan(1000)
    })

    it('presents the catalog as the first read of a data task', () => {
        expect((paidDataTools(ctx).paid_data_catalog as any).description).toContain('before you search the web')
    })

    describe('paid_data_catalog', () => {
        const read = (args: Record<string, unknown>) => run('paid_data_catalog', args)

        beforeEach(() => {
            forgetPriceMultiplier()
            mockFetch(200, { priceMultiplier: 1.5 })
        })

        it('lists a group one capability per line', async () => {
            const text = await read({ group: 'tiktok' })
            expect(text.startsWith('TikTok:\n')).toBe(true)
            expect(text).toContain('- tiktok.user.profile (username, user_id or sec_uid)')
            expect(text).not.toContain('people.search')
        })

        it('prices each capability in credits, per call or per row, so the coworker can add up a task', async () => {
            const companies = await read({ group: 'companies' })
            expect(companies).toMatch(/- companies\.jobs\.search [^\n]* About 8 credits per call\.\n/)
            expect(await read({ group: 'people' })).toMatch(/- people\.search [^\n]* About 2 credits per row\./)
            expect(await read({ capability: 'companies.jobs.search' })).toContain('Billed per call, about 8 credits each')
            expect(await read({ capability: 'people.search' })).toContain('Billed per row returned, about 2 credits each')
        })

        it('documents one capability with its inputs, its rule and how it is billed', async () => {
            const email = await read({ capability: 'people.email.find' })
            expect(email).toContain('Needs one of: full_name, last_name, linkedin_url.')
            expect(email).toContain('Billed per call, about 5 credits each, counted as "work emails".')
            expect(email).toContain('"linkedin_url"')
            expect(email).not.toContain('$schema')
            expect(await read({ capability: 'people.search' })).toContain('Billed per row returned')
            expect(await read({ group: 'tiktok', capability: 'people.search' })).toContain('people.search (')
        })

        it('gives the whole catalog by ids when asked nothing in particular', async () => {
            const text = await read({})
            expect(text).toContain('in 11 groups')
            for (const capability of PAID_DATA_CAPABILITIES) expect(text).toContain(capability)
        })

        it('names what exists when asked for something that does not', async () => {
            expect(await read({ group: 'pinterest' })).toBe('Unknown group "pinterest": one of people, companies, search, seo, linkedin, tiktok, instagram, x, youtube, facebook, reddit.')
            const unknown = await read({ capability: 'tiktok.followers' })
            expect(unknown.startsWith('Unknown capability "tiktok.followers".')).toBe(true)
            expect(unknown).toContain('tiktok.user.profile')
        })

        it('asks the hub only for the multiplier it bills with, once for a while, and buys nothing', async () => {
            const fetchMock = mockFetch(200, { priceMultiplier: 1.5 })
            for (const args of [{}, { group: 'seo' }, { capability: 'google.keywords.volume' }, { capability: 'nope' }]) expect(typeof (await read(args))).toBe('string')
            expect(fetchMock).toHaveBeenCalledTimes(1)
            const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
            expect(url).toBe('https://hub.example.test/api/paid-data')
            expect(init.method).toBeUndefined()
            expect(init.headers).toMatchObject({ Authorization: 'Bearer engine-secret' })
        })

        it('prices the catalog with the multiplier of the hub', async () => {
            mockFetch(200, { priceMultiplier: 1 })
            expect(await read({ capability: 'people.email.find' })).toContain('Billed per call, about 3 credits each')
            forgetPriceMultiplier()
            mockFetch(200, { priceMultiplier: 2 })
            expect(await read({ capability: 'people.email.find' })).toContain('Billed per call, about 6 credits each')
        })

        it('gives no price rather than a wrong one when the hub does not say what it bills', async () => {
            for (const answer of [() => mockFetch(404, { error: 'Not found' }), () => mockFetch(200, {}), () => (globalThis.fetch = vi.fn(async () => Promise.reject(new Error('offline'))) as unknown as typeof fetch)]) {
                forgetPriceMultiplier()
                answer()
                const group = await read({ group: 'people' })
                expect(group).not.toContain('credits per')
                expect(group).toContain('Prices are not available right now')
                const doc = await read({ capability: 'people.email.find' })
                expect(doc).toContain('Billed per call, counted as "work emails".')
                expect(doc).toContain('Prices are not available right now')
            }
        })
    })

    it('refuses an unknown capability or wrong params before asking the hub, so the model can fix its call', async () => {
        const fetchMock = mockFetch(200, {})

        expect((await buy('tiktok.followers', { username: 'khaby.lame' })).message).toContain('Unknown capability "tiktok.followers"')
        expect((await buy('tiktok.user.profile', { handle: 'khaby.lame' })).message).toContain('Unrecognized key')
        expect((await buy('tiktok.user.profile', {})).message).toBe('Not run, nothing was billed: tiktok.user.profile needs one of: username, user_id, sec_uid.')
        expect(fetchMock).not.toHaveBeenCalled()
    })

    it('sends the call to the hub with the engine key and the agent, with nothing to approve first', async () => {
        const fetchMock = mockFetch(200, { outcome: 'ok', result: { output: { email: 'jane@acme.com' } }, costMicros: 36_000, servedBy: 'hunter' })

        const output = await buy('people.email.find', { full_name: 'Jane Doe', domain: 'acme.com' })

        const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
        expect(url).toBe('https://hub.example.test/api/paid-data')
        expect(init.headers).toMatchObject({ Authorization: 'Bearer engine-secret', 'x-rerun-agent': 'prospector', 'x-rerun-paid-data-full': '1' })
        expect(JSON.parse(String(init.body))).toEqual({ capability: 'people.email.find', params: { full_name: 'Jane Doe', domain: 'acme.com' } })
        expect(output).toEqual({ status: 'found', billedMicros: 36_000, message: 'Found. Billed 4 credits.', servedBy: 'hunter', result: { output: { email: 'jane@acme.com' } } })
    })

    it('says in the message how many rows the provider sent past the limit and which filters it ignored', async () => {
        const companies = Array.from({ length: 100 }, (_, i) => ({ domain: `firm${i}.com.br` }))
        const result = { output: { companies: companies.slice(0, 25), count: 3578 }, ignoredFilters: ['country'], rows: { asked: 25, returned: 100, total: 3578 } }
        mockFetch(200, { outcome: 'ok', result, costMicros: 0, servedBy: 'hunter.x.discover-companies', callId: 'treg-call-7', full: { output: { companies, count: 3578 }, raw: null, notes: {} } })

        const output = await buy('companies.search', { q: 'law firms', country: 'br', limit: 25 })

        expect(output.result).toEqual(result)
        expect(output.message).toContain('The provider sent 100 rows for the 25 you asked for (3,578 match in all): the result shows the first 25, the saved file holds all 100.')
        expect(output.message).toContain('The provider ignored these filters: country. No row was filtered on them: check each row against them before you use it.')
    })

    it('adds nothing to the message of a miss, whatever the notes say', async () => {
        mockFetch(200, { outcome: 'miss', result: { output: { companies: [] }, ignoredFilters: ['country'] }, costMicros: 0 })

        expect((await buy('companies.search', { q: 'law firms', country: 'br' })).message).toBe('Nothing found. Nothing was billed.')
    })

    describe('the whole answer', () => {
        const videos = Array.from({ length: 30 }, (_, i) => ({ aweme_id: String(i), desc: 'd'.repeat(3_000), image_post_info: { images: [{ display_image: { url_list: [`https://cdn/${i}.jpeg`] } }] } }))
        const full = { output: { videos }, raw: { data: { aweme_list: videos } }, notes: { servedBy: 'tikhub' } }
        const hubAnswer = (result: unknown) => ({ outcome: 'ok', result, costMicros: 4_500, servedBy: 'tikhub', callId: 'treg-call-9', full })

        it('is saved in the workspace, pointed at from the result, without any cost in it', async () => {
            mockFetch(200, hubAnswer({ output: { videos: videos.slice(0, 2).map(({ aweme_id }) => ({ aweme_id })) } }))

            const output = await buy('tiktok.search.videos', { q: 'carousel' })

            expect(output.saved).toMatch(/^\.rerun\/paid-data\/tiktok\.search\.videos-\d{4}-\d{2}-\d{2}-treg-call-9\.json$/)
            expect(Object.keys(output)[0]).toBe('saved')
            expect(output.message).toContain(`The whole answer is saved at ${output.saved}`)
            expect(output.message).toContain('paid_data_read')
            const text = readFileSync(resolve(workspaceDir('prospector'), output.saved), 'utf8')
            expect(JSON.parse(text)).toMatchObject({ capability: 'tiktok.search.videos', params: { q: 'carousel' }, callId: 'treg-call-9', output: full.output, raw: full.raw })
            expect(text).not.toMatch(/cost|micros|billed/i)
            expect(text.split('\n').length).toBeGreaterThan(100)
        })

        it('reads back any part of it for free: an outline, a page of a list, a nested field', async () => {
            mockFetch(200, hubAnswer({ output: { videos: [] } }))
            const { saved } = await buy('tiktok.search.videos', { q: 'carousel' })
            const fetchMock = mockFetch(200, {})
            const read = (args: Record<string, unknown>) => run('paid_data_read', { saved, ...args })

            const { outline } = await read({})
            expect(outline.capability).toBe('text, 20 chars')
            expect(Object.keys(outline.output.videos)).toEqual([expect.stringMatching(/^list of 30, \d+ chars$/)])
            expect(Object.values(outline.output.videos)[0]).toMatchObject({ aweme_id: 'text, 1 chars', image_post_info: expect.anything() })
            const page = await read({ path: 'output.videos', offset: 3 })
            expect(page).toMatchObject({ total: 30, offset: 3 })
            expect(page.value[0].aweme_id).toBe('3')
            expect(JSON.stringify(page).length).toBeLessThan(40_000)
            expect(page.next).toBe(3 + page.value.length)
            expect((await read({ path: 'raw.data.aweme_list.29.image_post_info.images.0.display_image.url_list.0' })).value).toBe('https://cdn/29.jpeg')
            expect(fetchMock).not.toHaveBeenCalled()
        })

        it('outlines an item too big to read at once rather than sending it whole, and pages past it', async () => {
            const heavy = { aweme_id: 'heavy', desc: 'x'.repeat(90_000) }
            mockFetch(200, { ...hubAnswer({ output: { videos: [] } }), full: { ...full, output: { videos: [heavy, videos[1]] } } })
            const { saved } = await buy('tiktok.search.videos', { q: 'carousel' })
            const read = (args: Record<string, unknown>) => run('paid_data_read', { saved, ...args })

            const page = await read({ path: 'output.videos' })
            expect(page.value).toBeUndefined()
            expect(page).toMatchObject({ total: 2, offset: 0, next: 1, outline: { aweme_id: 'text, 5 chars', desc: 'text, 90000 chars' } })
            expect(page.note).toContain('"output.videos.0.<key>"')
            expect(JSON.stringify(page).length).toBeLessThan(40_000)
            expect((await read({ path: 'output.videos', offset: 1 })).value).toEqual([videos[1]])
        })

        it('refuses to read a file that is not a saved answer', async () => {
            await expect(run('paid_data_read', { saved: '.rerun/paid-data/../services.json' })).rejects.toThrow('Not a saved paid answer')
            await expect(run('paid_data_read', { saved: 'notes.md' })).rejects.toThrow('Not a saved paid answer')
        })

        it('comes back as the outline of the saved file when it is past the cut, whole when it fits', async () => {
            mockFetch(200, hubAnswer({ output: { videos } }))
            const heavy = await buy('tiktok.search.videos', { q: 'carousel' })

            expect(heavy).not.toHaveProperty('result')
            expect(Object.keys(heavy.outline)).toEqual(['notes', 'output', 'raw'])
            expect(Object.keys(heavy.outline.output.videos)).toEqual([expect.stringMatching(/^list of 30, \d+ chars$/)])
            expect(JSON.stringify(heavy).length).toBeLessThan(40_000)
            expect(heavy.message).toContain(`Too big to show here: saved whole at ${heavy.saved}. Read it with paid_data_read (path "output.videos", a page at a time) or with jq / grep through shell_exec`)

            const light = videos.slice(0, 3)
            mockFetch(200, { ...hubAnswer({ output: { videos: light } }), full: { ...full, output: { videos: light } } })
            const small = await buy('tiktok.search.videos', { q: 'carousel' })

            expect(small.result).toEqual({ output: { videos: light } })
            expect(small).not.toHaveProperty('outline')
        })

        it('saves nothing for a miss, nor when the hub sends no whole answer', async () => {
            mockFetch(200, { outcome: 'miss', result: { output: { videos: [] } }, costMicros: 0, full })
            expect(await buy('tiktok.search.videos', { q: 'nothing' })).not.toHaveProperty('saved')

            mockFetch(200, { outcome: 'ok', result: { output: { videos: [{ aweme_id: '1' }] } }, costMicros: 0 })
            const output = await buy('tiktok.search.videos', { q: 'carousel' })
            expect(output).not.toHaveProperty('saved')
            expect(output.message).toBe('Found. Nothing was billed.')
        })

        it('cuts an unsaved answer past the cut rather than sending it whole', async () => {
            mockFetch(200, { outcome: 'ok', result: { output: { videos } }, costMicros: 0 })

            const output = await buy('tiktok.search.videos', { q: 'carousel' })

            expect(output).not.toHaveProperty('saved')
            expect(output.result).toMatch(/…\[truncated\]$/)
            expect(output.result.length).toBeLessThan(40_100)
            expect(output.message).toContain('could not be saved')
        })
    })

    it('says a miss found nothing', async () => {
        mockFetch(200, { outcome: 'miss', result: { output: { email: null } }, costMicros: 0 })

        expect(await buy('people.email.find', { linkedin_url: 'https://linkedin.com/in/jane' })).toMatchObject({ status: 'nothing_found', billedMicros: 0, message: 'Nothing found. Nothing was billed.' })
    })

    it('marks a call refused for want of credit, so the chat shows the top-up notice, and tells the coworker to go on without paid data', async () => {
        mockFetch(402, { error: 'rerun_budget_exhausted' })

        const output = await buy('google.serp.maps', { q: 'plumber Lyon', country: 'fr' })
        expect(output).toMatchObject({ status: 'not_run', reason: 'out_of_credit', billedMicros: 0 })
        expect(output.message).toContain('no Rerun credit left')
        expect(output.message).toContain('finish the task with your free tools')
    })

    describe('a source that is down', () => {
        const SEARCHES = [{ title: 'CTO' }, { title: 'VP Engineering' }, { title: 'Head of Data' }, { title: 'CEO' }]

        function runTools() {
            const tools = paidDataTools({ ...ctx, hostBreaker: new HostBreaker() })
            return (params: Record<string, unknown>) => (tools.paid_data as any).execute({ capability: 'people.search', params }, { toolCallId: 'call-1', messages: [] })
        }

        it('tells the coworker to go on and retry once, unbilled', async () => {
            mockFetch(503, { error: 'Paid data is temporarily unavailable', costMicros: 0 })

            const output = await runTools()(SEARCHES[0])
            expect(output).toMatchObject({ status: 'not_run', billedMicros: 0 })
            expect(output.message).toContain('this source is down for the moment')
        })

        it('closes paid data for the run after three outages in a row, and calls the hub no more', async () => {
            const fetch = mockFetch(503, { error: 'Paid data is temporarily unavailable', costMicros: 0 })
            const search = runTools()

            const outputs = []
            for (const params of SEARCHES) outputs.push(await search(params))

            expect(fetch).toHaveBeenCalledTimes(3)
            expect(outputs[1].message).toContain('this source is down for the moment')
            for (const output of outputs.slice(2)) {
                expect(output).toMatchObject({ status: 'not_run', billedMicros: 0 })
                expect(output.message).toContain('Do not call paid_data again in this run')
            }
        })

        it('starts the count again after a call that went through', async () => {
            const search = runTools()
            mockFetch(503, { error: 'Paid data is temporarily unavailable', costMicros: 0 })
            await search(SEARCHES[0])
            await search(SEARCHES[1])
            mockFetch(200, { outcome: 'miss', result: { output: { people: [] } }, costMicros: 0 })
            await search(SEARCHES[2])
            mockFetch(503, { error: 'Paid data is temporarily unavailable', costMicros: 0 })

            expect((await search(SEARCHES[3])).message).toContain('this source is down for the moment')
        })

        it('does not count a refused input against the source', async () => {
            const search = runTools()
            const fetch = mockFetch(422, { error: 'no identity key', costMicros: 0 })
            for (const params of SEARCHES) await search(params)

            expect(fetch).toHaveBeenCalledTimes(4)
        })
    })

    it('warns against repeating a call still pending', async () => {
        mockFetch(200, { outcome: 'pending', result: null, costMicros: 0 })

        expect((await buy('people.phone.find', { linkedin_url: 'https://linkedin.com/in/jane' })).message).toContain('Do not call it again')
    })

    describe('the provenance index', () => {
        it('records a found answer by the values it returned, from the whole answer when the hub sends it', async () => {
            const places = [
                { title: 'Boulangerie Dupont', phone: '+33 1 42 00 00 01', website: 'https://boulangerie-dupont.fr' },
                { title: 'Café Lumière', phone: '+33 1 42 00 00 02', website: 'https://cafe-lumiere.com' },
            ]
            mockFetch(200, { outcome: 'ok', result: { output: { places: places.slice(0, 1) } }, costMicros: 9_000, servedBy: 'serpapi.maps', callId: 'treg-maps', full: { output: { places }, raw: null, notes: {} } })

            await buy('google.serp.maps', { q: 'boulangerie Paris', country: 'fr' }, 'tool-maps')

            const sources = await lookupPaidSources(['prospector'], [{ name: 'Café Lumière', phone: '01 42 00 00 02' }])
            expect(sources.calls['tool-maps']).toMatchObject({ capability: 'google.serp.maps', servedBy: 'serpapi.maps' })
            expect(sources.rows[0]).toEqual({
                sources: ['tool-maps'],
                cells: { name: { call: 'tool-maps', field: 'title', href: 'https://cafe-lumiere.com' }, phone: { call: 'tool-maps', field: 'phone', href: 'https://cafe-lumiere.com' } },
            })
        })

        it('carries the verdict of a found email, then the one of a later verification', async () => {
            mockFetch(200, { outcome: 'ok', result: { output: { email: 'jane@initech.com' }, verification: { verdict: 'accept_all' } }, costMicros: 36_000, servedBy: 'hunter' })
            await buy('people.email.find', { full_name: 'Jane Doe', domain: 'initech.com' }, 'tool-find')
            expect((await lookupPaidSources(['prospector'], [{ email: 'jane@initech.com' }])).rows[0].cells.email).toEqual({ call: 'tool-find', field: 'email', verdict: 'accept_all' })

            // "Later" is a millisecond timestamp: on the same one the order of the two calls would be a coin toss.
            await new Promise(resolve => setTimeout(resolve, 2))
            mockFetch(200, { outcome: 'ok', result: { output: { status: 'valid' } }, costMicros: 4_000, servedBy: 'zerobounce' })
            await buy('people.email.verify', { email: 'jane@initech.com' }, 'tool-verify')

            const sources = await lookupPaidSources(['prospector'], [{ email: 'jane@initech.com' }])
            expect(sources.rows[0].sources).toEqual(['tool-verify', 'tool-find'])
            expect(sources.rows[0].cells.email).toEqual({ call: 'tool-verify', field: 'email', verdict: 'valid' })
        })

        it('records nothing for a miss', async () => {
            mockFetch(200, { outcome: 'miss', result: { output: { email: null } }, costMicros: 0 })
            await buy('people.email.find', { full_name: 'Nobody', domain: 'nowhere.com' }, 'tool-miss')
            expect((await lookupPaidSources(['prospector'], [{ name: 'Nobody', company: 'nowhere.com' }])).calls).not.toHaveProperty('tool-miss')
        })
    })
})
