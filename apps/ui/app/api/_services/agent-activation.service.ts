import type { Database } from '@/app/api/database.types'
import { patchAgent as enginePatchAgent } from '@/lib/engine/client'
import { createServiceRoleClient } from '@/supabase/serviceRole'
import { selectAll, selectSingle } from '@/supabase/supabase-helpers'
import { pauseAgentSchedules, resumeAgentSchedules } from './agent.service'
import { PLAN_LIMIT_REASON, activeAgentLimit, hasFreeAgentSlot, isPlanLimited } from './capacity.service'
import { getSpaceConnection } from './space.service'

// Losing a plan never destroys work: a downgrade or a cancellation switches agents off and leaves
// them where they are, and buying the capacity back is what lets the user switch them on again.
//
// The split mirrors the template revocation service: the DB flag is written synchronously because
// it is what every gate reads, while reaching the engine can hang on a box that is asleep and is
// therefore handed to a Trigger task.

type AgentUpdate = Database['public']['Tables']['agents']['Update']

// Switch off whatever exceeds the workspace's current allowance, oldest agents first: the ones the
// user built their setup around stay up, the newest go quiet. Never switches anything back on:
// regaining capacity frees slots, and filling them is an explicit choice (activateAgent), a trial
// turning into a plan, or an archive coming back (wakePlanLimitedAgents).
// Returns the ids that were switched off, for the caller to hand to the engine.
export async function reconcileAgentActivation(workspaceId: number): Promise<string[]> {
    const limit = await activeAgentLimit(workspaceId)
    if (limit === null) return []

    const supabase = createServiceRoleClient()
    const { data: active } = await selectAll(supabase, 'agents', ['id'] as const, { workspace_id: workspaceId, disabled_at: { isNull: true } }, { column: 'created_at', ascending: true })

    const excess = (active ?? []).slice(limit).map(agent => agent.id)
    if (excess.length === 0) return []

    await supabase
        .from('agents')
        .update<AgentUpdate>({ disabled_at: new Date().toISOString(), disabled_reason: PLAN_LIMIT_REASON })
        .in('id', excess)

    return excess
}

// The DB half of switching back on what the plan's limit had switched off, oldest first, as many as
// the plan now has room for. Two moments call it: a trial turning into a plan, whose limit of
// active coworkers is gone, and an archive coming back (reactivateAgentsAfterRestore). Returns the
// ids it woke, for the caller to reach their engine.
export async function wakePlanLimitedAgents(workspaceId: number): Promise<{ woken: string[]; active: string[] }> {
    const limit = await activeAgentLimit(workspaceId)
    if (limit === 0) return { woken: [], active: [] }

    const supabase = createServiceRoleClient()
    const [{ data: active }, { data: switchedOff }] = await Promise.all([
        selectAll(supabase, 'agents', ['id'] as const, { workspace_id: workspaceId, disabled_at: { isNull: true } }),
        selectAll(supabase, 'agents', ['id'] as const, { workspace_id: workspaceId, disabled_reason: PLAN_LIMIT_REASON }, { column: 'created_at', ascending: true }),
    ])
    const freeSlots = limit === null ? Infinity : Math.max(0, limit - (active ?? []).length)
    const woken = (switchedOff ?? []).slice(0, freeSlots).map(agent => agent.id)

    if (woken.length > 0) await supabase.from('agents').update<AgentUpdate>({ disabled_at: null, disabled_reason: null }).in('id', woken)
    return { woken, active: (active ?? []).map(agent => agent.id) }
}

// A workspace that lost its plan was archived with every agent off, and paying again restores it:
// the customer was promised it comes back as they left it, so the agents the plan has room for wake
// up with it, oldest first, as reconcileAgentActivation would have kept them. Runs once the restored
// engine passed its canary.
export async function reactivateAgentsAfterRestore(workspaceId: number): Promise<string[]> {
    const { woken, active } = await wakePlanLimitedAgents(workspaceId)

    // Every agent the plan runs, not only the ones just woken: the archive was taken with all of
    // them switched off on the engine.
    for (const agentId of active) await startAgentOnEngine(agentId)
    for (const agentId of woken) await startAgentOnEngine(agentId)
    return woken
}

export const NO_FREE_SLOT_ERROR = 'No free coworker slot on your plan. Start Pro for unlimited coworkers, or delete a coworker to make room.'
const TEMPLATE_REVOKED_ERROR = 'This coworker came from a template subscription that has ended. Buy the template again to bring it back.'

// The only way an agent is ever switched back on. There is no matching "deactivate": the plan
// decides how many agents run, the user decides which ones, and letting them toggle freely would
// turn a paid limit into a scheduling game.
export async function activateAgent(agentId: string): Promise<void> {
    const supabase = createServiceRoleClient()
    const { data: agent } = await selectSingle(supabase, 'agents', ['workspace_id', 'disabled_at', 'disabled_reason'] as const, { id: agentId })
    if (!agent) throw new Error('Coworker not found')
    if (!agent.disabled_at) return
    if (!isPlanLimited(agent.disabled_reason)) throw new Error(TEMPLATE_REVOKED_ERROR)
    if (!(await hasFreeAgentSlot(agent.workspace_id))) throw new Error(NO_FREE_SLOT_ERROR)

    await supabase.from('agents').update<AgentUpdate>({ disabled_at: null, disabled_reason: null }).eq('id', agentId)

    // The flag above is what every gate reads, so the agent is usable from here on. Reaching its
    // box can still fail (asleep, updating), and that must not read as a failed activation: the
    // worst case is schedules that stay paused until the next attempt.
    await startAgentOnEngine(agentId)
}

// The engine half of a deactivation. Pausing the schedules is what stops an agent from waking
// itself up; the config flag is what stops its peers from calling it. Both are best-effort per
// agent: one unreachable box must not leave the rest of the batch running.
export async function stopAgentsOnEngine(agentIds: string[]): Promise<void> {
    for (const agentId of agentIds) {
        await attempt(`pause the schedules of ${agentId}`, () => pauseAgentSchedules(agentId))
        await attempt(`switch off ${agentId}`, () => setEngineAgentEnabled(agentId, false))
    }
}

export async function startAgentOnEngine(agentId: string): Promise<void> {
    await attempt(`switch on ${agentId}`, () => setEngineAgentEnabled(agentId, true))
    await attempt(`resume the schedules of ${agentId}`, () => resumeAgentSchedules(agentId))
}

// The two engine calls are independent: an engine too old to know the config flag must not cost
// the agent its schedules, and a box that is asleep must not stop the rest of a batch.
async function attempt(what: string, run: () => Promise<void>): Promise<void> {
    try {
        await run()
    } catch (err) {
        console.error(`[activation] failed to ${what}`, err)
    }
}

export async function setEngineAgentEnabled(agentId: string, enabled: boolean): Promise<void> {
    const supabase = createServiceRoleClient()
    const { data: agent } = await selectSingle(supabase, 'agents', ['engine_agent_id', 'space_id'] as const, { id: agentId })
    if (!agent?.engine_agent_id) return

    const conn = await getSpaceConnection(agent.space_id)
    await enginePatchAgent(conn, agent.engine_agent_id, { enabled })
}
