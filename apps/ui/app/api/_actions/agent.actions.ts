'use server'

import { z } from 'zod'

import { AccessDeniedError, assertAgentInWorkspace, assertSessionInWorkspace, keepVisible, requireLightSessionActor, visibleAgentIds } from '@/app/api/_auth/access'
import { requireWorkspaceId } from '@/app/api/_auth/ownership'
import { activateAgent } from '@/app/api/_services/agent-activation.service'
import { getAgentChatTarget, resolveRunTarget, sessionRowOf } from '@/app/api/_services/chat.service'
import { assertModelEntitled } from '@/app/api/_services/engine-plan.service'
import { getWorkspaceConnection, NoEngineError } from '@/app/api/_services/workspace-engine.service'
import { followCoworker } from '@/app/api/_services/notification-audience.service'
import { getServerSession } from '@/supabase/session/getServerSession'
import { deleteAgent, duplicateAgent, moveAgentToBox, renameAgent } from '@/app/api/_services/agent.service'
import { syncAgentProjectNote } from '@/app/api/_services/project-knowledge.service'
import {
    type ScheduleCreateParams,
    type ScheduleUpdateParams,
    type TriggerCreateParams,
    type TriggerUpdateParams,
    listTriggers as engineListTriggers,
    getTrigger as engineGetTrigger,
    createTrigger as engineCreateTrigger,
    updateTrigger as engineUpdateTrigger,
    deleteTrigger as engineDeleteTrigger,
    rotateTriggerToken as engineRotateTriggerToken,
    clearMemories as engineClearMemories,
    createMemory as engineCreateMemory,
    createSchedule as engineCreateSchedule,
    createSkill as engineCreateSkill,
    importSkill as engineImportSkill,
    skillFilesBase,
    fetchSkillArchive as engineFetchSkillArchive,
    readFileText as engineReadFileText,
    writeFileText as engineWriteFileText,
    deleteFile as engineDeleteFile,
    cancelRun as engineCancelRun,
    cancelSubRun as engineCancelSubRun,
    deleteMemory as engineDeleteMemory,
    deleteSchedule as engineDeleteSchedule,
    deleteSkill as engineDeleteSkill,
    getAgent as engineGetAgent,
    getAgentKeys as engineGetAgentKeys,
    getRun as engineGetRun,
    getRunSteps as engineGetRunSteps,
    getRunTools as engineGetRunTools,
    getAgentUsage as engineGetAgentUsage,
    getAgentStats as engineGetAgentStats,
    getSchedule as engineGetSchedule,
    getSessionMessages as engineGetSessionMessages,
    supportsScheduleRename,
    getSkill as engineGetSkill,
    listAgentTools as engineListAgentTools,
    agentDataBase,
    type ReadDbTableRowsParams,
    listDbTables as engineListDbTables,
    readDbTableRows as engineReadDbTableRows,
    deleteDbTableRows as engineDeleteDbTableRows,
    dropDbTable as engineDropDbTable,
    purgeDbTable as enginePurgeDbTable,
    listMemories as engineListMemories,
    listRuns as engineListRuns,
    listSchedules as engineListSchedules,
    listSessions as engineListSessions,
    listSkills as engineListSkills,
    listSkillSummaries as engineListSkillSummaries,
    patchAgent as enginePatchAgent,
    activateAgentAutomations as engineActivateAgentAutomations,
    patchMcpServers as enginePatchMcpServers,
    recallMemories as engineRecallMemories,
    updateAgentKeys as engineUpdateAgentKeys,
    updateSchedule as engineUpdateSchedule,
    runScheduleNow as engineRunScheduleNow,
    updateSkill as engineUpdateSkill,
} from '@/lib/engine/client'
import { type ParsedSchedule, parseSchedule } from '@/lib/ai/parse-schedule'
import type { TableListResult } from '@/lib/data/source'
import { transformEngineMessages } from '@/lib/chat/engine-history'
import { findPendingHitl, pendingSecrets } from '@/lib/chat-hitl'
import type { EngineConnection, EngineAgentConfigPatch, EngineAgentDetail, EngineMcpServer, EngineDbRows, EngineMemory, EngineRun, EngineRunDetail, EngineRunStep, EngineSchedule, EngineTrigger, EngineSkill, EngineSkillFilePayload, EngineSkillSummary, EngineSkillWithSource, EngineToolCall, EngineToolFamily, EngineUsageBucket, EngineStatsPoint } from '@/lib/engine/types'
import type { StatsQuery, UsageTimeRange } from '@rerun/contracts'
import { FOREMAN_AGENT_ID, statsQuerySchema } from '@rerun/contracts'
import { LOCKED_DOWNLOAD_ERROR, LOCKED_WRITE_ERROR, sealAgentDetail, sealSchedule, sealSkill, sealSkillFile, sealTrigger } from '@/app/api/_services/agent-content.service'
import { connectorMcpServerNames, connectorSkillOwners, connectorSkillSlugs, readRegistry } from '@/lib/services/registry'
import { TEXT_FILE_PAGE_CHARS, connectorSkillReadOnlyError } from '@rerun/contracts'
import { nextRunAt } from '@/lib/schedules/cron'
import { latestOutcomes, type TaskOutcome } from '@/lib/schedules/outcomes'
import { selectMany } from '@/supabase/supabase-helpers'
import { createServiceRoleClient } from '@/supabase/serviceRole'

export async function deleteAgentAction(id: string) {
    await assertAgentInWorkspace(id, 'manage')
    return deleteAgent(id)
}

const duplicateInputSchema = z.object({
    agentId: z.string().uuid(),
    spaceId: z.string().uuid(),
    position: z.object({ col: z.number().int(), row: z.number().int() }).optional(),
})

export type DuplicateAgentResult = { ok: true; agentId: string; agentName: string; inactive: boolean; schedules: string[]; triggers: string[] } | { ok: false; error: string }

// Both ends are checked against the session rather than trusted, by duplicateAgent itself: the
// source has to be reachable, and the Box the copy lands in managed. Any Box of the workspace is a
// valid destination: they all run on the same engine, where the copy never leaves the machine.
export async function duplicateAgentAction(input: unknown): Promise<DuplicateAgentResult> {
    try {
        const { agentId, spaceId, position } = duplicateInputSchema.parse(input)
        const actor = await requireLightSessionActor()
        const { agent, schedules, triggers } = await duplicateAgent({ actor, agentRowId: agentId, workspaceId: actor.workspaceId, spaceId, position })
        return { ok: true, agentId: agent.id, agentName: agent.name, inactive: Boolean(agent.disabled_at), schedules, triggers }
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'Could not duplicate this coworker' }
    }
}

const moveInputSchema = z.object({ agentId: z.string().uuid(), spaceId: z.string().uuid() })

export type MoveAgentResult = { ok: true; position: { col: number; row: number } } | { ok: false; error: string }

// Both ends are checked by moveAgentToBox: `manage` on the Box it leaves and on the one it joins.
// Nothing moves on the engine, only the rectangle the agent is drawn in.
export async function moveAgentAction(input: unknown): Promise<MoveAgentResult> {
    try {
        const { agentId, spaceId } = moveInputSchema.parse(input)
        const result = await moveAgentToBox(agentId, spaceId, await requireLightSessionActor())
        // The project note follows the coworker into (or out of) a linked Box, best-effort.
        if (result.ok) await syncAgentProjectNote(agentId).catch(() => {})
        return result
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'Could not move this coworker' }
    }
}

// Ownership goes through assertAgentInWorkspace rather than the usual chat target: that one throws
// on a disabled agent, which is precisely the agent this acts on.
export async function activateAgentAction(agentId: string): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
        await assertAgentInWorkspace(agentId, 'manage')
        await activateAgent(agentId)
        return { ok: true }
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'Failed to activate this coworker' }
    }
}

export async function renameAgentAction(agentId: string, newName: string): Promise<{ name: string; handle: string | null }> {
    await assertAgentInWorkspace(agentId, 'manage')
    return renameAgent(agentId, newName)
}

// --- Agent config (Settings tab) ---

export async function getAgentDetailAction(agentId: string): Promise<EngineAgentDetail | null> {
    try {
        const { conn, engineAgentId, contentLocked } = await getAgentChatTarget(agentId)
        return sealAgentDetail(await engineGetAgent(conn, engineAgentId), contentLocked)
    } catch {
        return null
    }
}

export async function listAgentToolsAction(agentId: string): Promise<EngineToolFamily[]> {
    try {
        const { conn, engineAgentId } = await getAgentChatTarget(agentId)
        return await engineListAgentTools(conn, engineAgentId)
    } catch {
        return []
    }
}

// Skipping the install is still the end of it, so the agent's schedules and webhooks are switched
// on as if it had closed the setup itself. Silent on failure, like the setup read above: an
// unreachable box, or an engine too old to know the route, must not turn a skip into an error.
export async function activateAgentAutomationsAction(agentId: string): Promise<void> {
    try {
        const { conn, engineAgentId } = await getAgentChatTarget(agentId, 'manage')
        await engineActivateAgentAutomations(conn, engineAgentId)
    } catch {}
}

export async function updateAgentConfigAction(agentId: string, patch: EngineAgentConfigPatch & { soul?: string; install?: string }): Promise<{ success: boolean; error?: string }> {
    try {
        const { conn, engineAgentId, contentLocked } = await resolveRunTarget(agentId, 'manage')
        await assertModelEntitled(patch.model)
        // Same reason as the skill body: a sealed soul is dropped from the patch, not written back.
        await enginePatchAgent(conn, engineAgentId, contentLocked ? { ...patch, soul: undefined } : patch)
        return { success: true }
    } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : 'Failed to update coworker' }
    }
}

// A connector owns its MCP servers: install and uninstall write them through the compiler, which
// calls the engine directly. Editing one from the panel would leave the registry describing a
// footprint that no longer exists, so this path refuses to touch them.
export async function patchAgentMcpServersAction(agentId: string, body: { upsert?: EngineMcpServer[]; remove?: string[] }): Promise<{ success: boolean; error?: string; detail?: EngineAgentDetail }> {
    try {
        const { conn, engineAgentId } = await getAgentChatTarget(agentId, 'manage')
        const owned = connectorMcpServerNames(await readRegistry(conn, engineAgentId))
        const touched = [...(body.upsert ?? []).map(s => s.name), ...(body.remove ?? [])]
        const claimed = touched.find(name => owned.has(name))
        if (claimed) return { success: false, error: `"${claimed}" belongs to an app. Manage it from the Apps tab.` }
        const detail = await enginePatchMcpServers(conn, engineAgentId, body)
        return { success: true, detail }
    } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : 'Failed to update MCP servers' }
    }
}

export async function getAgentKeysAction(agentId: string): Promise<{ keys: string[]; engineKeys: string[] }> {
    try {
        const { conn, engineAgentId } = await getAgentChatTarget(agentId, 'manage')
        return await engineGetAgentKeys(conn, engineAgentId)
    } catch {
        return { keys: [], engineKeys: [] }
    }
}

// `connectionId` / `model` are the pin the agent carries, null when it picked nothing and follows
// the Box default. `resolved*` is what the engine would actually run it on, which is the pin when
// there is one and the Box default otherwise. `loaded` keeps "the fetch failed" apart from
// "this agent chose nothing": both leave the pin null and they are not the same state.
export type ModelSelectorContext = { connectionId: string | null; model: string | null; resolvedConnectionId: string | null; resolvedModel: string | null; loaded: boolean }

// The guided-setup state the chat needs before it can decide between the composer and the
// install button. An engine that cannot be reached, or one too old to know about INSTALL.md,
// answers null: no gate rather than a chat nobody can type in. `sessionId` is the conversation the
// install was started in, as the row the agent panel opens.
export type AgentSetupInfo = { required: boolean | null; completedAt: string | null; prompt: string; sessionId: string | null }

// What a conversation needs about the agent itself, from the one read of it both the in-chat
// ModelSelector and the setup gate draw on. The connections are a machine-level fetch (see
// listBoxConnectionsAction) shared by every agent of the workspace. The foreman has no setup.
export type AgentContext = { model: ModelSelectorContext; setup: AgentSetupInfo | null }

export async function getAgentContextAction(agentId: string): Promise<AgentContext> {
    try {
        const { conn, engineAgentId } = await resolveRunTarget(agentId)
        const detail = await engineGetAgent(conn, engineAgentId)
        const installSession = detail.config.setup.sessionId
        return {
            model: {
                connectionId: detail.config.connectionId ?? null,
                model: detail.config.model ?? null,
                resolvedConnectionId: detail.resolvedConnectionId ?? null,
                resolvedModel: detail.resolvedModel ?? null,
                loaded: true,
            },
            setup:
                agentId === FOREMAN_AGENT_ID
                    ? null
                    : {
                          required: detail.config.setup.required,
                          completedAt: detail.config.setup.completedAt,
                          prompt: detail.install,
                          sessionId: installSession ? await sessionRowOf(agentId, installSession) : null,
                      },
        }
    } catch {
        return { model: { connectionId: null, model: null, resolvedConnectionId: null, resolvedModel: null, loaded: false }, setup: null }
    }
}

export async function updateAgentKeysAction(agentId: string, body: { set?: Record<string, string>; remove?: string[]; screen?: Record<string, { site: string; allowAlways: boolean }> }): Promise<{ success: boolean; error?: string }> {
    try {
        const { conn, engineAgentId } = await getAgentChatTarget(agentId, 'manage')
        await engineUpdateAgentKeys(conn, engineAgentId, body)
        return { success: true }
    } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : 'Failed to update coworker variables' }
    }
}

const SECRET_NOT_REQUESTED = 'This coworker did not ask for these credentials'

// A coworker asking for a credential in the chat is answered by whoever can talk to it, so this path
// takes `use` only. What makes that safe is that it writes nothing but the keys the pending request
// of that conversation names, read back from the engine rather than from the caller. Any other key
// goes through updateAgentKeysAction, which takes `manage`. The site a screen secret is pinned to
// comes from that same pending request, never from the caller: `allowAlways` only says which of the
// requested keys the user ticked "use it there without asking" for.
export async function answerSecretRequestAction(sessionId: string, values: Record<string, string>, allowAlways: string[] = []): Promise<{ success: boolean; error?: string }> {
    try {
        const session = await assertSessionInWorkspace(sessionId)
        const { conn, engineAgentId } = await getAgentChatTarget(session.agent_id)
        const messages = session.engine_session_id ? transformEngineMessages(await engineGetSessionMessages(conn, engineAgentId, session.engine_session_id)) : []
        const pending = findPendingHitl(messages)
        const requested = pending?.kind === 'secret' ? pendingSecrets(pending.input) : []
        const requestedKeys = new Set(requested.map(secret => secret.key))
        const keys = Object.keys(values)
        if (keys.length === 0 || keys.some(key => !requestedKeys.has(key))) throw new AccessDeniedError(SECRET_NOT_REQUESTED)
        const allowed = new Set(allowAlways)
        const screen = Object.fromEntries(requested.filter(secret => secret.site && keys.includes(secret.key)).map(secret => [secret.key, { site: secret.site as string, allowAlways: allowed.has(secret.key) }]))
        await engineUpdateAgentKeys(conn, engineAgentId, { set: values, ...(Object.keys(screen).length ? { screen } : {}) })
        return { success: true }
    } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : 'Could not save the credentials' }
    }
}

// --- Data tab (agent's private SQLite database, read-only) ---

const AGENT_DB_UNREACHABLE = 'Could not reach the engine for this coworker.'

// Resolving the coworker fails with messages written for the user (inactive, not found); the engine
// call fails with transport details that are not.
export async function listAgentTablesAction(agentId: string): Promise<TableListResult> {
    let target: Awaited<ReturnType<typeof getAgentChatTarget>>
    try {
        target = await getAgentChatTarget(agentId)
    } catch (err) {
        if (err instanceof NoEngineError) return { success: true, tables: [] }
        return { success: false, error: err instanceof Error && err.message ? err.message : AGENT_DB_UNREACHABLE }
    }
    try {
        return { success: true, tables: await engineListDbTables(target.conn, agentDataBase(target.engineAgentId)) }
    } catch {
        return { success: false, error: AGENT_DB_UNREACHABLE }
    }
}

export async function readAgentTableRowsAction(agentId: string, table: string, params: ReadDbTableRowsParams): Promise<EngineDbRows | null> {
    try {
        const { conn, engineAgentId } = await getAgentChatTarget(agentId)
        return await engineReadDbTableRows(conn, agentDataBase(engineAgentId), table, params)
    } catch {
        return null
    }
}

export async function deleteAgentTableRowsAction(agentId: string, table: string, rowids: (number | string)[]): Promise<{ success: boolean; error?: string; deleted?: number }> {
    try {
        const { conn, engineAgentId } = await getAgentChatTarget(agentId, 'manage')
        const { deleted } = await engineDeleteDbTableRows(conn, agentDataBase(engineAgentId), table, rowids)
        return { success: true, deleted }
    } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : 'Failed to delete rows' }
    }
}

export async function dropAgentTableAction(agentId: string, table: string): Promise<{ success: boolean; error?: string }> {
    try {
        const { conn, engineAgentId } = await getAgentChatTarget(agentId, 'manage')
        await engineDropDbTable(conn, agentDataBase(engineAgentId), table)
        return { success: true }
    } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : 'Failed to delete table' }
    }
}

// An engine that predates the purge route answers a bare 404, which reads as a broken agent
// unless we name it: the agent is fine, the machine it runs on is just behind.
function describeDataError(err: unknown, fallback: string): string {
    const message = err instanceof Error ? err.message : ''
    if (/failed: 404\b/.test(message)) return 'This workspace runs on a machine that needs an engine update before it can purge a table.'
    return message || fallback
}

export async function purgeAgentTableAction(agentId: string, table: string): Promise<{ success: boolean; error?: string; deleted?: number }> {
    try {
        const { conn, engineAgentId } = await getAgentChatTarget(agentId, 'manage')
        const { deleted } = await enginePurgeDbTable(conn, agentDataBase(engineAgentId), table)
        return { success: true, deleted }
    } catch (err) {
        return { success: false, error: describeDataError(err, 'Failed to purge table') }
    }
}

// Everything the Monitoring tab draws, behind one resolution of the agent: the tab polls, and as
// separate actions its charts used to queue one after the other on every tick.
export async function readAgentMonitoringAction(agentId: string, usageRange: UsageTimeRange, queries: StatsQuery[]): Promise<{ usage: EngineUsageBucket[] | null; stats: (EngineStatsPoint[] | null)[] }> {
    try {
        const parsed = queries.map(query => statsQuerySchema.parse(query))
        const { conn, engineAgentId } = await getAgentChatTarget(agentId)
        const [usage, stats] = await Promise.all([
            engineGetAgentUsage(conn, engineAgentId, usageRange).catch(() => null),
            Promise.all(parsed.map(query => engineGetAgentStats(conn, engineAgentId, query).catch(() => null))),
        ])
        return { usage, stats }
    } catch {
        return { usage: null, stats: queries.map(() => null) }
    }
}

// --- Skills tab ---

// A connector's skill is the connector's: the panels open it read-only, and every write path has
// to say the same thing, since the client flag is only a flag.
async function connectorSkillError(conn: EngineConnection, engineAgentId: string, slug: string): Promise<string | null> {
    const owner = connectorSkillOwners(await readRegistry(conn, engineAgentId)).get(slug)
    return owner ? connectorSkillReadOnlyError(slug, owner) : null
}

export async function listSkillsAction(agentId: string): Promise<EngineSkillWithSource[]> {
    try {
        const { conn, engineAgentId, contentLocked } = await getAgentChatTarget(agentId)
        const [skills, registry] = await Promise.all([engineListSkills(conn, engineAgentId), readRegistry(conn, engineAgentId)])
        const fromConnector = connectorSkillSlugs(registry)
        // The listing carries every body, so it is sealed like the editor is: what stays readable
        // here is the shelf (names and descriptions), not what is written on the pages.
        return skills.map(s => ({ ...sealSkill(s, contentLocked), fromConnector: fromConnector.has(s.slug) }))
    } catch {
        return []
    }
}

// The shelf alone, for the `/` menu of the composer: no body, no file list, no registry read. Names
// and descriptions stay readable on a sealed agent, so there is nothing to seal here.
export async function listSkillSummariesAction(agentId: string): Promise<EngineSkillSummary[]> {
    try {
        const { conn, engineAgentId } = await getAgentChatTarget(agentId)
        return await engineListSkillSummaries(conn, engineAgentId)
    } catch {
        return []
    }
}

export async function getSkillAction(agentId: string, slug: string): Promise<(EngineSkill & { locked: boolean }) | null> {
    try {
        const { conn, engineAgentId, contentLocked } = await getAgentChatTarget(agentId)
        return sealSkill(await engineGetSkill(conn, engineAgentId, slug), contentLocked)
    } catch {
        return null
    }
}

export async function createSkillAction(agentId: string, params: { name: string; description: string; body: string }): Promise<{ success: boolean; error?: string; skill?: EngineSkill }> {
    try {
        const { conn, engineAgentId } = await getAgentChatTarget(agentId, 'manage')
        const skill = await engineCreateSkill(conn, engineAgentId, params)
        return { success: true, skill }
    } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : 'Failed to create skill' }
    }
}

export async function importSkillAction(agentId: string, content: string, files: EngineSkillFilePayload[] = []): Promise<{ success: boolean; error?: string; skill?: EngineSkill }> {
    try {
        const { conn, engineAgentId } = await getAgentChatTarget(agentId, 'manage')
        const skill = await engineImportSkill(conn, engineAgentId, content, files)
        return { success: true, skill }
    } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : 'Failed to import skill' }
    }
}

export async function readSkillFileAction(agentId: string, slug: string, path: string): Promise<{ content: string; truncated: boolean; locked: boolean } | null> {
    try {
        const { conn, engineAgentId, contentLocked } = await getAgentChatTarget(agentId)
        const page = await engineReadFileText(conn, skillFilesBase(engineAgentId, slug), path)
        return sealSkillFile({ content: page.content, truncated: page.truncated ?? page.content.length >= TEXT_FILE_PAGE_CHARS }, contentLocked)
    } catch {
        return null
    }
}

export async function writeSkillFileAction(agentId: string, slug: string, path: string, content: string): Promise<{ success: boolean; error?: string }> {
    try {
        const { conn, engineAgentId, contentLocked } = await getAgentChatTarget(agentId, 'manage')
        // The editor showed filler, so a save here would write that filler over the real file.
        // Deleting is left alone: it destroys nothing the user could not already destroy.
        if (contentLocked) return { success: false, error: LOCKED_WRITE_ERROR }
        const readOnly = await connectorSkillError(conn, engineAgentId, slug)
        if (readOnly) return { success: false, error: readOnly }
        await engineWriteFileText(conn, skillFilesBase(engineAgentId, slug), path, content)
        return { success: true }
    } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : 'Failed to save file' }
    }
}

export async function deleteSkillFileAction(agentId: string, slug: string, path: string): Promise<{ success: boolean; error?: string }> {
    try {
        const { conn, engineAgentId } = await getAgentChatTarget(agentId, 'manage')
        const readOnly = await connectorSkillError(conn, engineAgentId, slug)
        if (readOnly) return { success: false, error: readOnly }
        await engineDeleteFile(conn, skillFilesBase(engineAgentId, slug), path)
        return { success: true }
    } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : 'Failed to delete file' }
    }
}

export async function downloadSkillArchiveAction(agentId: string, slug: string): Promise<{ success: boolean; error?: string; base64?: string }> {
    try {
        const { conn, engineAgentId, contentLocked } = await getAgentChatTarget(agentId)
        if (contentLocked) return { success: false, error: LOCKED_DOWNLOAD_ERROR }
        const buffer = await engineFetchSkillArchive(conn, engineAgentId, slug)
        return { success: true, base64: Buffer.from(buffer).toString('base64') }
    } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : 'Failed to download skill' }
    }
}

export async function updateSkillAction(agentId: string, slug: string, patch: { description?: string; body?: string }): Promise<{ success: boolean; error?: string; skill?: EngineSkill }> {
    try {
        const { conn, engineAgentId, contentLocked } = await getAgentChatTarget(agentId, 'manage')
        const readOnly = await connectorSkillError(conn, engineAgentId, slug)
        if (readOnly) return { success: false, error: readOnly }
        // The body in a sealed form is the filler the server sent, so it is dropped rather than
        // saved back over the real procedure. Everything else about the skill stays editable.
        const skill = await engineUpdateSkill(conn, engineAgentId, slug, contentLocked ? { ...patch, body: undefined } : patch)
        return { success: true, skill }
    } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : 'Failed to update skill' }
    }
}

export async function deleteSkillAction(agentId: string, slug: string): Promise<{ success: boolean; error?: string }> {
    try {
        const { conn, engineAgentId } = await getAgentChatTarget(agentId, 'manage')
        const readOnly = await connectorSkillError(conn, engineAgentId, slug)
        if (readOnly) return { success: false, error: readOnly }
        await engineDeleteSkill(conn, engineAgentId, slug)
        return { success: true }
    } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : 'Failed to delete skill' }
    }
}

// --- Memories tab ---

export async function listMemoriesAction(agentId: string): Promise<EngineMemory[]> {
    try {
        const { conn, engineAgentId } = await getAgentChatTarget(agentId)
        return await engineListMemories(conn, engineAgentId)
    } catch {
        return []
    }
}

export async function createMemoryAction(agentId: string, params: { content: string; kind?: string; tags?: string[] }): Promise<{ success: boolean; error?: string }> {
    try {
        const { conn, engineAgentId } = await getAgentChatTarget(agentId, 'manage')
        await engineCreateMemory(conn, engineAgentId, params)
        return { success: true }
    } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : 'Failed to create memory' }
    }
}

export async function recallMemoriesAction(agentId: string, query: string, limit = 5): Promise<EngineMemory[]> {
    try {
        const { conn, engineAgentId } = await getAgentChatTarget(agentId)
        return await engineRecallMemories(conn, engineAgentId, { query, limit })
    } catch {
        return []
    }
}

export async function deleteMemoryAction(agentId: string, memoryId: string): Promise<{ success: boolean; error?: string }> {
    try {
        const { conn, engineAgentId } = await getAgentChatTarget(agentId, 'manage')
        await engineDeleteMemory(conn, engineAgentId, memoryId)
        return { success: true }
    } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : 'Failed to delete memory' }
    }
}

export async function clearMemoriesAction(agentId: string): Promise<{ success: boolean; error?: string }> {
    try {
        const { conn, engineAgentId } = await getAgentChatTarget(agentId, 'manage')
        await engineClearMemories(conn, engineAgentId)
        return { success: true }
    } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : 'Failed to clear memories' }
    }
}

// --- Scheduled tasks tab (cron / one-shot) ---
// rerun-engine exposes schedule CRUD under /agents/:id/schedules. Per-fire run
// history is read via the /runs endpoints (see listRunsAction /
// listScheduleRunsAction below).

export async function listSchedulesAction(agentId: string): Promise<EngineSchedule[]> {
    try {
        const { conn, engineAgentId, contentLocked } = await getAgentChatTarget(agentId)
        return (await engineListSchedules(conn, engineAgentId)).map(schedule => sealSchedule(schedule, contentLocked))
    } catch {
        return []
    }
}

export type WorkspaceRoutine = Pick<EngineSchedule, 'slug' | 'name' | 'cron' | 'runAt' | 'timezone' | 'enabled' | 'lastRunAt'> & {
    agentId: string
    nextRunAt: string | null
    runningSince: string | null
    // The coworker's install is still running: its routines stay off until it finishes, and turning
    // one on would start a second install beside it.
    setupPending: boolean
}

export type WorkspaceRoutines = { routines: WorkspaceRoutine[]; canRename: boolean }

// The engine only lists schedules per agent, so this fans out over the workspace's agents on its one
// machine, the ones the caller can see. An agent whose box call fails drops out rather than emptying
// the whole list.
export async function listWorkspaceRoutinesAction(): Promise<WorkspaceRoutines> {
    const actor = await requireLightSessionActor()
    const workspaceId = actor.workspaceId
    const [{ data: agents }, visible] = await Promise.all([selectMany(createServiceRoleClient(), 'agents', ['id', 'engine_agent_id', 'disabled_at'] as const, { workspace_id: workspaceId }), visibleAgentIds(actor)])
    const runnable = keepVisible(agents ?? [], visible, agent => agent.id).filter(agent => agent.engine_agent_id && !agent.disabled_at)
    if (runnable.length === 0) return { routines: [], canRename: false }

    const conn = await getWorkspaceConnection(workspaceId)
    const now = new Date()
    const canRename = supportsScheduleRename(conn)
    const perAgent = await Promise.allSettled(
        runnable.map(async agent => {
            const engineAgentId = agent.engine_agent_id as string
            const [schedules, runs, detail] = await Promise.all([
                engineListSchedules(conn, engineAgentId),
                engineListRuns(conn, engineAgentId, { status: 'running', limit: 20 }).catch(() => []),
                engineGetAgent(conn, engineAgentId).catch(() => null),
            ])
            const scheduledRuns = runs.filter(run => run.status === 'running' && run.triggerSource === 'schedule')
            const setupPending = detail ? detail.config.setup.required === true && detail.config.setup.completedAt === null && detail.install.trim().length > 0 : false
            return schedules.map(schedule => ({
                agentId: agent.id,
                slug: schedule.slug,
                name: schedule.name,
                cron: schedule.cron,
                runAt: schedule.runAt,
                timezone: schedule.timezone,
                enabled: schedule.enabled,
                lastRunAt: schedule.lastRunAt,
                nextRunAt: nextRunAt(schedule, now),
                runningSince: scheduledRuns.find(run => run.triggerSlug === schedule.slug)?.startedAt ?? null,
                setupPending,
            }))
        })
    )

    return { routines: perAgent.flatMap(result => (result.status === 'fulfilled' ? result.value : [])).sort(byNextRun), canRename: await canRename }
}

function byNextRun(a: WorkspaceRoutine, b: WorkspaceRoutine): number {
    if (a.nextRunAt === b.nextRunAt) return a.name.localeCompare(b.name)
    if (!a.nextRunAt) return 1
    if (!b.nextRunAt) return -1
    return a.nextRunAt.localeCompare(b.nextRunAt)
}

export async function getScheduleAction(agentId: string, slug: string): Promise<{ schedule: EngineSchedule; canRename: boolean } | null> {
    try {
        const { conn, engineAgentId, contentLocked } = await getAgentChatTarget(agentId)
        const [schedule, canRename] = await Promise.all([engineGetSchedule(conn, engineAgentId, slug), supportsScheduleRename(conn)])
        return { schedule: sealSchedule(schedule, contentLocked), canRename }
    } catch {
        return null
    }
}

export async function createScheduleAction(agentId: string, params: ScheduleCreateParams): Promise<{ success: boolean; error?: string; schedule?: EngineSchedule }> {
    try {
        const { conn, engineAgentId } = await getAgentChatTarget(agentId, 'manage')
        await assertModelEntitled(params.model)
        const schedule = await engineCreateSchedule(conn, engineAgentId, params)
        await followCoworker((await getServerSession()).user?.id, agentId)
        return { success: true, schedule }
    } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : 'Failed to create schedule' }
    }
}

export async function updateScheduleAction(agentId: string, slug: string, patch: ScheduleUpdateParams): Promise<{ success: boolean; error?: string; schedule?: EngineSchedule }> {
    try {
        const { conn, engineAgentId, contentLocked } = await getAgentChatTarget(agentId, 'manage')
        await assertModelEntitled(patch.model)
        // Pausing or rescheduling a sealed task is ordinary use; only its prompt is held back.
        const schedule = await engineUpdateSchedule(conn, engineAgentId, slug, contentLocked ? { ...patch, body: undefined } : patch)
        // A box that predates renaming drops the unknown field and still answers 200.
        if (patch.name !== undefined && schedule.name !== patch.name.trim()) return { success: false, error: 'Update this coworker to rename its routines' }
        return { success: true, schedule }
    } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : 'Failed to update schedule' }
    }
}

export async function parseScheduleAction(input: string, ctx: { nowIso: string; timezone: string }): Promise<{ success: true; data: ParsedSchedule } | { success: false; error: string }> {
    await requireWorkspaceId()
    const trimmed = input.trim().slice(0, 500)
    if (!trimmed) return { success: false, error: 'Describe when the task should run' }
    const data = await parseSchedule(trimmed, ctx)
    if (!data) return { success: false, error: "Couldn't understand that schedule. Try rephrasing." }
    return { success: true, data }
}

export async function testScheduleAction(agentId: string, slug: string): Promise<{ success: boolean; runId?: string; sessionId?: string; error?: string }> {
    try {
        const { conn, engineAgentId } = await getAgentChatTarget(agentId)
        const { runId, sessionId } = await engineRunScheduleNow(conn, engineAgentId, slug)
        return { success: true, runId, sessionId }
    } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : 'Failed to run schedule' }
    }
}

export async function deleteScheduleAction(agentId: string, slug: string): Promise<{ success: boolean; error?: string }> {
    try {
        const { conn, engineAgentId } = await getAgentChatTarget(agentId, 'manage')
        await engineDeleteSchedule(conn, engineAgentId, slug)
        return { success: true }
    } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : 'Failed to delete schedule' }
    }
}

// --- Triggers tab (public webhook URLs) ---
// rerun-engine owns the trigger definitions under /agents/:id/triggers, exactly like schedules.
// Firing one is not here: that happens on the public /api/t/... route, with no session at all.

export async function listTriggersAction(agentId: string): Promise<EngineTrigger[]> {
    try {
        const { conn, engineAgentId, contentLocked } = await getAgentChatTarget(agentId)
        return (await engineListTriggers(conn, engineAgentId)).map(trigger => sealTrigger(trigger, contentLocked))
    } catch {
        return []
    }
}

const OUTCOME_RUNS = 100

// How each scheduled task and trigger of the coworker last ended, keyed by `outcomeKey`.
export async function listTaskOutcomesAction(agentId: string): Promise<Record<string, TaskOutcome>> {
    try {
        const { conn, engineAgentId } = await getAgentChatTarget(agentId)
        return latestOutcomes(await engineListRuns(conn, engineAgentId, { limit: OUTCOME_RUNS }))
    } catch {
        return {}
    }
}

export async function getTriggerAction(agentId: string, slug: string): Promise<EngineTrigger | null> {
    try {
        const { conn, engineAgentId, contentLocked } = await getAgentChatTarget(agentId)
        return sealTrigger(await engineGetTrigger(conn, engineAgentId, slug), contentLocked)
    } catch {
        return null
    }
}

export async function createTriggerAction(agentId: string, params: TriggerCreateParams): Promise<{ success: boolean; error?: string; trigger?: EngineTrigger }> {
    try {
        const { conn, engineAgentId } = await getAgentChatTarget(agentId, 'manage')
        await assertModelEntitled(params.model)
        const trigger = await engineCreateTrigger(conn, engineAgentId, params)
        await followCoworker((await getServerSession()).user?.id, agentId)
        return { success: true, trigger }
    } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : 'Failed to create trigger' }
    }
}

export async function updateTriggerAction(agentId: string, slug: string, patch: TriggerUpdateParams): Promise<{ success: boolean; error?: string; trigger?: EngineTrigger }> {
    try {
        const { conn, engineAgentId, contentLocked } = await getAgentChatTarget(agentId, 'manage')
        await assertModelEntitled(patch.model)
        const trigger = await engineUpdateTrigger(conn, engineAgentId, slug, contentLocked ? { ...patch, body: undefined } : patch)
        return { success: true, trigger }
    } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : 'Failed to update trigger' }
    }
}

export async function rotateTriggerTokenAction(agentId: string, slug: string): Promise<{ success: boolean; error?: string; trigger?: EngineTrigger }> {
    try {
        const { conn, engineAgentId } = await getAgentChatTarget(agentId, 'manage')
        const trigger = await engineRotateTriggerToken(conn, engineAgentId, slug)
        return { success: true, trigger }
    } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : 'Failed to rotate the trigger secret' }
    }
}

export async function deleteTriggerAction(agentId: string, slug: string): Promise<{ success: boolean; error?: string }> {
    try {
        const { conn, engineAgentId } = await getAgentChatTarget(agentId, 'manage')
        await engineDeleteTrigger(conn, engineAgentId, slug)
        return { success: true }
    } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : 'Failed to delete trigger' }
    }
}

// --- Runs (execution history) ---
// Every fire (chat / one-off / scheduled / triggered) is audited in the engine's
// `runs` table. The list is agent-wide; listScheduleRunsAction and
// listTriggerRunsAction narrow it to one routine by matching the engine sessions
// titled `schedule: <slug>` / `trigger: <slug>`.

export async function listRunsAction(agentId: string, limit?: number): Promise<EngineRun[]> {
    try {
        const { conn, engineAgentId } = await getAgentChatTarget(agentId)
        return await engineListRuns(conn, engineAgentId, { limit })
    } catch {
        return []
    }
}

export async function getRunAction(agentId: string, runId: string): Promise<EngineRunDetail | null> {
    try {
        const { conn, engineAgentId } = await resolveRunTarget(agentId)
        return await engineGetRun(conn, engineAgentId, runId)
    } catch {
        return null
    }
}

export async function getRunStepsAction(agentId: string, runId: string): Promise<EngineRunStep[]> {
    try {
        const { conn, engineAgentId } = await getAgentChatTarget(agentId)
        return await engineGetRunSteps(conn, engineAgentId, runId)
    } catch {
        return []
    }
}

export async function getRunToolsAction(agentId: string, runId: string): Promise<EngineToolCall[]> {
    try {
        const { conn, engineAgentId } = await getAgentChatTarget(agentId)
        return await engineGetRunTools(conn, engineAgentId, runId)
    } catch {
        return []
    }
}

// Returns whether the engine took the cancellation. `abortRun` frees the session claim before it
// answers, so awaiting this is what tells a caller it may start the next run on that conversation.
export async function cancelRunAction(agentId: string, runId: string): Promise<boolean> {
    try {
        const { conn, engineAgentId } = await resolveRunTarget(agentId)
        await engineCancelRun(conn, engineAgentId, runId)
        return true
    } catch {
        return false
    }
}

export async function cancelSubRunAction(agentId: string, runId: string, taskId: string): Promise<boolean> {
    try {
        const { conn, engineAgentId } = await resolveRunTarget(agentId)
        await engineCancelSubRun(conn, engineAgentId, runId, taskId)
        return true
    } catch {
        return false
    }
}

async function runsForSessionTitle(agentId: string, title: string): Promise<EngineRun[]> {
    try {
        const { conn, engineAgentId } = await getAgentChatTarget(agentId)
        const [runs, sessions] = await Promise.all([engineListRuns(conn, engineAgentId), engineListSessions(conn, engineAgentId)])
        const sessionIds = new Set(sessions.filter(s => s.title === title).map(s => s.id))
        return runs.filter(r => r.sessionId && sessionIds.has(r.sessionId)).sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''))
    } catch {
        return []
    }
}

export async function listScheduleRunsAction(agentId: string, slug: string): Promise<EngineRun[]> {
    return runsForSessionTitle(agentId, `schedule: ${slug}`)
}

export async function listTriggerRunsAction(agentId: string, slug: string): Promise<EngineRun[]> {
    return runsForSessionTitle(agentId, `trigger: ${slug}`)
}
