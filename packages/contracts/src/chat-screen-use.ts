import { parseHitlReply } from './chat-hitl.js'
import { stripBridgePrefix } from './chat-tool-name.js'
import { parseHubOutput } from './tool-output.js'

// `type_secret` is a tool of its own on runs that get the provider-native computer toolset.
const SCREEN_TOOLS = new Set(['computer', 'computer_open_app', 'type_secret'])
const NAVIGATE_TOOL = 'browser_navigate'

type ToolPart = { type: string; toolName?: string; input?: unknown; output?: unknown; text?: string }
type MessageLike = { id?: string; role: string; parts: readonly { type: string }[] }

const toolNameOf = (part: ToolPart) => stripBridgePrefix(part.toolName ?? (part.type.startsWith('tool-') ? part.type.slice('tool-'.length) : ''))

const textOf = (message: MessageLike) => (message.parts as readonly ToolPart[]).map(part => (part.type === 'text' ? (part.text ?? '') : '')).join('')

// The run the thread is in: everything since the person last wrote. Answering a block the run asked
// (a takeover handed back, a question) resumes that same run, so it does not start a new one.
export function currentRunMessages<M extends MessageLike>(messages: readonly M[]): readonly M[] {
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'user' && !parseHitlReply(textOf(messages[i]))) return messages.slice(i + 1)
    }
    return messages
}

const runParts = (messages: readonly MessageLike[]) => currentRunMessages(messages).flatMap(message => message.parts as readonly ToolPart[])

export function runUsesScreen(messages: readonly MessageLike[]): boolean {
    return runParts(messages).some(part => SCREEN_TOOLS.has(toolNameOf(part)))
}

// The result arrives in whatever wrapper the path put around it: the plain value live, an AI-SDK
// envelope on reload, a JSON text from a CLI bridge. parseHubOutput unwraps them all.
function screenSessionOf(output: unknown): string | null {
    const id = parseHubOutput<{ screenSession?: unknown }>(output)?.screenSession
    return typeof id === 'string' ? id : null
}

function sessionsOfParts(parts: readonly ToolPart[]): string[] {
    const sessions = new Set<string>()
    for (const part of parts) {
        if (!SCREEN_TOOLS.has(toolNameOf(part))) continue
        const id = screenSessionOf(part.output)
        if (id) sessions.add(id)
    }
    return [...sessions]
}

// The screen sessions each turn worked in, keyed by the id of the turn's last assistant message:
// under that message the chat shows the "screen activity" card replaying them. A turn is everything
// since a user message, like paidDataSourcesByTurn.
export function screenSessionsByTurn(messages: readonly MessageLike[]): Map<string, string[]> {
    const byTurn = new Map<string, string[]>()
    let turn: ToolPart[] = []
    let lastAssistantId: string | null = null
    const close = () => {
        const sessions = lastAssistantId ? sessionsOfParts(turn) : []
        if (sessions.length && lastAssistantId) byTurn.set(lastAssistantId, sessions)
        turn = []
        lastAssistantId = null
    }
    for (const message of messages) {
        if (message.role === 'user') {
            close()
            continue
        }
        if (message.role !== 'assistant') continue
        turn.push(...(message.parts as readonly ToolPart[]))
        if (message.id) lastAssistantId = message.id
    }
    close()
    return byTurn
}

// Read by hand: React Native's `URL` has no `hostname`. Userinfo and port are set aside, so
// `https://stripe.com@evil.example/` names `evil.example` and nothing else.
const URL_HOST = /^[a-z][a-z\d+.-]*:\/\/(?:[^@/?#]*@)?([^/?#:]+)/i

export function siteOf(url: string): string | null {
    const host = url.match(URL_HOST)?.[1]
    return host ? host.toLowerCase().replace(/^www\./, '') : null
}

const BARE_HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/

// A site label as people and agents write it: a bare host ("github.com"), with www, with a path,
// or a full URL. Null when nothing that names a site is left.
export function normalizeSite(value: string): string | null {
    const trimmed = value.trim().toLowerCase()
    if (!trimmed) return null
    const fromUrl = siteOf(trimmed)
    if (fromUrl) return fromUrl
    const host = trimmed.replace(/^www\./, '').replace(/[/?#].*$/, '')
    return BARE_HOST.test(host) ? host : null
}

// Cookie-style scope: a secret saved for github.com types on accounts.github.com too, never the
// other way round, and never on not-github.com.
export function siteMatches(saved: string, current: string): boolean {
    return current === saved || current.endsWith(`.${saved}`)
}

// The site the screen is on, as far as the thread can tell: the one a takeover asks for, otherwise the
// last page the run opened in its browser.
export function screenSite(messages: readonly MessageLike[], takeoverUrl: string | null): string | null {
    if (takeoverUrl) return siteOf(takeoverUrl)
    const navigation = runParts(messages).findLast(part => toolNameOf(part) === NAVIGATE_TOOL)
    const url = (navigation?.input as { url?: unknown } | undefined)?.url
    return typeof url === 'string' ? siteOf(url) : null
}
