import type { ModelMessage } from 'ai'
import { describe, expect, it } from 'vitest'
import { createScreenshotStore, stepWithScreenshots, withScreenshots } from './screenshots.js'

const picture = (label: string) => ({ image: Buffer.from(label), mediaType: 'image/jpeg' })

const toolResult = (toolCallId: string, value: unknown): ModelMessage => ({
    role: 'tool',
    content: [{ type: 'tool-result', toolCallId, toolName: 'computer', output: { type: 'json', value: value as never } }],
})

describe('screenshot store', () => {
    it('hands back what it was given under the id it returned', () => {
        const store = createScreenshotStore()
        const id = store.add(picture('one'))
        expect(store.get(id)?.image.toString()).toBe('one')
        expect(store.get('unknown')).toBeUndefined()
    })

    it('keeps six pictures, then drops down to the three latest in one go', () => {
        const store = createScreenshotStore()
        const ids = Array.from({ length: 6 }, (_, index) => store.add(picture(String(index))))
        expect(ids.every(id => store.get(id))).toBe(true)
        const seventh = store.add(picture('6'))
        expect(ids.slice(0, 4).some(id => store.get(id))).toBe(false)
        expect([...ids.slice(4), seventh].every(id => store.get(id))).toBe(true)
    })

    it('keeps as many pictures as it is given, then drops down to half of them', () => {
        const store = createScreenshotStore(2)
        const ids = [store.add(picture('0')), store.add(picture('1'))]
        const third = store.add(picture('2'))
        expect(ids.some(id => store.get(id))).toBe(false)
        expect(store.get(third)).toBeDefined()
    })
})

describe('withScreenshots', () => {
    it('leaves a conversation without screenshots exactly as it is', () => {
        const store = createScreenshotStore()
        const messages: ModelMessage[] = [
            { role: 'user', content: 'hello' },
            toolResult('c1', { status: 'refused', reason: 'no' }),
            toolResult('c2', null),
            { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c3', toolName: 'shell_exec', output: { type: 'text', value: 'ok' } }] },
        ]
        expect(withScreenshots(messages, store, 'tool-result')).toEqual(messages)
        expect(withScreenshots(messages, store, 'user-message')).toEqual(messages)
    })

    it('puts the picture inside the tool result for a provider that reads one there', () => {
        const store = createScreenshotStore()
        const id = store.add(picture('screen'))
        const value = { status: 'done', screenshotId: id, screen: [1280, 720] }
        const [message] = withScreenshots([toolResult('c1', value)], store, 'tool-result')
        expect(message).toEqual({
            role: 'tool',
            content: [
                {
                    type: 'tool-result',
                    toolCallId: 'c1',
                    toolName: 'computer',
                    output: {
                        type: 'content',
                        value: [
                            { type: 'text', text: JSON.stringify(value) },
                            { type: 'image-data', data: Buffer.from('screen').toString('base64'), mediaType: 'image/jpeg' },
                        ],
                    },
                },
            ],
        })
    })

    it('follows the tool message with a user message carrying the picture for a chat-completions provider', () => {
        const store = createScreenshotStore()
        const id = store.add(picture('screen'))
        const result = toolResult('c1', { status: 'done', screenshotId: id })
        const next: ModelMessage = { role: 'assistant', content: 'done' }
        expect(withScreenshots([result, next], store, 'user-message')).toEqual([
            result,
            {
                role: 'user',
                content: [
                    { type: 'text', text: `Screenshot ${id}, your screen as that action left it:` },
                    { type: 'image', image: Buffer.from('screen'), mediaType: 'image/jpeg' },
                ],
            },
            next,
        ])
    })

    it('leaves a result whose picture was dropped as the text it always was', () => {
        const store = createScreenshotStore()
        const stale = store.add(picture('old'))
        for (let i = 0; i < 6; i++) store.add(picture(String(i)))
        const messages = [toolResult('c1', { status: 'done', screenshotId: stale })]
        expect(withScreenshots(messages, store, 'tool-result')).toEqual(messages)
    })

    it('only touches the results that name a picture when a step ran several tools', () => {
        const store = createScreenshotStore()
        const id = store.add(picture('screen'))
        const message: ModelMessage = {
            role: 'tool',
            content: [
                { type: 'tool-result', toolCallId: 'c1', toolName: 'shell_exec', output: { type: 'text', value: 'ok' } },
                { type: 'tool-result', toolCallId: 'c2', toolName: 'computer', output: { type: 'json', value: { screenshotId: id } } },
            ],
        }
        const [out] = withScreenshots([message], store, 'tool-result') as Array<Extract<ModelMessage, { role: 'tool' }>>
        expect(out!.content[0]).toEqual(message.content[0])
        expect((out!.content[1] as { output: { type: string } }).output.type).toBe('content')
    })
})

describe('stepWithScreenshots', () => {
    it('changes nothing in a run that never looked at a screen', () => {
        expect(stepWithScreenshots([{ role: 'user', content: 'hello' }], undefined, 'anthropic')).toEqual({})
    })

    it.each([
        ['anthropic', 'tool'],
        ['openai', 'tool'],
        ['google', 'tool'],
        ['rerun', 'user'],
        ['openrouter', 'user'],
    ] as const)('hands %s its picture in a %s message', (provider, role) => {
        const store = createScreenshotStore()
        const messages = [toolResult('c1', { screenshotId: store.add(picture('screen')) })]
        expect(stepWithScreenshots(messages, store, provider).messages!.at(-1)!.role).toBe(role)
    })

    it.each([
        ['go/claude-haiku-5-5', 'tool'],
        ['go/gpt-6-luna', 'tool'],
        ['go/gemini-4-argon', 'tool'],
        ['go/kimi-k3.1-pro', 'user'],
    ] as const)('hands OpenCode %s its picture the way its format takes it, in a %s message', (model, role) => {
        const store = createScreenshotStore()
        const messages = [toolResult('c1', { screenshotId: store.add(picture('screen')) })]
        expect(stepWithScreenshots(messages, store, 'opencode', model).messages!.at(-1)!.role).toBe(role)
    })

    // OpenCode drops an image sent to a model that cannot see without a word.
    it('never attaches a picture for an OpenCode model without vision', () => {
        const store = createScreenshotStore()
        const messages = [toolResult('c1', { screenshotId: store.add(picture('screen')) })]
        expect(stepWithScreenshots(messages, store, 'opencode', 'go/deepseek-v4-pro')).toEqual({})
    })
})
