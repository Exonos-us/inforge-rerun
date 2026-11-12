import { BOX_MANAGE_ONLY, BOX_NOT_FOUND, COWORKER_NOT_FOUND, enforce, readSpaceAccess, type Actor } from '@/app/api/_auth/access'
import { AuthorizationError } from '@/app/api/_auth/ownership'
import type { Database } from '@/app/api/database.types'
import {
    createAgent as engineCreateAgent,
    deleteAgent as engineDeleteAgent,
    duplicateAgent as engineDuplicateAgent,
    importAgentArchive,
    listSchedules,
    patchAgent as enginePatchAgent,
    updateSchedule,
} from '@/lib/engine/client'
import type { EngineAgentConfigPatch } from '@/lib/engine/types'
import { AGENT_SPAN, UNPLACED_COL, agentsOverlap, isPlaced } from '@/lib/board/iso'
import type { GridPosition } from '@/lib/board/types'
import { createServiceRoleClient } from '@/supabase/serviceRole'
import { selectMany, selectSingle } from '@/supabase/supabase-helpers'
import { sanitizeIdentifier } from '@/lib/utils'
import { duplicateAgentName } from '@/lib/copy-name'
import { PLAN_LIMIT_REASON, hasFreeAgentSlot } from './capacity.service'
import { getSpaceConnection } from './space.service'

type CreateAgentParams = {
    name: string
    description?: string
    soulMd?: string
    // The INSTALL.md a copy of this agent replays on its new owner's account. Only meaningful
    // alongside config.setup.required, which is what decides whether it ever runs.
    installMd?: string
    // Who creates it. Creating a coworker in a Box takes `manage` on that Box.
    actor: Actor
    workspaceId: number
    spaceId: string
    // Explicit grid anchor chosen by the user during placement. When omitted we fall
    // back to findFreeCellInSpace (programmatic creation without a placement step).
    position?: GridPosition
    // Model, tool families and self-improvement flags to apply at creation rather than in a
    // follow-up patch, so an agent is never briefly live under settings nobody asked for.
    config?: Omit<EngineAgentConfigPatch, 'name' | 'displayName' | 'description'>
    // Decided by a caller that creates several agents at once: the handle and the free slot are
    // read-then-write, and re-reading them per agent would hand two parallel creations the same one.
    handle?: string
    enabled?: boolean
}

// Scan the space for a free anchor (top/north cell) where the agent's footprint fits without
// overlapping an existing one, so a freshly created agent lands inside its space instead of
// waiting in the unplaced toolbar. Returns null when nothing fits, in which case we leave the
// agent unplaced for manual placement.
export async function findFreeCellInSpace(supabase: ReturnType<typeof createServiceRoleClient>, spaceId: string): Promise<GridPosition | null> {
    const [cell] = await findFreeCellsInSpace(supabase, spaceId, 1)
    return cell ?? null
}

// The same scan for several agents landing in one pass: each cell handed out counts as taken for the
// next, which a per-agent re-read cannot see before the rows are inserted. Shorter than `count` when
// the space runs out of room.
export async function findFreeCellsInSpace(supabase: ReturnType<typeof createServiceRoleClient>, spaceId: string, count: number): Promise<GridPosition[]> {
    const { data: space } = await selectSingle(supabase, 'spaces', ['col_start', 'row_start', 'col_end', 'row_end'] as const, { id: spaceId })
    if (!space) return []

    const colMin = Math.min(space.col_start, space.col_end)
    const colMax = Math.max(space.col_start, space.col_end)
    const rowMin = Math.min(space.row_start, space.row_end)
    const rowMax = Math.max(space.row_start, space.row_end)

    const { data: occupants } = await selectMany(supabase, 'agents', ['col', 'row'] as const, { space_id: spaceId })
    const anchors = (occupants ?? []).filter(a => isPlaced(a)).map(a => ({ col: a.col, row: a.row }))

    const cells: GridPosition[] = []
    for (let row = rowMin; row <= rowMax - (AGENT_SPAN - 1) && cells.length < count; row++) {
        for (let col = colMin; col <= colMax - (AGENT_SPAN - 1) && cells.length < count; col++) {
            if (anchors.some(o => agentsOverlap({ col, row }, o))) continue
            cells.push({ col, row })
            anchors.push({ col, row })
        }
    }

    return cells
}

// Moving an agent between two Boxes is three columns: a Box is a rectangle on the board, the whole
// workspace runs on one engine, and the agent keeps its folder, its handle and its sessions. The
// anchor has to move with it: a tile is drawn at its own col/row whichever Box owns it, so keeping
// the old one would park it in the rectangle it just left.
// Moving changes who sees the coworker, so it takes `manage` on the Box it leaves and on the one it
// joins.
export async function moveAgentToBox(agentId: string, spaceId: string, actor: Actor): Promise<{ ok: true; position: GridPosition } | { ok: false; error: string }> {
    const supabase = createServiceRoleClient()
    const { data: agent } = await selectSingle(supabase, 'agents', ['space_id', 'workspace_id'] as const, { id: agentId })
    if (!agent || agent.workspace_id !== actor.workspaceId) return { ok: false, error: 'Coworker not found' }
    if (agent.space_id === spaceId) return { ok: false, error: 'This coworker is already in that Box' }
    const [from, to] = await Promise.all([readSpaceAccess(actor, agent.space_id), readSpaceAccess(actor, spaceId)])
    if (from === 'none') return { ok: false, error: 'Coworker not found' }
    if (to === 'none') return { ok: false, error: 'Box not found' }
    if (from !== 'manage' || to !== 'manage') return { ok: false, error: BOX_MANAGE_ONLY }

    // Refused rather than moved unplaced: an unplaced agent leaves the board, and the toolbar badge
    // that brings it back is a worse place than the one it already had.
    const position = await findFreeCellInSpace(supabase, spaceId)
    if (!position) return { ok: false, error: 'That Box has no room left. Free a cell in it first.' }

    const { error } = await supabase.from('agents').update<Database['public']['Tables']['agents']['Update']>({ space_id: spaceId, col: position.col, row: position.row }).eq('id', agentId)
    if (error) return { ok: false, error: `Failed to move agent: ${error.message}` }

    return { ok: true, position }
}

async function assertCanCreateIn(actor: Actor, workspaceId: number, spaceId: string): Promise<void> {
    if (actor.workspaceId !== workspaceId) throw new AuthorizationError(BOX_NOT_FOUND)
    enforce(await readSpaceAccess(actor, spaceId), 'manage', BOX_NOT_FOUND)
}

function allocateHandle(displayName: string, taken: Set<string>): string {
    const base = sanitizeIdentifier(displayName).replace(/^_+|_+$/g, '') || 'agent'
    let candidate = base
    for (let i = 2; taken.has(candidate); i++) candidate = `${base}_${i}`
    return candidate
}

// The mention token / call_agent resolution key. Derived from the free display name, unique per
// workspace (suffix _2, _3, … on collision), and kept equal to the engine's config.name so
// @mentions resolve on the engine. Workspace-wide rather than per Box, because every Box of a
// workspace now runs on the same engine, where one name means one agent.
export async function deriveUniqueHandle(supabase: ReturnType<typeof createServiceRoleClient>, workspaceId: number, displayName: string, excludeAgentId?: string): Promise<string> {
    const { data } = await selectMany(supabase, 'agents', ['id', 'handle'] as const, { workspace_id: workspaceId })
    const taken = new Set((data ?? []).filter(a => a.id !== excludeAgentId && a.handle).map(a => a.handle as string))
    return allocateHandle(displayName, taken)
}

// A batch allocates against one growing set: the singular form re-reads the table on every call,
// so two agents created in the same pass would be handed the same handle, neither being inserted
// yet.
export async function deriveUniqueHandles(supabase: ReturnType<typeof createServiceRoleClient>, workspaceId: number, displayNames: string[]): Promise<string[]> {
    const { data } = await selectMany(supabase, 'agents', ['handle'] as const, { workspace_id: workspaceId })
    const taken = new Set((data ?? []).filter(a => a.handle).map(a => a.handle as string))
    return displayNames.map(displayName => {
        const handle = allocateHandle(displayName, taken)
        taken.add(handle)
        return handle
    })
}

export async function createAgent(params: CreateAgentParams) {
    const { name, description, soulMd, installMd, workspaceId, spaceId, position, config } = params

    if (!name || !workspaceId || !spaceId) {
        throw new Error('name, workspaceId and spaceId are required')
    }
    await assertCanCreateIn(params.actor, workspaceId, spaceId)

    // The plan caps active agents, not stored ones: without a free slot the agent is still built,
    // it just arrives switched off and waits for the user to free a slot or buy one.
    const enabled = params.enabled ?? (await hasFreeAgentSlot(workspaceId))

    const conn = await getSpaceConnection(spaceId)
    const supabase = createServiceRoleClient()
    const handle = params.handle ?? (await deriveUniqueHandle(supabase, workspaceId, name))

    // The engine scaffolds the agent (SOUL.md, config.json, workspace) and
    // returns its canonical id. We mirror only what the grid UI needs. The engine
    // stores the handle as config.name (mention/resolution key); the free display
    // name goes to displayName (used in the SOUL prompt).
    const detail = await engineCreateAgent(conn, {
        config: { ...config, name: handle, displayName: name, description: description || undefined, enabled },
        soul: soulMd || undefined,
        install: installMd || undefined,
    })

    const cell = position ?? (await findFreeCellInSpace(supabase, spaceId))
    const { data: agent, error } = await supabase
        .from('agents')
        .insert<Database['public']['Tables']['agents']['Insert']>({
            name,
            handle,
            description: description || null,
            engine_agent_id: detail.id,
            workspace_id: workspaceId,
            space_id: spaceId,
            col: cell ? cell.col : UNPLACED_COL,
            row: cell ? cell.row : UNPLACED_COL,
            disabled_at: enabled ? null : new Date().toISOString(),
            disabled_reason: enabled ? null : PLAN_LIMIT_REASON,
        })
        .select()
        .single()

    if (error || !agent) {
        // Roll back the engine-side agent so we don't leak orphans.
        await engineDeleteAgent(conn, detail.id).catch(() => {})
        throw new Error(`Failed to persist agent: ${error?.message ?? 'unknown error'}`)
    }

    await syncProjectNote(agent.id)
    return agent
}

// A coworker born in a Box linked to a Confluence engagement starts with the project note, like
// one moved into it. Lazy import: project-knowledge.service reaches back into services this file
// feeds, and the note is best-effort either way.
async function syncProjectNote(agentId: string): Promise<void> {
    try {
        const { syncAgentProjectNote } = await import('@/app/api/_services/project-knowledge.service')
        await syncAgentProjectNote(agentId)
    } catch {
        // The coworker works without the note; the next link or move rewrites it.
    }
}

type ImportAgentParams = {
    // Who creates it. Creating a coworker in a Box takes `manage` on that Box.
    actor: Actor
    archive: Blob
    name: string
    handle: string
    workspaceId: number
    spaceId: string
    // Grid anchor chosen by the user while placing this agent, same contract as createAgent.
    position?: GridPosition
    // The template this folder came from. It is what makes a revoked purchase actionable: without
    // it there is no way to name the agents a template installed.
    templateId?: string
}

// The mirror of createAgent for a captured folder: the engine unpacks the archive instead of
// scaffolding a new agent, and everything it needs to describe itself (soul, description) comes
// back from the tarball rather than from the caller.
export async function importAgent(params: ImportAgentParams) {
    const { archive, name, handle, workspaceId, spaceId, position, templateId } = params
    await assertCanCreateIn(params.actor, workspaceId, spaceId)

    const enabled = await hasFreeAgentSlot(workspaceId)

    const conn = await getSpaceConnection(spaceId)
    const supabase = createServiceRoleClient()

    const imported = await importAgentArchive(conn, archive, handle, name)
    // The archive carries its own config, so unlike createAgent the flag has to be applied after
    // the unpack rather than passed into it.
    if (!enabled) await enginePatchAgent(conn, imported.id, { enabled: false })

    const cell = position ?? (await findFreeCellInSpace(supabase, spaceId))
    const { data: agent, error } = await supabase
        .from('agents')
        .insert<Database['public']['Tables']['agents']['Insert']>({
            name,
            handle,
            description: imported.description || null,
            engine_agent_id: imported.id,
            workspace_id: workspaceId,
            space_id: spaceId,
            template_id: templateId ?? null,
            col: cell ? cell.col : UNPLACED_COL,
            row: cell ? cell.row : UNPLACED_COL,
            disabled_at: enabled ? null : new Date().toISOString(),
            disabled_reason: enabled ? null : PLAN_LIMIT_REASON,
        })
        .select()
        .single()

    if (error || !agent) {
        await engineDeleteAgent(conn, imported.id).catch(() => {})
        throw new Error(`Failed to persist agent: ${error?.message ?? 'unknown error'}`)
    }

    // A captured folder can bring schedules with it, and an agent that arrives switched off must
    // not start firing them.
    if (!enabled) await pauseAgentSchedules(agent.id).catch(err => console.error('[activation] failed to pause the schedules of an imported agent', agent.id, err))

    await syncProjectNote(agent.id)
    return { agent, imported }
}

type DuplicateAgentParams = {
    // Who creates it. Creating a coworker in a Box takes `manage` on that Box.
    actor: Actor
    agentRowId: string
    workspaceId: number
    spaceId: string
    // Grid anchor chosen by the user while placing the copy, same contract as createAgent.
    position?: GridPosition
}

export type DuplicatedAgent = {
    agent: Database['public']['Tables']['agents']['Row']
    schedules: string[]
    triggers: string[]
}

// An engine that predates the duplicate route answers 404 to a perfectly good request, and the
// only other 404 on that path is an agent the engine really does not have. The body tells them
// apart, so a box being behind never reads as "your agent is gone".
const STALE_DUPLICATE_HINT = 'This workspace runs on a machine whose engine is too old to duplicate coworkers. Ask the Rerun team to update it, then try again.'

function isMissingDuplicateRoute(err: unknown): boolean {
    return err instanceof Error && /failed: 404/.test(err.message) && !err.message.includes('agent not found')
}

// The third way an agent comes into existence, after a scratch creation and an archive import.
// Unlike the import it never leaves the box: the engine copies the folder in place, so the copy
// keeps its keys, its connected services and the model it was pinned to. What this side owns is
// the same as everywhere else — a unique handle, a free cell, and the plan's active-agent cap.
export async function duplicateAgent(params: DuplicateAgentParams): Promise<DuplicatedAgent> {
    const { agentRowId, workspaceId, spaceId, position } = params

    const supabase = createServiceRoleClient()
    const { data: source } = await selectSingle(supabase, 'agents', ['name', 'space_id', 'engine_agent_id', 'description', 'template_id', 'workspace_id'] as const, { id: agentRowId })
    if (!source || source.workspace_id !== workspaceId || !source.engine_agent_id) throw new Error('Coworker not found')
    // A copy carries its source's whole setup, keys and connected services included, so both Boxes
    // have to be managed: the source like a share link, the copy's like any creation.
    enforce(await readSpaceAccess(params.actor, source.space_id), 'manage', COWORKER_NOT_FOUND)
    await assertCanCreateIn(params.actor, workspaceId, spaceId)
    const enabled = await hasFreeAgentSlot(workspaceId)
    const name = duplicateAgentName(source.name)
    const handle = await deriveUniqueHandle(supabase, workspaceId, name)
    const conn = await getSpaceConnection(spaceId)

    let copy
    try {
        copy = await engineDuplicateAgent(conn, source.engine_agent_id, { name: handle, displayName: name })
    } catch (err) {
        throw isMissingDuplicateRoute(err) ? new Error(STALE_DUPLICATE_HINT) : err
    }

    // The copy carries the source's own `enabled`, so the flag is applied after the fact rather
    // than passed in, exactly as for an import.
    if (!enabled) await enginePatchAgent(conn, copy.id, { enabled: false })

    const cell = position ?? (await findFreeCellInSpace(supabase, spaceId))
    const { data: agent, error } = await supabase
        .from('agents')
        .insert<Database['public']['Tables']['agents']['Insert']>({
            name,
            handle,
            description: copy.description || source.description || null,
            engine_agent_id: copy.id,
            workspace_id: workspaceId,
            space_id: spaceId,
            // Inherited on purpose: a copy of a purchased agent is still that template's, and a
            // revoked purchase has to be able to name every agent it installed.
            template_id: source.template_id,
            col: cell ? cell.col : UNPLACED_COL,
            row: cell ? cell.row : UNPLACED_COL,
            disabled_at: enabled ? null : new Date().toISOString(),
            disabled_reason: enabled ? null : PLAN_LIMIT_REASON,
        })
        .select()
        .single()

    if (error || !agent) {
        await engineDeleteAgent(conn, copy.id).catch(() => {})
        throw new Error(`Failed to persist agent: ${error?.message ?? 'unknown error'}`)
    }

    // A copy arrives with the source's schedules enabled. One that landed inactive must not spend
    // on them, same rule as an import.
    if (!enabled) await pauseAgentSchedules(agent.id).catch(err => console.error('[activation] failed to pause the schedules of a duplicated agent', agent.id, err))

    // The copied folder carries the source's project note; the copy's own Box decides it.
    await syncProjectNote(agent.id)
    return { agent, schedules: copy.schedules, triggers: copy.triggers }
}

// The engine half of disabling an agent, for a template subscription that has ended. Nothing is
// deleted: memories, files and skills have to survive, because re-subscribing must give the buyer
// their agent back rather than a fresh one. What stops it from acting and spending is its
// schedules, so those are paused.
//
// The DB flag (`agents.disabled_at`) is written separately and first, by the caller: it is what the
// chat and install gates read, so an engine that is asleep can never leave a revoked agent usable.
//
// Only the schedules that were running are recorded, so resuming restores exactly those and leaves
// whatever the user had switched off themselves switched off.
export async function pauseAgentSchedules(id: string): Promise<void> {
    const supabase = createServiceRoleClient()
    const { data: agent } = await selectSingle(supabase, 'agents', ['engine_agent_id', 'space_id'] as const, { id })
    if (!agent?.engine_agent_id) return

    const conn = await getSpaceConnection(agent.space_id)
    const schedules = await listSchedules(conn, agent.engine_agent_id)
    const paused: string[] = []

    for (const schedule of schedules.filter(s => s.enabled)) {
        await updateSchedule(conn, agent.engine_agent_id, schedule.slug, { enabled: false })
        paused.push(schedule.slug)
    }

    await supabase.from('agents').update<Database['public']['Tables']['agents']['Update']>({ disabled_schedule_slugs: paused }).eq('id', id)
}

export async function resumeAgentSchedules(id: string): Promise<void> {
    const supabase = createServiceRoleClient()
    const { data: agent } = await selectSingle(supabase, 'agents', ['engine_agent_id', 'space_id', 'disabled_schedule_slugs'] as const, { id })
    if (!agent?.engine_agent_id || agent.disabled_schedule_slugs.length === 0) return

    const conn = await getSpaceConnection(agent.space_id)
    for (const slug of agent.disabled_schedule_slugs) {
        await updateSchedule(conn, agent.engine_agent_id, slug, { enabled: true })
    }

    await supabase.from('agents').update<Database['public']['Tables']['agents']['Update']>({ disabled_schedule_slugs: [] }).eq('id', id)
}

// The handle follows the name, so what other coworkers write after @ always matches what the user
// sees. The engine rewrites every `@oldHandle` written into the other agents' souls, skills,
// schedules and memories in the same PATCH, which is what keeps their calls resolving. The engine
// is written first: it is the side that can be unreachable, and a handle moved in Supabase alone
// would be offered in the UI while call_agent still only answers to the old one.
export async function renameAgent(id: string, newName: string) {
    const supabase = createServiceRoleClient()
    const { data: agent } = await selectSingle(supabase, 'agents', ['workspace_id', 'space_id', 'engine_agent_id', 'handle'] as const, { id })
    if (!agent) throw new Error('Coworker not found')

    const handle = await deriveUniqueHandle(supabase, agent.workspace_id, newName, id)
    if (agent.engine_agent_id) {
        const conn = await getSpaceConnection(agent.space_id)
        await enginePatchAgent(conn, agent.engine_agent_id, { name: handle, displayName: newName })
    }

    const { error } = await supabase.from('agents').update<Database['public']['Tables']['agents']['Update']>({ name: newName, handle }).eq('id', id)
    if (error) throw new Error(`Failed to rename agent: ${error.message}`)

    return { name: newName, handle, handleChanged: handle !== agent.handle }
}

// A handle that no longer follows the name, set on purpose. The engine rewrites the `@oldHandle`
// references the same way it does for a rename.
export async function changeAgentHandle(id: string, requestedHandle: string) {
    const supabase = createServiceRoleClient()
    const { data: agent } = await selectSingle(supabase, 'agents', ['workspace_id', 'space_id', 'engine_agent_id', 'name', 'handle'] as const, { id })
    if (!agent) throw new Error('Coworker not found')

    const handle = sanitizeIdentifier(requestedHandle).replace(/^_+|_+$/g, '')
    if (!handle) throw new Error(`"${requestedHandle}" leaves nothing usable as a handle. Use letters, digits and underscores.`)

    if (handle !== agent.handle) {
        const { data: siblings } = await selectMany(supabase, 'agents', ['id', 'handle'] as const, { workspace_id: agent.workspace_id })
        if ((siblings ?? []).some(sibling => sibling.id !== id && sibling.handle === handle)) {
            throw new Error(`Another coworker in this workspace already answers to "${handle}".`)
        }
    }

    if (agent.engine_agent_id) {
        const conn = await getSpaceConnection(agent.space_id)
        await enginePatchAgent(conn, agent.engine_agent_id, { name: handle })
    }

    const { error } = await supabase.from('agents').update<Database['public']['Tables']['agents']['Update']>({ handle }).eq('id', id)
    if (error) throw new Error(`Failed to change the handle: ${error.message}`)

    return { name: agent.name, handle }
}

export async function deleteAgent(id: string) {
    const supabase = createServiceRoleClient()

    const { data: agent } = await selectSingle(supabase, 'agents', ['engine_agent_id', 'space_id'] as const, { id })

    if (!agent) {
        throw new Error('Coworker not found')
    }

    if (agent.engine_agent_id) {
        const conn = await getSpaceConnection(agent.space_id)
        await engineDeleteAgent(conn, agent.engine_agent_id).catch(() => {})
    }

    await supabase.from('agents').delete().eq('id', id)

    return { success: true }
}
