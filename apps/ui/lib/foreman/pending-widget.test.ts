import type { UIMessage } from 'ai'
import { describe, expect, it } from 'vitest'

import { findPendingEngineHitl, findPendingWidget, isEngineHitl, keepsComposer, resumesAfterAnswer } from './pending-widget'

const assistant = (parts: unknown[]): UIMessage => ({ id: 'm1', role: 'assistant', parts }) as UIMessage
const user = (): UIMessage => ({ id: 'm2', role: 'user', parts: [{ type: 'text', text: 'never mind' }] }) as UIMessage

const asking = [{ type: 'tool-ask_choice', toolCallId: 'c1', state: 'input-available', input: { question: 'Which one?' } }]

describe('findPendingWidget', () => {
    it('finds the widget waiting on an answer', () => {
        expect(findPendingWidget([assistant(asking)], 'ready')).toEqual({ toolName: 'ask_choice', toolCallId: 'c1', input: { question: 'Which one?' } })
    })

    it('holds nothing back while the turn is still running', () => {
        expect(findPendingWidget([assistant(asking)], 'streaming')).toBeNull()
        expect(findPendingWidget([assistant(asking)], 'submitted')).toBeNull()
    })

    it('lets go once the widget is answered', () => {
        expect(findPendingWidget([assistant([{ type: 'tool-ask_choice', toolCallId: 'c1', state: 'output-available', output: { answered: true } }])], 'ready')).toBeNull()
    })

    // Typing over a widget seals it, but the seal and the send land in the same tick: the user
    // message is what says the question is behind us.
    it('lets go once the user has spoken after it', () => {
        expect(findPendingWidget([assistant(asking), user()], 'ready')).toBeNull()
    })

    it('ignores a tool that is not a widget', () => {
        expect(findPendingWidget([assistant([{ type: 'tool-create_agent', toolCallId: 'c1', state: 'input-available', input: {} }])], 'ready')).toBeNull()
    })

    // A call the provider refused has no input to render and nothing to answer, so the composer
    // has to stay rather than hand over to an empty widget.
    it('ignores a widget that errored out', () => {
        expect(findPendingWidget([assistant([{ type: 'tool-ask_input', toolCallId: 'c1', state: 'output-error', errorText: 'boom' }])], 'ready')).toBeNull()
    })

    it('takes the last widget of the message when several were called', () => {
        const parts = [
            { type: 'tool-show_templates', toolCallId: 'c1', state: 'output-available', output: { answered: false } },
            { type: 'tool-show_plan', toolCallId: 'c2', state: 'input-available', input: { title: 'Your team', items: [] } },
        ]
        expect(findPendingWidget([assistant(parts)], 'ready')).toMatchObject({ toolName: 'show_plan', toolCallId: 'c2' })
    })
})

describe('isEngineHitl', () => {
    it('reads the two questions the engine foreman stops on', () => {
        expect(isEngineHitl('ask_user')).toBe(true)
        expect(isEngineHitl('request_approval')).toBe(true)
    })

    it('leaves the hub widgets where they streamed in', () => {
        expect(isEngineHitl('ask_choice')).toBe(false)
        expect(isEngineHitl('show_plan')).toBe(false)
    })
})

describe('keepsComposer', () => {
    it('keeps the composer under the hand-off to the team and the starter pack only', () => {
        expect(keepsComposer({ toolName: 'open_checkout', toolCallId: 'c1', input: {} })).toBe(false)
        expect(keepsComposer({ toolName: 'contact_team', toolCallId: 'c1', input: {} })).toBe(true)
        expect(keepsComposer({ toolName: 'show_starter_pack', toolCallId: 'c1', input: {} })).toBe(true)
        expect(keepsComposer({ toolName: 'ask_choice', toolCallId: 'c1', input: {} })).toBe(false)
        expect(keepsComposer({ toolName: 'ask_user', toolCallId: 'c1', input: {} })).toBe(false)
    })
})

describe('findPendingEngineHitl', () => {
    const question = { questions: [{ question: 'Which Box?', options: ['Sales', 'Ops'] }] }

    it('finds the question the engine foreman stopped on', () => {
        const parts = [{ type: 'tool-ask_user', toolCallId: 'h1', state: 'output-available', input: question, output: { status: 'delivered' } }]
        expect(findPendingEngineHitl([assistant(parts)], 'ready')).toEqual({ toolName: 'ask_user', toolCallId: 'h1', input: question })
    })

    // Claude reaches the builtins through the bridged MCP server, which namespaces their names.
    it('reads a bridged call under its plain name', () => {
        const parts = [{ type: 'dynamic-tool', toolName: 'mcp__rerun__request_approval', toolCallId: 'h2', state: 'output-available', input: { approvals: [{ action: 'Delete Scout' }] } }]
        expect(findPendingEngineHitl([assistant(parts)], 'ready')?.toolName).toBe('request_approval')
    })

    it('lets go once the user replied', () => {
        const parts = [{ type: 'tool-ask_user', toolCallId: 'h1', state: 'output-available', input: question }]
        expect(findPendingEngineHitl([assistant(parts), user()], 'ready')).toBeNull()
    })

    it('ignores the hub widgets and a call with nothing to ask', () => {
        expect(findPendingEngineHitl([assistant(asking)], 'ready')).toBeNull()
        expect(findPendingEngineHitl([assistant([{ type: 'tool-ask_user', toolCallId: 'h3', state: 'output-available', input: {} }])], 'ready')).toBeNull()
    })
})

describe('resumesAfterAnswer', () => {
    const checkout = { type: 'tool-open_checkout', toolCallId: 'c2', state: 'output-available', output: { ok: true, status: 'entitled' } }

    it('sends the conversation back once a widget is answered', () => {
        expect(resumesAfterAnswer({ messages: [assistant([{ type: 'step-start' }, checkout])] })).toBe(true)
    })

    it('waits while the widget is still open', () => {
        expect(resumesAfterAnswer({ messages: [assistant([{ type: 'step-start' }, ...asking])] })).toBe(false)
    })

    // The browser's copy of a build never gets the empty step the script closes on.
    it('never sends a finished build back', () => {
        const built = assistant([{ type: 'step-start' }, checkout, { type: 'step-start' }, { type: 'tool-build_team', toolCallId: 'b1', state: 'output-available', output: { agents: [{}] } }, { type: 'data-delegate', id: 'b1', data: { tasks: [] } }])
        expect(resumesAfterAnswer({ messages: [built] })).toBe(false)
    })
})
