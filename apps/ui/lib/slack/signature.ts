import { createHmac, timingSafeEqual } from 'node:crypto'

// Slack signs every delivery with the app's signing secret over `v0:<timestamp>:<raw body>`. The
// endpoint is public and unauthenticated, so this check is the whole door: it runs before the
// payload is parsed, let alone acted on.
//
// The five-minute window is Slack's own recommendation and is what makes a captured delivery
// useless after the fact. Replays inside it are caught by the event id, not here.
export const MAX_SKEW_SECONDS = 300

export function verifySlackSignature(params: { body: string; timestamp: string | null; signature: string | null; signingSecret: string; now?: number }): boolean {
    const { body, timestamp, signature, signingSecret } = params
    if (!timestamp || !signature || !signingSecret) return false

    const sentAt = Number(timestamp)
    if (!Number.isFinite(sentAt)) return false
    const now = params.now ?? Date.now() / 1000
    if (Math.abs(now - sentAt) > MAX_SKEW_SECONDS) return false

    const expected = `v0=${createHmac('sha256', signingSecret).update(`v0:${timestamp}:${body}`).digest('hex')}`
    const a = Buffer.from(expected, 'utf8')
    const b = Buffer.from(signature, 'utf8')
    return a.length === b.length && timingSafeEqual(a, b)
}

// A Slack signing secret is 32 hexadecimal characters, and it sits on the same page as the client
// secret, the client id and the app-level token. Pasting a neighbour is the easy mistake, and its
// only symptom is silence: Slack calls, every delivery fails its signature, and nothing in the
// channel says why. Cheaper to refuse it at the form.
export function looksLikeSigningSecret(value: string): boolean {
    return /^[0-9a-f]{32}$/i.test(value.trim())
}
