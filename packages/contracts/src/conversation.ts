import { z } from 'zod'

import { sessionSourceSchema } from './session.js'

export const sessionStatusSchema = z.enum(['idle', 'working', 'error', 'waiting_human', 'awaiting_question', 'awaiting_approval', 'awaiting_connector', 'awaiting_ack'])
export type SessionStatus = z.infer<typeof sessionStatusSchema>

// A conversation nobody can move forward without a human. Shared so the web's To handle list and
// the app's cannot drift apart. Wider than the `pending` badge of an agent row, which leaves out
// `error` because the row says "Error" on its own.
export const ATTENTION_STATUSES = ['error', 'waiting_human', 'awaiting_question', 'awaiting_approval', 'awaiting_connector', 'awaiting_ack'] as const satisfies readonly SessionStatus[]

const attentionStatuses: ReadonlySet<string> = new Set(ATTENTION_STATUSES)

export function needsHuman(status: SessionStatus): boolean {
    return attentionStatuses.has(status)
}

export const sessionOutcomeSchema = z.enum(['done', 'nothing', 'failed'])
export type SessionOutcome = z.infer<typeof sessionOutcomeSchema>

// A coworker has one `general` conversation; every other one is a `thread` of it, placed in General
// by the time it was opened.
export const sessionKindSchema = z.enum(['general', 'thread'])
export type SessionKind = z.infer<typeof sessionKindSchema>

export const conversationSchema = z.object({
    // Null for a conversation another agent opened on this one's engine: it has no hub row until
    // it is adopted, and cannot be opened before that.
    id: z.string().nullable(),
    agentId: z.string(),
    engineSessionId: z.string(),
    title: z.string(),
    status: sessionStatusSchema,
    source: sessionSourceSchema,
    updatedAt: z.string(),
    // Optional for a hub older than it: the app then names the coworker without drawing it.
    originAgentId: z.string().nullable().optional(),
    originAgentName: z.string().nullable(),
    // Optional for a hub older than them. `unseen`: a run finished after the caller last opened it.
    // `ask`: what the coworker waits on, for a status of `ATTENTION_STATUSES`.
    unseen: z.boolean().optional(),
    ask: z.string().nullable().optional(),
    // Optional for a hub older than them. Set on a scheduled or triggered run: `title` then says
    // what the run did, `automationName` names its routine and `outcome` how it ended.
    automationName: z.string().nullable().optional(),
    outcome: sessionOutcomeSchema.nullable().optional(),
    // Optional for a hub older than them. `kind` tells the coworker's General from its threads,
    // `createdAt` is where a thread sits in General.
    kind: sessionKindSchema.optional(),
    createdAt: z.string().optional(),
})
export type Conversation = z.infer<typeof conversationSchema>

// A conversation found by its title, for the search of the web's control center and of the app.
export const conversationHitSchema = z.object({
    id: z.string(),
    agentId: z.string(),
    title: z.string(),
    status: sessionStatusSchema,
    updatedAt: z.string(),
})
export type ConversationHit = z.infer<typeof conversationHitSchema>

export const adoptConversationSchema = z.object({ engineSessionId: z.string().min(1), title: z.string() })

export const conversationAttachmentSchema = z.object({
    name: z.string(),
    // Workspace path on the agent's Box, the one the agent reads the file from.
    path: z.string(),
    mediaType: z.string(),
})
export type ConversationAttachment = z.infer<typeof conversationAttachmentSchema>

export const conversationMessageMetadataSchema = z.object({
    authorId: z.string().optional(),
    // When the engine stored the message. Optional so an app older than the hub keeps parsing.
    createdAt: z.string().optional(),
    attachments: z.array(conversationAttachmentSchema).optional(),
    // `peaks` is the base36 waveform of the marker (see voice.ts). Optional so an app older than
    // the hub keeps parsing: it falls back to a flat waveform.
    voice: z.object({ transcript: z.string(), src: z.string(), durationMs: z.number(), peaks: z.string().optional() }).optional(),
    // A message no one typed: the routine that fired the run, or the guided install it opens with.
    // The text carries the bare prompt or guide, so an app older than these fields shows a bubble.
    scheduledRun: z.object({ slug: z.string(), name: z.string() }).optional(),
    install: z.object({ agentName: z.string() }).optional(),
})
export type ConversationMessageMetadata = z.infer<typeof conversationMessageMetadataSchema>

// Parts are AI SDK UI message parts. Only their `type` is checked here: the client narrows them
// with its own UIMessage generics, and the part union is the AI SDK's to evolve.
export const conversationMessageSchema = z.object({
    id: z.string(),
    role: z.enum(['user', 'assistant']),
    parts: z.array(z.looseObject({ type: z.string() })),
    metadata: conversationMessageMetadataSchema.optional(),
})
export type ConversationMessage = z.infer<typeof conversationMessageSchema>

// What one row of the Chats screen needs, so the app reads the whole workspace in one request
// instead of one per agent. `latest` is null for an agent nobody has talked to yet.
export const agentConversationsOverviewSchema = z.array(
    z.object({
        agentId: z.string(),
        latest: conversationSchema.nullable(),
        pending: z.number(),
    }),
)
export type AgentConversationsOverview = z.infer<typeof agentConversationsOverviewSchema>

// One row of the To handle list: a conversation waiting on its human, named by its agent so the
// client has nothing to resolve.
export const toHandleItemSchema = z.object({
    sessionId: z.string(),
    agentId: z.string(),
    agentName: z.string(),
    title: z.string(),
    status: sessionStatusSchema,
    updatedAt: z.string(),
})
export type ToHandleItem = z.infer<typeof toHandleItemSchema>

// `total` is what the strip header and the tab badge count. `items` is a bounded page of it: a
// workspace can sit on thousands of untouched errors, and the list would otherwise run into
// PostgREST's silent 1000-row cap.
export const toHandleListSchema = z.object({
    items: z.array(toHandleItemSchema),
    total: z.number(),
})
export type ToHandleList = z.infer<typeof toHandleListSchema>

export const markHandledSchema = z.union([z.object({ sessionIds: z.array(z.string()).min(1) }), z.object({ all: z.literal(true) })])
export type MarkHandledInput = z.infer<typeof markHandledSchema>

export const inboxStatusSchema = z.enum(['awaiting_question', 'awaiting_approval', 'awaiting_connector', 'waiting_human', 'awaiting_ack', 'error', 'done'])
export type InboxStatus = z.infer<typeof inboxStatusSchema>

// One row of the web's inbox. A `done` row is one finished conversation, or every unseen run of one
// scheduled task: `sessionId` is the one to open, `sessionIds` every conversation it stands for.
export const inboxItemSchema = z.object({
    id: z.string(),
    sessionId: z.string(),
    sessionIds: z.array(z.string()),
    agentId: z.string(),
    agentName: z.string(),
    status: inboxStatusSchema,
    title: z.string(),
    // The question, approval, heads-up or error the agent left, when one was recorded.
    message: z.string().nullable(),
    updatedAt: z.string(),
    count: z.number(),
})
export type InboxItem = z.infer<typeof inboxItemSchema>

// `running` counts the conversations at work, the line the web shows above the list.
export const inboxSchema = z.object({
    items: z.array(inboxItemSchema),
    running: z.number(),
})
export type Inbox = z.infer<typeof inboxSchema>

export const activeRunSchema =z.object({ runId: z.string().nullable() })
