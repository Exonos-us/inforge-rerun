import 'server-only'

import type { Database } from '@/app/api/database.types'
import type { PageIndexEntry } from '@/lib/atlassian/confluence'
import { clientKnowledgeDir, clientSkillSlug } from '@/lib/clients/naming'
import { deleteFile, makeDir, writeFileText } from '@/lib/engine/client'
import type { EngineConnection } from '@/lib/engine/types'
import { authoredSkillsFromRow, knowledgeDocsFromRow, type AuthoredSkill } from '@/lib/presets/types'
import { createServiceRoleClient } from '@/supabase/serviceRole'
import { selectMaybeSingle } from '@/supabase/supabase-helpers'

// `.rerun/project.md` is the only thing an engine puts in front of a coworker on every run without
// the coworker choosing it: systemPrompt.ts reads it into the <project_knowledge> section. A skill
// is the opposite — it is offered by its description and the coworker decides whether it applies.
// So who the Box works for belongs here. Left to a skill description it is a judgement call, and a
// coworker that judges wrong writes an off-brand deliverable while believing it was right to.
//
// Two features have something to say in that file, the client of the Box and its Confluence
// engagement, so neither owns it: this module reads both and rebuilds the whole file, and a file
// with no section left is deleted rather than kept empty. It reads its own state so that neither
// service has to import the other.

const PROJECT_NOTE_DIR = '.rerun'
const PROJECT_NOTE_PATH = '.rerun/project.md'

const KNOWLEDGE_COLUMNS = ['site_url', 'space_key', 'space_name', 'page_id', 'page_title', 'page_index'] as const
const CLIENT_COLUMNS = ['id', 'name', 'short_code', 'skills', 'knowledge'] as const

type KnowledgeRow = Pick<Database['public']['Tables']['space_knowledge']['Row'], (typeof KNOWLEDGE_COLUMNS)[number]>

export type ClientNote = { id: string; name: string; shortCode: string; skills: AuthoredSkill[]; hasDocs: boolean }

export function clientNoteSection(client: ClientNote): string {
    const named = client.skills.filter(skill => skill.name.trim())
    const lines = named.map(skill => `- ${skill.name.trim()} (slug: ${clientSkillSlug(client.id, skill.name)})${skill.description.trim() ? ` — ${skill.description.trim()}` : ''}`)
    return [
        `# Client — ${client.name}`,
        `This Box works for ${client.name} (short code \`${client.shortCode}\`). Everything you produce in it is for that engagement, whatever the subject: a document about your own team, another company or an internal programme is still a ${client.name} deliverable and is written to their standard.`,
        named.length
            ? [
                  `${client.name} brings these skills, and they are the house standard here rather than an option:`,
                  lines.join('\n'),
                  `Before you write, format or send anything a person will read, read the one that covers it with skill_read and follow it. Never decide on your own that one of them does not apply because of what the document is about — if you believe it should not, say so in your message and ask, instead of quietly producing the work in your own style.`,
              ].join('\n\n')
            : '',
        client.hasDocs ? `${client.name}'s documents are in \`${clientKnowledgeDir(client.id)}\` in your workspace. Read them before you work on anything for this client.` : '',
    ]
        .filter(Boolean)
        .join('\n\n')
}

export function engagementNoteSection(row: KnowledgeRow, boxName: string): string {
    const scope = row.page_title ? `the engagement "${row.page_title}"` : `the whole client space`
    const index = Array.isArray(row.page_index) ? (row.page_index as PageIndexEntry[]) : []
    return [
        `# Project knowledge`,
        `Your Box "${boxName}" is the project for ${scope} in the Confluence space "${row.space_name}" (key ${row.space_key}, site ${row.site_url}).${row.page_title ? ` Its root page is "${row.page_title}" (page id ${row.page_id}).` : ''}`,
        `These pages are this project's brain, shared with people and other AIs outside Rerun. Before working on anything about this project, read the relevant pages with your atlassian tools (search within space ${row.space_key}). Write back what you learn so the brain stays current: decisions on the Decisions page, meeting preparation under Meeting preps, unknowns under Open questions, each inside this page tree. Edit carefully and comment when unsure; never restructure pages you did not create.`,
        index.length ? `Page index (titles under it):\n${index.map(page => `- ${page.title}`).join('\n')}` : '',
    ]
        .filter(Boolean)
        .join('\n\n')
}

async function clientNoteOfSpace(spaceId: string): Promise<ClientNote | null> {
    const supabase = createServiceRoleClient()
    const { data: space } = await selectMaybeSingle(supabase, 'spaces', ['client_id'] as const, { id: spaceId })
    if (!space?.client_id) return null
    const { data: row } = await selectMaybeSingle(supabase, 'clients', CLIENT_COLUMNS, { id: space.client_id })
    return row ? toClientNote(row) : null
}

export function toClientNote(row: { id: string; name: string; short_code: string; skills: unknown; knowledge: unknown }): ClientNote {
    return {
        id: row.id,
        name: row.name,
        shortCode: row.short_code,
        skills: authoredSkillsFromRow.parse(row.skills),
        hasDocs: knowledgeDocsFromRow.parse(row.knowledge).some(doc => doc.path.trim()),
    }
}

// `client` is passed explicitly by the flow that is changing it, because the Box's row may not
// name the new one yet; everything else reads the state as it stands.
export async function refreshProjectNote(conn: EngineConnection, engineAgentId: string, spaceId: string, client?: ClientNote | null): Promise<void> {
    const supabase = createServiceRoleClient()
    const [space, knowledge] = await Promise.all([
        selectMaybeSingle(supabase, 'spaces', ['name'] as const, { id: spaceId }),
        selectMaybeSingle(supabase, 'space_knowledge', KNOWLEDGE_COLUMNS, { space_id: spaceId }),
    ])
    const resolved = client === undefined ? await clientNoteOfSpace(spaceId) : client
    const sections = [resolved ? clientNoteSection(resolved) : '', knowledge.data ? engagementNoteSection(knowledge.data, space.data?.name ?? 'this project') : '']

    const base = `/agents/${engineAgentId}/files`
    const note = sections.filter(section => section.trim()).join('\n\n---\n\n')
    if (!note) {
        await deleteFile(conn, base, PROJECT_NOTE_PATH)
        return
    }
    await makeDir(conn, base, PROJECT_NOTE_DIR).catch(() => {})
    await writeFileText(conn, base, PROJECT_NOTE_PATH, note)
}
