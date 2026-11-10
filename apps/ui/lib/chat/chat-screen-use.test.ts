import { describe, expect, it } from 'vitest'

import { runUsesScreen, screenSessionsByTurn, screenSite, serializeTakeoverResult } from '@rerun/contracts'

const user = (text: string) => ({ role: 'user', parts: [{ type: 'text', text }] })
let nextId = 0
const assistant = (...parts: { type: string; toolName?: string; input?: unknown; output?: unknown }[]) => ({ id: `m${++nextId}`, role: 'assistant', parts })
const click = { type: 'tool-computer', input: { action: 'left_click' } }
const navigate = (url: string) => ({ type: 'tool-browser_navigate', input: { url } })

describe('runUsesScreen', () => {
    it('reads only the run since the person last wrote', () => {
        expect(runUsesScreen([user('find them'), assistant(click)])).toBe(true)
        expect(runUsesScreen([user('find them'), assistant(click), user('thanks'), assistant({ type: 'text' })])).toBe(false)
    })

    it('keeps the run going across a takeover handed back', () => {
        expect(runUsesScreen([user('find them'), assistant(click), user(serializeTakeoverResult({ url: 'https://www.linkedin.com/feed/', open: true })), assistant({ type: 'text' })])).toBe(true)
    })

    it('knows the screen tools the CLI bridge prefixed', () => {
        expect(runUsesScreen([user('go'), assistant({ type: 'dynamic-tool', toolName: 'mcp__rerun__computer_open_app' })])).toBe(true)
    })
})

describe('screenSite', () => {
    const messages = [user('go'), assistant(navigate('https://www.pennylane.com/'), click, navigate('https://www.linkedin.com/search/results/people/'))]

    it('names the last site the run opened, without its www', () => {
        expect(screenSite(messages, null)).toBe('linkedin.com')
    })

    it('prefers the site a takeover asks for', () => {
        expect(screenSite(messages, 'https://accounts.google.com/signin')).toBe('accounts.google.com')
    })

    it('has nothing to say about a run that opened no page', () => {
        expect(screenSite([user('go'), assistant(click)], null)).toBeNull()
        expect(screenSite(messages, 'not a url')).toBeNull()
    })
})

describe('screenSessionsByTurn', () => {
    const acted = (session: string) => ({ type: 'tool-computer', input: { action: 'left_click' }, output: { status: 'done', screenSession: session } })

    it('keys each turn by its last assistant message, with the sessions its screen tools named', () => {
        const first = assistant(acted('s1'), acted('s1'))
        const tail = assistant({ type: 'text' })
        const second = assistant(acted('s2'))
        const byTurn = screenSessionsByTurn([user('go'), first, tail, user('again'), second])
        expect(byTurn.get(tail.id)).toEqual(['s1'])
        expect(byTurn.get(first.id)).toBeUndefined()
        expect(byTurn.get(second.id)).toEqual(['s2'])
    })

    it('reads a result whatever wrapped it on the way, and skips outputs that name no session', () => {
        const bridged = assistant({ type: 'dynamic-tool', toolName: 'mcp__rerun__computer', output: JSON.stringify({ status: 'done', screenSession: 's3' }) })
        const reloaded = assistant({ type: 'tool-computer', output: { type: 'json', value: { status: 'done', screenSession: 's4' } } })
        const silent = assistant(click, { type: 'tool-computer', output: 'not json' })
        expect(screenSessionsByTurn([user('go'), bridged]).get(bridged.id)).toEqual(['s3'])
        expect(screenSessionsByTurn([user('go'), reloaded]).get(reloaded.id)).toEqual(['s4'])
        expect(screenSessionsByTurn([user('go'), silent]).size).toBe(0)
    })
})
