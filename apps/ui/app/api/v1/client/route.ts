import { apiRoute } from '@/app/api/v1/_lib/api-route'
import type { ClientConfig, ClientServer } from '@rerun/contracts'

export const dynamic = 'force-dynamic'

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

function minIosBuild(): number {
    const build = Number.parseInt(process.env.MOBILE_IOS_MIN_BUILD ?? '', 10)
    return Number.isInteger(build) && build > 0 ? build : 0
}

// The Host header, not req.url: Next rebuilds req.url on the address it listens on.
function hostnameReached(req: Request): string {
    const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host')
    return host ? new URL(`http://${host.split(',')[0].trim()}`).hostname : new URL(req.url).hostname
}

// A hub next to a local Supabase knows it as localhost, which on a phone is the phone itself: the
// phone reaches that Supabase on the machine it reached the hub on, at the same port.
function supabaseUrlSeenFrom(req: Request, supabaseUrl: string): string {
    const url = new URL(supabaseUrl)
    if (!LOOPBACK_HOSTS.has(url.hostname)) return supabaseUrl.replace(/\/+$/, '')
    url.hostname = hostnameReached(req)
    return url.origin
}

function serverOf(req: Request): ClientServer | undefined {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
    const supabasePublishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
    if (!supabaseUrl || !supabasePublishableKey) return undefined
    return { supabaseUrl: supabaseUrlSeenFrom(req, supabaseUrl), supabasePublishableKey }
}

export const GET = apiRoute({ auth: 'public' }, async ({ req }): Promise<ClientConfig> => ({ minBuild: minIosBuild(), server: serverOf(req) }))
