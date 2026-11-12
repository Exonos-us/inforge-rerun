import 'server-only'

import type { Actor } from '@/app/api/_auth/access'
import type { Database } from '@/app/api/database.types'
import type { GridPosition } from '@/lib/board/types'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createAgent, deriveUniqueHandles, findFreeCellsInSpace, importAgent } from '@/app/api/_services/agent.service'
import { createBoxesBatch } from '@/app/api/_services/box.service'
import { resolveAgentTarget } from '@/app/api/_services/chat.service'
import { getSpaceConnection } from '@/app/api/_services/space.service'
import { bindCoworker, connectionForWorkspace, invitePrivateChannelCreator, slackChannels } from '@/app/api/_services/slack.service'
import { defaultExcludedPaths } from '@rerun/contracts'
import { captureAgentArchive } from '@/lib/agents/capture-archive'
import { createMemory, createSchedule, createSkill, getAgent, importSkill, makeDir, patchAgent, planAgentArchive, writeFileText } from '@/lib/engine/client'
import { randomUuid } from '@/lib/random-uuid'
import {
    authoredRoutinesFromRow,
    authoredSkillsFromRow,
    connectorSlugsFromRow,
    knowledgeDocsFromRow,
    presetQuestionsFromRow,
    presetSummaryFromRow,
    tagsFromRow,
    teamMembersFromRow,
    type AuthoredRoutine,
    type AuthoredSkill,
    type KnowledgeDoc,
    type PresetQuestion,
    type PresetSummary,
    type TeamPresetMember,
} from '@/lib/presets/types'
import { createChannel, postMessage } from '@/lib/slack/api'
import { downloadPrivateFile, removePrivateFiles, uploadPrivateFile } from '@/lib/storage/private'
import { connectorSkillSlugs, entriesOfSlug, readRegistry, upsertRegistryEntry } from '@/lib/services/registry'
import { AGENT_ARCHIVE_BUCKET } from '@/lib/templates/archives'
import { projectAgent } from '@/lib/templates/archives'
import { createServiceRoleClient } from '@/supabase/serviceRole'
import { selectMany, selectMaybeSingle } from '@/supabase/supabase-helpers'

// A preset is a workspace-local capture of a coworker: the same archive a template ships, without
// the marketplace. Saving one strips credentials and memory on the way out (the engine's export
// does), so a hire always starts fresh, wired the same way.

const PRESET_COLUMNS = ['id', 'name', 'role', 'description', 'icon', 'tags', 'connector_slugs', 'summary', 'questions', 'soul', 'skills', 'routines', 'knowledge', 'archive_path', 'archive_bytes', 'hires', 'updated_at'] as const
const TEAM_COLUMNS = ['id', 'name', 'description', 'tags', 'members', 'updated_at'] as const

export type CoworkerPresetView = {
    id: string
    name: string
    role: string
    description: string
    // A Slack :shortcode:, the same value a channel binding stores.
    icon: string
    tags: string[]
    connectorSlugs: string[]
    summary: PresetSummary
    questions: PresetQuestion[]
    // A from-scratch preset carries its instructions here and has no archive; a captured one keeps
    // the soul inside the archive, where re-capturing refreshes it.
    soul: string | null
    // Written on the preset itself, materialized on every hire beside what the archive carries.
    authoredSkills: AuthoredSkill[]
    authoredRoutines: AuthoredRoutine[]
    knowledgeDocs: KnowledgeDoc[]
    captured: boolean
    hires: number
    updatedAt: string
}

export type TeamPresetView = {
    id: string
    name: string
    description: string
    tags: string[]
    members: TeamPresetMember[]
    updatedAt: string
}

type PresetRow = Pick<Database['public']['Tables']['coworker_presets']['Row'], (typeof PRESET_COLUMNS)[number]>

function presetView(row: PresetRow): CoworkerPresetView {
    return {
        id: row.id,
        name: row.name,
        role: row.role,
        description: row.description,
        icon: row.icon,
        tags: tagsFromRow.parse(row.tags),
        connectorSlugs: connectorSlugsFromRow.parse(row.connector_slugs),
        summary: presetSummaryFromRow.parse(row.summary),
        questions: presetQuestionsFromRow.parse(row.questions),
        soul: row.soul,
        authoredSkills: authoredSkillsFromRow.parse(row.skills),
        authoredRoutines: authoredRoutinesFromRow.parse(row.routines),
        knowledgeDocs: knowledgeDocsFromRow.parse(row.knowledge),
        captured: row.archive_path !== null,
        hires: row.hires,
        updatedAt: row.updated_at,
    }
}

export async function listCoworkerPresets(supabase: SupabaseClient<Database>, workspaceId: number): Promise<CoworkerPresetView[]> {
    const { data } = await selectMany(supabase, 'coworker_presets', PRESET_COLUMNS, { workspace_id: workspaceId }, { column: 'updated_at', ascending: false })
    return (data ?? []).map(presetView)
}

export async function listTeamPresets(supabase: SupabaseClient<Database>, workspaceId: number): Promise<TeamPresetView[]> {
    const { data } = await selectMany(supabase, 'team_presets', TEAM_COLUMNS, { workspace_id: workspaceId }, { column: 'updated_at', ascending: false })
    return (data ?? []).map(row => ({
        id: row.id,
        name: row.name,
        description: row.description,
        tags: tagsFromRow.parse(row.tags),
        members: teamMembersFromRow.parse(row.members),
        updatedAt: row.updated_at,
    }))
}

function presetArchivePath(workspaceId: number): string {
    return `presets/${workspaceId}/${randomUuid()}.tar.gz`
}

// A preset is the definition — the soul, the skills, the schedules, the connector registry — and
// the workspace folder is what the agent made: recordings, drafts, project files a fresh hire
// starts without (70 MB of them, on a coworker that spent a day recording videos). Only
// workspace/.rerun travels: it is how the copy knows its connectors.
function presetExcludedPaths(plan: Awaited<ReturnType<typeof planAgentArchive>>): string[] {
    const artifacts = plan.files.filter(file => file.path.startsWith('workspace/') && !file.path.startsWith('workspace/.rerun/')).map(file => file.path)
    return [...new Set([...defaultExcludedPaths(plan), ...artifacts])]
}

// Captures the agent's folder as it stands and keeps the editorial projection the store renders.
// The capture is the template capture, scoped down: no marketplace document, one row instead.
export async function saveAgentAsPreset(params: { workspaceId: number; agentId: string; actor: Actor; createdBy: string }): Promise<CoworkerPresetView> {
    const { conn, engineAgentId } = await resolveAgentTarget(params.agentId, params.actor, 'manage')

    const probe = await planAgentArchive(conn, engineAgentId)
    const { plan, bytes } = await captureAgentArchive(conn, engineAgentId, presetExcludedPaths(probe))
    const connectorSkills = connectorSkillSlugs(await readRegistry(conn, engineAgentId))
    const projected = projectAgent(plan, 'preset', connectorSkills)
    // The soul is stored on the row as well, so the store can show and edit it; at hire an edited
    // one is patched over what the archive carries.
    const detail = await getAgent(conn, engineAgentId).catch(() => null)

    const supabase = createServiceRoleClient()
    const path = presetArchivePath(params.workspaceId)
    await uploadPrivateFile(supabase, AGENT_ARCHIVE_BUCKET, path, bytes, 'application/gzip')

    const summary: PresetSummary = { skills: projected.skills, schedules: projected.schedules, tools: projected.tools }
    const { data: row, error } = await supabase
        .from('coworker_presets')
        .insert<Database['public']['Tables']['coworker_presets']['Insert']>({
            workspace_id: params.workspaceId,
            name: projected.name,
            // The hire's Slack identity starts here; the store lets each preset pick its own.
            icon: ':robot_face:',
            description: projected.description,
            soul: detail?.soul || null,
            connector_slugs: projected.connectorSlugs,
            summary,
            archive_path: path,
            archive_bytes: bytes.byteLength,
            engine_commit: plan.engineCommit,
            source_agent_id: params.agentId,
            created_by: params.createdBy,
        })
        .select(PRESET_COLUMNS.join(','))
        .single<PresetRow>()
    if (error || !row) {
        await removePrivateFiles(supabase, AGENT_ARCHIVE_BUCKET, [path]).catch(() => {})
        throw new Error(error?.message ?? 'Could not save the preset')
    }
    return presetView(row)
}

// A written-from-scratch definition: no engine round trip, no archive. The hire scaffolds a fresh
// agent from the soul, exactly the way "New coworker" on the board does.
export async function createCoworkerPresetFromScratch(params: { workspaceId: number; name: string; role: string; description: string; soul: string; tags: string[]; createdBy: string }): Promise<CoworkerPresetView> {
    const supabase = createServiceRoleClient()
    const { data: row, error } = await supabase
        .from('coworker_presets')
        .insert<Database['public']['Tables']['coworker_presets']['Insert']>({
            workspace_id: params.workspaceId,
            name: params.name,
            role: params.role,
            description: params.description,
            icon: ':robot_face:',
            tags: params.tags,
            soul: params.soul || null,
            archive_path: null,
            created_by: params.createdBy,
        })
        .select(PRESET_COLUMNS.join(','))
        .single<PresetRow>()
    if (error || !row) throw new Error(error?.message ?? 'Could not create the preset')
    return presetView(row)
}

// A new preset standing on an existing one: the whole definition copied, the archive file too —
// two presets must never share one object, because deleting either removes its archive.
export async function duplicateCoworkerPreset(workspaceId: number, presetId: string, createdBy: string): Promise<CoworkerPresetView> {
    const supabase = createServiceRoleClient()
    const { data: source } = await selectMaybeSingle(
        supabase,
        'coworker_presets',
        ['name', 'role', 'description', 'icon', 'tags', 'connector_slugs', 'summary', 'questions', 'soul', 'skills', 'routines', 'knowledge', 'archive_path', 'archive_bytes', 'engine_commit', 'source_agent_id'] as const,
        { id: presetId, workspace_id: workspaceId }
    )
    if (!source) throw new Error('That preset is gone.')

    let archivePath: string | null = source.archive_path
    if (archivePath) {
        const copyPath = presetArchivePath(workspaceId)
        const { error } = await supabase.storage.from(AGENT_ARCHIVE_BUCKET).copy(archivePath, copyPath)
        if (error) throw new Error(error.message)
        archivePath = copyPath
    }

    const { data: row, error } = await supabase
        .from('coworker_presets')
        .insert<Database['public']['Tables']['coworker_presets']['Insert']>({
            workspace_id: workspaceId,
            name: `${source.name} (copy)`,
            role: source.role,
            description: source.description,
            icon: source.icon,
            tags: source.tags,
            connector_slugs: source.connector_slugs,
            summary: source.summary,
            questions: source.questions,
            soul: source.soul,
            skills: source.skills,
            routines: source.routines,
            knowledge: source.knowledge,
            archive_path: archivePath,
            archive_bytes: source.archive_bytes,
            engine_commit: source.engine_commit,
            source_agent_id: source.source_agent_id,
            created_by: createdBy,
        })
        .select(PRESET_COLUMNS.join(','))
        .single<PresetRow>()
    if (error || !row) {
        if (archivePath && archivePath !== source.archive_path) await removePrivateFiles(supabase, AGENT_ARCHIVE_BUCKET, [archivePath]).catch(() => {})
        throw new Error(error?.message ?? 'Could not duplicate the preset')
    }
    return presetView(row)
}

export type PresetPatch = { name?: string; role?: string; description?: string; icon?: string; tags?: string[]; soul?: string; skills?: AuthoredSkill[]; routines?: AuthoredRoutine[]; knowledge?: KnowledgeDoc[]; connectorSlugs?: string[]; questions?: PresetQuestion[] }

export async function updateCoworkerPreset(workspaceId: number, presetId: string, patch: PresetPatch): Promise<void> {
    const supabase = createServiceRoleClient()
    const { error } = await supabase
        .from('coworker_presets')
        .update<Database['public']['Tables']['coworker_presets']['Update']>({
            ...(patch.name !== undefined ? { name: patch.name } : {}),
            ...(patch.role !== undefined ? { role: patch.role } : {}),
            ...(patch.description !== undefined ? { description: patch.description } : {}),
            ...(patch.icon !== undefined ? { icon: patch.icon } : {}),
            ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
            ...(patch.soul !== undefined ? { soul: patch.soul || null } : {}),
            ...(patch.skills !== undefined ? { skills: patch.skills } : {}),
            ...(patch.routines !== undefined ? { routines: patch.routines } : {}),
            ...(patch.knowledge !== undefined ? { knowledge: patch.knowledge } : {}),
            ...(patch.connectorSlugs !== undefined ? { connector_slugs: patch.connectorSlugs } : {}),
            ...(patch.questions !== undefined ? { questions: patch.questions } : {}),
            updated_at: new Date().toISOString(),
        })
        .eq('id', presetId)
        .eq('workspace_id', workspaceId)
    if (error) throw new Error(error.message)
}

export async function deleteCoworkerPreset(workspaceId: number, presetId: string): Promise<void> {
    const supabase = createServiceRoleClient()
    const { data: row } = await selectMaybeSingle(supabase, 'coworker_presets', ['id', 'archive_path'] as const, { id: presetId, workspace_id: workspaceId })
    if (!row) return
    if (row.archive_path) await removePrivateFiles(supabase, AGENT_ARCHIVE_BUCKET, [row.archive_path]).catch(() => {})
    const { error } = await supabase.from('coworker_presets').delete().eq('id', presetId).eq('workspace_id', workspaceId)
    if (error) throw new Error(error.message)
}

export async function saveTeamPreset(params: { workspaceId: number; id?: string; name: string; description: string; tags: string[]; members: TeamPresetMember[]; createdBy: string }): Promise<void> {
    const supabase = createServiceRoleClient()
    if (params.id) {
        const { error } = await supabase
            .from('team_presets')
            .update<Database['public']['Tables']['team_presets']['Update']>({ name: params.name, description: params.description, tags: params.tags, members: params.members, updated_at: new Date().toISOString() })
            .eq('id', params.id)
            .eq('workspace_id', params.workspaceId)
        if (error) throw new Error(error.message)
        return
    }
    const { error } = await supabase.from('team_presets').insert<Database['public']['Tables']['team_presets']['Insert']>({
        workspace_id: params.workspaceId,
        name: params.name,
        description: params.description,
        tags: params.tags,
        members: params.members,
        created_by: params.createdBy,
    })
    if (error) throw new Error(error.message)
}

export async function deleteTeamPreset(workspaceId: number, teamId: string): Promise<void> {
    const supabase = createServiceRoleClient()
    const { error } = await supabase.from('team_presets').delete().eq('id', teamId).eq('workspace_id', workspaceId)
    if (error) throw new Error(error.message)
}

export type HireAnswer = { question: string; answer: string }

export type RosterEntry = { presetId: string; name: string; icon: string | null }

export type HireOutcome = {
    spaceId: string
    agents: { id: string; name: string }[]
    channelId: string | null
    failed: { name: string; error: string }[]
    warnings: string[]
}

type ArchiveSource = Pick<Database['public']['Tables']['coworker_presets']['Row'], 'id' | 'archive_path' | 'soul' | 'description' | 'skills' | 'routines' | 'knowledge' | 'connector_slugs' | 'hires'>

async function presetArchives(supabase: SupabaseClient<Database>, workspaceId: number, presetIds: string[]): Promise<Map<string, ArchiveSource>> {
    const { data } = await selectMany(supabase, 'coworker_presets', ['id', 'archive_path', 'soul', 'description', 'skills', 'routines', 'knowledge', 'connector_slugs', 'hires'] as const, { id: { in: presetIds }, workspace_id: workspaceId })
    return new Map((data ?? []).map(row => [row.id, row]))
}

// What the preset carries beyond its archive: instructions edited in the store (patched over what
// the archive unpacked), skills written in the store, created on the fresh agent, and apps assigned
// on the card, marked "needs setup" in the hire's own registry unless the archive already brought
// that app along. Failures warn — the hire itself is the deliverable.
async function applyAuthoredExtras(source: ArchiveSource, spaceId: string, agent: { name: string; engine_agent_id: string | null }, warnings: string[]): Promise<void> {
    const skills = authoredSkillsFromRow.parse(source.skills).filter(skill => skill.name.trim())
    const routines = authoredRoutinesFromRow.parse(source.routines).filter(routine => routine.name.trim())
    const docs = knowledgeDocsFromRow.parse(source.knowledge).filter(doc => doc.path.trim())
    const slugs = connectorSlugsFromRow.parse(source.connector_slugs)
    const soulOverride = source.archive_path !== null && source.soul !== null
    if ((skills.length === 0 && routines.length === 0 && docs.length === 0 && slugs.length === 0 && !soulOverride) || !agent.engine_agent_id) return

    const conn = await getSpaceConnection(spaceId)
    if (soulOverride) {
        await patchAgent(conn, agent.engine_agent_id, { soul: source.soul as string }).catch(() => {
            warnings.push(`"${agent.name}" kept the archive's instructions: the edited ones could not be written.`)
        })
    }
    for (const skill of skills) {
        // An uploaded skill lands verbatim and a hand-written one that carries files composes the
        // SKILL.md it would have had — both through the engine's atomic folder import. A bare
        // hand-written one is just its instructions.
        const create = skill.raw
            ? importSkill(conn, agent.engine_agent_id, skill.raw, skill.files)
            : skill.files.length > 0
              ? importSkill(conn, agent.engine_agent_id, authoredSkillMarkdown(skill), skill.files)
              : createSkill(conn, agent.engine_agent_id, { name: skill.name.trim(), description: skill.description, body: skill.body })
        await create.catch(() => {
            warnings.push(`"${agent.name}" did not get the skill "${skill.name.trim()}".`)
        })
    }
    for (const routine of routines) {
        await createSchedule(conn, agent.engine_agent_id, { name: routine.name.trim(), body: routine.body, cron: routine.cron.trim() || undefined }).catch(() => {
            warnings.push(`"${agent.name}" did not get the routine "${routine.name.trim()}".`)
        })
    }
    if (docs.length > 0) {
        const base = `/agents/${agent.engine_agent_id}/files`
        await makeDir(conn, base, 'knowledge').catch(() => {})
        for (const doc of docs) {
            await writeFileText(conn, base, `knowledge/${doc.path.trim()}`, doc.content).catch(() => {
                warnings.push(`"${agent.name}" did not get the document "${doc.path.trim()}".`)
            })
        }
    }
    if (slugs.length > 0) {
        const registry = await readRegistry(conn, agent.engine_agent_id)
        for (const slug of slugs) {
            if (entriesOfSlug(registry, slug).length > 0) continue
            await upsertRegistryEntry(conn, agent.engine_agent_id, slug, { status: 'needs_config', config: {}, mcpServers: [], envKeys: [], skills: [], installedAt: new Date().toISOString() }).catch(() => {
                warnings.push(`"${agent.name}" did not get "${slug}" assigned.`)
            })
        }
    }
}

// JSON strings are valid YAML double-quoted scalars, so a composed frontmatter survives any name.
function authoredSkillMarkdown(skill: AuthoredSkill): string {
    const quote = (value: string) => JSON.stringify(value.replace(/\s+/g, ' ').trim())
    return `---\nname: ${quote(skill.name)}\ndescription: ${quote(skill.description)}\n---\n\n${skill.body}`
}

// A captured preset is unpacked from its archive; a from-scratch one is scaffolded from its soul,
// the same call the board's "New coworker" makes. Both land as the same agent row.
async function spawnFromSource(source: ArchiveSource, params: { supabase: SupabaseClient<Database>; actor: Actor; workspaceId: number; spaceId: string; name: string; handle: string; position?: GridPosition }) {
    if (source.archive_path) {
        const blob = await downloadPrivateFile(params.supabase, AGENT_ARCHIVE_BUCKET, source.archive_path)
        const { agent } = await importAgent({ archive: blob, name: params.name, handle: params.handle, workspaceId: params.workspaceId, spaceId: params.spaceId, actor: params.actor, position: params.position })
        return agent
    }
    return await createAgent({
        actor: params.actor,
        name: params.name,
        handle: params.handle,
        workspaceId: params.workspaceId,
        spaceId: params.spaceId,
        position: params.position,
        soulMd: source.soul ?? undefined,
        description: source.description || undefined,
    })
}

// The answers a hire gave become plain memories on every coworker of the batch: project facts
// belong to the project, not to the one role whose preset asked the question.
function answerMemories(answers: HireAnswer[]): string[] {
    return answers.filter(a => a.answer.trim()).map(a => `Project fact — ${a.question.trim()} ${a.answer.trim()}`)
}

async function writeAnswers(conn: Awaited<ReturnType<typeof getSpaceConnection>>, engineAgentId: string, memories: string[], warnings: string[], name: string): Promise<void> {
    for (const content of memories) {
        try {
            await createMemory(conn, engineAgentId, { content })
        } catch {
            warnings.push(`"${name}" did not get every project fact written to its memory.`)
            return
        }
    }
}

async function bumpHires(supabase: SupabaseClient<Database>, sources: Map<string, ArchiveSource>, roster: RosterEntry[]): Promise<void> {
    const counts = new Map<string, number>()
    for (const entry of roster) counts.set(entry.presetId, (counts.get(entry.presetId) ?? 0) + 1)
    for (const [presetId, count] of counts) {
        const source = sources.get(presetId)
        if (!source) continue
        await supabase
            .from('coworker_presets')
            .update<Database['public']['Tables']['coworker_presets']['Update']>({ hires: source.hires + count })
            .eq('id', presetId)
    }
}

// One hire into an existing space: the single-coworker path of the store.
export async function hireFromPreset(params: { workspaceId: number; actor: Actor; spaceId: string; roster: RosterEntry; answers: HireAnswer[] }): Promise<HireOutcome> {
    const supabase = createServiceRoleClient()
    const sources = await presetArchives(supabase, params.workspaceId, [params.roster.presetId])
    const source = sources.get(params.roster.presetId)
    if (!source) throw new Error('That preset is gone.')

    const warnings: string[] = []
    const [handle] = await deriveUniqueHandles(supabase, params.workspaceId, [params.roster.name])
    const agent = await spawnFromSource(source, { supabase, actor: params.actor, workspaceId: params.workspaceId, spaceId: params.spaceId, name: params.roster.name, handle })
    await applyAuthoredExtras(source, params.spaceId, agent, warnings)

    const memories = answerMemories(params.answers)
    if (memories.length && agent.engine_agent_id) {
        const conn = await getSpaceConnection(params.spaceId)
        await writeAnswers(conn, agent.engine_agent_id, memories, warnings, agent.name)
    }
    await bumpHires(supabase, sources, [params.roster])

    return { spaceId: params.spaceId, agents: [{ id: agent.id, name: agent.name }], channelId: null, failed: [], warnings }
}

export type HireTeamParams = {
    workspaceId: number
    userId: string
    userEmail: string | null
    actor: Actor
    spaceName: string
    roster: RosterEntry[]
    channel: { name: string; isPrivate: boolean } | null
    answers: HireAnswer[]
}

const CHANNEL_NAME_RE = /^[a-z0-9][a-z0-9-_]{0,78}$/

// The whole kickoff in one call: a space, the roster imported into it, the project facts written
// to each one, and — when Slack is connected and asked for — the channel they all answer in.
// The space and the coworkers are the deliverable; Slack failing is a warning, never a rollback.
export async function hireTeam(params: HireTeamParams): Promise<HireOutcome> {
    if (params.roster.length === 0) throw new Error('The roster is empty.')
    if (!params.spaceName.trim()) throw new Error('The space needs a name.')

    const supabase = createServiceRoleClient()
    const sources = await presetArchives(supabase, params.workspaceId, [...new Set(params.roster.map(entry => entry.presetId))])
    const missing = params.roster.find(entry => !sources.has(entry.presetId))
    if (missing) throw new Error(`The preset behind "${missing.name}" is gone.`)

    const [box] = await createBoxesBatch({ workspaceId: params.workspaceId, userId: params.userId, actor: params.actor, names: [params.spaceName.trim()] })
    if (!box.ok) throw new Error(box.error)
    const spaceId = box.spaceId

    const handles = await deriveUniqueHandles(supabase, params.workspaceId, params.roster.map(entry => entry.name))
    const cells = await findFreeCellsInSpace(supabase, spaceId, params.roster.length)

    const failed: HireOutcome['failed'] = []
    const warnings: string[] = []
    const agents: HireOutcome['agents'] = []
    const engineIds = new Map<string, string>()

    for (const [index, entry] of params.roster.entries()) {
        try {
            const source = sources.get(entry.presetId) as ArchiveSource
            const agent = await spawnFromSource(source, { supabase, actor: params.actor, workspaceId: params.workspaceId, spaceId, name: entry.name, handle: handles[index], position: cells[index] })
            await applyAuthoredExtras(source, spaceId, agent, warnings)
            agents.push({ id: agent.id, name: agent.name })
            if (agent.engine_agent_id) engineIds.set(agent.id, agent.engine_agent_id)
            if (agent.disabled_at) warnings.push(`"${agent.name}" landed switched off: the plan has no free slot for it.`)
        } catch (err) {
            failed.push({ name: entry.name, error: err instanceof Error ? err.message : 'Unknown error' })
        }
    }
    if (agents.length === 0) throw new Error(failed[0]?.error ?? 'No coworker could be hired.')

    const memories = answerMemories(params.answers)
    if (memories.length) {
        const conn = await getSpaceConnection(spaceId)
        for (const agent of agents) {
            const engineAgentId = engineIds.get(agent.id)
            if (engineAgentId) await writeAnswers(conn, engineAgentId, memories, warnings, agent.name)
        }
    }

    await bumpHires(supabase, sources, params.roster)

    let channelId: string | null = null
    if (params.channel) {
        try {
            channelId = await openTeamChannel(params.workspaceId, params.channel, params.roster, agents, { id: params.userId, email: params.userEmail }, warnings)
        } catch (err) {
            warnings.push(`The team is hired, but the Slack channel could not be created: ${err instanceof Error ? err.message : 'unknown error'}`)
        }
    }

    return { spaceId, agents, channelId, failed, warnings }
}

// The same hello the channels screen gives a new channel: created in Slack, every hire bound with
// the identity the roster chose, each one introducing itself so the channel knows the names. A
// name Slack already holds is not an error — the project channel existing first is normal — so
// the team joins it instead.
async function openTeamChannel(workspaceId: number, channel: { name: string; isPrivate: boolean }, roster: RosterEntry[], agents: { id: string; name: string }[], hirer: { id: string; email: string | null }, warnings: string[]): Promise<string> {
    const connection = await connectionForWorkspace(workspaceId)
    if (!connection) throw new Error('Slack is not connected')

    const name = channel.name.trim().toLowerCase().replace(/[^a-z0-9-_]+/g, '-')
    if (!CHANNEL_NAME_RE.test(name)) throw new Error('A channel name is lowercase letters, numbers and hyphens.')

    const created = await createChannel(connection.bot_token, { name, isPrivate: channel.isPrivate }).catch(async err => {
        if (!(err instanceof Error) || !err.message.includes('name_taken')) throw err
        const existing = (await slackChannels(connection)).find(candidate => candidate.name === name)
        if (!existing) throw err
        return existing
    })
    for (const agent of agents) {
        const icon = roster.find(entry => entry.name === agent.name)?.icon ?? null
        await bindCoworker({ connectionId: connection.id, channelId: created.id, channelName: created.name, agentId: agent.id, displayName: agent.name, iconEmoji: icon })
        await postMessage(connection.bot_token, {
            channel: created.id,
            text: `Here. I am *${agent.name}*, one of your Rerun coworkers. Write to me in this channel — put my name at the start if several of us are here — and I answer in a thread.`,
            identity: connection.can_customize_identity ? { name: agent.name } : undefined,
        }).catch(() => {})
    }
    if (channel.isPrivate) {
        const warning = await invitePrivateChannelCreator(connection, created, hirer)
        if (warning) warnings.push(warning)
    }
    return created.id
}
