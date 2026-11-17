import 'server-only'

import type { Database } from '@/app/api/database.types'
import type { SupabaseClient } from '@supabase/supabase-js'
import { supportsSkillImportCreate } from '@/lib/engine/client'
import type { EngineConnection } from '@/lib/engine/types'
import { shortCodeOf } from '@/lib/presets/naming'
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
