import { workspaceActor, type Actor } from '@/app/api/_auth/access'
import { resolveAgentTarget } from '@/app/api/_services/chat.service'
import { allocateServiceInstance, loadManifest, toAuthMethodSummaries } from '@/app/api/_services/services.service'
import { deleteConnectedAccount } from '@/lib/composio/client'
import { compileService, decompileService, type ServiceInstanceTarget } from '@/lib/services/compiler'
import { hubClientSecret } from '@/lib/mcp-oauth'
import { fetchPublic } from '@/lib/net/public-fetch'
import { getMethod, missingRequiredInputs, oauthServer, serviceManifestSchema, type AuthMethod, type ServiceManifest } from '@/lib/services/manifest'
import { entriesOfSlug, readRegistry, removeRegistryEntry, sharedSkillSlugs, upsertRegistryEntry } from '@/lib/services/registry'
import type { AuthMethodSummary, GlobalAppConnection, GlobalAppKind, GlobalAppOption, GlobalAppStatus, ShareableService } from '@/lib/services/types'
import type { Database } from '@/app/api/database.types'
import { createServiceRoleClient } from '@/supabase/serviceRole'
import { selectMany, selectMaybeSingle, selectSingle } from '@/supabase/supabase-helpers'

// Global apps: one catalog account connected for the whole workspace, enabled per coworker with
// no second sign-in. Two kinds can share today:
//   - 'key': the credential lives on the connection row (server-side only, like a Slack bot
//     token) and enabling a coworker compiles it onto its engine exactly like a personal install.
//   - 'composio': Composio holds the token under a per-connection user id; the coworker's proxy
//     calls carry `x-rerun-global: <connectionId>` and never a credential.
// OAuth-direct, managed and stdio methods resolve their token on the coworker's own engine, so
// they stay per coworker until a box-level store exists; the picker says so instead of hiding.

type ConnectionUpdate = Database['public']['Tables']['global_app_connections']['Update']
type GlobalConnectionRow = {
    id: string
    workspace_id: number
    service_slug: string
    label: string
    auth_method_id: string
    kind: string
    config: unknown
    secrets: unknown
    composio_account_id: string | null
    composio_account_label: string | null
    oauth: unknown
    status: string
    created_at: string
}

const CONNECTION_COLUMNS = ['id', 'workspace_id', 'service_slug', 'label', 'auth_method_id', 'kind', 'config', 'secrets', 'composio_account_id', 'composio_account_label', 'oauth', 'status', 'created_at'] as const

function stringRecord(value: unknown): Record<string, string> {
    if (!value || typeof value !== 'object') return {}
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) if (typeof v === 'string') out[k] = v
    return out
}

// Whether a pasted credential carries this method: covers stdio servers too — the process runs on
// each coworker's engine, but the credential it reads is one value the workspace can hold.
function isPastedMethod(method: AuthMethod): boolean {
    return (method.kind === 'key' || method.kind === 'stdio') && method.inputs.length > 0
}

// A method the workspace can hold: a pasted credential, a browser sign-in whose token the hub
// proxy can carry, or a Composio-brokered sign-in whose auth config is set up on this install.
function isShareableMethod(method: AuthMethod): boolean {
    if (isPastedMethod(method)) return true
    if (method.kind === 'oauth') return Boolean(oauthServer(method)?.url)
    if (method.kind === 'composio') return Boolean(method.composio?.authConfigId)
    return false
}

export function shareableMethods(manifest: ServiceManifest): AuthMethod[] {
    return manifest.authMethods.filter(isShareableMethod)
}

// Why a service cannot be shared, worded for the picker row.
function shareableReason(manifest: ServiceManifest): string {
    const kinds = new Set(manifest.authMethods.map(m => m.kind))
    if (kinds.has('app')) return 'A paid app: its accounts have a page of their own.'
    if (kinds.has('managed')) return 'Signs in per coworker for now.'
    return 'Needs no account at all.'
}

export async function listShareableCatalog(): Promise<ShareableService[]> {
    const supabase = createServiceRoleClient()
    const { data } = await selectMany(supabase, 'services', ['slug', 'name', 'category', 'summary', 'icon', 'manifest'] as const, { enabled: true }, { column: 'name' })
    return (data ?? []).flatMap(row => {
        const parsed = serviceManifestSchema.safeParse(row.manifest)
        if (!parsed.success) return []
        const shareable = shareableMethods(parsed.data).length > 0
        return [
            {
                slug: row.slug,
                name: row.name,
                category: row.category,
                summary: row.summary,
                icon: row.icon,
                shareable,
                ...(shareable ? {} : { shareableReason: shareableReason(parsed.data) }),
            },
        ]
    })
}

export type ShareableServiceDetails = {
    slug: string
    name: string
    summary: string
    icon: string | null
    category: string
    methods: AuthMethodSummary[]
}

// The connect form's view of one service: only the methods the workspace can hold.
export async function getShareableService(slug: string): Promise<ShareableServiceDetails> {
    const manifest = await loadManifest(slug)
    if (!manifest) throw new Error(`Service not found: ${slug}`)
    const shareableIds = new Set(shareableMethods(manifest).map(m => m.id))
    const methods = toAuthMethodSummaries(manifest).filter(m => shareableIds.has(m.id))
    if (methods.length === 0) throw new Error(`${manifest.name} cannot be connected for the workspace yet: it signs in per coworker.`)
    const supabase = createServiceRoleClient()
    const { data } = await selectSingle(supabase, 'services', ['icon'] as const, { slug: manifest.slug })
    return { slug: manifest.slug, name: manifest.name, summary: manifest.summary, icon: data?.icon ?? null, category: manifest.category, methods }
}

function toView(row: GlobalConnectionRow, meta: Map<string, { name: string; icon: string | null; category: string }>, agentIds: string[]): GlobalAppConnection {
    const cat = meta.get(row.service_slug)
    return {
        id: row.id,
        slug: row.service_slug,
        name: cat?.name ?? row.service_slug,
        icon: cat?.icon ?? null,
        category: cat?.category ?? 'other',
        label: row.label,
        kind: row.kind as GlobalAppKind,
        status: row.status as GlobalAppStatus,
        authMethodId: row.auth_method_id,
        ...(row.composio_account_label ? { accountLabel: row.composio_account_label } : {}),
        createdAt: row.created_at,
        agentIds,
    }
}

export async function listGlobalApps(workspaceId: number): Promise<GlobalAppConnection[]> {
    const supabase = createServiceRoleClient()
    const { data: rows } = await selectMany(supabase, 'global_app_connections', CONNECTION_COLUMNS, { workspace_id: workspaceId }, { column: 'created_at' })
    if (!rows?.length) return []
    const { data: bindings } = await selectMany(supabase, 'global_app_agents', ['connection_id', 'agent_id'] as const, { connection_id: rows.map(r => r.id) })
    const agentsByConnection = new Map<string, string[]>()
    for (const b of bindings ?? []) {
        const list = agentsByConnection.get(b.connection_id) ?? []
        list.push(b.agent_id)
        agentsByConnection.set(b.connection_id, list)
    }
    const { data: services } = await selectMany(supabase, 'services', ['slug', 'name', 'icon', 'category'] as const, { slug: [...new Set(rows.map(r => r.service_slug))] })
    const meta = new Map((services ?? []).map(s => [s.slug, { name: s.name, icon: s.icon, category: s.category }]))
    return rows.map(row => toView(row as GlobalConnectionRow, meta, agentsByConnection.get(row.id) ?? []))
}

// The workspace accounts of one app, offered while installing it on a coworker.
export async function listGlobalOptionsForSlug(workspaceId: number, slug: string): Promise<GlobalAppOption[]> {
    const supabase = createServiceRoleClient()
    const { data: rows } = await selectMany(supabase, 'global_app_connections', ['id', 'label', 'status'] as const, { workspace_id: workspaceId, service_slug: slug }, { column: 'created_at' })
    if (!rows?.length) return []
    const { data: bindings } = await selectMany(supabase, 'global_app_agents', ['connection_id'] as const, { connection_id: rows.map(r => r.id) })
    const counts = new Map<string, number>()
    for (const b of bindings ?? []) counts.set(b.connection_id, (counts.get(b.connection_id) ?? 0) + 1)
    return rows.map(row => ({ id: row.id, label: row.label, status: row.status as GlobalAppStatus, usedBy: counts.get(row.id) ?? 0 }))
}

async function requireConnection(workspaceId: number, connectionId: string): Promise<GlobalConnectionRow> {
    const supabase = createServiceRoleClient()
    const { data } = await selectMaybeSingle(supabase, 'global_app_connections', CONNECTION_COLUMNS, { id: connectionId, workspace_id: workspaceId })
    if (!data) throw new Error('This workspace account no longer exists.')
    return data as GlobalConnectionRow
}

// Split the submitted values into what the UI may read back (non-secret) and what stays
// server-side, by the method's own input definitions.
function splitValues(method: AuthMethod, values: Record<string, string>): { config: Record<string, string>; secrets: Record<string, string> } {
    const config: Record<string, string> = {}
    const secrets: Record<string, string> = {}
    for (const input of method.inputs) {
        const value = values[input.key]
        if (value === undefined || value === '') continue
        if (input.secret) secrets[input.key] = value
        else config[input.key] = value
    }
    return { config, secrets }
}

export async function createGlobalKeyConnection(params: { workspaceId: number; userId: string; slug: string; authMethodId: string; label: string; values: Record<string, string> }): Promise<{ id: string }> {
    const manifest = await loadManifest(params.slug)
    if (!manifest) throw new Error(`Service not found: ${params.slug}`)
    const method = getMethod(manifest, params.authMethodId)
    if (!isPastedMethod(method)) throw new Error('This method cannot be held by the workspace.')
    const missing = missingRequiredInputs(method, params.values)
    if (missing.length > 0) throw new Error(`Missing: ${missing.map(i => i.label || i.key).join(', ')}`)

    const { config, secrets } = splitValues(method, params.values)
    const supabase = createServiceRoleClient()
    const { data, error } = await supabase
        .from('global_app_connections')
        .insert<Database['public']['Tables']['global_app_connections']['Insert']>({
            workspace_id: params.workspaceId,
            service_slug: manifest.slug,
            label: params.label,
            auth_method_id: method.id,
            kind: 'key',
            config,
            secrets,
            status: 'connected',
            connected_by: params.userId,
        })
        .select('id')
        .single()
    if (error || !data) throw new Error(error?.message ?? 'Could not save the connection')
    return { id: data.id }
}

// The row exists before the Composio popup opens, so the callback has something to finish and an
// abandoned sign-in shows as "Connecting" with a resume instead of vanishing.
export async function createGlobalComposioConnection(params: { workspaceId: number; userId: string; slug: string; label: string }): Promise<{ id: string }> {
    const manifest = await loadManifest(params.slug)
    if (!manifest) throw new Error(`Service not found: ${params.slug}`)
    const method = shareableMethods(manifest).find(m => m.kind === 'composio')
    if (!method) throw new Error(`${manifest.name} has no Composio connection to set up.`)

    const supabase = createServiceRoleClient()
    const { data, error } = await supabase
        .from('global_app_connections')
        .insert<Database['public']['Tables']['global_app_connections']['Insert']>({
            workspace_id: params.workspaceId,
            service_slug: manifest.slug,
            label: params.label,
            auth_method_id: method.id,
            kind: 'composio',
            status: 'connecting',
            connected_by: params.userId,
        })
        .select('id')
        .single()
    if (error || !data) throw new Error(error?.message ?? 'Could not save the connection')
    return { id: data.id }
}

// The token bundle of an 'oauth' connection, the /api/mcp/global proxy's working set. Mirrors the
// engine token store's bundle, plus the MCP url the proxy forwards to.
export type GlobalOauthBundle = {
    accessToken: string
    refreshToken?: string
    expiresAt?: number
    scope?: string
    tokenEndpoint: string
    clientId: string
    clientSecret?: string
    mcpUrl: string
    obtainedAt: number
}

function oauthBundleOf(row: { oauth: unknown }): GlobalOauthBundle | null {
    const bundle = row.oauth as GlobalOauthBundle | null
    if (!bundle || typeof bundle !== 'object' || !bundle.accessToken || !bundle.mcpUrl) return null
    return bundle
}

// `${input.X}` in an OAuth server template is always a non-secret value (a region, a host), so the
// connection's stored config is all it takes to resolve the real MCP url.
function substituteConfig(value: string, config: Record<string, string>): string {
    return value.replace(/\$\{input\.([A-Za-z0-9_]+)\}/g, (_, key: string) => config[key] ?? '')
}

export async function createGlobalOauthConnection(params: { workspaceId: number; userId: string; slug: string; label: string; values: Record<string, string> }): Promise<{ id: string }> {
    const manifest = await loadManifest(params.slug)
    if (!manifest) throw new Error(`Service not found: ${params.slug}`)
    const method = shareableMethods(manifest).find(m => m.kind === 'oauth')
    if (!method) throw new Error(`${manifest.name} has no sign-in the workspace can hold.`)
    const { config } = splitValues(method, params.values)

    const supabase = createServiceRoleClient()
    const { data, error } = await supabase
        .from('global_app_connections')
        .insert<Database['public']['Tables']['global_app_connections']['Insert']>({
            workspace_id: params.workspaceId,
            service_slug: manifest.slug,
            label: params.label,
            auth_method_id: method.id,
            kind: 'oauth',
            config,
            status: 'connecting',
            connected_by: params.userId,
        })
        .select('id')
        .single()
    if (error || !data) throw new Error(error?.message ?? 'Could not save the connection')
    return { id: data.id }
}

// What the global MCP OAuth start route needs: the real MCP url the sign-in discovers against.
export async function globalMcpOauthContext(workspaceId: number, connectionId: string): Promise<{ slug: string; name: string; mcpUrl: string }> {
    const row = await requireConnection(workspaceId, connectionId)
    if (row.kind !== 'oauth') throw new Error('This account does not sign in through a popup.')
    const manifest = await loadManifest(row.service_slug)
    const method = manifest?.authMethods.find(m => m.id === row.auth_method_id)
    const template = method ? oauthServer(method) : undefined
    const mcpUrl = template?.url ? substituteConfig(template.url, stringRecord(row.config)) : ''
    if (!manifest || !mcpUrl || mcpUrl.includes('${')) throw new Error(`${row.service_slug} has no sign-in the workspace can hold.`)
    return { slug: manifest.slug, name: manifest.name, mcpUrl }
}

export async function markGlobalOauthConnected(connectionId: string, bundle: GlobalOauthBundle): Promise<void> {
    const supabase = createServiceRoleClient()
    await supabase.from('global_app_connections').update<ConnectionUpdate>({ status: 'connected', oauth: bundle, updated_at: new Date().toISOString() }).eq('id', connectionId)
}

// The proxy's token: refreshed ahead of expiry (or on demand after a 401) and persisted, so the
// next call starts from the newest bundle. Throws when there is nothing usable left — the caller
// flags the connection, never any one coworker.
export async function ensureGlobalOauthAccess(row: { id: string; oauth: unknown }, opts?: { forceRefresh?: boolean }): Promise<GlobalOauthBundle> {
    const bundle = oauthBundleOf(row)
    if (!bundle) throw new Error('This account has no token: reconnect it.')
    const expiring = bundle.expiresAt !== undefined && bundle.expiresAt - 60_000 < Date.now()
    if (!opts?.forceRefresh && !expiring) return bundle
    if (!bundle.refreshToken) {
        if (opts?.forceRefresh || (bundle.expiresAt !== undefined && bundle.expiresAt < Date.now())) throw new Error('The token expired and there is no refresh token: reconnect the account.')
        return bundle
    }

    const body = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: bundle.refreshToken,
        client_id: bundle.clientId,
        resource: bundle.mcpUrl,
    })
    const secret = bundle.clientSecret ?? hubClientSecret({ mcpUrl: bundle.mcpUrl, clientId: bundle.clientId })
    if (secret) body.set('client_secret', secret)
    const res = await fetchPublic(bundle.tokenEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: body.toString(),
    })
    if (!res.ok) throw new Error(`token refresh failed (${res.status})`)
    const data = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string }
    if (!data.access_token) throw new Error('token refresh returned no access_token')
    const next: GlobalOauthBundle = {
        ...bundle,
        accessToken: data.access_token,
        refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : bundle.refreshToken,
        expiresAt: typeof data.expires_in === 'number' ? Date.now() + data.expires_in * 1000 : undefined,
        ...(typeof data.scope === 'string' ? { scope: data.scope } : {}),
        obtainedAt: Date.now(),
    }
    await markGlobalOauthConnected(row.id, next)
    return next
}

// The proxy's own row read (it authenticates the engine, not a browser session).
export async function globalConnectionForProxy(workspaceId: number, connectionId: string): Promise<GlobalConnectionRow | null> {
    const supabase = createServiceRoleClient()
    const { data } = await selectMaybeSingle(supabase, 'global_app_connections', CONNECTION_COLUMNS, { id: connectionId, workspace_id: workspaceId })
    return (data as GlobalConnectionRow | null) ?? null
}

// What the Composio start route needs to mint the sign-in link for a pending connection.
export async function globalComposioContext(workspaceId: number, connectionId: string): Promise<{ slug: string; toolkit: string; authConfigId: string }> {
    const row = await requireConnection(workspaceId, connectionId)
    if (row.kind !== 'composio') throw new Error('This account does not sign in through Composio.')
    const manifest = await loadManifest(row.service_slug)
    const method = manifest?.authMethods.find(m => m.id === row.auth_method_id && m.kind === 'composio')
    if (!manifest || !method?.composio?.authConfigId) throw new Error(`${row.service_slug} has no Composio connection to set up.`)
    return { slug: manifest.slug, toolkit: method.composio.toolkit, authConfigId: method.composio.authConfigId }
}

export async function markGlobalComposioConnected(connectionId: string, composioAccountId: string, accountLabel?: string): Promise<void> {
    const supabase = createServiceRoleClient()
    const { data: row } = await selectMaybeSingle(supabase, 'global_app_connections', ['composio_account_id'] as const, { id: connectionId })
    // A reconnect leaves the previous Composio account orphaned: revoke it, best-effort.
    if (row?.composio_account_id && row.composio_account_id !== composioAccountId) {
        await deleteConnectedAccount(row.composio_account_id).catch(err => {
            console.warn(`[global-apps] could not delete the replaced Composio account ${row.composio_account_id}:`, err instanceof Error ? err.message : err)
        })
    }
    await supabase
        .from('global_app_connections')
        .update<ConnectionUpdate>({ status: 'connected', composio_account_id: composioAccountId, composio_account_label: accountLabel ?? null, updated_at: new Date().toISOString() })
        .eq('id', connectionId)
}

// The composio proxy flags a dead workspace account here, instead of flipping any one coworker's
// registry entry: the account is the thing that broke, and it broke for everyone on it.
export async function markGlobalNeedsReconnect(connectionId: string): Promise<void> {
    const supabase = createServiceRoleClient()
    await supabase.from('global_app_connections').update<ConnectionUpdate>({ status: 'needs_reconnect', updated_at: new Date().toISOString() }).eq('id', connectionId)
}

export async function renameGlobalConnection(workspaceId: number, connectionId: string, label: string): Promise<void> {
    const row = await requireConnection(workspaceId, connectionId)
    const supabase = createServiceRoleClient()
    await supabase.from('global_app_connections').update<ConnectionUpdate>({ label, updated_at: new Date().toISOString() }).eq('id', row.id)
    // The label is written on each bound coworker's registry entry too; refresh them, best-effort.
    const { data: bindings } = await selectMany(supabase, 'global_app_agents', ['agent_id', 'registry_key'] as const, { connection_id: row.id })
    for (const binding of bindings ?? []) {
        try {
            const { conn, engineAgentId } = await resolveAgentTarget(binding.agent_id, workspaceActor(workspaceId), 'manage')
            const entry = (await readRegistry(conn, engineAgentId)).services[binding.registry_key]
            if (entry?.global?.connectionId === row.id) {
                await upsertRegistryEntry(conn, engineAgentId, binding.registry_key, { ...entry, label, global: { ...entry.global, label } })
            }
        } catch (err) {
            console.warn(`[global-apps] could not refresh the label on agent ${binding.agent_id}:`, err instanceof Error ? err.message : err)
        }
    }
}

// Where an enable lands on the coworker: the entry already bound to this connection, the free
// base key, or a fresh account of a multi-account app. A slug the coworker holds with its own
// sign-in is never silently replaced.
async function enableTarget(agentId: string, manifest: ServiceManifest, connectionId: string, actor: Actor): Promise<ServiceInstanceTarget | null> {
    const { conn, engineAgentId } = await resolveAgentTarget(agentId, actor, 'manage')
    const reg = await readRegistry(conn, engineAgentId)
    const entries = entriesOfSlug(reg, manifest.slug)
    const bound = entries.find(e => e.entry.global?.connectionId === connectionId)
    if (bound) {
        const { instanceId } = bound.entry
        return instanceId ? { key: bound.key, instanceId } : null
    }
    if (entries.length === 0) return null
    if (!manifest.multiInstance) throw new Error(`${manifest.name} is already set up on this coworker with its own account. Remove it there first, or keep it as it is.`)
    const seed = await allocateServiceInstance(agentId, manifest, actor)
    return { key: seed.key, instanceId: seed.instanceId }
}

export async function enableGlobalApp(params: { workspaceId: number; connectionId: string; agentId: string; actor: Actor }): Promise<void> {
    const row = await requireConnection(params.workspaceId, params.connectionId)
    if (row.status !== 'connected') throw new Error(`${row.label} is not connected right now. Reconnect it first.`)
    const manifest = await loadManifest(row.service_slug)
    if (!manifest) throw new Error(`Service not found: ${row.service_slug}`)
    const method = getMethod(manifest, row.auth_method_id)

    const instance = await enableTarget(params.agentId, manifest, row.id, params.actor)
    const values = { ...stringRecord(row.config), ...stringRecord(row.secrets) }
    await compileService(params.agentId, manifest, values, method.id, params.actor, instance ?? undefined, { connectionId: row.id, label: row.label })

    const supabase = createServiceRoleClient()
    const { error } = await supabase
        .from('global_app_agents')
        .upsert<Database['public']['Tables']['global_app_agents']['Insert']>({ connection_id: row.id, agent_id: params.agentId, registry_key: instance?.key ?? manifest.slug }, { onConflict: 'connection_id,agent_id' })
    if (error) throw new Error(error.message)
}

export async function disableGlobalApp(params: { workspaceId: number; connectionId: string; agentId: string; actor: Actor }): Promise<void> {
    const supabase = createServiceRoleClient()
    const { data: binding } = await selectMaybeSingle(supabase, 'global_app_agents', ['registry_key'] as const, { connection_id: params.connectionId, agent_id: params.agentId })
    if (binding) {
        const { conn, engineAgentId } = await resolveAgentTarget(params.agentId, params.actor, 'manage')
        const reg = await readRegistry(conn, engineAgentId)
        const entry = reg.services[binding.registry_key]
        // Only tear down what this connection put there: an entry the coworker re-signed on its
        // own in the meantime is not ours to remove.
        if (entry?.global?.connectionId === params.connectionId) {
            await decompileService(conn, engineAgentId, entry, { keepSkills: sharedSkillSlugs(reg, binding.registry_key) })
            await removeRegistryEntry(conn, engineAgentId, binding.registry_key)
        }
    }
    await supabase.from('global_app_agents').delete().eq('connection_id', params.connectionId).eq('agent_id', params.agentId)
}

// Rotate a key connection: new values land on the row, then on every enabled coworker. A coworker
// whose engine is unreachable is reported, not silently skipped.
export async function updateGlobalKeyConnection(params: { workspaceId: number; connectionId: string; values: Record<string, string> }): Promise<{ warnings: string[] }> {
    const row = await requireConnection(params.workspaceId, params.connectionId)
    if (row.kind !== 'key') throw new Error('This account signs in through a popup; reconnect it instead.')
    const manifest = await loadManifest(row.service_slug)
    if (!manifest) throw new Error(`Service not found: ${row.service_slug}`)
    const method = getMethod(manifest, row.auth_method_id)
    const missing = missingRequiredInputs(method, params.values)
    if (missing.length > 0) throw new Error(`Missing: ${missing.map(i => i.label || i.key).join(', ')}`)

    const { config, secrets } = splitValues(method, params.values)
    const supabase = createServiceRoleClient()
    await supabase.from('global_app_connections').update<ConnectionUpdate>({ config, secrets, status: 'connected', updated_at: new Date().toISOString() }).eq('id', row.id)

    const warnings: string[] = []
    const { data: bindings } = await selectMany(supabase, 'global_app_agents', ['agent_id'] as const, { connection_id: row.id })
    const actor = workspaceActor(params.workspaceId)
    for (const binding of bindings ?? []) {
        try {
            await enableGlobalApp({ workspaceId: params.workspaceId, connectionId: row.id, agentId: binding.agent_id, actor })
        } catch (err) {
            warnings.push(`One coworker did not get the new credential: ${err instanceof Error ? err.message : 'unknown error'}`)
        }
    }
    return { warnings }
}

export async function deleteGlobalConnection(params: { workspaceId: number; connectionId: string }): Promise<{ warnings: string[] }> {
    const row = await requireConnection(params.workspaceId, params.connectionId)
    const supabase = createServiceRoleClient()
    const warnings: string[] = []
    const actor = workspaceActor(params.workspaceId)
    const { data: bindings } = await selectMany(supabase, 'global_app_agents', ['agent_id'] as const, { connection_id: row.id })
    for (const binding of bindings ?? []) {
        try {
            await disableGlobalApp({ workspaceId: params.workspaceId, connectionId: row.id, agentId: binding.agent_id, actor })
        } catch (err) {
            warnings.push(`One coworker could not be detached: ${err instanceof Error ? err.message : 'unknown error'}`)
        }
    }
    if (row.composio_account_id) {
        await deleteConnectedAccount(row.composio_account_id).catch(err => {
            warnings.push('The Composio account could not be revoked; remove it from the Composio dashboard.')
            console.warn(`[global-apps] could not delete Composio account ${row.composio_account_id}:`, err instanceof Error ? err.message : err)
        })
    }
    await supabase.from('global_app_connections').delete().eq('id', row.id)
    return { warnings }
}
