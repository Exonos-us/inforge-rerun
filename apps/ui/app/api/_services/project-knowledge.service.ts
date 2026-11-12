import { assertSpaceAccess, type Actor } from '@/app/api/_auth/access'
import { enableGlobalApp, ensureGlobalOauthAccess, markGlobalNeedsReconnect } from '@/app/api/_services/global-apps.service'
import { getWorkspaceConnection } from '@/app/api/_services/workspace-engine.service'
import { atlassianSession, getSite, listEngagements, listSpaces, pageIndex, type ConfluenceEngagement, type ConfluenceSpace, type PageIndexEntry } from '@/lib/atlassian/confluence'
import { AtlassianAuthError, type AtlassianMcpSession } from '@/lib/atlassian/mcp'
import { deleteFile, makeDir, writeFileText } from '@/lib/engine/client'
import type { EngineConnection } from '@/lib/engine/types'
import { entriesOfSlug, readRegistry } from '@/lib/services/registry'
import type { Database } from '@/app/api/database.types'
import { createServiceRoleClient } from '@/supabase/serviceRole'
import { selectMany, selectMaybeSingle, selectSingle } from '@/supabase/supabase-helpers'

// Project knowledge: a Box points at the Confluence engagement it is about. The pages stay in
// Confluence — the Company Brain is untouched — and every coworker of the Box carries a note
// (.rerun/project.md on its engine) telling it where to read before working and where to write
// back. Reads here ride the workspace's Atlassian account from Global apps.

const PROJECT_NOTE_DIR = '.rerun'
const PROJECT_NOTE_PATH = '.rerun/project.md'
const ATLASSIAN_SLUG = 'atlassian'
const INDEX_STALE_MS = 60 * 60 * 1000

const KNOWLEDGE_COLUMNS = ['space_id', 'workspace_id', 'connection_id', 'site_url', 'cloud_id', 'space_key', 'space_name', 'page_id', 'page_title', 'page_index', 'index_refreshed_at', 'status', 'created_at'] as const

type KnowledgeRow = {
    space_id: string
    workspace_id: number
    connection_id: string | null
    site_url: string
    cloud_id: string
    space_key: string
    space_name: string
    page_id: string | null
    page_title: string | null
    page_index: unknown
    index_refreshed_at: string | null
    status: string
    created_at: string
}

export type KnowledgeStatus = 'ok' | 'needs_reconnect' | 'missing'
export type KnowledgeUnavailableReason = 'no_connection' | 'needs_reconnect'
export type KnowledgeSpacesResult = { available: false; reason: KnowledgeUnavailableReason } | { available: true; siteUrl: string; spaces: ConfluenceSpace[] }
export type KnowledgeEngagementsResult = { spaceKey: string; spaceName: string; fallback: boolean; engagements: ConfluenceEngagement[] }

export type ProjectKnowledgeAgent = { id: string; name: string; atlassian: 'global' | 'own' | 'none' }
export type ProjectKnowledgeView = {
    spaceId: string
    siteUrl: string
    spaceKey: string
    spaceName: string
    pageId: string | null
    pageTitle: string | null
    pageCount: number
    status: KnowledgeStatus
    connectionId: string | null
    agents: ProjectKnowledgeAgent[]
}

type AtlassianAccess = { connection: { id: string; label: string }; session: AtlassianMcpSession }

async function findAtlassianConnection(workspaceId: number): Promise<{ id: string; label: string; oauth: unknown; status: string } | null> {
    const supabase = createServiceRoleClient()
    const { data } = await selectMany(supabase, 'global_app_connections', ['id', 'label', 'oauth', 'status', 'kind'] as const, { workspace_id: workspaceId, service_slug: ATLASSIAN_SLUG, kind: 'oauth' }, { column: 'created_at' })
    return data?.find(row => row.status !== 'connecting') ?? null
}

async function atlassianAccess(workspaceId: number): Promise<{ ok: true; access: AtlassianAccess } | { ok: false; reason: KnowledgeUnavailableReason }> {
    const connection = await findAtlassianConnection(workspaceId)
    if (!connection) return { ok: false, reason: 'no_connection' }
    try {
        const bundle = await ensureGlobalOauthAccess({ id: connection.id, oauth: connection.oauth })
        return { ok: true, access: { connection: { id: connection.id, label: connection.label }, session: atlassianSession(bundle.mcpUrl, bundle.accessToken) } }
    } catch {
        await markGlobalNeedsReconnect(connection.id)
        return { ok: false, reason: 'needs_reconnect' }
    }
}

export async function listKnowledgeSpaces(workspaceId: number): Promise<KnowledgeSpacesResult> {
    const result = await atlassianAccess(workspaceId)
    if (!result.ok) return { available: false, reason: result.reason }
    const site = await getSite(result.access.session)
    const spaces = await listSpaces(result.access.session, site.cloudId)
    return { available: true, siteUrl: site.url, spaces }
}

export async function listKnowledgeEngagements(workspaceId: number, spaceKey: string): Promise<KnowledgeEngagementsResult> {
    const result = await atlassianAccess(workspaceId)
    if (!result.ok) throw new Error('The workspace Atlassian account is not available right now.')
    const site = await getSite(result.access.session)
    const space = (await listSpaces(result.access.session, site.cloudId)).find(s => s.key === spaceKey)
    if (!space) throw new Error('This Confluence space is gone or out of reach.')
    if (!space.homepageId) return { spaceKey, spaceName: space.name, fallback: true, engagements: [] }
    const listing = await listEngagements(result.access.session, site.cloudId, space.homepageId)
    return { spaceKey, spaceName: space.name, fallback: listing.fallback, engagements: listing.engagements }
}

function asIndex(value: unknown): PageIndexEntry[] {
    return Array.isArray(value) ? (value as PageIndexEntry[]) : []
}

// What a coworker of the Box reads in its system prompt. Written to the engine, next to the
// services registry, so unlinking is deleting one file.
function buildProjectNote(row: KnowledgeRow, boxName: string): string {
    const scope = row.page_title ? `the engagement "${row.page_title}"` : `the whole client space`
    const index = asIndex(row.page_index)
    const indexLines = index.length ? `Page index (titles under it):\n${index.map(page => `- ${page.title}`).join('\n')}` : ''
    return [
        `# Project knowledge`,
        `Your Box "${boxName}" is the project for ${scope} in the Confluence space "${row.space_name}" (key ${row.space_key}, site ${row.site_url}).${row.page_title ? ` Its root page is "${row.page_title}" (page id ${row.page_id}).` : ''}`,
        `These pages are this project's brain, shared with people and other AIs outside Rerun. Before working on anything about this project, read the relevant pages with your atlassian tools (search within space ${row.space_key}). Write back what you learn so the brain stays current: decisions on the Decisions page, meeting preparation under Meeting preps, unknowns under Open questions, each inside this page tree. Edit carefully and comment when unsure; never restructure pages you did not create.`,
        indexLines,
    ]
        .filter(Boolean)
        .join('\n\n')
}

async function boxAgents(spaceId: string): Promise<{ id: string; name: string; engineAgentId: string | null }[]> {
    const supabase = createServiceRoleClient()
    const { data } = await selectMany(supabase, 'agents', ['id', 'name', 'engine_agent_id'] as const, { space_id: spaceId })
    return (data ?? []).map(agent => ({ id: agent.id, name: agent.name, engineAgentId: agent.engine_agent_id }))
}

function filesBase(engineAgentId: string): string {
    return `/agents/${engineAgentId}/files`
}

async function writeProjectNote(conn: EngineConnection, engineAgentId: string, note: string): Promise<void> {
    await makeDir(conn, filesBase(engineAgentId), PROJECT_NOTE_DIR).catch(() => {})
    await writeFileText(conn, filesBase(engineAgentId), PROJECT_NOTE_PATH, note)
}

async function removeProjectNote(conn: EngineConnection, engineAgentId: string): Promise<void> {
    await deleteFile(conn, filesBase(engineAgentId), PROJECT_NOTE_PATH)
}

async function pushNotesToBox(workspaceId: number, spaceId: string, row: KnowledgeRow | null): Promise<string[]> {
    const warnings: string[] = []
    const agents = await boxAgents(spaceId)
    if (!agents.length) return warnings
    const conn = await getWorkspaceConnection(workspaceId)
    const { data: space } = await selectSingle(createServiceRoleClient(), 'spaces', ['name'] as const, { id: spaceId })
    const note = row ? buildProjectNote(row, space?.name ?? 'this project') : null
    for (const agent of agents) {
        if (!agent.engineAgentId) continue
        try {
            if (note) await writeProjectNote(conn, agent.engineAgentId, note)
            else await removeProjectNote(conn, agent.engineAgentId)
        } catch (err) {
            warnings.push(`${agent.name}: ${err instanceof Error ? err.message : 'could not update the project note'}`)
        }
    }
    return warnings
}

// Coworkers reach the pages through the same workspace account: enabling the Atlassian global app
// is part of linking, skipped for a coworker that already has Atlassian of its own.
async function enableAtlassianForBox(workspaceId: number, spaceId: string, connectionId: string, actor: Actor): Promise<string[]> {
    const warnings: string[] = []
    const agents = await boxAgents(spaceId)
    const conn = await getWorkspaceConnection(workspaceId)
    for (const agent of agents) {
        if (!agent.engineAgentId) continue
        try {
            const registry = await readRegistry(conn, agent.engineAgentId)
            if (entriesOfSlug(registry, ATLASSIAN_SLUG).length > 0) continue
            await enableGlobalApp({ workspaceId, connectionId, agentId: agent.id, actor })
        } catch (err) {
            warnings.push(`${agent.name}: ${err instanceof Error ? err.message : 'could not enable Atlassian'}`)
        }
    }
    return warnings
}

async function knowledgeRow(spaceId: string): Promise<KnowledgeRow | null> {
    const { data } = await selectMaybeSingle(createServiceRoleClient(), 'space_knowledge', KNOWLEDGE_COLUMNS, { space_id: spaceId })
    return (data as KnowledgeRow | null) ?? null
}

export async function linkProjectKnowledge(params: { actor: Actor; spaceId: string; spaceKey: string; pageId: string | null; pageTitle: string | null }): Promise<{ warnings: string[] }> {
    const { actor, spaceId, spaceKey, pageId, pageTitle } = params
    await assertSpaceAccess(spaceId, 'manage', actor)
    const workspaceId = actor.workspaceId

    const access = await atlassianAccess(workspaceId)
    if (!access.ok) throw new Error(access.reason === 'no_connection' ? 'Connect Atlassian in Global apps first.' : 'The workspace Atlassian account needs a reconnect in Global apps.')
    const site = await getSite(access.access.session)
    const space = (await listSpaces(access.access.session, site.cloudId)).find(s => s.key === spaceKey)
    if (!space) throw new Error('This Confluence space is gone or out of reach.')

    const indexRoot = pageId ?? space.homepageId
    const index = indexRoot ? await pageIndex(access.access.session, site.cloudId, indexRoot).catch(() => []) : []

    const supabase = createServiceRoleClient()
    const payload: Database['public']['Tables']['space_knowledge']['Insert'] = {
        space_id: spaceId,
        workspace_id: workspaceId,
        connection_id: access.access.connection.id,
        site_url: site.url,
        cloud_id: site.cloudId,
        space_key: space.key,
        space_name: space.name,
        page_id: pageId,
        page_title: pageTitle,
        page_index: index,
        index_refreshed_at: new Date().toISOString(),
        status: 'ok',
        linked_by: actor.kind === 'user' ? actor.userId : null,
        updated_at: new Date().toISOString(),
    }
    const { error } = await supabase.from('space_knowledge').upsert<Database['public']['Tables']['space_knowledge']['Insert']>(payload, { onConflict: 'space_id' })
    if (error) throw new Error(`Failed to link the engagement: ${error.message}`)

    const row = await knowledgeRow(spaceId)
    const warnings = [...(await pushNotesToBox(workspaceId, spaceId, row)), ...(await enableAtlassianForBox(workspaceId, spaceId, access.access.connection.id, actor))]
    return { warnings }
}

export async function unlinkProjectKnowledge(actor: Actor, spaceId: string): Promise<void> {
    await assertSpaceAccess(spaceId, 'manage', actor)
    const supabase = createServiceRoleClient()
    const { error } = await supabase.from('space_knowledge').delete().eq('space_id', spaceId)
    if (error) throw new Error(`Failed to unlink: ${error.message}`)
    await pushNotesToBox(actor.workspaceId, spaceId, null).catch(() => {})
}

async function agentAtlassianStates(workspaceId: number, spaceId: string, connectionId: string | null): Promise<ProjectKnowledgeAgent[]> {
    const agents = await boxAgents(spaceId)
    if (!agents.length) return []
    const supabase = createServiceRoleClient()
    const globallyBound = new Set<string>()
    if (connectionId) {
        const { data: bindings } = await selectMany(supabase, 'global_app_agents', ['agent_id'] as const, { connection_id: connectionId })
        for (const binding of bindings ?? []) globallyBound.add(binding.agent_id)
    }
    const conn = await getWorkspaceConnection(workspaceId).catch(() => null)
    const states: ProjectKnowledgeAgent[] = []
    for (const agent of agents) {
        if (globallyBound.has(agent.id)) {
            states.push({ id: agent.id, name: agent.name, atlassian: 'global' })
            continue
        }
        let own = false
        if (conn && agent.engineAgentId) {
            const registry = await readRegistry(conn, agent.engineAgentId).catch(() => ({ services: {} }))
            own = entriesOfSlug(registry, ATLASSIAN_SLUG).length > 0
        }
        states.push({ id: agent.id, name: agent.name, atlassian: own ? 'own' : 'none' })
    }
    return states
}

// Refreshes the cached page index when it is stale, best-effort: a dead account flags the row
// instead of failing the read, and a vanished root page flags it missing.
async function refreshIndex(row: KnowledgeRow): Promise<KnowledgeRow> {
    const stale = !row.index_refreshed_at || Date.now() - new Date(row.index_refreshed_at).getTime() > INDEX_STALE_MS
    if (!stale) return row
    const supabase = createServiceRoleClient()
    const update = async (patch: Database['public']['Tables']['space_knowledge']['Update']) => {
        await supabase.from('space_knowledge').update<Database['public']['Tables']['space_knowledge']['Update']>({ ...patch, updated_at: new Date().toISOString() }).eq('space_id', row.space_id)
    }
    const access = await atlassianAccess(row.workspace_id)
    if (!access.ok) {
        if (access.reason === 'needs_reconnect' && row.status === 'ok') await update({ status: 'needs_reconnect' })
        return { ...row, status: access.reason === 'needs_reconnect' ? 'needs_reconnect' : row.status }
    }
    try {
        const root = row.page_id ?? (await listSpaces(access.access.session, row.cloud_id)).find(s => s.key === row.space_key)?.homepageId
        if (!root) {
            await update({ status: 'missing' })
            return { ...row, status: 'missing' }
        }
        const index = await pageIndex(access.access.session, row.cloud_id, root)
        if (row.page_id && index.length === 0) {
            await update({ status: 'missing' })
            return { ...row, status: 'missing' }
        }
        await update({ page_index: index, index_refreshed_at: new Date().toISOString(), status: 'ok' })
        return { ...row, page_index: index, index_refreshed_at: new Date().toISOString(), status: 'ok' }
    } catch (err) {
        if (err instanceof AtlassianAuthError) await update({ status: 'needs_reconnect' })
        return row
    }
}

export async function getProjectKnowledge(actor: Actor, spaceId: string): Promise<ProjectKnowledgeView | null> {
    await assertSpaceAccess(spaceId, 'use', actor)
    const stored = await knowledgeRow(spaceId)
    if (!stored) return null
    const row = await refreshIndex(stored).catch(() => stored)
    const agents = await agentAtlassianStates(row.workspace_id, spaceId, row.connection_id).catch(() => [])
    return {
        spaceId: row.space_id,
        siteUrl: row.site_url,
        spaceKey: row.space_key,
        spaceName: row.space_name,
        pageId: row.page_id,
        pageTitle: row.page_title,
        pageCount: asIndex(row.page_index).length,
        status: (['ok', 'needs_reconnect', 'missing'].includes(row.status) ? row.status : 'ok') as KnowledgeStatus,
        connectionId: row.connection_id,
        agents,
    }
}

// Keeps a coworker's note in step with where it lives: called after a move between Boxes and
// after a coworker lands in a Box, best-effort both times.
export async function syncAgentProjectNote(agentId: string): Promise<void> {
    const supabase = createServiceRoleClient()
    const { data: agent } = await selectMaybeSingle(supabase, 'agents', ['space_id', 'workspace_id', 'engine_agent_id'] as const, { id: agentId })
    if (!agent?.engine_agent_id) return
    const row = await knowledgeRow(agent.space_id)
    const conn = await getWorkspaceConnection(agent.workspace_id)
    if (!row) {
        await removeProjectNote(conn, agent.engine_agent_id)
        return
    }
    const { data: space } = await selectSingle(supabase, 'spaces', ['name'] as const, { id: agent.space_id })
    await writeProjectNote(conn, agent.engine_agent_id, buildProjectNote(row, space?.name ?? 'this project'))
}
