import { z } from 'zod'
import { OPENCODE_DEFAULT_MODEL } from './opencode.js'

// Tools surface as "<server>_<tool>" and CLI providers key their config records by server name, so
// anything outside this set (a dot, a space) makes every run of the agent fail at settings
// validation. Enforced on write paths only: configs already on disk must keep loading so an
// invalid legacy name stays removable.
export const MCP_SERVER_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/
export const mcpServerNameSchema = z.string().regex(MCP_SERVER_NAME_RE, 'must be 1-64 characters: letters, digits, underscores, or hyphens')

export const mcpServerSchema = z.object({
    name: z.string(),
    transport: z.enum(['stdio', 'sse', 'http']).optional(),
    command: z.string().optional(),
    args: z.array(z.string()).default([]),
    url: z.string().optional(),
    env: z.record(z.string(), z.string()).default({}),
    headers: z.record(z.string(), z.string()).default({}),
})
export type McpServer = z.infer<typeof mcpServerSchema>
export const strictMcpServerSchema = mcpServerSchema.extend({ name: mcpServerNameSchema })

export const toolsSchema = z.object({
    filesystem: z.boolean().default(true),
    shared: z.boolean().default(true),
    shell: z.boolean().default(true),
    web: z.boolean().default(true),
    memory: z.boolean().default(true),
    db: z.boolean().default(true),
    sharedDb: z.boolean().default(true),
    skills: z.boolean().default(true),
    schedule: z.boolean().default(true),
    trigger: z.boolean().default(true),
    delegate: z.boolean().default(true),
    callAgent: z.boolean().default(true),
    team: z.boolean().default(true),
    browser: z.boolean().default(true),
    vision: z.boolean().default(true),
    notify: z.boolean().default(true),
    askUser: z.boolean().default(true),
    requestApproval: z.boolean().default(true),
    suggestService: z.boolean().default(true),
    requestSecret: z.boolean().default(true),
    hub: z.boolean().default(true),
    cards: z.boolean().default(true),
    quickReplies: z.boolean().default(true),
    brain: z.boolean().default(true),
    computer: z.boolean().default(true),
    computerRecording: z.boolean().default(true),
    paidData: z.boolean().default(true),
})
export type Tools = z.infer<typeof toolsSchema>

export type ToolKey = keyof Tools

// Derived from the schema rather than restated, so adding a capability in one place is
// enough for every consumer (agent panel, template editor, template preview).
export const TOOL_KEYS = Object.keys(toolsSchema.shape) as ToolKey[]

export const selfImprovementSchema = z.object({
    enabled: z.boolean().default(true),
    allowToolInstall: z.boolean().default(true),
    allowSoulEdit: z.boolean().default(true),
    autoMemory: z.boolean().default(true),
})
export type SelfImprovement = z.infer<typeof selfImprovementSchema>

export type SelfImprovementKey = keyof SelfImprovement
export const SELF_IMPROVEMENT_KEYS = Object.keys(selfImprovementSchema.shape) as SelfImprovementKey[]

export const providerSchema = z.enum(['rerun', 'anthropic', 'claude', 'codex', 'openai', 'google', 'openrouter', 'opencode', 'custom'])
export type Provider = z.infer<typeof providerSchema>

// The names the boxes know the Rerun models by. Aliases, not OpenRouter ids: the hub proxy resolves
// each to whatever model that tier runs today (`RERUN_UPSTREAM_MODELS` in apps/ui), so changing a
// model is a hub deploy and never a fleet update.
//
// Balanced keeps the id it had when it was the only one and was called Rerun Max: it is written in
// agent pins, schedules and triggers on every box, and an engine that has not self-updated refuses
// a Rerun connection without it.
export const RERUN_MODELS = { fast: 'rerun-fast', balanced: 'rerun-max', smart: 'rerun-smart' } as const
export type RerunTier = keyof typeof RERUN_MODELS

export const RERUN_TIERS = Object.keys(RERUN_MODELS) as RerunTier[]

export const RERUN_MODEL = RERUN_MODELS.balanced

// Anything that is not a tier id reads as Balanced, which is what a box provisioned before the
// aliases still asks for under an OpenRouter id.
export function rerunTierOf(model: unknown): RerunTier {
    return RERUN_TIERS.find(tier => RERUN_MODELS[tier] === model) ?? 'balanced'
}

// What the hub answers a box on GET /api/llm/models: by alias, the model that serves it for this
// workspace today. Some models need a turn ordered their own way, and only the hub knows which runs.
export const rerunUpstreamModelsSchema = z.object({ models: z.record(z.string(), z.string()) })
export type RerunUpstreamModels = z.infer<typeof rerunUpstreamModelsSchema>

// What a provider runs when it is picked as a fallback rather than chosen. Mid-tier on purpose: a
// substitution nobody asked for should not silently bill the most expensive model of the family.
// Every id here needs a MODEL_CONTEXT_WINDOW entry, otherwise compaction loses its threshold.
export const DEFAULT_PROVIDER_MODEL: Record<Provider, string> = {
    rerun: RERUN_MODEL,
    anthropic: 'claude-sonnet-4-6',
    claude: 'claude-opus-5-5',
    codex: 'gpt-6-sol',
    openai: 'gpt-5.4',
    google: 'gemini-3.6-flash',
    openrouter: 'anthropic/claude-sonnet-5.5',
    opencode: OPENCODE_DEFAULT_MODEL,
    // A custom endpoint serves whatever its owner installed: there is no model to fall back on, so
    // a connection runs the first one it lists.
    custom: '',
}

// How much prose the agent addresses to the user, independent of how much work it does. `normal`
// is the model's native behaviour and deliberately renders no instruction at all, so an agent that
// never touches this setting keeps the exact prompt it had before the field existed.
export const verbositySchema = z.enum(['minimal', 'concise', 'normal', 'detailed'])
export type Verbosity = z.infer<typeof verbositySchema>
export const VERBOSITY_LEVELS = verbositySchema.options

// Guided setup, the counterpart of INSTALL.md. `required` is deliberately three-valued: `null`
// means the author never answered, which is what a template submission blocks on, and is not the
// same statement as "this agent needs nothing".
export const agentSetupSchema = z.object({
    required: z.boolean().nullable().default(null),
    completedAt: z.string().nullable().default(null),
    // The engine session the guided setup was started in. Pending setup with a live session here is
    // an install under way: a second one would ask the user everything twice, beside the first.
    sessionId: z.string().nullable().default(null),
})
export type AgentSetup = z.infer<typeof agentSetupSchema>

// A "yes" with nothing behind it is not an answer: the copy would carry `required: true` and no
// INSTALL.md, so the engine never counts it as pending and the installation it promises never runs.
// Stated here so the capture review, the agent panel, the MCP tools and the capture itself agree.
export function isSetupAnswered(setup: { required: boolean | null; prompt: string }): boolean {
    return setup.required === false || (setup.required === true && setup.prompt.trim().length > 0)
}

export const agentConfigSchema = z.object({
    name: z.string(),
    // `foreman` is the one built-in agent each engine writes for itself at boot. Never settable
    // through the API: `updateAgentSchema` leaves it out.
    kind: z.enum(['user', 'foreman']).default('user'),
    ephemeral: z.boolean().default(false),
    // An agent switched off by its host (a plan that no longer covers it) keeps everything it has
    // and simply stops running: no chat, no schedule, no call from a peer. Defaults to true so a
    // config written before this flag existed reads as a live agent.
    enabled: z.boolean().default(true),
    displayName: z.string().optional(),
    description: z.string().default(''),
    // The box connection this agent draws its credentials from. Null means "not resolved yet":
    // an imported template or an agent created through MCP with a bare provider, which the engine
    // maps onto a matching connection when it loads the agent.
    connectionId: z.string().nullable().default(null),
    // A mirror of the connection's provider, kept because it is what the telemetry, the prompt
    // caching and an exported template all read, and the only thing a template can carry across
    // boxes, since a connection id means nothing on another one.
    provider: providerSchema.nullable().default(null),
    // The switch between "this agent picked a model" and "it runs whatever the box does". Null is
    // the second, whatever stale connectionId or provider sits next to it: a pin is a model, those
    // two only say where to run it.
    model: z.string().nullable().default(null),
    verbosity: verbositySchema.default('normal'),
    tools: toolsSchema.prefault({}),
    mcpServers: z.array(mcpServerSchema).default([]),
    selfImprovement: selfImprovementSchema.prefault({}),
    setup: agentSetupSchema.prefault({}),
})
export type AgentConfig = z.infer<typeof agentConfigSchema>

export const createAgentSchema = z.object({
    config: agentConfigSchema.omit({ kind: true }).partial().extend({ name: z.string() }),
    soul: z.string().optional(),
    install: z.string().optional(),
    keys: z.record(z.string(), z.string()).optional(),
})
export type CreateAgentInput = z.infer<typeof createAgentSchema>

// A coworker made from the app: a name, what it should do, and the Box it joins. The description
// is also its first message, reformulated as the web does.
export const createCoworkerSchema = z.object({
    name: z.string().trim().min(1).max(60),
    description: z.string().trim().max(2000).optional(),
    spaceId: z.string().uuid(),
})
export type CreateCoworkerInput = z.infer<typeof createCoworkerSchema>

// `active` is false when the plan has no free coworker slot: the coworker exists but stays off, and
// nothing was sent to it. `sessionId` and `runId` name the first conversation when one started.
export const createdCoworkerSchema = z.object({
    agentId: z.string(),
    active: z.boolean(),
    sessionId: z.string().nullable(),
    runId: z.string().nullable(),
})
export type CreatedCoworker = z.infer<typeof createdCoworkerSchema>

// Renaming only changes what is displayed: the handle other coworkers mention it by stays put.
export const renameCoworkerSchema = z.object({ name: z.string().trim().min(1).max(60) })
export type RenameCoworkerInput = z.infer<typeof renameCoworkerSchema>

// The caller's own rule for one coworker, the web bell's three choices. `default` follows the
// caller's workspace-wide setting.
export const coworkerNotifyModeSchema = z.enum(['default', 'everything', 'muted'])
export type CoworkerNotifyMode = z.infer<typeof coworkerNotifyModeSchema>

export const coworkerNotificationsSchema = z.object({ mode: coworkerNotifyModeSchema })
export type CoworkerNotifications = z.infer<typeof coworkerNotificationsSchema>

// Copying an agent inside the box it already lives on. Deliberately not the import path: an
// archive is redacted because it leaves the workspace, and every one of those redactions (an
// emptied `.env`, a scrubbed config, connectors back to `needs_auth`, a setup to run again) would
// be a regression on a copy that stays with its owner. All the caller chooses is what to call it.
export const duplicateAgentSchema = z.object({
    name: z.string(),
    displayName: z.string().optional(),
})
export type DuplicateAgentInput = z.infer<typeof duplicateAgentSchema>

// The two things the copy owns that the original does not, and that nobody can see from the
// outside: every webhook was reissued a URL of its own, and the schedules it carries start
// counting from now rather than from whenever the source last ran them.
export const agentDuplicateResultSchema = z.object({
    id: z.string(),
    name: z.string(),
    displayName: z.string().default(''),
    description: z.string().default(''),
    schedules: z.array(z.string()).default([]),
    triggers: z.array(z.string()).default([]),
    memoriesIndexed: z.number().int().nonnegative().default(0),
})
export type AgentDuplicateResult = z.infer<typeof agentDuplicateResultSchema>

export const updateAgentSchema = agentConfigSchema.omit({ kind: true }).partial()

// What makes a coworker variable a screen secret: the site its value signs in to, and whether the
// user already allowed the agent to type it there without asking each run. The value itself stays
// in the agent .env; this is metadata only.
export const screenSecretMetaSchema = z.object({
    site: z.string().min(1),
    allowAlways: z.boolean().default(false),
})
export type ScreenSecretMeta = z.infer<typeof screenSecretMetaSchema>

export const agentKeysListSchema = z.object({
    keys: z.array(z.string()),
    engineKeys: z.array(z.string()).optional(),
    // Absent on an engine that predates screen secrets.
    screen: z.record(z.string(), screenSecretMetaSchema).optional(),
})
export type AgentKeysList = z.infer<typeof agentKeysListSchema>

export const updateAgentKeysSchema = z.object({
    set: z.record(z.string(), z.string()).default({}),
    remove: z.array(z.string()).default([]),
    // Screen-secret metadata for keys in `set` (or already stored): the key never types anywhere
    // without a site to pin it to.
    screen: z.record(z.string(), screenSecretMetaSchema).default({}),
})

export const updateAgentMcpServersSchema = z.object({
    upsert: z.array(strictMcpServerSchema).default([]),
    remove: z.array(z.string()).default([]),
})

export const mcpTokenSchema = z.object({
    accessToken: z.string(),
    refreshToken: z.string().optional(),
    expiresAt: z.number().optional(),
    scope: z.string().optional(),
    tokenEndpoint: z.string().optional(),
    clientId: z.string().optional(),
    clientSecret: z.string().optional(),
    obtainedAt: z.number().optional(),
})

// The live answer of one server: connected, asking for a sign-in (a 401), or down for any other reason.
export const mcpServerStatusSchema = z.object({
    name: z.string(),
    status: z.enum(['connected', 'needs_auth', 'error']),
    transport: z.enum(['stdio', 'sse', 'http']),
    toolCount: z.number().int().nonnegative(),
    error: z.string().optional(),
})
export type McpServerStatus = z.infer<typeof mcpServerStatusSchema>

export const mcpServerStatusListSchema = z.object({ servers: z.array(mcpServerStatusSchema) })

export const agentDetailSchema = z.object({
    id: z.string(),
    config: agentConfigSchema,
    soul: z.string(),
    install: z.string().default(''),
    // The connection, provider and model the engine would actually run this agent on, once its own
    // pin, the box default and the fallbacks are applied. Read-only: a resolution, not a setting.
    resolvedConnectionId: z.string().nullable().default(null),
    resolvedProvider: providerSchema.nullable().default(null),
    // Null only from an engine older than box defaults, which the UI reads as "this box cannot
    // express `model: null` yet" rather than sending it a config it would reject.
    resolvedModel: z.string().nullable().default(null),
})
export type AgentDetail = z.infer<typeof agentDetailSchema>

// The slugs an activation actually switched on, so the caller can say what now runs rather than
// claim it for everything the agent carries.
export const activatedAutomationsSchema = z.object({
    schedules: z.array(z.string()).default([]),
    triggers: z.array(z.string()).default([]),
})
export type ActivatedAutomations = z.infer<typeof activatedAutomationsSchema>
