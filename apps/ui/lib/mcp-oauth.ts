// MCP OAuth (authorization-code + PKCE + Dynamic Client Registration), driven by the UI
// because rerun.build has a domain + TLS the engine (raw IP) does not. The resulting token
// is handed to the engine token store (apps/engine mcp-auth.ts) — never persisted in
// Supabase. Mirrors the hand-rolled PKCE style of lib/engine/claude-oauth.ts.
//
// Server-only (uses node:crypto). Import from route handlers.

import { assertPublicUrl, fetchPublic } from '@/lib/net/public-fetch'
import { openContext, sealContext } from '@/lib/oauth/context-cookie'
import { createHash, randomBytes } from 'node:crypto'

const trimSlash = (s: string) => s.replace(/\/+$/, '')

export function base64url(buf: Buffer): string {
    return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export const OAUTH_COOKIE_PREFIX = 'mcp_oauth_'
export const OAUTH_COOKIE_PATH = '/api/mcp/oauth'

// The one-request PKCE + provider context, round-tripped through an httpOnly cookie keyed
// by `state` between /start and /callback. Holds no long-lived secret — just the PKCE
// verifier and the endpoints/client needed to finish and later refresh.
export type OAuthContext = {
    verifier: string
    agentId: string
    serverName: string
    mcpUrl: string
    tokenEndpoint: string
    clientId: string
    clientSecret?: string
    redirectUri: string
    scope?: string
    // Started from the iOS app: the callback redirects back into it instead of answering with the
    // popup page, and reads the workspace from this signed grant since that browser has no session.
    mobileGrant?: string
}

export type DiscoveredMetadata = {
    authorizationEndpoint: string
    tokenEndpoint: string
    registrationEndpoint?: string
    scopesSupported?: string[]
    clientIdMetadataDocumentSupported?: boolean
}

export type ClientInfo = { clientId: string; clientSecret?: string }

function appOrigin(req: Request): string {
    const h = req.headers
    const host = h.get('x-forwarded-host') ?? h.get('host') ?? 'localhost:3000'
    const local = host.startsWith('localhost') || host.startsWith('127.')
    const proto = h.get('x-forwarded-proto') ?? (local ? 'http' : 'https')
    return `${proto}://${host}`
}

// The redirect_uri, derived identically in /discover (DCR), /start (authorize) and
// /callback (exchange) so the three always agree.
export function callbackUrl(req: Request): string {
    return `${appOrigin(req)}${OAUTH_COOKIE_PATH}/callback`
}

async function fetchJson(url: string): Promise<Record<string, unknown> | null> {
    try {
        const res = await fetchPublic(url, { headers: { Accept: 'application/json' } })
        if (!res.ok) return null
        return (await res.json()) as Record<string, unknown>
    } catch {
        return null
    }
}

// RFC 8414 §3.1 / OIDC Discovery: when the authorization-server issuer has a path, the
// well-known segment is inserted between host and path (path-aware), not appended after it.
// A root issuer (no path) collapses to the plain well-known URL. Ordered most- to
// least-specific so a path issuer like https://login.wrike.com/oauth2 resolves.
function authServerMetadataUrls(issuer: string): string[] {
    const u = new URL(issuer)
    const path = trimSlash(u.pathname)
    const urls: string[] = []
    if (path) {
        urls.push(`${u.origin}/.well-known/oauth-authorization-server${path}`)
        urls.push(`${u.origin}/.well-known/openid-configuration${path}`)
        urls.push(`${u.origin}${path}/.well-known/openid-configuration`)
    }
    urls.push(`${u.origin}/.well-known/oauth-authorization-server`)
    urls.push(`${u.origin}/.well-known/openid-configuration`)
    return urls
}

// No public suffix list here: a two-label parent like co.uk or com.au is caught by its shape instead.
const TWO_LABEL_PUBLIC_SUFFIX = /^(?:co|com|net|org|gov|edu|ac)\.[a-z]{2}$/

// A provider that hosts its MCP server on a subdomain (mcp.acme.com) often publishes the OAuth
// metadata on the parent domain only, and skips the RFC 9728 protected-resource document that
// would point there — Firecrawl's mcp.firecrawl.dev is served by www.firecrawl.dev. Walk the
// labels up, stopping at the registrable domain.
function parentOrigins(origin: string): string[] {
    const labels = new URL(origin).hostname.split('.')
    const origins: string[] = []
    for (let i = 1; labels.length - i >= 2; i++) {
        const parent = labels.slice(i).join('.')
        if (TWO_LABEL_PUBLIC_SUFFIX.test(parent)) break
        origins.push(`https://${parent}`)
    }
    return origins
}

function registrableDomain(hostname: string): string {
    const labels = hostname.split('.')
    const parent = labels.slice(-2).join('.')
    return TWO_LABEL_PUBLIC_SUFFIX.test(parent) ? labels.slice(-3).join('.') : parent
}

// The endpoints a metadata document names are where the person is sent and where the code goes.
// They stay on the site of the server, or of the authorization server its protected-resource
// document named: a document anyone can publish must not turn our redirect into a door to a third party.
async function endpointOnSite(value: unknown, label: string, sites: URL[]): Promise<string> {
    if (typeof value !== 'string') throw new Error(`this server advertises no ${label}`)
    const parsed = await assertPublicUrl(value)
    if (!sites.some(site => registrableDomain(site.hostname) === registrableDomain(parsed.hostname))) throw new Error(`the ${label} of this server points away from it (${parsed.host})`)
    return value
}

// Protected-resource metadata → authorization-server metadata. Falls back to treating the
// MCP origin as the authorization server when no protected-resource document is published.
export async function discoverAuthServer(mcpUrl: string): Promise<DiscoveredMetadata> {
    const url = await assertPublicUrl(mcpUrl)
    const origin = url.origin
    // RFC 9728: the well-known segment is inserted before the resource path, so a server at
    // /mcp publishes at /.well-known/oauth-protected-resource/mcp. Try that first, then root.
    const path = trimSlash(url.pathname)
    const prm =
        (path ? await fetchJson(`${origin}/.well-known/oauth-protected-resource${path}`) : null) ??
        (await fetchJson(`${origin}/.well-known/oauth-protected-resource`))
    const servers = prm?.authorization_servers as string[] | undefined
    const bases = servers?.length ? [servers[0]] : [origin, ...parentOrigins(origin)]
    // RFC 9728: the protected resource lists the scopes it actually accepts. Prefer these over
    // the authorization server's global scopes_supported, which may advertise scopes (or scope
    // combinations) the resource rejects with invalid_scope at /authorize.
    const resourceScopes = Array.isArray(prm?.scopes_supported) ? (prm!.scopes_supported as string[]) : undefined
    let meta: Record<string, unknown> | null = null
    let foundAt: string | null = null
    for (const base of bases) {
        for (const candidate of authServerMetadataUrls(base)) {
            const found = await fetchJson(candidate)
            if (found && typeof found.authorization_endpoint === 'string' && typeof found.token_endpoint === 'string') {
                meta = found
                foundAt = base
                break
            }
        }
        if (meta) break
    }
    if (!meta || !foundAt) {
        throw new Error('this server does not advertise an OAuth authorization server')
    }
    const sites = [url, new URL(foundAt)]
    return {
        authorizationEndpoint: await endpointOnSite(meta.authorization_endpoint, 'authorization endpoint', sites),
        tokenEndpoint: await endpointOnSite(meta.token_endpoint, 'token endpoint', sites),
        registrationEndpoint: typeof meta.registration_endpoint === 'string' ? await endpointOnSite(meta.registration_endpoint, 'registration endpoint', sites) : undefined,
        scopesSupported: resourceScopes ?? (Array.isArray(meta.scopes_supported) ? (meta.scopes_supported as string[]) : undefined),
        clientIdMetadataDocumentSupported: meta.client_id_metadata_document_supported === true,
    }
}

// Client ID Metadata Document (draft-ietf-oauth-client-id-metadata-document): the client_id is
// this document's own HTTPS URL, which the authorization server dereferences to read our
// registration. Used instead of Dynamic Client Registration for servers that advertise
// client_id_metadata_document_supported and reject DCR for non-loopback (hosted) redirect URIs,
// as Indeed's secure.indeed.com does.
export function clientMetadataDocumentUrl(req: Request): string {
    return `${appOrigin(req)}${OAUTH_COOKIE_PATH}/client-metadata`
}

export function clientMetadataDocument(req: Request): Record<string, unknown> {
    return {
        client_id: clientMetadataDocumentUrl(req),
        client_name: 'Rerun',
        client_uri: appOrigin(req),
        redirect_uris: [callbackUrl(req)],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
    }
}

// Dynamic Client Registration (RFC 7591) as a public PKCE client.
export async function registerClient(registrationEndpoint: string, redirectUri: string): Promise<ClientInfo> {
    const res = await fetchPublic(registrationEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
            client_name: 'Rerun',
            redirect_uris: [redirectUri],
            grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code'],
            token_endpoint_auth_method: 'none',
        }),
    })
    if (!res.ok) throw new Error(`client registration failed (${res.status})`)
    const data = (await res.json()) as { client_id?: string; client_secret?: string }
    if (!data.client_id) throw new Error('client registration returned no client_id')
    return { clientId: data.client_id, clientSecret: data.client_secret }
}

type PreRegisteredClient = { mcpOrigin: string; clientIdEnv: string; clientSecretEnv: string; engineRefreshes?: boolean }

// For authorization servers offering neither DCR nor Client ID Metadata Documents, an OAuth app
// registered by Rerun itself. Keyed on the MCP origin rather than the authorization server, so
// another MCP server naming github.com as its issuer cannot borrow our app. Its secret never
// reaches the browser or the context cookie, and reaches the engine token store only when the
// provider's tokens expire and its token endpoint refuses a refresh without it.
const PRE_REGISTERED_CLIENTS: PreRegisteredClient[] = [
    // GitHub OAuth App tokens never expire, so the engine never needs the secret to refresh.
    { mcpOrigin: 'https://api.githubcopilot.com', clientIdEnv: 'RERUN_GITHUB_MCP_CLIENT_ID', clientSecretEnv: 'RERUN_GITHUB_MCP_CLIENT_SECRET' },
    // Asana access tokens last one hour and its token endpoint only takes authenticated clients.
    { mcpOrigin: 'https://mcp.asana.com', clientIdEnv: 'RERUN_ASANA_MCP_CLIENT_ID', clientSecretEnv: 'RERUN_ASANA_MCP_CLIENT_SECRET', engineRefreshes: true },
]

// Their registration endpoint answers every caller with one shared client and keeps its own
// redirect URIs, echoing ours back without registering it: HeyGen hands out "HeyGen MCP Default".
const CLIENT_METADATA_DOCUMENT_FIRST = ['https://mcp.heygen.com']

function preRegisteredClient(mcpUrl: string): { clientId: string; clientSecret: string; engineRefreshes: boolean } | null {
    const origin = new URL(mcpUrl).origin
    const entry = PRE_REGISTERED_CLIENTS.find(client => client.mcpOrigin === origin)
    const clientId = entry && process.env[entry.clientIdEnv]
    const clientSecret = entry && process.env[entry.clientSecretEnv]
    return clientId && clientSecret ? { clientId, clientSecret, engineRefreshes: entry.engineRefreshes === true } : null
}

export async function resolveClient(metadata: DiscoveredMetadata, mcpUrl: string, req: Request): Promise<ClientInfo | null> {
    const preRegistered = preRegisteredClient(mcpUrl)
    if (preRegistered) return { clientId: preRegistered.clientId }

    if (metadata.clientIdMetadataDocumentSupported && CLIENT_METADATA_DOCUMENT_FIRST.includes(new URL(mcpUrl).origin)) {
        return { clientId: clientMetadataDocumentUrl(req) }
    }

    if (metadata.registrationEndpoint) {
        try {
            return await registerClient(metadata.registrationEndpoint, callbackUrl(req))
        } catch (err) {
            // Some servers (e.g. Indeed) restrict DCR to loopback redirect URIs and reject our
            // hosted https callback. Fall back to a Client ID Metadata Document when advertised.
            if (!metadata.clientIdMetadataDocumentSupported) throw err
        }
    }
    return metadata.clientIdMetadataDocumentSupported ? { clientId: clientMetadataDocumentUrl(req) } : null
}

// Enough to name the client without a full context: the mobile claim only holds the MCP URL and
// the client id of the parked bundle.
type ClientRef = { mcpUrl: string; clientId?: string; clientSecret?: string }

function clientSecret(ref: ClientRef, forEngine: boolean): string | undefined {
    if (ref.clientSecret) return ref.clientSecret
    const preRegistered = preRegisteredClient(ref.mcpUrl)
    if (!preRegistered || preRegistered.clientId !== ref.clientId) return undefined
    return forEngine && !preRegistered.engineRefreshes ? undefined : preRegistered.clientSecret
}

function clientSecretFor(ref: ClientRef): string | undefined {
    return clientSecret(ref, false)
}

// The secret the engine token store keeps to refresh on its own.
export function engineClientSecret(ref: ClientRef): string | undefined {
    return clientSecret(ref, true)
}

// The secret the hub itself uses to refresh a workspace-level (Global apps) token. Unlike the
// engine, the hub shares the environment that holds the pre-registered clients, so it always may.
export function hubClientSecret(ref: ClientRef): string | undefined {
    return clientSecret(ref, false)
}

export function createPkce(): { verifier: string; challenge: string; state: string } {
    const verifier = base64url(randomBytes(32))
    const challenge = base64url(createHash('sha256').update(verifier).digest())
    const state = base64url(randomBytes(24))
    return { verifier, challenge, state }
}

export function buildAuthorizeUrl(metadata: DiscoveredMetadata, ctx: OAuthContext, challenge: string, state: string): string {
    const params = new URLSearchParams({
        response_type: 'code',
        client_id: ctx.clientId,
        redirect_uri: ctx.redirectUri,
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        resource: ctx.mcpUrl,
    })
    if (ctx.scope) params.set('scope', ctx.scope)
    return `${metadata.authorizationEndpoint}?${params.toString()}`
}

export type ExchangedToken = { accessToken: string; refreshToken?: string; expiresAt?: number; scope?: string }

export async function exchangeCode(ctx: OAuthContext, code: string): Promise<ExchangedToken> {
    const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: ctx.redirectUri,
        client_id: ctx.clientId,
        code_verifier: ctx.verifier,
        resource: ctx.mcpUrl,
    })
    const clientSecret = clientSecretFor(ctx)
    if (clientSecret) body.set('client_secret', clientSecret)
    const res = await fetchPublic(ctx.tokenEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: body.toString(),
    })
    if (!res.ok) {
        const detail = await res.text().catch(() => '')
        throw new Error(`token exchange failed (${res.status})${detail ? `: ${detail.slice(0, 200)}` : ''}`)
    }
    const data = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string }
    if (!data.access_token) throw new Error('no access_token in response')
    return {
        accessToken: data.access_token,
        refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : undefined,
        expiresAt: typeof data.expires_in === 'number' ? Date.now() + data.expires_in * 1000 : undefined,
        scope: typeof data.scope === 'string' ? data.scope : undefined,
    }
}

export function encodeContext(ctx: OAuthContext): string {
    return sealContext(ctx)
}

export function decodeContext(raw: string): OAuthContext {
    return openContext<OAuthContext>(raw)
}
