import { describe, expect, it } from 'vitest'
import { cleanMessage, pickBinding, type ChannelBinding } from './slack.service'

function binding(name: string, agentId: string): ChannelBinding {
    return { id: `b-${agentId}`, channelId: 'C1', channelName: 'mdc-code', agentId, engineAgentId: `e-${agentId}`, disabled: false, name, identity: { name } }
}

const ENGINEER_1 = binding('engineer-1', 'a1')
const ENGINEER_2 = binding('engineer-2', 'a2')
const BOTH = [ENGINEER_1, ENGINEER_2]

describe('pickBinding', () => {
    it('takes the coworker named at the start', () => {
        expect(pickBinding(BOTH, 'engineer-2 draft the release notes')?.agentId).toBe('a2')
    })

    it('reads an @ in front of the name, the way people type it', () => {
        expect(pickBinding(BOTH, 'hey @engineer-1, the build is red')?.agentId).toBe('a1')
    })

    it('needs no name in a channel with a single coworker', () => {
        expect(pickBinding([ENGINEER_1], 'the build is red')?.agentId).toBe('a1')
    })

    it('stays with the coworker already in the thread', () => {
        expect(pickBinding(BOTH, 'and in Spanish?', 'a2')?.agentId).toBe('a2')
    })

    it('lets a thread be handed to the other coworker by naming them', () => {
        expect(pickBinding(BOTH, 'engineer-1 can you take this one', 'a2')?.agentId).toBe('a1')
    })

    it('asks rather than guesses when several could answer', () => {
        expect(pickBinding(BOTH, 'who can look at the build?')).toBeNull()
    })

    it('does not match a name buried inside a longer word', () => {
        expect(pickBinding(BOTH, 'the engineer-10 branch is broken')).toBeNull()
    })

    it('survives a coworker whose name holds regex characters', () => {
        const odd = binding('c++ (legacy)', 'a3')
        expect(pickBinding([odd, ENGINEER_1], 'c++ (legacy) what broke?')?.agentId).toBe('a3')
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

    it('leaves a plain message alone', () => {
        expect(cleanMessage('what broke?', 'engineer-1')).toBe('what broke?')
    })
})
