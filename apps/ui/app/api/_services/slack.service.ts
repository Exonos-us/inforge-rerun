import 'server-only'

import type { Database } from '@/app/api/database.types'
import { ensureSessionRow } from '@/app/api/_services/chat.service'
import { getWorkspaceConnection } from '@/app/api/_services/workspace-engine.service'
import { chat, getRun, getRunTools, listFiles, readFileBytes } from '@/lib/engine/client'
import { authTest, fitMessage, installedScopes, listChannels, postMessage, toMrkdwn, updateMessage, uploadFile, userName, type SlackIdentity } from '@/lib/slack/api'
import { attachmentComment, attachmentsFor, type WorkspaceFile } from '@/lib/slack/attachments'
import { looksLikeSigningSecret } from '@/lib/slack/signature'
import { createServiceRoleClient } from '@/supabase/serviceRole'
import { selectMany, selectManyWithJoins, selectMaybeSingle } from '@/supabase/supabase-helpers'

type ConnectionInsert = Database['public']['Tables']['slack_connections']['Insert']
type ConnectionUpdate = Database['public']['Tables']['slack_connections']['Update']
type BindingInsert = Database['public']['Tables']['slack_channel_agents']['Insert']
type ThreadInsert = Database['public']['Tables']['slack_threads']['Insert']
type ThreadUpdate = Database['public']['Tables']['slack_threads']['Update']
type EventInsert = Database['public']['Tables']['slack_events']['Insert']
type EventUpdate = Database['public']['Tables']['slack_events']['Update']

const CONNECTION_COLUMNS = ['id', 'workspace_id', 'team_id', 'team_name', 'bot_user_id', 'bot_token', 'signing_secret', 'can_customize_identity', 'status', 'last_event_at', 'last_signature_error_at', 'request_url'] as const

export type SlackConnection = Pick<Database['public']['Tables']['slack_connections']['Row'], (typeof CONNECTION_COLUMNS)[number]>
// The same row minus the two secrets, which never travel to a browser.
export type PublicSlackConnection = Omit<SlackConnection, 'bot_token' | 'signing_secret'>

// How long the coworker may take before the thread is told it gave up. Slack has long stopped
// waiting for the HTTP response by then: what holds the exchange open is the placeholder message.
const RUN_TIMEOUT_MS = 10 * 60_000
const POLL_MS = 2_000
const PULSE_EVERY_MS = 8_000

// --- the connection -----------------------------------------------------------------------

// Secrets included: only the webhook and the server actions call this.
export async function connectionForTeam(teamId: string): Promise<SlackConnection | null> {
    const { data } = await selectMaybeSingle(createServiceRoleClient(), 'slack_connections', CONNECTION_COLUMNS, { team_id: teamId })
    return data ?? null
}

export async function connectionForWorkspace(workspaceId: number): Promise<SlackConnection | null> {
    const { data } = await selectMaybeSingle(createServiceRoleClient(), 'slack_connections', CONNECTION_COLUMNS, { workspace_id: workspaceId })
    return data ?? null
}

// What the dialog is allowed to see. The bot token and the signing secret never leave the server.
export function publicView(connection: SlackConnection | null): PublicSlackConnection | null {
    if (!connection) return null
    return {
        id: connection.id,
        workspace_id: connection.workspace_id,
        team_id: connection.team_id,
        team_name: connection.team_name,
        bot_user_id: connection.bot_user_id,
        can_customize_identity: connection.can_customize_identity,
        status: connection.status,
        last_event_at: connection.last_event_at,
        last_signature_error_at: connection.last_signature_error_at,
        request_url: connection.request_url,
    }
}

export type ConnectResult = { ok: true; teamName: string; canCustomizeIdentity: boolean } | { ok: false; error: string }

// Saving the two values the user copied out of their new Slack app. The token is checked against
// Slack before anything is written: a typo here would otherwise only surface as silence in a
// channel days later.
export async function connectSlack(params: { workspaceId: number; userId: string; botToken: string; signingSecret: string; requestUrl?: string | null }): Promise<ConnectResult> {
    const token = params.botToken.trim()
    const secret = params.signingSecret.trim()
    if (!token.startsWith('xoxb-')) return { ok: false, error: 'That is not a bot token — it should start with xoxb-. Copy it from OAuth & Permissions → Bot User OAuth Token.' }
    if (!looksLikeSigningSecret(secret))
        return {
            ok: false,
            error: `That is not the signing secret — it is 32 hexadecimal characters, and what you pasted is ${secret.length}. Basic Information → App Credentials → Signing Secret → Show. The client secret and the app token sit right beside it.`,
        }

    let identity: Awaited<ReturnType<typeof authTest>>
    try {
        identity = await authTest(token)
    } catch (err) {
        return { ok: false, error: `Slack refused the token (${err instanceof Error ? err.message : 'unknown error'}). Reinstall the app and copy it again.` }
    }

    const scopes = await installedScopes(token).catch(() => [] as string[])
    const supabase = createServiceRoleClient()
    const { error } = await supabase.from('slack_connections').upsert<ConnectionInsert>(
        {
            workspace_id: params.workspaceId,
            team_id: identity.team_id,
            team_name: identity.team,
            bot_user_id: identity.user_id,
            bot_token: token,
            signing_secret: secret,
            can_customize_identity: scopes.includes('chat:write.customize'),
            connected_by: params.userId,
            status: 'connected',
            // The address the Slack app was created with: the one Slack calls, not necessarily
            // the one this app is read on. Kept so the screen can probe it later.
            request_url: params.requestUrl?.trim() || null,
            updated_at: new Date().toISOString(),
        },
        { onConflict: 'workspace_id' },
    )
    if (error) return { ok: false, error: error.message }
    return { ok: true, teamName: identity.team, canCustomizeIdentity: scopes.includes('chat:write.customize') }
}

// Replacing the secret, not the connection. Disconnecting would take the channel bindings with
// it (they hang off the connection row), and losing which coworkers are in which channels is a
// steep price for fixing a value that was mistyped once.
export async function replaceSigningSecret(workspaceId: number, signingSecret: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const secret = signingSecret.trim()
    if (!looksLikeSigningSecret(secret)) return { ok: false, error: 'A signing secret is 32 characters, digits and a–f. Basic Information → App Credentials → Signing Secret → Show.' }

    const { error } = await createServiceRoleClient()
        .from('slack_connections')
        .update<ConnectionUpdate>({ signing_secret: secret, last_signature_error_at: null, updated_at: new Date().toISOString() })
        .eq('workspace_id', workspaceId)
    return error ? { ok: false, error: error.message } : { ok: true }
}

// The delivery address alone, for the connection that predates it being stored or whose tunnel
// changed. Nothing else moves: token, secret and channels stay exactly as they are.
export async function saveRequestUrl(workspaceId: number, requestUrl: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const { error } = await createServiceRoleClient()
        .from('slack_connections')
        .update<ConnectionUpdate>({ request_url: requestUrl, updated_at: new Date().toISOString() })
        .eq('workspace_id', workspaceId)
    return error ? { ok: false, error: error.message } : { ok: true }
}

export async function disconnectSlack(workspaceId: number): Promise<void> {
    await createServiceRoleClient().from('slack_connections').delete().eq('workspace_id', workspaceId)
}

// Stamped by the webhook so the Slack screen can say what is happening instead of leaving the
// user with a coworker that does not answer. A refused delivery is almost always the signing
// secret: Slack found the workspace, so the team id was right, and only the signature failed.
export async function noteSignatureFailure(connectionId: string): Promise<void> {
    await createServiceRoleClient()
        .from('slack_connections')
        .update<ConnectionUpdate>({ last_signature_error_at: new Date().toISOString() })
        .eq('id', connectionId)
}

export async function slackChannels(connection: SlackConnection) {
    return listChannels(connection.bot_token)
}

// --- bindings -----------------------------------------------------------------------------

const BINDING_COLUMNS = ['id', 'channel_id', 'channel_name', 'agent_id', 'display_name', 'icon_emoji', 'icon_url'] as const

export type ChannelBinding = {
    id: string
    channelId: string
    channelName: string | null
    agentId: string
    engineAgentId: string | null
    disabled: boolean
    name: string
    identity: SlackIdentity
}

async function bindingsOf(connectionId: string, channelId?: string): Promise<ChannelBinding[]> {
    const { data } = await selectManyWithJoins(
        createServiceRoleClient(),
        'slack_channel_agents',
        BINDING_COLUMNS,
        { agent: { table: 'agents', foreignKey: 'agents!slack_channel_agents_agent_id_fkey', columns: ['name', 'engine_agent_id', 'disabled_at'] } } as const,
        { connection_id: connectionId, ...(channelId ? { channel_id: channelId } : {}) },
    )
    return (data ?? []).map(row => {
        const name = row.display_name || row.agent?.name || 'coworker'
        return {
            id: row.id,
            channelId: row.channel_id,
            channelName: row.channel_name,
            agentId: row.agent_id,
            engineAgentId: row.agent?.engine_agent_id ?? null,
            disabled: Boolean(row.agent?.disabled_at),
            name,
            identity: { name, iconEmoji: row.icon_emoji, iconUrl: row.icon_url },
        }
    })
}

export async function listBindings(connectionId: string): Promise<ChannelBinding[]> {
    return bindingsOf(connectionId)
}

// The channels one coworker answers in, for its own card. Scoped to the workspace's connection so
// a coworker never reports a binding that belongs to another workspace.
export async function bindingsForAgent(connectionId: string, agentId: string): Promise<ChannelBinding[]> {
    return (await bindingsOf(connectionId)).filter(binding => binding.agentId === agentId)
}

// The name and the face a coworker wears in one channel. Both are per channel on purpose: the
// same coworker can be "engineer-1" with a wrench in #mdc-code and something plainer elsewhere.
export async function updateBinding(bindingId: string, fields: { displayName?: string | null; iconEmoji?: string | null }): Promise<void> {
    const supabase = createServiceRoleClient()
    const { error } = await supabase
        .from('slack_channel_agents')
        .update<Database['public']['Tables']['slack_channel_agents']['Update']>({
            ...(fields.displayName !== undefined ? { display_name: fields.displayName } : {}),
            ...(fields.iconEmoji !== undefined ? { icon_emoji: fields.iconEmoji } : {}),
            updated_at: new Date().toISOString(),
        })
        .eq('id', bindingId)
    if (error) throw new Error(error.message)
}

export async function bindCoworker(params: { connectionId: string; channelId: string; channelName?: string | null; agentId: string; displayName?: string | null; iconEmoji?: string | null }): Promise<void> {
    const supabase = createServiceRoleClient()
    const { error } = await supabase.from('slack_channel_agents').upsert<BindingInsert>(
        {
            connection_id: params.connectionId,
            channel_id: params.channelId,
            channel_name: params.channelName ?? null,
            agent_id: params.agentId,
            display_name: params.displayName ?? null,
            icon_emoji: params.iconEmoji ?? null,
            updated_at: new Date().toISOString(),
        },
        { onConflict: 'connection_id,channel_id,agent_id' },
    )
    if (error) throw new Error(error.message)
}

export async function unbindCoworker(bindingId: string): Promise<void> {
    await createServiceRoleClient().from('slack_channel_agents').delete().eq('id', bindingId)
}

// --- deliveries ---------------------------------------------------------------------------

// Slack retries anything it does not hear back from in three seconds, and it answers before the
// coworker does: without this, one message would start two runs.
export async function claimEvent(eventId: string, teamId: string | null): Promise<boolean> {
    const supabase = createServiceRoleClient()
    const { error } = await supabase.from('slack_events').insert<EventInsert>({ event_id: eventId, team_id: teamId })
    if (!error) return true
    const { data } = await selectMaybeSingle(supabase, 'slack_events', ['processed_at'] as const, { event_id: eventId })
    // A delivery whose handler crashed before stamping is worth running again; one already
    // answered is not.
    return !data?.processed_at
}

async function markEventProcessed(eventId: string): Promise<void> {
    await createServiceRoleClient().from('slack_events').update<EventUpdate>({ processed_at: new Date().toISOString() }).eq('event_id', eventId)
}

// --- the loop -----------------------------------------------------------------------------

export type SlackMessageEvent = {
    type: string
    channel?: string
    user?: string
    text?: string
    ts?: string
    thread_ts?: string
    bot_id?: string
    subtype?: string
}

// Who, if anyone, a channel message is for. Answering is earned, never the default: people talk
// to each other in these channels too, and a bot that butts in reads as a machine. A coworker
// speaks when it is named, when the thread is already its conversation, or when it is alone in
// the channel and nobody else was addressed. Naming several coworkers in one message convenes
// them: each answers, each may react once, and the first named closes with the result. "Who
// should take this" is only worth asking when the app itself was mentioned: the person called,
// and several could pick up.
export type SlackRouting = { kind: 'answer'; binding: ChannelBinding } | { kind: 'convene'; bindings: ChannelBinding[] } | { kind: 'ask_who' } | { kind: 'silent' }

export function routeMessage(params: {
    bindings: ChannelBinding[]
    text: string
    // The coworker already holding this thread, from its slack_threads row.
    threadAgentId?: string | null
    // The message sits in a thread no coworker ever answered in: someone else's conversation.
    inForeignThread?: boolean
    botUserId?: string | null
}): SlackRouting {
    const { bindings, text } = params

    // `(?![\w-])` rather than `\b`: a name can end in a character that is not a word character
    // ("c++"), where `\b` would never match, and it still keeps "engineer-1" from matching
    // "engineer-10". Kept in the order they were named: the first named leads a convened group.
    const named = bindings
        .map(binding => ({ binding, at: text.search(new RegExp(`(^|[^\\w-])@?${binding.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`, 'i')) }))
        .filter(hit => hit.at >= 0)
        .sort((a, b) => a.at - b.at)
        .map(hit => hit.binding)
    if (named.length === 1) return { kind: 'answer', binding: named[0] }
    if (named.length > 1) return { kind: 'convene', bindings: named }

    const threadBinding = params.threadAgentId ? (bindings.find(b => b.agentId === params.threadAgentId) ?? null) : null

    if (params.botUserId && text.includes(`<@${params.botUserId}>`)) {
        if (threadBinding) return { kind: 'answer', binding: threadBinding }
        if (bindings.length === 1) return { kind: 'answer', binding: bindings[0] }
        return { kind: 'ask_who' }
    }

    // "Mira ese thread <@U_JAHIR>": a person was pulled in, and the message is theirs to answer —
    // even inside a coworker's own thread, and even when that coworker is alone in the channel.
    const mentionsAPerson = [...text.matchAll(/<@([A-Z0-9_]+)>/g)].some(mention => mention[1] !== params.botUserId)
    if (mentionsAPerson) return { kind: 'silent' }

    // A thread row whose owner is no longer bound here: that conversation left with it. The other
    // coworkers were never part of it, so nobody picks it up uninvited.
    if (params.threadAgentId) return threadBinding ? { kind: 'answer', binding: threadBinding } : { kind: 'silent' }
    if (params.inForeignThread) return { kind: 'silent' }
    if (bindings.length === 1) return { kind: 'answer', binding: bindings[0] }
    return { kind: 'silent' }
}

// The app mention and the coworker's name are how you address someone, not part of what you asked.
export function cleanMessage(text: string, name: string): string {
    return text
        .replace(/<@[A-Z0-9]+>/g, ' ')
        .replace(new RegExp(`^\\s*@?${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[:,—-]?\\s*`, 'i'), '')
        .trim()
}

async function threadOf(connectionId: string, channelId: string, threadTs: string) {
    const { data } = await selectMaybeSingle(createServiceRoleClient(), 'slack_threads', ['agent_id', 'engine_session_id'] as const, { connection_id: connectionId, channel_id: channelId, thread_ts: threadTs })
    return data ?? null
}

async function rememberThread(params: { connectionId: string; channelId: string; threadTs: string; agentId: string; engineSessionId: string; sessionId: string | null }): Promise<void> {
    const supabase = createServiceRoleClient()
    const { error } = await supabase.from('slack_threads').upsert<ThreadInsert>(
        {
            connection_id: params.connectionId,
            channel_id: params.channelId,
            thread_ts: params.threadTs,
            agent_id: params.agentId,
            engine_session_id: params.engineSessionId,
            session_id: params.sessionId,
            updated_at: new Date().toISOString(),
        },
        { onConflict: 'connection_id,channel_id,thread_ts' },
    )
    if (error) console.error('[slack] could not remember the thread', error.message)
}

// The placeholder is rewritten from the run's own tool calls, so a long task shows a pulse
// instead of three minutes of nothing. Cheap: no streaming API, no Slack plan requirement.
async function waitForAnswer(params: { conn: Awaited<ReturnType<typeof getWorkspaceConnection>>; engineAgentId: string; runId: string; onPulse: (text: string) => Promise<void>; timeoutMs?: number }): Promise<string> {
    const startedAt = Date.now()
    const timeoutMs = params.timeoutMs ?? RUN_TIMEOUT_MS
    let lastPulse = Date.now()
    for (;;) {
        const run = await getRun(params.conn, params.engineAgentId, params.runId)
        if (run.status === 'done') return run.output?.trim() || '_(the run finished without saying anything)_'
        if (run.status === 'error') throw new Error(run.error || 'the run failed')
        if (run.status === 'cancelled') throw new Error('the run was stopped from Rerun')
        if (Date.now() - startedAt > timeoutMs) throw new Error(`still working after ${Math.round(timeoutMs / 60_000)} minutes — the answer will be in Rerun`)

        if (Date.now() - lastPulse > PULSE_EVERY_MS) {
            lastPulse = Date.now()
            const tools = await getRunTools(params.conn, params.engineAgentId, params.runId).catch(() => [])
            const seconds = Math.round((Date.now() - startedAt) / 1000)
            await params.onPulse(`_working… ${seconds}s${tools.length ? `, ${tools.length} tool${tools.length > 1 ? 's' : ''} so far` : ''}_`)
        }
        await new Promise(resolve => setTimeout(resolve, POLL_MS))
    }
}

// What the coworker wrote while it was answering. Walked rather than watched: the engine has no
// "files changed in this run", and one shallow pass over the workspace costs less than teaching
// it one. Three levels deep covers where deliverables actually land — a recording in
// screen/<session>/, a build in <project>/out/ — while anything buried further was not meant for
// a chat.
const WALK_DEPTH = 3
const WALK_MAX_LISTINGS = 20

async function walkWorkspace(conn: Awaited<ReturnType<typeof getWorkspaceConnection>>, engineAgentId: string): Promise<WorkspaceFile[]> {
    const base = `/agents/${encodeURIComponent(engineAgentId)}/files`
    const found: WorkspaceFile[] = []
    let folders = ['']
    let listings = 0

    for (let depth = 0; depth < WALK_DEPTH && folders.length > 0 && listings < WALK_MAX_LISTINGS; depth++) {
        const batch = folders.slice(0, WALK_MAX_LISTINGS - listings)
        listings += batch.length
        const listed = await Promise.all(
            batch.map(async folder => ({ folder, entries: await listFiles(conn, base, folder || '.').catch(() => []) })),
        )
        const next: string[] = []
        for (const { folder, entries } of listed) {
            for (const entry of entries) {
                if (entry.name.startsWith('.')) continue
                const path = folder ? `${folder}/${entry.name}` : entry.name
                if (entry.type === 'dir') next.push(path)
                else found.push({ path, name: entry.name, size: entry.size, modifiedAt: entry.modifiedAt ?? null })
            }
        }
        folders = next
    }

    return found
}

// Posting is best-effort on purpose: the answer is already in the channel, and an install without
// files:write (or a file that vanished between the walk and the read) must not turn a finished
// run into an error in the thread.
async function postAttachments(params: {
    token: string
    conn: Awaited<ReturnType<typeof getWorkspaceConnection>>
    engineAgentId: string
    channel: string
    threadTs: string
    since: Date
    answer: string
    from: string
}): Promise<number> {
    const walked = await walkWorkspace(params.conn, params.engineAgentId).catch(() => [] as WorkspaceFile[])
    const files = attachmentsFor({ answer: params.answer, files: walked, since: params.since })
    let posted = 0
    for (const file of files) {
        try {
            const bytes = await readFileBytes(params.conn, `/agents/${encodeURIComponent(params.engineAgentId)}/files`, file.path)
            await uploadFile(params.token, { channel: params.channel, threadTs: params.threadTs, filename: file.name, bytes, comment: attachmentComment(file, params.from) })
            posted += 1
        } catch (err) {
            const why = err instanceof Error ? err.message : String(err)
            console.warn(`[slack] could not post ${file.path}: ${why}`)
            // A missing scope fails every file the same way, so stop rather than retry five times.
            if (why.includes('missing_scope') || why.includes('not_allowed_token_type')) break
        }
    }
    return posted
}

// --- several coworkers convened in one thread -----------------------------------------------

// The same collaboration coworkers already have inside Rerun, made visible in Slack: each takes
// the ask, each gets one chance to react to the others, and the first named closes with the
// result. Every turn is driven from here, sequentially — the webhook stays deaf to bot messages,
// so two coworkers can never ping-pong each other into a loop.
const MAX_CONVENED = 3
const COLLAB_TURN_TIMEOUT_MS = 4 * 60_000

// Slack already names the author on every message: a signed-off message reads like an email
// pasted into a chat.
const SLACK_TURN_RULES = 'Slack shows your name on the message, so never sign off with it. Answer in the language of the request.'

// The reaction round is an offer, not an obligation: a coworker with nothing to add says PASS and
// nothing is posted for it.
export function isCollabPass(answer: string): boolean {
    return /^[\s_*`>]*pass[\s_*`.!]*$/i.test(answer.trim())
}

type CollabSeat = { binding: ChannelBinding; engineSessionId: string | null; answer: string | null }

async function startRun(conn: Awaited<ReturnType<typeof getWorkspaceConnection>>, engineAgentId: string, message: string, sessionId: string | undefined, author: { id: string; name: string }): Promise<{ runId: string; engineSessionId: string }> {
    // `source: 'api'` because the engine's contract has no 'slack' yet: adding one means a new
    // value in its enum, and a hub ahead of its engine would get a 400 on every message.
    const res = await chat(conn, engineAgentId, { message, sessionId, source: 'api', author })
    if (!res.ok) throw new Error(`the coworker could not be reached (${res.status})`)
    const runId = res.headers.get('x-run-id')
    const engineSessionId = res.headers.get('x-session-id') ?? sessionId ?? null
    // The engine buffers the run, so dropping the stream here reads as one subscriber leaving.
    await res.body?.cancel().catch(() => {})
    if (!runId || !engineSessionId) throw new Error('the engine started the run without naming it')
    return { runId, engineSessionId }
}

async function collabTurn(params: {
    connection: SlackConnection
    conn: Awaited<ReturnType<typeof getWorkspaceConnection>>
    channelId: string
    threadTs: string
    seat: CollabSeat
    prompt: string
    author: { id: string; name: string }
    // A quiet turn posts only a substantive answer: no placeholder, and a PASS leaves no trace.
    quiet?: boolean
}): Promise<string | null> {
    const { connection, conn, channelId, threadTs, seat } = params
    const token = connection.bot_token
    const identity = connection.can_customize_identity ? seat.binding.identity : undefined
    const startedAt = new Date()
    const placeholder = params.quiet ? null : await postMessage(token, { channel: channelId, threadTs, text: '_on it…_', identity })

    try {
        const { runId, engineSessionId } = await startRun(conn, seat.binding.engineAgentId as string, params.prompt, seat.engineSessionId ?? undefined, params.author)
        if (!seat.engineSessionId) await ensureSessionRow(seat.binding.agentId, engineSessionId, params.prompt, { source: 'api', status: 'working' })
        seat.engineSessionId = engineSessionId

        const answer = await waitForAnswer({
            conn,
            engineAgentId: seat.binding.engineAgentId as string,
            runId,
            timeoutMs: COLLAB_TURN_TIMEOUT_MS,
            onPulse: pulse => (placeholder ? updateMessage(token, { channel: channelId, ts: placeholder.ts, text: pulse, identity }).catch(() => {}) : Promise.resolve()),
        })

        if (params.quiet && isCollabPass(answer)) return null
        if (placeholder) await updateMessage(token, { channel: channelId, ts: placeholder.ts, text: fitMessage(toMrkdwn(answer)), identity })
        else await postMessage(token, { channel: channelId, threadTs, text: fitMessage(toMrkdwn(answer)), identity })

        const posted = await postAttachments({ token, conn, engineAgentId: seat.binding.engineAgentId as string, channel: channelId, threadTs, since: startedAt, answer, from: seat.binding.name })
        if (posted) console.info(`[slack] ${seat.binding.name} posted ${posted} file(s) to ${channelId}`)
        return answer
    } catch (err) {
        const why = err instanceof Error ? err.message : String(err)
        console.error(`[slack] ${seat.binding.name} could not take its turn:`, why)
        if (placeholder) await updateMessage(token, { channel: channelId, ts: placeholder.ts, text: `:warning: ${why}`, identity }).catch(() => {})
        return null
    }
}

async function runCollab(params: {
    connection: SlackConnection
    conn: Awaited<ReturnType<typeof getWorkspaceConnection>>
    channelId: string
    threadTs: string
    text: string
    author: { id: string; name: string }
    bindings: ChannelBinding[]
}): Promise<void> {
    const { connection, conn, channelId, threadTs, author } = params
    const token = connection.bot_token
    const invited = params.bindings.slice(0, MAX_CONVENED)
    const seats: CollabSeat[] = invited.filter(binding => !binding.disabled && binding.engineAgentId).map(binding => ({ binding, engineSessionId: null, answer: null }))

    for (const off of invited.filter(binding => binding.disabled || !binding.engineAgentId)) {
        await postMessage(token, { channel: channelId, threadTs, text: `_${off.name} is switched off in Rerun right now._`, identity: connection.can_customize_identity ? off.identity : undefined }).catch(() => {})
    }
    if (seats.length === 0) return
    const channelName = `#${seats[0].binding.channelName ?? channelId}`
    const message = params.text.replace(/<@[A-Z0-9_]+>/g, ' ').replace(/[ \t]+/g, ' ').trim()

    // Round 1: everyone takes the ask, knowing the others are on it too.
    for (const seat of seats) {
        const others = seats.filter(other => other !== seat).map(other => other.binding.name)
        const prompt = [
            `[Slack] ${author.name} wrote in ${channelName}, to you and ${others.join(' and ')} together:`,
            '',
            message,
            '',
            `If this asks for work your tools can do now, do it in this turn and answer with what you actually did — a result, not a plan. Otherwise give your take, Slack-sized (a few sentences). You have not seen what ${others.join(' and ')} will answer, so do not quote or anticipate them — once everyone has answered you will get one short chance to react. ${SLACK_TURN_RULES}`,
        ].join('\n')
        seat.answer = await collabTurn({ connection, conn, channelId, threadTs, seat, prompt, author })
    }

    const active = seats.filter(seat => seat.answer !== null)
    if (active.length < 2) {
        const lead = active[0] ?? null
        if (lead?.engineSessionId) await rememberThread({ connectionId: connection.id, channelId, threadTs, agentId: lead.binding.agentId, engineSessionId: lead.engineSessionId, sessionId: null })
        return
    }

    // One reaction each, in the open. Later seats also see the reactions already given, so the
    // exchange reads as a conversation rather than parallel monologues.
    const reactions: { name: string; text: string }[] = []
    for (const seat of active) {
        const heard = [
            ...active.filter(other => other !== seat).map(other => `${other.binding.name}: ${other.answer as string}`),
            ...reactions.filter(reaction => reaction.name !== seat.binding.name).map(reaction => `${reaction.name} (follow-up): ${reaction.text}`),
        ].join('\n\n')
        const prompt = [
            'The others have answered in the thread:',
            '',
            heard,
            '',
            `One short follow-up: react only if it changes or sharpens the result — a disagreement, a correction, a build. If you have nothing useful to add, reply exactly PASS. ${SLACK_TURN_RULES}`,
        ].join('\n')
        const reaction = await collabTurn({ connection, conn, channelId, threadTs, seat, prompt, author, quiet: true })
        if (reaction) reactions.push({ name: seat.binding.name, text: reaction })
    }

    // The first named closes, but only when the reactions moved something: two clean answers with
    // nothing to add need no third message repeating them.
    const lead = active[0]
    if (reactions.length > 0) {
        const prompt = [
            ...(reactions.some(reaction => reaction.name !== lead.binding.name)
                ? ['Follow-ups since your last message:', '', reactions.filter(r => r.name !== lead.binding.name).map(r => `${r.name}: ${r.text}`).join('\n\n'), '']
                : []),
            `If the group agreed on work that is yours and still undone, do it now, in this turn. Then close the thread for ${author.name}: one short message with the result the group landed on — name the files you produced so they travel with your message. Name any point still in disagreement. Do not repeat what was already said. ${SLACK_TURN_RULES}`,
        ].join('\n')
        await collabTurn({ connection, conn, channelId, threadTs, seat: lead, prompt, author })
    }

    // Unnamed follow-ups in this thread go to the lead; naming another convened coworker hands it
    // over, as in any thread.
    if (lead.engineSessionId) await rememberThread({ connectionId: connection.id, channelId, threadTs, agentId: lead.binding.agentId, engineSessionId: lead.engineSessionId, sessionId: null })
}

export async function handleSlackMessage(connection: SlackConnection, event: SlackMessageEvent, eventId: string): Promise<void> {
    const channelId = event.channel
    const text = event.text ?? ''
    if (!channelId || !event.ts) return

    const threadTs = event.thread_ts || event.ts
    const [bindings, thread] = await Promise.all([bindingsOf(connection.id, channelId), threadOf(connection.id, channelId, threadTs)])
    if (bindings.length === 0) return

    const routing = routeMessage({
        bindings,
        text,
        threadAgentId: thread?.agent_id ?? null,
        inForeignThread: Boolean(event.thread_ts) && !thread,
        botUserId: connection.bot_user_id,
    })
    const token = connection.bot_token

    if (routing.kind === 'silent') {
        await markEventProcessed(eventId)
        return
    }

    if (routing.kind === 'ask_who') {
        await postMessage(token, {
            channel: channelId,
            threadTs,
            text: `Who should take this — ${bindings.map(b => `*${b.name}*`).join(' or ')}? Put the name at the start of the message.`,
            identity: { name: 'Rerun', iconEmoji: ':robot_face:' },
        })
        await markEventProcessed(eventId)
        return
    }

    if (routing.kind === 'convene') {
        try {
            const conn = await getWorkspaceConnection(connection.workspace_id)
            const author = { id: event.user ?? 'slack', name: event.user ? await userName(token, event.user).catch(() => 'a Slack teammate') : 'a Slack teammate' }
            await runCollab({ connection, conn, channelId, threadTs, text, author, bindings: routing.bindings })
        } catch (err) {
            const why = err instanceof Error ? err.message : String(err)
            console.error('[slack] the convened coworkers could not answer:', why)
            await postMessage(token, { channel: channelId, threadTs, text: `:warning: ${why}`, identity: { name: 'Rerun', iconEmoji: ':robot_face:' } }).catch(() => {})
        } finally {
            await markEventProcessed(eventId)
            await createServiceRoleClient().from('slack_connections').update<ConnectionUpdate>({ last_event_at: new Date().toISOString(), last_signature_error_at: null }).eq('id', connection.id)
        }
        return
    }

    const binding = routing.binding

    const message = cleanMessage(text, binding.name)
    if (!message) return
    const identity = connection.can_customize_identity ? binding.identity : undefined

    if (binding.disabled || !binding.engineAgentId) {
        await postMessage(token, { channel: channelId, threadTs, text: `_${binding.name} is switched off in Rerun right now._`, identity })
        await markEventProcessed(eventId)
        return
    }

    const placeholder = await postMessage(token, { channel: channelId, threadTs, text: '_on it…_', identity })

    const runStartedAt = new Date()
    try {
        const conn = await getWorkspaceConnection(connection.workspace_id)
        const author = { id: event.user ?? 'slack', name: event.user ? await userName(token, event.user).catch(() => 'a Slack teammate') : 'a Slack teammate' }
        // An engine session belongs to one agent: when a thread is handed to another coworker by
        // naming it, the old session would 404 under the new agent, so the newcomer starts fresh.
        const inheritedSessionId = thread && thread.agent_id === binding.agentId ? (thread.engine_session_id ?? undefined) : undefined
        const { runId, engineSessionId } = await startRun(conn, binding.engineAgentId, message, inheritedSessionId, author)

        const sessionId = await ensureSessionRow(binding.agentId, engineSessionId, message, { source: 'api', status: 'working' })
        await rememberThread({ connectionId: connection.id, channelId, threadTs, agentId: binding.agentId, engineSessionId, sessionId })

        const answer = await waitForAnswer({
            conn,
            engineAgentId: binding.engineAgentId,
            runId,
            onPulse: pulse => updateMessage(token, { channel: channelId, ts: placeholder.ts, text: pulse, identity }).catch(() => {}),
        })
        await updateMessage(token, { channel: channelId, ts: placeholder.ts, text: fitMessage(toMrkdwn(answer)), identity })

        // Whatever it made while answering goes in under its own answer: a report, a sheet, a
        // screen recording. Described in the text, handed over as a file.
        const posted = await postAttachments({ token, conn, engineAgentId: binding.engineAgentId, channel: channelId, threadTs, since: runStartedAt, answer, from: binding.name })
        if (posted) console.info(`[slack] ${binding.name} posted ${posted} file(s) to ${channelId}`)
    } catch (err) {
        const why = err instanceof Error ? err.message : String(err)
        console.error(`[slack] ${binding.name} could not answer:`, why)
        await updateMessage(token, { channel: channelId, ts: placeholder.ts, text: `:warning: ${why}`, identity }).catch(() => {})
    } finally {
        await markEventProcessed(eventId)
        await createServiceRoleClient().from('slack_connections').update<ConnectionUpdate>({ last_event_at: new Date().toISOString(), last_signature_error_at: null }).eq('id', connection.id)
    }
}

// --- the coworkers a workspace can put in a channel -----------------------------------------

export async function workspaceCoworkers(workspaceId: number) {
    const { data } = await selectMany(createServiceRoleClient(), 'agents', ['id', 'name', 'engine_agent_id', 'disabled_at'] as const, { workspace_id: workspaceId }, { column: 'name', ascending: true })
    return (data ?? []).filter(agent => agent.engine_agent_id)
}

export async function touchThreadAgent(connectionId: string, channelId: string, threadTs: string, agentId: string): Promise<void> {
    await createServiceRoleClient().from('slack_threads').update<ThreadUpdate>({ agent_id: agentId, updated_at: new Date().toISOString() }).eq('connection_id', connectionId).eq('channel_id', channelId).eq('thread_ts', threadTs)
}

// When each channel last moved, from the threads the coworkers answered in. Read newest first and
// bounded, so a long history costs one small page: the first time a channel appears is its answer.
export async function lastThreadActivity(connectionId: string): Promise<Record<string, string>> {
    const { data } = await selectMany(createServiceRoleClient(), 'slack_threads', ['channel_id', 'updated_at'] as const, { connection_id: connectionId }, { column: 'updated_at', ascending: false }, 500)
    const latest: Record<string, string> = {}
    for (const thread of data ?? []) latest[thread.channel_id] ??= thread.updated_at
    return latest
}
