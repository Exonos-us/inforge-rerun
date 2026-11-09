import { z } from 'zod'

export const CLIENT_HEADER = 'x-rerun-client'

export type ClientIdentity = { platform: 'ios'; version: string; build: number }

export function formatClientHeader({ platform, version, build }: ClientIdentity): string {
    return `${platform}/${version} (${build})`
}

// The Supabase project a hub signs people in with, as a phone reaches it. Optional because hubs from
// before self-hosted servers could be picked in the app do not send it.
export const clientServerSchema = z.object({
    supabaseUrl: z.url(),
    supabasePublishableKey: z.string().min(1),
})
export type ClientServer = z.infer<typeof clientServerSchema>

// A binary older than minBuild cannot follow the hub any more and must be updated from the App Store.
export const clientConfigSchema = z.object({
    minBuild: z.number().int().nonnegative(),
    server: clientServerSchema.optional(),
})
export type ClientConfig = z.infer<typeof clientConfigSchema>
