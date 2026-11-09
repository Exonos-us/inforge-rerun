import { track } from '@rerun/analytics/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { emit, emitOwnAsk, viewTrialStep } from './useForemanFunnelAnalytics'

vi.mock('@rerun/analytics/client', () => ({ track: vi.fn() }))

let seen: Set<string>
const once = (key: string) => (seen.has(key) ? false : (seen.add(key), true))

function events(): [string, unknown][] {
    return vi.mocked(track).mock.calls.map(([event, props]) => [event, props])
}

function run(tool: string, input: unknown, output: unknown, entitled: boolean) {
    emit(tool, input, output, once, entitled)
}

beforeEach(() => {
    vi.clearAllMocks()
    seen = new Set()
})

describe('the interview cards', () => {
    const card = { title: 'Which job eats your week?', options: ['Finding customers', 'Answering emails'] }

    it('counts the job from the first card they picked a button on', () => {
        run('ask_either', card, { answered: true, question: card.title, answers: ['Finding customers'] }, true)

        expect(events()).toEqual([
            ['onboarding_either_answered', { outcome: 'picked' }],
            ['onboarding_use_cases_selected', { proposed: 2, selected: 1, custom: false }],
        ])
    })

    // A "Neither" picked nothing, so the job is still to be counted on the next card.
    it('tells a "Neither" apart, and keeps the job for the card after it', () => {
        run('ask_either', card, { answered: false, reason: 'neither' }, true)
        run('ask_either', card, { answered: true, question: card.title, answers: ['Answering emails'] }, true)

        expect(events()).toEqual([
            ['onboarding_either_answered', { outcome: 'neither' }],
            ['onboarding_either_answered', { outcome: 'picked' }],
            ['onboarding_use_cases_selected', { proposed: 2, selected: 1, custom: false }],
        ])
    })

    it('reads a card sealed before the reason existed as abandoned', () => {
        run('ask_either', card, { answered: false }, true)

        expect(events()).toEqual([['onboarding_either_answered', { outcome: 'abandoned' }]])
    })
})

describe('the plan step', () => {
    it('opens the build when the plan is already on', () => {
        run('show_plan', { items: [{}, {}] }, { answered: true, confirmed: true }, true)

        expect(events()).toEqual([
            ['onboarding_plan_answered', { confirmed: true, agents: 2 }],
            ['onboarding_step_completed', { step: 'plan', via: 'plan_card' }],
            ['onboarding_step_viewed', { step: 'build' }],
        ])
    })

    it('leaves the next step to the trial card when no plan is on yet', () => {
        run('show_plan', { items: [{}] }, { answered: true, confirmed: true }, false)

        expect(events()).toEqual([
            ['onboarding_plan_answered', { confirmed: true, agents: 1 }],
            ['onboarding_step_completed', { step: 'plan', via: 'plan_card' }],
        ])
    })

    it('says a template was picked rather than a plan confirmed', () => {
        run('show_templates', {}, { chosen: 'weekly-report' }, true)

        expect(events()[0]).toEqual(['onboarding_step_completed', { step: 'plan', via: 'template' }])
    })

    it('counts the coworkers hired off the starter pack', () => {
        run('show_starter_pack', {}, { answered: true, chosen: ['executive-assistant', 'seo-consultant'] }, false)

        expect(events()).toEqual([
            ['onboarding_plan_answered', { confirmed: true, agents: 2, via: 'starter_pack', picked: ['executive-assistant', 'seo-consultant'] }],
            ['onboarding_step_completed', { step: 'plan', via: 'starter_pack' }],
        ])
    })

    it('says they described their own coworker instead of picking one', () => {
        run('show_starter_pack', {}, { answered: true, custom: 'Answer every enquiry within the hour' }, true)

        expect(events()).toEqual([
            ['onboarding_plan_answered', { confirmed: true, agents: 1, via: 'custom', from: 'pack' }],
            ['onboarding_step_completed', { step: 'plan', via: 'custom' }],
            ['onboarding_step_viewed', { step: 'build' }],
        ])
    })

    it('counts nothing for a pack left unanswered', () => {
        run('show_starter_pack', {}, { answered: false, reason: 'abandoned' }, true)

        expect(events()).toEqual([])
    })

    // No card went up: the kickoff carries the line written under the welcome card.
    it('counts the line written under the welcome card as the plan', () => {
        emitOwnAsk(once, true)

        expect(events()).toEqual([
            ['onboarding_plan_answered', { confirmed: true, agents: 1, via: 'custom', from: 'intake' }],
            ['onboarding_step_completed', { step: 'plan', via: 'custom' }],
            ['onboarding_step_viewed', { step: 'build' }],
        ])
    })
})

describe('the trial step', () => {
    it('is viewed once, however many times the card is seen', () => {
        viewTrialStep(once)
        viewTrialStep(once)

        expect(events()).toEqual([['onboarding_step_viewed', { step: 'trial' }]])
    })

    it('stays open on a refusal, and closes into the build once the plan is on', () => {
        run('open_checkout', {}, { ok: false, reason: 'dismissed' }, false)
        run('open_checkout', {}, { ok: true, status: 'entitled' }, true)

        expect(events()).toEqual([
            ['onboarding_checkout_answered', { ok: false, reason: 'dismissed' }],
            ['onboarding_checkout_answered', { ok: true }],
            ['onboarding_step_completed', { step: 'trial' }],
            ['onboarding_step_viewed', { step: 'build' }],
        ])
    })
})

describe('the build step', () => {
    it('closes on a team, and no longer stands in for the first run', () => {
        run('build_team', {}, { agents: [{}, {}], failed: [] }, true)

        expect(events()).toEqual([
            ['onboarding_team_built', { agents: 2, failed: 0, error: false }],
            ['first_agent_created', { template: 'foreman' }],
            ['onboarding_step_completed', { step: 'build' }],
        ])
    })

    it('stays open on a build that made nobody', () => {
        run('build_team', {}, { agents: [], failed: [{}] }, true)

        expect(events()).toEqual([['onboarding_team_built', { agents: 0, failed: 1, error: false }]])
    })
})
