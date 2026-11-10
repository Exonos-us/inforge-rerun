import { after } from 'next/server'
import { claimEvent, connectionForTeam, handleSlackMessage, type SlackMessageEvent } from '@/app/api/_services/slack.service'
import { verifySlackSignature } from '@/lib/slack/signature'

// Slack's door. Public and unauthenticated, so the signature is the whole gate: it is checked
// against the workspace's own signing secret before the payload is read for anything else.
//
// Slack gives up on a delivery after 3 seconds and retries it, which a coworker's run would never
// fit inside. So the 200 goes out first and the work runs in `after`.
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 300

const MAX_BODY_BYTES = 1_000_000

type SlackEnvelope = {
    type?: string
    challenge?: string
    team_id?: string
    event_id?: string
    event?: SlackMessageEvent
}

function ok(body: Record<string, unknown> = { ok: true }): Response {
    return Response.json(body, { status: 200 })
}

export async function POST(req: Request): Promise<Response> {
    const raw = await req.text()
    if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) return Response.json({ error: 'Payload too large' }, { status: 413 })

    let envelope: SlackEnvelope
    try {
        envelope = JSON.parse(raw) as SlackEnvelope
    } catch {
        return Response.json({ error: 'Invalid JSON' }, { status: 400 })
    }

    const connection = envelope.team_id ? await connectionForTeam(envelope.team_id) : null
    if (!connection) {
        // Same answer as a bad signature: an unknown team must not learn whether it is known.
        console.warn(`[slack] delivery for an unknown team: ${envelope.team_id ?? 'none'}`)
        return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const verified = verifySlackSignature({
        body: raw,
        timestamp: req.headers.get('x-slack-request-timestamp'),
        signature: req.headers.get('x-slack-signature'),
        signingSecret: connection.signing_secret,
    })
    if (!verified) {
        console.warn('[slack] refused a delivery with a bad signature')
        return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // The handshake Slack runs the moment the Request URL is pasted into the app.
    if (envelope.type === 'url_verification' && envelope.challenge) return ok({ challenge: envelope.challenge })
    if (envelope.type !== 'event_callback' || !envelope.event) return ok()

    const event = envelope.event
    // The app hears its own messages back, and `subtype` covers joins, edits and channel chatter.
    const fromAPerson = (event.type === 'app_mention' || event.type === 'message') && !event.bot_id && !event.subtype && event.user !== connection.bot_user_id
    if (!fromAPerson) return ok()

    // One sentence typed in a channel the app is in arrives twice, as `app_mention` and as
    // `message.channels`, under two different event ids. So the claim is keyed on the message
    // itself — team, channel, timestamp — which is the same in both, and in every retry of either.
    const eventKey = `${envelope.team_id}:${event.channel}:${event.ts}`
    // A retry means the first delivery was never answered in time. The run it started is still
    // going, so answering it again would only double the work.
    if (req.headers.get('x-slack-retry-num')) return ok()
    if (!(await claimEvent(eventKey, envelope.team_id ?? null))) return ok()

    after(async () => {
        try {
            await handleSlackMessage(connection, event, eventKey)
        } catch (err) {
            console.error('[slack] handler failed:', err instanceof Error ? err.message : err)
        }
    })

    return ok()
}

// Slack probes the URL before saving it, and a link scanner may too. Neither should start a run.
export function GET(): Response {
    return new Response(null, { status: 405 })
}
