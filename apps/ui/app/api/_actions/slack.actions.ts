'use server'

import { requireAdminContext, requireWorkspaceContext } from '@/app/api/_auth/ownership'
import {
    bindCoworker,
    connectSlack,
    connectionForWorkspace,
    disconnectSlack,
    listBindings,
    publicView,
    slackChannels,
    unbindCoworker,
    workspaceCoworkers,
    type SlackConnection,
} from '@/app/api/_services/slack.service'
import { getAppOrigin } from '@/lib/app-origin'
import { createAppUrl, createChannel, postMessage, type SlackChannel } from '@/lib/slack/api'
import { selectMaybeSingle } from '@/supabase/supabase-helpers'

import type { ActionResult } from './space.actions'

// Connecting Slack hands Rerun a bot token that can post anywhere the app is invited, so it is an
// admin's call. Wiring a coworker into a channel afterwards is ordinary work any member may do.

const SLACK_ADMIN_ONLY = 'Only an admin can connect or disconnect Slack'

export type SlackCoworkerView = { id: string; name: string; disabled: boolean }

export type SlackBindingView = { id: string; channelId: string; channelName: string | null; agentId: string; name: string; iconEmoji: string | null }

export type SlackStateView = {
    connection: { teamName: string | null; teamId: string; canCustomizeIdentity: boolean; status: string } | null
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

        if (!connection || !view) return { ok: true, state: { ...base, connection: null } }

        const connectionView = { teamName: view.team_name, teamId: view.team_id, canCustomizeIdentity: view.can_customize_identity, status: view.status }
        const bindings = (await listBindings(connection.id)).map(bindingView)

        try {
            const channels = await slackChannels(connection)
            return { ok: true, state: { ...base, connection: connectionView, channels, bindings } }
        } catch (err) {
            // The app was uninstalled or the token revoked: the bindings are still worth showing,
            // with the reason the channel list is empty.
            return { ok: true, state: { ...base, connection: connectionView, bindings, slackError: err instanceof Error ? err.message : 'Slack refused the call' } }
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
