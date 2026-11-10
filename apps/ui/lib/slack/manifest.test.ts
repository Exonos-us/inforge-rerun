import { describe, expect, it } from 'vitest'
import { appManifest, createAppUrl, isReachableFromSlack } from './manifest'

describe('appManifest', () => {
    it('asks for the scope that lets each coworker keep its own name', () => {
        const scopes = (appManifest('https://rerun.example.com/api/webhooks/slack') as { oauth_config: { scopes: { bot: string[] } } }).oauth_config.scopes.bot
        expect(scopes).toContain('chat:write.customize')
        expect(scopes).toContain('channels:manage')
    })

    it('points Slack at the address it was given', () => {
        const manifest = appManifest('https://tunnel.example.dev/api/webhooks/slack') as { settings: { event_subscriptions: { request_url: string; bot_events: string[] } } }
        expect(manifest.settings.event_subscriptions.request_url).toBe('https://tunnel.example.dev/api/webhooks/slack')
        expect(manifest.settings.event_subscriptions.bot_events).toContain('app_mention')
    })
})

describe('createAppUrl', () => {
    it('carries the whole manifest in the link, so Slack opens it already configured', () => {
        const url = new URL(createAppUrl('https://rerun.example.com/api/webhooks/slack'))
        expect(url.origin + url.pathname).toBe('https://api.slack.com/apps')
        expect(url.searchParams.get('new_app')).toBe('1')
        expect(JSON.parse(url.searchParams.get('manifest_json') ?? '{}')).toMatchObject({ display_information: { name: 'Rerun' } })
    })
})

describe('isReachableFromSlack', () => {
    it('accepts a real address', () => {
        expect(isReachableFromSlack('https://app.rerun.build/api/webhooks/slack')).toBe(true)
        expect(isReachableFromSlack('https://semiexpansible.ngrok-free.dev/api/webhooks/slack')).toBe(true)
    })

    it('refuses the addresses only this machine can answer', () => {
        expect(isReachableFromSlack('http://localhost:3050/api/webhooks/slack')).toBe(false)
        expect(isReachableFromSlack('http://127.0.0.1:3050/api/webhooks/slack')).toBe(false)
        expect(isReachableFromSlack('http://[::1]:3050/api/webhooks/slack')).toBe(false)
    })

    it('refuses what is not a URL at all', () => {
        expect(isReachableFromSlack('')).toBe(false)
        expect(isReachableFromSlack('ngrok-free.dev/api/webhooks/slack')).toBe(false)
        expect(isReachableFromSlack('ftp://example.com/hook')).toBe(false)
    })
})
