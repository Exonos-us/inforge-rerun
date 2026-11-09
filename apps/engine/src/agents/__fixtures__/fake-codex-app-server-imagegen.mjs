// Stands in for `codex app-server --listen stdio://`: answers the handshake, then answers every turn
// with the image_gen tool of Codex 0.166 (an `imageGeneration` item, started then completed) and a
// short message. FAKE_IMAGE_STATUS=failed makes the generation fail; FAKE_IMAGE_SAVED_PATH names a
// file the item points at, with or without inline bytes (FAKE_IMAGE_INLINE=0 leaves them out).
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const THREAD_ID = 'thread-1'
const TURN_ID = 'turn-1'
const ITEM_ID = 'ig_1'
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const send = message => process.stdout.write(`${JSON.stringify(message)}\n`)
const turn = (status, items = []) => ({ id: TURN_ID, items, status, error: null })

const item = status => {
    const base = { type: 'imageGeneration', id: ITEM_ID, status, revisedPrompt: 'a black ergonomic office chair on a white background', transparentBackground: false, failure: null, generationId: 'gen-1' }
    if (status === 'failed') return { ...base, failure: { message: 'Image generation is not available on this plan' } }
    if (process.env.FAKE_IMAGE_SAVED_PATH) base.savedPath = process.env.FAKE_IMAGE_SAVED_PATH
    if (process.env.FAKE_IMAGE_INLINE === '0') return { ...base, fileId: 'file-1' }
    return { ...base, result: PNG_1PX }
}

createInterface({ input: process.stdin }).on('line', line => {
    const { id, method } = JSON.parse(line)
    if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, `${method}\n`)
    if (method === 'initialize') return send({ id, result: { userAgent: 'codex_cli_rs/0.166.0', capabilities: {} } })
    if (method === 'thread/start' || method === 'thread/resume') return send({ id, result: { thread: { id: THREAD_ID } } })
    if (method !== 'turn/start') {
        // Anything else the engine asks (the config, the models) gets an empty answer rather than a hang.
        if (id !== undefined) send({ id, result: {} })
        return
    }
    const status = process.env.FAKE_IMAGE_STATUS === 'failed' ? 'failed' : 'completed'
    const text = status === 'failed' ? 'I could not generate the image.' : 'Here is the regenerated chair.'
    const message = { type: 'agentMessage', id: 'msg_1', text, phase: null }
    send({ id, result: { turn: turn('inProgress') } })
    send({ method: 'turn/started', params: { threadId: THREAD_ID, turn: turn('inProgress') } })
    send({ method: 'item/started', params: { threadId: THREAD_ID, turnId: TURN_ID, item: item('inProgress') } })
    send({ method: 'item/completed', params: { threadId: THREAD_ID, turnId: TURN_ID, item: item(status) } })
    send({ method: 'item/started', params: { threadId: THREAD_ID, turnId: TURN_ID, item: { ...message, text: '' } } })
    send({ method: 'item/agentMessage/delta', params: { threadId: THREAD_ID, turnId: TURN_ID, itemId: 'msg_1', delta: text } })
    send({ method: 'item/completed', params: { threadId: THREAD_ID, turnId: TURN_ID, item: message } })
    send({ method: 'turn/completed', params: { threadId: THREAD_ID, turn: turn('completed', [item(status), message]) } })
})
