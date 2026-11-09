import { clientConfigSchema } from '@rerun/contracts'

import { ApiError, clientHeader, createApiClient } from '@/api/client'
import type { CustomServer } from '@/config/custom-server'

export type ServerProblem = 'invalid' | 'insecure' | 'unreachable' | 'not-rerun' | 'outdated'

export type ServerOrigin = { ok: true; origin: string } | { ok: false; problem: ServerProblem }

export type ServerLookup = { ok: true; server: CustomServer } | { ok: false; problem: ServerProblem }

const LOOKUP_TIMEOUT_MS = 10_000

function isPrivateIpv4(host: string): boolean {
    const parts = host.split('.').map(Number)
    if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false
    const [a, b] = parts
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127)
}

// The only places iOS lets the app speak plain HTTP to: the person's own network, a Tailscale address
// included, never the open internet.
export function isLocalNetworkHost(host: string): boolean {
    const name = host.toLowerCase()
    if (name === 'localhost' || name.endsWith('.local')) return true
    if (!name.includes('.') && !name.includes(':')) return true
    return isPrivateIpv4(name)
}

export function normalizeServerUrl(input: string): ServerOrigin {
    const typed = input.trim()
    if (!typed) return { ok: false, problem: 'invalid' }

    const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(typed)
    let url: URL
    try {
        url = new URL(hasScheme ? typed : `http://${typed}`)
    } catch {
        return { ok: false, problem: 'invalid' }
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, problem: 'invalid' }
    if (!url.hostname) return { ok: false, problem: 'invalid' }

    const local = isLocalNetworkHost(url.hostname)
    if (!hasScheme) url.protocol = local ? 'http:' : 'https:'
    if (url.protocol === 'http:' && !local) return { ok: false, problem: 'insecure' }
    return { ok: true, origin: url.origin }
}

function reachableOverHttp(url: string): boolean {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' || isLocalNetworkHost(parsed.hostname)
}

type Request = (path: string, init: { signal: AbortSignal }) => Promise<unknown>

// Asks a hub how a phone signs in to it. An address that answers but is not a Rerun hub, or is one
// from before the app could pick a server, is told apart from one that does not answer at all.
export async function lookUpServer(origin: string, request: Request = createApiClient({ baseUrl: origin, clientHeader })): Promise<ServerLookup> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS)
    let payload: unknown
    try {
        payload = await request('/api/v1/client', { signal: controller.signal })
    } catch (error) {
        return { ok: false, problem: error instanceof ApiError ? 'not-rerun' : 'unreachable' }
    } finally {
        clearTimeout(timer)
    }

    const config = clientConfigSchema.safeParse(payload)
    if (!config.success) return { ok: false, problem: 'not-rerun' }
    if (!config.data.server) return { ok: false, problem: 'outdated' }
    if (!reachableOverHttp(config.data.server.supabaseUrl)) return { ok: false, problem: 'insecure' }
    return { ok: true, server: { apiUrl: origin, ...config.data.server } }
}

export const SERVER_PROBLEMS: Record<ServerProblem, string> = {
    invalid: 'Enter the address of your Rerun server.',
    insecure: 'Use https:// outside your local network.',
    unreachable: 'Could not reach this server.',
    'not-rerun': 'This address is not a Rerun server.',
    outdated: 'Update this Rerun server to use it from the app.',
}
