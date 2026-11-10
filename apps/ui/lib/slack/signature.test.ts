import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { verifySlackSignature } from './signature'

const SECRET = 'a-signing-secret'
const BODY = JSON.stringify({ type: 'event_callback', event: { type: 'message', text: 'hello' } })

function sign(body: string, timestamp: string, secret = SECRET): string {
    return `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${body}`).digest('hex')}`
}

describe('verifySlackSignature', () => {
    const now = 1_800_000_000

    it('accepts a delivery Slack signed', () => {
        const timestamp = String(now)
        expect(verifySlackSignature({ body: BODY, timestamp, signature: sign(BODY, timestamp), signingSecret: SECRET, now })).toBe(true)
    })

    it('refuses a body changed in flight', () => {
        const timestamp = String(now)
        const signature = sign(BODY, timestamp)
        const tampered = BODY.replace('hello', 'delete everything')
        expect(verifySlackSignature({ body: tampered, timestamp, signature, signingSecret: SECRET, now })).toBe(false)
    })

    it('refuses a signature made with another secret', () => {
        const timestamp = String(now)
        expect(verifySlackSignature({ body: BODY, timestamp, signature: sign(BODY, timestamp, 'someone-elses'), signingSecret: SECRET, now })).toBe(false)
    })

    it('refuses a delivery replayed outside the window, signature and all', () => {
        const timestamp = String(now - 301)
        expect(verifySlackSignature({ body: BODY, timestamp, signature: sign(BODY, timestamp), signingSecret: SECRET, now })).toBe(false)
    })

    it('accepts a delivery from a clock a little ahead', () => {
        const timestamp = String(now + 30)
        expect(verifySlackSignature({ body: BODY, timestamp, signature: sign(BODY, timestamp), signingSecret: SECRET, now })).toBe(true)
    })

    it('refuses anything missing', () => {
        const timestamp = String(now)
        expect(verifySlackSignature({ body: BODY, timestamp: null, signature: sign(BODY, timestamp), signingSecret: SECRET, now })).toBe(false)
        expect(verifySlackSignature({ body: BODY, timestamp, signature: null, signingSecret: SECRET, now })).toBe(false)
        expect(verifySlackSignature({ body: BODY, timestamp, signature: sign(BODY, timestamp), signingSecret: '', now })).toBe(false)
        expect(verifySlackSignature({ body: BODY, timestamp: 'not-a-number', signature: sign(BODY, timestamp), signingSecret: SECRET, now })).toBe(false)
    })
})
