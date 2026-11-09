import type { Environment } from '@/config/environment'

// A build of the open source app points at the hub it was built for: EXPO_PUBLIC_API_URL,
// EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY, read when the bundle is built.
function hubOf(name: Environment['name']): Environment {
    return {
        name,
        apiUrl: process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000',
        supabaseUrl: process.env.EXPO_PUBLIC_SUPABASE_URL ?? 'http://127.0.0.1:54421',
        supabasePublishableKey: process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? '',
    }
}

export const PRODUCTION = hubOf('production')
export const STAGING = hubOf('staging')

// No product analytics unless the build names its own PostHog project.
export const POSTHOG_TOKEN = process.env.EXPO_PUBLIC_POSTHOG_TOKEN ?? ''
