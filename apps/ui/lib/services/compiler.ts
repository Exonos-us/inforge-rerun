import type { Actor } from '@/app/api/_auth/access'
import { resolveAgentTarget } from '@/app/api/_services/chat.service'
import { createSkill, deleteMcpToken, deleteSkill, listSkills, patchMcpServers, updateAgentKeys, updateSkill } from '@/lib/engine/client'
import type { EngineConnection, EngineMcpServer } from '@/lib/engine/types'
import type { InputDef, McpServerTemplate, ServiceManifest, ServiceSkill } from './manifest'
import { deleteConnectedAccount } from '@/lib/composio/client'
import { defaultInstanceEnvVar, instanceEnvVar, instanceServerName, ordinalInstanceLabel } from './instances'
import { appTarget, composioTarget, getMethod, managedTarget, oauthServer } from './manifest'
import { type RegistryEntry, readRegistry, registryFootprint, upsertRegistryEntry } from './registry'

// Substitution context shared by every template string in a compile pass. Non-secret
// inputs are inlined; secret inputs are NOT — their value goes to the engine .env and
// the compiled config keeps only a ${VAR} reference, resolved engine-side at connect time.
type SubstituteContext = {
    values: Record<string, string>
    inputMap: Map<string, InputDef>
    varNameFor: (inputKey: string) => string
    referencedSecrets: Set<string>
    derivedSecrets: Record<string, string>
    engineAgentId: string
}

// `${basic:input.A:input.B}` becomes HTTP Basic credentials, base64("A:B"). The engine only
// resolves plain ${VAR} references, so the encoding happens here and lands in its own secret.
const BASIC_PLACEHOLDER = /\$\{basic:input\.([A-Za-z0-9_]+):input\.([A-Za-z0-9_]+)\}/g

function substituteBasic(value: string, ctx: SubstituteContext): string {
    return value.replace(BASIC_PLACEHOLDER, (_, userKey: string, passwordKey: string) => {
        const user = ctx.values[userKey]
        const password = ctx.values[passwordKey]
        if (!user || !password) return ''
        const varName = ctx.varNameFor(`${userKey}_${passwordKey}_BASIC`)
        ctx.derivedSecrets[varName] = Buffer.from(`${user}:${password}`).toString('base64')
        return `\${${varName}}`
    })
}

// ${agent.id} is resolved here (the engine's ${VAR} resolver can't — it disallows the dot),
// so a managed proxy server can carry the agent id in a header. ${RERUN_API_KEY} /
// ${RERUN_HUB_BASE_URL} are left intact for the engine to resolve from its own env.
function substitute(value: string, ctx: SubstituteContext): string {
    return substituteBasic(value, ctx).replaceAll('${agent.id}', ctx.engineAgentId).replace(/\$\{input\.([A-Za-z0-9_]+)\}/g, (_, key) => {
        if (ctx.inputMap.get(key)?.secret) {
            ctx.referencedSecrets.add(key)
            return `\${${ctx.varNameFor(key)}}`
        }
        return ctx.values[key] ?? ''
    })
}

function substituteRecord(rec: Record<string, string>, ctx: SubstituteContext): Record<string, string> {
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(rec)) out[k] = substitute(v, ctx)
    return out
}

// Turn an mcpServer template into a concrete engine server config. Secret values are kept
// out of config.json (only ${VAR} refs remain) — never in Supabase, never in cleartext.
function compileMcpServer(tpl: McpServerTemplate, ctx: SubstituteContext, name: string): EngineMcpServer {
    return {
        name,
        transport: tpl.transport,
        command: tpl.command ? substitute(tpl.command, ctx) : undefined,
        args: tpl.args.map(a => substitute(a, ctx)),
        url: tpl.url ? substitute(tpl.url, ctx) : undefined,
        env: substituteRecord(tpl.env, ctx),
        headers: substituteRecord(tpl.headers, ctx),
    }
}

// Create the skill, or update it in place if a skill with the same name already exists
// (re-install must be idempotent). Returns the engine slug so uninstall can delete it.
async function upsertSkill(conn: EngineConnection, engineAgentId: string, skill: ServiceSkill): Promise<string | null> {
    try {
        const created = await createSkill(conn, engineAgentId, { name: skill.name, description: skill.description, body: skill.body })
        return created.slug
    } catch {
        const existing = await listSkills(conn, engineAgentId).catch(() => [])
        const match = existing.find(s => s.name === skill.name)
        if (match) {
            await updateSkill(conn, engineAgentId, match.slug, { description: skill.description, body: skill.body })
            return match.slug
        }
        return null
    }
}

export type CompileResult = {
    toolNames: string[]
    oauth: { serverName: string; url: string } | null
    managed: { provider: string; serverName: string } | null
    composio: { toolkit: string; serverName: string } | null
    app: { appSlug: string; serverName: string } | null
}

// An extra account of an app: its registry key (`gmail@k3x9ab`) and the id that suffixes its
// server names and env vars, so it never overwrites the base account's.
export type ServiceInstanceTarget = { key: string; instanceId: string }

// A workspace-level (Global apps) connection the compile binds the coworker to. The entry lands
// active at once: a key method's secrets came in `values`, and a composio method routes by the
// `x-rerun-global` header instead of a per-coworker sign-in.
export type GlobalBindTarget = { connectionId: string; label?: string }

// Compile a service into engine primitives, using the selected auth method (falls back to
// the default). Assumes all REQUIRED inputs of that method are present in `values` (the
// caller — installService — guards this). Idempotent: safe to re-run.
export async function compileService(
    agentId: string,
    manifest: ServiceManifest,
    values: Record<string, string>,
    authMethodId?: string,
    actor?: Actor,
    instance?: ServiceInstanceTarget,
    global?: GlobalBindTarget,
): Promise<CompileResult> {
    const { conn, engineAgentId } = await resolveAgentTarget(agentId, actor, 'manage')
    const method = getMethod(manifest, authMethodId)
    const instanceId = instance?.instanceId

    const inputMap = new Map(method.inputs.map(i => [i.key, i]))
    const envKeyByInput = new Map(method.envKeys.map(m => [m.fromInput, m.key]))
    const explicitVar = (key: string) => (instanceId ? instanceEnvVar(key, instanceId) : key)
    const varNameFor = (inputKey: string) => {
        const explicit = envKeyByInput.get(inputKey)
        return explicit ? explicitVar(explicit) : defaultInstanceEnvVar(manifest.slug, instanceId, inputKey)
    }
    const ctx: SubstituteContext = { values, inputMap, varNameFor, referencedSecrets: new Set(), derivedSecrets: {}, engineAgentId }
    const serverNameFor = (templateName: string) => (instanceId ? instanceServerName(templateName, instanceId) : templateName)

    // Compile first so `referencedSecrets` is populated before we assemble the .env set.
    const compiled = method.mcpServers.map(t => {
        // An OAuth server bound to a workspace account never signs in on the engine: its calls go
        // through the hub proxy, which injects (and refreshes) the shared token. The literal
        // ${RERUN_HUB_BASE_URL} is the one placeholder the engine resolves from its own env.
        if (global && t.oauth) {
            return { name: serverNameFor(t.name), transport: 'http' as const, args: [], url: `\${RERUN_HUB_BASE_URL}/api/mcp/global/${global.connectionId}`, env: {}, headers: {} }
        }
        const server = compileMcpServer(t, ctx, serverNameFor(t.name))
        // The Composio proxy derives the instance's own Composio user from this header.
        if (instanceId && method.kind === 'composio') server.headers = { ...server.headers, 'x-rerun-instance': instanceId }
        // A global binding routes the proxy to the workspace connection's Composio user instead.
        if (global && method.kind === 'composio') server.headers = { ...server.headers, 'x-rerun-global': global.connectionId }
        return server
    })
    const compiledSkills = manifest.skills.map(s => ({ ...s, body: substitute(s.body, ctx) }))

    // 1. Secrets → engine .env (never Supabase, never cleartext in config.json). Union of
    //    the method's explicit envKeys, any secret input referenced by an mcp template, and
    //    the Basic credentials derived from them.
    const envSet: Record<string, string> = {}
    for (const mapping of method.envKeys) {
        const v = values[mapping.fromInput]
        if (v !== undefined) envSet[explicitVar(mapping.key)] = v
    }
    for (const inputKey of ctx.referencedSecrets) {
        const v = values[inputKey]
        if (v !== undefined && v !== '') envSet[varNameFor(inputKey)] = v
    }
    Object.assign(envSet, ctx.derivedSecrets)
    if (Object.keys(envSet).length > 0) {
        await updateAgentKeys(conn, engineAgentId, { set: envSet })
    }

    // 2. MCP servers → engine merges by name atomically (never send the whole array).
    if (compiled.length > 0) {
        await patchMcpServers(conn, engineAgentId, { upsert: compiled })
    }

    // 3. Behavioural instructions → skills (shared across methods; collect slugs for clean uninstall).
    const skillSlugs: string[] = []
    for (const skill of compiledSkills) {
        const slug = await upsertSkill(conn, engineAgentId, skill)
        if (slug) skillSlugs.push(slug)
    }

    // 4. Record installed-state in the agent's OWN registry on the engine (LAST — if it
    //    fails the agent still has working tools). Only non-secret config is stored,
    //    plus the footprint (mcpServers/envKeys/skills) so uninstall can reverse it.
    const nonSecretConfig: Record<string, string> = {}
    for (const input of method.inputs) {
        if (!input.secret && values[input.key] !== undefined) nonSecretConfig[input.key] = values[input.key]
    }
    const mcpServerNames = compiled.map(s => s.name)

    // An OAuth / managed service is only usable once the user signs in — the sign-in writes
    // the token to the engine token store and the connect action flips this to 'active'. A
    // global binding has no per-coworker sign-in at all: the workspace account already did.
    const authServer = global ? undefined : oauthServer(method)
    const oauth = authServer ? { serverName: serverNameFor(authServer.name), url: substitute(authServer.url ?? '', ctx) } : null
    const renamed = <T extends { serverName: string }>(target: T | null): T | null => (target ? { ...target, serverName: serverNameFor(target.serverName) } : null)
    const managed = renamed(managedTarget(method))
    const composio = renamed(composioTarget(method))
    const app = renamed(appTarget(method))

    const registryKey = instance?.key ?? manifest.slug
    // A recompile of an existing account keeps the label it already has (an email, or its ordinal).
    const instanceFields = instance ? await instanceRegistryFields(conn, engineAgentId, manifest, instance) : {}

    await upsertRegistryEntry(conn, engineAgentId, registryKey, {
        // A global binding is usable at once: its sign-in happened at the workspace level.
        status: global || !(oauth || managed || composio || app) ? 'active' : 'needs_auth',
        config: nonSecretConfig,
        authMethodId: method.id,
        mcpServers: mcpServerNames,
        envKeys: Object.keys(envSet),
        skills: skillSlugs,
        ...(oauth ? { oauth } : {}),
        ...(managed ? { managed } : {}),
        ...(composio ? { composio } : {}),
        ...(app ? { app } : {}),
        ...instanceFields,
        ...(global ? { global, ...(global.label ? { label: global.label } : {}) } : {}),
        installedAt: new Date().toISOString(),
    })

    return { toolNames: mcpServerNames, oauth, managed, composio, app }
}

async function instanceRegistryFields(conn: EngineConnection, engineAgentId: string, manifest: ServiceManifest, instance: ServiceInstanceTarget): Promise<Pick<RegistryEntry, 'instanceId' | 'label'>> {
    const reg = await readRegistry(conn, engineAgentId)
    const label = reg.services[instance.key]?.label ?? ordinalInstanceLabel(manifest.name, reg, manifest.slug)
    return { instanceId: instance.instanceId, label }
}

// Reverse of compileService: strip exactly what the install added (recorded in the
// registry entry), preserving the Hub and every other installed service.
// `keepSkills` lists the skills another account of the same app still relies on.
export async function decompileService(conn: EngineConnection, engineAgentId: string, entry: RegistryEntry, opts?: { keepSkills?: Set<string> }): Promise<void> {
    const { envKeys, mcpServers, skills } = registryFootprint(entry)

    // 1. Remove the engine .env keys this service set.
    if (envKeys.length > 0) {
        await updateAgentKeys(conn, engineAgentId, { remove: envKeys })
    }

    // 2. Remove the service's MCP servers (engine removes by name — keeps rerun_hub + others).
    if (mcpServers.length > 0) {
        await patchMcpServers(conn, engineAgentId, { remove: mcpServers })
    }

    // 3. Delete the skills this service created (ignore if already gone).
    for (const slug of skills) {
        if (opts?.keepSkills?.has(slug)) continue
        await deleteSkill(conn, engineAgentId, slug).catch(() => {})
    }

    // 4. Clear the OAuth token from the engine token store, for an OAuth or managed service.
    const tokenServer = entry.oauth?.serverName ?? entry.managed?.serverName
    if (tokenServer) {
        await deleteMcpToken(conn, engineAgentId, tokenServer).catch(() => {})
    }

    // 5. A Composio service has no engine token: revoking means deleting the connected
    //    account at Composio. Best-effort — the engine teardown above must not be undone by
    //    a Composio outage; a residual account is removable from the Composio dashboard.
    if (entry.composio?.connectedAccountId) {
        await deleteConnectedAccount(entry.composio.connectedAccountId).catch(err => {
            console.warn(`[composio] could not delete connected account ${entry.composio?.connectedAccountId}:`, err instanceof Error ? err.message : err)
        })
    }
}
