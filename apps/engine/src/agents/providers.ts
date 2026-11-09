import { createProviderRegistry, wrapLanguageModel, type LanguageModel, type ToolSet } from 'ai'
import { Agent as UndiciAgent } from 'undici'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createClaudeCode, createCustomMcpServer, type McpServerConfig, type MinimalCallToolResult } from 'ai-sdk-provider-claude-code'
import {
    createCodexAppServer,
    createCodexExec,
    createSdkMcpServer,
    tool as codexTool,
    type CodexAppServerSettings,
    type CodexExecSettings,
    type LocalTool,
} from 'ai-sdk-provider-codex-cli'
import type { ZodObject, ZodRawShape, ZodType } from 'zod'
import type { ContextOccupancy, McpServer, Provider } from '@rerun/contracts'
import { env } from '../config/env.js'
import { codexPath } from '../runtime/codex-cli.js'
import { codexHomeDir } from '../config/paths.js'
import { allowedModel } from '../connections/plan.js'
import { CONNECTION_TOKEN_KEY, RERUN_CONNECTION_ID } from '@rerun/contracts'
import { childProcessEnv, envOverlay } from '../lib/child-env.js'
import { newId } from '../lib/ids.js'
import { resolveTransport } from '../tools/mcp.js'
import { relayMcpServer, type RunMcpServer } from '../tools/mcp-relay.js'
import { claudeContextCapture, type ClaudeContextCapture } from './claude-context.js'
import { claudeScreenshotMiddleware } from './claude-stream.js'
import { codexMcpCompatibilityMiddleware } from './codex-stream.js'
import { createCodexImageMiddleware } from './codex-images.js'
import { googleToolSchemaMiddleware } from './google-tool-schema.js'
import { createQuickRepliesCapture, type QuickRepliesCapture } from './quick-replies-stream.js'
import { createFakeToolCallGuard } from './fake-tool-call-stream.js'
import { createCardTagGuard } from './card-tag-stream.js'
import { cardTagStopHook } from './claude-card-nudge.js'
import { openrouterReasoningMiddleware, reasoningFetch } from './openrouter-reasoning.js'
import { cacheBreakpointsFetch } from './openrouter-cache.js'
import { openrouterStreamRetryMiddleware } from './openrouter-stream-retry.js'
import { opencodeLanguageModel } from './opencode.js'
import { opencodeChatReasoningMiddleware, opencodeUsageMiddleware } from './opencode-stream.js'
import { agentProcessEnv } from './process-env.js'
import { BRIDGE_SERVER_NAME, CLI_PROVIDERS, type LoadedAgent } from './types.js'
import { hubCallerHeaders } from '../runtime/hub.js'
import type { StoredScreenshot } from '../runtime/screenshots.js'

export { CLI_PROVIDERS }

const OPENROUTER_DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1'

// Fail fast rather than let an older CLI misbehave: the app-server JSON-RPC protocol this provider
// speaks landed in 0.144.
const CODEX_MIN_VERSION = '0.144.0'

// The bridged server carries Rerun's own tools, so a `tools/call` is a shell command or a whole
// agent run, not an RPC. Both CLIs default to a 300s tool timeout, which abandons work the engine
// finishes fine and leaves the caller with no way to recover the result.
const BRIDGE_TOOL_TIMEOUT_SEC = 3600

// The CLI is a transport for the subscription and nothing more: no built-in tool but WebSearch
// (Rerun's reach it bridged over MCP), no settings file, no prompt of its own. What it still does
// on its own initiative is switched off here so a run holds only what Rerun put in it. Every name exists in
// the CLI the Agent SDK ships (2.1.317); the provider forwards any `CLAUDE_*` through its allowlist
// and merges these over it, so the unprefixed one passes too.
export const CLAUDE_HARNESS_ENV = {
    // Rerun compacts the session before the run. A second compaction inside the CLI would rewrite
    // a history Rerun keeps sending in full, and the two would never agree on what was said.
    DISABLE_AUTO_COMPACT: '1',
    // Update checks, telemetry, surveys.
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: '1',
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
    CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: '1',
    CLAUDE_CODE_DISABLE_WORKFLOWS: '1',
    // The CLI process exits with the turn, so nothing started in the background would outlive it.
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
    CLAUDE_CODE_DISABLE_CRON: '1',
} as const

// Codex's native sub-agents run inside the app-server, which is closed with the run: a child
// spawned without a matching wait is killed mid-work. `delegate_tasks` is the one way to delegate.
export const CODEX_DISABLED_FEATURES = ['multi_agent', 'multi_agent_v2'] as const

// Codex ships a skill system of its own, discovered under `$CODEX_HOME/skills` and fronted by a
// `.system/skill-creator`. An agent asked for a skill reaches for it instead of `skill_create`, and
// what it writes lands outside the Rerun store: invisible in the UI, absent from the agent archive,
// and sitting in a home that belongs to the connection rather than to the agent. There is no
// `features.skills` flag, so the `[skills]` table of config.toml is what closes it.
export const CODEX_SKILL_OVERRIDES = { 'skills.bundled.enabled': false, 'skills.include_instructions': false } as const

// The package declares these but does not export them.
type CodexMcpServerConfig = NonNullable<CodexAppServerSettings['mcpServers']>[string]
type CodexConfigOverrides = NonNullable<CodexAppServerSettings['configOverrides']>

// The Codex counterpart of CLAUDE_HARNESS_ENV, as config overrides. An unknown key is swallowed
// without a word, so every line here was read back from a run against 0.154 rather than trusted.
// `features.view_image` and `features.image_generation` are left on deliberately: vision and image
// generation stay. Two natives outlive the list: `apply_patch`, which has no switch at all, and
// `update_plan`, whose switch below 0.154 ignores. Neither reaches anything a Rerun tool does not.
export const CODEX_HARNESS_OVERRIDES: CodexConfigOverrides = {
    // An AGENTS.md in the workspace would become a second prompt.
    project_doc_max_bytes: 0,
    // The blocks Codex prepends to its instructions on its own.
    include_environment_context: false,
    include_permissions_instructions: false,
    include_apps_instructions: false,
    include_collaboration_mode_instructions: false,
    // A run reopens it in `codexAppServerProvider`, where the subscription pays for the search.
    web_search: 'disabled',
    'history.persistence': 'none',
    check_for_update_on_startup: false,
    'tools.update_plan.enabled': false,
    'tools.experimental_request_user_input.enabled': false,
    'features.apps': false,
    'features.memories': false,
    'features.goals': false,
    'features.tool_suggest': false,
    'features.hooks': false,
    'features.code_mode': false,
    // Running a command is shell_exec, the Rerun tool. These two close Codex's own shell whole:
    // with them the model answers that it has no way to run a command.
    'features.shell_tool': false,
    'features.unified_exec': false,
    // A binary too old to know those two keeps its shell, and that shell drops any inherited
    // variable named like a key or a token, which shell_exec passes on. These put the paths the
    // prompt names and the agent's .env back in it.
    'shell_environment_policy.inherit': 'all',
    'shell_environment_policy.ignore_default_excludes': true,
    ...Object.fromEntries(CODEX_DISABLED_FEATURES.map(feature => [`features.${feature}`, false])),
    ...CODEX_SKILL_OVERRIDES,
}

function openaiChat(options: Parameters<typeof createOpenAI>[0]) {
    const p = createOpenAI(options)
    return Object.assign(p, { languageModel: (id: string) => p.chat(id) })
}

function isZodSchema(schema: unknown): boolean {
    return !!schema && typeof schema === 'object' && ('_def' in schema || '~standard' in schema)
}

function bridgeableTools(tools: ToolSet): ToolSet {
    const out: ToolSet = {}
    for (const [name, t] of Object.entries(tools)) {
        if (typeof t.execute === 'function' && isZodSchema(t.inputSchema)) out[name] = t
    }
    return out
}

function nativeMcpEntry(server: McpServer): McpServerConfig | null {
    const kind = resolveTransport(server)
    if (kind === 'stdio') return server.command ? { type: 'stdio', command: server.command, args: server.args, env: server.env } : null
    if (!server.url) return null
    if (kind === 'http') return { type: 'http', url: server.url, headers: server.headers }
    return { type: 'sse', url: server.url, headers: server.headers }
}

export type ScreenshotLookup = (id: string) => StoredScreenshot | undefined

type BridgedTool = ToolSet[string]
type BridgeCall = { requestId?: unknown; signal?: AbortSignal }

const bridgeError = (message: string): MinimalCallToolResult => ({ isError: true, content: [{ type: 'text', text: message }] })

// What the model reads is the text the tool returned, as with any bridged tool. A result that names
// a screenshot of the run also carries the picture, which only this side of the bridge can attach.
export function claudeBridgeHandler(bridged: BridgedTool, screenshots?: ScreenshotLookup) {
    return async (args: Record<string, unknown>, extra: unknown): Promise<MinimalCallToolResult> => {
        const call = (extra ?? {}) as BridgeCall
        try {
            const result: unknown = await bridged.execute!(args, { toolCallId: call.requestId !== undefined ? String(call.requestId) : newId(), abortSignal: call.signal, messages: [] })
            const text = typeof result === 'string' ? result : (JSON.stringify(result) ?? 'undefined')
            const id = (result as { screenshotId?: unknown } | null)?.screenshotId
            const screenshot = typeof id === 'string' ? screenshots?.(id) : undefined
            return { content: [{ type: 'text', text }, ...(screenshot ? [{ type: 'image' as const, data: screenshot.image.toString('base64'), mimeType: screenshot.mediaType }] : [])] }
        } catch (error) {
            return bridgeError(error instanceof Error ? error.message : String(error))
        }
    }
}

export function claudeMcpConfig(tools?: ToolSet, mcpServers: RunMcpServer[] = [], screenshots?: ScreenshotLookup): { mcpServers: Record<string, McpServerConfig>; allowedTools: string[] } {
    const bridged = tools ? bridgeableTools(tools) : {}
    const names = Object.keys(bridged)
    const servers: Record<string, McpServerConfig> = {}
    const allowedTools: string[] = []
    if (names.length) {
        servers[BRIDGE_SERVER_NAME] = createCustomMcpServer({
            name: BRIDGE_SERVER_NAME,
            tools: Object.fromEntries(names.map(name => [name, { description: bridged[name]!.description ?? '', inputSchema: bridged[name]!.inputSchema as ZodObject<ZodRawShape>, handler: claudeBridgeHandler(bridged[name]!, screenshots) }])),
        })
        allowedTools.push(...names.map(n => `mcp__${BRIDGE_SERVER_NAME}__${n}`))
    }
    for (const server of mcpServers) {
        const entry = server.relay ? relayMcpServer(server.relay, BRIDGE_TOOL_TIMEOUT_SEC * 1000) : nativeMcpEntry(server)
        if (!entry || server.name === BRIDGE_SERVER_NAME) continue
        servers[server.name] = entry
        allowedTools.push(`mcp__${server.name}`)
    }
    return { mcpServers: servers, allowedTools }
}

// Codex has no SSE transport, so an SSE server is dropped rather than mangled into an http entry.
function codexNativeMcpEntry(server: McpServer): CodexMcpServerConfig | null {
    const kind = resolveTransport(server)
    if (kind === 'stdio') return server.command ? { transport: 'stdio', command: server.command, args: server.args, env: server.env } : null
    if (kind === 'http' && server.url) return { transport: 'http', url: server.url, httpHeaders: server.headers }
    return null
}

// Codex's `tool()` takes `parameters` where the AI SDK takes `inputSchema`, and hands `execute` the
// parsed input alone, with no abort signal and no id of the model's call. A tool that has to stop
// with its run reads `RunContext.abortSignal` instead, and nothing can join on `toolCallId`.
function codexBridgedTools(tools: ToolSet): LocalTool[] {
    return Object.entries(bridgeableTools(tools)).map(([name, t]) =>
        codexTool({
            name,
            description: t.description ?? name,
            parameters: t.inputSchema as ZodType,
            execute: async input => t.execute!(input, { toolCallId: newId(), messages: [] }),
        }),
    )
}

export function codexMcpConfig(tools?: ToolSet, mcpServers: McpServer[] = []): Record<string, CodexMcpServerConfig> {
    const servers: Record<string, CodexMcpServerConfig> = {}
    const bridged = tools ? codexBridgedTools(tools) : []
    if (bridged.length) servers[BRIDGE_SERVER_NAME] = createSdkMcpServer({ name: BRIDGE_SERVER_NAME, tools: bridged })
    for (const server of mcpServers) {
        const entry = codexNativeMcpEntry(server)
        if (!entry || server.name === BRIDGE_SERVER_NAME) continue
        servers[server.name] = entry
    }
    return servers
}

// What a CLI provider takes from the run beyond its tools. `system` is the run's prompt, which the
// CLI takes through its settings rather than through the AI SDK message (see `applyCaching`): a
// one-shot call (compaction, curator, vision) has none here and keeps passing its own to
// generateText, where the provider folds it into the user turn. `claudeTools` reopens named Claude
// built-ins for that call alone; a run has only CLAUDE_RUN_TOOLS.
//
// `sessionId` is what an OpenCode request names its conversation by: a one-shot call inside a run
// (compaction, vision) passes the run's own, the others one of their own making.
export type CliModelOptions = { system?: string; claudeTools?: readonly string[]; screenshots?: ScreenshotLookup; sessionId?: string }

// What a run hands its model beyond the tools: the prompt and the screenshots for the CLIs, the
// conversation for OpenCode.
export type ResolveModelOptions = { system?: string; screenshots?: ScreenshotLookup; sessionId?: string }

function oneShotSessionId(agent: LoadedAgent, options?: { sessionId?: string }): string {
    return options?.sessionId ?? `${agent.id}:one-shot`
}

// The subscription pays for the CLI's own web search, where Rerun's web_search would bill Brave to
// Rerun. Its WebFetch stays closed: it hands back a summary of the page, web_fetch the page itself.
export const CLAUDE_RUN_TOOLS = ['WebSearch'] as const

// A token handed over by environment variable is read by the CLI as inference-only whatever it was
// issued with, and the plan limits are only read with the profile scope. Only the sign-in flow asks
// for that scope, and it is also the only one that leaves a refresh token: a `claude setup-token`
// value pasted by hand has neither, and claiming the scope for it would promise a read that fails.
const CLAUDE_SIGN_IN_SCOPES = 'user:profile user:inference'

export function claudeAuthEnv(connection: Record<string, string>): { CLAUDE_CODE_OAUTH_TOKEN: string; CLAUDE_CODE_OAUTH_SCOPES: string | undefined } {
    return {
        CLAUDE_CODE_OAUTH_TOKEN: connection.CLAUDE_CODE_OAUTH_TOKEN ?? '',
        CLAUDE_CODE_OAUTH_SCOPES: connection.CLAUDE_CODE_OAUTH_REFRESH_TOKEN ? CLAUDE_SIGN_IN_SCOPES : undefined,
    }
}

type ClaudeHooks = NonNullable<ClaudeContextCapture['settings']['hooks']>

// Added beside the context capture's Stop hook, never in its place: a hook list that replaced it
// silently lost the context window gauge once before.
export function withCardTagNudge(hooks: ClaudeHooks | undefined): ClaudeHooks {
    const stop = hooks?.Stop ?? []
    return { ...hooks, Stop: [...stop, { hooks: [cardTagStopHook] }] }
}

function claudeProvider(agent: LoadedAgent, tools?: ToolSet, mcpServers: RunMcpServer[] = [], capture?: ClaudeContextCapture, options: CliModelOptions = {}) {
    const { mcpServers: servers, allowedTools } = claudeMcpConfig(tools, mcpServers, options.screenshots)
    const { cwd, env: agentEnv } = agentProcessEnv(agent)
    return createClaudeCode({
        defaultSettings: {
            persistSession: false,
            permissionMode: 'bypassPermissions',
            allowDangerouslySkipPermissions: true,
            tools: [...(options.claudeTools ?? [])],
            strictMcpConfig: true,
            enableFileCheckpointing: false,
            cwd,
            // Without this the CLI emits no thinking block at all, so the chat never shows what the
            // agent is working through. `adaptive` leaves the model to decide when it is worth it.
            thinking: { type: 'adaptive', display: 'summarized' },
            env: {
                ...agentEnv,
                ...CLAUDE_HARNESS_ENV,
                ...claudeAuthEnv(connectionEnv(agent)),
                ANTHROPIC_API_KEY: undefined,
                MCP_TOOL_TIMEOUT: String(BRIDGE_TOOL_TIMEOUT_SEC * 1000),
            },
            ...(options.system !== undefined ? { systemPrompt: options.system } : {}),
            ...(allowedTools.length ? { mcpServers: servers, allowedTools } : {}),
            ...(capture ? { ...capture.settings, hooks: withCardTagNudge(capture.settings.hooks) } : {}),
        },
    })
}

// The credentials an agent runs on live on its box connection, not on the agent. An agent with no
// connection resolves to an empty set, which every provider reads as "no key" and fails on rather
// than silently borrowing an ambient one.
function connectionEnv(agent: LoadedAgent): Record<string, string> {
    return agent.resolved.connection?.env ?? {}
}

// Codex reads its credentials from `$CODEX_HOME/auth.json`, which codex-auth.ts writes before the
// run — there is no token setting to pass. `env` is merged over process.env by the provider, so it
// is given as an overlay that empties every engine variable the child must not see. The home is
// the connection's, so agents sharing a subscription share one auth.json.
function codexShared(agent: LoadedAgent): CodexExecSettings & CodexAppServerSettings {
    const { cwd, env: agentEnv } = agentProcessEnv(agent)
    const path = codexPath()
    return {
        cwd,
        env: envOverlay(childProcessEnv(agentEnv, { CODEX_HOME: codexHomeDir(agent.resolved.connection?.id ?? RERUN_CONNECTION_ID) })),
        ...(path ? { codexPath: path } : {}),
    }
}

export const CODEX_ONE_SHOT_INSTRUCTIONS = 'Do what the user message asks and answer with the result alone.'

// One-shot calls (compaction, curator, vision, memory reconcile): no tools and no streaming needed,
// so the cheaper exec transport avoids a persistent process nobody would be left to close.
function codexExecProvider(agent: LoadedAgent) {
    return createCodexExec({
        defaultSettings: {
            ...codexShared(agent),
            approvalMode: 'never',
            sandboxMode: 'danger-full-access',
            skipGitRepoCheck: true,
            // Codex's own prompt is a coding agent's, several thousand tokens on every call that no
            // cache ever holds. Each caller brings its own instructions in the user turn. `instructions`
            // was read back against 0.160; `base_instructions` is swallowed there.
            configOverrides: { ...CODEX_HARNESS_OVERRIDES, instructions: CODEX_ONE_SHOT_INSTRUCTIONS },
        },
    })
}

// The chat/run transport. Only the app-server emits real text deltas — exec returns the whole turn
// as a single chunk, which would leave the chat blank for the length of an agentic loop.
function codexAppServerProvider(agent: LoadedAgent, tools?: ToolSet, mcpServers: McpServer[] = [], options: CliModelOptions = {}) {
    return createCodexAppServer({
        defaultSettings: {
            ...codexShared(agent),
            approvalPolicy: 'never',
            sandboxPolicy: 'danger-full-access',
            autoApprove: true,
            // A thread written to disk, so the next message can resume it: the run passes its id
            // back (see `codexThreadToResume`), and Codex keys OpenAI's prompt cache on it.
            threadMode: 'persistent',
            minCodexVersion: CODEX_MIN_VERSION,
            rmcpClient: true,
            personality: 'none',
            // The Rerun prompt replaces Codex's base instructions rather than following them as
            // developer instructions, so the model reads one identity, not two.
            ...(options.system !== undefined ? { baseInstructions: options.system } : {}),
            // Pin the tool namespace: without it recent Codex builds expose the bridged tools as
            // `rerun__ask_user` on some versions and `mcp__rerun__ask_user` on others.
            // The reasoning summary is stated rather than left to whichever Codex build the box has
            // installed, so the chat shows the same thing everywhere.
            configOverrides: {
                prefix_mcp_tool_names: true,
                [`mcp_servers.${BRIDGE_SERVER_NAME}.tool_timeout_sec`]: BRIDGE_TOOL_TIMEOUT_SEC,
                model_reasoning_summary: 'auto',
                ...CODEX_HARNESS_OVERRIDES,
                ...(agent.config.tools.web ? { web_search: 'live' } : {}),
            },
            mcpServers: codexMcpConfig(tools, mcpServers),
        },
    })
}

// The two providers that speak the OpenAI chat format to OpenRouter: the keyless `rerun` one
// through the hub proxy, and the user's own key straight to OpenRouter (or to the router they
// pointed their connection at).
function openrouterCompatibleOptions(agent: LoadedAgent, provider: 'rerun' | 'openrouter'): Parameters<typeof createOpenAI>[0] {
    if (provider === 'rerun') {
        const { RERUN_HUB_BASE_URL: hub, RERUN_API_KEY: hubKey } = env()
        return { apiKey: hubKey ?? '', baseURL: `${(hub ?? '').replace(/\/$/, '')}/api/llm`, headers: hubCallerHeaders(agent) }
    }
    return {
        apiKey: connectionEnv(agent).OPENROUTER_API_KEY,
        baseURL: (agent.resolved.connection?.config.baseUrl || OPENROUTER_DEFAULT_BASE_URL).replace(/\/+$/, ''),
    }
}

// A local model on modest hardware reads a long prompt for minutes before its first token, and
// sends no response header until then: past the five minutes Node allows, the request is dropped and
// retried from scratch, three times over. Measured on a CPU box: a 20k-token prompt takes 25 minutes.
const CUSTOM_ENDPOINT_PATIENCE_MS = 60 * 60_000
const customEndpointDispatcher = new UndiciAgent({ headersTimeout: CUSTOM_ENDPOINT_PATIENCE_MS, bodyTimeout: CUSTOM_ENDPOINT_PATIENCE_MS })

const customEndpointFetch: typeof fetch = (input, init) => fetch(input, { ...init, dispatcher: customEndpointDispatcher } as RequestInit)

// Any server that speaks the OpenAI chat format, at the address its owner gave. Nothing of
// OpenRouter's dialect is added to the request: a strict server answers an unknown field with a 400.
// The SDK refuses to build without a key, and a local server ignores the header it puts it in.
function customOptions(agent: LoadedAgent): Parameters<typeof createOpenAI>[0] {
    return {
        apiKey: connectionEnv(agent)[CONNECTION_TOKEN_KEY.custom] || 'none',
        baseURL: (agent.resolved.connection?.config.baseUrl ?? '').trim().replace(/\/+$/, ''),
        fetch: customEndpointFetch,
    }
}

function registryFor(agent: LoadedAgent, tools?: ToolSet, mcpServers?: McpServer[], options?: CliModelOptions) {
    const e = connectionEnv(agent)
    return createProviderRegistry({
        rerun: openaiChat(openrouterCompatibleOptions(agent, 'rerun')),
        anthropic: createAnthropic({ apiKey: e.ANTHROPIC_API_KEY }),
        claude: claudeProvider(agent, tools, mcpServers, undefined, options),
        codex: codexExecProvider(agent),
        openai: createOpenAI({ apiKey: e.OPENAI_API_KEY }),
        google: createGoogleGenerativeAI({ apiKey: e.GOOGLE_GENERATIVE_AI_API_KEY ?? e.GOOGLE_API_KEY }),
        openrouter: openaiChat(openrouterCompatibleOptions(agent, 'openrouter')),
        custom: openaiChat(customOptions(agent)),
    })
}

// A run's model, as asked for. The provider is the connection's — the override only ever names a
// connection and a model, and `runtime/loop.ts` derives the provider from the resolved connection.
export type ModelOverride = { connectionId?: string; provider?: Provider; model?: string }

// `agent.resolved` already applied the agent's pin, the box default and the fallbacks, so it is
// what a caller with no override of its own (compaction, curator, vision, memory reconcile) means.
function pairFor(agent: LoadedAgent, override?: ModelOverride): { provider: Provider; model: string } {
    const provider = agent.resolved.provider
    return { provider, model: allowedModel(provider, override?.model ?? agent.resolved.model) }
}

// For one-shot calls with no tools. Codex resolves to the exec transport here, which spawns per call
// and exits — nothing to dispose. A run that streams must use `resolveModel` instead.
export function modelFor(agent: LoadedAgent, override?: ModelOverride, tools?: ToolSet, mcpServers?: McpServer[], options?: CliModelOptions): LanguageModel {
    const { provider, model } = pairFor(agent, override)
    if (provider === 'opencode') {
        const opencode = opencodeLanguageModel(agent.resolved.connection, model, oneShotSessionId(agent, options))
        return wrapLanguageModel({ model: opencode.model, middleware: opencode.middleware })
    }
    return registryFor(agent, tools, mcpServers, options).languageModel(`${provider}:${model}`)
}

// A model plus whatever has to be torn down once the run is over. Only the Codex app-server holds a
// process; every other provider closes to a no-op. `contextUsage` reads the context window occupancy
// a claude run captured via its Stop hook — the cumulative usage the provider reports at finish
// counts cache reads once per internal turn and says nothing about how full the window is.
// `quickReplies` reads the block the model closed its message with, cut out of the text on its way.
export type ResolvedModel = { model: LanguageModel; close: () => Promise<void>; contextUsage?: () => ContextOccupancy | undefined; quickReplies: () => QuickRepliesCapture | undefined }

const noClose = async (): Promise<void> => {}

export function resolveModel(agent: LoadedAgent, override?: ModelOverride, tools?: ToolSet, mcpServers?: RunMcpServer[], { system, screenshots, sessionId }: ResolveModelOptions = {}): ResolvedModel {
    const { provider, model } = pairFor(agent, override)
    // `wrapLanguageModel` runs the list from the end: the guard sits nearest the model, so no other
    // middleware ever reads a fake tool call, the card tags go next, and the quick replies read the
    // text right after them.
    const replies = createQuickRepliesCapture()
    const cardTags = createCardTagGuard(agent.id, provider)
    const guard = createFakeToolCallGuard(agent.id)
    if (provider === 'codex') {
        const codex = codexAppServerProvider(agent, tools, mcpServers, { system })
        return { model: wrapLanguageModel({ model: codex(model), middleware: [codexMcpCompatibilityMiddleware, createCodexImageMiddleware(agent.id), replies.middleware, cardTags, guard] }), close: () => codex.close(), quickReplies: replies.read }
    }
    if (provider === 'claude') {
        const capture = claudeContextCapture(agent.resolved.connection?.id)
        const claude = claudeProvider(agent, tools, mcpServers, capture, { system, screenshots, claudeTools: agent.config.tools.web ? CLAUDE_RUN_TOOLS : [] }).languageModel(model)
        return { model: wrapLanguageModel({ model: claude, middleware: [claudeScreenshotMiddleware, replies.middleware, cardTags, guard] }), close: noClose, contextUsage: capture.read, quickReplies: replies.read }
    }
    // OpenCode runs in Rerun's own loop, on the SDK of whichever format the model is served on.
    if (provider === 'opencode') {
        const opencode = opencodeLanguageModel(agent.resolved.connection, model, sessionId ?? oneShotSessionId(agent))
        return { model: wrapLanguageModel({ model: opencode.model, middleware: [...opencode.middleware, opencodeUsageMiddleware, replies.middleware, cardTags, guard] }), close: noClose, quickReplies: replies.read }
    }
    // Asking for the reasoning and reading it back are both off the OpenAI chat format, so they are
    // wired here rather than in the registry: the one-shot calls that go through `modelFor`
    // (compaction, curator, vision, memory reconcile) have no one to show a thought to.
    if (provider === 'rerun' || provider === 'openrouter') {
        const openrouter = openaiChat({ ...openrouterCompatibleOptions(agent, provider), fetch: provider === 'openrouter' ? cacheBreakpointsFetch(reasoningFetch) : reasoningFetch })
        return { model: wrapLanguageModel({ model: openrouter.languageModel(model), middleware: [openrouterStreamRetryMiddleware, openrouterReasoningMiddleware, replies.middleware, cardTags, guard] }), close: noClose, quickReplies: replies.read }
    }
    // The reasoning a DeepSeek or a vLLM server streams back comes as `reasoning_content`, read the
    // way OpenCode's chat models are, without asking for it in the request.
    if (provider === 'custom') {
        const custom = openaiChat(customOptions(agent))
        return { model: wrapLanguageModel({ model: custom.languageModel(model), middleware: [openrouterStreamRetryMiddleware, opencodeChatReasoningMiddleware, replies.middleware, cardTags, guard] }), close: noClose, quickReplies: replies.read }
    }
    const middleware = provider === 'google' ? [googleToolSchemaMiddleware, replies.middleware, cardTags, guard] : [replies.middleware, cardTags, guard]
    return { model: wrapLanguageModel({ model: registryFor(agent, tools, mcpServers).languageModel(`${provider}:${model}`), middleware }), close: noClose, quickReplies: replies.read }
}
