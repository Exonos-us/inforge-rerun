import { z } from 'zod'
import type { GettingStartedItem } from '@/lib/onboarding/getting-started'
import {
    toolsSchema,
    toolDescriptorSchema,
    toolFamilySchema,
    toolsListSchema,
    selfImprovementSchema,
    mcpServerSchema,
    mcpServerStatusListSchema,
    type McpServerStatus,
    agentConfigSchema,
    agentDetailSchema,
    activatedAutomationsSchema,
    agentKeysListSchema,
    connectionSummarySchema,
    connectionsListSchema,
    boxDefaultModelSchema as engineBoxDefaultModelSchema,
    connectionUsageSchema as engineConnectionUsageSchema,
    deleteConnectionResultSchema as engineDeleteConnectionResultSchema,
    sessionSchema,
    sessionsListSchema,
    messageSchema,
    messagesListSchema,
    memorySchema,
    memoriesListSchema,
    fileEntrySchema,
    fileEntriesListSchema,
    fileContentSchema,
    skillSchema,
    skillsListSchema,
    skillProposalSchema,
    skillProposalsListSchema,
    scheduleSchema,
    schedulesListSchema,
    triggerSchema,
    triggersListSchema,
    runSchema,
    runsListSchema,
    runDetailSchema,
    runResultSchema,
    runStepSchema,
    runStepsListSchema,
    toolCallSchema,
    toolCallsListSchema,
} from '@rerun/contracts'
import type {
    Tools,
    ToolDescriptor,
    ToolFamily,
    SelfImprovement,
    McpServer,
    Provider,
    Verbosity,
    AgentConfig,
    AgentSetup,
    AgentDetail,
    AgentKeysList,
    ScreenSecretMeta,
    Session,
    SessionSource,
    Message,
    Memory,
    FileEntry,
    FileContent,
    Skill,
    SkillProposal,
    SkillFilePayload,
    ConnectionSummary,
    ConnectionsList,
    ConnectionUsage,
    BoxDefaultModel,
    CreateConnectionInput,
    UpdateConnectionInput,
    Schedule,
    Trigger,
    TriggerMethod,
    Run,
    RunDetail,
    RunResult,
    RunStep,
    RunStepsList,
    ToolCall,
    ToolCallsList,
} from '@rerun/contracts'

// How to reach a box's engine. Not to be confused with a `BoxConnection`, which is an AI provider
// credential held by that box.
export type EngineConnection = {
    baseUrl: string
    apiKey: string | null
}

export const engineToolsSchema = toolsSchema
export const engineToolDescriptorSchema = toolDescriptorSchema
export const engineToolFamilySchema = toolFamilySchema
export const engineToolsListSchema = toolsListSchema
export const engineSelfImprovementSchema = selfImprovementSchema
export const engineMcpServerSchema = mcpServerSchema
export const engineMcpServerStatusListSchema = mcpServerStatusListSchema
export const engineAgentConfigSchema = agentConfigSchema
export const engineAgentDetailSchema = agentDetailSchema
export const engineActivatedAutomationsSchema = activatedAutomationsSchema
export const engineAgentKeysListSchema = agentKeysListSchema
export const boxConnectionSchema = connectionSummarySchema
export const boxConnectionsListSchema = connectionsListSchema
export const boxDefaultSchema = engineBoxDefaultModelSchema
export const connectionUsageSchema = engineConnectionUsageSchema
export const deleteConnectionResultSchema = engineDeleteConnectionResultSchema
export const engineSessionSchema = sessionSchema
export const engineSessionsListSchema = sessionsListSchema
export const engineMessageSchema = messageSchema
export const engineMessagesListSchema = messagesListSchema
export const engineMemorySchema = memorySchema
export const engineMemoriesListSchema = memoriesListSchema
export const engineFileEntrySchema = fileEntrySchema
export const engineFileEntriesListSchema = fileEntriesListSchema
export const engineFileContentSchema = fileContentSchema
export const engineSkillSchema = skillSchema
export const engineSkillsListSchema = skillsListSchema
export const engineSkillSummarySchema = skillSchema.pick({ slug: true, name: true, description: true })
export const engineSkillSummariesListSchema = z.object({ skills: z.array(engineSkillSummarySchema) })
export const engineSkillProposalSchema = skillProposalSchema
export const engineSkillProposalsListSchema = skillProposalsListSchema
export const engineScheduleSchema = scheduleSchema
export const engineSchedulesListSchema = schedulesListSchema
export const engineTriggerSchema = triggerSchema
export const engineTriggersListSchema = triggersListSchema
export const engineRunSchema = runSchema
export const engineRunsListSchema = runsListSchema
export const engineRunDetailSchema = runDetailSchema
export const engineRunResultSchema = runResultSchema
export const engineRunStepSchema = runStepSchema
export const engineRunStepsListSchema = runStepsListSchema
export const engineToolCallSchema = toolCallSchema
export const engineToolCallsListSchema = toolCallsListSchema

export type EngineTools = Tools
export type EngineToolDescriptor = ToolDescriptor
export type EngineToolFamily = ToolFamily
export type EngineSelfImprovement = SelfImprovement
export type EngineMcpServer = McpServer
export type EngineMcpServerStatus = McpServerStatus
export type EngineAgentConfig = AgentConfig
export type EngineAgentConfigPatch = Partial<Omit<AgentConfig, 'tools' | 'selfImprovement' | 'setup'>> & {
    tools?: Record<string, boolean>
    selfImprovement?: Partial<SelfImprovement>
    setup?: Partial<AgentSetup>
}
export type EngineAgentDetail = AgentDetail
export type EngineAgentSetup = AgentSetup
export type EngineAgentKeysList = AgentKeysList
export type EngineScreenSecretMeta = ScreenSecretMeta
// An AI provider credential held by a box: what an agent points at through `config.connectionId`.
export type BoxConnection = ConnectionSummary
export type BoxConnectionUsage = ConnectionUsage
// The connection and model an agent runs on when it has picked none. Set once per box.
export type BoxDefault = BoxDefaultModel
export type BoxConnectionsList = ConnectionsList
export type CreateBoxConnectionInput = CreateConnectionInput
export type UpdateBoxConnectionInput = UpdateConnectionInput
export type EngineSession = Session
export type { SessionSource }
export type EngineMessage = Message
export type EngineMemory = Memory
export type EngineFileEntry = FileEntry
export type EngineFileContent = FileContent
export type EngineSkill = Skill
export type EngineSkillWithSource = EngineSkill & { fromConnector: boolean }
export type EngineSkillSummary = z.infer<typeof engineSkillSummarySchema>
export type EngineSkillFilePayload = SkillFilePayload
export type EngineSkillProposal = SkillProposal
export type EngineProvider = Provider
export type EngineVerbosity = Verbosity
export type EngineSchedule = Schedule
export type EngineTrigger = Trigger
export type EngineTriggerMethod = TriggerMethod
export type EngineRun = Run
export type EngineRunDetail = RunDetail
export type EngineRunResult = RunResult
export type EngineRunStep = RunStep
export type EngineRunStepsList = RunStepsList
export type EngineToolCall = ToolCall
export type EngineToolCallsList = ToolCallsList

export const engineUploadResultSchema = z.object({ path: z.string(), bytes: z.number() })
export type EngineUploadResult = z.infer<typeof engineUploadResultSchema>

// What the last `rerun update` on a box did; `restarting` is the updater's last word before the
// service restart kills it, the engine that comes back settles it.
export const engineLastUpdateSchema = z.object({
    status: z.enum(['running', 'error', 'restarting', 'success']),
    commit: z.string().nullable(),
    error: z.string().optional(),
    at: z.string(),
})
export type EngineLastUpdate = z.infer<typeof engineLastUpdateSchema>

export const engineHealthSchema = z.object({
    status: z.string(),
    activeAgents: z.number(),
    activeRuns: z.number().optional(),
    capabilities: z.array(z.string()).default([]),
    commit: z.string().nullable().optional(),
    startedAt: z.string().nullable().optional(),
    // How the box holds its code: `release` (prebuilt artifact), `monorepo` (git checkout) or `image`.
    // Absent on an engine that predates artifact updates.
    layout: z.string().optional(),
    lastUpdate: engineLastUpdateSchema.nullable().optional(),
    // Absent on an engine that predates the data-dir migration ladder.
    dataVersion: z.number().optional(),
    dataVersionTarget: z.number().optional(),
})
export type EngineHealth = z.infer<typeof engineHealthSchema>

export const engineUpdateResultSchema = z.object({
    started: z.boolean(),
    reason: z.string().optional(),
    activeRuns: z.number().optional(),
    commit: z.string().nullable().optional(),
    lastUpdate: engineLastUpdateSchema.nullable().optional(),
})
export type EngineUpdateResult = z.infer<typeof engineUpdateResultSchema>

export {
    engineDbColumnSchema,
    engineDbTableSchema,
    engineDbTablesListSchema,
    engineDbRowsSchema,
    engineDeleteRowsResultSchema,
    engineUsageBucketSchema,
    engineUsageSchema,
    dbQueryResultSchema,
    dbExecuteResultSchema,
} from '@rerun/contracts'
export type { EngineDbColumn, EngineDbTable, EngineDbRows, EngineDeleteRowsResult, EngineUsageBucket, DbQueryInput, DbQueryResult, DbExecuteInput, DbExecuteResult } from '@rerun/contracts'

export { statsPointSchema as engineStatsPointSchema, statsResponseSchema as engineStatsResponseSchema } from '@rerun/contracts'
export { engineDoctorSchema } from '@rerun/contracts'
export type { EngineDoctor, EngineDoctorCheck } from '@rerun/contracts'
export type { StatsPoint as EngineStatsPoint, StatsQuery as EngineStatsQuery } from '@rerun/contracts'

export type CronOutputEntry = {
    timestamp: string
    run_time: string
    size_bytes: number
}

export type SkillInfo = {
    id: string
    description: string
    category: string
    platforms?: string[]
    tags?: string[]
    enabled: boolean
}

export type ToolsetInfo = {
    id: string
    enabled: boolean
    heavy: boolean
}

export type ApprovalChoice = 'once' | 'session' | 'always' | 'deny'

// `alert` was merged into `info`, but an engine that has not taken the update yet keeps sending it.
// It means exactly the same thing, and the database no longer carries the label, so coerce on the way in.
export const notificationKindSchema = z.preprocess(value => (value === 'alert' ? 'info' : value), z.enum(['info', 'question', 'approval', 'connector', 'done', 'error']))
export type NotificationKind = z.infer<typeof notificationKindSchema>

// `progress` was removed: its notifications are dropped rather than stored. The wire still accepts it
// so an engine that has not taken the update yet gets a 202 instead of a rejected webhook, but it
// never reaches `NotificationKind`, which is what every per-kind map and preference is keyed on.
export const RETIRED_NOTIFICATION_KIND = 'progress'
const wireNotificationKindSchema = z.union([notificationKindSchema, z.literal(RETIRED_NOTIFICATION_KIND)])

export const notificationPayloadSchema = z.object({
    event: z.enum(['agent.notification', 'agent.message.completed', 'agent.schedule.completed', 'agent.trigger.completed', 'agent.session.created']),
    kind: wireNotificationKindSchema,
    agentId: z.string().min(1),
    sessionId: z.string().nullable().optional(),
    runId: z.string().nullable().optional(),
    message: z.string().min(1).max(16_000),
    metadata: z.record(z.string(), z.unknown()).nullable().optional(),
    title: z.string().max(200).nullable().optional(),
    source: z.enum(['dashboard', 'builder', 'schedule', 'agent', 'delegate', 'api', 'trigger']).nullable().optional(),
    originAgentId: z.string().nullable().optional(),
    timestamp: z.string(),
})
export type NotificationPayload = z.infer<typeof notificationPayloadSchema>

// A box telling the hub that something was just created on it. It is news for nobody, so it stays
// out of the notification payload (and its required agent: a connection has none). A schedule or a
// trigger written during a chat names its author in `metadata.authorId`.
export const GETTING_STARTED_EVENT_STEP: Partial<Record<EngineCreatedEvent['event'], GettingStartedItem>> = { 'agent.schedule.created': 'schedule', 'box.connection.connected': 'ai_provider' }
export const engineCreatedEventSchema = z.object({
    event: z.enum(['agent.schedule.created', 'agent.trigger.created', 'box.connection.connected']),
    agentId: z.string().nullable().optional(),
    metadata: z.record(z.string(), z.unknown()).nullable().optional(),
})
export type EngineCreatedEvent = z.infer<typeof engineCreatedEventSchema>
