import { describe, expect, it } from 'vitest'
import { cleanMessage, routeMessage, type ChannelBinding, type SlackRouting } from './slack.service'

function binding(name: string, agentId: string): ChannelBinding {
    return { id: `b-${agentId}`, channelId: 'C1', channelName: 'mdc-code', agentId, engineAgentId: `e-${agentId}`, disabled: false, name, identity: { name } }
}

const ENGINEER_1 = binding('engineer-1', 'a1')
const ENGINEER_2 = binding('engineer-2', 'a2')
const BOTH = [ENGINEER_1, ENGINEER_2]
const BOT = 'U_RERUN'

function answered(routing: SlackRouting): string | null {
    return routing.kind === 'answer' ? routing.binding.agentId : null
}

// The scenarios a channel lives through, so a coworker answers like a person would: when spoken
// to, never into a conversation between people.
describe('routeMessage', () => {
    describe('a coworker is named', () => {
        it('takes the coworker named at the start', () => {
            expect(answered(routeMessage({ bindings: BOTH, text: 'engineer-2 draft the release notes', botUserId: BOT }))).toBe('a2')
        })

        it('reads an @ in front of the name, the way people type it', () => {
            expect(answered(routeMessage({ bindings: BOTH, text: 'hey @engineer-1, the build is red', botUserId: BOT }))).toBe('a1')
        })

        it('a named coworker beats everything: a person mentioned beside it, a foreign thread', () => {
            expect(answered(routeMessage({ bindings: BOTH, text: 'engineer-1 pair with <@U_JAHIR> on this', botUserId: BOT }))).toBe('a1')
            expect(answered(routeMessage({ bindings: BOTH, text: 'engineer-2 can you summarize?', inForeignThread: true, botUserId: BOT }))).toBe('a2')
        })

        it('does not match a name buried inside a longer word', () => {
            expect(routeMessage({ bindings: BOTH, text: 'the engineer-10 branch is broken', botUserId: BOT }).kind).toBe('silent')
        })

        it('survives a coworker whose name holds regex characters', () => {
            const odd = binding('c++ (legacy)', 'a3')
            expect(answered(routeMessage({ bindings: [odd, ENGINEER_1], text: 'c++ (legacy) what broke?', botUserId: BOT }))).toBe('a3')
        })
    })

    describe('inside a thread', () => {
        it('stays with the coworker already holding the thread, no name needed', () => {
            expect(answered(routeMessage({ bindings: BOTH, text: 'and in Spanish?', threadAgentId: 'a2', botUserId: BOT }))).toBe('a2')
        })

        it('lets a thread be handed to the other coworker by naming them', () => {
            expect(answered(routeMessage({ bindings: BOTH, text: 'engineer-1 can you take this one', threadAgentId: 'a2', botUserId: BOT }))).toBe('a1')
        })

        it('stays out of a thread the coworkers never answered in', () => {
            expect(routeMessage({ bindings: [ENGINEER_1], text: 'I agree, ship it', inForeignThread: true, botUserId: BOT }).kind).toBe('silent')
        })

        it('goes quiet when the thread owner was unbound from the channel meanwhile', () => {
            expect(routeMessage({ bindings: [ENGINEER_1], text: 'any update?', threadAgentId: 'a9', inForeignThread: false, botUserId: BOT }).kind).toBe('silent')
        })

        it('steps back even in its own thread when a person is pulled in', () => {
            expect(routeMessage({ bindings: BOTH, text: 'thanks — <@U_JAHIR> can you review?', threadAgentId: 'a2', botUserId: BOT }).kind).toBe('silent')
        })
    })

    describe('people talking to each other', () => {
        it('stays silent when a person is mentioned, even with a single coworker in the channel', () => {
            expect(routeMessage({ bindings: [ENGINEER_1], text: 'Mira ese ultimo thread <@U_JAHIR>', botUserId: BOT }).kind).toBe('silent')
        })

        it('stays silent when several coworkers are bound and nobody was named', () => {
            expect(routeMessage({ bindings: BOTH, text: 'who can look at the build?', botUserId: BOT }).kind).toBe('silent')
        })
    })

    describe('the app itself is mentioned', () => {
        it('asks who should take it when several could', () => {
            expect(routeMessage({ bindings: BOTH, text: '<@U_RERUN> can someone look at the build?', botUserId: BOT }).kind).toBe('ask_who')
        })

        it('answers with the single coworker, no ceremony', () => {
            expect(answered(routeMessage({ bindings: [ENGINEER_1], text: '<@U_RERUN> the build is red', botUserId: BOT }))).toBe('a1')
        })

        it('answers with the thread owner inside its own thread', () => {
            expect(answered(routeMessage({ bindings: BOTH, text: '<@U_RERUN> any update?', threadAgentId: 'a2', botUserId: BOT }))).toBe('a2')
        })

        it('being explicitly called beats a person mentioned in the same breath', () => {
            expect(routeMessage({ bindings: BOTH, text: '<@U_RERUN> help <@U_JAHIR> with the deploy', botUserId: BOT }).kind).toBe('ask_who')
        })
    })

    describe('alone in the channel', () => {
        it('answers a plain top-level message: it is the only one there to answer', () => {
            expect(answered(routeMessage({ bindings: [ENGINEER_1], text: 'the build is red', botUserId: BOT }))).toBe('a1')
        })
    })
})

describe('cleanMessage', () => {
    it('drops the app mention Slack sends as an id', () => {
        expect(cleanMessage('<@U123> engineer-1 what broke?', 'engineer-1')).toBe('what broke?')
    })

    it('drops the leading name and its punctuation', () => {
        expect(cleanMessage('engineer-1: what broke?', 'engineer-1')).toBe('what broke?')
        expect(cleanMessage('engineer-1, what broke?', 'engineer-1')).toBe('what broke?')
        expect(cleanMessage('@engineer-1 — what broke?', 'engineer-1')).toBe('what broke?')
    })

    it('keeps the name when it is part of the sentence', () => {
        expect(cleanMessage('ask engineer-1 about the build', 'engineer-1')).toBe('ask engineer-1 about the build')
    })
})
