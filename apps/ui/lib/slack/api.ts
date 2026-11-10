// The Slack Web API, the little of it coworkers need: post, edit, create a channel, say who
// someone is. Every call takes the workspace's own bot token — Rerun holds no Slack app of its
// own, so a self-hosted install and Rerun Cloud run the same path.

const SLACK_API = process.env.SLACK_API_BASE || 'https://slack.com/api'

export class SlackApiError extends Error {
    code: string

    constructor(method: string, code: string) {
        super(`Slack refused ${method}: ${code}`)
        this.code = code
    }
}

async function call<T>(token: string, method: string, payload: Record<string, unknown>): Promise<T> {
    const res = await fetch(`${SLACK_API}/${method}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify(payload),
    })
    const data = (await res.json().catch(() => ({ ok: false, error: `http_${res.status}` }))) as { ok: boolean; error?: string } & T
    if (!data.ok) throw new SlackApiError(method, data.error ?? 'unknown_error')
    return data
}

// What makes engineer-1 look like engineer-1 rather than like the app. Slack only honours these
// when the install carries chat:write.customize; without it they are ignored silently, which is
// why the connection records whether the scope is there.
export type SlackIdentity = { name: string; iconEmoji?: string | null; iconUrl?: string | null }

export function identityFields(identity: SlackIdentity | undefined): Record<string, string> {
    if (!identity) return {}
    return {
        username: identity.name,
        ...(identity.iconEmoji ? { icon_emoji: identity.iconEmoji } : {}),
        ...(identity.iconUrl && !identity.iconEmoji ? { icon_url: identity.iconUrl } : {}),
    }
}

export type AuthTest = { team: string; team_id: string; user_id: string; bot_id?: string }

export async function authTest(token: string): Promise<AuthTest> {
    return call<AuthTest>(token, 'auth.test', {})
}

// Slack answers auth.test with the install's scopes in a header, which is the only way to know
// whether the per-coworker name and avatar will be honoured before the first message is sent.
export async function installedScopes(token: string): Promise<string[]> {
    const res = await fetch(`${SLACK_API}/auth.test`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } })
    return (res.headers.get('x-oauth-scopes') ?? '').split(',').map(s => s.trim()).filter(Boolean)
}

export async function postMessage(token: string, params: { channel: string; text: string; threadTs?: string; identity?: SlackIdentity }): Promise<{ ts: string }> {
    const data = await call<{ ts: string }>(token, 'chat.postMessage', {
        channel: params.channel,
        text: params.text,
        ...(params.threadTs ? { thread_ts: params.threadTs } : {}),
        ...identityFields(params.identity),
    })
    return { ts: data.ts }
}

export async function updateMessage(token: string, params: { channel: string; ts: string; text: string; identity?: SlackIdentity }): Promise<void> {
    await call(token, 'chat.update', { channel: params.channel, ts: params.ts, text: params.text, ...identityFields(params.identity) })
}

export async function createChannel(token: string, params: { name: string; isPrivate?: boolean }): Promise<{ id: string; name: string }> {
    const data = await call<{ channel: { id: string; name: string } }>(token, 'conversations.create', { name: params.name, is_private: params.isPrivate ?? false })
    return data.channel
}

export type SlackChannel = { id: string; name: string; is_private?: boolean; is_member?: boolean }

// The channels the app can actually answer in: Slack only delivers messages from conversations the
// app is a member of, so anything else in the list would be a dead binding.
export async function listChannels(token: string): Promise<SlackChannel[]> {
    const data = await call<{ channels: SlackChannel[] }>(token, 'users.conversations', { types: 'public_channel,private_channel', exclude_archived: true, limit: 200 })
    return data.channels ?? []
}

export async function userName(token: string, userId: string): Promise<string> {
    const data = await call<{ user: { name?: string; real_name?: string; profile?: { display_name?: string; real_name?: string } } }>(token, 'users.info', { user: userId })
    return data.user.profile?.display_name || data.user.profile?.real_name || data.user.real_name || data.user.name || userId
}

// Slack's mrkdwn is not markdown: one star is bold, headings do not exist, and a list is a
// character the writer typed. Converting beats a coworker's answer arriving full of raw syntax.
export function toMrkdwn(text: string): string {
    return text
        .replace(/```(\w+)\n/g, '```\n')
        .replace(/^#{1,6}\s*(.+)$/gm, '*$1*')
        .replace(/\*\*(.+?)\*\*/g, '*$1*')
        .replace(/^\s*[-*]\s+/gm, '• ')
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<$2|$1>')
        .trim()
}

// Slack caps a message at 4000 characters and silently truncates past it.
export const MAX_MESSAGE_CHARS = 3900

export function fitMessage(text: string): string {
    return text.length <= MAX_MESSAGE_CHARS ? text : `${text.slice(0, MAX_MESSAGE_CHARS)}\n\n_…cut here. The whole answer is in Rerun._`
}

// The app the workspace creates for itself. Handed to Slack as a manifest so the scopes, the
// events and the request URL are already right: the user presses Create, then Install, and
// copies two values back. Nothing in it is Rerun-specific except the URL.
export function appManifest(requestUrl: string, name = 'Rerun'): Record<string, unknown> {
    return {
        display_information: { name, description: 'Your Rerun coworkers, in Slack', background_color: '#1d1c1d' },
        features: { bot_user: { display_name: name, always_online: true } },
        oauth_config: {
            scopes: {
                bot: [
                    'app_mentions:read',
                    'channels:history',
                    'channels:read',
                    'channels:manage',
                    'groups:history',
                    'groups:read',
                    'groups:write',
                    'im:history',
                    'chat:write',
                    'chat:write.customize',
                    'users:read',
                ],
            },
        },
        settings: {
            event_subscriptions: { request_url: requestUrl, bot_events: ['app_mention', 'message.channels', 'message.groups', 'message.im'] },
            org_deploy_enabled: false,
            socket_mode_enabled: false,
        },
    }
}

// Slack's "create an app from a manifest" deep link. One click from Rerun instead of a page of
// instructions: the app opens already configured, waiting to be created.
export function createAppUrl(requestUrl: string, name?: string): string {
    return `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(appManifest(requestUrl, name)))}`
}
