import { describe, expect, it } from 'vitest'
import { findUnknownPendingCall, hitlVersionOf, withHitlVersion } from '@rerun/contracts'
import { findPendingAlert, findPendingHitl, HITL_CANCELLED, hitlInputIsUsable, hitlKindOf, parseHitlReply, pendingApprovals, pendingMcpSignIn, pendingQuestions, pendingSecrets, pendingServices, pendingTakeover, serializeAnswers, serializeApprovalDecisions, serializeMcpSignInResult, serializeSecretResult, serializeServiceSetupResult, serializeTakeoverResult } from './chat-hitl'
import { parseAttachments } from './chat/attachments-marker'

describe('pendingQuestions', () => {
    it('normalizes a batch, options or not', () => {
        expect(
            pendingQuestions({
                questions: [
                    { question: 'Which domain?' },
                    { question: 'Report language?', options: ['English', 'French'] },
                ],
            })
        ).toEqual([
            { question: 'Which domain?', options: [], multiple: false },
            { question: 'Report language?', options: [{ label: 'English' }, { label: 'French' }], multiple: false },
        ])
    })

    it('reads an open question whose options came back as an explicit null', () => {
        expect(pendingQuestions({ questions: [{ question: 'Which domain?', options: null }] })).toEqual([{ question: 'Which domain?', options: [], multiple: false }])
    })

    it('keeps a long option list whole and carries the multiple flag', () => {
        const options = Array.from({ length: 12 }, (_, i) => `#channel-${i + 1}`)
        expect(pendingQuestions({ questions: [{ question: 'Which channels?', options, multiple: true }] })).toEqual([{ question: 'Which channels?', options: options.map(label => ({ label })), multiple: true }])
    })

    it('normalizes a stringified batch and the suggestions alias', () => {
        expect(pendingQuestions({ questions: '[{"question":"Which domain?","suggestions":["example.com"]}]' })).toEqual([{ question: 'Which domain?', options: [{ label: 'example.com' }], multiple: false }])
    })

    it('reads the legacy singular input', () => {
        expect(pendingQuestions({ question: 'Which domain?', options: ['example.com'] })).toEqual([{ question: 'Which domain?', options: [{ label: 'example.com' }], multiple: false }])
    })

    it('reads a header and options written as a label with its description', () => {
        expect(
            pendingQuestions({
                questions: [
                    {
                        question: 'Which format should the report take?',
                        header: 'Format',
                        options: [{ label: 'One-pager', description: 'A single page with the key numbers' }, { label: 'Deck', description: null }, 'Spreadsheet'],
                    },
                ],
            }),
        ).toEqual([
            {
                question: 'Which format should the report take?',
                header: 'Format',
                options: [{ label: 'One-pager', description: 'A single page with the key numbers' }, { label: 'Deck' }, { label: 'Spreadsheet' }],
                multiple: false,
            },
        ])
    })

    it('drops a blank header and options that carry no label', () => {
        expect(pendingQuestions({ questions: [{ question: 'Which?', header: ' ', options: [{ description: 'orphan' }, '', { label: 'A' }, null] }] })).toEqual([{ question: 'Which?', options: [{ label: 'A' }], multiple: false }])
    })
})

describe('withHitlVersion', () => {
    it('stamps v2 on an ask_user call that writes an option as an object', () => {
        const input = { questions: [{ question: 'Which?', options: [{ label: 'A', description: 'first' }, 'B'] }] }
        expect(withHitlVersion('ask_user', input)).toEqual({ ...input, v: 2 })
        expect(withHitlVersion('mcp__rerun__ask_user', input)).toEqual({ ...input, v: 2 })
    })

    it('reads a stringified batch', () => {
        const input = { questions: '[{"question":"Which?","options":[{"label":"A"},{"label":"B"}]}]' }
        expect(withHitlVersion('ask_user', input)).toEqual({ ...input, v: 2 })
    })

    it('leaves string options, other tools and an already versioned input untouched', () => {
        const strings = { questions: [{ question: 'Which?', header: 'Pick', options: ['A', 'B'] }] }
        expect(withHitlVersion('ask_user', strings)).toBe(strings)
        const approval = { approvals: [{ action: 'Send', detail: { label: 'x' } }] }
        expect(withHitlVersion('request_approval', approval)).toBe(approval)
        const stamped = { v: 2, questions: [{ question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }] }
        expect(withHitlVersion('ask_user', stamped)).toBe(stamped)
        expect(withHitlVersion('ask_user', 'not an object')).toBe('not an object')
    })
})

describe('serializeAnswers', () => {
    it('keeps the text-only format unchanged', () => {
        expect(
            serializeAnswers([
                { question: 'Which domain?', answers: ['example.com'] },
                { question: 'Channels?', answers: ['X', 'LinkedIn'] },
                { question: 'Budget?', answers: ['  '] },
            ]),
        ).toBe('Here are my answers:\n\n**Which domain?**\nexample.com\n\n**Channels?**\n- X\n- LinkedIn\n\n**Budget?**\n[skipped]')
    })

    it('names the files under their answer and lists their paths in the trailing marker', () => {
        const text = serializeAnswers([
            { question: 'Which logo?', answers: [], attachments: ['chat-uploads/mf2k3a9x-abc123-logo.svg'] },
            { question: 'Brief?', answers: ['See the doc'], attachments: ['chat-uploads/mf2k3a9y-def456-brief.pdf'] },
            { question: 'Budget?', answers: [] },
        ])

        expect(text).toContain('**Which logo?**\nAttached: logo.svg')
        expect(text).toContain('**Brief?**\nSee the doc\nAttached: brief.pdf')
        expect(text).toContain('**Budget?**\n[skipped]')
        expect(parseAttachments(text)?.paths).toEqual(['chat-uploads/mf2k3a9x-abc123-logo.svg', 'chat-uploads/mf2k3a9y-def456-brief.pdf'])
    })
})

describe('hitlInputIsUsable', () => {
    it('accepts a batch and the legacy singular shapes', () => {
        expect(hitlInputIsUsable('question', { questions: [{ question: 'Which domain?' }] })).toBe(true)
        expect(hitlInputIsUsable('question', { question: 'Which domain?' })).toBe(true)
        expect(hitlInputIsUsable('approval', { action: 'Send email' })).toBe(true)
        expect(hitlInputIsUsable('secret', { secrets: [{ key: 'API_KEY' }] })).toBe(true)
        expect(hitlInputIsUsable('service', { services: [{ slug: 'stripe' }] })).toBe(true)
    })

    it('rejects the input of a call whose payload was stripped', () => {
        expect(hitlInputIsUsable('question', {})).toBe(false)
        expect(hitlInputIsUsable('approval', {})).toBe(false)
        expect(hitlInputIsUsable('service', { services: null })).toBe(false)
    })
})

describe('pendingApprovals', () => {
    it('normalizes a batch', () => {
        expect(
            pendingApprovals({
                approvals: [{ action: 'Send email', detail: 'To finance@example.com' }, { action: 'Delete draft' }],
            })
        ).toEqual([
            { action: 'Send email', detail: 'To finance@example.com' },
            { action: 'Delete draft', detail: undefined },
        ])
    })

    it('normalizes a stringified batch', () => {
        expect(pendingApprovals({ approvals: '[{"action":"Send email"}]' })).toEqual([{ action: 'Send email', detail: undefined }])
    })

    it('reads the legacy singular input', () => {
        expect(pendingApprovals({ action: 'Send email', detail: 'To finance@example.com' })).toEqual([{ action: 'Send email', detail: 'To finance@example.com' }])
    })
})

describe('pendingSecrets', () => {
    it('normalizes a batch', () => {
        expect(
            pendingSecrets({
                secrets: [
                    { key: 'LINEAR_API_KEY', label: 'Linear API key', help: 'Settings > API', docsUrl: 'https://linear.app/settings/api' },
                    { key: 'LINEAR_TEAM_ID', label: 'Team id' },
                ],
            })
        ).toEqual([
            { key: 'LINEAR_API_KEY', label: 'Linear API key', help: 'Settings > API', docsUrl: 'https://linear.app/settings/api' },
            { key: 'LINEAR_TEAM_ID', label: 'Team id', help: undefined, docsUrl: undefined },
        ])
    })

    it('normalizes a stringified batch', () => {
        expect(pendingSecrets({ secrets: '[{"key":"API_KEY","label":"API key"}]' })).toEqual([{ key: 'API_KEY', label: 'API key', help: undefined, docsUrl: undefined }])
    })

    it('falls back to the key as label and drops entries without a key', () => {
        expect(pendingSecrets({ secrets: [{ key: 'API_KEY' }, { label: 'orphan' }] })).toEqual([{ key: 'API_KEY', label: 'API_KEY', help: undefined, docsUrl: undefined }])
    })

    it('returns nothing when the input holds no secrets', () => {
        expect(pendingSecrets({})).toEqual([])
    })

    it('keeps the site of a screen secret and drops a blank one', () => {
        expect(pendingSecrets({ secrets: [{ key: 'GH_PASSWORD', label: 'GitHub password', site: ' github.com ' }, { key: 'PLAIN', label: 'Plain', site: '  ' }] })).toEqual([
            { key: 'GH_PASSWORD', label: 'GitHub password', help: undefined, docsUrl: undefined, site: 'github.com' },
            { key: 'PLAIN', label: 'Plain', help: undefined, docsUrl: undefined, site: undefined },
        ])
    })
})

describe('serializeSecretResult', () => {
    const secrets = [
        { key: 'LINEAR_API_KEY', label: 'Linear API key' },
        { key: 'LINEAR_TEAM_ID', label: 'Team id' },
    ]

    it('reports provided and skipped variables by name', () => {
        const message = serializeSecretResult(secrets, ['LINEAR_API_KEY'])
        expect(message).toContain('- LINEAR_API_KEY: provided (stored as a coworker variable)')
        expect(message).toContain('- LINEAR_TEAM_ID: skipped')
    })

    it('builds the whole message from variable names only', () => {
        expect(serializeSecretResult(secrets, ['LINEAR_API_KEY', 'LINEAR_TEAM_ID'])).toBe(
            'Credential setup result:\n' +
                '- LINEAR_API_KEY: provided (stored as a coworker variable)\n' +
                '- LINEAR_TEAM_ID: provided (stored as a coworker variable)\n\n' +
                'Reference a provided variable as ${KEY} in an MCP server config (headers, url, env, args) or in a command. Never ask for the value itself: it is not available to you.'
        )
    })
})

describe('serializeApprovalDecisions', () => {
    it('serializes a mixed batch into one explicit user message', () => {
        expect(
            serializeApprovalDecisions([
                { action: 'Send email', decision: 'approved' },
                { action: 'Delete draft', decision: 'declined', note: ' Keep it for the audit. ' },
                { action: 'Issue refund', decision: 'declined' },
            ])
        ).toBe('Here are my approval decisions:\n\n' + '1. **APPROVED** — Send email\n\n' + '2. **DECLINED** — Delete draft\nReason: Keep it for the audit.\n\n' + '3. **DECLINED** — Issue refund\n\n' + 'Perform only the approved actions. Do not perform any declined action or attempt any workaround to achieve the same result.')
    })
})

describe('findPendingAlert', () => {
    const alertCall = (message: string, toolCallId = 'call-1') => ({ type: 'tool-notify_user', toolCallId, toolName: 'notify_user', input: { kind: 'info', message } })

    it('picks the last notification even when the agent kept working after it', () => {
        expect(
            findPendingAlert([
                { role: 'assistant', parts: [alertCall('First alert')] },
                { role: 'assistant', parts: [alertCall('The Stripe quota is nearly out', 'call-2'), { type: 'tool-fs_write', toolCallId: 'call-3', toolName: 'fs_write', input: {} }] },
            ])
        ).toEqual({ toolCallId: 'call-2', message: 'The Stripe quota is nearly out' })
    })

    it('reads the call through the CLI bridge prefix', () => {
        expect(findPendingAlert([{ role: 'assistant', parts: [{ type: 'tool-mcp__rerun__notify_user', toolCallId: 'call-9', input: { kind: 'info', message: 'Look at this' } }] }])).toEqual({ toolCallId: 'call-9', message: 'Look at this' })
    })

    it('reads a call that left the kind out, since it defaults to info', () => {
        expect(findPendingAlert([{ role: 'assistant', parts: [{ type: 'tool-notify_user', toolCallId: 'call-7', toolName: 'notify_user', input: { message: 'Look at this' } }] }])).toEqual({ toolCallId: 'call-7', message: 'Look at this' })
    })

    it('ignores a notify_user of any other kind', () => {
        expect(findPendingAlert([{ role: 'assistant', parts: [{ type: 'tool-notify_user', toolCallId: 'call-4', toolName: 'notify_user', input: { kind: 'done', message: 'Finished' } }] }])).toEqual({
            toolCallId: null,
            message: 'The coworker sent you a notification.',
        })
    })

    it('falls back when the transcript no longer holds the call', () => {
        expect(findPendingAlert([{ role: 'user', parts: [{ type: 'text', text: 'hello' }] }])).toEqual({ toolCallId: null, message: 'The coworker sent you a notification.' })
    })
})

describe('pendingServices', () => {
    it('keeps the slugs and their reasons, JSON-encoded or not', () => {
        expect(pendingServices({ services: JSON.stringify([{ slug: 'notion', reason: 'to publish the pages' }, { slug: 'slack' }]) })).toEqual([
            { slug: 'notion', reason: 'to publish the pages' },
            { slug: 'slack', reason: undefined },
        ])
    })

    it('drops an entry with no slug', () => {
        expect(pendingServices({ services: [{ reason: 'orphan' }] })).toEqual([])
    })
})

describe('serializeServiceSetupResult', () => {
    it('tells apart skipped, reset and never-found', () => {
        expect(
            serializeServiceSetupResult([
                { slug: 'notion', name: 'Notion', outcome: 'connected' },
                { slug: 'slack', name: 'Slack', outcome: 'reset' },
                { slug: 'linear', name: 'Linear', outcome: 'skipped' },
                { slug: 'frobnicator', name: 'frobnicator', outcome: 'not-found' },
            ])
        ).toBe(
            'App setup result:\n- Notion: connected\n- Slack: connection reset, not reconnected\n- Linear: skipped\n- frobnicator: not found in the catalog\n\nPlease continue.'
        )
    })

    it('names the app an alternative replaced', () => {
        expect(serializeServiceSetupResult([{ slug: 'outlook', name: 'Outlook', outcome: 'connected', replaces: 'Gmail' }])).toBe('App setup result:\n- Outlook (instead of Gmail): connected\n\nPlease continue.')
    })

    it('still answers the agent when nothing was suggested', () => {
        expect(serializeServiceSetupResult([])).toBe('App setup result:\n- (no apps suggested)\n\nPlease continue.')
    })
})

describe('parseHitlReply', () => {
    it('reads back an app setup result, alternative and odd names included', () => {
        const text = serializeServiceSetupResult([
            { slug: 'fal', name: 'fal.ai', outcome: 'connected', replaces: 'Higgsfield' },
            { slug: 'trendtrack', name: 'TrendTrack (beta)', outcome: 'skipped' },
            { slug: 'hubspot', name: 'HubSpot', outcome: 'reset' },
            { slug: 'frobnicator', name: 'frobnicator', outcome: 'not-found' },
        ])
        expect(parseHitlReply(text)).toEqual({
            kind: 'service',
            entries: [
                { name: 'fal.ai', outcome: 'connected', replaces: 'Higgsfield' },
                { name: 'TrendTrack (beta)', outcome: 'skipped' },
                { name: 'HubSpot', outcome: 'reset' },
                { name: 'frobnicator', outcome: 'not-found' },
            ],
        })
    })

    it('reads back an empty app setup', () => {
        expect(parseHitlReply(serializeServiceSetupResult([]))).toEqual({ kind: 'service', entries: [] })
    })

    it('reads back answers: single, list, free text over lines, skipped, files', () => {
        const answers = [
            { question: 'Which stages?', answers: ['Lead', 'Demo booked', 'Won'] },
            { question: 'How often?', answers: ['Every morning'] },
            { question: 'Anything to avoid?', answers: ['Never on Friday.\nThey hate it.'] },
            { question: 'Who to copy?', answers: [] },
            { question: 'Brand guide?', answers: ['Here it is'], attachments: ['chat-uploads/mfx2k3a1-Ab12Cd-guide.pdf', 'chat-uploads/mfx2k3a2-Ef34Gh-post.png'] },
            { question: 'Only files?', answers: [], attachments: ['chat-uploads/mfx2k3a3-Ij56Kl-logo.svg'] },
        ]
        expect(parseHitlReply(serializeAnswers(answers))).toEqual({ kind: 'question', answers })
    })

    it('reads back credentials by name only', () => {
        const text = serializeSecretResult(
            [
                { key: 'SHOPIFY_ADMIN_TOKEN', label: 'Admin token' },
                { key: 'SHOPIFY_WEBHOOK_SECRET', label: 'Webhook secret' },
            ],
            ['SHOPIFY_ADMIN_TOKEN']
        )
        expect(parseHitlReply(text)).toEqual({
            kind: 'secret',
            entries: [
                { key: 'SHOPIFY_ADMIN_TOKEN', provided: true },
                { key: 'SHOPIFY_WEBHOOK_SECRET', provided: false },
            ],
        })
    })

    it('reads back credentials stored before the copy said coworker', () => {
        const text = 'Credential setup result:\n- LINEAR_API_KEY: provided (stored as an agent variable)\n\nReference a provided variable as ${KEY} in an MCP server config (headers, url, env, args) or in a command. Never ask for the value itself: it is not available to you.'
        expect(parseHitlReply(text)).toEqual({ kind: 'secret', entries: [{ key: 'LINEAR_API_KEY', provided: true }] })
    })

    it('reads back an MCP sign-in', () => {
        expect(parseHitlReply(serializeMcpSignInResult('mobbin'))).toEqual({ kind: 'mcp', name: 'mobbin' })
    })

    it('reads a skipped MCP sign-in', () => {
        expect(parseHitlReply(HITL_CANCELLED.mcp)).toEqual({ kind: 'cancelled', of: 'mcp' })
    })

    it('reads back approval decisions, a reason spanning paragraphs included', () => {
        const text = serializeApprovalDecisions([
            { action: 'Send email', decision: 'approved' },
            { action: 'Delete draft', decision: 'declined', note: 'Keep it.\n\nThe audit needs it.' },
            { action: 'Issue refund', decision: 'declined' },
        ])
        expect(parseHitlReply(text)).toEqual({
            kind: 'approval',
            decisions: [
                { action: 'Send email', decision: 'approved' },
                { action: 'Delete draft', decision: 'declined', note: 'Keep it.\n\nThe audit needs it.' },
                { action: 'Issue refund', decision: 'declined' },
            ],
        })
    })

    it('reads a dismissal', () => {
        expect(parseHitlReply(HITL_CANCELLED.secret)).toEqual({ kind: 'cancelled', of: 'secret' })
    })

    it('leaves what the user typed alone', () => {
        expect(parseHitlReply('App setup result: it worked, thanks')).toBeNull()
        expect(parseHitlReply('Here are my answers:\n\nyes to all')).toBeNull()
        expect(parseHitlReply('Credential setup result:\n- done\n\nReference a provided variable as ${KEY}')).toBeNull()
    })
})

describe('browser takeover', () => {
    it('is a human-in-the-loop call under its bridged names too, usable once it names a page', () => {
        expect(hitlKindOf('request_takeover')).toBe('takeover')
        expect(hitlKindOf('mcp__rerun__request_takeover')).toBe('takeover')
        expect(hitlInputIsUsable('takeover', { url: 'https://www.linkedin.com/login', reason: 'Sign in to LinkedIn' })).toBe(true)
        expect(hitlInputIsUsable('takeover', {})).toBe(false)
    })

    it('reads the request, with a title to fall back on', () => {
        expect(pendingTakeover({ url: 'https://www.linkedin.com/login', reason: ' Sign in to LinkedIn ' })).toEqual({ url: 'https://www.linkedin.com/login', reason: 'Sign in to LinkedIn' })
        expect(pendingTakeover({ url: 'https://x.example/' }).reason).toBe('The coworker needs you in its browser')
    })

    it('round-trips the page the browser was handed back on', () => {
        expect(parseHitlReply(serializeTakeoverResult({ url: 'https://www.linkedin.com/feed/' }))).toEqual({ kind: 'takeover', url: 'https://www.linkedin.com/feed/' })
        expect(parseHitlReply(serializeTakeoverResult({ url: 'https://web.whatsapp.com/', open: true }))).toEqual({ kind: 'takeover', url: 'https://web.whatsapp.com/' })
        expect(parseHitlReply(serializeTakeoverResult({ url: null }))).toEqual({ kind: 'takeover', url: null })
    })

    it('still reads the hand back of a conversation written before the window stayed open', () => {
        const before = 'Browser handed back.\nI left your browser on https://www.linkedin.com/feed/\n\nWhatever I did there is saved in your browser profile: open the page again with browser_navigate and continue.'
        expect(parseHitlReply(before)).toEqual({ kind: 'takeover', url: 'https://www.linkedin.com/feed/' })
    })

    it('tells the coworker its window is closed and which tool reopens the page', () => {
        const text = serializeTakeoverResult({ url: 'https://web.whatsapp.com/' })
        expect(text).toContain('The window is closed')
        expect(text).toContain('computer_open_app when you were working on your screen')
        expect(text).toContain('browser_navigate otherwise')
    })

    it('tells the coworker the window is still on its screen when it was left open', () => {
        const text = serializeTakeoverResult({ url: 'https://web.whatsapp.com/', open: true })
        expect(text).toContain('The window is still open on your screen')
        expect(text).toContain('browser_navigate reads in that same window')
        expect(text).not.toContain('The window is closed')
    })

    it('tells a skipped takeover apart from a completed one', () => {
        expect(parseHitlReply(HITL_CANCELLED.takeover)).toEqual({ kind: 'cancelled', of: 'takeover' })
        expect(parseHitlReply('Browser handed back, thanks')).toBeNull()
    })
})

describe('request_mcp_sign_in', () => {
    it('is a card of its own, bridged name included', () => {
        expect(hitlKindOf('mcp__rerun__request_mcp_sign_in')).toBe('mcp')
    })

    it('reads the server name and drops a blank reason', () => {
        expect(pendingMcpSignIn({ name: 'mobbin', reason: '  ' })).toEqual({ name: 'mobbin', reason: undefined })
        expect(hitlInputIsUsable('mcp', {})).toBe(false)
    })
})

describe('request_spend', () => {
    it('is no longer a card: an old call in a transcript renders as a plain step', () => {
        expect(hitlKindOf('mcp__rerun__request_spend')).toBeNull()
    })
})

describe('findPendingHitl', () => {
    const question = { type: 'tool-ask_user', toolCallId: 'call-1', input: { questions: [{ question: 'Which list?', options: ['Q4', 'Q1'] }] } }
    const assistant = (...parts: object[]) => ({ role: 'assistant', parts })

    it('finds the question the closing assistant message stopped on', () => {
        expect(findPendingHitl([{ role: 'user', parts: [] }, assistant({ type: 'text', text: 'One moment' }, question)])).toMatchObject({ kind: 'question', toolCallId: 'call-1' })
    })

    it('finds nothing once the human has answered', () => {
        expect(findPendingHitl([assistant(question), { role: 'user', parts: [{ type: 'text', text: 'Q4' }] }])).toBeNull()
    })

    it('recovers the payload of a call the SDK rejected, and skips one with nothing usable left', () => {
        expect(findPendingHitl([assistant({ ...question, input: undefined, rawInput: question.input })])).toMatchObject({ input: question.input })
        expect(findPendingHitl([assistant({ ...question, input: {} })])).toBeNull()
    })

    it('leaves out a block the user closed', () => {
        expect(findPendingHitl([assistant(question)], 'call-1')).toBeNull()
    })
})

describe('hitlVersionOf', () => {
    it('reads an input without a version as the first one', () => {
        expect(hitlVersionOf({ questions: [] })).toBe(1)
        expect(hitlVersionOf({ v: 2 })).toBe(2)
        expect(hitlVersionOf({ v: '2' })).toBe(1)
        expect(hitlVersionOf({ v: 0 })).toBe(1)
    })
})

describe('findUnknownPendingCall', () => {
    const assistant = (...parts: object[]) => ({ role: 'assistant', parts })
    const unknown = { type: 'dynamic-tool', toolName: 'rerun__request_signature', toolCallId: 'call-9', state: 'input-available', input: { document: 'NDA', reason: 'Sign the NDA' } }

    it('finds a call the client cannot name that the run stopped on', () => {
        expect(findUnknownPendingCall([assistant({ type: 'text', text: 'Before I go on' }, unknown)])).toEqual({ toolCallId: 'call-9', toolName: 'request_signature', input: unknown.input })
    })

    it('leaves a known HITL to its own block, and an answered call alone', () => {
        expect(findUnknownPendingCall([assistant({ type: 'tool-ask_user', toolCallId: 'call-1', input: { questions: [] } })])).toBeNull()
        expect(findUnknownPendingCall([assistant({ ...unknown, state: 'output-available', output: 'ok' })])).toBeNull()
        expect(findUnknownPendingCall([assistant(unknown, { type: 'tool-web_search', toolCallId: 'call-10', output: [] })])).toBeNull()
    })

    it('finds nothing once the human has spoken', () => {
        expect(findUnknownPendingCall([assistant(unknown), { role: 'user', parts: [{ type: 'text', text: 'Done' }] }])).toBeNull()
    })
})
