'use server'

import { assertSpaceAccess } from '@/app/api/_auth/access'
import { requireWorkspaceContext, type WorkspaceContext } from '@/app/api/_auth/ownership'
import { applyClientExtras, createClient, deleteClient, getClient, listClients, pendingSyncCount, removeClientExtras, syncClient, updateClient, type ClientPatch, type ClientSyncResult, type ClientView } from '@/app/api/_services/client.service'
import { getSpaceConnection } from '@/app/api/_services/space.service'
import type { Database } from '@/app/api/database.types'
import { UNNAMED_BOX_LABEL } from '@/lib/board/types'
import { listSkillSummaries } from '@/lib/engine/client'
import { selectMany, selectMaybeSingle } from '@/supabase/supabase-helpers'

import type { ActionResult } from './space.actions'

// The panel's door onto the clients, and the Box's pointer at one. Reading a client takes nothing
// more than being in the workspace — the same rule the table itself carries — but changing what a
// Box works to takes manage on that Box, because it rewrites every coworker standing in it.

export type ClientBox = { id: string; name: string }
export type ClientUsage = { boxes: ClientBox[]; coworkers: number; pending: number }
export type ClientListEntry = ClientView & ClientUsage

// A short code is chosen, not derived: `updateClient` writes what the user typed rather than
// quietly renaming it, so a collision has to come back pointing at the input they have to change.
// `field` is what lets the form put it there instead of raising a toast that names no field.
export type ClientFieldError = { ok: false; error: string; field: 'shortCode' }

export type BoxClientResult = {
    client: ClientView | null
    cleared: number
    applied: number
    pending: number
    warnings: string[]
}

const SHORT_CODE_TAKEN = 'Another client already uses this code.'
const SHORT_CODE_BLANK = 'A client needs a short code.'
const EMPTY_USAGE: ClientUsage = { boxes: [], coworkers: 0, pending: 0 }

const BOX_COWORKER_COLUMNS = ['id', 'name', 'engine_agent_id'] as const

const message = (err: unknown, fallback: string) => (err instanceof Error ? err.message : fallback)

// How many Boxes each client stands behind, and how many coworkers in them. The trailing count
// comes from pendingSyncCount rather than from a second reading of `client_revision` here: it is
// the number the panel's "N to sync" badge means, and two ways of computing it would drift.
async function usageOf(ctx: WorkspaceContext, clients: readonly ClientView[]): Promise<Map<string, ClientUsage>> {
    const usage = new Map<string, ClientUsage>(clients.map(client => [client.id, { boxes: [], coworkers: 0, pending: 0 }]))
    if (clients.length === 0) return usage

    const { data: spaces } = await selectMany(ctx.supabase, 'spaces', ['id', 'name', 'client_id'] as const, { workspace_id: ctx.workspace.id, client_id: clients.map(client => client.id) }, { column: 'name' })
    const clientOfBox = new Map<string, string>()
    for (const space of spaces ?? []) {
        const clientId = space.client_id
        const entry = clientId ? usage.get(clientId) : undefined
        if (!clientId || !entry) continue
        entry.boxes.push({ id: space.id, name: space.name || UNNAMED_BOX_LABEL })
        clientOfBox.set(space.id, clientId)
    }

    if (clientOfBox.size > 0) {
        const { data: coworkers } = await selectMany(ctx.supabase, 'agents', ['space_id'] as const, { workspace_id: ctx.workspace.id, space_id: [...clientOfBox.keys()], engine_agent_id: { notNull: true } })
        for (const coworker of coworkers ?? []) {
            const clientId = clientOfBox.get(coworker.space_id)
            const entry = clientId ? usage.get(clientId) : undefined
            if (entry) entry.coworkers += 1
        }
    }

    const pending = await Promise.all(clients.map(client => pendingSyncCount(ctx.supabase, ctx.workspace.id, client.id, client.revision)))
    clients.forEach((client, index) => {
        const entry = usage.get(client.id)
        if (entry) entry.pending = pending[index]
    })
    return usage
}

export async function listClientsAction(): Promise<ActionResult<{ clients: ClientListEntry[] }>> {
    try {
        const ctx = await requireWorkspaceContext()
        const clients = await listClients(ctx.supabase, ctx.workspace.id)
        const usage = await usageOf(ctx, clients)
        return { ok: true, clients: clients.map(client => ({ ...client, ...(usage.get(client.id) ?? EMPTY_USAGE) })) }
    } catch (err) {
        return { ok: false, error: message(err, 'Could not read the clients') }
    }
}

export async function createClientAction(params: { name: string }): Promise<ActionResult<{ client: ClientView }>> {
    try {
        const ctx = await requireWorkspaceContext()
        if (!params.name.trim()) return { ok: false, error: 'A client needs a name.' }
        const clientId = await createClient(ctx.supabase, ctx.workspace.id, ctx.userId, params.name)
        const client = await getClient(ctx.supabase, ctx.workspace.id, clientId)
        if (!client) return { ok: false, error: 'Could not read the client back' }
        return { ok: true, client }
    } catch (err) {
        return { ok: false, error: message(err, 'Could not create the client') }
    }
}

// The code is compared case-insensitively, where the unique index is not: "MDC" and "mdc" would
// both be accepted by Postgres and would then name the same Boxes and channels, which is the
// ambiguity the code exists to avoid.
async function shortCodeClash(ctx: WorkspaceContext, clientId: string, shortCode: string): Promise<ClientFieldError | null> {
    const code = shortCode.trim()
    if (!code) return { ok: false, error: SHORT_CODE_BLANK, field: 'shortCode' }
    const clash = (await listClients(ctx.supabase, ctx.workspace.id)).find(other => other.id !== clientId && other.shortCode.toLowerCase() === code.toLowerCase())
    return clash ? { ok: false, error: `"${clash.shortCode}" is already ${clash.name}'s code.`, field: 'shortCode' } : null
}

// The read above races with another tab saving the same code, so the index stays the last word and
// its message is translated back onto the same input.
function shortCodeViolation(text: string): ClientFieldError | null {
    if (text.includes('clients_workspace_short_code_idx')) return { ok: false, error: SHORT_CODE_TAKEN, field: 'shortCode' }
    if (text.includes('clients_short_code_not_blank')) return { ok: false, error: SHORT_CODE_BLANK, field: 'shortCode' }
    return null
}

export async function updateClientAction(params: { clientId: string } & ClientPatch): Promise<ActionResult<{ client: ClientView; sync: ClientSyncResult }> | ClientFieldError> {
    try {
        const ctx = await requireWorkspaceContext()
        const { clientId, ...patch } = params
        const current = await getClient(ctx.supabase, ctx.workspace.id, clientId)
        if (!current) return { ok: false, error: 'Could not find the client' }

        if (patch.name !== undefined && !patch.name.trim()) return { ok: false, error: 'A client needs a name.' }
        if (patch.skills !== undefined) patch.skills = patch.skills.filter(skill => skill.name.trim())
        if (patch.knowledge !== undefined) {
            patch.knowledge = patch.knowledge.filter(doc => doc.path.trim())
            if (patch.knowledge.some(doc => doc.path.includes('..') || doc.path.startsWith('/'))) return { ok: false, error: 'A document name cannot leave its folder.' }
        }
        if (patch.shortCode !== undefined) {
            const clash = await shortCodeClash(ctx, clientId, patch.shortCode)
            if (clash) return clash
        }

        await updateClient(ctx.supabase, ctx.workspace.id, clientId, patch, current.revision)
        const client = await getClient(ctx.supabase, ctx.workspace.id, clientId)
        // The save and the push are one gesture: the panel shows what landed on the coworkers, not
        // just that the row was written.
        const sync = await syncClient(ctx.supabase, ctx.workspace.id, clientId)
        return { ok: true, client: client ?? current, sync }
    } catch (err) {
        const text = message(err, 'Could not update the client')
        return shortCodeViolation(text) ?? { ok: false, error: text }
    }
}

// The coworkers keep the skills and documents they already have. `spaces.client_id` is
// `on delete set null`, so the Boxes simply lose their client; stripping a live engagement of the
// conventions it works to is not what deleting a row off an admin list means. The usage read
// before the delete is what the confirm dialog names.
export async function deleteClientAction(params: { clientId: string }): Promise<ActionResult<{ usage: ClientUsage }>> {
    try {
        const ctx = await requireWorkspaceContext()
        const client = await getClient(ctx.supabase, ctx.workspace.id, params.clientId)
        if (!client) return { ok: false, error: 'Could not find the client' }
        const usage = (await usageOf(ctx, [client])).get(client.id) ?? EMPTY_USAGE
        await deleteClient(ctx.supabase, ctx.workspace.id, params.clientId)
        return { ok: true, usage }
    } catch (err) {
        return { ok: false, error: message(err, 'Could not delete the client') }
    }
}

// What the coworker actually has, which is not what the client row says it should: a skill renamed
// since it was installed left an orphan under its old slug, and only the engine knows about it.
// An unreachable machine gives nothing, and removeClientExtras warns about it on its own.
async function installedSlugs(spaceId: string, engineAgentId: string | null): Promise<string[]> {
    if (!engineAgentId) return []
    const conn = await getSpaceConnection(spaceId).catch(() => null)
    if (!conn) return []
    const summaries = await listSkillSummaries(conn, engineAgentId).catch(() => null)
    return (summaries ?? []).map(summary => summary.slug)
}

// The revision a coworker carries is a number of its own client's, so it means nothing once the
// Box moves: a coworker level with revision 5 of the client it is leaving would read as level with
// revision 1 of the one arriving, and no sync would ever come back for it.
async function pointBoxAt(ctx: WorkspaceContext, spaceId: string, clientId: string | null): Promise<void> {
    const { error } = await ctx.supabase.from('spaces').update<Database['public']['Tables']['spaces']['Update']>({ client_id: clientId }).eq('id', spaceId).eq('workspace_id', ctx.workspace.id)
    if (error) throw new Error(error.message)
    await ctx.supabase.from('agents').update<Database['public']['Tables']['agents']['Update']>({ client_revision: null }).eq('space_id', spaceId).eq('workspace_id', ctx.workspace.id)
}

async function markClientRevision(ctx: WorkspaceContext, agentId: string, revision: number): Promise<boolean> {
    const { error } = await ctx.supabase.from('agents').update<Database['public']['Tables']['agents']['Update']>({ client_revision: revision }).eq('id', agentId).eq('workspace_id', ctx.workspace.id)
    return !error
}

// Changing a Box's client is the one place a client's skills are taken off a coworker: a different
// client is taking the engagement over. The old one goes first and the new one lands after, so a
// skill the two share is never deleted by the removal that follows its own install.
//
// Nothing here is allowed to end the loop. removeClientExtras and applyClientExtras already collect
// rather than throw; the catch around each covers what they cannot, so one coworker on a machine
// that is down leaves the rest of the Box changed and itself trailing, with a warning saying so.
export async function setBoxClientAction(params: { spaceId: string; clientId: string | null }): Promise<ActionResult<{ result: BoxClientResult }>> {
    try {
        const ctx = await requireWorkspaceContext()
        await assertSpaceAccess(params.spaceId, 'manage')

        const { data: box } = await selectMaybeSingle(ctx.supabase, 'spaces', ['id', 'client_id'] as const, { id: params.spaceId, workspace_id: ctx.workspace.id })
        if (!box) return { ok: false, error: 'Could not find the Box' }

        const nextId = params.clientId ?? null
        const next = nextId ? await getClient(ctx.supabase, ctx.workspace.id, nextId) : null
        if (nextId && !next) return { ok: false, error: 'Could not find the client' }
        if ((box.client_id ?? null) === nextId) return { ok: true, result: { client: next, cleared: 0, applied: 0, pending: 0, warnings: [] } }

        const previous = box.client_id ? await getClient(ctx.supabase, ctx.workspace.id, box.client_id) : null
        const { data: coworkers } = await selectMany(ctx.supabase, 'agents', BOX_COWORKER_COLUMNS, { workspace_id: ctx.workspace.id, space_id: params.spaceId, engine_agent_id: { notNull: true } })
        const roster = coworkers ?? []

        const warnings: string[] = []
        let cleared = 0
        if (previous) {
            for (const coworker of roster) {
                const before = warnings.length
                await removeClientExtras(previous, params.spaceId, coworker, await installedSlugs(params.spaceId, coworker.engine_agent_id), warnings).catch(() => {
                    warnings.push(`"${coworker.name}" kept ${previous.name}'s skills and documents.`)
                })
                if (warnings.length === before) cleared += 1
            }
        }

        await pointBoxAt(ctx, params.spaceId, nextId)

        let applied = 0
        let pending = 0
        if (next) {
            for (const coworker of roster) {
                const before = warnings.length
                await applyClientExtras(next, params.spaceId, coworker, warnings).catch(() => {
                    warnings.push(`"${coworker.name}" did not get ${next.name}'s skills and documents: its machine could not be reached.`)
                })
                if (warnings.length === before && (await markClientRevision(ctx, coworker.id, next.revision))) applied += 1
                else pending += 1
            }
        }

        return { ok: true, result: { client: next, cleared, applied, pending, warnings } }
    } catch (err) {
        return { ok: false, error: message(err, 'Could not change the client of this Box') }
    }
}

export async function retryClientSyncAction(params: { clientId: string }): Promise<ActionResult<{ sync: ClientSyncResult }>> {
    try {
        const ctx = await requireWorkspaceContext()
        const sync = await syncClient(ctx.supabase, ctx.workspace.id, params.clientId)
        return { ok: true, sync }
    } catch (err) {
        return { ok: false, error: message(err, 'Could not sync the client') }
    }
}
