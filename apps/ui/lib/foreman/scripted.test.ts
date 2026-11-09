import type { UIMessage } from 'ai'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { intakeBoxes } from '@/lib/onboarding/intake'
import type { ForemanState } from './phase'

const writePlan = vi.fn()
const buildTeamOnce = vi.fn()

vi.mock('./onboarding-tools', () => ({ writePlan }))
vi.mock('./build-once', () => ({ buildTeamOnce }))
const owedTemplatePurchase = vi.fn()
vi.mock('./template-purchase', () => ({ owedTemplatePurchase }))
const loadStarterPack = vi.fn()
const nameCustomCoworker = vi.fn()
vi.mock('./starter-pack-offer', () => ({ loadStarterPack, nameCustomCoworker }))

const { prepareScript, runScript, scriptedIntent } = await import('./scripted')

const CTX = { workspace: { id: 7 }, userId: 'user-1' } as never

const SHOWN = { title: 'Your team at Retalk', boxes: [{ name: 'Sales' }], items: [{ kind: 'agent', name: 'Closer', role: 'Answers demo requests', box: 'Sales' }] }
const PLAN = { title: SHOWN.title, boxes: SHOWN.boxes, items: [{ kind: 'agent' as const, name: 'Closer', role: 'Answers demo requests', box: 'Sales' }] }

function assistant(...parts: unknown[]): UIMessage {
    return { id: 'a', role: 'assistant', parts } as UIMessage
}

function user(text: string): UIMessage {
    return { id: 'u', role: 'user', parts: [{ type: 'text', text }] } as UIMessage
}

const planCard = (output: unknown) => ({ type: 'tool-show_plan', toolCallId: 'plan-1', state: 'output-available', input: SHOWN, output })
const TEMPLATE_CARD_INPUT = { templates: [{ slug: 'buyer-signals', title: 'Find prospects with buyer signals', why: 'Finds leads' }], allow_custom: true, box: 'Sales' }
const templateCard = (output: unknown) => ({ type: 'tool-show_templates', toolCallId: 'tpl-1', state: 'output-available', input: TEMPLATE_CARD_INPUT, output })
const checkout = (output: unknown) => ({ type: 'tool-open_checkout', toolCallId: 'co-1', state: 'output-available', input: {}, output })

function stateAt(phase: ForemanState['phase'], patch: Partial<ForemanState> = {}): ForemanState {
    return {
        phase,
        intent: null,
        answers: {},
        foreman: { profileAt: 'then' },
        onboardingCompletedAt: 'then',
        firstName: 'Ada',
        language: 'en',
        entitled: false,
        trialSpent: false,
        trialNeedsCard: true,
        priceArm: '49',
        client: 'web',
        workspaceName: 'Retalk',
        workspacePlan: 'none',
        userEmail: null,
        spaces: [],
        agents: [],
        ...patch,
    }
}

describe('scriptedIntent', () => {
    it('takes a confirmed plan card from the model', () => {
        expect(scriptedIntent('plan', [assistant({ type: 'text', text: 'Here it is' }, planCard({ answered: true, confirmed: true }))])).toBe('confirm_plan')
    })

    it('leaves a request for changes, a skipped card and anything typed to the model', () => {
        expect(scriptedIntent('plan', [assistant(planCard({ answered: true, confirmed: false }))])).toBeNull()
        expect(scriptedIntent('plan', [assistant(planCard({ answered: false }))])).toBeNull()
        expect(scriptedIntent('plan', [assistant(planCard({ answered: true, confirmed: true })), user('actually, one more agent')])).toBeNull()
    })

    it('takes a picked template card as the confirmed plan, and leaves the custom answer to the model', () => {
        expect(scriptedIntent('plan', [assistant(templateCard({ answered: true, chosen: 'buyer-signals' }))])).toBe('confirm_plan')
        expect(scriptedIntent('plan', [assistant(templateCard({ answered: true, custom: true }))])).toBeNull()
        expect(scriptedIntent('plan', [assistant(templateCard({ answered: false }))])).toBeNull()
    })

    it('puts the trial card up when a conversation opens on the trial step', () => {
        expect(scriptedIntent('trial', [user('[[foreman:start]]')])).toBe('offer_trial')
    })

    it('leaves a turned-down trial to the model, which answers the objection', () => {
        expect(scriptedIntent('trial', [assistant(checkout({ ok: false, reason: 'dismissed' }))])).toBeNull()
        expect(scriptedIntent('trial', [assistant(checkout({ ok: false, reason: 'dismissed' })), user('why do I need a trial?')])).toBeNull()
    })

    it('always builds once the trial is on and the team does not exist yet', () => {
        expect(scriptedIntent('build', [assistant(checkout({ ok: true, status: 'entitled' }))])).toBe('build')
        expect(scriptedIntent('build', [user('[[foreman:start]]')])).toBe('build')
    })

    it('never takes over the companion', () => {
        expect(scriptedIntent('companion', [assistant(planCard({ answered: true, confirmed: true }))])).toBeNull()
    })
})

describe('prepareScript', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        writePlan.mockResolvedValue({ plan: PLAN, planAt: 'now' })
        owedTemplatePurchase.mockResolvedValue(null)
    })

    it('writes the confirmed card down as it was shown, then offers the trial', async () => {
        const prepared = await prepareScript(CTX, stateAt('plan'), [assistant(planCard({ answered: true, confirmed: true }))])
        expect(writePlan).toHaveBeenCalledWith(CTX, SHOWN, ['agent'], null, false, { profileAt: 'then' })
        expect(prepared).toEqual({ script: { kind: 'offer_trial' } })
    })

    it('hands down what they wrote when they sent the card back for changes', async () => {
        const askInput = { type: 'tool-ask_input', toolCallId: 'ask-1', state: 'output-available', input: {}, output: { answered: true, answers: ['Only inbound demo requests'] } }
        await prepareScript(CTX, stateAt('plan'), [assistant(planCard({ answered: true, confirmed: false }), askInput, planCard({ answered: true, confirmed: true }))])
        expect(writePlan).toHaveBeenCalledWith(CTX, SHOWN, ['agent'], 'Only inbound demo requests', false, { profileAt: 'then' })
    })

    it('builds on the job the card was confirmed on, not the one the interview heard first', async () => {
        const interview = { profileAt: 'then', useCases: ['Finding new clients'], needs: [{ job: 'Finding new clients', pain: 'No decision makers' }] }
        const revised = { useCases: ['Finds apprenticeship hiring managers'], pain: 'Finds apprenticeship hiring managers', needs: [] }
        writePlan.mockResolvedValue({ plan: PLAN, planAt: 'now', ...revised })
        const prepared = await prepareScript(CTX, stateAt('plan', { entitled: true, foreman: interview }), [assistant(planCard({ answered: true, confirmed: true }))])
        expect(prepared).toMatchObject({ script: { kind: 'build', state: { foreman: { plan: PLAN, ...revised }, answers: { foreman: revised } } } })
    })

    it('writes a picked template down as the whole plan, in the one Box the card named', async () => {
        const state = stateAt('plan', { intent: { kind: 'template', slug: 'buyer-signals' }, answers: { company_name: 'Accuro' } })
        const prepared = await prepareScript(CTX, state, [assistant(templateCard({ answered: true, chosen: 'buyer-signals' }))])
        expect(writePlan).toHaveBeenCalledWith(CTX, { title: 'Accuro', boxes: [{ name: 'Sales' }], items: [{ kind: 'template', slug: 'buyer-signals', title: 'Find prospects with buyer signals', box: 'Sales' }] }, ['agent', 'template'], null, false)
        expect(prepared).toEqual({ script: { kind: 'offer_trial' } })
    })

    it('writes a picked template down with every Box the card was laid out with', async () => {
        const state = stateAt('plan', { intent: { kind: 'template', slug: 'buyer-signals' }, answers: { company_name: 'Accuro' } })
        const boxes = [{ name: 'Product' }, { name: 'Sales' }, { name: 'Support' }]
        const card = { type: 'tool-show_templates', toolCallId: 'tpl-1', state: 'output-available', input: { ...TEMPLATE_CARD_INPUT, boxes }, output: { answered: true, chosen: 'buyer-signals' } }
        await prepareScript(CTX, state, [assistant(card)])
        expect(writePlan).toHaveBeenCalledWith(CTX, { title: 'Accuro', boxes, items: [{ kind: 'template', slug: 'buyer-signals', title: 'Find prospects with buyer signals', box: 'Sales' }] }, ['agent', 'template'], null, false)
    })

    describe('arriving on a template link', () => {
        const TEMPLATE_INTENT = { kind: 'template' as const, slug: 'buyer-signals', title: 'Find prospects with buyer signals' }
        const KICKOFF = user('[[foreman:start:template:buyer-signals]]')
        const BOXES = intakeBoxes(null).map(name => ({ name }))
        const CARD = { templates: [{ slug: 'buyer-signals', title: 'Find prospects with buyer signals', why: '' }], box: BOXES[0].name, boxes: BOXES }

        it('writes the template down as the plan the moment the conversation opens, in the first Box, then offers the trial', async () => {
            const state = stateAt('plan', { intent: TEMPLATE_INTENT, answers: { company_name: 'Accuro' } })
            const prepared = await prepareScript(CTX, state, [KICKOFF])
            expect(writePlan).toHaveBeenCalledWith(CTX, { title: 'Accuro', boxes: BOXES, items: [{ kind: 'template', slug: 'buyer-signals', title: 'Find prospects with buyer signals', box: BOXES[0].name }] }, ['agent', 'template'], null, false)
            expect(prepared).toEqual({ script: { kind: 'offer_trial', template: CARD } })
        })

        // Nobody has asked who they are yet: the mark written with the plan is what brings the
        // welcome card back once the template is on the board.
        it('marks a workspace that installs before its profile is written', async () => {
            const state = stateAt('plan', { intent: TEMPLATE_INTENT, foreman: {} })
            await prepareScript(CTX, state, [KICKOFF])
            expect(writePlan).toHaveBeenCalledWith(CTX, expect.objectContaining({ items: [expect.objectContaining({ kind: 'template', slug: 'buyer-signals' })] }), ['agent', 'template'], null, true)
        })

        it('puts the card of a template still to be bought up before the build', async () => {
            const purchase = { slug: 'buyer-signals', title: 'Find prospects with buyer signals', pricing: { model: 'one_time', amountCents: 2900, currency: 'usd' } }
            owedTemplatePurchase.mockResolvedValue(purchase)
            const prepared = await prepareScript(CTX, stateAt('plan', { intent: TEMPLATE_INTENT, entitled: true }), [KICKOFF])
            expect(prepared).toEqual({ script: { kind: 'offer_purchase', purchase, template: CARD } })
        })

        it('goes straight to the build for a workspace already on a plan', async () => {
            const prepared = await prepareScript(CTX, stateAt('plan', { intent: TEMPLATE_INTENT, entitled: true }), [KICKOFF])
            expect(prepared).toMatchObject({ script: { kind: 'build', state: { phase: 'build' }, template: CARD } })
        })

        it('leaves a template the library no longer publishes, and anything typed, to the model', async () => {
            expect(await prepareScript(CTX, stateAt('plan', { intent: { kind: 'template', slug: 'gone' } }), [user('[[foreman:start:template:gone]]')])).toBeNull()
            expect(await prepareScript(CTX, stateAt('plan', { intent: TEMPLATE_INTENT }), [KICKOFF, user('something else please')])).toBeNull()
            expect(writePlan).not.toHaveBeenCalled()
        })

    describe('arriving on a shared coworker', () => {
        const SHARE_INTENT = { kind: 'share' as const, token: 'tok-1', title: 'Inbox Concierge' }
        const KICKOFF = user('[[foreman:start:share:tok-1]]')
        const BOXES = intakeBoxes(null).map(name => ({ name }))

        it('writes the shared coworker down as the plan with no model turn, then offers the trial', async () => {
            const state = stateAt('plan', { intent: SHARE_INTENT, foreman: {}, answers: {} })
            const prepared = await prepareScript(CTX, state, [KICKOFF])
            expect(writePlan).toHaveBeenCalledWith(CTX, { title: 'Retalk', boxes: BOXES, items: [{ kind: 'share', token: 'tok-1', name: 'Inbox Concierge', box: BOXES[0].name }] }, ['agent', 'share'], null, true)
            expect(prepared).toEqual({ script: { kind: 'offer_trial' } })
        })

        it('leaves a link that no longer resolves to the model', async () => {
            expect(await prepareScript(CTX, stateAt('plan', { intent: { kind: 'share', token: 'gone' } }), [user('[[foreman:start:share:gone]]')])).toBeNull()
        })
    })
    })

    it('goes straight to the build for a workspace already on a plan', async () => {
        const prepared = await prepareScript(CTX, stateAt('plan', { entitled: true }), [assistant(planCard({ answered: true, confirmed: true }))])
        expect(prepared).toMatchObject({ script: { kind: 'build', state: { phase: 'build', foreman: { plan: PLAN } } } })
    })

    it('hands a card that cannot be written down back to the model with the reason', async () => {
        writePlan.mockRejectedValue(new Error('A plan holds 5 Boxes at most.'))
        const prepared = await prepareScript(CTX, stateAt('plan'), [assistant(planCard({ answered: true, confirmed: true }))])
        expect(prepared).toEqual({ planError: 'A plan holds 5 Boxes at most.' })
    })
})

describe('the starter pack', () => {
    const BOXES = intakeBoxes('agencies')
    const card = (slug: string, focus?: string) => ({ slug, promise: `Promise of ${slug}`, line: '', ...(focus ? { focus } : {}), title: slug, agent: `Agent ${slug}`, image: null, connectors: [] })
    const PACK = { cards: [card('sales-development-rep', 'Build the prospect list'), card('seo-consultant'), card('executive-assistant')], box: BOXES[0], boxes: BOXES.map(name => ({ name })) }
    const KICKOFF = user('[[foreman:start]]')
    const packCard = (output?: unknown) => ({ type: 'tool-show_starter_pack', toolCallId: 'pack-1', state: output === undefined ? 'input-available' : 'output-available', input: PACK, output })
    const fresh = (patch: Partial<ForemanState> = {}) => stateAt('plan', { answers: { company_name: 'Accuro', industry: 'agencies' }, ...patch })

    beforeEach(() => {
        vi.clearAllMocks()
        loadStarterPack.mockResolvedValue(PACK)
        writePlan.mockResolvedValue({ plan: PLAN, planAt: 'now' })
        owedTemplatePurchase.mockResolvedValue(null)
    })

    it('puts the pack of their industry up the moment the welcome card hands over, with no model turn', async () => {
        expect(await prepareScript(CTX, fresh(), [KICKOFF])).toEqual({ script: { kind: 'offer_pack', pack: PACK } })
        expect(writePlan).not.toHaveBeenCalled()
    })

    it('leaves the plan to the model when nothing of the pack is in the library yet', async () => {
        loadStarterPack.mockResolvedValue(null)
        expect(await prepareScript(CTX, fresh(), [KICKOFF])).toBeNull()
    })

    it('never puts the pack up for someone who arrived on a link', async () => {
        await prepareScript(CTX, fresh({ intent: { kind: 'template', slug: 'buyer-signals' } }), [user('[[foreman:start:template:buyer-signals]]')])
        await prepareScript(CTX, fresh({ intent: { kind: 'prompt', text: 'Find me leads' } }), [user('[[foreman:start]]')])
        expect(loadStarterPack).not.toHaveBeenCalled()
    })

    it('writes the cards they picked down as the plan, each opened on the skill its card sold', async () => {
        const prepared = await prepareScript(CTX, fresh(), [KICKOFF, assistant(packCard({ answered: true, chosen: ['seo-consultant', 'sales-development-rep'] }))])
        expect(writePlan).toHaveBeenCalledWith(
            CTX,
            {
                title: 'Accuro',
                boxes: PACK.boxes,
                items: [
                    { kind: 'template', slug: 'sales-development-rep', title: 'Agent sales-development-rep', focus: 'Build the prospect list', box: BOXES[0] },
                    { kind: 'template', slug: 'seo-consultant', title: 'Agent seo-consultant', box: BOXES[0] },
                ],
            },
            ['template'],
        )
        expect(prepared).toEqual({ script: { kind: 'offer_trial' } })
    })

    it('builds one coworker out of the line they wrote instead of picking', async () => {
        nameCustomCoworker.mockResolvedValue({ name: 'Enquiries', role: 'Answers every website enquiry within the hour' })
        await prepareScript(CTX, fresh(), [KICKOFF, assistant(packCard({ answered: true, custom: 'Answer every enquiry within the hour' }))])
        expect(nameCustomCoworker).toHaveBeenCalledWith('Answer every enquiry within the hour')
        expect(writePlan).toHaveBeenCalledWith(CTX, { title: 'Accuro', boxes: PACK.boxes, items: [{ kind: 'agent', name: 'Enquiries', role: 'Answers every website enquiry within the hour', box: BOXES[0] }] }, ['agent'], 'Answer every enquiry within the hour')
    })

    it('reads a line typed over the cards as the coworker they want', async () => {
        nameCustomCoworker.mockResolvedValue({ name: 'Invoices', role: 'Chases unpaid invoices' })
        await prepareScript(CTX, fresh(), [KICKOFF, assistant(packCard({ answered: false, reason: 'typed' })), user('chase my unpaid invoices')])
        expect(writePlan).toHaveBeenCalledWith(CTX, expect.objectContaining({ items: [expect.objectContaining({ kind: 'agent', name: 'Invoices' })] }), ['agent'], 'chase my unpaid invoices')
    })

    it('builds one coworker out of a line written under the welcome card, without putting the pack up', async () => {
        nameCustomCoworker.mockResolvedValue({ name: 'Invoices', role: 'Chases unpaid invoices' })
        const prepared = await prepareScript(CTX, fresh(), [user('[[foreman:start:own]]\nChase my unpaid invoices')])
        expect(loadStarterPack).not.toHaveBeenCalled()
        expect(nameCustomCoworker).toHaveBeenCalledWith('Chase my unpaid invoices')
        expect(writePlan).toHaveBeenCalledWith(CTX, expect.objectContaining({ title: 'Accuro', items: [expect.objectContaining({ kind: 'agent', name: 'Invoices' })] }), ['agent'], 'Chase my unpaid invoices')
        expect(prepared).toEqual({ script: { kind: 'offer_trial' } })
    })

    it('puts the pack back up when it was left unanswered', async () => {
        expect(await prepareScript(CTX, fresh(), [KICKOFF, assistant(packCard({ answered: false, reason: 'abandoned' }))])).toEqual({ script: { kind: 'offer_pack', pack: PACK } })
    })

    it('puts the pack back up rather than handing the model a plan it never drew', async () => {
        writePlan.mockRejectedValue(new Error('A plan needs its one item'))
        expect(await prepareScript(CTX, fresh(), [KICKOFF, assistant(packCard({ answered: true, chosen: ['gone'] }))])).toEqual({ script: { kind: 'offer_pack', pack: PACK } })
    })

    it('leaves a conversation the pack never opened to the model', async () => {
        expect(await prepareScript(CTX, fresh(), [user('hello')])).toBeNull()
        expect(loadStarterPack).not.toHaveBeenCalled()
    })
})

describe('runScript', () => {
    function recorder() {
        const chunks: { type: string; [key: string]: unknown }[] = []
        return { chunks, writer: { write: (chunk: { type: string }) => chunks.push(chunk), merge: () => {}, onError: undefined } as never }
    }

    it('puts the purchase card up as a call left for the card to answer', async () => {
        const { chunks, writer } = recorder()
        const purchase = { slug: 'buyer-signals', title: 'Find prospects with buyer signals', pricing: { model: 'one_time' as const, amountCents: 2900, currency: 'usd' } }
        await runScript({ kind: 'offer_purchase', purchase }, { ctx: CTX, writer, reload: async () => stateAt('build') })

        expect(chunks.map(chunk => chunk.type)).toEqual(['start', 'start-step', 'tool-input-available', 'finish-step', 'finish'])
        expect(chunks[2]).toMatchObject({ toolName: 'open_template_purchase', input: purchase })
    })

    it('puts the starter pack up as a call left for the cards to answer', async () => {
        const { chunks, writer } = recorder()
        const pack = { cards: [], boxes: [] }
        await runScript({ kind: 'offer_pack', pack }, { ctx: CTX, writer, reload: async () => stateAt('build') })

        expect(chunks.map(chunk => chunk.type)).toEqual(['start', 'start-step', 'tool-input-available', 'finish-step', 'finish'])
        expect(chunks[2]).toMatchObject({ toolName: 'show_starter_pack', input: pack })
    })

    it('puts the trial card up as an open_checkout call left for the card to answer', async () => {
        const { chunks, writer } = recorder()
        await runScript({ kind: 'offer_trial' }, { ctx: CTX, writer, reload: async () => stateAt('build') })

        expect(chunks.map(chunk => chunk.type)).toEqual(['start', 'start-step', 'tool-input-available', 'finish-step', 'finish'])
        expect(chunks[2]).toMatchObject({ toolName: 'open_checkout', input: {} })
    })

    it('writes the template they arrived on as an already picked card before the trial card', async () => {
        const { chunks, writer } = recorder()
        const template = { templates: [{ slug: 'buyer-signals', title: 'Find prospects with buyer signals', why: '' }], box: 'Sales', boxes: [{ name: 'Sales' }] }
        await runScript({ kind: 'offer_trial', template }, { ctx: CTX, writer, reload: async () => stateAt('build') })

        expect(chunks.map(chunk => chunk.type)).toEqual(['start', 'start-step', 'tool-input-available', 'tool-output-available', 'tool-input-available', 'finish-step', 'finish'])
        expect(chunks[2]).toMatchObject({ toolName: 'show_templates', input: template })
        expect(chunks[3]).toMatchObject({ toolCallId: chunks[2].toolCallId, output: { answered: true, chosen: 'buyer-signals' } })
        expect(chunks[4]).toMatchObject({ toolName: 'open_checkout' })
    })

    it('streams the build under one call id and closes on an empty step, so the browser does not send it back', async () => {
        buildTeamOnce.mockImplementation(async ({ emit }: { emit: (tasks: unknown[]) => void }) => {
            emit([{ title: 'Closer', status: 'running', steps: 1 }])
            return { boxes: [], agents: [], failed: [] }
        })
        const { chunks, writer } = recorder()
        await runScript({ kind: 'build', state: stateAt('build') }, { ctx: CTX, writer, reload: async () => stateAt('build') })

        expect(chunks.map(chunk => chunk.type)).toEqual(['start', 'start-step', 'tool-input-available', 'data-delegate', 'tool-output-available', 'finish-step', 'start-step', 'finish-step', 'finish'])
        const call = chunks[2]
        expect(call).toMatchObject({ toolName: 'build_team' })
        expect(chunks[3].id).toBe(call.toolCallId)
        expect(chunks[4].toolCallId).toBe(call.toolCallId)
    })

    it('reports a build that failed as a failed call rather than breaking the stream', async () => {
        buildTeamOnce.mockRejectedValue(new Error('No machine is available right now'))
        const { chunks, writer } = recorder()
        await runScript({ kind: 'build', state: stateAt('build') }, { ctx: CTX, writer, reload: async () => stateAt('build') })

        expect(chunks.find(chunk => chunk.type === 'tool-output-error')).toMatchObject({ errorText: 'No machine is available right now' })
        expect(chunks.at(-1)?.type).toBe('finish')
    })
})
