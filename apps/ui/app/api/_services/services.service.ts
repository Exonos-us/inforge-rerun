import { parseServiceRegistryKey, serviceRegistryKey } from '@rerun/contracts'

import { workspaceActor, type Actor } from '@/app/api/_auth/access'
import { AuthorizationError } from '@/app/api/_auth/ownership'
import { resolveAgentTarget } from '@/app/api/_services/chat.service'
import { unbindAgent } from '@rerun/cloud/apps.server'
import { isAppSlug, type AppSlug } from '@rerun/cloud/apps'
import { deleteConnectedAccount } from '@/lib/composio/client'
import { deleteMcpToken } from '@/lib/engine/client'
import { getManagedProvider } from '@/lib/managed/registry'
import { type ServiceInstanceTarget, compileService, decompileService } from '@/lib/services/compiler'
import { embedText, toVectorLiteral } from '@/lib/services/embed'
import { type ServiceManifest, defaultMethod, getMethod, missingRequiredInputs, predictInstall, requiredSecretInputs, serviceManifestSchema } from '@/lib/services/manifest'
import { newServiceInstanceId, ordinalInstanceLabel } from '@/lib/services/instances'
import { isPublishedAccess } from '@/lib/published/access'
import { listPublished, publishWithThumbnail, unpublishFile } from '@/lib/services/publish-thumbnail'
import {
    type ServiceRegistry,
    entriesOfSlug,
    primaryStatusOfSlug,
    readRegistry,
    registryFootprint,
    removeRegistryEntry,
    resolveRegistryEntry,
    sharedSkillSlugs,
    upsertRegistryEntry,
} from '@/lib/services/registry'
import { rerankRelevant } from '@/lib/services/rerank'
import { sanitizeIlike } from '@/lib/search/ilike'
import { ALTERNATIVE_THRESHOLD, MAX_OFFERED_ALTERNATIVES } from '@/lib/services/alternatives'
import type { AgentServiceStatus, AuthMethodSummary, InstallResult, InstalledService, ResetConnectionResult, ServiceAlternative, ServiceDetails, ServiceSearchResult } from '@/lib/services/types'
import { triggerWebhookUrl } from '@/lib/triggers/webhook'
import { createServiceRoleClient } from '@/supabase/serviceRole'
import { selectMany, selectMaybeSingle, selectSingle } from '@/supabase/supabase-helpers'

// Recall floor for the vector retrieval. Kept low on purpose: pgvector only shortlists
// candidates, and the Haiku re-rank (lib/services/rerank.ts) does the actual relevance
// gating. Query-to-document similarities with text-embedding-3-small are compressed (a
// genuine match like "refund a customer" → Stripe scores ~0.21), so a low floor avoids
// dropping real matches before the model ever sees them.
const CANDIDATE_FLOOR = 0.15
const CANDIDATE_COUNT = 10

// Default page size for the paginated catalog browse (no query).
const BROWSE_PAGE_SIZE = 60

// Cap on the literal name lookup merged ahead of the semantic results, so a broad substring
// (e.g. "a") can't flood the list before the semantic matches.
const LITERAL_MATCH_LIMIT = 25

// Fallback only: if the re-rank model is unavailable we degrade to the raw vector ranking,
// keeping the top hit and others within this fraction of it.
const RELATIVE_MARGIN = 0.65

// A registry entry outlives the catalog: a service that moved off the managed path leaves
// entries pointing at a provider we no longer serve. Dropping the target here makes the UI
// fall back to its "no sign-in target" branch, which offers a reinstall instead of a Connect
// button that could only ever fail.
function liveManaged<T extends { provider: string }>(managed: T | undefined): T | undefined {
    return managed && getManagedProvider(managed.provider) ? managed : undefined
}

// --- Catalog (UI database) ---

export async function loadManifest(slugOrKey: string): Promise<ServiceManifest | null> {
    const supabase = createServiceRoleClient()
    const { data } = await selectSingle(supabase, 'services', ['manifest', 'enabled'] as const, { slug: parseServiceRegistryKey(slugOrKey).slug })
    if (!data || !data.enabled) return null
    return serviceManifestSchema.parse(data.manifest)
}

// Client-safe view of a service's auth methods (never leaks mcpServers/envKeys).
export function toAuthMethodSummaries(manifest: ServiceManifest): AuthMethodSummary[] {
    return manifest.authMethods.map(m => ({
        id: m.id,
        label: m.label,
        kind: m.kind,
        recommended: m.recommended,
        inputs: m.inputs,
        requiresSecrets: requiredSecretInputs(m).length > 0,
    }))
}

// Which services are installed is the AGENT's own state, read from its engine-side
// registry (see lib/services/registry.ts) — never from the UI database. The status comes
// along: a declared entry still waiting for a sign-in is not an installed connector.
async function installedStatuses(agentId: string, actor?: Actor): Promise<Map<string, AgentServiceStatus>> {
    try {
        const { conn, engineAgentId } = await resolveAgentTarget(agentId, actor)
        const reg = await readRegistry(conn, engineAgentId)
        const slugs = new Set(Object.keys(reg.services).map(key => parseServiceRegistryKey(key).slug))
        return new Map([...slugs].map(slug => [slug, primaryStatusOfSlug(reg, slug) as AgentServiceStatus]))
    } catch (err) {
        // An unreachable engine legitimately degrades to "nothing installed". An authorization
        // failure does not: it would tell the agent its working connectors are missing, so it
        // surfaces instead of quietly turning every service into a setup prompt.
        if (err instanceof AuthorizationError) throw err
        console.warn(`[services] could not read the registry of agent ${agentId}:`, err instanceof Error ? err.message : err)
        return new Map()
    }
}

// Mark a service as pending config in the agent registry without compiling anything
// (used when an install is triggered but required inputs are still missing). Records the
// chosen method so the config form re-opens on the right one.
export async function markServiceNeedsConfig(agentId: string, key: string, authMethodId?: string, actor?: Actor, seed?: { instanceId: string; label: string }): Promise<void> {
    const { conn, engineAgentId } = await resolveAgentTarget(agentId, actor, 'manage')
    // Pending: no engine footprint yet (empty mcpServers/envKeys/skills).
    await upsertRegistryEntry(conn, engineAgentId, key, { status: 'needs_config', config: {}, authMethodId, mcpServers: [], envKeys: [], skills: [], ...seed, installedAt: new Date().toISOString() })
}

export type ServiceInstanceSeed = ServiceInstanceTarget & { label: string }

// A fresh key for another account of an app the coworker may already hold, labelled after the
// accounts it already shows until its sign-in gives it an email.
export async function allocateServiceInstance(agentId: string, manifest: ServiceManifest, actor?: Actor): Promise<ServiceInstanceSeed> {
    const { conn, engineAgentId } = await resolveAgentTarget(agentId, actor, 'manage')
    const reg = await readRegistry(conn, engineAgentId)
    const taken = Object.keys(reg.services).flatMap(key => parseServiceRegistryKey(key).instanceId ?? [])
    const instanceId = newServiceInstanceId(taken)
    return { key: serviceRegistryKey(manifest.slug, instanceId), instanceId, label: ordinalInstanceLabel(manifest.name, reg, manifest.slug) }
}

// --- Public service functions ---

type CatalogRow = { slug: string; name: string; category: string; summary: string; icon: string | null; manifest: unknown; verified?: boolean }

function toSearchResult(s: CatalogRow, installed: Map<string, AgentServiceStatus>, similarity?: number): ServiceSearchResult {
    const manifest = serviceManifestSchema.parse(s.manifest)
    const prediction = predictInstall(manifest)
    const status = installed.get(s.slug) ?? null
    return {
        slug: s.slug,
        name: s.name,
        category: s.category,
        summary: s.summary,
        icon: s.icon,
        requiresSecrets: requiredSecretInputs(defaultMethod(manifest)).length > 0,
        setup: prediction.outcome,
        setupReason: prediction.reason,
        installed: status === 'active',
        installStatus: status,
        verified: Boolean(s.verified),
        multiInstance: manifest.multiInstance,
        ...(manifest.authMethods.some(method => method.kind === 'app') ? { paidApp: true } : {}),
        ...(similarity === undefined ? {} : { similarity }),
    }
}

// Semantic capability search over the library. A natural-language query ("schedule social
// posts") is embedded and matched by cosine similarity against each service, so the right
// service surfaces even with no shared keywords. Falls back to substring matching when
// there's no query or no embedding key configured — nothing breaks before the backfill.
export async function searchServices(agentId: string, query?: string, category?: string, actor?: Actor): Promise<{ results: ServiceSearchResult[] }> {
    const installed = await installedStatuses(agentId, actor)
    return { results: await searchCatalog(installed, query, category) }
}

// Vector shortlist shared by search and use-case suggestion: embed the query, let pgvector
// return the semantically closest candidates. Falls back to a keyword substring match when
// there's no query, no embedding key, or the vector retrieval surfaced nothing. `viaVector`
// tells the caller whether the rows carry meaningful similarities (worth re-ranking) or came
// from the keyword fallback.
async function shortlistCandidates(
    supabase: ReturnType<typeof createServiceRoleClient>,
    q: string,
    category: string | undefined,
    vectorCount: number,
    keywordLimit = 50,
): Promise<{ rows: Array<CatalogRow & { similarity?: number }>; viaVector: boolean }> {
    if (q) {
        const embedding = await embedText(q).catch(() => null)
        if (embedding) {
            const { data } = await supabase.rpc('match_services', {
                query_embedding: toVectorLiteral(embedding),
                match_count: vectorCount,
                match_threshold: CANDIDATE_FLOOR,
                filter_category: category ?? undefined,
            })
            const rows = (data ?? []) as Array<CatalogRow & { similarity: number }>
            if (rows.length > 0) return { rows, viaVector: true }
        }
    }

    const filters: Record<string, unknown> = { enabled: true }
    if (category) filters.category = category
    const { data } = await selectMany(supabase, 'services', ['slug', 'name', 'category', 'summary', 'icon', 'manifest', 'verified'] as const, filters, { column: 'name' }, keywordLimit)
    const ql = q.toLowerCase()
    const rows = (data ?? []).filter(s => !ql || s.name.toLowerCase().includes(ql) || s.summary.toLowerCase().includes(ql) || s.slug.toLowerCase().includes(ql))
    return { rows, viaVector: false }
}

const LITERAL_COLS = ['slug', 'name', 'category', 'summary', 'icon', 'manifest', 'verified'] as const

// Literal name search, straight from the database — the "classic" lookup that always finds a
// service by its name/slug even when the semantic re-rank would drop it. A single substring
// `ilike` OR'd across name, slug and summary, ranked so name/slug hits come before summary-only
// hits and an exact/prefix name match floats to the top.
async function literalMatches(
    supabase: ReturnType<typeof createServiceRoleClient>,
    q: string,
    category: string | undefined,
    limit: number,
): Promise<CatalogRow[]> {
    const esc = sanitizeIlike(q)
    if (!esc) return []

    const pattern = `%${esc}%`
    const filters = {
        enabled: true,
        ...(category ? { category } : {}),
        or: { name: { ilike: pattern }, slug: { ilike: pattern }, summary: { ilike: pattern } },
    }
    const { data } = await selectMany(supabase, 'services', LITERAL_COLS, filters, { column: 'name' }, limit)

    const ql = q.toLowerCase()
    const rank = (s: CatalogRow): number => {
        const nm = s.name.toLowerCase()
        if (nm === ql) return 0
        if (nm.startsWith(ql)) return 1
        if (nm.includes(ql)) return 2
        if (s.slug.toLowerCase().includes(ql)) return 3
        return 4
    }
    return ((data ?? []) as CatalogRow[]).slice().sort((a, b) => rank(a) - rank(b))
}

// Shared search core: a literal name lookup merged ahead of the semantic vector retrieval +
// Haiku re-rank, with a keyword substring fallback. Literal name/slug matches are surfaced
// first and bypass the re-rank gate (they are exactly what the user typed), then the semantic
// results fill in, deduped by slug. The `installed` map is the only per-agent input — pass an
// empty map for the agent-less catalog browse.
async function searchCatalog(installed: Map<string, AgentServiceStatus>, query?: string, category?: string): Promise<ServiceSearchResult[]> {
    const supabase = createServiceRoleClient()
    const q = (query ?? '').trim()

    if (!q) {
        const { rows } = await shortlistCandidates(supabase, q, category, CANDIDATE_COUNT)
        return rows.map(s => toSearchResult(s, installed))
    }

    const [literal, semantic] = await Promise.all([
        literalMatches(supabase, q, category, LITERAL_MATCH_LIMIT),
        semanticCatalog(supabase, installed, q, category),
    ])

    const seen = new Set<string>()
    const merged: ServiceSearchResult[] = []
    for (const s of literal.map(r => toSearchResult(r, installed))) {
        if (seen.has(s.slug)) continue
        seen.add(s.slug)
        merged.push(s)
    }
    for (const s of semantic) {
        if (seen.has(s.slug)) continue
        seen.add(s.slug)
        merged.push(s)
    }
    return merged
}

// Semantic half of searchCatalog: vector shortlist + Haiku re-rank, with the keyword substring
// fallback when embeddings are unavailable. Assumes a non-empty query.
async function semanticCatalog(
    supabase: ReturnType<typeof createServiceRoleClient>,
    installed: Map<string, AgentServiceStatus>,
    q: string,
    category: string | undefined,
): Promise<ServiceSearchResult[]> {
    const { rows, viaVector } = await shortlistCandidates(supabase, q, category, CANDIDATE_COUNT)

    if (viaVector) {
        const vrows = rows as Array<CatalogRow & { similarity: number }>
        const bySlug = new Map(vrows.map(r => [r.slug, r]))
        try {
            // Haiku keeps only the candidates that genuinely match — or none, in
            // which case the semantic half is empty and only literal matches remain.
            const ranked = await rerankRelevant(q, vrows.map(r => ({ slug: r.slug, name: r.name, summary: r.summary })))
            const ordered = ranked.map(slug => bySlug.get(slug)).filter((r): r is CatalogRow & { similarity: number } => Boolean(r))
            return ordered.map(s => toSearchResult(s, installed, s.similarity))
        } catch {
            // Re-rank unavailable → degrade to the raw vector ranking with a
            // relative cutoff rather than black-holing the search.
            const cutoff = vrows[0].similarity * RELATIVE_MARGIN
            return vrows.filter(s => s.similarity >= cutoff).map(s => toSearchResult(s, installed, s.similarity))
        }
    }

    return rows.map(s => toSearchResult(s, installed))
}

// Semantic catalog search with no agent context. Same pipeline as searchServices, but `installed`
// is always empty since there is no agent to install into.
export async function searchCatalogServices(query?: string, category?: string): Promise<ServiceSearchResult[]> {
    return searchCatalog(new Map(), query, category)
}

// Paginated catalog browse without an agent context. No per-agent install state, so `installed`
// is always false. Ordered by (category, name) for a stable, groupable infinite scroll; the
// caller keeps loading pages until a short one comes back.
export async function listCatalogServices(opts?: { category?: string; limit?: number; offset?: number }): Promise<ServiceSearchResult[]> {
    const supabase = createServiceRoleClient()
    const limit = opts?.limit ?? BROWSE_PAGE_SIZE
    const offset = opts?.offset ?? 0

    let query = supabase.from('services').select('slug, name, category, summary, icon, manifest, verified').eq('enabled', true)
    if (opts?.category) query = query.eq('category', opts.category)

    const { data } = await query.order('category', { ascending: true }).order('name', { ascending: true }).range(offset, offset + limit - 1)

    return ((data ?? []) as CatalogRow[]).map(s => toSearchResult(s, new Map()))
}

// Resolve full catalog metadata for a specific set of slugs. Seeds the agent-creation
// dialog's tile cache in "finish setup" mode, where the checklist slugs may fall outside the
// browse pages loaded — so their tiles/icons still render.
export async function getCatalogServicesBySlugs(slugs: string[]): Promise<ServiceSearchResult[]> {
    if (slugs.length === 0) return []
    const supabase = createServiceRoleClient()
    const { data } = await selectMany(supabase, 'services', ['slug', 'name', 'category', 'summary', 'icon', 'manifest', 'verified'] as const, { slug: { in: slugs }, enabled: true })
    return (data ?? []).map(s => toSearchResult(s, new Map()))
}

// The best replacements for each slug, strongest first. Disabled services drop out here rather
// than in the pair table, which keeps pointing at them.
export async function getServiceAlternatives(slugs: string[]): Promise<Record<string, ServiceAlternative[]>> {
    if (slugs.length === 0) return {}
    const supabase = createServiceRoleClient()
    const { data: pairs } = await selectMany(supabase, 'service_alternatives', ['service_slug', 'alternative_slug'] as const, { service_slug: { in: slugs }, probability: { gte: ALTERNATIVE_THRESHOLD } }, { column: 'probability', ascending: false })
    if (!pairs?.length) return {}
    const { data: services } = await selectMany(supabase, 'services', ['slug', 'name', 'category', 'icon'] as const, { slug: { in: [...new Set(pairs.map(p => p.alternative_slug))] }, enabled: true })
    const bySlug = new Map((services ?? []).map(s => [s.slug, s]))
    const alternatives: Record<string, ServiceAlternative[]> = {}
    for (const { service_slug, alternative_slug } of pairs) {
        const service = bySlug.get(alternative_slug)
        const list = (alternatives[service_slug] ??= [])
        if (service && list.length < MAX_OFFERED_ALTERNATIVES) list.push(service)
    }
    return alternatives
}

export async function getServiceDetails(agentId: string, slugOrKey: string, actor?: Actor): Promise<ServiceDetails> {
    const manifest = await loadManifest(slugOrKey)
    if (!manifest) throw new Error(`Service not found: ${slugOrKey}`)

    // A registry entry alone proves nothing: needs_config and needs_auth entries are declared
    // on the agent but unusable, and reporting them as installed leaves the user with no way
    // to finish the setup and the agent believing it holds tools it cannot call.
    let installStatus: AgentServiceStatus | null = null
    let installedMethodId: string | undefined
    let oauth: ServiceDetails['oauth']
    let managed: ServiceDetails['managed']
    let composio: ServiceDetails['composio']
    let app: ServiceDetails['app']
    let label: string | undefined
    let instances: ServiceDetails['instances'] = []
    try {
        const { conn, engineAgentId } = await resolveAgentTarget(agentId, actor)
        const reg = await readRegistry(conn, engineAgentId)
        const entry = resolveRegistryEntry(reg, slugOrKey)?.entry
        label = entry?.label
        instances = entriesOfSlug(reg, manifest.slug).map(({ key, entry: other }) => ({ key, status: other.status, ...(other.label ? { label: other.label } : {}) }))
        installStatus = entry?.status ?? null
        installedMethodId = entry?.authMethodId
        oauth = entry?.oauth
        managed = liveManaged(entry?.managed)
        composio = entry?.composio
        app = entry?.app
    } catch (err) {
        // Unreachable engine → treat as not installed. An authorization failure is a different
        // story: reporting a working connector as absent is worse than failing the call.
        if (err instanceof AuthorizationError) throw err
        console.warn(`[services] could not read ${slugOrKey} on agent ${agentId}:`, err instanceof Error ? err.message : err)
    }

    return {
        key: slugOrKey,
        slug: manifest.slug,
        ...(label ? { label } : {}),
        name: manifest.name,
        category: manifest.category,
        summary: manifest.summary,
        description: manifest.description,
        authMethods: toAuthMethodSummaries(manifest),
        installed: installStatus === 'active',
        installStatus,
        installedMethodId,
        oauth,
        managed,
        composio,
        app,
        multiInstance: manifest.multiInstance,
        instances,
    }
}

// Install a service using the chosen auth method (falls back to the default). Returns
// needs_config (without compiling) when the method's required inputs are missing, so the
// caller (chat renderer / settings panel) can show the config form.
// `newInstance` adds another account next to the ones the coworker holds, only for an app whose
// manifest allows it: anywhere else it is ignored and the base account is (re)installed.
export async function installService(
    agentId: string,
    slugOrKey: string,
    values: Record<string, string> = {},
    authMethodId?: string,
    actor?: Actor,
    opts?: { newInstance?: boolean },
): Promise<InstallResult> {
    const manifest = await loadManifest(slugOrKey)
    if (!manifest) throw new Error(`Service not found: ${slugOrKey}`)

    const instance = await installTarget(agentId, manifest, slugOrKey, Boolean(opts?.newInstance), actor)
    const key = instance?.key ?? manifest.slug
    const method = getMethod(manifest, authMethodId)
    const missing = missingRequiredInputs(method, values)
    if (missing.length > 0) {
        await markServiceNeedsConfig(agentId, key, method.id, actor, instance ? { instanceId: instance.instanceId, label: instance.label } : undefined)
        return { status: 'needs_config', key, slug: manifest.slug, name: manifest.name, authMethods: toAuthMethodSummaries(manifest), authMethodId: method.id, message: `${manifest.name} needs configuration. A form has been shown to the user — ask them to fill it in.` }
    }

    const { toolNames, oauth, managed, composio, app } = await compileService(agentId, manifest, values, method.id, actor, instance ?? undefined)
    if (oauth) {
        return { status: 'needs_auth', key, slug: manifest.slug, name: manifest.name, oauth, message: `${manifest.name} needs the user to sign in. A Connect button has been shown to them.` }
    }
    if (managed) {
        return { status: 'needs_auth', key, slug: manifest.slug, name: manifest.name, managed, message: `${manifest.name} needs the user to connect their account. A Connect button has been shown to them.` }
    }
    if (composio) {
        return { status: 'needs_auth', key, slug: manifest.slug, name: manifest.name, composio, message: `${manifest.name} needs the user to connect their account. A Connect button has been shown to them.` }
    }
    if (app) {
        // A coworker that already picked an account (a reinstall) is ready at once.
        const bound = isAppSlug(app.appSlug) ? await boundAccountLabel(agentId, app.appSlug) : null
        if (bound === null) {
            return { status: 'needs_auth', key, slug: manifest.slug, name: manifest.name, app, message: `${manifest.name} needs the user to pick the account you act with. A picker has been shown to them.` }
        }
        await markAppAuthorized(agentId, key, bound || undefined, actor)
    }
    return { status: 'installed', key, slug: manifest.slug, name: manifest.name, toolNames, message: `${manifest.name} installed. Its tools become available on your next turn.` }
}

// Which registry entry an install writes: null for the base account, a fresh key for a new
// account, or the existing extra account the caller addressed by its key (keeping its label).
async function installTarget(agentId: string, manifest: ServiceManifest, slugOrKey: string, newInstance: boolean, actor?: Actor): Promise<ServiceInstanceSeed | null> {
    if (newInstance && manifest.multiInstance) return allocateServiceInstance(agentId, manifest, actor)
    const { instanceId } = parseServiceRegistryKey(slugOrKey)
    if (!instanceId || !manifest.multiInstance) return null
    const { conn, engineAgentId } = await resolveAgentTarget(agentId, actor, 'manage')
    const reg = await readRegistry(conn, engineAgentId)
    return { key: slugOrKey, instanceId, label: reg.services[slugOrKey]?.label ?? ordinalInstanceLabel(manifest.name, reg, manifest.slug) }
}

// The label of the account a coworker acts with in a paid app, '' when it has none yet, null when
// the coworker picked none or its account is gone.
async function boundAccountLabel(agentId: string, appSlug: AppSlug): Promise<string | null> {
    const supabase = createServiceRoleClient()
    const { data: binding } = await selectMaybeSingle(supabase, 'app_connection_agents', ['connection_id'] as const, { agent_id: agentId, app_slug: appSlug })
    if (!binding) return null
    const { data: connection } = await selectMaybeSingle(supabase, 'app_connections', ['label', 'status'] as const, { id: binding.connection_id })
    if (!connection || connection.status === 'deleted') return null
    return connection.label ?? ''
}

// Flip a paid app's service to active once the coworker has picked the account it acts with.
export async function markAppAuthorized(agentId: string, key: string, accountLabel?: string, actor?: Actor): Promise<void> {
    const { conn, engineAgentId } = await resolveAgentTarget(agentId, actor, 'manage')
    const entry = (await readRegistry(conn, engineAgentId)).services[key]
    if (!entry?.app) return
    const app = { appSlug: entry.app.appSlug, serverName: entry.app.serverName, ...(accountLabel ? { accountLabel } : {}) }
    await upsertRegistryEntry(conn, engineAgentId, key, { ...entry, status: 'active', app })
}

// Flip an OAuth service to active after the user completes the sign-in popup (the callback
// route has already written the token to the engine token store).
export async function markServiceAuthorized(agentId: string, key: string, actor?: Actor): Promise<void> {
    const { conn, engineAgentId } = await resolveAgentTarget(agentId, actor, 'manage')
    const entry = (await readRegistry(conn, engineAgentId)).services[key]
    if (entry) await upsertRegistryEntry(conn, engineAgentId, key, { ...entry, status: 'active' })
}

// Flip a managed service to active and record the connected account label, after the managed
// OAuth callback wrote the token to the engine token store.
export async function markManagedAuthorized(agentId: string, key: string, accountEmail?: string, actor?: Actor): Promise<void> {
    const { conn, engineAgentId } = await resolveAgentTarget(agentId, actor, 'manage')
    const entry = (await readRegistry(conn, engineAgentId)).services[key]
    if (!entry) return
    const managed = { provider: entry.managed?.provider ?? '', serverName: entry.managed?.serverName ?? '', ...(accountEmail ? { accountEmail } : {}) }
    await upsertRegistryEntry(conn, engineAgentId, key, { ...entry, status: 'active', managed, ...(accountEmail ? { label: accountEmail } : {}) })
}

// Flip a Composio service to active once its connected account is verified ACTIVE. The
// connectedAccountId is what uninstall/reconnect later delete at Composio to revoke access.
export async function markComposioAuthorized(agentId: string, key: string, connectedAccountId: string, accountLabel?: string, actor?: Actor): Promise<void> {
    const { conn, engineAgentId } = await resolveAgentTarget(agentId, actor, 'manage')
    const entry = (await readRegistry(conn, engineAgentId)).services[key]
    if (!entry) return
    const composio = { toolkit: entry.composio?.toolkit ?? '', serverName: entry.composio?.serverName ?? '', connectedAccountId, ...(accountLabel ? { accountLabel } : {}) }
    await upsertRegistryEntry(conn, engineAgentId, key, { ...entry, status: 'active', composio, ...(accountLabel ? { label: accountLabel } : {}) })
}

// Send a connected service back to its sign-in step without tearing down what the install
// compiled: an expired or wrong-account token is the whole problem, so only the token goes and
// the mcp servers / env keys / skills stay. A service with no sign-in (API key, stdio) has no
// token to drop — it keeps working until the user actually submits new values, since
// compileService is idempotent and the submit overwrites in place.
export async function resetServiceConnection(agentId: string, key: string, actor?: Actor): Promise<ResetConnectionResult> {
    const { conn, engineAgentId } = await resolveAgentTarget(agentId, actor, 'manage')
    const entry = (await readRegistry(conn, engineAgentId)).services[key]
    if (!entry) return { mode: 'config' }

    // A paid app's account belongs to the workspace, so a reset only sends the coworker back to
    // picking one: the account itself stays connected for the other coworkers. A coworker still
    // bound keeps working while the picker is open, since closing it without a pick changes nothing.
    if (entry.app?.serverName) {
        const app = { appSlug: entry.app.appSlug, serverName: entry.app.serverName }
        const bound = isAppSlug(app.appSlug) ? await boundAccountLabel(agentId, app.appSlug) : null
        if (bound === null) await upsertRegistryEntry(conn, engineAgentId, key, { ...entry, status: 'needs_auth', app })
        else await upsertRegistryEntry(conn, engineAgentId, key, { ...entry, status: 'active', app: { ...app, ...(bound ? { accountLabel: bound } : {}) } })
        return { mode: 'auth', app }
    }

    // A Composio connection has no engine token: resetting means deleting the connected
    // account at Composio (best-effort) and sending the entry back to its sign-in step.
    if (entry.composio?.serverName && entry.composio.toolkit) {
        if (entry.composio.connectedAccountId) {
            await deleteConnectedAccount(entry.composio.connectedAccountId).catch(err => {
                console.warn(`[composio] could not delete connected account ${entry.composio?.connectedAccountId}:`, err instanceof Error ? err.message : err)
            })
        }
        const composio = { toolkit: entry.composio.toolkit, serverName: entry.composio.serverName }
        await upsertRegistryEntry(conn, engineAgentId, key, { ...entry, status: 'needs_auth', composio })
        return { mode: 'auth', composio }
    }

    // A legacy entry can carry a half-filled target: without a server name there is no token to
    // clear, and without a url / provider the UI has no sign-in step to render.
    const entryManaged = liveManaged(entry.managed)
    const serverName = entry.oauth?.serverName ?? entryManaged?.serverName
    if (!serverName || !(entry.oauth?.url || entryManaged?.provider)) return { mode: 'config', authMethodId: entry.authMethodId }

    await deleteMcpToken(conn, engineAgentId, serverName).catch(() => {})
    // provider/serverName are what markManagedAuthorized reads back after the new sign-in; only
    // the account label is stale.
    const managed = entryManaged ? { provider: entryManaged.provider, serverName: entryManaged.serverName } : undefined
    await upsertRegistryEntry(conn, engineAgentId, key, { ...entry, status: 'needs_auth', ...(managed ? { managed } : {}) })
    return { mode: 'auth', oauth: entry.oauth, managed }
}

export async function listInstalledServices(agentId: string, actor?: Actor): Promise<{ services: InstalledService[] }> {
    const { conn, engineAgentId } = await resolveAgentTarget(agentId, actor)
    return { services: await installedFromRegistry(await readRegistry(conn, engineAgentId)) }
}

// One row per account, every account of an app grouped under it, the base one first.
export async function installedFromRegistry(reg: ServiceRegistry): Promise<InstalledService[]> {
    const slugs = [...new Set(Object.keys(reg.services).map(key => parseServiceRegistryKey(key).slug))]
    if (slugs.length === 0) return []

    // Resolve display metadata from the catalog (best-effort).
    const supabase = createServiceRoleClient()
    const { data: svcs } = await selectMany(supabase, 'services', ['slug', 'name', 'icon', 'category'] as const, { slug: { in: slugs } })
    const bySlug = new Map((svcs ?? []).map(s => [s.slug, s]))

    return slugs.flatMap(slug =>
        entriesOfSlug(reg, slug).map(({ key, entry }) => {
            const cat = bySlug.get(slug)
            const { instanceId } = parseServiceRegistryKey(key)
            return {
                key,
                slug,
                ...(instanceId ? { instanceId } : {}),
                ...(entry.label ? { label: entry.label } : {}),
                name: cat?.name ?? slug,
                icon: cat?.icon ?? null,
                category: cat?.category ?? 'other',
                status: entry.status,
                toolNames: registryFootprint(entry).mcpServers,
                oauth: entry.oauth,
                managed: liveManaged(entry.managed),
                composio: entry.composio,
                app: entry.app,
                authMethodId: entry.authMethodId,
                ...(entry.global ? { global: entry.global } : {}),
                installedAt: entry.installedAt,
            }
        }),
    )
}

// Full teardown: reverse exactly what the install added (per the registry footprint),
// then drop the registry entry. needs_config entries have an empty footprint → no-op
// teardown, just the registry removal.
export async function uninstallService(agentId: string, key: string, actor?: Actor): Promise<void> {
    const { conn, engineAgentId } = await resolveAgentTarget(agentId, actor, 'manage')
    const reg = await readRegistry(conn, engineAgentId)
    const entry = reg.services[key]
    if (entry) await decompileService(conn, engineAgentId, entry, { keepSkills: sharedSkillSlugs(reg, key) })
    await removeRegistryEntry(conn, engineAgentId, key)
    if (entry?.app && isAppSlug(entry.app.appSlug)) {
        const supabase = createServiceRoleClient()
        const { data: agent } = await selectMaybeSingle(supabase, 'agents', ['workspace_id'] as const, { id: agentId })
        if (agent) await unbindAgent(supabase, agent.workspace_id, agentId, entry.app.appSlug)
    }
    // A Global apps binding: the workspace account survives (its credential never lived on this
    // coworker), only the link goes.
    if (entry?.global) {
        const supabase = createServiceRoleClient()
        await supabase.from('global_app_agents').delete().eq('connection_id', entry.global.connectionId).eq('agent_id', agentId)
    }
}

// --- Hub dispatch (called by app/api/hub/route.ts) ---

function asString(v: unknown): string | undefined {
    return typeof v === 'string' ? v : undefined
}

function requireString(v: unknown, field: string): string {
    if (typeof v !== 'string' || !v) throw new Error(`Missing required argument: ${field}`)
    return v
}

function asStringArray(v: unknown): string[] | undefined {
    if (typeof v === 'string') return v.split(',')
    return Array.isArray(v) ? v.filter((entry): entry is string => typeof entry === 'string') : undefined
}

function asStringRecord(v: unknown): Record<string, string> {
    if (!v || typeof v !== 'object') return {}
    const out: Record<string, string> = {}
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) if (typeof val === 'string') out[k] = val
    return out
}

// The caller is the engine, authenticated by its Box key, so there is no browser session to
// resolve a workspace from: the route hands over the one it authenticated. Without it every
// registry read below fails authorization and the agent is told its live connectors are absent.
export async function dispatchHubTool(agentId: string, name: string, args: Record<string, unknown>, workspaceId: number): Promise<unknown> {
    const actor = workspaceActor(workspaceId)
    switch (name) {
        case 'service_search':
            return searchServices(agentId, asString(args.query), asString(args.category), actor)
        case 'service_details':
            return getServiceDetails(agentId, requireString(args.slug, 'slug'), actor)
        case 'service_install':
            return installService(agentId, requireString(args.slug, 'slug'), asStringRecord(args.values), asString(args.authMethodId), actor)
        case 'service_list_installed':
            return listInstalledServices(agentId, actor)
        case 'service_uninstall': {
            const slug = requireString(args.slug, 'slug')
            await uninstallService(agentId, slug, actor)
            return { status: 'uninstalled', slug }
        }
        case 'publish_file':
            return publishWithThumbnail(agentId, requireString(args.path, 'path'), asString(args.slug), {
                access: isPublishedAccess(args.access) ? args.access : undefined,
                invite: asStringArray(args.invite),
                password: asString(args.password),
            })
        case 'unpublish_file':
            return unpublishFile(agentId, { path: asString(args.path), slug: asString(args.slug) })
        case 'list_published':
            return listPublished(agentId)
        // The engine addresses agents by its own local ids, so only the hub can build a trigger's
        // public URL. No DB read: the caller already proved it owns this agent's engine.
        case 'trigger_url':
            return { url: await triggerWebhookUrl(agentId, requireString(args.slug, 'slug'), requireString(args.token, 'token')) }
        default:
            throw new Error(`Unknown Hub tool: ${name}`)
    }
}
