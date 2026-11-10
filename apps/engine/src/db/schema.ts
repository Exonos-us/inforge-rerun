import type { Provider } from '@rerun/contracts'
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'

export const agents = sqliteTable('agents', {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    status: text('status').notNull().default('idle'),
    createdAt: text('created_at').notNull(),
})

export const sessions = sqliteTable('sessions', {
    id: text('id').primaryKey(),
    agentId: text('agent_id').notNull(),
    title: text('title').notNull().default('Untitled'),
    status: text('status').notNull().default('open'),
    source: text('source').notNull().default('dashboard'),
    originAgentId: text('origin_agent_id'),
    originSessionId: text('origin_session_id'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
})

export const messages = sqliteTable('messages', {
    id: text('id').primaryKey(),
    sessionId: text('session_id').notNull(),
    role: text('role').notNull(),
    contentJson: text('content_json').notNull(),
    toolCallsJson: text('tool_calls_json'),
    createdAt: text('created_at').notNull(),
    authorId: text('author_id'),
    authorName: text('author_name'),
})

export const runs = sqliteTable('runs', {
    id: text('id').primaryKey(),
    agentId: text('agent_id').notNull(),
    sessionId: text('session_id').notNull(),
    status: text('status').notNull().default('running'),
    stepCount: integer('step_count').notNull().default(0),
    usageJson: text('usage_json'),
    provider: text('provider'),
    model: text('model'),
    triggerSource: text('trigger_source'),
    triggerSlug: text('trigger_slug'),
    costMicros: integer('cost_micros'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    cachedInputTokens: integer('cached_input_tokens'),
    reasoningTokens: integer('reasoning_tokens'),
    totalTokens: integer('total_tokens'),
    startedAt: text('started_at').notNull(),
    finishedAt: text('finished_at'),
    error: text('error'),
})

export const runSteps = sqliteTable('run_steps', {
    id: text('id').primaryKey(),
    runId: text('run_id').notNull(),
    agentId: text('agent_id').notNull(),
    sessionId: text('session_id').notNull(),
    stepNumber: integer('step_number').notNull(),
    provider: text('provider'),
    model: text('model'),
    finishReason: text('finish_reason'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    cachedInputTokens: integer('cached_input_tokens'),
    reasoningTokens: integer('reasoning_tokens'),
    totalTokens: integer('total_tokens'),
    cacheWriteTokens: integer('cache_write_tokens'),
    costMicros: integer('cost_micros'),
    toolCallCount: integer('tool_call_count').notNull().default(0),
    textLength: integer('text_length').notNull().default(0),
    durationMs: integer('duration_ms'),
    createdAt: text('created_at').notNull(),
})

export const toolCalls = sqliteTable('tool_calls', {
    id: text('id').primaryKey(),
    runId: text('run_id').notNull(),
    agentId: text('agent_id').notNull(),
    sessionId: text('session_id').notNull(),
    stepNumber: integer('step_number').notNull(),
    toolCallId: text('tool_call_id'),
    toolName: text('tool_name').notNull(),
    inputJson: text('input_json'),
    resultJson: text('result_json'),
    isError: integer('is_error').notNull().default(0),
    durationMs: integer('duration_ms'),
    createdAt: text('created_at').notNull(),
})

export const compactionCheckpoints = sqliteTable('compaction_checkpoints', {
    id: text('id').primaryKey(),
    sessionId: text('session_id').notNull(),
    summaryJson: text('summary_json').notNull(),
    throughMessageId: text('through_message_id').notNull(),
    throughCreatedAt: text('through_created_at').notNull(),
    createdAt: text('created_at').notNull(),
})

export const skillProposals = sqliteTable('skill_proposals', {
    id: text('id').primaryKey(),
    agentId: text('agent_id').notNull(),
    sessionId: text('session_id').notNull(),
    runId: text('run_id'),
    toolCallId: text('tool_call_id').notNull(),
    mode: text('mode').notNull(),
    slug: text('slug'),
    title: text('title').notNull(),
    summary: text('summary').notNull(),
    instructionsJson: text('instructions_json').notNull(),
    fingerprintsJson: text('fingerprints_json').notNull(),
    status: text('status').notNull().default('proposed'),
    appliedSlug: text('applied_slug'),
    error: text('error'),
    createdAt: text('created_at').notNull(),
    decidedAt: text('decided_at'),
    connectionId: text('connection_id'),
    provider: text('provider').$type<Provider>(),
    model: text('model'),
})

// The value lives in the agent's .env under `key`; this row only pins where it may be typed.
export const screenSecrets = sqliteTable('screen_secrets', {
    key: text('key').primaryKey(),
    site: text('site').notNull(),
    approvedAlways: integer('approved_always').notNull().default(0),
    createdAt: text('created_at').notNull(),
})

export type AgentRow = typeof agents.$inferSelect
export type SessionRow = typeof sessions.$inferSelect
export type MessageRow = typeof messages.$inferSelect
export type RunRow = typeof runs.$inferSelect
export type RunStepRow = typeof runSteps.$inferSelect
export type ToolCallRow = typeof toolCalls.$inferSelect
export type CompactionCheckpointRow = typeof compactionCheckpoints.$inferSelect
export type SkillProposalRow = typeof skillProposals.$inferSelect
