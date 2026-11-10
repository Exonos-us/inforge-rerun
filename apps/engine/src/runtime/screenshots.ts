import type { LoadedConnection } from '../connections/types.js'
import { behaviourOf, modelSeesImages } from '../agents/opencode.js'
import type { Provider } from '@rerun/contracts'
import type { ModelMessage } from 'ai'
import { newId } from '../lib/ids.js'
import { env } from '../config/env.js'


export type StoredScreenshot = { image: Buffer; mediaType: string }

export type ScreenshotStore = {
    add: (screenshot: StoredScreenshot) => string
    get: (id: string) => StoredScreenshot | undefined
}

// A tool result is frozen into the conversation the moment it is produced, so a picture put there
// would be stored, replayed and counted as text forever. The result only names its screenshot, the
// pictures live here for the length of the run, and each model call gets the recent ones attached.
// Dropped in one go rather than one per step: every eviction rewrites the prompt from that picture
// on, and a provider's prefix cache only survives when that happens rarely.
export function createScreenshotStore(maxKept: number = env().RERUN_COMPUTER_SCREENSHOTS_IN_CONTEXT): ScreenshotStore {
    const keptAfterEviction = Math.ceil(maxKept / 2)
    const kept = new Map<string, StoredScreenshot>()
    return {
        add: screenshot => {
            const id = newId()
            kept.set(id, screenshot)
            if (kept.size > maxKept) for (const stale of [...kept.keys()].slice(0, kept.size - keptAfterEviction)) kept.delete(stale)
            return id
        },
        get: id => kept.get(id),
    }
}

// A chat-completions tool message is text only: a provider speaking that format gets the picture
// in a user message right after it.
export type ScreenshotDelivery = 'tool-result' | 'user-message'
const CHAT_COMPLETIONS_PROVIDERS = new Set<Provider>(['rerun', 'openrouter', 'custom'])

type ToolResultPart = Extract<Exclude<Extract<ModelMessage, { role: 'tool' }>['content'][number], { type: 'tool-approval-response' }>, { type: 'tool-result' }>

function screenshotOf(part: { type: string }, store: ScreenshotStore): { id: string; screenshot: StoredScreenshot; result: unknown } | null {
    if (part.type !== 'tool-result') return null
    const { output } = part as ToolResultPart
    if (output.type !== 'json') return null
    const id = (output.value as { screenshotId?: unknown } | null)?.screenshotId
    if (typeof id !== 'string') return null
    const screenshot = store.get(id)
    return screenshot ? { id, screenshot, result: output.value } : null
}

export function withScreenshots(messages: ModelMessage[], store: ScreenshotStore, delivery: ScreenshotDelivery): ModelMessage[] {
    return messages.flatMap((message): ModelMessage[] => {
        if (message.role !== 'tool') return [message]
        const found = message.content.map(part => screenshotOf(part, store))
        if (found.every(entry => entry === null)) return [message]
        if (delivery === 'user-message') {
            const pictures = found.filter(entry => entry !== null)
            return [
                message,
                {
                    role: 'user',
                    content: pictures.flatMap(({ id, screenshot }) => [
                        { type: 'text' as const, text: `Screenshot ${id}, your screen as that action left it:` },
                        { type: 'image' as const, image: screenshot.image, mediaType: screenshot.mediaType },
                    ]),
                },
            ]
        }
        const content = message.content.map((part, index) => {
            const entry = found[index]
            if (!entry) return part
            return {
                ...(part as ToolResultPart),
                output: {
                    type: 'content' as const,
                    value: [
                        { type: 'text' as const, text: JSON.stringify(entry.result) },
                        { type: 'image-data' as const, data: entry.screenshot.image.toString('base64'), mediaType: entry.screenshot.mediaType },
                    ],
                },
            }
        })
        return [{ ...message, content }]
    })
}

// A model that cannot see never gets the picture: OpenCode would drop it without a word, and the
// model would answer about a screen it never saw.
export function stepWithScreenshots(messages: ModelMessage[], store: ScreenshotStore | undefined, provider: Provider, model = '', connection?: LoadedConnection | null): { messages?: ModelMessage[] } {
    if (!store || !modelSeesImages(provider, model, connection)) return {}
    return { messages: withScreenshots(messages, store, CHAT_COMPLETIONS_PROVIDERS.has(behaviourOf(provider, model)) ? 'user-message' : 'tool-result') }
}
