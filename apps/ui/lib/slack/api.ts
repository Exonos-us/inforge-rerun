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

// Slack takes a JSON body on the methods that write, and only form encoding on the ones that
// read: users.info, users.conversations and conversations.info answer `ok: true` with nothing in
// it when handed JSON, having quietly ignored every argument. Two shapes, one per family, rather
// than one that looks right and returns empty.
const FORM_ENCODED = new Set(['auth.test', 'users.info', 'users.lookupByEmail', 'users.conversations', 'conversations.info', 'conversations.list', 'files.getUploadURLExternal'])

async function call<T>(token: string, method: string, payload: Record<string, unknown>): Promise<T> {
    const form = FORM_ENCODED.has(method)
    const body = form
        ? new URLSearchParams(Object.entries(payload).map(([key, value]) => [key, String(value)])).toString()
        : JSON.stringify(payload)
    const res = await fetch(`${SLACK_API}/${method}`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': form ? 'application/x-www-form-urlencoded; charset=utf-8' : 'application/json; charset=utf-8',
        },
        body,
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
    const body = { channel: params.channel, text: params.text, ...identityFields(params.identity) }
    try {
        const data = await call<{ ts: string }>(token, 'chat.postMessage', { ...body, ...(params.threadTs ? { thread_ts: params.threadTs } : {}) })
        return { ts: data.ts }
    } catch (err) {
        // The thread is gone — someone deleted the message they asked from while the coworker was
        // working on it. An answer in the channel is worth more than no answer at all.
        if (!(err instanceof SlackApiError) || err.code !== 'invalid_thread_ts' || !params.threadTs) throw err
        const data = await call<{ ts: string }>(token, 'chat.postMessage', body)
        return { ts: data.ts }
    }
}

export async function updateMessage(token: string, params: { channel: string; ts: string; text: string; identity?: SlackIdentity }): Promise<void> {
    await call(token, 'chat.update', { channel: params.channel, ts: params.ts, text: params.text, ...identityFields(params.identity) })
}

export async function createChannel(token: string, params: { name: string; isPrivate?: boolean }): Promise<{ id: string; name: string }> {
    const data = await call<{ channel: { id: string; name: string } }>(token, 'conversations.create', { name: params.name, is_private: params.isPrivate ?? false })
    return data.channel
}

// Needs users:read.email, which older installs of the app do not carry: null covers the missing
// scope and the address Slack does not know, and the caller says what to do instead.
export async function findUserByEmail(token: string, email: string): Promise<string | null> {
    try {
        const data = await call<{ user: { id: string } }>(token, 'users.lookupByEmail', { email })
        return data.user.id
    } catch {
        return null
    }
}

export async function inviteToChannel(token: string, channelId: string, userId: string): Promise<void> {
    try {
        await call(token, 'conversations.invite', { channel: channelId, users: userId })
    } catch (err) {
        if (err instanceof SlackApiError && err.code === 'already_in_channel') return
        throw err
    }
}

export type SlackChannel = { id: string; name: string; is_private?: boolean; is_member?: boolean }

// The channels the app can actually answer in: Slack only delivers messages from conversations the
// app is a member of, so anything else in the list would be a dead binding.
export async function listChannels(token: string): Promise<SlackChannel[]> {
    const data = await call<{ channels: SlackChannel[] }>(token, 'users.conversations', { types: 'public_channel,private_channel', exclude_archived: true, limit: 200 })
    return data.channels ?? []
}

// Slack takes a file in three steps: ask for a URL, PUT the bytes there, then say where it goes.
// The last call is what shares it, so a file uploaded without `channel_id` stays invisible.
export async function uploadFile(
    token: string,
    params: { channel: string; threadTs?: string; filename: string; bytes: Uint8Array; title?: string; comment?: string },
): Promise<void> {
    const ticket = await call<{ upload_url: string; file_id: string }>(token, 'files.getUploadURLExternal', { filename: params.filename, length: params.bytes.byteLength })

    const upload = await fetch(ticket.upload_url, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: params.bytes as BodyInit })
    if (!upload.ok) throw new SlackApiError('files.upload', `http_${upload.status}`)

    await call(token, 'files.completeUploadExternal', {
        files: [{ id: ticket.file_id, title: params.title ?? params.filename }],
        channel_id: params.channel,
        ...(params.threadTs ? { thread_ts: params.threadTs } : {}),
        ...(params.comment ? { initial_comment: params.comment } : {}),
    })
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
