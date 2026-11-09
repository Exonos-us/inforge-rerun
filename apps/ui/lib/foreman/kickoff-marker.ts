// The foreman speaks first during onboarding, and a turn only starts from a user message. So the
// browser sends one the user never wrote: a marker, hidden from the stack the way an attachment
// marker is, and kept out of the conversation title.
//
// The marker is also what carries what the user arrived with. An opened link is not a workspace
// fact, so writing it to the profile would be the stored state machine this module refuses; the
// transcript, on the other hand, is already persisted, so every turn re-derives the intent from it
// exactly as the phase is re-derived from the database.

import { readHeroAgentApps, readHeroAgentName } from '@/lib/onboarding/hero-handoff'

export const KICKOFF_MARKER = '[[foreman:start]]'

// A prompt comes with what the landing composer read in it, when it read anything: the name it gave
// the agent and the catalogue slugs of its apps.
export type PromptIntent = { kind: 'prompt'; text: string; name?: string; apps?: string[] }

export type KickoffIntent = { kind: 'template'; slug: string } | { kind: 'share'; token: string } | PromptIntent

const OPEN = '[[foreman:start'
const CLOSE = ']]'

const PROMPT_FIELD = ':prompt'

// The line written in the composer under the welcome card, by someone who already knows the coworker
// they want. It is not an arriving intent: they came in with nothing, and the starter pack step reads
// the line as the one coworker it builds instead of the cards it would have offered (scripted.ts).
const OWN_FIELD = ':own'

// The name is free text too, so it rides the head line as a query string, which escapes the brackets,
// the colons and the newlines a bracketed field cannot hold.
function promptExtras(intent: PromptIntent): string {
    const query = new URLSearchParams()
    if (intent.name) query.set('name', intent.name)
    if (intent.apps?.length) query.set('apps', intent.apps.join(','))
    const extras = query.toString()
    return extras ? `:${extras}` : ''
}

// Read back through the same bounds as the landing link they came from: the transcript is sent by
// the browser, so the marker is no more trusted than the URL was.
function readPromptExtras(field: string): Pick<PromptIntent, 'name' | 'apps'> {
    const query = new URLSearchParams(field.slice(PROMPT_FIELD.length + 1))
    const name = readHeroAgentName(query)
    const apps = readHeroAgentApps(query)
    return { ...(name ? { name } : {}), ...(apps.length ? { apps } : {}) }
}

// A prompt carries its payload under the marker rather than inside it: what someone types in the
// landing composer can hold newlines and `]]`, and neither survives a bracketed field.
export function buildKickoffMarker(intent: KickoffIntent | null): string {
    if (!intent) return KICKOFF_MARKER
    if (intent.kind === 'prompt') return `${OPEN}${PROMPT_FIELD}${promptExtras(intent)}${CLOSE}\n${intent.text}`
    return `${OPEN}:${intent.kind}:${intent.kind === 'template' ? intent.slug : intent.token}${CLOSE}`
}

// `null` means "not a kickoff at all"; an intent of `null` inside means "a kickoff with nothing
// attached", which is the ordinary first arrival.
export function parseKickoff(text: string): { intent: KickoffIntent | null } | null {
    const [head, ...rest] = text.trim().split('\n')
    const line = head.trim()
    if (!line.startsWith(OPEN) || !line.endsWith(CLOSE)) return null

    const field = line.slice(OPEN.length, -CLOSE.length)
    if (!field) return { intent: null }
    if (field === PROMPT_FIELD || field.startsWith(`${PROMPT_FIELD}:`)) {
        const body = rest.join('\n').trim()
        return { intent: body ? { kind: 'prompt', text: body, ...readPromptExtras(field) } : null }
    }

    const [, kind, ...value] = field.split(':')
    const payload = value.join(':').trim()
    if (!payload) return { intent: null }
    if (kind === 'template') return { intent: { kind: 'template', slug: payload } }
    if (kind === 'share') return { intent: { kind: 'share', token: payload } }
    return { intent: null }
}

export function buildOwnKickoff(asked: string): string {
    return `${OPEN}${OWN_FIELD}${CLOSE}\n${asked.trim()}`
}

export function readOwnAsk(text: string): string | null {
    const [head, ...rest] = text.trim().split('\n')
    if (head.trim() !== `${OPEN}${OWN_FIELD}${CLOSE}`) return null
    return rest.join('\n').trim() || null
}

export function isKickoffText(text: string): boolean {
    return parseKickoff(text) !== null
}

// What is left of a kickoff message once the marker is taken out: empty for a bare start, and the
// user's own words for a prompt arriving from the landing or a line written under the welcome card,
// which must stay readable in the stack.
export function stripKickoff(text: string): string {
    const parsed = parseKickoff(text)
    if (!parsed) return text
    return parsed.intent?.kind === 'prompt' ? parsed.intent.text : (readOwnAsk(text) ?? '')
}

// The wire form of an intent, for the one place that cannot carry a transcript: the phase probe the
// column runs before its first message. Same grammar as the marker, so there is one format.
export function encodeIntent(intent: KickoffIntent): string {
    return intent.kind === 'prompt' ? 'prompt' : `${intent.kind}:${intent.kind === 'template' ? intent.slug : intent.token}`
}

export function decodeIntent(value: string | null): KickoffIntent | null {
    if (!value) return null
    if (value === 'prompt') return { kind: 'prompt', text: '' }
    const [kind, ...rest] = value.split(':')
    const payload = rest.join(':').trim()
    if (!payload) return null
    if (kind === 'template') return { kind: 'template', slug: payload }
    if (kind === 'share') return { kind: 'share', token: payload }
    return null
}
