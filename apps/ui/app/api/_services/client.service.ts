import 'server-only'

import type { Database } from '@/app/api/database.types'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getSpaceConnection } from '@/app/api/_services/space.service'
import { clientKnowledgeDir, clientSkillSlug, isClientSkillSlug } from '@/lib/clients/naming'
import { deleteFile, deleteSkill, importSkill, listSkillSummaries, makeDir, supportsSkillImportCreate, writeFileText } from '@/lib/engine/client'
import type { EngineConnection } from '@/lib/engine/types'
import { shortCodeOf } from '@/lib/presets/naming'
import { authoredSkillMarkdown } from '@/lib/presets/skill-markdown'
import { authoredSkillsFromRow, knowledgeDocsFromRow, type AuthoredSkill, type KnowledgeDoc } from '@/lib/presets/types'
import { selectMany, selectMaybeSingle } from '@/supabase/supabase-helpers'

// A client is who the workspace works for: the skills and knowledge every coworker on that
// engagement starts with. The payload columns hold the same shapes a preset holds, so the same
// parsers read both, with the same tolerance for a row written by an older build.

const CLIENT_COLUMNS = ['id', 'name', 'short_code', 'skills', 'knowledge', 'site_url', 'cloud_id', 'space_key', 'space_name', 'revision', 'updated_at'] as const

type ClientRow = Pick<Database['public']['Tables']['clients']['Row'], (typeof CLIENT_COLUMNS)[number]>

export type ClientConfluenceSpace = { siteUrl: string; cloudId: string; spaceKey: string; spaceName: string }

export type ClientView = {
    id: string
    name: string
    shortCode: string
    skills: AuthoredSkill[]
    knowledgeDocs: KnowledgeDoc[]
    confluence: ClientConfluenceSpace | null
    revision: number
    updatedAt: string
}

export type ClientPatch = {
    name?: string
    shortCode?: string
    skills?: AuthoredSkill[]
    knowledge?: KnowledgeDoc[]
    confluence?: ClientConfluenceSpace | null
}

// shortCodeOf is initials-based and a name with no Latin characters gives nothing back, but the
// column is not null and non-blank: a client always gets an addressable code.
const FALLBACK_SHORT_CODE = 'client'

export function toClientViews(rows: readonly ClientRow[]): ClientView[] {
    return rows.map(row => ({
        id: row.id,
        name: row.name,
        shortCode: row.short_code,
        skills: authoredSkillsFromRow.parse(row.skills),
        knowledgeDocs: knowledgeDocsFromRow.parse(row.knowledge),
        confluence: row.cloud_id ? { siteUrl: row.site_url ?? '', cloudId: row.cloud_id, spaceKey: row.space_key ?? '', spaceName: row.space_name ?? '' } : null,
        revision: row.revision,
        updatedAt: row.updated_at,
    }))
}

export async function listClients(supabase: SupabaseClient<Database>, workspaceId: number): Promise<ClientView[]> {
    const { data } = await selectMany(supabase, 'clients', CLIENT_COLUMNS, { workspace_id: workspaceId }, { column: 'name' })
    return toClientViews(data ?? [])
}

export async function getClient(supabase: SupabaseClient<Database>, workspaceId: number, clientId: string): Promise<ClientView | null> {
    const { data } = await selectMaybeSingle(supabase, 'clients', CLIENT_COLUMNS, { id: clientId, workspace_id: workspaceId })
    return data ? toClientViews([data])[0] : null
}

// The code is unique per workspace and names Boxes, channels and coworkers, so a collision is
// resolved here rather than left to the unique index: the user has to be shown the code they are
// getting, and "Miami Dade County" and "Miami Dade City" both propose "mdc".
async function freeShortCode(supabase: SupabaseClient<Database>, workspaceId: number, name: string): Promise<string> {
    const { data } = await selectMany(supabase, 'clients', ['short_code'] as const, { workspace_id: workspaceId })
    const taken = new Set((data ?? []).map(row => row.short_code))
    const base = shortCodeOf(name) || FALLBACK_SHORT_CODE
    let candidate = base
    let ordinal = 2
    while (taken.has(candidate)) {
        candidate = `${base}${ordinal}`
        ordinal += 1
    }
    return candidate
}

export async function createClient(supabase: SupabaseClient<Database>, workspaceId: number, userId: string, name: string): Promise<string> {
    const { data, error } = await supabase
        .from('clients')
        .insert<Database['public']['Tables']['clients']['Insert']>({
            workspace_id: workspaceId,
            name: name.trim(),
            short_code: await freeShortCode(supabase, workspaceId, name),
            created_by: userId,
        })
        .select('id')
        .single()
    if (error || !data) throw new Error(error?.message ?? 'Could not create the client')
    return data.id
}

// The revision moves in the same statement as the payload: the sync counts the coworkers trailing
// it, so a payload that landed without a bump would stay invisible to that count forever.
export async function updateClient(supabase: SupabaseClient<Database>, workspaceId: number, clientId: string, patch: ClientPatch, currentRevision: number): Promise<void> {
    const { error } = await supabase
        .from('clients')
        .update<Database['public']['Tables']['clients']['Update']>({
            ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
            ...(patch.shortCode !== undefined ? { short_code: patch.shortCode.trim() } : {}),
            ...(patch.skills !== undefined ? { skills: patch.skills } : {}),
            ...(patch.knowledge !== undefined ? { knowledge: patch.knowledge } : {}),
            ...(patch.confluence !== undefined
                ? {
                      site_url: patch.confluence?.siteUrl ?? null,
                      cloud_id: patch.confluence?.cloudId ?? null,
                      space_key: patch.confluence?.spaceKey ?? null,
                      space_name: patch.confluence?.spaceName ?? null,
                  }
                : {}),
            revision: currentRevision + 1,
            updated_at: new Date().toISOString(),
        })
        .eq('id', clientId)
        .eq('workspace_id', workspaceId)
    if (error) throw new Error(error.message)
}

export async function deleteClient(supabase: SupabaseClient<Database>, workspaceId: number, clientId: string): Promise<void> {
    const { error } = await supabase.from('clients').delete().eq('id', clientId).eq('workspace_id', workspaceId)
    if (error) throw new Error(error.message)
}

// A client's skills land on their own slug, which only an engine carrying `skills.import-create`
// will create. Boxes self-update on their own schedule, so an older one is a normal state: the gate
// is asked once per connection, before any skill is attempted, so the person reads one line instead
// of one failure per skill. It stands between the skills and nothing else — knowledge docs are
// plain file writes and install either way.
//
// Task 5's applyClientExtras calls this right before its skill loop.
export async function canInstallClientSkills(conn: EngineConnection, agent: { name: string }, warnings: string[]): Promise<boolean> {
    if (await supportsSkillImportCreate(conn)) return true
    warnings.push(`"${agent.name}" did not get the client's skills: they arrive with the next update of this machine.`)
    return false
}

export type ClientTarget = { name: string; engine_agent_id: string | null }

// The client row is the intent and the engine is the truth, so what a coworker should no longer
// have is the difference between the two rather than a list kept on the row: a recorded list drifts
// the moment a data-dir is restored, an agent is imported, or a skill is deleted from the panel.
//
// An empty skill list is never permission to delete. `authoredSkillsFromRow` is `.catch([])`, so a
// malformed `clients.skills` jsonb parses as zero skills instead of failing, and a reconcile that
// read that as "the client dropped everything" would wipe its skills off every coworker in every
// Box from one bad row. The caller only reaches here with at least one skill it just pushed.
async function removeSkillsTheClientDropped(conn: EngineConnection, client: ClientView, agent: { name: string; engine_agent_id: string }, skills: AuthoredSkill[], warnings: string[]): Promise<void> {
    const wanted = new Set(skills.map(skill => clientSkillSlug(client.id, skill.name)))
    const installed = await listSkillSummaries(conn, agent.engine_agent_id).catch(() => null)
    if (!installed) return
    for (const summary of installed) {
        if (!isClientSkillSlug(client.id, summary.slug) || wanted.has(summary.slug)) continue
        await deleteSkill(conn, agent.engine_agent_id, summary.slug).catch(() => {
            warnings.push(`"${agent.name}" kept "${summary.slug}", which ${client.name} no longer has.`)
        })
    }
}

// Mirrors applyAuthoredExtras in preset.service.ts: it never throws, it collects warnings. A
// coworker whose engine is down keeps the skills it has and shows up as trailing the revision.
//
// Skills are pushed before anything is deleted, so an import that fails leaves the coworker with
// what it had rather than with nothing.
export async function applyClientExtras(client: ClientView, spaceId: string, agent: ClientTarget, warnings: string[]): Promise<void> {
    const engineAgentId = agent.engine_agent_id
    if (!engineAgentId) return
    const skills = client.skills.filter(skill => skill.name.trim())
    const docs = client.knowledgeDocs.filter(doc => doc.path.trim())
    if (skills.length === 0 && docs.length === 0) return

    const conn = await getSpaceConnection(spaceId)
    // The gate stands between the skills and nothing else: the documents below are plain file
    // writes and land on a machine of any age.
    if (skills.length > 0 && (await canInstallClientSkills(conn, agent, warnings))) {
        for (const skill of skills) {
            await importSkill(conn, engineAgentId, skill.raw || authoredSkillMarkdown(skill), skill.files, { slug: clientSkillSlug(client.id, skill.name), overwrite: true }).catch(() => {
                warnings.push(`"${agent.name}" did not get "${skill.name.trim()}" from ${client.name}.`)
            })
        }
        await removeSkillsTheClientDropped(conn, client, { name: agent.name, engine_agent_id: engineAgentId }, skills, warnings)
    }
    if (docs.length > 0) {
        const base = `/agents/${engineAgentId}/files`
        const dir = clientKnowledgeDir(client.id)
        await makeDir(conn, base, dir).catch(() => {})
        for (const doc of docs) {
            await writeFileText(conn, base, `${dir}/${doc.path.trim()}`, doc.content).catch(() => {
                warnings.push(`"${agent.name}" did not get the document "${doc.path.trim()}".`)
            })
        }
    }
}

// What a Box leaves behind when it changes client. The caller passes the slugs the coworker
// actually has, and only those inside this client's namespace are touched — a coworker's own
// skills, and another client's, are never in it.
export async function removeClientExtras(client: ClientView, spaceId: string, agent: ClientTarget, installedSlugs: readonly string[], warnings: string[]): Promise<void> {
    const engineAgentId = agent.engine_agent_id
    if (!engineAgentId) return

    const conn = await getSpaceConnection(spaceId)
    for (const slug of installedSlugs) {
        if (!isClientSkillSlug(client.id, slug)) continue
        await deleteSkill(conn, engineAgentId, slug).catch(() => {
            warnings.push(`"${agent.name}" kept "${slug}", which came from ${client.name}.`)
        })
    }
    await deleteFile(conn, `/agents/${engineAgentId}/files`, clientKnowledgeDir(client.id)).catch(() => {
        warnings.push(`"${agent.name}" kept the documents of ${client.name}.`)
    })
}
