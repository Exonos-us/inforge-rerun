import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

process.env.RERUN_DATA_DIR = mkdtempSync(resolve(tmpdir(), 'rerun-codex-images-'))
process.env.RERUN_API_KEY = ''

const { fileURLToPath } = await import('node:url')
const { stat, readFile } = await import('node:fs/promises')
const { streamText, wrapLanguageModel } = await import('ai')
const { createCodexAppServer } = await import('ai-sdk-provider-codex-cli')
const { fileCardSchema } = await import('@rerun/contracts')
const { describe, expect, it } = await import('vitest')
const { workspaceDir } = await import('../config/paths.js')
const { createCodexImageMiddleware, rewriteImageGenerationPart } = await import('./codex-images.js')

const fakeServer = fileURLToPath(new URL('./__fixtures__/fake-codex-app-server-imagegen.mjs', import.meta.url))
const AGENT = 'chair-designer'
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const JPEG_HEADER = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]).toString('base64')

type Part = { type: string; toolName?: string; input?: unknown; output?: unknown; text?: string; error?: unknown }

async function runTurn(env: Record<string, string>): Promise<Part[]> {
    const provider = createCodexAppServer({ defaultSettings: { codexPath: fakeServer, minCodexVersion: '0.144.0', logger: false, env: { ...process.env, ...env } as Record<string, string> } })
    const model = wrapLanguageModel({ model: provider('gpt-6.1-sol'), middleware: [createCodexImageMiddleware(AGENT)] })
    const parts: Part[] = []
    try {
        const result = streamText({ model, prompt: 'regenerate the jazz chair', onError: ({ error }) => void parts.push({ type: 'error', error }) })
        for await (const part of result.fullStream) parts.push(part as Part)
    } finally {
        await provider.close()
    }
    return parts
}

const imagePart = (parts: Part[], type: string) => parts.find(part => part.type === type && part.toolName === 'image_generation')

describe('Codex image generation reaches the chat', () => {
    it('turns the generated image into a file card in the workspace, without its base64', async () => {
        const parts = await runTurn({})

        const call = imagePart(parts, 'tool-call')
        expect(call?.input).toEqual({ prompt: 'a black ergonomic office chair on a white background' })

        const card = fileCardSchema.parse(imagePart(parts, 'tool-result')?.output)
        expect(card.files).toEqual([{ path: 'generated-images/ig_1.png', name: 'ig_1.png', size: 70, scope: 'agent' }])
        const written = await readFile(resolve(workspaceDir(AGENT), 'generated-images/ig_1.png'))
        expect(written.toString('base64')).toBe(PNG_1PX)

        expect(JSON.stringify(parts)).not.toContain(PNG_1PX)
        expect(parts.filter(part => part.type === 'text-delta').map(part => part.text).join('')).toBe('Here is the regenerated chair.')
        expect(parts.some(part => part.type === 'error')).toBe(false)
    }, 15_000)

    it('copies the file Codex saved when the item carries no inline bytes, and leaves the original in place', async () => {
        const saved = resolve(process.env.RERUN_DATA_DIR!, 'codex-home', 'generated_images', 'thread-1', 'ig_1.png')
        await import('node:fs/promises').then(fs => fs.mkdir(resolve(saved, '..'), { recursive: true }))
        writeFileSync(saved, Buffer.from(PNG_1PX, 'base64'))

        const parts = await runTurn({ FAKE_IMAGE_SAVED_PATH: saved, FAKE_IMAGE_INLINE: '0' })

        const card = fileCardSchema.parse(imagePart(parts, 'tool-result')?.output)
        expect(card.files[0]).toMatchObject({ path: 'generated-images/ig_1.png', size: 70 })
        expect((await stat(saved)).size).toBe(70)
    }, 15_000)

    it('reports a failed generation as a tool error and writes nothing', async () => {
        const parts = await runTurn({ FAKE_IMAGE_STATUS: 'failed' })

        expect(imagePart(parts, 'tool-result')).toBeUndefined()
        expect(imagePart(parts, 'tool-error')?.error).toEqual({ error: 'Image generation is not available on this plan' })
        expect(JSON.stringify(parts)).not.toContain(PNG_1PX)
        expect(parts.filter(part => part.type === 'text-delta').map(part => part.text).join('')).toBe('I could not generate the image.')
    }, 15_000)
})

describe('rewriteImageGenerationPart', () => {
    const item = { type: 'imageGeneration', id: 'ig_2', status: 'completed', revisedPrompt: 'a chair', result: PNG_1PX }

    it('leaves the parts of other tools alone', async () => {
        const part = { type: 'tool-result', toolCallId: 'c', toolName: 'web_search', result: { query: 'chairs' } }
        expect(await rewriteImageGenerationPart(AGENT, part)).toBe(part)
    })

    it('shrinks the input delta of an image call to the prompt, and leaves the others alone', async () => {
        const calls = new Set<string>()
        await rewriteImageGenerationPart(AGENT, { type: 'tool-input-start', id: 'c', toolName: 'image_generation' }, calls)
        expect(await rewriteImageGenerationPart(AGENT, { type: 'tool-input-delta', id: 'c', delta: JSON.stringify(item) }, calls)).toMatchObject({ delta: JSON.stringify({ prompt: 'a chair' }) })
        const other = { type: 'tool-input-delta', id: 'd', delta: JSON.stringify(item) }
        expect(await rewriteImageGenerationPart(AGENT, other, calls)).toBe(other)
    })

    it('keeps the extension of the file Codex saved, jpeg included', async () => {
        const saved = resolve(process.env.RERUN_DATA_DIR!, 'codex-home', 'generated_images', 'thread-2', 'ig_4.jpeg')
        await import('node:fs/promises').then(fs => fs.mkdir(resolve(saved, '..'), { recursive: true }))
        writeFileSync(saved, Buffer.from(JPEG_HEADER, 'base64'))
        const part = { type: 'tool-result', toolCallId: 'c', toolName: 'image_generation', result: { ...item, id: 'ig_4', result: null, savedPath: saved } }
        expect(await rewriteImageGenerationPart(AGENT, part)).toMatchObject({ result: { files: [{ path: 'generated-images/ig_4.jpg', name: 'ig_4.jpg' }] } })
    })

    it('reads the format of inline bytes from their magic header', async () => {
        const part = { type: 'tool-result', toolCallId: 'c', toolName: 'image_generation', result: { ...item, id: 'ig_5', result: JPEG_HEADER } }
        expect(await rewriteImageGenerationPart(AGENT, part)).toMatchObject({ result: { files: [{ path: 'generated-images/ig_5.jpg', name: 'ig_5.jpg' }] } })
    })

    it('keeps the error when the image cannot be written', async () => {
        const part = { type: 'tool-result', toolCallId: 'c', toolName: 'image_generation', result: { ...item, id: 'ig_3', result: null, savedPath: '/nowhere/ig_3.png' } }
        expect(await rewriteImageGenerationPart(AGENT, part)).toMatchObject({ isError: true, result: { error: 'Could not keep the generated image: Codex returned no image data' } })
    })
})
