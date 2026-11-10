import { createHmac } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { claimEvent, connectionForTeam, handleSlackMessage } from '@/app/api/_services/slack.service'
import { POST } from './route'

const afterTasks = vi.hoisted(() => [] as Promise<unknown>[])
vi.mock('next/server', async importOriginal => ({ ...(await importOriginal<typeof import('next/server')>()), after: (task: () => Promise<unknown>) => void afterTasks.push(task()) }))
vi.mock('@/app/api/_services/slack.service', () => ({ connectionForTeam: vi.fn(), claimEvent: vi.fn(), handleSlackMessage: vi.fn() }))

// The coworker answers after the response, so a test reads the handler once those tasks settled.
const afterResponse = () => Promise.all(afterTasks.splice(0))

const SECRET = 'signing-secret'
const TEAM = 'T_EXONOS'
const CONNECTION = { id: 'conn-1', workspace_id: 7, team_id: TEAM, team_name: 'Exonos', bot_user_id: 'U_RERUN', bot_token: 'xoxb-token', signing_secret: SECRET, can_customize_identity: true, status: 'connected' }

function deliver(body: unknown, options: { secret?: string; timestamp?: number; headers?: Record<string, string> } = {}): Request {
    const raw = JSON.stringify(body)
    const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1000))
    const signature = `v0=${createHmac('sha256', options.secret ?? SECRET).update(`v0:${timestamp}:${raw}`).digest('hex')}`
    return new Request('https://app.rerun.build/api/webhooks/slack', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-slack-request-timestamp': timestamp, 'x-slack-signature': signature, ...(options.headers ?? {}) },
        body: raw,
    })
}

function message(overrides: Record<string, unknown> = {}) {
    return {
        type: 'event_callback',
        team_id: TEAM,
        event_id: 'Ev1',
        event: { type: 'message', channel: 'C_MDC', user: 'U_THIAGO', text: 'engineer-1 the build is red', ts: '1794330002.000005', ...overrides },
    }
}

beforeEach(() => {
    vi.clearAllMocks()
    afterTasks.length = 0
    vi.mocked(connectionForTeam).mockResolvedValue(CONNECTION)
    vi.mocked(claimEvent).mockResolvedValue(true)
    vi.mocked(handleSlackMessage).mockResolvedValue()
})

describe('POST /api/webhooks/slack', () => {
    it('answers the challenge Slack sends when the URL is pasted', async () => {
        const res = await POST(deliver({ type: 'url_verification', team_id: TEAM, challenge: 'abc123' }))

        expect(res.status).toBe(200)
        await expect(res.json()).resolves.toEqual({ challenge: 'abc123' })
    })

    it('hands a message to the coworker, after answering Slack', async () => {
        const res = await POST(deliver(message()))

        expect(res.status).toBe(200)
        // Through `after`, not awaited by the handler: Slack gives up on the delivery after three
        // seconds, and a coworker's run takes longer than that.
        expect(afterTasks).toHaveLength(1)
        await afterResponse()
        expect(handleSlackMessage).toHaveBeenCalledWith(CONNECTION, expect.objectContaining({ text: 'engineer-1 the build is red' }), `${TEAM}:C_MDC:1794330002.000005`)
    })

    it('refuses a delivery signed with the wrong secret', async () => {
        const res = await POST(deliver(message(), { secret: 'not-the-secret' }))

        expect(res.status).toBe(401)
        await afterResponse()
        expect(handleSlackMessage).not.toHaveBeenCalled()
    })

    it('refuses a correctly signed delivery replayed an hour later', async () => {
        const res = await POST(deliver(message(), { timestamp: Math.floor(Date.now() / 1000) - 3600 }))

        expect(res.status).toBe(401)
        await afterResponse()
        expect(handleSlackMessage).not.toHaveBeenCalled()
    })

    it('refuses a team it does not know, without saying so', async () => {
        vi.mocked(connectionForTeam).mockResolvedValue(null)

        const res = await POST(deliver(message()))

        expect(res.status).toBe(401)
        await expect(res.json()).resolves.toEqual({ error: 'Unauthorized' })
    })

    it('ignores what the app itself said', async () => {
        await POST(deliver(message({ bot_id: 'B_RERUN', user: 'U_RERUN' })))
        await afterResponse()

        expect(handleSlackMessage).not.toHaveBeenCalled()
    })

    it('ignores joins, edits and other channel chatter', async () => {
        await POST(deliver(message({ subtype: 'channel_join' })))
        await afterResponse()

        expect(handleSlackMessage).not.toHaveBeenCalled()
    })

    it('keys the claim on the message, so one sentence delivered twice runs once', async () => {
        // The same words arrive as app_mention and as message.channels, under two event ids.
        await POST(deliver(message({ type: 'app_mention' })))
        await POST(deliver({ ...message(), event_id: 'Ev2' }))
        await afterResponse()

        expect(vi.mocked(claimEvent).mock.calls.map(call => call[0])).toEqual([`${TEAM}:C_MDC:1794330002.000005`, `${TEAM}:C_MDC:1794330002.000005`])
    })

    it('drops a delivery already claimed', async () => {
        vi.mocked(claimEvent).mockResolvedValue(false)

        await POST(deliver(message()))
        await afterResponse()

        expect(handleSlackMessage).not.toHaveBeenCalled()
    })

    it('leaves a Slack retry alone: the first run is still going', async () => {
        await POST(deliver(message(), { headers: { 'x-slack-retry-num': '1' } }))
        await afterResponse()

        expect(claimEvent).not.toHaveBeenCalled()
        expect(handleSlackMessage).not.toHaveBeenCalled()
    })
})
