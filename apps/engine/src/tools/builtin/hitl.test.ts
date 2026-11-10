import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import type { ModelMessage } from 'ai'
import { HITL_ACK, HITL_ACK_CALL_FIRST, approvalSummary, askUserTool, findPendingHitl, hitlAck, hitlStepLacksMessage, hitlTurnIsOver, isHitlToolName, lastStepHasHitlCall, mcpSignInTool, requestApprovalTool, requestSecretTool, requestTakeoverTool, secretSummary, suggestServiceTool, takeoverSummary } from './hitl.js'

function askUserCall(toolCallId: string, toolName = 'ask_user'): ModelMessage {
    return { role: 'assistant', content: [{ type: 'tool-call', toolCallId, toolName, input: { questions: [{ question: 'Which domain?' }] } }] } as unknown as ModelMessage
}

function toolResult(toolCallId: string, output: { type: string; value: string }, toolName = 'ask_user'): ModelMessage {
    return { role: 'tool', content: [{ type: 'tool-result', toolCallId, toolName, output }] } as unknown as ModelMessage
}

const ctxWithCards = (cards: boolean) => ({ agent: { config: { tools: { cards } } } }) as any

function askUserSchema(): z.ZodTypeAny {
    return (askUserTool(ctxWithCards(true)).ask_user as any).inputSchema
}

function suggestServiceSchema(): z.ZodTypeAny {
    return (suggestServiceTool({} as any).suggest_service as any).inputSchema
}

function requestApprovalSchema(): z.ZodTypeAny {
    return (requestApprovalTool({} as any).request_approval as any).inputSchema
}

function requestSecretSchema(): z.ZodTypeAny {
    return (requestSecretTool({} as any).request_secret as any).inputSchema
}

describe('ask_user description', () => {
    const descriptionWith = (cards: boolean) => (askUserTool(ctxWithCards(cards)).ask_user as any).description as string

    it('points at card_file only for a coworker that has the cards tool', () => {
        expect(descriptionWith(true)).toContain('card_file')
        expect(descriptionWith(false)).not.toContain('card_file')
        expect(descriptionWith(false)).toContain('its text in your message.')
    })

    it('wants what it asks about in the turn that asks, even when it was shown before or the card is sent again', () => {
        expect(descriptionWith(false)).toContain('even when you showed it earlier or are asking again')
    })
})

describe('the ack of a card', () => {
    it('asks a bare card for what the question is about, and ends a turn that already wrote it, when the message comes first', () => {
        expect(hitlAck('message-first')).toBe(HITL_ACK)
        expect(HITL_ACK.instruction).toContain('in full what the question is about')
        expect(HITL_ACK.instruction).toContain('If you already did, end your turn now.')
    })

    it('expects the message now, whatever was written before, when the calls come first', () => {
        expect(hitlAck('call-first')).toBe(HITL_ACK_CALL_FIRST)
        expect(HITL_ACK_CALL_FIRST.instruction).toContain('a note written before a call is not shown to them')
        expect(HITL_ACK_CALL_FIRST.instruction).toContain('Write your message now')
        expect(HITL_ACK_CALL_FIRST.instruction).toContain('in full what the card asks about')
        expect(HITL_ACK_CALL_FIRST.instruction).not.toContain('If you already did')
        expect(HITL_ACK_CALL_FIRST.instruction).not.toContain('If you wrote nothing')
    })

    it.each([HITL_ACK, HITL_ACK_CALL_FIRST])('tells a message written after the card that the card sits below it', ack => {
        expect(ack.instruction).toContain('The card shows below that message, so point to it as the card below, never above.')
    })

    it('is the one a card returns on each runtime', async () => {
        for (const order of ['message-first', 'call-first'] as const) {
            const { request_secret } = requestSecretTool({ turnOrder: order })
            expect(await (request_secret as any).execute({ secrets: [{ key: 'A_KEY', label: 'A key' }] }, {})).toBe(hitlAck(order))
        }
    })
})

describe('ask_user input schema', () => {
    it('accepts a question using options', () => {
        const result = askUserSchema().safeParse({ questions: [{ question: 'x', options: ['a', 'b'] }] })
        expect(result.success).toBe(true)
    })

    it('accepts an open question with no options', () => {
        const result = askUserSchema().safeParse({ questions: [{ question: 'What should the title be?' }] })
        expect(result.success).toBe(true)
    })

    it('accepts a question whose options are an explicit null', () => {
        const result = askUserSchema().safeParse({ questions: [{ question: 'Which domain?', options: null }, { question: 'Confirm?', options: ['Yes', 'No'] }] })
        expect(result.success).toBe(true)
    })

    it('accepts a question whose suggestions are an explicit null', () => {
        const result = askUserSchema().safeParse({ questions: [{ question: 'x', suggestions: null }] })
        expect(result.success).toBe(true)
    })

    it('accepts a question using the suggestions alias', () => {
        const result = askUserSchema().safeParse({ questions: [{ question: 'x', suggestions: ['a', 'b'] }] })
        expect(result.success).toBe(true)
    })

    it('accepts a long list of options', () => {
        const options = Array.from({ length: 12 }, (_, i) => `option ${i + 1}`)
        const parsed = askUserSchema().parse({ questions: [{ question: 'Which channels?', options, multiple: true }] })
        expect(parsed.questions[0].options).toHaveLength(12)
    })

    it('accepts more questions than the old cap of 6', () => {
        const questions = Array.from({ length: 9 }, (_, i) => ({ question: `question ${i + 1}` }))
        const parsed = askUserSchema().parse({ questions })
        expect(parsed.questions).toHaveLength(9)
    })

    it('rejects an empty options array', () => {
        const result = askUserSchema().safeParse({ questions: [{ question: 'x', options: [] }] })
        expect(result.success).toBe(false)
    })

    it('rejects a single option: one button is not a choice', () => {
        const result = askUserSchema().safeParse({ questions: [{ question: 'What is your store URL?', options: ['No store yet'] }] })
        expect(result.success).toBe(false)
    })

    it('rejects a single suggestion', () => {
        const result = askUserSchema().safeParse({ questions: [{ question: 'x', suggestions: ['a'] }] })
        expect(result.success).toBe(false)
    })

    it('accepts a multiple-choice question', () => {
        const parsed = askUserSchema().parse({ questions: [{ question: 'x', options: ['a', 'b'], multiple: true }] })
        expect(parsed.questions[0].multiple).toBe(true)
    })

    it('accepts a question whose multiple is an explicit null', () => {
        const parsed = askUserSchema().parse({ questions: [{ question: 'x', options: ['a', 'b'], multiple: null }] })
        expect(parsed.questions[0].multiple).toBeUndefined()
    })

    it('accepts a double-encoded JSON string for questions', () => {
        const result = askUserSchema().safeParse({ questions: '[{"question":"x","options":["a","b"]}]' })
        expect(result.success).toBe(true)
    })

    it('accepts a header and options written as a label with its description', () => {
        const parsed = askUserSchema().parse({
            questions: [{ question: 'Which format?', header: 'Format', options: [{ label: 'One-pager', description: 'A single page' }, { label: 'Deck', description: null }, 'Spreadsheet'] }],
        })
        expect(parsed.questions[0].header).toBe('Format')
        expect(parsed.questions[0].options).toEqual([{ label: 'One-pager', description: 'A single page' }, { label: 'Deck', description: undefined }, 'Spreadsheet'])
    })

    it('accepts a header that came back as an explicit null', () => {
        const parsed = askUserSchema().parse({ questions: [{ question: 'x', header: null, options: ['a', 'b'] }] })
        expect(parsed.questions[0].header).toBeUndefined()
    })

    it('rejects an option object without a label', () => {
        const result = askUserSchema().safeParse({ questions: [{ question: 'x', options: [{ description: 'no label' }, 'b'] }] })
        expect(result.success).toBe(false)
    })

    it('rejects a non-JSON string for questions', () => {
        const result = askUserSchema().safeParse({ questions: 'not json' })
        expect(result.success).toBe(false)
    })
})

describe('suggest_service input schema', () => {
    it('accepts services with a slug and optional reason', () => {
        const result = suggestServiceSchema().safeParse({ services: [{ slug: 'stripe', reason: 'Take payments' }, { slug: 'notion' }] })
        expect(result.success).toBe(true)
    })

    it('accepts a service whose reason is an explicit null', () => {
        expect(suggestServiceSchema().safeParse({ services: [{ slug: 'stripe', reason: null }] }).success).toBe(true)
    })

    it('rejects an empty services list', () => {
        const result = suggestServiceSchema().safeParse({ services: [] })
        expect(result.success).toBe(false)
    })

    it('rejects a service without a slug', () => {
        const result = suggestServiceSchema().safeParse({ services: [{ reason: 'no slug' }] })
        expect(result.success).toBe(false)
    })

    it('accepts a double-encoded JSON string for services', () => {
        const result = suggestServiceSchema().safeParse({ services: '[{"slug":"stripe"}]' })
        expect(result.success).toBe(true)
    })
})

describe('request_approval input schema', () => {
    it.each([1, 6, 7, 20])('accepts a batch of %i approvals', count => {
        const approvals = Array.from({ length: count }, (_, index) => ({ action: `action-${index}`, detail: index === 0 ? 'detail' : undefined }))
        expect(requestApprovalSchema().safeParse({ approvals }).success).toBe(true)
    })

    it('accepts a stringified approvals array', () => {
        const result = requestApprovalSchema().safeParse({ approvals: '[{"action":"send the email"}]' })
        expect(result.success).toBe(true)
    })

    it('accepts an approval whose detail is an explicit null', () => {
        expect(requestApprovalSchema().safeParse({ approvals: [{ action: 'send the email', detail: null }] }).success).toBe(true)
    })

    it('rejects an empty approvals array', () => {
        expect(requestApprovalSchema().safeParse({ approvals: [] }).success).toBe(false)
    })

    it('rejects more than 20 approvals', () => {
        const approvals = Array.from({ length: 21 }, (_, index) => ({ action: `action-${index}` }))
        expect(requestApprovalSchema().safeParse({ approvals }).success).toBe(false)
    })

    it('rejects an approval without an action', () => {
        expect(requestApprovalSchema().safeParse({ approvals: [{ detail: 'missing action' }] }).success).toBe(false)
    })

    it('does not accept the legacy singular input for new calls', () => {
        expect(requestApprovalSchema().safeParse({ action: 'send the email' }).success).toBe(false)
    })
})

describe('request_mcp_sign_in', () => {
    const schema = () => (mcpSignInTool({ turnOrder: 'message-first' }).request_mcp_sign_in as any).inputSchema as z.ZodTypeAny

    it('accepts a server name with an optional reason', () => {
        expect(schema().safeParse({ name: 'mobbin', reason: 'Search real app screens' }).success).toBe(true)
        expect(schema().safeParse({ name: 'mobbin', reason: null }).success).toBe(true)
    })

    it('rejects a call without a server name', () => {
        expect(schema().safeParse({ name: '' }).success).toBe(false)
    })

    it('pauses the run like every other card', () => {
        expect(isHitlToolName('mcp__rerun__request_mcp_sign_in')).toBe(true)
        const call = { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 's1', toolName: 'request_mcp_sign_in', input: { name: 'mobbin' } }] } as unknown as ModelMessage
        expect(findPendingHitl([call])).toEqual({ toolCallId: 's1', toolName: 'request_mcp_sign_in', input: { name: 'mobbin' } })
        expect(hitlTurnIsOver([{ text: 'Sign in to Mobbin to use it.', toolCalls: [{ toolName: 'request_mcp_sign_in' }] }], false)).toBe(true)
    })
})

describe('request_secret input schema', () => {
    it('accepts a batch of credentials with optional help and docs', () => {
        const result = requestSecretSchema().safeParse({
            secrets: [
                { key: 'LINEAR_API_KEY', label: 'Linear API key', help: 'Settings > API', docsUrl: 'https://linear.app/settings/api' },
                { key: 'LINEAR_TEAM_ID', label: 'Team id' },
            ],
            reason: 'To register the Linear MCP server',
        })
        expect(result.success).toBe(true)
    })

    it('accepts a credential whose optional fields are explicit nulls', () => {
        const result = requestSecretSchema().safeParse({ secrets: [{ key: 'API_KEY', label: 'API key', help: null, docsUrl: null, site: null }], reason: null })
        expect(result.success).toBe(true)
    })

    it('accepts a screen secret labeled with its site, and rejects an empty site', () => {
        expect(requestSecretSchema().safeParse({ secrets: [{ key: 'GH_PASSWORD', label: 'GitHub password', site: 'github.com' }] }).success).toBe(true)
        expect(requestSecretSchema().safeParse({ secrets: [{ key: 'GH_PASSWORD', label: 'GitHub password', site: '' }] }).success).toBe(false)
    })

    it('accepts a stringified secrets array', () => {
        expect(requestSecretSchema().safeParse({ secrets: '[{"key":"API_KEY","label":"API key"}]' }).success).toBe(true)
    })

    it.each(['api_key', 'API-KEY', '1API', 'API KEY', ''])('rejects %s as a variable name', key => {
        expect(requestSecretSchema().safeParse({ secrets: [{ key, label: 'API key' }] }).success).toBe(false)
    })

    it('rejects a credential without a label', () => {
        expect(requestSecretSchema().safeParse({ secrets: [{ key: 'API_KEY' }] }).success).toBe(false)
    })

    it('rejects an empty secrets array', () => {
        expect(requestSecretSchema().safeParse({ secrets: [] }).success).toBe(false)
    })

    it('rejects more than 8 credentials', () => {
        const secrets = Array.from({ length: 9 }, (_, index) => ({ key: `KEY_${index}`, label: `Key ${index}` }))
        expect(requestSecretSchema().safeParse({ secrets }).success).toBe(false)
    })
})

describe('findPendingHitl', () => {
    it('returns the call the user still has to answer', () => {
        const pending = findPendingHitl([askUserCall('c1'), toolResult('c1', { type: 'text', value: 'delivered' })])
        expect(pending).toMatchObject({ toolCallId: 'c1', toolName: 'ask_user' })
    })

    it('canonicalizes a bridged tool name', () => {
        const pending = findPendingHitl([askUserCall('c1', 'mcp__rerun__ask_user'), toolResult('c1', { type: 'text', value: 'delivered' }, 'mcp__rerun__ask_user')])
        expect(pending?.toolName).toBe('ask_user')
    })

    it('ignores a call the tool rejected: nobody was ever asked', () => {
        expect(findPendingHitl([askUserCall('c1'), toolResult('c1', { type: 'error-text', value: 'Invalid input for tool ask_user' })])).toBeNull()
    })

    // A CLI that proposes a skill after its card would otherwise hide the card it sent.
    it('looks past the skill proposal that follows a card', () => {
        const trailing = { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'p1', toolName: 'mcp__rerun__skill_propose', input: {} }] } as unknown as ModelMessage
        const pending = findPendingHitl([askUserCall('c1'), toolResult('c1', { type: 'text', value: 'delivered' }), trailing])
        expect(pending).toMatchObject({ toolCallId: 'c1', toolName: 'ask_user' })
    })

    it('returns null when the run ended on a regular tool call', () => {
        const messages = [{ role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c2', toolName: 'fs_read', input: {} }] }] as unknown as ModelMessage[]
        expect(findPendingHitl(messages)).toBeNull()
    })
})

describe('lastStepHasHitlCall', () => {
    it('stops the turn on a valid question', () => {
        expect(lastStepHasHitlCall([{ toolCalls: [{ toolName: 'ask_user' }] }])).toBe(true)
    })

    it('lets the turn continue after a rejected question so the model can fix it', () => {
        expect(lastStepHasHitlCall([{ toolCalls: [{ toolName: 'ask_user', invalid: true }] }])).toBe(false)
    })

    it('lets the turn continue when the card call threw, since no card went out', () => {
        const call = { toolName: 'request_approval', toolCallId: 'approval-1' }
        expect(lastStepHasHitlCall([{ toolCalls: [call] }])).toBe(true)
        expect(lastStepHasHitlCall([{ toolCalls: [call], content: [{ type: 'tool-error', toolCallId: 'approval-1' }] }])).toBe(false)
    })

    it('ignores steps without a HITL call', () => {
        expect(lastStepHasHitlCall([{ toolCalls: [{ toolName: 'ask_user' }] }, { toolCalls: [{ toolName: 'fs_read' }] }])).toBe(false)
    })

    // A card is displayed and the agent keeps working. Widening the HITL set to canonicalize other
    // bridged names would end the turn here instead.
    it('does not stop the turn on a bridged card call', () => {
        expect(lastStepHasHitlCall([{ toolCalls: [{ toolName: 'mcp__rerun__card_table' }] }])).toBe(false)
    })
})

describe('a card without its message', () => {
    const bareCard = { text: '  \n', toolCalls: [{ toolName: 'ask_user' }] }
    const explainedCard = { text: 'Here is what I found, two things to confirm.', toolCalls: [{ toolName: 'ask_user' }] }

    it('is a HITL step that wrote nothing', () => {
        expect(hitlStepLacksMessage([bareCard])).toBe(true)
        expect(hitlStepLacksMessage([explainedCard])).toBe(false)
        expect(hitlStepLacksMessage([{ text: '', toolCalls: [{ toolName: 'fs_read' }] }])).toBe(false)
        expect(hitlStepLacksMessage([{ text: '', toolCalls: [{ toolName: 'ask_user', invalid: true }] }])).toBe(false)
    })

    it('ends the turn on a card that came with its message', () => {
        expect(hitlTurnIsOver([explainedCard], false)).toBe(true)
    })

    it('buys one more step when the card came bare', () => {
        expect(hitlTurnIsOver([bareCard], false)).toBe(false)
    })

    it('ends the turn after that step whatever it holds', () => {
        expect(hitlTurnIsOver([bareCard, { text: 'Here is why I ask.' }], false)).toBe(true)
        expect(hitlTurnIsOver([bareCard, { text: '', toolCalls: [{ toolName: 'fs_read' }] }], false)).toBe(true)
        expect(hitlTurnIsOver([bareCard, bareCard], false)).toBe(true)
    })

    it('ends the turn on the card for a CLI provider, whose whole turn is one step', () => {
        expect(hitlTurnIsOver([bareCard], true)).toBe(true)
    })

    it('keeps the turn going on a rejected card, bare or not', () => {
        expect(hitlTurnIsOver([{ text: '', toolCalls: [{ toolName: 'ask_user', invalid: true }] }], false)).toBe(false)
    })

    it('keeps the turn going on a regular tool step', () => {
        expect(hitlTurnIsOver([{ text: '', toolCalls: [{ toolName: 'fs_read' }] }], false)).toBe(false)
        expect(hitlTurnIsOver([], false)).toBe(false)
    })
})

describe('secretSummary', () => {
    it('summarizes a batch using its first label', () => {
        expect(secretSummary({ secrets: [{ key: 'A_KEY', label: 'Linear API key' }, { key: 'B_KEY', label: 'Team id' }] })).toBe('Needs Linear API key (+1 more)')
    })

    it('summarizes a stringified batch', () => {
        expect(secretSummary({ secrets: '[{"key":"A_KEY","label":"Linear API key"}]' })).toBe('Needs Linear API key')
    })

    it('falls back to the key when no label is present', () => {
        expect(secretSummary({ secrets: [{ key: 'A_KEY' }] })).toBe('Needs A_KEY')
    })
})

describe('approvalSummary', () => {
    it('summarizes a batch using its first action', () => {
        expect(approvalSummary({ approvals: [{ action: 'Send email' }, { action: 'Delete draft' }, { action: 'Issue refund' }] })).toBe('Send email (+2 more)')
    })

    it('summarizes a stringified batch', () => {
        expect(approvalSummary({ approvals: '[{"action":"Send email"},{"action":"Delete draft"}]' })).toBe('Send email (+1 more)')
    })

    it('reads the legacy singular input', () => {
        expect(approvalSummary({ action: 'Send email' })).toBe('Send email')
    })
})

describe('request_takeover', () => {
    const schema = (): z.ZodTypeAny => (requestTakeoverTool({} as any).request_takeover as any).inputSchema

    it('takes a page and one line telling the user what to do there', () => {
        expect(schema().safeParse({ url: 'https://www.linkedin.com/login', reason: 'Sign in to LinkedIn' }).success).toBe(true)
        expect(schema().safeParse({ url: 'not a url', reason: 'Sign in' }).success).toBe(false)
        expect(schema().safeParse({ url: 'file:///etc/passwd', reason: 'Sign in' }).success).toBe(false)
        expect(schema().safeParse({ url: 'ftp://files.example/', reason: 'Sign in' }).success).toBe(false)
        expect(schema().safeParse({ url: 'https://www.linkedin.com/login' }).success).toBe(false)
    })

    it('ends the turn like the other human-in-the-loop tools, under its bridged names too', () => {
        expect(isHitlToolName('request_takeover')).toBe(true)
        expect(isHitlToolName('mcp__rerun__request_takeover')).toBe(true)
        expect(lastStepHasHitlCall([{ toolCalls: [{ toolName: 'rerun__request_takeover' }] }])).toBe(true)
    })

    it('summarises the request for the notification', () => {
        expect(takeoverSummary({ reason: 'Sign in to LinkedIn' })).toBe('Needs you in the browser: Sign in to LinkedIn')
        expect(takeoverSummary(undefined)).toBe('The coworker needs you in the browser')
    })
})
