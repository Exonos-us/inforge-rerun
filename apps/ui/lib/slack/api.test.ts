import { afterEach, describe, expect, it, vi } from 'vitest'
import { identityFields, postMessage, toMrkdwn } from './api'

const TOKEN = 'xoxb-test'

afterEach(() => vi.unstubAllGlobals())

function slackResponses(...answers: object[]) {
    const fetchMock = vi.fn()
    for (const answer of answers) fetchMock.mockResolvedValueOnce({ json: async () => answer, ok: true, headers: new Headers() })
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
}

describe('postMessage', () => {
    it('answers in the thread it was asked in', async () => {
        const fetchMock = slackResponses({ ok: true, ts: '1.2' })

        await expect(postMessage(TOKEN, { channel: 'C1', text: 'hi', threadTs: '1.1' })).resolves.toEqual({ ts: '1.2' })
        expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ channel: 'C1', thread_ts: '1.1' })
    })

    it('falls back to the channel when the thread is gone', async () => {
        // Someone deleted the message they asked from while the coworker was working.
        const fetchMock = slackResponses({ ok: false, error: 'invalid_thread_ts' }, { ok: true, ts: '2.0' })

        await expect(postMessage(TOKEN, { channel: 'C1', text: 'hi', threadTs: '1.1' })).resolves.toEqual({ ts: '2.0' })
        expect(JSON.parse(fetchMock.mock.calls[1][1].body).thread_ts).toBeUndefined()
    })

    it('does not swallow a refusal that is not about the thread', async () => {
        slackResponses({ ok: false, error: 'channel_not_found' })

        await expect(postMessage(TOKEN, { channel: 'C1', text: 'hi', threadTs: '1.1' })).rejects.toThrow('channel_not_found')
    })
})

describe('identityFields', () => {
    it('gives the coworker its name and face', () => {
        expect(identityFields({ name: 'engineer-1', iconEmoji: ':wrench:' })).toEqual({ username: 'engineer-1', icon_emoji: ':wrench:' })
    })

    it('prefers an emoji over a url, the way Slack does', () => {
        expect(identityFields({ name: 'e', iconEmoji: ':art:', iconUrl: 'https://x/y.png' })).toEqual({ username: 'e', icon_emoji: ':art:' })
    })

    it('sends nothing when there is nobody to be', () => {
        expect(identityFields(undefined)).toEqual({})
    })
})

describe('toMrkdwn', () => {
    it('turns markdown bold into the one Slack reads', () => {
        expect(toMrkdwn('**done**')).toBe('*done*')
    })

    it('flattens a heading, which Slack has no idea about', () => {
        expect(toMrkdwn('## Results')).toBe('*Results*')
    })

    it('keeps a link readable', () => {
        expect(toMrkdwn('see [the run](https://ci.example.com/42)')).toBe('see <https://ci.example.com/42|the run>')
    })
})
