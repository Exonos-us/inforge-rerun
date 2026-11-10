import { createAnthropic, anthropic } from '@ai-sdk/anthropic'
import { stepCountIs, streamText, type ToolSet } from 'ai'
import { describe, expect, it } from 'vitest'
import { createScreenshotStore } from '../runtime/screenshots.js'
import { stepWithScreenshots } from '../runtime/screenshots.js'

type SentBody = {
    tools?: Array<{ name?: string; type?: string; configs?: unknown }>
    messages: Array<{ role: string; content: Array<Record<string, unknown>> | string }>
}

const sse = (events: object[]) => events.map(event => `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`).join('')

const messageStart = { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }
const messageEnd = (stopReason: string) => [
    { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 20 } },
    { type: 'message_stop' },
]

// What the Claude API streams for a computer toolset member call: its own tool_use block whose
// `name` is the member and whose `toolset_name` is `computer`.
const clickTurn = sse([
    messageStart,
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'left_click', toolset_name: 'computer', input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"coordinate":[500,300]}' } },
    { type: 'content_block_stop', index: 0 },
    ...messageEnd('tool_use'),
])

const doneTurn = sse([
    messageStart,
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Clicked.' } },
    { type: 'content_block_stop', index: 0 },
    ...messageEnd('end_turn'),
])

// Pins what the native computer path relies the pinned @ai-sdk/anthropic on: the toolset entry goes
// out typed (no name, no display size), a member call comes back as one `computer` tool call with
// the member folded into `action`, and the next request echoes `toolset_name` on both the replayed
// tool_use and the tool_result, the screenshot attached as an image block.
describe('the Anthropic computer toolset through the AI SDK', () => {
    it('round-trips a member call onto one executor and echoes toolset_name with the screenshot', async () => {
        const sent: SentBody[] = []
        const turns = [clickTurn, doneTurn]
        const provider = createAnthropic({
            apiKey: 'test',
            fetch: async (_input, init) => {
                sent.push(JSON.parse(String(init?.body)) as SentBody)
                return new Response(turns[sent.length - 1], { headers: { 'content-type': 'text/event-stream' } })
            },
        })

        const store = createScreenshotStore()
        const executed: unknown[] = []
        const tools = {
            computer: anthropic.tools.computerToolset_20260801({
                configs: { cursor_position: { enabled: false } },
                execute: async (input: unknown) => {
                    executed.push(input)
                    return { status: 'done', screen: [1280, 720], screenshotId: store.add({ image: Buffer.from('jpeg-bytes'), mediaType: 'image/jpeg' }) }
                },
            }),
        } as ToolSet

        const result = streamText({
            model: provider('claude-opus-5-5'),
            prompt: 'Click the button.',
            tools,
            stopWhen: stepCountIs(2),
            prepareStep: ({ messages }) => stepWithScreenshots(messages, store, 'anthropic', 'claude-opus-5-5'),
        })
        await result.consumeStream()

        expect(sent).toHaveLength(2)
        expect(sent[0].tools).toEqual([{ type: 'computer_toolset_20260801', configs: { cursor_position: { enabled: false } } }])
        expect(executed).toEqual([{ action: 'left_click', coordinate: [500, 300] }])

        const replayed = sent[1].messages.flatMap(m => (Array.isArray(m.content) ? m.content : []))
        expect(replayed).toContainEqual(expect.objectContaining({ type: 'tool_use', name: 'left_click', toolset_name: 'computer', input: { coordinate: [500, 300] } }))
        const toolResult = replayed.find(part => part.type === 'tool_result') as { toolset_name?: string; content: Array<{ type: string; source?: { data?: string } }> }
        expect(toolResult.toolset_name).toBe('computer')
        expect(toolResult.content.map(part => part.type)).toEqual(['text', 'image'])
        expect(toolResult.content[1].source?.data).toBe(Buffer.from('jpeg-bytes').toString('base64'))
        expect(await result.text).toBe('Clicked.')
    })
})
