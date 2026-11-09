import { describe, expect, it, vi } from 'vitest'

import { BILLING_ENABLED } from '@rerun/cloud/billing'

vi.mock('server-only', () => ({}))

const { foremanEngineInstructions, foremanSystemPrompt } = await import('./prompt')
import type { ForemanPlan, ForemanState } from './phase'

const ASKED = 'Je cherche un worker capable de trouver des décisionnaires capables de me recruter en alternance'

const HIRING_LEADS = { kind: 'agent' as const, name: 'Hiring Leads', role: 'Finds potential apprenticeship hiring managers and delivers leads for review', need: ASKED, asked: ASKED, box: 'Sales' }

const PLAN: ForemanPlan = { title: 'Your first coworker for finding an apprenticeship', boxes: [{ name: 'Sales' }], items: [HIRING_LEADS] }

function stateWith(patch: Partial<ForemanState>): ForemanState {
    return {
        phase: 'companion',
        intent: null,
        answers: {},
        foreman: { profileAt: 'then', useCases: ['Trouver de nouveaux clients'], needs: [{ job: 'Trouver de nouveaux clients', pain: 'Je ne sais pas où trouver les décideurs' }] },
        onboardingCompletedAt: 'then',
        firstName: 'Nico',
        language: 'fr',
        entitled: true,
        trialSpent: false,
        trialNeedsCard: true,
        priceArm: '49',
        client: 'web',
        workspaceName: "Nico's workspace",
        workspacePlan: 'base',
        userEmail: null,
        spaces: [],
        agents: [],
        ...patch,
    }
}

describe('foremanEngineInstructions', () => {
    it('knows that only a coworker on a ChatGPT connection can generate an image, and says who to hand it to', () => {
        const prompt = foremanEngineInstructions(stateWith({}))
        expect(prompt).toContain('runs on a ChatGPT connection (provider codex) generates and edits images')
        expect(prompt).toContain('hand it the request with send_message')
        expect(prompt).toContain('Never tell the user that the ChatGPT plan only covers text')
    })

    it('carries the coworker they agreed on and their correction, over what the interview heard first', () => {
        const instructions = foremanEngineInstructions(stateWith({ foreman: { ...stateWith({}).foreman, plan: PLAN } }))
        expect(instructions).toContain('The first coworker they agreed on during onboarding: Hiring Leads, Finds potential apprenticeship hiring managers and delivers leads for review.')
        expect(instructions).toContain(`What they asked for when they changed it, in their own words: "${ASKED}"`)
        expect(instructions).toContain('Where this and what you know above disagree, this wins')
    })

    it('cuts a long correction short, since it is read on every turn', () => {
        const long = 'a'.repeat(2000)
        const instructions = foremanEngineInstructions(stateWith({ foreman: { plan: { ...PLAN, items: [{ ...HIRING_LEADS, asked: long }] } } }))
        expect(instructions).toContain(`"${'a'.repeat(600)}…"`)
        expect(instructions).not.toContain('a'.repeat(601))
    })

    it('names the coworker alone when the card came back confirmed as it was drawn', () => {
        const instructions = foremanEngineInstructions(stateWith({ foreman: { plan: { ...PLAN, items: [{ kind: 'agent', name: 'Closer', role: 'Answers demo requests' }] } } }))
        expect(instructions).toContain('The first coworker they agreed on during onboarding: Closer, Answers demo requests.')
        expect(instructions).not.toContain('when they changed it')
    })

    it('says nothing of a plan for a workspace that never had one, or whose plan was a template', () => {
        expect(foremanEngineInstructions(stateWith({}))).not.toContain('agreed on during onboarding')
        expect(foremanEngineInstructions(stateWith({ foreman: { plan: { title: 'Team', items: [{ kind: 'template', slug: 'buyer-signals' }] } } }))).not.toContain('agreed on during onboarding')
    })
})

describe('foremanSystemPrompt', () => {
    it('leaves the agreed plan to the engine: on the hub the card is still being decided', () => {
        expect(foremanSystemPrompt(stateWith({ phase: 'trial', entitled: false, foreman: { ...stateWith({}).foreman, plan: PLAN } }))).not.toContain('agreed on during onboarding')
    })
})

describe('foremanSystemPrompt in the app', () => {
    const PRICE = /\$\d|a month|card required|free trial|Start free trial|Talk to the team/i

    it('keeps every price, card and trial out of the plan and trial steps', () => {
        for (const phase of ['plan', 'trial'] as const) {
            for (const trialSpent of [false, true]) {
                const prompt = foremanSystemPrompt(stateWith({ phase, entitled: false, trialSpent, client: 'ios', foreman: { ...stateWith({}).foreman, plan: PLAN } }))
                expect(prompt).toContain('They are in the Rerun iPhone app.')
                expect(prompt).not.toMatch(PRICE)
            }
        }
    })

    it.skipIf(!BILLING_ENABLED)('sends a spent trial to the web, and anything else back to the button', () => {
        expect(foremanSystemPrompt(stateWith({ phase: 'trial', entitled: false, trialSpent: true, client: 'ios' }))).toContain('finish setting it up at rerun.build')
        expect(foremanSystemPrompt(stateWith({ phase: 'trial', entitled: false, trialSpent: false, client: 'ios' }))).toContain('"Build my team" button right under your reply tries again')
    })

    it.skipIf(!BILLING_ENABLED)('still quotes the price on the web', () => {
        expect(foremanSystemPrompt(stateWith({ phase: 'trial', entitled: false, client: 'web' }))).toMatch(/\$49 a month/)
        expect(foremanSystemPrompt(stateWith({ phase: 'trial', entitled: false, client: 'web' }))).not.toContain('iPhone app')
    })
})
