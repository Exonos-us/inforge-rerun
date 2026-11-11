import { isReachableFromSlack } from '@/lib/slack/manifest'

// Checking a delivery address by doing what Slack does: POST its url_verification handshake and
// expect the challenge echoed back. A dead tunnel, a rotated ngrok URL and a server that stopped
// listening all fail the same way a real delivery would, which is exactly the question the
// Event deliveries row has to answer.

// Only an address Slack itself could call is worth probing, and only such an address is safe to
// call from the server: https (Slack accepts nothing else), a named host rather than an IP
// literal, and nothing that points back at localhost. The probe body is the public handshake, so
// the far end learns nothing a real Slack delivery would not have told it.
export function probeableRequestUrl(url: string | null | undefined): string | null {
    if (!url) return null
    try {
        const parsed = new URL(url)
        if (parsed.protocol !== 'https:') return null
        if (!isReachableFromSlack(url)) return null
        if (/^\d{1,3}(\.\d{1,3}){3}$/.test(parsed.hostname) || parsed.hostname.startsWith('[')) return null
        return parsed.toString()
    } catch {
        return null
    }
}

export async function probeRequestUrl(url: string, timeoutMs = 3_000): Promise<'ok' | 'unreachable'> {
    const challenge = crypto.randomUUID()
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ type: 'url_verification', challenge }),
            signal: AbortSignal.timeout(timeoutMs),
            redirect: 'manual',
        })
        if (!res.ok) return 'unreachable'
        return (await res.text()).includes(challenge) ? 'ok' : 'unreachable'
    } catch {
        return 'unreachable'
    }
}
