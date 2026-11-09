import type { LanguageModelMiddleware } from 'ai'
import { copyFile, mkdir, stat, writeFile } from 'node:fs/promises'
import { extname, resolve } from 'node:path'
import type { FileCard } from '@rerun/contracts'
import { workspaceDir } from '../config/paths.js'

// Codex's own image tool, named by the provider patch. Codex writes the picture under the
// connection's CODEX_HOME, a folder the chat cannot reach, and tells the model it is "already
// displayed to the user": the only way it shows is to copy it into the coworker's workspace and hand
// the chat the same card card_file would.
export const IMAGE_GENERATION_TOOL = 'image_generation'
export const GENERATED_IMAGES_DIR = 'generated-images'

type ImageGenerationItem = {
    id: string
    status?: string
    revisedPrompt?: string | null
    failure?: unknown
    savedPath?: string | null
    result?: string | null
}

type ToolPart = { type: string; id?: string; toolCallId?: string; toolName?: string; delta?: string; input?: string; result?: unknown; preliminary?: boolean; isError?: boolean }

function record(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function imageItem(value: unknown): ImageGenerationItem | null {
    let parsed: unknown = value
    if (typeof value === 'string') {
        try {
            parsed = JSON.parse(value)
        } catch {
            return null
        }
    }
    const item = record(parsed)
    if (!item || typeof item.id !== 'string') return null
    return item as ImageGenerationItem
}

const imageInput = (item: ImageGenerationItem | null): string => JSON.stringify({ prompt: item?.revisedPrompt ?? null })

function failureText(failure: unknown): string {
    if (typeof failure === 'string' && failure) return failure
    const detail = record(failure)
    if (detail && typeof detail.message === 'string') return detail.message
    if (detail) {
        const [kind] = Object.keys(detail)
        if (kind) return kind.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()
    }
    return 'Image generation failed'
}

type ImageExtension = 'png' | 'jpg' | 'gif' | 'webp'

const BASE64_MAGIC: Array<[prefix: string, extension: ImageExtension]> = [
    ['iVBORw0', 'png'],
    ['R0lGOD', 'gif'],
    ['/9j/', 'jpg'],
    ['UklGR', 'webp'],
]

// The extension of the file Codex saved when it names one, the magic bytes of the inline data
// otherwise: the card and the MIME type the hub serves follow the name.
function extensionOf(item: ImageGenerationItem): ImageExtension {
    const saved = item.savedPath ? extname(item.savedPath).slice(1).toLowerCase() : ''
    if (saved === 'jpeg' || saved === 'jpg') return 'jpg'
    if (saved === 'png' || saved === 'gif' || saved === 'webp') return saved
    const data = item.result?.trimStart() ?? ''
    return BASE64_MAGIC.find(([prefix]) => data.startsWith(prefix))?.[1] ?? 'png'
}

const fileSafe = (id: string) => id.replace(/[^a-zA-Z0-9._-]/g, '_') || 'generated_image'

// Copies the picture into the workspace, from the file Codex saved when it is readable, from the
// inline bytes otherwise. The original stays where Codex put it: the model refers to that path for
// a later edit.
export async function saveGeneratedImage(agentId: string, item: ImageGenerationItem): Promise<FileCard> {
    const name = `${fileSafe(item.id)}.${extensionOf(item)}`
    const dir = resolve(workspaceDir(agentId), GENERATED_IMAGES_DIR)
    await mkdir(dir, { recursive: true })
    const target = resolve(dir, name)
    let copied = false
    if (item.savedPath) {
        copied = await copyFile(item.savedPath, target).then(
            () => true,
            () => false
        )
    }
    if (!copied) {
        if (!item.result) throw new Error('Codex returned no image data')
        await writeFile(target, Buffer.from(item.result, 'base64'))
    }
    const { size } = await stat(target)
    return { kind: 'file', files: [{ path: `${GENERATED_IMAGES_DIR}/${name}`, name, size, scope: 'agent' }] }
}

// The provider hands the whole item as the tool input and as its result, inline bytes included: the
// input shrinks to the prompt, the result becomes a file card or an error, so neither the stored
// transcript nor the stream carries a wall of base64. An input delta only names its call id, so the
// ids of the image calls are remembered from their `tool-input-start`.
export async function rewriteImageGenerationPart<Part extends { type: string }>(agentId: string, part: Part, imageCalls: Set<string> = new Set()): Promise<Part> {
    const item = part as Part & ToolPart
    if (item.type === 'tool-input-delta') {
        if (!item.id || !imageCalls.has(item.id) || typeof item.delta !== 'string') return part
        return { ...part, delta: imageInput(imageItem(item.delta)) }
    }
    if (item.toolName !== IMAGE_GENERATION_TOOL) return part
    if (item.type === 'tool-input-start' && item.id) {
        imageCalls.add(item.id)
        return part
    }
    if (item.type === 'tool-call' && typeof item.input === 'string') return { ...part, input: imageInput(imageItem(item.input)) }
    if (item.type !== 'tool-result') return part
    if (item.preliminary) return { ...part, result: {} }
    const generated = imageItem(item.result)
    if (!generated) return part
    if (generated.status === 'failed' || item.isError) return { ...part, result: { error: failureText(generated.failure) }, isError: true }
    try {
        return { ...part, result: await saveGeneratedImage(agentId, generated), isError: false }
    } catch (e) {
        return { ...part, result: { error: `Could not keep the generated image: ${(e as Error).message}` }, isError: true }
    }
}

export function createCodexImageMiddleware(agentId: string): LanguageModelMiddleware {
    return {
        specificationVersion: 'v3',
        async wrapStream({ doStream }) {
            const result = await doStream()
            type Part = typeof result.stream extends ReadableStream<infer P> ? P : never
            const imageCalls = new Set<string>()
            return {
                ...result,
                stream: result.stream.pipeThrough(
                    new TransformStream<Part, Part>({
                        async transform(part, controller) {
                            controller.enqueue(await rewriteImageGenerationPart(agentId, part, imageCalls))
                        },
                    })
                ),
            }
        },
        async wrapGenerate({ doGenerate }) {
            const result = await doGenerate()
            const imageCalls = new Set<string>()
            const content = []
            for (const part of result.content) content.push(await rewriteImageGenerationPart(agentId, part, imageCalls))
            return { ...result, content }
        },
    }
}
