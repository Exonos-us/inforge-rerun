// The Slack app a workspace creates for itself, as a manifest. Kept apart from the Web API client
// so the dialog can build the link in the browser, from whatever address the user says Slack
// should call — which is not always the one they are reading the app on: a local install is
// reached at localhost and Slack at a tunnel.

export function appManifest(requestUrl: string, name = 'Rerun'): Record<string, unknown> {
    return {
        display_information: { name, description: 'Your Rerun coworkers, in Slack', background_color: '#1d1c1d' },
        features: { bot_user: { display_name: name, always_online: true } },
        oauth_config: {
            scopes: {
                bot: [
                    'app_mentions:read',
                    'channels:history',
                    'channels:read',
                    // Creating #mdc-code from Rerun.
                    'channels:manage',
                    'groups:history',
                    'groups:read',
                    'groups:write',
                    'im:history',
                    'chat:write',
                    // What lets each coworker answer under its own name and avatar.
                    'chat:write.customize',
                    // Posting what a coworker made: a report, a sheet, a screen recording.
                    'files:write',
                    // Reading one back: what the coworker itself was handed in the channel.
                    'files:read',
                    'users:read',
                    // Finding the hirer by their account email, to invite them into a private
                    // channel the bot just created — otherwise Slack hides it from them.
                    'users:read.email',
                ],
            },
        },
        settings: {
            event_subscriptions: { request_url: requestUrl, bot_events: ['app_mention', 'message.channels', 'message.groups', 'message.im'] },
            org_deploy_enabled: false,
            socket_mode_enabled: false,
        },
    }
}

// Slack's "create an app from a manifest" deep link: the app opens already configured, waiting to
// be created, instead of a page of instructions to follow by hand.
export function createAppUrl(requestUrl: string, name?: string): string {
    return `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(appManifest(requestUrl, name)))}`
}

// A tunnel, a reverse proxy, a real domain — anything but a loopback address, which Slack cannot
// reach from the outside.
export function isReachableFromSlack(url: string): boolean {
    try {
        const parsed = new URL(url)
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false
        return !/^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)$/i.test(parsed.hostname)
    } catch {
        return false
    }
}

// A development tunnel in front of a local install. Named because its URL rotates: when events
// stop arriving, the first suspect is a tunnel that restarted under a new address.
export function isLocalTunnel(url: string): boolean {
    try {
        return /(^|\.)(ngrok(-free)?\.(app|dev|io)|trycloudflare\.com|loca\.lt|localtunnel\.me)$/i.test(new URL(url).hostname)
    } catch {
        return false
    }
}
