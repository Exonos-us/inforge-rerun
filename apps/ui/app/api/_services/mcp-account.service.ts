import { connectorSkillReadOnlyError, isSetupAnswered, MAX_TEXT_WRITE_CHARS, providerSchema, triggerMethodSchema, verbositySchema } from '@rerun/contracts'
import { AccessDeniedError, assertAgentInWorkspace, callableEngineAgentIds, isAdminActor, keepVisible, manageableSpaceIds, spaceAccessMap, visibleAgentIds, visibleSpaceIds, type Actor } from '@/app/api/_auth/access'
import type { Database } from '@/app/api/database.types'
import {
    chat as engineChat,
    createSchedule as engineCreateSchedule,
    createTrigger as engineCreateTrigger,
    deleteSchedule as engineDeleteSchedule,
    deleteSkill as engineDeleteSkill,
    deleteTrigger as engineDeleteTrigger,
    SPACE_DATA_BASE,
    agentDataBase,
    agentFilesBase,
    createMemory as engineCreateMemory,
    executeDb as engineExecuteDb,
    fireTrigger as engineFireTrigger,
    getAgent as engineGetAgent,
    getRun as engineGetRun,
    getRunTools as engineGetRunTools,
    getSkill as engineGetSkill,
    getTrigger as engineGetTrigger,
    importSkill as engineImportSkill,
    listConnections as engineListConnections,
    listDbTables as engineListDbTables,
    listRuns as engineListRuns,
    listSchedules as engineListSchedules,
    listSkills as engineListSkills,
    listTriggers as engineListTriggers,
    patchAgent as enginePatchAgent,
    queryDb as engineQueryDb,
    rotateTriggerToken as engineRotateTriggerToken,
    runScheduleNow as engineRunScheduleNow,
    setBoxDefault as engineSetBoxDefault,
    updateSchedule as engineUpdateSchedule,
    updateTrigger as engineUpdateTrigger,
    uploadFile as engineUploadFile,
    writeFileText as engineWriteFileText,
} from '@/lib/engine/client'
import type { InstalledService } from '@/lib/services/types'
import type { BoxConnection, EngineAgentConfigPatch, EngineAgentDetail, EngineAgentSetup, EngineConnection, EngineRunDetail, EngineTrigger, EngineTriggerMethod } from '@/lib/engine/types'
import { MAX_MEMORIES_PER_CALL, MAX_MEMORY_CHARS, MAX_UPLOAD_MB } from '@/lib/mcp/account-tools'
import { asBooleanRecord, asNumber, asString, asStringArray, clamp, requireConfirmation, requireString } from '@/lib/mcp/args'
import { connectionModels, readModelPin, type ModelPin } from '@/lib/mcp/model-pin'
import { projectRun } from '@/lib/mcp/run-projection'
import { assertModelEntitled } from '@/app/api/_services/engine-plan.service'
import { truncateField } from '@/lib/mcp/truncate'
import { describeSkillFiles, normalizeSkillFilePath, planSkillFileRemovals, readSkillReferenceFile, removeSkillFiles } from '@/lib/skills/reference-files'
import { connectorSkillOwners, readRegistry } from '@/lib/services/registry'
import { slugify } from '@/lib/slugify'
import { MAX_TRIGGER_BODY_BYTES, triggerWebhookUrl } from '@/lib/triggers/webhook'
import { createServiceRoleClient } from '@/supabase/serviceRole'
import { selectCount, selectMany, selectMaybeSingle } from '@/supabase/supabase-helpers'
import { changeAgentHandle, createAgent, deleteAgent, moveAgentToBox, renameAgent } from './agent.service'
import { declareService, installServiceSlugs } from './agent-setup.service'
import { LOCKED_NOTICE, LOCKED_WRITE_ERROR } from './agent-content.service'
import { ensureSessionRow, resolveAgentTarget } from './chat.service'
import { followCoworker, recordSessionParticipant } from './notification-audience.service'
import { resolveSpaceTarget } from './space.service'
import { dispatchShareTool } from './mcp-shares.service'
import { allocateServiceInstance, listCatalogServices, listInstalledServices, loadManifest, searchCatalogServices, toAuthMethodSummaries, uninstallService } from './services.service'
import { readTeamStatus } from './team-status.service'
import { getWorkspaceConnection, NoEngineError } from './workspace-engine.service'

// Dispatch for the account MCP server (app/api/mcp/account/route.ts). Every handler takes
// its workspace from the authenticated API key, never from an argument, and reaches agents
// only through resolveAgentTarget, or a Box through resolveSpaceTarget — the same ownership
// chokepoints the browser session uses.

type SkillFile = { path: string; content: string }

// A malformed entry is rejected rather than dropped: silently skipping it would answer "skill
// written" on a call whose reference file never landed.
function asSkillFiles(v: unknown): SkillFile[] {
    if (v === undefined) return []
    if (!Array.isArray(v)) throw new Error('files must be an array, e.g. [{"path": "references/api.md", "content": "…"}].')
    return v.map((entry, index) => {
        const { path, content } = (entry ?? {}) as { path?: unknown; content?: unknown }
        if (typeof path !== 'string' || !path || typeof content !== 'string') {
            throw new Error(`files[${index}] needs a non-empty "path" and a "content" string.`)
        }
        return { path, content }
    })
}

type SqlParam = string | number | boolean | null

function asSqlParams(v: unknown): SqlParam[] {
    if (!Array.isArray(v)) return []
    return v.filter((p): p is SqlParam => p === null || typeof p === 'string' || typeof p === 'number' || typeof p === 'boolean')
}

function asSqlStatements(v: unknown): { sql: string; params: SqlParam[] }[] | undefined {
    if (!Array.isArray(v)) return undefined
    const statements = v.flatMap(entry => {
        if (!entry || typeof entry !== 'object') return []
        const { sql, params } = entry as { sql?: unknown; params?: unknown }
        return typeof sql === 'string' && sql ? [{ sql, params: asSqlParams(params) }] : []
    })
    return statements.length > 0 ? statements : undefined
}

// The import endpoint reads a SKILL.md, but takes name and description as explicit fields
// that win over the frontmatter — so they never have to survive a round trip through YAML we
// wrote by hand. The empty block is there so a body opening on a `---` rule isn't swallowed
// as frontmatter.
function toSkillMarkdown(body: string): string {
    return `---\n---\n\n${body.trim()}\n`
}

// Safety and tone settings, read the same way whether they arrive at creation or on an
// update. Only the keys actually present end up in the patch: an absent key must stay absent
// or a PATCH would reset the rest of the config to its defaults.
function readConfigPatch(args: Record<string, unknown>, pin: ModelPin | undefined): EngineAgentConfigPatch {
    const patch: EngineAgentConfigPatch = { ...pin }
    const verbosity = asString(args.verbosity)
    const tools = asBooleanRecord(args.tools)
    const selfImprovement = asBooleanRecord(args.selfImprovement)

    if (verbosity !== undefined) {
        const parsed = verbositySchema.safeParse(verbosity)
        if (!parsed.success) throw new Error(`Unknown verbosity "${verbosity}". Expected one of: ${verbositySchema.options.join(', ')}`)
        patch.verbosity = parsed.data
    }
    if (tools !== undefined) patch.tools = tools
    if (selfImprovement !== undefined) patch.selfImprovement = selfImprovement
    return patch
}

function namesModelPin(args: Record<string, unknown>): boolean {
    return args.connectionId !== undefined || args.provider !== undefined || args.model !== undefined
}

// A workspace that has not claimed its machine yet has no connection to check a pin against, and
// the coworker being created is what claims it: the pair is then written as asked.
function unverifiedModelPin(args: Record<string, unknown>): ModelPin {
    const provider = asString(args.provider)
    const parsed = provider === undefined ? null : providerSchema.safeParse(provider)
    if (parsed && !parsed.success) throw new Error(`Unknown provider "${provider}". Expected one of: ${providerSchema.options.join(', ')}`)
    return { connectionId: asString(args.connectionId) ?? null, provider: parsed?.data ?? null, model: asString(args.model) ?? null }
}

async function newAgentModelPin(workspaceId: number, args: Record<string, unknown>): Promise<ModelPin | undefined> {
    if (!namesModelPin(args)) return undefined
    let conn: EngineConnection
    try {
        conn = await getWorkspaceConnection(workspaceId)
    } catch (err) {
        if (err instanceof NoEngineError) return unverifiedModelPin(args)
        throw err
    }
    return readModelPin(args, (await engineListConnections(conn)).connections)
}

type CheckedModelPin = { pin: ModelPin; connections: BoxConnection[] }

// The pin of an existing coworker, or of one of its automations. The connection the coworker runs
// on today is only read when the call names a model and nothing else, which is the one case where
// it decides the answer.
async function checkedModelPin(conn: EngineConnection, engineAgentId: string, args: Record<string, unknown>): Promise<CheckedModelPin | undefined> {
    if (!namesModelPin(args)) return undefined
    const { connections } = await engineListConnections(conn)
    const modelAlone = typeof args.model === 'string' && typeof args.connectionId !== 'string' && typeof args.provider !== 'string'
    const current = modelAlone ? (await engineGetAgent(conn, engineAgentId)).resolvedConnectionId : null
    const pin = readModelPin(args, connections, current)
    return pin ? { pin, connections } : undefined
}

// What the coworker runs on once the box has resolved its config, which is the only honest answer
// to "did the change take": a pin can be written and still lose to something else.
function projectRunsOn(detail: EngineAgentDetail, connections: BoxConnection[]) {
    return {
        connectionId: detail.resolvedConnectionId,
        connectionName: connections.find(connection => connection.id === detail.resolvedConnectionId)?.name ?? null,
        provider: detail.resolvedProvider ?? detail.config.provider,
        model: detail.resolvedModel ?? detail.config.model,
        followsWorkspaceDefault: detail.config.model === null,
    }
}

// The guided-setup answer, written exactly the way the app writes it (lib/templates/capture.ts and
// the agent panel): the answer is stamped complete on the spot, because the caller is the author
// and the author never installs their own agent — only the copy an import creates starts pending.
function readSetup(args: Record<string, unknown>): { setup: Partial<EngineAgentSetup>; install: string } | undefined {
    const raw = args.setup
    if (raw === undefined) return undefined
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('setup must be an object, e.g. {"required": true, "prompt": "..."}.')

    const { required, prompt } = raw as { required?: unknown; prompt?: unknown }
    if (typeof required !== 'boolean') throw new Error('setup.required must be true or false. It is the answer to "does this coworker need to be configured after install?".')

    const text = typeof prompt === 'string' ? prompt.trim() : ''
    if (!isSetupAnswered({ required, prompt: text })) throw new Error('setup.required is true, so setup.prompt must carry the install instructions the coworker runs on its new owner account.')

    return { setup: { required, completedAt: new Date().toISOString() }, install: required ? text : '' }
}

const RUN_POLL_INTERVAL_MS = 2000
const DEFAULT_WAIT_SECONDS = 120
const MAX_WAIT_SECONDS = 600

function parseTriggerMethod(value: string): EngineTriggerMethod {
    const parsed = triggerMethodSchema.safeParse(value.toUpperCase())
    if (!parsed.success) throw new Error(`Unknown HTTP method "${value}". Expected one of: ${triggerMethodSchema.options.join(', ')}`)
    return parsed.data
}

function asTriggerMethods(v: unknown): EngineTriggerMethod[] | undefined {
    if (v === undefined) return undefined
    if (!Array.isArray(v) || v.length === 0) throw new Error(`methods must be a non-empty array of: ${triggerMethodSchema.options.join(', ')}`)
    return [...new Set(v.map(entry => parseTriggerMethod(String(entry))))]
}

function asTriggerBody(v: unknown): string {
    if (v === undefined || v === null) return ''
    return typeof v === 'string' ? v : JSON.stringify(v)
}

function defaultContentType(body: string): string {
    if (!body) return ''
    const head = body.trimStart()[0]
    return head === '{' || head === '[' ? 'application/json' : 'text/plain'
}

// The public URL carries the token, so it stands in for it rather than being returned next to
// it: nothing here should invite the caller to recompose the URL by hand. It is built from the
// Rerun agent id, not the engine's local one, since that is what /api/t/... resolves.
async function projectTrigger(agentId: string, trigger: EngineTrigger) {
    return {
        slug: trigger.slug,
        name: trigger.name,
        description: trigger.description,
        body: trigger.body,
        methods: trigger.methods,
        enabled: trigger.enabled,
        connectionId: trigger.connectionId,
        model: trigger.model,
        lastFiredAt: trigger.lastFiredAt,
        fireCount: trigger.fireCount,
        url: trigger.token ? await triggerWebhookUrl(agentId, trigger.slug, trigger.token) : null,
    }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function waitForRun(conn: EngineConnection, engineAgentId: string, runId: string, waitSeconds: number): Promise<EngineRunDetail> {
    const deadline = Date.now() + waitSeconds * 1000
    let run = await engineGetRun(conn, engineAgentId, runId)
    while (run.status === 'running' && Date.now() < deadline) {
        await sleep(RUN_POLL_INTERVAL_MS)
        run = await engineGetRun(conn, engineAgentId, runId)
    }
    return run
}

// Only the Boxes the caller manages are candidates: a coworker is created where it can be set up.
async function resolveSpaceId(actor: Actor, requested?: string): Promise<string> {
    const supabase = createServiceRoleClient()
    const [{ data: all }, manageable] = await Promise.all([selectMany(supabase, 'spaces', ['id', 'name'] as const, { workspace_id: actor.workspaceId }), manageableSpaceIds(actor)])
    const spaces = keepVisible(all ?? [], manageable, space => space.id)

    if (spaces.length === 0) throw new Error(all?.length ? 'You manage no Box in this workspace. Create one first, or ask an admin to make you a manager of one.' : 'This account has no Box yet — create one in the Rerun app first.')
    if (requested) {
        if (!spaces.some(space => space.id === requested)) throw new Error('Box not found')
        return requested
    }
    if (spaces.length > 1) throw new Error(`This account has several Boxes, pass spaceId: ${spaces.map(space => `${space.id} (${space.name ?? 'unnamed'})`).join(', ')}`)

    return spaces[0].id
}

// installServiceSlugs silently skips a slug the catalog doesn't know, which would otherwise
// read as "connector installed" to the caller. Fail on it instead, before touching the agent.
async function assertCatalogService(slug: string): Promise<void> {
    const supabase = createServiceRoleClient()
    const { data } = await selectMaybeSingle(supabase, 'services', ['enabled'] as const, { slug })
    if (!data?.enabled) throw new Error(`Unknown app "${slug}". Use search_connectors to find the right slug.`)
}

// `key` is what detach_connector and the app address one account by, `slug` the app it belongs to.
function connectorView({ key, slug, name, label, status }: InstalledService) {
    return { key, slug, name, label, status }
}

async function listWorkspaceAgents(workspaceId: number, spaceId?: string) {
    const supabase = createServiceRoleClient()
    const { data } = await selectMany(
        supabase,
        'agents',
        ['id', 'name', 'handle', 'description', 'status', 'space_id', 'created_at'] as const,
        spaceId ? { workspace_id: workspaceId, space_id: spaceId } : { workspace_id: workspaceId },
        { column: 'created_at', ascending: false },
    )
    return data ?? []
}

type MemoryEntry = { content: string; kind?: string; tags?: string[] }

function readMemoryEntries(value: unknown): MemoryEntry[] {
    if (!Array.isArray(value) || value.length === 0) throw new Error('memories must be a non-empty array of { content, kind?, tags? }.')
    if (value.length > MAX_MEMORIES_PER_CALL) throw new Error(`At most ${MAX_MEMORIES_PER_CALL} memories per call. Send the rest in another call.`)
    return value.map((entry, index) => {
        const content = typeof entry === 'object' && entry !== null ? (entry as { content?: unknown }).content : undefined
        if (typeof content !== 'string' || !content.trim()) throw new Error(`memories[${index}].content must be a non-empty string.`)
        if (content.length > MAX_MEMORY_CHARS) throw new Error(`memories[${index}] is over ${MAX_MEMORY_CHARS} characters. Split it into several memories.`)
        const { kind, tags } = entry as { kind?: unknown; tags?: unknown }
        return { content, ...(typeof kind === 'string' ? { kind } : {}), ...(Array.isArray(tags) ? { tags: tags.filter((tag): tag is string => typeof tag === 'string') } : {}) }
    })
}

// `actor` is whose access the call runs with: the workspace for an API key, the member a foreman
// turn speaks for. `actorUserId` is the member recorded as the author of what the call starts (an
// API key's creator, the foreman's member).
export async function dispatchAccountTool(actor: Actor, name: string, args: Record<string, unknown>, { actorUserId = null }: { actorUserId?: string | null } = {}): Promise<unknown> {
    const workspaceId = actor.workspaceId
    // Every tool that takes a `model` pins it, on a coworker, a scheduled task, a trigger or the
    // workspace default, so the plan is checked once for all of them.
    if (typeof args.model === 'string') await assertModelEntitled(args.model, workspaceId)
    switch (name) {
        case 'list_spaces': {
            const supabase = createServiceRoleClient()
            const [{ data: spaces }, agents, visible] = await Promise.all([selectMany(supabase, 'spaces', ['id', 'name', 'created_at'] as const, { workspace_id: workspaceId }), listWorkspaceAgents(workspaceId), spaceAccessMap(actor)])
            return {
                spaces: (spaces ?? []).filter(space => (visible.get(space.id) ?? 'none') !== 'none').map(space => ({
                    id: space.id,
                    name: space.name ?? 'Box',
                    agentCount: agents.filter(agent => agent.space_id === space.id).length,
                    createdAt: space.created_at,
                    access: visible.get(space.id),
                })),
            }
        }

        case 'list_agents': {
            const [agents, visible] = await Promise.all([listWorkspaceAgents(workspaceId, asString(args.spaceId)), visibleSpaceIds(actor)])
            return { agents: keepVisible(agents, visible, agent => agent.space_id) }
        }

        case 'get_team_status': {
            const [status, visible] = await Promise.all([readTeamStatus(workspaceId, { spaceId: asString(args.spaceId), agentId: asString(args.agentId) }), visibleAgentIds(actor)])
            return { ...status, agents: keepVisible(status.agents, visible, agent => agent.id) }
        }

        case 'get_agent': {
            const agentId = requireString(args.agentId, 'agentId')
            const { conn, engineAgentId, contentLocked } = await resolveAgentTarget(agentId, actor)
            // A part that cannot be read still answers empty, so one failing route does not hide the
            // rest of the agent, but it is named in `unavailable`: an empty list has to mean empty.
            const unavailable: string[] = []
            const unreadable = (part: string) => () => {
                unavailable.push(part)
                return []
            }
            const [detail, aiConnections, skills, schedules, triggers, connectors] = await Promise.all([
                engineGetAgent(conn, engineAgentId),
                engineListConnections(conn)
                    .then(list => list.connections)
                    .catch(unreadable('runsOn')),
                engineListSkills(conn, engineAgentId).catch(unreadable('skills')),
                engineListSchedules(conn, engineAgentId).catch(unreadable('schedules')),
                engineListTriggers(conn, engineAgentId).catch(unreadable('triggers')),
                listInstalledServices(agentId, actor)
                    .then(result => result.services)
                    .catch(unreadable('connectors')),
            ])

            return {
                id: agentId,
                handle: detail.config.name,
                name: detail.config.displayName ?? detail.config.name,
                description: detail.config.description,
                soul: contentLocked ? LOCKED_NOTICE : detail.soul,
                // The pair the box would actually run, not the pin: an agent that picked nothing
                // still has a provider and a model, they just come from the Box default.
                provider: detail.resolvedProvider ?? detail.config.provider,
                model: detail.resolvedModel ?? detail.config.model,
                runsOn: projectRunsOn(detail, aiConnections),
                verbosity: detail.config.verbosity,
                tools: detail.config.tools,
                selfImprovement: detail.config.selfImprovement,
                // `required: null` is an unanswered agent, which is what a template submission
                // blocks on, and is not the same statement as "this one needs nothing".
                setup: { required: detail.config.setup.required, completedAt: detail.config.setup.completedAt, prompt: detail.install },
                mcpServers: detail.config.mcpServers.map(server => ({ name: server.name, transport: server.transport, url: server.url })),
                skills: skills.map(skill => ({ slug: skill.slug, name: skill.name, description: skill.description })),
                schedules: schedules.map(schedule => ({ slug: schedule.slug, name: schedule.name, cron: schedule.cron, runAt: schedule.runAt, enabled: schedule.enabled })),
                // No URL here: it carries the trigger's secret, and this is the wide read. Use
                // list_triggers to get it deliberately.
                triggers: triggers.map(trigger => ({ slug: trigger.slug, name: trigger.name, methods: trigger.methods, enabled: trigger.enabled, lastFiredAt: trigger.lastFiredAt })),
                connectors: connectors.map(connectorView),
                ...(unavailable.length > 0 ? { unavailable } : {}),
            }
        }

        case 'create_agent': {
            const spaceId = await resolveSpaceId(actor, asString(args.spaceId))
            const slugs = Array.isArray(args.connectors) ? args.connectors.filter((slug): slug is string => typeof slug === 'string') : []
            await Promise.all(slugs.map(assertCatalogService))

            const setup = readSetup(args)
            const pin = await newAgentModelPin(workspaceId, args)
            const agent = await createAgent({
                name: requireString(args.name, 'name'),
                description: asString(args.description),
                soulMd: asString(args.soul),
                installMd: setup?.install,
                workspaceId,
                spaceId,
                actor,
                config: { ...readConfigPatch(args, pin), ...(setup ? { setup: setup.setup } : {}) },
            })

            if (slugs.length > 0) await installServiceSlugs(agent.id, slugs, actor)

            // The registry is the only honest answer: the checklist installServiceSlugs
            // returns holds the needs_config bucket alone, and would quietly drop a connector
            // that installed fine but still waits on a sign-in.
            const connectors = slugs.length > 0 ? (await listInstalledServices(agent.id, actor)).services : []

            return {
                agentId: agent.id,
                name: agent.name,
                handle: agent.handle,
                spaceId,
                // The plan caps active agents, so a creation can legitimately succeed and hand back
                // something that will not run until a slot frees up. Saying so is the only way the
                // caller can tell that apart from a working agent.
                active: !agent.disabled_at,
                ...(agent.disabled_at ? { inactiveReason: 'No free coworker slot on the current plan. Start Pro for unlimited coworkers, or delete a coworker to activate it.' } : {}),
                connectors: connectors.map(connectorView),
            }
        }

        case 'update_agent': {
            const agentId = requireString(args.agentId, 'agentId')
            const { conn, engineAgentId, contentLocked } = await resolveAgentTarget(agentId, actor, 'manage')
            const soul = typeof args.soul === 'string' ? args.soul : undefined
            if (contentLocked && soul !== undefined) throw new Error(LOCKED_WRITE_ERROR)

            // Checked before the rename and the move below: a refused pin must leave nothing done.
            const checked = await checkedModelPin(conn, engineAgentId, args)
            const patch: EngineAgentConfigPatch & { soul?: string; install?: string } = readConfigPatch(args, checked?.pin)
            const description = asString(args.description)
            const setup = readSetup(args)
            if (description !== undefined) patch.description = description
            if (soul !== undefined) patch.soul = soul
            if (setup) {
                patch.setup = setup.setup
                patch.install = setup.install
            }

            const newName = asString(args.name)
            const newHandle = asString(args.handle)
            const renamed = newName ? await renameAgent(agentId, newName) : null
            const rehandled = newHandle ? await changeAgentHandle(agentId, newHandle) : null

            // Resolved only when asked for: resolveSpaceId falls back to the single Box of an
            // account that has one, so calling it blind would move the agent on every update.
            const requestedSpaceId = asString(args.spaceId)
            const moved = requestedSpaceId ? await moveAgentToBox(agentId, await resolveSpaceId(actor, requestedSpaceId), actor) : null
            if (moved && !moved.ok) throw new Error(moved.error)

            let patched: EngineAgentDetail | null = null
            if (Object.keys(patch).length > 0) {
                patched = await enginePatchAgent(conn, engineAgentId, patch)
                if (description !== undefined) {
                    const supabase = createServiceRoleClient()
                    await supabase.from('agents').update<Database['public']['Tables']['agents']['Update']>({ description }).eq('id', agentId)
                }
            }

            const identity = rehandled ?? renamed
            const handleMoved = Boolean(rehandled) || Boolean(renamed?.handleChanged)
            const identityUpdated = [...(renamed ? ['name'] : []), ...(handleMoved ? ['handle'] : [])]
            return {
                agentId,
                updated: [...identityUpdated, ...Object.keys(patch), ...(moved ? ['spaceId'] : [])],
                ...(moved?.ok ? { spaceId: requestedSpaceId, position: moved.position } : {}),
                ...(identity ? { name: identity.name, handle: identity.handle } : {}),
                ...(patched && checked ? { runsOn: projectRunsOn(patched, checked.connections) } : {}),
            }
        }

        case 'list_ai_connections': {
            const { connections, default: workspaceDefault } = await engineListConnections(await getWorkspaceConnection(workspaceId))
            return {
                default: workspaceDefault ? { ...workspaceDefault, connectionName: connections.find(connection => connection.id === workspaceDefault.connectionId)?.name ?? null } : null,
                connections: connections.map(connection => ({
                    id: connection.id,
                    name: connection.name,
                    provider: connection.provider,
                    models: connectionModels(connection),
                    connected: connection.connected,
                    isDefault: workspaceDefault?.connectionId === connection.id,
                })),
            }
        }

        case 'set_default_model': {
            if (!isAdminActor(actor)) throw new AccessDeniedError('Only an admin can change the default model of the workspace.')
            const conn = await getWorkspaceConnection(workspaceId)
            const { connections } = await engineListConnections(conn)
            const pin = readModelPin({ connectionId: requireString(args.connectionId, 'connectionId'), model: requireString(args.model, 'model') }, connections)
            if (!pin?.connectionId || !pin.model) throw new Error('set_default_model needs a connectionId and a model.')
            await assertModelEntitled(pin.model, workspaceId)
            await engineSetBoxDefault(conn, { connectionId: pin.connectionId, model: pin.model })
            return { default: { connectionId: pin.connectionId, connectionName: connections.find(connection => connection.id === pin.connectionId)?.name ?? null, provider: pin.provider, model: pin.model } }
        }

        case 'delete_agent': {
            const agentId = requireString(args.agentId, 'agentId')
            requireConfirmation(args, 'the coworker, its skills, its scheduled tasks, its memory and its files')
            // Not resolveAgentTarget: it goes through the engine, and a coworker whose engine side is
            // broken must still be deletable.
            await assertAgentInWorkspace(agentId, 'manage', actor)
            await deleteAgent(agentId)
            return { agentId, deleted: true }
        }

        case 'list_skills': {
            const { conn, engineAgentId } = await resolveAgentTarget(requireString(args.agentId, 'agentId'), actor)
            const skills = await engineListSkills(conn, engineAgentId)
            const owners = connectorSkillOwners(await readRegistry(conn, engineAgentId))
            return {
                skills: skills.map(skill => {
                    const connector = owners.get(skill.slug)
                    return {
                        slug: skill.slug,
                        name: skill.name,
                        description: skill.description,
                        files: skill.files,
                        ...(connector ? { connector, readOnly: true } : {}),
                    }
                }),
            }
        }

        case 'get_skill': {
            const { conn, engineAgentId, contentLocked } = await resolveAgentTarget(requireString(args.agentId, 'agentId'), actor)
            const skill = await engineGetSkill(conn, engineAgentId, requireString(args.slug, 'slug'))
            const files = await describeSkillFiles(conn, engineAgentId, skill.slug, skill.files)
            const connector = connectorSkillOwners(await readRegistry(conn, engineAgentId)).get(skill.slug)
            const origin = connector ? { connector, readOnly: true } : {}
            // A program would act on filler as if it were the procedure, so this surface says what
            // happened rather than handing back the placeholder the panels blur.
            return contentLocked ? { ...skill, body: LOCKED_NOTICE, locked: true, files, ...origin } : { ...skill, files, ...origin }
        }

        case 'read_skill_file': {
            const { conn, engineAgentId, contentLocked } = await resolveAgentTarget(requireString(args.agentId, 'agentId'), actor)
            if (contentLocked) throw new Error(LOCKED_NOTICE)
            const slug = requireString(args.slug, 'slug')
            const offset = asNumber(args.offset)
            if (args.offset !== undefined && (offset === undefined || !Number.isInteger(offset) || offset < 0)) {
                throw new Error('offset must be a non-negative integer.')
            }
            return { slug, ...(await readSkillReferenceFile(conn, engineAgentId, slug, requireString(args.path, 'path'), offset ?? 0)) }
        }

        case 'upsert_skill': {
            const { conn, engineAgentId, contentLocked } = await resolveAgentTarget(requireString(args.agentId, 'agentId'), actor, 'manage')
            if (contentLocked) throw new Error(LOCKED_WRITE_ERROR)
            const files = asSkillFiles(args.files)
            // Both checks run before the write: a removal refused afterwards would fail the call
            // on a skill whose body had already been replaced.
            const removeFiles = planSkillFileRemovals(asStringArray(args.removeFiles))
            const written = new Set(files.map(file => normalizeSkillFilePath(file.path)))
            const contradiction = removeFiles.find(path => written.has(path))
            if (contradiction) throw new Error(`"${contradiction}" is in both files and removeFiles. Pick one.`)

            // The engine writes with overwrite: true, so a name that slugifies onto a connector
            // skill would replace it just as surely as passing its slug.
            const target = asString(args.slug) ?? slugify(requireString(args.name, 'name'))
            const owner = connectorSkillOwners(await readRegistry(conn, engineAgentId)).get(target)
            if (owner) throw new Error(connectorSkillReadOnlyError(target, owner))

            // One atomic call: the engine stages the whole folder and swaps it in, so a bad
            // reference file can no longer leave the body rewritten and the files missing.
            const skill = await engineImportSkill(conn, engineAgentId, toSkillMarkdown(requireString(args.body, 'body')), files, {
                name: requireString(args.name, 'name'),
                description: asString(args.description) ?? '',
                slug: asString(args.slug),
                overwrite: true,
            })

            // Deletions come after the swap: a failure here leaves a file behind, where deleting
            // first would lose it whenever the write that follows is rejected.
            if (removeFiles.length === 0) return { slug: skill.slug, name: skill.name, description: skill.description, files: skill.files }
            await removeSkillFiles(conn, engineAgentId, skill.slug, removeFiles)
            const updated = await engineGetSkill(conn, engineAgentId, skill.slug)
            return { slug: updated.slug, name: updated.name, description: updated.description, files: updated.files, removed: removeFiles }
        }

        case 'write_memory': {
            const { conn, engineAgentId, contentLocked } = await resolveAgentTarget(requireString(args.agentId, 'agentId'), actor, 'manage')
            if (contentLocked) throw new Error(LOCKED_WRITE_ERROR)
            const memories = readMemoryEntries(args.memories)
            const written: string[] = []
            const failed: { index: number; error: string }[] = []
            // One at a time: each write embeds through the hub, and a burst of a hundred would
            // queue there anyway while making a partial failure harder to report entry by entry.
            for (const [index, memory] of memories.entries()) {
                try {
                    const { id } = await engineCreateMemory(conn, engineAgentId, memory)
                    if (id) written.push(id)
                } catch (err) {
                    failed.push({ index, error: err instanceof Error ? err.message : 'Write failed' })
                }
            }
            return { written: written.length, ids: written, ...(failed.length > 0 ? { failed } : {}) }
        }

        case 'upload_workspace_file': {
            const { conn, engineAgentId, contentLocked } = await resolveAgentTarget(requireString(args.agentId, 'agentId'), actor, 'manage')
            if (contentLocked) throw new Error(LOCKED_WRITE_ERROR)
            const path = requireString(args.path, 'path').replace(/^\/+/, '')
            const content = typeof args.content === 'string' ? args.content : ''
            const base = agentFilesBase(engineAgentId)
            const isBase64 = args.encoding === 'base64'
            const bytes = Buffer.from(content, isBase64 ? 'base64' : 'utf8')
            if (bytes.byteLength > MAX_UPLOAD_MB * 1024 * 1024) throw new Error(`The file is over ${MAX_UPLOAD_MB} MB${isBase64 ? ' once decoded' : ''}.`)
            const slash = path.lastIndexOf('/')
            const name = path.slice(slash + 1)
            if (!name) throw new Error('path must name a file, e.g. "assets/logo.png".')
            // The JSON write caps its content at MAX_TEXT_WRITE_CHARS on the engine; a longer text
            // travels as bytes through the raw upload, the same door as a binary.
            if (!isBase64 && content.length <= MAX_TEXT_WRITE_CHARS) {
                await engineWriteFileText(conn, base, path, content)
            } else {
                await engineUploadFile(conn, base, new File([bytes], name), slash > 0 ? path.slice(0, slash) : '')
            }
            return { path, bytes: bytes.byteLength }
        }

        case 'delete_skill': {
            requireConfirmation(args, 'the skill and its reference files')
            const { conn, engineAgentId } = await resolveAgentTarget(requireString(args.agentId, 'agentId'), actor, 'manage')
            const slug = requireString(args.slug, 'slug')
            const owner = connectorSkillOwners(await readRegistry(conn, engineAgentId)).get(slug)
            if (owner) throw new Error(connectorSkillReadOnlyError(slug, owner))
            await engineDeleteSkill(conn, engineAgentId, slug)
            return { slug, deleted: true }
        }

        case 'list_schedules': {
            const { conn, engineAgentId, contentLocked } = await resolveAgentTarget(requireString(args.agentId, 'agentId'), actor)
            const schedules = await engineListSchedules(conn, engineAgentId)
            return { schedules: schedules.map(schedule => (contentLocked ? { ...schedule, body: LOCKED_NOTICE } : schedule)) }
        }

        case 'upsert_schedule': {
            const agentId = requireString(args.agentId, 'agentId')
            const { conn, engineAgentId, contentLocked } = await resolveAgentTarget(agentId, actor, 'manage')
            if (contentLocked && args.body !== undefined) throw new Error(LOCKED_WRITE_ERROR)
            const slug = asString(args.slug)
            const checked = await checkedModelPin(conn, engineAgentId, args)

            const shared = {
                ...checked?.pin,
                description: asString(args.description),
                body: typeof args.body === 'string' ? args.body : undefined,
                cron: asString(args.cron),
                runAt: asString(args.runAt),
                timezone: asString(args.timezone),
                enabled: typeof args.enabled === 'boolean' ? args.enabled : undefined,
            }

            if (slug) {
                return await engineUpdateSchedule(conn, engineAgentId, slug, shared)
            }

            const cron = shared.cron
            const runAt = shared.runAt
            if (!cron && !runAt) throw new Error('A new scheduled task needs either cron (recurring) or runAt (one-off)')

            const schedule = await engineCreateSchedule(conn, engineAgentId, {
                ...checked?.pin,
                name: requireString(args.name, 'name'),
                description: shared.description,
                body: requireString(args.body, 'body'),
                cron,
                runAt,
                timezone: shared.timezone,
                enabled: shared.enabled,
            })
            await followCoworker(actorUserId, agentId)
            return schedule
        }

        case 'run_schedule_now': {
            const { conn, engineAgentId } = await resolveAgentTarget(requireString(args.agentId, 'agentId'), actor)
            return await engineRunScheduleNow(conn, engineAgentId, requireString(args.slug, 'slug'))
        }

        case 'delete_schedule': {
            requireConfirmation(args, 'the scheduled task')
            const { conn, engineAgentId } = await resolveAgentTarget(requireString(args.agentId, 'agentId'), actor, 'manage')
            const slug = requireString(args.slug, 'slug')
            await engineDeleteSchedule(conn, engineAgentId, slug)
            return { slug, deleted: true }
        }

        case 'list_triggers': {
            const agentId = requireString(args.agentId, 'agentId')
            const { conn, engineAgentId, contentLocked } = await resolveAgentTarget(agentId, actor)
            const triggers = await engineListTriggers(conn, engineAgentId)
            return { triggers: await Promise.all(triggers.map(trigger => projectTrigger(agentId, contentLocked ? { ...trigger, body: LOCKED_NOTICE } : trigger))) }
        }

        case 'upsert_trigger': {
            const agentId = requireString(args.agentId, 'agentId')
            const { conn, engineAgentId, contentLocked } = await resolveAgentTarget(agentId, actor, 'manage')
            if (contentLocked && args.body !== undefined) throw new Error(LOCKED_WRITE_ERROR)
            const slug = asString(args.slug)
            const checked = await checkedModelPin(conn, engineAgentId, args)

            const shared = {
                ...checked?.pin,
                description: asString(args.description),
                body: typeof args.body === 'string' ? args.body : undefined,
                methods: asTriggerMethods(args.methods),
                enabled: typeof args.enabled === 'boolean' ? args.enabled : undefined,
            }

            if (slug) {
                return await projectTrigger(agentId, await engineUpdateTrigger(conn, engineAgentId, slug, shared))
            }

            const trigger = await engineCreateTrigger(conn, engineAgentId, {
                ...checked?.pin,
                name: requireString(args.name, 'name'),
                description: shared.description,
                body: requireString(args.body, 'body'),
                methods: shared.methods,
                enabled: shared.enabled,
            })
            await followCoworker(actorUserId, agentId)

            return await projectTrigger(agentId, trigger)
        }

        case 'test_trigger': {
            const agentId = requireString(args.agentId, 'agentId')
            const { conn, engineAgentId } = await resolveAgentTarget(agentId, actor)
            const slug = requireString(args.slug, 'slug')
            const trigger = await engineGetTrigger(conn, engineAgentId, slug)

            const requested = asString(args.method)
            const method = requested ? parseTriggerMethod(requested) : (trigger.methods[0] ?? 'POST')

            // Both of these would come back from the engine as a bare 404 or 405, which reads as
            // "the trigger you just created does not exist". Answer them before firing.
            if (!trigger.methods.includes(method)) throw new Error(`This trigger does not accept ${method}. It accepts: ${trigger.methods.join(', ')}.`)
            if (!trigger.enabled) throw new Error(`Trigger "${slug}" is disabled, and a disabled trigger turns every call away. Enable it with upsert_trigger before testing.`)

            const body = asTriggerBody(args.body)
            const bodyBytes = Buffer.byteLength(body, 'utf8')
            if (bodyBytes > MAX_TRIGGER_BODY_BYTES) throw new Error(`The payload is ${bodyBytes} bytes, over the ${MAX_TRIGGER_BODY_BYTES} the public webhook accepts.`)

            const outcome = await engineFireTrigger(conn, engineAgentId, slug, {
                token: trigger.token,
                method,
                query: asString(args.query) ?? '',
                contentType: asString(args.contentType) ?? defaultContentType(body),
                body,
                bodyBytes,
            })

            if (outcome.status === 405) throw new Error(`This trigger does not accept ${method}. It accepts: ${(outcome.allow ?? trigger.methods).join(', ')}.`)
            if (outcome.status !== 202 || !outcome.runId) throw new Error(`The engine turned the call away (${outcome.status}). A trigger disabled or deleted in the meantime answers exactly like a missing one.`)

            return { slug, method, runId: outcome.runId, sessionId: outcome.sessionId, note: 'The run started. Read the outcome with get_run.' }
        }

        case 'rotate_trigger_token': {
            const agentId = requireString(args.agentId, 'agentId')
            const { conn, engineAgentId } = await resolveAgentTarget(agentId, actor, 'manage')
            const trigger = await engineRotateTriggerToken(conn, engineAgentId, requireString(args.slug, 'slug'))
            return { ...(await projectTrigger(agentId, trigger)), note: 'The previous URL no longer fires. Update every service configured with it.' }
        }

        case 'delete_trigger': {
            requireConfirmation(args, 'the webhook trigger and its URL')
            const { conn, engineAgentId } = await resolveAgentTarget(requireString(args.agentId, 'agentId'), actor, 'manage')
            const slug = requireString(args.slug, 'slug')
            await engineDeleteTrigger(conn, engineAgentId, slug)
            return { slug, deleted: true }
        }

        case 'send_message': {
            const agentId = requireString(args.agentId, 'agentId')
            const [{ conn, engineAgentId }, callableAgentIds] = await Promise.all([resolveAgentTarget(agentId, actor), callableEngineAgentIds(actor)])
            const waitSeconds = clamp(asNumber(args.waitSeconds), DEFAULT_WAIT_SECONDS, MAX_WAIT_SECONDS)

            const res = await engineChat(conn, engineAgentId, { message: requireString(args.message, 'message'), sessionId: asString(args.sessionId), source: 'api', callableAgentIds })
            if (!res.ok) throw new Error(`The coworker could not be reached: ${res.status} ${await res.text().catch(() => '')}`.trim())

            const runId = res.headers.get('x-run-id')
            const sessionId = res.headers.get('x-session-id')
            // The engine buffers the run's stream on its side, so dropping the response here
            // reads as one subscriber leaving: the agent keeps working either way.
            await res.body?.cancel().catch(() => {})
            if (!runId) throw new Error('The engine accepted the message but did not return a run id.')
            // Same reason as the foreman's setup hand-over: /chat announces no session, so without
            // this the conversation never shows up in the agent's chat.
            if (sessionId) await recordSessionParticipant(await ensureSessionRow(agentId, sessionId, requireString(args.message, 'message'), { source: 'api', status: 'working' }), actorUserId)

            const run = await waitForRun(conn, engineAgentId, runId, waitSeconds)
            return {
                ...projectRun(run),
                sessionId: sessionId ?? run.sessionId,
                output: run.output ?? null,
                ...(run.status === 'running' ? { note: `Still working after ${waitSeconds}s. The run continues — read it later with get_run.` } : {}),
            }
        }

        case 'list_runs': {
            const { conn, engineAgentId } = await resolveAgentTarget(requireString(args.agentId, 'agentId'), actor)
            const runs = await engineListRuns(conn, engineAgentId, { limit: clamp(asNumber(args.limit), 20, 200) })
            return { runs: runs.map(projectRun) }
        }

        case 'get_run': {
            const { conn, engineAgentId } = await resolveAgentTarget(requireString(args.agentId, 'agentId'), actor)
            const runId = requireString(args.runId, 'runId')
            const run = await engineGetRun(conn, engineAgentId, runId)
            const toolCalls = args.includeToolCalls === true ? await engineGetRunTools(conn, engineAgentId, runId) : null

            return {
                ...projectRun(run),
                output: run.output ?? null,
                ...(toolCalls
                    ? {
                          // A run's own tool results are unbounded, and a run that itself read
                          // runs nests them. Handed back whole they cost more context than the
                          // run they describe.
                          toolCalls: toolCalls.map(call => ({
                              step: call.stepNumber,
                              tool: call.toolName,
                              input: truncateField(call.inputJson),
                              result: truncateField(call.resultJson),
                              isError: call.isError === 1,
                              durationMs: call.durationMs,
                          })),
                      }
                    : {}),
            }
        }

        case 'list_tables': {
            const { conn, engineAgentId } = await resolveAgentTarget(requireString(args.agentId, 'agentId'), actor)
            return { tables: await engineListDbTables(conn, agentDataBase(engineAgentId)) }
        }

        case 'db_query': {
            const { conn, engineAgentId } = await resolveAgentTarget(requireString(args.agentId, 'agentId'), actor)
            return await engineQueryDb(conn, agentDataBase(engineAgentId), {
                sql: requireString(args.sql, 'sql'),
                params: asSqlParams(args.params),
                limit: clamp(asNumber(args.limit), 100, 1000),
            })
        }

        case 'db_execute': {
            const { conn, engineAgentId } = await resolveAgentTarget(requireString(args.agentId, 'agentId'), actor, 'manage')
            const statements = asSqlStatements(args.statements)
            const sql = asString(args.sql)
            if (!statements && !sql) throw new Error('Provide either sql (one statement) or statements (several, applied atomically).')
            return await engineExecuteDb(conn, agentDataBase(engineAgentId), { sql, params: asSqlParams(args.params), statements })
        }

        case 'list_space_tables': {
            const { conn } = await resolveSpaceTarget(requireString(args.spaceId, 'spaceId'), workspaceId)
            return { tables: await engineListDbTables(conn, SPACE_DATA_BASE) }
        }

        case 'space_db_query': {
            const { conn } = await resolveSpaceTarget(requireString(args.spaceId, 'spaceId'), workspaceId)
            return await engineQueryDb(conn, SPACE_DATA_BASE, {
                sql: requireString(args.sql, 'sql'),
                params: asSqlParams(args.params),
                limit: clamp(asNumber(args.limit), 100, 1000),
            })
        }

        case 'space_db_execute': {
            const { conn } = await resolveSpaceTarget(requireString(args.spaceId, 'spaceId'), workspaceId)
            const statements = asSqlStatements(args.statements)
            const sql = asString(args.sql)
            if (!statements && !sql) throw new Error('Provide either sql (one statement) or statements (several, applied atomically).')
            return await engineExecuteDb(conn, SPACE_DATA_BASE, { sql, params: asSqlParams(args.params), statements })
        }

        case 'search_connectors': {
            const results = await searchCatalogServices(asString(args.query), asString(args.category))
            return { connectors: results.map(({ slug, name, category, summary, setup, setupReason }) => ({ slug, name, category, summary, setup, setupReason })) }
        }

        case 'list_connectors': {
            const limit = clamp(asNumber(args.limit), 60, 200)
            const offset = Math.max(Math.trunc(asNumber(args.offset) ?? 0), 0)
            const category = asString(args.category)

            const supabase = createServiceRoleClient()
            const [results, { data: total }] = await Promise.all([
                listCatalogServices({ category, limit, offset }),
                selectCount(supabase, 'services', category ? { enabled: true, category } : { enabled: true }),
            ])

            return {
                total: total ?? 0,
                offset,
                connectors: results.map(({ slug, name, category: serviceCategory, summary, setup }) => ({ slug, name, category: serviceCategory, summary, setup })),
            }
        }

        case 'list_agent_connectors': {
            const agentId = requireString(args.agentId, 'agentId')
            const { services } = await listInstalledServices(agentId, actor)
            return { connectors: services.map(service => ({ ...connectorView(service), toolNames: service.toolNames })) }
        }

        case 'attach_connector': {
            const agentId = requireString(args.agentId, 'agentId')
            const slug = requireString(args.slug, 'slug')
            const [, manifest] = await Promise.all([resolveAgentTarget(agentId, actor, 'manage'), loadManifest(slug)])
            if (!manifest || manifest.slug !== slug) throw new Error(`Unknown app "${slug}". Use search_connectors to find the right slug.`)

            const instance = args.newInstance === true && manifest.multiInstance ? await allocateServiceInstance(agentId, manifest, actor) : undefined
            const key = instance?.key ?? manifest.slug
            const declared = await declareService(agentId, manifest, actor, instance)

            // The registry is the truth: a credential-free service still lands on needs_auth
            // when its single method is an OAuth sign-in.
            const { services } = await listInstalledServices(agentId, actor)
            const installed = services.find(service => service.key === key)
            const status = installed?.status ?? 'needs_config'
            const name = installed?.name ?? manifest.name
            const label = installed?.label ?? instance?.label

            return {
                key,
                slug,
                name,
                ...(label ? { label } : {}),
                status,
                ...(declared === 'needs_config' ? { authMethods: toAuthMethodSummaries(manifest).map(method => ({ id: method.id, label: method.label, kind: method.kind, requiresSecrets: method.requiresSecrets })) } : {}),
                message:
                    status === 'active'
                        ? `${name} is installed and its tools are available to the coworker.`
                        : `${name} is declared on the coworker and waiting for the account owner to connect it from the Rerun app (coworker panel, Services tab). Do not ask anyone for credentials here.`,
            }
        }

        case 'detach_connector': {
            requireConfirmation(args, 'the app, its tools and its credentials')
            const agentId = requireString(args.agentId, 'agentId')
            const key = asString(args.key) ?? asString(args.slug)
            if (!key) throw new Error('Pass key (from list_agent_connectors) or slug.')
            await uninstallService(agentId, key, actor)
            return { key, detached: true }
        }

        default:
            // Two more halves live next door, chained in that order: sharing, which any account
            // can use, then template authoring, which resolves an expert sandbox author before it
            // runs anything. The ungated one has to come first so an unknown name does not pay a
            // gate it was never aiming at. The last default is the one that answers for a name no
            // file knows.
            return await dispatchShareTool(actor, name, args)
    }
}
