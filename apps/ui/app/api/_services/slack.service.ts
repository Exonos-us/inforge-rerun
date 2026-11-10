import 'server-only'

import type { Database } from '@/app/api/database.types'
import { ensureSessionRow } from '@/app/api/_services/chat.service'
import { getWorkspaceConnection } from '@/app/api/_services/workspace-engine.service'
import { chat, getRun, getRunTools, listFiles, readFileBytes } from '@/lib/engine/client'
import { authTest, fitMessage, installedScopes, listChannels, postMessage, toMrkdwn, updateMessage, uploadFile, userName, type SlackIdentity } from '@/lib/slack/api'
import { attachmentComment, filesWorthPosting, type WorkspaceFile } from '@/lib/slack/attachments'
import { createServiceRoleClient } from '@/supabase/serviceRole'
import { selectMany, selectManyWithJoins, selectMaybeSingle } from '@/supabase/supabase-helpers'

type ConnectionInsert = Database['public']['Tables']['slack_connections']['Insert']
type ConnectionUpdate = Database['public']['Tables']['slack_connections']['Update']
type BindingInsert = Database['public']['Tables']['slack_channel_agents']['Insert']
type ThreadInsert = Database['public']['Tables']['slack_threads']['Insert']
type ThreadUpdate = Database['public']['Tables']['slack_threads']['Update']
type EventInsert = Database['public']['Tables']['slack_events']['Insert']
type EventUpdate = Database['public']['Tables']['slack_events']['Update']

const CONNECTION_COLUMNS = ['id', 'workspace_id', 'team_id', 'team_name', 'bot_user_id', 'bot_token', 'signing_secret', 'can_customize_identity', 'status'] as const

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
    }
}

export type ConnectResult = { ok: true; teamName: string; canCustomizeIdentity: boolean } | { ok: false; error: string }

// Saving the two values the user copied out of their new Slack app. The token is checked against
// Slack before anything is written: a typo here would otherwise only surface as silence in a
// channel days later.
export async function connectSlack(params: { workspaceId: number; userId: string; botToken: string; signingSecret: string }): Promise<ConnectResult> {
    const token = params.botToken.trim()
    const secret = params.signingSecret.trim()
    if (!token.startsWith('xoxb-')) return { ok: false, error: 'That is not a bot token — it should start with xoxb-. Copy it from OAuth & Permissions → Bot User OAuth Token.' }
    if (secret.length < 16) return { ok: false, error: 'That signing secret looks too short. Copy it from Basic Information → App Credentials → Signing Secret.' }

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
            updated_at: new Date().toISOString(),
        },
        { onConflict: 'workspace_id' },
    )
    if (error) return { ok: false, error: error.message }
    return { ok: true, teamName: identity.team, canCustomizeIdentity: scopes.includes('chat:write.customize') }
}

export async function disconnectSlack(workspaceId: number): Promise<void> {
    await createServiceRoleClient().from('slack_connections').delete().eq('workspace_id', workspaceId)
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

// Who the message is for. A thread already belongs to a coworker, so a follow-up needs no name;
// a channel with one coworker needs none either. Otherwise the first name mentioned wins.
export function pickBinding(bindings: ChannelBinding[], text: string, boundAgentId?: string | null): ChannelBinding | null {
    // `(?![\w-])` rather than `\b`: a name can end in a character that is not a word character
    // ("c++"), where `\b` would never match, and it still keeps "engineer-1" from matching
    // "engineer-10".
    const named = bindings.find(b => new RegExp(`(^|[^\\w-])@?${b.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`, 'i').test(text))
    if (named) return named
    if (boundAgentId) return bindings.find(b => b.agentId === boundAgentId) ?? null
    return bindings.length === 1 ? bindings[0] : null
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
async function waitForAnswer(params: { conn: Awaited<ReturnType<typeof getWorkspaceConnection>>; engineAgentId: string; runId: string; onPulse: (text: string) => Promise<void> }): Promise<string> {
    const startedAt = Date.now()
    let lastPulse = Date.now()
    for (;;) {
        const run = await getRun(params.conn, params.engineAgentId, params.runId)
        if (run.status === 'done') return run.output?.trim() || '_(the run finished without saying anything)_'
        if (run.status === 'error') throw new Error(run.error || 'the run failed')
        if (run.status === 'cancelled') throw new Error('the run was stopped from Rerun')
        if (Date.now() - startedAt > RUN_TIMEOUT_MS) throw new Error('still working after 10 minutes — the answer will be in Rerun')

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
// it one. Two levels deep is where a coworker puts a deliverable; anything buried further was
// not meant for a chat.
const WALK_DEPTH = 2
const WALK_MAX_LISTINGS = 12

async function filesWrittenDuring(conn: Awaited<ReturnType<typeof getWorkspaceConnection>>, engineAgentId: string, since: Date): Promise<WorkspaceFile[]> {
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

    return filesWorthPosting(found, since)
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
}): Promise<number> {
    const files = await filesWrittenDuring(params.conn, params.engineAgentId, params.since).catch(() => [] as WorkspaceFile[])
    let posted = 0
    for (const file of files) {
        try {
            const bytes = await readFileBytes(params.conn, `/agents/${encodeURIComponent(params.engineAgentId)}/files`, file.path)
            await uploadFile(params.token, { channel: params.channel, threadTs: params.threadTs, filename: file.name, bytes, comment: attachmentComment(file) })
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

export async function handleSlackMessage(connection: SlackConnection, event: SlackMessageEvent, eventId: string): Promise<void> {
    const channelId = event.channel
    const text = event.text ?? ''
    if (!channelId || !event.ts) return

    const threadTs = event.thread_ts || event.ts
    const [bindings, thread] = await Promise.all([bindingsOf(connection.id, channelId), threadOf(connection.id, channelId, threadTs)])
    if (bindings.length === 0) return

    const binding = pickBinding(bindings, text, thread?.agent_id)
    const token = connection.bot_token
    if (!binding) {
        await postMessage(token, {
            channel: channelId,
            threadTs,
            text: `Who should take this — ${bindings.map(b => `*${b.name}*`).join(' or ')}? Put the name at the start of the message.`,
            identity: { name: 'Rerun', iconEmoji: ':robot_face:' },
        })
        await markEventProcessed(eventId)
        return
    }

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
        // `source: 'api'` because the engine's contract has no 'slack' yet: adding one means a new
        // value in its enum, and a hub ahead of its engine would get a 400 on every message.
        const res = await chat(conn, binding.engineAgentId, { message, sessionId: thread?.engine_session_id ?? undefined, source: 'api', author })
        if (!res.ok) throw new Error(`the coworker could not be reached (${res.status})`)
        const runId = res.headers.get('x-run-id')
        const engineSessionId = res.headers.get('x-session-id') ?? thread?.engine_session_id ?? null
        // The engine buffers the run, so dropping the stream here reads as one subscriber leaving.
        await res.body?.cancel().catch(() => {})
        if (!runId || !engineSessionId) throw new Error('the engine started the run without naming it')

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
        const posted = await postAttachments({ token, conn, engineAgentId: binding.engineAgentId, channel: channelId, threadTs, since: runStartedAt })
        if (posted) console.info(`[slack] ${binding.name} posted ${posted} file(s) to ${channelId}`)
    } catch (err) {
        const why = err instanceof Error ? err.message : String(err)
        console.error(`[slack] ${binding.name} could not answer:`, why)
        await updateMessage(token, { channel: channelId, ts: placeholder.ts, text: `:warning: ${why}`, identity }).catch(() => {})
    } finally {
        await markEventProcessed(eventId)
        await createServiceRoleClient().from('slack_connections').update<ConnectionUpdate>({ last_event_at: new Date().toISOString() }).eq('id', connection.id)
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
