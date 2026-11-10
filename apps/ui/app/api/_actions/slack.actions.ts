'use server'

import { requireAdminContext, requireWorkspaceContext } from '@/app/api/_auth/ownership'
import {
    bindCoworker,
    bindingsForAgent,
    connectSlack,
    connectionForWorkspace,
    disconnectSlack,
    listBindings,
    publicView,
    slackChannels,
    unbindCoworker,
    updateBinding,
    workspaceCoworkers,
    type SlackConnection,
} from '@/app/api/_services/slack.service'
import { getAppOrigin } from '@/lib/app-origin'
import { createChannel, postMessage, type SlackChannel } from '@/lib/slack/api'
import { createAppUrl } from '@/lib/slack/manifest'
import { selectMaybeSingle } from '@/supabase/supabase-helpers'

import type { ActionResult } from './space.actions'

// Connecting Slack hands Rerun a bot token that can post anywhere the app is invited, so it is an
// admin's call. Wiring a coworker into a channel afterwards is ordinary work any member may do.

const SLACK_ADMIN_ONLY = 'Only an admin can connect or disconnect Slack'

export type SlackCoworkerView = { id: string; name: string; disabled: boolean }

export type SlackBindingView = { id: string; channelId: string; channelName: string | null; agentId: string; name: string; iconEmoji: string | null }

// What is wrong, in the terms of the thing to go and fix. Both silences a connected Slack can
// fall into are invisible from the channel, so the screen has to name them.
export type SlackHealth =
    | { state: 'never_called'; since: string }
    | { state: 'bad_signature'; at: string }
    | { state: 'no_identity' }
    | { state: 'delivering'; at: string }
    | { state: 'idle' }

export type SlackStateView = {
    connection: { teamName: string | null; teamId: string; canCustomizeIdentity: boolean; status: string } | null
    health: SlackHealth | null
    // Where Slack must send its events, and the one-click link that creates an app already
    // pointed at it. Both depend on the origin the app is actually served from.
    requestUrl: string
    createAppUrl: string
    channels: SlackChannel[]
    bindings: SlackBindingView[]
    coworkers: SlackCoworkerView[]
    // Set when Slack itself refused a call: an uninstalled app, a revoked token.
    slackError?: string
}

// A refusal beats silence: if the last thing Slack did was fail a signature, say that, even if a
// message got through earlier — nothing is getting through now.
function slackHealth(view: { last_event_at: string | null; last_signature_error_at: string | null; can_customize_identity: boolean; created_at?: string }): SlackHealth {
    const delivered = view.last_event_at ? new Date(view.last_event_at).getTime() : 0
    const refused = view.last_signature_error_at ? new Date(view.last_signature_error_at).getTime() : 0

    if (refused > delivered) return { state: 'bad_signature', at: view.last_signature_error_at as string }
    if (!view.last_event_at) return { state: 'never_called', since: view.created_at ?? '' }
    if (!view.can_customize_identity) return { state: 'no_identity' }
    return { state: 'delivering', at: view.last_event_at }
}

function bindingView(binding: Awaited<ReturnType<typeof listBindings>>[number]): SlackBindingView {
    return { id: binding.id, channelId: binding.channelId, channelName: binding.channelName, agentId: binding.agentId, name: binding.name, iconEmoji: binding.identity.iconEmoji ?? null }
}

export async function getSlackStateAction(): Promise<ActionResult<{ state: SlackStateView }>> {
    try {
        const ctx = await requireWorkspaceContext()
        const origin = await getAppOrigin()
        const requestUrl = `${origin}/api/webhooks/slack`
        const connection = await connectionForWorkspace(ctx.workspace.id)
        const view = publicView(connection)

        const coworkers = (await workspaceCoworkers(ctx.workspace.id)).map(agent => ({ id: agent.id, name: agent.name, disabled: Boolean(agent.disabled_at) }))
        const base = { requestUrl, createAppUrl: createAppUrl(requestUrl), coworkers, channels: [] as SlackChannel[], bindings: [] as SlackBindingView[] }

        if (!connection || !view) return { ok: true, state: { ...base, connection: null, health: null } }

        const connectionView = { teamName: view.team_name, teamId: view.team_id, canCustomizeIdentity: view.can_customize_identity, status: view.status }
        const health = slackHealth(view)
        const bindings = (await listBindings(connection.id)).map(bindingView)

        try {
            const channels = await slackChannels(connection)
            return { ok: true, state: { ...base, connection: connectionView, health, channels, bindings } }
        } catch (err) {
            // The app was uninstalled or the token revoked: the bindings are still worth showing,
            // with the reason the channel list is empty.
            return { ok: true, state: { ...base, connection: connectionView, health, bindings, slackError: err instanceof Error ? err.message : 'Slack refused the call' } }
        }
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'Could not read the Slack settings' }
    }
}

export async function connectSlackAction(params: { botToken: string; signingSecret: string }): Promise<ActionResult<{ teamName: string; canCustomizeIdentity: boolean }>> {
    try {
        const ctx = await requireAdminContext().catch(() => null)
        if (!ctx) return { ok: false, error: SLACK_ADMIN_ONLY }

        const result = await connectSlack({ workspaceId: ctx.workspace.id, userId: ctx.userId, botToken: params.botToken, signingSecret: params.signingSecret })
        return result.ok ? { ok: true, teamName: result.teamName, canCustomizeIdentity: result.canCustomizeIdentity } : { ok: false, error: result.error }
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'Could not connect Slack' }
    }
}

export async function disconnectSlackAction(): Promise<ActionResult> {
    try {
        const ctx = await requireAdminContext().catch(() => null)
        if (!ctx) return { ok: false, error: SLACK_ADMIN_ONLY }
        await disconnectSlack(ctx.workspace.id)
        return { ok: true }
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'Could not disconnect Slack' }
    }
}

// The agent id comes from the client, so it is checked against the caller's workspace before a
// binding is written: without this, a member could put someone else's coworker in their channel.
async function requireConnectionAndAgent(agentId: string): Promise<{ connection: SlackConnection; agentName: string }> {
    const ctx = await requireWorkspaceContext()
    const connection = await connectionForWorkspace(ctx.workspace.id)
    if (!connection) throw new Error('Slack is not connected')
    const { data: agent } = await selectMaybeSingle(ctx.supabase, 'agents', ['workspace_id', 'name'] as const, { id: agentId })
    if (!agent || agent.workspace_id !== ctx.workspace.id) throw new Error('Coworker not found')
    return { connection, agentName: agent.name }
}

export async function bindCoworkerAction(params: { channelId: string; channelName?: string | null; agentId: string; displayName?: string | null; iconEmoji?: string | null }): Promise<ActionResult> {
    try {
        const { connection, agentName } = await requireConnectionAndAgent(params.agentId)
        await bindCoworker({
            connectionId: connection.id,
            channelId: params.channelId,
            channelName: params.channelName ?? null,
            agentId: params.agentId,
            displayName: params.displayName?.trim() || agentName,
            iconEmoji: params.iconEmoji ?? null,
        })
        return { ok: true }
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'Could not add the coworker to that channel' }
    }
}

// What one coworker's own card shows: the channels it answers in, the channels it could join, and
// whether Slack is connected at all. A member may wire a coworker they can reach; connecting
// Slack itself stays with an admin.
export type AgentChannelsView = {
    connected: boolean
    canCustomizeIdentity: boolean
    bindings: SlackBindingView[]
    channels: SlackChannel[]
    agentName: string
}

export async function getAgentChannelsAction(params: { agentId: string }): Promise<ActionResult<{ state: AgentChannelsView }>> {
    try {
        const ctx = await requireWorkspaceContext()
        const { data: agent } = await selectMaybeSingle(ctx.supabase, 'agents', ['workspace_id', 'name'] as const, { id: params.agentId })
        if (!agent || agent.workspace_id !== ctx.workspace.id) return { ok: false, error: 'Coworker not found' }

        const connection = await connectionForWorkspace(ctx.workspace.id)
        if (!connection) return { ok: true, state: { connected: false, canCustomizeIdentity: false, bindings: [], channels: [], agentName: agent.name } }

        const [bindings, channels] = await Promise.all([
            bindingsForAgent(connection.id, params.agentId),
            slackChannels(connection).catch(() => [] as SlackChannel[]),
        ])
        return {
            ok: true,
            state: {
                connected: true,
                canCustomizeIdentity: connection.can_customize_identity,
                bindings: bindings.map(bindingView),
                // Only the channels it is not already in: adding it twice is refused anyway.
                channels: channels.filter(channel => !bindings.some(binding => binding.channelId === channel.id)),
                agentName: agent.name,
            },
        }
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'Could not read the Slack channels' }
    }
}

export async function updateBindingAction(params: { bindingId: string; displayName?: string | null; iconEmoji?: string | null }): Promise<ActionResult> {
    try {
        const ctx = await requireWorkspaceContext()
        const connection = await connectionForWorkspace(ctx.workspace.id)
        if (!connection) return { ok: false, error: 'Slack is not connected' }
        const mine = (await listBindings(connection.id)).some(binding => binding.id === params.bindingId)
        if (!mine) return { ok: false, error: 'That channel does not belong to this workspace' }

        const displayName = params.displayName?.trim()
        if (params.displayName !== undefined && !displayName) return { ok: false, error: 'A coworker needs a name to post under.' }
        // Slack wants :shortcode: form, and silently ignores anything else.
        const emoji = params.iconEmoji?.trim()
        const iconEmoji = emoji ? (/^:[a-z0-9_+-]+:$/.test(emoji) ? emoji : `:${emoji.replace(/^:|:$/g, '')}:`) : null

        await updateBinding(params.bindingId, {
            ...(params.displayName !== undefined ? { displayName } : {}),
            ...(params.iconEmoji !== undefined ? { iconEmoji } : {}),
        })
        return { ok: true }
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'Could not change how the coworker appears' }
    }
}

export async function unbindCoworkerAction(params: { bindingId: string }): Promise<ActionResult> {
    try {
        const ctx = await requireWorkspaceContext()
        const connection = await connectionForWorkspace(ctx.workspace.id)
        if (!connection) return { ok: false, error: 'Slack is not connected' }
        const mine = (await listBindings(connection.id)).some(binding => binding.id === params.bindingId)
        if (!mine) return { ok: false, error: 'That channel does not belong to this workspace' }
        await unbindCoworker(params.bindingId)
        return { ok: true }
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'Could not remove the coworker' }
    }
}

const CHANNEL_NAME_RE = /^[a-z0-9][a-z0-9-_]{0,78}$/

// "Give this team a channel": creates it in Slack, binds every coworker picked, and has each one
// say what it is. The hello matters — it is the only thing that tells the rest of the channel
// what these names are and how to talk to them.
export async function createSlackChannelAction(params: { name: string; isPrivate?: boolean; agentIds: string[] }): Promise<ActionResult<{ channelId: string }>> {
    try {
        const ctx = await requireWorkspaceContext()
        const connection = await connectionForWorkspace(ctx.workspace.id)
        if (!connection) return { ok: false, error: 'Slack is not connected' }

        const name = params.name.trim().toLowerCase().replace(/[^a-z0-9-_]+/g, '-')
        if (!CHANNEL_NAME_RE.test(name)) return { ok: false, error: 'A channel name is lowercase letters, numbers and hyphens.' }
        if (params.agentIds.length === 0) return { ok: false, error: 'Pick at least one coworker.' }

        const coworkers = await workspaceCoworkers(ctx.workspace.id)
        const picked = params.agentIds.map(id => coworkers.find(agent => agent.id === id)).filter(agent => agent !== undefined)
        if (picked.length !== params.agentIds.length) return { ok: false, error: 'One of those coworkers is not in this workspace.' }

        const channel = await createChannel(connection.bot_token, { name, isPrivate: params.isPrivate })

        for (const agent of picked) {
            await bindCoworker({ connectionId: connection.id, channelId: channel.id, channelName: channel.name, agentId: agent.id, displayName: agent.name })
            await postMessage(connection.bot_token, {
                channel: channel.id,
                text: `Here. I am *${agent.name}*, one of your Rerun coworkers. Write to me in this channel — put my name at the start if several of us are here — and I answer in a thread.`,
                identity: connection.can_customize_identity ? { name: agent.name } : undefined,
            }).catch(() => {})
        }

        return { ok: true, channelId: channel.id }
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'Could not create the channel' }
    }
}
