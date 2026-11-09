import type Stripe from 'stripe'
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { MICROS_PER_USD } from '@/ee/lib/billing/plans'
import { PHONE_REQUIRED_MESSAGE } from '@/lib/phone/verification'
import { stripe, subscriptionOfInvoice } from '@/ee/lib/billing/stripe'
import { trialArm } from '@/ee/lib/billing/trial-experiment'
import { fakeSupabase, writeMethodOf } from '@/test/supabase-fake'
import { TRIAL_ACTIVE_AGENTS, TRIAL_DAYS } from '@rerun/contracts'
import {
    acceptPlanTerms,
    applySubscriptionToWorkspace,
    cancelSubscription,
    changePlan,
    completeCardSetupSession,
    createPlanCardSetupSession,
    createPlanCheckoutSession,
    finishPendingPlanChange,
    listInvoices,
    planChangeKind,
    previewPlanChange,
    updatePlanCheckoutSession,
    claimRetentionOffer,
    getCancelFlowState,
    extendTrial,
    getSubscriptionState,
    markSubscriptionCanceled,
    markSubscriptionPastDue,
    previewSubscriptionUpdate,
    readCheckoutOutcome,
    requestRenewalReminder,
    resumeSubscription,
    stampFirstPlanPayment,
    startCardlessTrial,
    syncStripeCustomerEmail,
    removeTaxId,
    saveBusinessDetails,
} from './billing.service'

// Hoisted so the portal tests, which reload the service to reset its cached configuration id, still
// reach the same spies.
const m = vi.hoisted(() => ({
    createServiceRoleClient: vi.fn(),
    requireWorkspaceId: vi.fn(),
    getServerSession: vi.fn(),
    getAppOrigin: vi.fn(),
    affiliateReferralMetadata: vi.fn(),
    reconcileAgentActivation: vi.fn(),
    wakePlanLimitedAgents: vi.fn(),
    requestAgentActivationSync: vi.fn(),
    sendTrialStartedReceipt: vi.fn(),
    sendPaymentFailedNotice: vi.fn(),
    reportSubscriptionCancelled: vi.fn(),
    reportSubscriptionTransition: vi.fn(),
    reportTrialConverted: vi.fn(),
    reportTrialPaymentFailed: vi.fn(),
    requestBoxRestore: vi.fn(),
    resolveEngineWaitlist: vi.fn(),
    syncEnginePlan: vi.fn(),
    isPhoneStepPending: vi.fn(),
}))

vi.mock('@/ee/lib/billing/stripe', async importOriginal => ({
    ...(await importOriginal<typeof import('@/ee/lib/billing/stripe')>()),
    stripe: (await import('@/ee/test/stripe-fake')).fakeStripe(),
    subscriptionOfInvoice: vi.fn(),
}))
vi.mock('@/supabase/serviceRole', () => ({ createServiceRoleClient: m.createServiceRoleClient }))
vi.mock('@/app/api/_auth/ownership', () => ({ requireWorkspaceId: m.requireWorkspaceId }))
vi.mock('@/supabase/session/getServerSession', () => ({ getServerSession: m.getServerSession, getSessionWorkspace: m.getServerSession }))
vi.mock('@/lib/app-origin', () => ({ getAppOrigin: m.getAppOrigin }))
vi.mock('@/ee/lib/billing/affiliate', () => ({ affiliateReferralMetadata: m.affiliateReferralMetadata }))
vi.mock('@/app/api/_services/agent-activation.service', () => ({ reconcileAgentActivation: m.reconcileAgentActivation, wakePlanLimitedAgents: m.wakePlanLimitedAgents }))
vi.mock('@/trigger/sync-agent-activation', () => ({ requestAgentActivationSync: m.requestAgentActivationSync }))
vi.mock('@/ee/lib/lifecycle/trial-receipt', () => ({ sendTrialStartedReceipt: m.sendTrialStartedReceipt }))
vi.mock('@/ee/lib/lifecycle/payment-failed-notice', () => ({ sendPaymentFailedNotice: m.sendPaymentFailedNotice }))
vi.mock('./billing-analytics.service', () => ({
    reportSubscriptionCancelled: m.reportSubscriptionCancelled,
    reportSubscriptionTransition: m.reportSubscriptionTransition,
    reportTrialConverted: m.reportTrialConverted,
    reportTrialPaymentFailed: m.reportTrialPaymentFailed,
}))
vi.mock('@rerun/cloud/engines', () => ({ requestBoxRestore: m.requestBoxRestore }))
vi.mock('@/app/api/_services/waitlist.service', () => ({ resolveEngineWaitlist: m.resolveEngineWaitlist }))
vi.mock('@/app/api/_services/workspace-engine.service', () => ({ syncEnginePlan: m.syncEnginePlan }))
vi.mock('@/app/api/_services/phone-gate.service', () => ({ isPhoneStepPending: m.isPhoneStepPending }))
vi.mock('@/ee/lib/billing/trial-experiment', async importOriginal => {
    const actual = await importOriginal<typeof import('@/ee/lib/billing/trial-experiment')>()
    return { ...actual, trialArm: (id: number, share = 0.5) => actual.trialArm(id, share) }
})

const WORKSPACE_ID = 7
const PERIOD_END = 1_900_000_000
const iso = (seconds: number) => new Date(seconds * 1000).toISOString()

type Row = Record<string, unknown> | null

// Every read of `workspaces` answers the same row: each function only picks the columns it asked for.
function useDb({ row = null, updateError = null, members = 1, invites = 0 }: { row?: Row; updateError?: unknown; members?: number; invites?: number } = {}) {
    const fake = fakeSupabase((table, calls) => {
        if (table === 'workspaces') return writeMethodOf(calls) ? { error: updateError } : { data: row }
        if (table === 'workspace_members') return { count: members }
        if (table === 'workspace_invitations') return { count: invites }
        return undefined
    })
    m.createServiceRoleClient.mockReturnValue(fake.client)
    return { ...fake, updates: () => fake.writes('workspaces').map(write => write.payload as Record<string, unknown>) }
}

type ItemSpec = { price: string; quantity?: number; id?: string; end?: number }

function sub(fields: Record<string, unknown> & { items?: ItemSpec[] } = {}): Stripe.Subscription {
    const { items = [{ price: 'price_base', quantity: 1 }], ...rest } = fields
    return {
        id: 'sub_1',
        object: 'subscription',
        status: 'active',
        customer: 'cus_1',
        metadata: { workspace_id: String(WORKSPACE_ID), plan: 'base' },
        trial_end: null,
        cancel_at: null,
        cancel_at_period_end: false,
        default_payment_method: null,
        automatic_tax: { enabled: true },
        discounts: [],
        items: { data: items.map(({ price, quantity, id, end = PERIOD_END }) => ({ id: id ?? `si_${price}`, quantity, current_period_end: end, price: { id: price, currency: 'usd', unit_amount: 4900 } })) },
        ...rest,
    } as unknown as Stripe.Subscription
}

beforeEach(() => {
    vi.resetAllMocks()
    m.requireWorkspaceId.mockResolvedValue(WORKSPACE_ID)
    m.getServerSession.mockResolvedValue({ session: { email: 'a@b.co' }, isAnonymous: false })
    m.getAppOrigin.mockResolvedValue('https://app.test')
    m.affiliateReferralMetadata.mockResolvedValue({})
    m.resolveEngineWaitlist.mockResolvedValue(false)
    m.wakePlanLimitedAgents.mockResolvedValue({ woken: [], active: [] })
    vi.mocked(stripe.subscriptions.update).mockResolvedValue({ pending_update: null } as never)
    vi.mocked(stripe.paymentIntents.retrieve).mockResolvedValue({ status: 'requires_action' } as never)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('applySubscriptionToWorkspace', () => {
    it('writes nothing for a template subscription', async () => {
        const db = useDb({ row: { current_period_end: null } })
        await applySubscriptionToWorkspace(sub({ metadata: { kind: 'template_purchase', workspace_id: '7' } }))
        expect(db.calls).toEqual([])
    })

    it('writes nothing for a subscription without the base plan item', async () => {
        const db = useDb({ row: { current_period_end: null } })
        await applySubscriptionToWorkspace(sub({ items: [{ price: 'price_agent_pack', quantity: 2 }] }))
        expect(db.updates()).toEqual([])
    })

    it('does nothing when no workspace matches the metadata or the customer', async () => {
        const db = useDb({ row: null })
        await applySubscriptionToWorkspace(sub({ metadata: {}, customer: 'cus_unknown' }))
        expect(db.chainsOn('workspaces')[0]).toContainEqual({ table: 'workspaces', method: 'eq', args: ['stripe_customer_id', 'cus_unknown'] })
        expect(db.updates()).toEqual([])
        expect(m.reportSubscriptionTransition).not.toHaveBeenCalled()
    })

    it('finds the workspace by its Stripe customer when the metadata is empty', async () => {
        const db = useDb({ row: { id: 12, current_period_end: null, rerun_budget_micros: 0 } })
        await applySubscriptionToWorkspace(sub({ metadata: {} }))
        expect(db.writes('workspaces')[0].filters).toEqual([{ table: 'workspaces', method: 'eq', args: ['id', 12] }])
    })

    it('leaves a lifecycle event alone while the workspace is billed on another live subscription', async () => {
        const db = useDb({ row: { stripe_subscription_id: 'sub_other', subscription_status: 'active', current_period_end: null } })
        await applySubscriptionToWorkspace(sub(), { adopt: false })
        expect(db.updates()).toEqual([])
    })

    it('lets a lifecycle event take over once the stored subscription is canceled', async () => {
        const db = useDb({ row: { stripe_subscription_id: 'sub_other', subscription_status: 'canceled', current_period_end: null, rerun_budget_micros: 0 } })
        await applySubscriptionToWorkspace(sub(), { adopt: false })
        expect(db.updates()).toHaveLength(1)
        expect(db.updates()[0]).toMatchObject({ stripe_subscription_id: 'sub_1' })
    })

    it('holds a credit downgrade until the period advances, and lifts a coworker cap left from the packs', async () => {
        const db = useDb({ row: { current_period_end: iso(PERIOD_END), subscription_status: 'active', stripe_subscription_id: 'sub_1', max_agents: 20, max_seats: 10, rerun_budget_micros: 50 * MICROS_PER_USD } })
        await applySubscriptionToWorkspace(sub())
        const [update] = db.updates()
        expect(update).toMatchObject({ max_agents: null, max_seats: null, rerun_budget_micros: 50 * MICROS_PER_USD })
        expect(update).not.toHaveProperty('rerun_used_micros')
    })

    it('keeps an unlimited agent count unlimited mid-period', async () => {
        const db = useDb({ row: { current_period_end: iso(PERIOD_END), subscription_status: 'active', max_agents: null, max_seats: 3, rerun_budget_micros: 0 } })
        await applySubscriptionToWorkspace(sub())
        expect(db.updates()[0].max_agents).toBeNull()
    })

    it('lands an increase mid-period, a legacy agent pack still on the subscription counting for nothing', async () => {
        const db = useDb({ row: { current_period_end: iso(PERIOD_END), subscription_status: 'active', max_agents: 5, max_seats: 3, rerun_budget_micros: 5 * MICROS_PER_USD } })
        await applySubscriptionToWorkspace(sub({ items: [{ price: 'price_base', quantity: 1 }, { price: 'price_agent_pack', quantity: 1 }, { price: 'price_credit_pack', quantity: 2 }] }))
        expect(db.updates()[0]).toMatchObject({ max_agents: null, max_seats: null, rerun_budget_micros: 25 * MICROS_PER_USD })
    })

    it('reads a subscription still holding a legacy agent pack as the plan, never as a template purchase', async () => {
        const db = useDb({ row: { current_period_end: iso(PERIOD_END), subscription_status: 'active', max_agents: 15, max_seats: null, rerun_budget_micros: 5 * MICROS_PER_USD } })
        await applySubscriptionToWorkspace(sub({ items: [{ price: 'price_base_29', quantity: 1 }, { price: 'price_agent_pack', quantity: 2 }] }))
        expect(db.updates()[0]).toMatchObject({ stripe_price_id: 'price_base_29', subscription_status: 'active', max_agents: null })
    })

    it('writes the exact derived limits and resets the credit when the period advances', async () => {
        const db = useDb({ row: { current_period_end: iso(PERIOD_END - 30 * 86_400), subscription_status: 'active', max_agents: 20, max_seats: 10, rerun_budget_micros: 50 * MICROS_PER_USD } })
        await applySubscriptionToWorkspace(sub())
        expect(db.updates()[0]).toMatchObject({
            stripe_subscription_id: 'sub_1',
            stripe_price_id: 'price_base',
            subscription_status: 'active',
            current_period_end: iso(PERIOD_END),
            plan: 'base',
            max_agents: null,
            max_seats: null,
            model_access: 'best',
            custom_integrations: true,
            rerun_budget_micros: 5 * MICROS_PER_USD,
            rerun_used_micros: 0,
            rerun_period_anchor: expect.any(String),
        })
    })

    it('keeps the existing budget on a trial and sends the trial receipt', async () => {
        const db = useDb({ row: { current_period_end: null, subscription_status: null, max_agents: 5, max_seats: 3, rerun_budget_micros: 0 } })
        const trialEnd = PERIOD_END - 86_400
        await applySubscriptionToWorkspace(sub({ status: 'trialing', trial_start: trialEnd - TRIAL_DAYS * 86_400, trial_end: trialEnd }))
        const [update] = db.updates()
        expect(update.rerun_budget_micros).toBe(0)
        expect(update).not.toHaveProperty('rerun_used_micros')
        expect(update.trial_ends_at).toBe(iso(trialEnd))
        expect(update.trial_started_at).toBe(iso(trialEnd - TRIAL_DAYS * 86_400))
        expect(update.max_seats).toBeNull()
        expect(m.sendTrialStartedReceipt).toHaveBeenCalledWith(db.client, WORKSPACE_ID, iso(trialEnd), TRIAL_DAYS, true)
    })

    it('starts a trial on the trial agent count when the signup wrote no cap', async () => {
        const db = useDb({ row: { current_period_end: null, subscription_status: null, max_agents: null, max_seats: null, rerun_budget_micros: 0 } })
        await applySubscriptionToWorkspace(sub({ status: 'trialing', trial_end: PERIOD_END }))
        expect(db.updates()[0].max_agents).toBe(TRIAL_ACTIVE_AGENTS)
    })

    it('starts a trial on the trial agent count, not the plan one', async () => {
        const db = useDb({ row: { current_period_end: null, subscription_status: null, max_agents: 1, max_seats: 3, rerun_budget_micros: 0 } })
        await applySubscriptionToWorkspace(sub({ status: 'trialing', trial_end: PERIOD_END }))
        expect(db.updates()[0].max_agents).toBe(TRIAL_ACTIVE_AGENTS)
    })

    it('keeps a trial raised by hand when the trial is extended', async () => {
        const db = useDb({ row: { current_period_end: iso(PERIOD_END - 86_400), subscription_status: 'trialing', max_agents: 5, max_seats: 3, rerun_budget_micros: 0 } })
        await applySubscriptionToWorkspace(sub({ status: 'trialing', trial_end: PERIOD_END }))
        expect(db.updates()[0].max_agents).toBe(5)
    })

    it('lifts the trial cap when the trial converts', async () => {
        const db = useDb({ row: { current_period_end: iso(PERIOD_END - 86_400), subscription_status: 'trialing', max_agents: TRIAL_ACTIVE_AGENTS, max_seats: 3, rerun_budget_micros: 0 } })
        await applySubscriptionToWorkspace(sub({ status: 'active' }))
        expect(db.updates()[0].max_agents).toBeNull()
    })

    it('lifts the trial cap when the trial is ended early, inside the same period', async () => {
        const db = useDb({ row: { current_period_end: iso(PERIOD_END), subscription_status: 'trialing', max_agents: TRIAL_ACTIVE_AGENTS, max_seats: null, rerun_budget_micros: 0 } })
        await applySubscriptionToWorkspace(sub({ status: 'active' }))
        expect(db.updates()[0].max_agents).toBeNull()
    })

    it('grants no budget to a trial on a workspace with no row read back', async () => {
        const db = useDb({ row: null })
        await applySubscriptionToWorkspace(sub({ status: 'trialing', trial_end: PERIOD_END }))
        expect(db.updates()[0].rerun_budget_micros).toBe(0)
    })

    it('never clears trial_ends_at when the subscription carries no trial', async () => {
        const db = useDb({ row: { current_period_end: null, rerun_budget_micros: 0 } })
        await applySubscriptionToWorkspace(sub({ trial_end: null }))
        expect(db.updates()[0]).not.toHaveProperty('trial_ends_at')
        expect(db.updates()[0]).not.toHaveProperty('trial_started_at')
        expect(m.sendTrialStartedReceipt).not.toHaveBeenCalled()
    })

    it('reads the cancellation date off cancel_at first', async () => {
        const db = useDb({ row: { current_period_end: null, rerun_budget_micros: 0 } })
        await applySubscriptionToWorkspace(sub({ cancel_at: PERIOD_END - 100, cancel_at_period_end: true }))
        expect(db.updates()[0].subscription_cancel_at).toBe(iso(PERIOD_END - 100))
    })

    it('falls back on the period end when only cancel_at_period_end is set', async () => {
        const db = useDb({ row: { current_period_end: null, rerun_budget_micros: 0 } })
        await applySubscriptionToWorkspace(sub({ cancel_at_period_end: true }))
        expect(db.updates()[0].subscription_cancel_at).toBe(iso(PERIOD_END))
    })

    it('clears the cancellation date when the cancellation is withdrawn', async () => {
        const db = useDb({ row: { current_period_end: null, rerun_budget_micros: 0 } })
        await applySubscriptionToWorkspace(sub())
        expect(db.updates()[0]).toHaveProperty('subscription_cancel_at', null)
    })

    it('restores the Box only for a status that keeps its machine', async () => {
        useDb({ row: { current_period_end: null, rerun_budget_micros: 0 } })
        await applySubscriptionToWorkspace(sub({ status: 'active' }))
        expect(m.requestBoxRestore).toHaveBeenCalledWith(WORKSPACE_ID)

        for (const status of ['past_due', 'incomplete'] as const) {
            m.requestBoxRestore.mockClear()
            await applySubscriptionToWorkspace(sub({ status }))
            expect(m.requestBoxRestore).not.toHaveBeenCalled()
        }
    })

    it('reports the transition from the previous status', async () => {
        useDb({ row: { current_period_end: null, subscription_status: 'trialing', rerun_budget_micros: 0 } })
        const subscription = sub()
        await applySubscriptionToWorkspace(subscription)
        expect(m.reportSubscriptionTransition).toHaveBeenCalledWith(subscription, WORKSPACE_ID, 'trialing')
    })

    it('switches back on the coworkers the trial cap had switched off once the trial is paid for', async () => {
        useDb({ row: { current_period_end: null, subscription_status: 'trialing', rerun_budget_micros: 0 } })
        m.wakePlanLimitedAgents.mockResolvedValue({ woken: ['a4'], active: ['a1', 'a2', 'a3'] })
        await applySubscriptionToWorkspace(sub({ status: 'active' }))
        expect(m.wakePlanLimitedAgents).toHaveBeenCalledWith(WORKSPACE_ID)
        expect(m.requestAgentActivationSync).toHaveBeenCalledWith(['a4'], { switchOn: true })
    })

    it.each([
        ['active', 'active'],
        ['trialing', 'trialing'],
        ['trialing', 'past_due'],
        ['canceled', 'active'],
    ] as const)('wakes nothing going from %s to %s', async (before, after) => {
        useDb({ row: { current_period_end: null, subscription_status: before, rerun_budget_micros: 0 } })
        await applySubscriptionToWorkspace(sub({ status: after }))
        expect(m.wakePlanLimitedAgents).not.toHaveBeenCalled()
    })

    it('fails when the workspace write fails, so the webhook answers 500 and Stripe retries', async () => {
        useDb({ row: { current_period_end: null, rerun_budget_micros: 0 }, updateError: { message: 'db down' } })
        await expect(applySubscriptionToWorkspace(sub())).rejects.toMatchObject({ message: 'db down' })
        expect(m.reportSubscriptionTransition).not.toHaveBeenCalled()
    })
})

describe('markSubscriptionCanceled', () => {
    it('ignores a template subscription', async () => {
        const db = useDb({ row: { stripe_subscription_id: 'sub_1' } })
        await markSubscriptionCanceled(sub({ metadata: { kind: 'template_purchase' } }))
        expect(db.calls).toEqual([])
    })

    it('leaves the workspace alone when it is billed on another subscription', async () => {
        const db = useDb({ row: { stripe_subscription_id: 'sub_other' } })
        await markSubscriptionCanceled(sub())
        expect(db.updates()).toEqual([])
        expect(m.reconcileAgentActivation).not.toHaveBeenCalled()
    })

    it('cancels the workspace, switches its agents off and reports it', async () => {
        const db = useDb({ row: { stripe_subscription_id: 'sub_1' } })
        m.reconcileAgentActivation.mockResolvedValue(['a1'])
        const subscription = sub({ status: 'canceled' })
        await markSubscriptionCanceled(subscription)
        expect(db.updates()).toEqual([{ subscription_status: 'canceled' }])
        expect(m.requestAgentActivationSync).toHaveBeenCalledWith(['a1'])
        expect(m.reportSubscriptionCancelled).toHaveBeenCalledWith(subscription, WORKSPACE_ID)
    })

    it('fails when the workspace write fails', async () => {
        useDb({ row: { stripe_subscription_id: 'sub_1' }, updateError: { message: 'db down' } })
        await expect(markSubscriptionCanceled(sub())).rejects.toMatchObject({ message: 'db down' })
        expect(m.reportSubscriptionCancelled).not.toHaveBeenCalled()
    })
})

describe('markSubscriptionPastDue', () => {
    const invoice = { id: 'in_1', attempt_count: 1, amount_due: 4900, currency: 'usd', hosted_invoice_url: 'https://pay.stripe.test/in_1' } as Stripe.Invoice
    const PAID_AT = '2026-08-01T00:00:00.000Z'

    it('tells a paying workspace its renewal was declined, on the first attempt', async () => {
        const db = useDb({ row: { stripe_subscription_id: 'sub_1', subscription_status: 'active', first_paid_at: PAID_AT } })
        await markSubscriptionPastDue(sub(), invoice)
        expect(m.sendPaymentFailedNotice).toHaveBeenCalledWith(db.client, WORKSPACE_ID, { id: 'in_1', amountDueCents: 4900, currency: 'usd', hostedUrl: 'https://pay.stripe.test/in_1', firstCharge: false })
    })

    it('starts the day of grace on the first attempt, and leaves it alone on a retry', async () => {
        const first = useDb({ row: { stripe_subscription_id: 'sub_1', subscription_status: 'active', first_paid_at: PAID_AT } })
        await markSubscriptionPastDue(sub(), invoice)
        expect(first.updates()).toEqual([{ subscription_status: 'past_due', payment_failed_at: expect.any(String) }])

        const retry = useDb({ row: { stripe_subscription_id: 'sub_1', subscription_status: 'past_due', first_paid_at: PAID_AT } })
        await markSubscriptionPastDue(sub(), { ...invoice, attempt_count: 2 } as Stripe.Invoice)
        expect(retry.updates()).toEqual([{ subscription_status: 'past_due' }])
    })

    it('leaves a trial alone while its bank asks for 3-D Secure on the pending change', async () => {
        const db = useDb({ row: { stripe_subscription_id: 'sub_1', subscription_status: 'trialing', first_paid_at: null } })
        await markSubscriptionPastDue(sub({ status: 'trialing', pending_update: { expires_at: 1 }, latest_invoice: 'in_1' }), invoice)
        expect(db.updates()).toEqual([])
        expect(m.sendPaymentFailedNotice).not.toHaveBeenCalled()
        expect(m.reportTrialPaymentFailed).not.toHaveBeenCalled()
    })

    it('stays silent when Stripe retries the same invoice', async () => {
        useDb({ row: { stripe_subscription_id: 'sub_1', subscription_status: 'past_due', first_paid_at: PAID_AT } })
        await markSubscriptionPastDue(sub(), { ...invoice, attempt_count: 2 } as Stripe.Invoice)
        expect(m.sendPaymentFailedNotice).not.toHaveBeenCalled()
    })

    it('tells a trial its first charge was declined, as a first charge', async () => {
        useDb({ row: { stripe_subscription_id: 'sub_1', subscription_status: 'trialing', first_paid_at: null } })
        await markSubscriptionPastDue(sub(), invoice)
        expect(m.sendPaymentFailedNotice).toHaveBeenCalledWith(expect.anything(), WORKSPACE_ID, expect.objectContaining({ firstCharge: true }))
    })

    it('flags the workspace past_due without reporting a trial failure on a paid plan', async () => {
        const db = useDb({ row: { stripe_subscription_id: 'sub_1', subscription_status: 'active' } })
        await markSubscriptionPastDue(sub(), invoice)
        expect(db.updates()).toEqual([expect.objectContaining({ subscription_status: 'past_due' })])
        expect(m.reportTrialPaymentFailed).not.toHaveBeenCalled()
    })

    it('reports a failed first charge at the end of a trial', async () => {
        useDb({ row: { stripe_subscription_id: 'sub_1', subscription_status: 'trialing' } })
        const subscription = sub()
        await markSubscriptionPastDue(subscription, invoice)
        expect(m.reportTrialPaymentFailed).toHaveBeenCalledWith(subscription, WORKSPACE_ID, invoice)
    })

    it('ignores a sibling subscription the workspace is not billed on', async () => {
        const db = useDb({ row: { stripe_subscription_id: 'sub_other', subscription_status: 'active' } })
        await markSubscriptionPastDue(sub(), invoice)
        expect(db.updates()).toEqual([])
    })

    it('fails when the workspace write fails', async () => {
        useDb({ row: { stripe_subscription_id: 'sub_1', subscription_status: 'trialing' }, updateError: { message: 'db down' } })
        await expect(markSubscriptionPastDue(sub(), invoice)).rejects.toMatchObject({ message: 'db down' })
        expect(m.reportTrialPaymentFailed).not.toHaveBeenCalled()
    })
})

describe('stampFirstPlanPayment', () => {
    const paid = { id: 'in_1', amount_paid: 4900 } as Stripe.Invoice

    it('stamps nothing for a zero invoice', async () => {
        const db = useDb({ row: { stripe_subscription_id: 'sub_1', first_paid_at: null } })
        await stampFirstPlanPayment({ id: 'in_0', amount_paid: 0 } as Stripe.Invoice)
        expect(subscriptionOfInvoice).not.toHaveBeenCalled()
        expect(db.calls).toEqual([])
        expect(m.reportTrialConverted).not.toHaveBeenCalled()
    })

    it('stamps the first real charge on the plan', async () => {
        const subscription = sub()
        vi.mocked(subscriptionOfInvoice).mockResolvedValue(subscription)
        const db = useDb({ row: { stripe_subscription_id: 'sub_1', first_paid_at: null } })
        await stampFirstPlanPayment(paid)
        expect(db.updates()).toEqual([{ first_paid_at: expect.any(String) }])
        expect(m.reportTrialConverted).toHaveBeenCalledWith(subscription, WORKSPACE_ID)
    })

    it('keeps the first stamp once set', async () => {
        vi.mocked(subscriptionOfInvoice).mockResolvedValue(sub())
        const db = useDb({ row: { stripe_subscription_id: 'sub_1', first_paid_at: '2026-09-01T00:00:00Z' } })
        await stampFirstPlanPayment(paid)
        expect(db.updates()).toEqual([])
        expect(m.reportTrialConverted).not.toHaveBeenCalled()
    })

    it('ignores a template invoice and a subscription the workspace is not billed on', async () => {
        const db = useDb({ row: { stripe_subscription_id: 'sub_other', first_paid_at: null } })
        vi.mocked(subscriptionOfInvoice).mockResolvedValueOnce(sub({ metadata: { kind: 'template_purchase', workspace_id: '7' } }))
        await stampFirstPlanPayment(paid)
        vi.mocked(subscriptionOfInvoice).mockResolvedValueOnce(sub())
        await stampFirstPlanPayment(paid)
        vi.mocked(subscriptionOfInvoice).mockResolvedValueOnce(null)
        await stampFirstPlanPayment(paid)
        expect(db.updates()).toEqual([])
        expect(m.reportTrialConverted).not.toHaveBeenCalled()
    })

    it('fails when the workspace write fails', async () => {
        vi.mocked(subscriptionOfInvoice).mockResolvedValue(sub())
        useDb({ row: { stripe_subscription_id: 'sub_1', first_paid_at: null }, updateError: { message: 'db down' } })
        await expect(stampFirstPlanPayment(paid)).rejects.toMatchObject({ message: 'db down' })
        expect(m.reportTrialConverted).not.toHaveBeenCalled()
    })
})

describe('startCardlessTrial', () => {
    const ids = Array.from({ length: 200 }, (_, i) => i + 1)
    const cardlessId = ids.find(id => trialArm(id) === 'cardless')!
    const cardId = ids.find(id => trialArm(id) === 'card')!
    const freshWorkspace = { id: cardlessId, name: 'Acme', trial_ends_at: null, subscription_status: null, is_sandbox: false, price_arm: null, stripe_customer_id: 'cus_1', stripe_subscription_id: null, current_period_end: null, rerun_budget_micros: 0 }

    beforeEach(() => {
        m.requireWorkspaceId.mockResolvedValue(cardlessId)
        vi.mocked(stripe.subscriptions.list).mockResolvedValue({ data: [] } as never)
        vi.mocked(stripe.subscriptions.create).mockResolvedValue(sub({ status: 'trialing', trial_end: PERIOD_END, metadata: { workspace_id: String(cardlessId), plan: 'base' } }) as never)
    })

    it('refuses an anonymous session without reading the workspace', async () => {
        m.getServerSession.mockResolvedValue({ session: { email: null }, isAnonymous: true })
        await expect(startCardlessTrial()).resolves.toBe(false)
        expect(m.requireWorkspaceId).not.toHaveBeenCalled()
    })

    it('refuses a sandbox', async () => {
        useDb({ row: { ...freshWorkspace, is_sandbox: true } })
        await expect(startCardlessTrial()).resolves.toBe(false)
        expect(stripe.subscriptions.create).not.toHaveBeenCalled()
    })

    it('answers true without a second subscription when the workspace is already entitled', async () => {
        useDb({ row: { ...freshWorkspace, subscription_status: 'past_due' } })
        await expect(startCardlessTrial()).resolves.toBe(true)
        expect(stripe.subscriptions.create).not.toHaveBeenCalled()
    })

    it('refuses a workspace whose trial is spent', async () => {
        useDb({ row: { ...freshWorkspace, trial_ends_at: '2026-09-01T00:00:00Z', subscription_status: 'canceled' } })
        await expect(startCardlessTrial()).resolves.toBe(false)
        expect(stripe.subscriptions.create).not.toHaveBeenCalled()
    })

    it('sends the card arm of the experiment to the card checkout', async () => {
        m.requireWorkspaceId.mockResolvedValue(cardId)
        useDb({ row: { ...freshWorkspace, id: cardId } })
        await expect(startCardlessTrial()).resolves.toBe(false)
        expect(stripe.subscriptions.create).not.toHaveBeenCalled()
    })

    it('starts the card arm without a card from the app, which sells nothing', async () => {
        m.requireWorkspaceId.mockResolvedValue(cardId)
        useDb({ row: { ...freshWorkspace, id: cardId } })
        await expect(startCardlessTrial('ios')).resolves.toBe(true)
        expect(stripe.subscriptions.create).toHaveBeenCalledWith(expect.objectContaining({ trial_settings: { end_behavior: { missing_payment_method: 'cancel' } }, metadata: expect.objectContaining({ workspace_id: String(cardId), origin: 'ios' }) }), { idempotencyKey: `cardless-trial-ws-${cardId}` })
    })

    it('still refuses a spent trial from the app', async () => {
        useDb({ row: { ...freshWorkspace, trial_ends_at: '2026-09-01T00:00:00Z', subscription_status: 'canceled' } })
        await expect(startCardlessTrial('ios')).resolves.toBe(false)
        expect(stripe.subscriptions.create).not.toHaveBeenCalled()
    })

    it('waits for a pending phone step', async () => {
        useDb({ row: freshWorkspace })
        m.isPhoneStepPending.mockResolvedValueOnce(true)
        await expect(startCardlessTrial()).rejects.toThrow(PHONE_REQUIRED_MESSAGE)
        expect(stripe.subscriptions.create).not.toHaveBeenCalled()
    })

    it('refuses a trial while every machine is taken', async () => {
        useDb({ row: freshWorkspace })
        m.resolveEngineWaitlist.mockResolvedValue(true)
        await expect(startCardlessTrial()).rejects.toThrow(/Every machine is taken/)
        expect(stripe.subscriptions.create).not.toHaveBeenCalled()
    })

    it('refuses a second plan subscription found on the customer', async () => {
        useDb({ row: freshWorkspace })
        vi.mocked(stripe.subscriptions.list).mockResolvedValue({ data: [sub({ id: 'sub_live', status: 'past_due' })] } as never)
        await expect(startCardlessTrial()).rejects.toThrow(/already has a subscription/)
        expect(stripe.subscriptions.create).not.toHaveBeenCalled()
    })

    it('creates a usd trial that cancels without a card, idempotent per workspace', async () => {
        const db = useDb({ row: freshWorkspace })
        m.affiliateReferralMetadata.mockResolvedValue({ affonso_referral: 'ref_1' })

        await expect(startCardlessTrial()).resolves.toBe(true)

        expect(stripe.subscriptions.create).toHaveBeenCalledWith(
            expect.objectContaining({
                customer: 'cus_1',
                items: [{ price: 'price_base_29', quantity: 1 }],
                currency: 'usd',
                trial_period_days: TRIAL_DAYS,
                trial_settings: { end_behavior: { missing_payment_method: 'cancel' } },
                automatic_tax: { enabled: false },
                metadata: { workspace_id: String(cardlessId), plan: 'base', origin: 'web', affonso_referral: 'ref_1' },
            }),
            { idempotencyKey: `cardless-trial-ws-${cardlessId}` },
        )
        expect(db.updates()).toContainEqual(expect.objectContaining({ subscription_status: 'trialing', stripe_subscription_id: 'sub_1' }))
    })

    it('bills the trial at the price arm the workspace was drawn into', async () => {
        useDb({ row: { ...freshWorkspace, price_arm: '49' } })
        await startCardlessTrial()
        expect(vi.mocked(stripe.subscriptions.create).mock.calls[0][0]).toMatchObject({ items: [{ price: 'price_base', quantity: 1 }] })
    })
})

describe('readCheckoutOutcome', () => {
    it('refuses a session opened by another workspace', async () => {
        useDb({ row: { subscription_status: 'active' } })
        vi.mocked(stripe.checkout.sessions.retrieve).mockResolvedValue({ metadata: { workspace_id: '99' } } as never)
        await expect(readCheckoutOutcome('cs_1')).rejects.toThrow(/another workspace/)
    })

    it('reports an entitled workspace', async () => {
        useDb({ row: { subscription_status: 'trialing', trial_ends_at: '2026-10-01T00:00:00Z' } })
        vi.mocked(stripe.checkout.sessions.retrieve).mockResolvedValue({ status: 'complete', metadata: { workspace_id: '7' } } as never)
        await expect(readCheckoutOutcome('cs_1')).resolves.toEqual({ state: 'entitled' })
    })

    it('reports a trial refused for a reused card', async () => {
        useDb({ row: { subscription_status: 'canceled', trial_ends_at: '2026-10-01T00:00:00Z' } })
        vi.mocked(stripe.checkout.sessions.retrieve).mockResolvedValue({ status: 'complete', metadata: { workspace_id: '7' } } as never)
        await expect(readCheckoutOutcome('cs_1')).resolves.toEqual({ state: 'trial_refused' })
    })

    it('waits while the webhook has not landed', async () => {
        useDb({ row: { subscription_status: null, trial_ends_at: null } })
        vi.mocked(stripe.checkout.sessions.retrieve).mockResolvedValue({ status: 'complete', metadata: { workspace_id: '7' } } as never)
        await expect(readCheckoutOutcome('cs_1')).resolves.toEqual({ state: 'pending' })
    })
})

describe('changePlan on the same interval', () => {
    const editable = { stripe_subscription_id: 'sub_1', subscription_status: 'active' }
    const current = sub({
        default_payment_method: 'pm_1',
        items: [
            { price: 'price_base', quantity: 1 },
            { price: 'price_agent_pack', quantity: 2, id: 'si_agent' },
            { price: 'price_credit_pack', quantity: 1, id: 'si_credit' },
        ],
    })

    beforeEach(() => {
        vi.mocked(stripe.subscriptions.retrieve).mockResolvedValue(current as never)
        vi.mocked(stripe.customers.retrieve).mockResolvedValue({ invoice_settings: { default_payment_method: null } } as never)
    })

    it('refuses a negative or fractional quantity before touching anything', async () => {
        useDb({ row: editable })
        await expect(changePlan({ quantities: { credit_pack: -1, linkedin_slot: 0, whatsapp_slot: 0 }, interval: 'monthly' })).rejects.toThrow('Invalid add-on quantity.')
        await expect(changePlan({ quantities: { credit_pack: 1.5, linkedin_slot: 0, whatsapp_slot: 0 }, interval: 'monthly' })).rejects.toThrow('Invalid add-on quantity.')
        expect(stripe.subscriptions.retrieve).not.toHaveBeenCalled()
    })

    // A decrease bills nothing back: deleting the legacy pack here would lose the unused part of the
    // period, which the migration script credits when it removes the item.
    it('bills an increase today and leaves a legacy agent pack for the migration to credit', async () => {
        useDb({ row: editable })
        await expect(changePlan({ quantities: { credit_pack: 2, linkedin_slot: 0, whatsapp_slot: 0 }, interval: 'monthly' })).resolves.toEqual({ trialEnded: false, switchAt: null, paymentClientSecret: null })

        expect(vi.mocked(stripe.subscriptions.update).mock.calls).toEqual([
            ['sub_1', { items: [{ id: 'si_credit', quantity: 2 }], proration_behavior: 'always_invoice', payment_behavior: 'pending_if_incomplete', expand: ['latest_invoice.confirmation_secret'] }],
        ])
    })

    const MIXED = { quantities: { credit_pack: 0, linkedin_slot: 1, whatsapp_slot: 0 }, interval: 'monthly' } as const
    const HELD = { pending_update: { expires_at: 1 }, latest_invoice: { id: 'in_pending', confirmation_secret: { client_secret: 'pi_1_secret_2', type: 'payment_intent' } } }

    it('bills the increases before applying the decreases, which forget the selection they carried', async () => {
        useDb({ row: editable })
        await expect(changePlan(MIXED)).resolves.toEqual({ trialEnded: false, switchAt: null, paymentClientSecret: null })

        expect(vi.mocked(stripe.subscriptions.update).mock.calls).toEqual([
            ['sub_1', { items: [{ price: 'price_linkedin_slot', quantity: 1 }], proration_behavior: 'always_invoice', metadata: { plan_change_after_payment: JSON.stringify(MIXED) }, payment_behavior: 'pending_if_incomplete', expand: ['latest_invoice.confirmation_secret'] }],
            ['sub_1', { items: [{ id: 'si_credit', deleted: true }], proration_behavior: 'none', metadata: { plan_change_after_payment: '' } }],
        ])
    })

    it('applies the decreases alone without writing any selection', async () => {
        useDb({ row: editable })
        await changePlan({ quantities: { credit_pack: 0, linkedin_slot: 0, whatsapp_slot: 0 }, interval: 'monthly' })
        expect(vi.mocked(stripe.subscriptions.update).mock.calls).toEqual([['sub_1', { items: [{ id: 'si_credit', deleted: true }], proration_behavior: 'none' }]])
    })

    it('leaves the decreases to the webhook while the bank holds the increase', async () => {
        useDb({ row: editable })
        vi.mocked(stripe.subscriptions.update).mockResolvedValue(HELD as never)

        await expect(changePlan(MIXED)).resolves.toEqual({ trialEnded: false, switchAt: null, paymentClientSecret: 'pi_1_secret_2' })
        expect(stripe.subscriptions.update).toHaveBeenCalledOnce()
        expect(stripe.paymentIntents.retrieve).toHaveBeenCalledWith('pi_1')
    })

    it("refuses a declined card in the card's own words, nothing applied", async () => {
        useDb({ row: editable })
        vi.mocked(stripe.subscriptions.update).mockResolvedValue(HELD as never)
        vi.mocked(stripe.paymentIntents.retrieve).mockResolvedValue({ status: 'requires_payment_method', last_payment_error: { type: 'card_error', message: 'Your card was declined.' } } as never)

        await expect(changePlan(MIXED)).rejects.toThrow('Your card was declined.')
        expect(stripe.subscriptions.update).toHaveBeenCalledOnce()
    })

    it('words any other refusal itself', async () => {
        useDb({ row: editable })
        vi.mocked(stripe.subscriptions.update).mockResolvedValue(HELD as never)
        vi.mocked(stripe.paymentIntents.retrieve).mockResolvedValue({ status: 'requires_payment_method', last_payment_error: { type: 'invalid_request_error', message: 'The PaymentIntent is in an unexpected state.' } } as never)

        await expect(changePlan(MIXED)).rejects.toThrow("We couldn't charge your card. Nothing was charged, try again or change your card.")
    })

    it('ends a trial on the spot with nothing else changed, the start-Pro-now path', async () => {
        useDb({ row: { ...editable, subscription_status: 'trialing' } })
        const trial = sub({ status: 'trialing', default_payment_method: 'pm_1', items: [{ price: 'price_base_29', quantity: 1 }] })
        vi.mocked(stripe.subscriptions.retrieve).mockResolvedValue(trial as never)

        await expect(changePlan({ quantities: { credit_pack: 0, linkedin_slot: 0, whatsapp_slot: 0 }, interval: 'monthly' })).resolves.toEqual({ trialEnded: true, switchAt: null, paymentClientSecret: null })
        expect(stripe.subscriptions.update).toHaveBeenCalledWith('sub_1', {
            items: [{ id: 'si_price_base_29', price: 'price_base_29', quantity: 1 }],
            trial_end: 'now',
            proration_behavior: 'none',
            payment_behavior: 'pending_if_incomplete',
            expand: ['latest_invoice.confirmation_secret'],
        })
    })

    it('refuses to end a trial early without a card, or once it is set to cancel', async () => {
        useDb({ row: { ...editable, subscription_status: 'trialing' } })
        vi.mocked(stripe.subscriptions.retrieve).mockResolvedValueOnce(sub({ status: 'trialing', default_payment_method: null }) as never)
        await expect(changePlan({ quantities: { credit_pack: 0, linkedin_slot: 0, whatsapp_slot: 0 }, interval: 'monthly' })).rejects.toThrow('Add a payment method first.')
        vi.mocked(stripe.subscriptions.retrieve).mockResolvedValueOnce(sub({ status: 'trialing', default_payment_method: 'pm_1', cancel_at_period_end: true }) as never)
        await expect(changePlan({ quantities: { credit_pack: 0, linkedin_slot: 0, whatsapp_slot: 0 }, interval: 'monthly' })).rejects.toThrow(/set to cancel/)
        expect(stripe.subscriptions.update).not.toHaveBeenCalled()
    })

    it('ends a trial on the spot with the whole plan picked, dropping a legacy agent pack', async () => {
        useDb({ row: { ...editable, subscription_status: 'trialing' } })
        vi.mocked(stripe.subscriptions.retrieve).mockResolvedValue({ ...current, status: 'trialing' } as never)

        await expect(changePlan({ quantities: { credit_pack: 1, linkedin_slot: 0, whatsapp_slot: 0 }, interval: 'monthly' })).resolves.toEqual({ trialEnded: true, switchAt: null, paymentClientSecret: null })
        expect(stripe.subscriptions.update).toHaveBeenCalledWith('sub_1', {
            items: [
                { id: 'si_price_base', price: 'price_base', quantity: 1 },
                { id: 'si_agent', deleted: true },
                { id: 'si_credit', price: 'price_credit_pack', quantity: 1 },
            ],
            trial_end: 'now',
            proration_behavior: 'none',
            payment_behavior: 'pending_if_incomplete', expand: ['latest_invoice.confirmation_secret'],
        })
    })

    it('hands the browser the invoice secret when the bank asks for 3-D Secure', async () => {
        useDb({ row: { ...editable, subscription_status: 'trialing' } })
        vi.mocked(stripe.subscriptions.retrieve).mockResolvedValue({ ...current, status: 'trialing' } as never)
        vi.mocked(stripe.subscriptions.update).mockResolvedValue({
            pending_update: { expires_at: 1 },
            latest_invoice: { id: 'in_pending', confirmation_secret: { client_secret: 'pi_1_secret_2', type: 'payment_intent' } },
        } as never)

        await expect(changePlan({ quantities: { credit_pack: 1, linkedin_slot: 0, whatsapp_slot: 0 }, interval: 'monthly' })).resolves.toEqual({
            trialEnded: true,
            switchAt: null,
            paymentClientSecret: 'pi_1_secret_2',
        })
    })

    it('refuses an increase without a payment method', async () => {
        useDb({ row: editable })
        vi.mocked(stripe.subscriptions.retrieve).mockResolvedValue({ ...current, default_payment_method: null } as never)
        await expect(changePlan({ quantities: { credit_pack: 2, linkedin_slot: 0, whatsapp_slot: 0 }, interval: 'monthly' })).rejects.toThrow('Add a payment method first.')
        expect(stripe.subscriptions.update).not.toHaveBeenCalled()
    })

    it('accepts a card held on the customer rather than the subscription', async () => {
        useDb({ row: editable })
        vi.mocked(stripe.subscriptions.retrieve).mockResolvedValue({ ...current, default_payment_method: null } as never)
        vi.mocked(stripe.customers.retrieve).mockResolvedValue({ invoice_settings: { default_payment_method: 'pm_c' } } as never)
        await changePlan({ quantities: { credit_pack: 2, linkedin_slot: 0, whatsapp_slot: 0 }, interval: 'monthly' })
        expect(stripe.subscriptions.update).toHaveBeenCalledOnce()
    })

    it('lets a decrease through without a payment method', async () => {
        useDb({ row: editable })
        vi.mocked(stripe.subscriptions.retrieve).mockResolvedValue({ ...current, default_payment_method: null } as never)
        await changePlan({ quantities: { credit_pack: 0, linkedin_slot: 0, whatsapp_slot: 0 }, interval: 'monthly' })
        expect(stripe.subscriptions.update).toHaveBeenCalledWith('sub_1', { items: [{ id: 'si_credit', deleted: true }], proration_behavior: 'none' })
    })

    it('refuses a workspace without a plan subscription', async () => {
        useDb({ row: { stripe_subscription_id: null, subscription_status: null } })
        await expect(changePlan({ quantities: { credit_pack: 0, linkedin_slot: 0, whatsapp_slot: 0 }, interval: 'monthly' })).rejects.toThrow(/Subscribe first/)
    })

    it('refuses a subscription that is not active or trialing', async () => {
        useDb({ row: { ...editable, subscription_status: 'past_due' } })
        await expect(changePlan({ quantities: { credit_pack: 0, linkedin_slot: 0, whatsapp_slot: 0 }, interval: 'monthly' })).rejects.toThrow('Your subscription is not active.')
    })

    it('refuses to edit a template subscription or one without the base plan', async () => {
        useDb({ row: editable })
        vi.mocked(stripe.subscriptions.retrieve).mockResolvedValueOnce(sub({ metadata: { kind: 'template_purchase' } }) as never)
        await expect(changePlan({ quantities: { credit_pack: 0, linkedin_slot: 0, whatsapp_slot: 0 }, interval: 'monthly' })).rejects.toThrow('No plan subscription found.')
        vi.mocked(stripe.subscriptions.retrieve).mockResolvedValueOnce(sub({ items: [{ price: 'price_agent_pack', quantity: 1 }] }) as never)
        await expect(changePlan({ quantities: { credit_pack: 0, linkedin_slot: 0, whatsapp_slot: 0 }, interval: 'monthly' })).rejects.toThrow('No plan subscription found.')
    })
})

describe('previewSubscriptionUpdate', () => {
    const editable = { stripe_subscription_id: 'sub_1', subscription_status: 'active' }

    it('quotes nothing for a decrease only', async () => {
        useDb({ row: editable })
        vi.mocked(stripe.subscriptions.retrieve).mockResolvedValue(sub({ items: [{ price: 'price_base', quantity: 1 }, { price: 'price_credit_pack', quantity: 2 }] }) as never)
        await expect(previewSubscriptionUpdate({ credit_pack: 1, linkedin_slot: 0, whatsapp_slot: 0 })).resolves.toBeNull()
        expect(stripe.invoices.createPreview).not.toHaveBeenCalled()
    })

    it('quotes only the proration lines of a mid-cycle increase, tax included', async () => {
        useDb({ row: editable })
        vi.mocked(stripe.subscriptions.retrieve).mockResolvedValue(sub() as never)
        vi.mocked(stripe.invoices.createPreview).mockResolvedValue({
            lines: {
                data: [
                    { amount: 500, taxes: [{ amount: 100 }], parent: { subscription_item_details: { proration: true } } },
                    { amount: 5900, taxes: [{ amount: 1180 }], parent: { subscription_item_details: { proration: false } } },
                ],
            },
        } as never)

        await expect(previewSubscriptionUpdate({ credit_pack: 1, linkedin_slot: 0, whatsapp_slot: 0 })).resolves.toEqual({ dueTodayCents: 600, taxCents: 100, taxIncluded: true, nextRenewalIso: iso(PERIOD_END) })
        expect(vi.mocked(stripe.invoices.createPreview).mock.calls[0][0]).toMatchObject({ subscription_details: { proration_behavior: 'always_invoice' } })
    })

    it('quotes nothing it cannot name when no proration line comes back', async () => {
        useDb({ row: editable })
        vi.mocked(stripe.subscriptions.retrieve).mockResolvedValue(sub() as never)
        vi.mocked(stripe.invoices.createPreview).mockResolvedValue({ lines: { data: [{ amount: 5900, parent: null }] } } as never)
        await expect(previewSubscriptionUpdate({ credit_pack: 1, linkedin_slot: 0, whatsapp_slot: 0 })).resolves.toBeNull()
    })

    it('quotes the whole invoice when the increase ends a trial', async () => {
        useDb({ row: { ...editable, subscription_status: 'trialing' } })
        vi.mocked(stripe.subscriptions.retrieve).mockResolvedValue(sub({ status: 'trialing', automatic_tax: { enabled: false } }) as never)
        vi.mocked(stripe.invoices.createPreview).mockResolvedValue({ amount_due: 5900, total_taxes: [] } as never)

        await expect(previewSubscriptionUpdate({ credit_pack: 1, linkedin_slot: 0, whatsapp_slot: 0 })).resolves.toEqual({ dueTodayCents: 5900, taxCents: 0, taxIncluded: false, nextRenewalIso: iso(PERIOD_END) })
        expect(vi.mocked(stripe.invoices.createPreview).mock.calls[0][0]).toMatchObject({ subscription_details: { proration_behavior: 'none', trial_end: 'now' } })
    })
})

describe('extendTrial', () => {
    it('pushes the trial end back by whole days, idempotently', async () => {
        vi.mocked(stripe.subscriptions.retrieve).mockResolvedValue(sub({ status: 'trialing', trial_end: 1_000_000 }) as never)
        await expect(extendTrial('sub_1', 2, 'extend-1')).resolves.toBe(true)
        expect(stripe.subscriptions.update).toHaveBeenCalledWith('sub_1', { trial_end: 1_000_000 + 2 * 86_400, proration_behavior: 'none' }, { idempotencyKey: 'extend-1' })
    })

    it('has nothing to extend outside a trial', async () => {
        vi.mocked(stripe.subscriptions.retrieve).mockResolvedValue(sub({ status: 'active', trial_end: 1_000_000 }) as never)
        await expect(extendTrial('sub_1', 2, 'extend-1')).resolves.toBe(false)
        vi.mocked(stripe.subscriptions.retrieve).mockResolvedValue(sub({ status: 'trialing', trial_end: null }) as never)
        await expect(extendTrial('sub_1', 2, 'extend-1')).resolves.toBe(false)
        expect(stripe.subscriptions.update).not.toHaveBeenCalled()
    })
})

describe('getSubscriptionState', () => {
    const row = { stripe_subscription_id: 'sub_1', subscription_status: 'active', current_period_end: '2030-01-01T00:00:00+00:00', max_agents: 5, max_seats: 3, rerun_budget_micros: 5 * MICROS_PER_USD }

    it('is null for a workspace without a subscription or without the base plan', async () => {
        useDb({ row: { ...row, stripe_subscription_id: null } })
        await expect(getSubscriptionState()).resolves.toBeNull()

        useDb({ row })
        vi.mocked(stripe.subscriptions.retrieve).mockResolvedValue(sub({ items: [{ price: 'price_seat', quantity: 1 }] }) as never)
        await expect(getSubscriptionState()).resolves.toBeNull()
    })

    it('reports the held downgrade, the permanent usd discounts, the card and the next invoice', async () => {
        useDb({ row: { ...row, max_agents: null, max_seats: 6, rerun_budget_micros: 40 * MICROS_PER_USD } })
        const subscription = sub({
            items: [{ price: 'price_base_legacy', quantity: 1 }, { price: 'price_seat', quantity: 1 }],
            customer: { id: 'cus_1', invoice_settings: { default_payment_method: { id: 'pm_1', card: { brand: 'visa', last4: '4242', exp_month: 4, exp_year: 2030 } } } },
            discounts: [
                { source: { coupon: { duration: 'forever', currency: 'usd', amount_off: 300 } } },
                { source: { coupon: { duration: 'forever', currency: 'eur', amount_off: 1000 } } },
                { source: { coupon: { duration: 'once', currency: 'usd', amount_off: 1000 } } },
            ],
        }) as unknown as { items: { data: { price: { unit_amount: number } }[] } }
        subscription.items.data[0].price.unit_amount = 2400
        vi.mocked(stripe.subscriptions.retrieve).mockResolvedValue(subscription as never)
        vi.mocked(stripe.invoices.createPreview).mockResolvedValue({ amount_due: 2400, next_payment_attempt: PERIOD_END, period_end: PERIOD_END } as never)

        await expect(getSubscriptionState()).resolves.toEqual({
            entitled: true,
            status: 'active',
            quantities: { credit_pack: 0, linkedin_slot: 0, whatsapp_slot: 0 },
            interval: 'monthly',
            priceArm: '49',
            pendingSwitch: null,
            monthlyDiscountCents: 300 + 2500,
            pendingDowngrade: { rerun_budget_micros: 5 * MICROS_PER_USD },
            periodEnd: '2030-01-01T00:00:00+00:00',
            card: { brand: 'visa', last4: '4242', expMonth: 4, expYear: 2030 },
            nextInvoice: { at: iso(PERIOD_END), amountCents: 2400 },
            openInvoice: null,
            hasPaymentMethod: true,
            cancelAtPeriodEnd: false,
            cancelPhase: 'paid',
            retentionOffer: null,
            business: { name: null, country: null, taxId: null },
        })
    })

    it('reads the business name, the billing country and the tax ID off the customer', async () => {
        useDb({ row })
        const taxId = { id: 'txi_1', type: 'eu_vat', value: 'FR12345678901', verification: { status: 'verified' } }
        vi.mocked(stripe.subscriptions.retrieve).mockResolvedValue(sub({ customer: { id: 'cus_1', name: 'Acme SAS', address: { country: 'FR' }, tax_ids: { data: [taxId] }, invoice_settings: {} } }) as never)
        vi.mocked(stripe.invoices.createPreview).mockResolvedValue({ amount_due: 4900, period_end: PERIOD_END } as never)

        const state = await getSubscriptionState()
        expect(state?.business).toEqual({ name: 'Acme SAS', country: 'FR', taxId: { type: 'eu_vat', value: 'FR12345678901', status: 'verified' } })
        expect(stripe.subscriptions.retrieve).toHaveBeenCalledWith('sub_1', expect.objectContaining({ expand: expect.arrayContaining(['customer.tax_ids']) }))
    })

    it('reports no coworker downgrade for a workspace still holding agent packs, and no pack in its quantities', async () => {
        useDb({ row: { ...row, max_agents: 20 } })
        vi.mocked(stripe.subscriptions.retrieve).mockResolvedValue(sub({ items: [{ price: 'price_base_29', quantity: 1 }, { price: 'price_agent_pack', quantity: 3 }] }) as never)
        vi.mocked(stripe.invoices.createPreview).mockResolvedValue({ amount_due: 5900, period_end: PERIOD_END } as never)

        const state = await getSubscriptionState()
        expect(state).toMatchObject({ quantities: { credit_pack: 0, linkedin_slot: 0, whatsapp_slot: 0 }, priceArm: '29', pendingDowngrade: {}, nextInvoice: { at: iso(PERIOD_END), amountCents: 5900 } })
        expect(stripe.coupons.retrieve).not.toHaveBeenCalled()
    })

    it('reads the switch to monthly waiting on a schedule, and the open invoice of a failed payment', async () => {
        useDb({ row: { ...row, subscription_status: 'past_due' } })
        vi.mocked(stripe.subscriptions.retrieve).mockResolvedValue(sub({ status: 'past_due', schedule: 'sub_sched_1', items: [{ price: 'price_base_yearly', quantity: 1 }] }) as never)
        vi.mocked(stripe.invoices.createPreview).mockResolvedValue({ amount_due: 46800, period_end: PERIOD_END } as never)
        vi.mocked(stripe.invoices.list).mockResolvedValue({ data: [{ amount_due: 46800, created: PERIOD_END - 86_400 }] } as never)
        vi.mocked(stripe.subscriptionSchedules.retrieve).mockResolvedValue({
            phases: [
                { start_date: 1_000, items: [{ price: 'price_base_yearly', quantity: 1 }] },
                { start_date: PERIOD_END, items: [{ price: 'price_base', quantity: 1 }, { price: 'price_agent_pack', quantity: 2 }] },
            ],
        } as never)

        const state = await getSubscriptionState()
        expect(state?.interval).toBe('yearly')
        expect(state?.pendingSwitch).toEqual({ selection: { quantities: { credit_pack: 0, linkedin_slot: 0, whatsapp_slot: 0 }, interval: 'monthly' }, at: iso(PERIOD_END) })
        expect(state?.openInvoice).toEqual({ amountCents: 46800, createdAt: iso(PERIOD_END - 86_400) })
    })

    it('does not count a trial budget above the plan as a pending downgrade', async () => {
        useDb({ row: { ...row, subscription_status: 'trialing', rerun_budget_micros: 40 * MICROS_PER_USD } })
        vi.mocked(stripe.subscriptions.retrieve).mockResolvedValue(sub({ status: 'trialing' }) as never)
        const state = await getSubscriptionState()
        expect(state?.pendingDowngrade).toEqual({})
        expect(state?.hasPaymentMethod).toBe(false)
    })
})

describe('the cancel flow', () => {
    const DAY_S = 86_400
    const nowS = () => Math.floor(Date.now() / 1000)
    const paidRow = { stripe_subscription_id: 'sub_1', subscription_status: 'active' }

    function paying(fields: Record<string, unknown> = {}) {
        const end = nowS() + 27 * DAY_S
        const subscription = sub({ default_payment_method: 'pm_1', items: [{ price: 'price_base', quantity: 1, end }], ...fields }) as unknown as { items: { data: Record<string, unknown>[] } }
        subscription.items.data[0].current_period_start = end - 30 * DAY_S
        subscription.items.data[0].price = { id: 'price_base', currency: 'usd', unit_amount: 4900, product: 'prod_base' }
        return subscription as unknown as Stripe.Subscription
    }

    describe('getCancelFlowState', () => {
        it('quotes the share of the month already paid, the reminder and the $1 offer', async () => {
            useDb({ row: paidRow })
            vi.mocked(stripe.subscriptions.retrieve).mockResolvedValue(paying() as never)

            const state = await getCancelFlowState()

            expect(state.phase).toBe('paid')
            expect(state.paidLeftCents).toBe(4410)
            expect(Date.parse(state.endsAt) - Date.parse(state.reminderAt ?? '')).toBe(7 * DAY_S * 1000)
            expect(state.offer).toMatchObject({ kind: 'base_1usd', priceCents: 100, fullPriceCents: 4900, basePriceCents: 4900 })
        })

        it('words the $1 offer against $29 for a subscription sold at $29', async () => {
            useDb({ row: paidRow })
            const subscription = paying() as unknown as { items: { data: { price: { id: string } }[] } }
            subscription.items.data[0].price.id = 'price_base_29'
            vi.mocked(stripe.subscriptions.retrieve).mockResolvedValue(subscription as never)

            const state = await getCancelFlowState()

            expect(state.offer).toMatchObject({ kind: 'base_1usd', priceCents: 100, fullPriceCents: 2900, basePriceCents: 2900 })
        })

        it('offers half off the first month to a trial with a card, and no reminder in its last day', async () => {
            useDb({ row: { ...paidRow, subscription_status: 'trialing' } })
            vi.mocked(stripe.subscriptions.retrieve).mockResolvedValue(paying({ status: 'trialing', trial_end: nowS() + 12 * 3600 }) as never)

            const state = await getCancelFlowState()

            expect(state).toMatchObject({ phase: 'trial', reminderAt: null, paidLeftCents: 0, offer: { kind: 'trial_half', priceCents: 2450 } })
        })

        it('makes no offer to a workspace that already had one', async () => {
            useDb({ row: paidRow })
            vi.mocked(stripe.subscriptions.retrieve).mockResolvedValue(paying({ metadata: { workspace_id: String(WORKSPACE_ID), retention_offer_claimed_at: '2026-09-01T00:00:00Z' } }) as never)

            await expect(getCancelFlowState()).resolves.toMatchObject({ offer: null })
        })

        it('refuses a trial without a card, which ends on its own', async () => {
            useDb({ row: { ...paidRow, subscription_status: 'trialing' } })
            vi.mocked(stripe.subscriptions.retrieve).mockResolvedValue(paying({ status: 'trialing', default_payment_method: null, trial_end: nowS() + DAY_S }) as never)
            vi.mocked(stripe.customers.retrieve).mockResolvedValue({ invoice_settings: { default_payment_method: null } } as never)

            await expect(getCancelFlowState()).rejects.toThrow(/ends on its own/)
        })
    })

    it('cancels at the end of the period with the reason in cancellation_details', async () => {
        useDb({ row: paidRow })
        vi.mocked(stripe.subscriptions.retrieve).mockResolvedValue(paying() as never)

        await cancelSubscription({ reason: 'too_expensive', comeback: 'maybe', comment: 'Too much for one coworker', check: 'genuine' })

        expect(stripe.subscriptions.update).toHaveBeenCalledWith('sub_1', {
            cancel_at_period_end: true,
            cancellation_details: { feedback: 'too_expensive', comment: 'Too much for one coworker' },
            metadata: { cancel_comeback: 'maybe', cancel_reason_check: 'genuine' },
        })
    })

    it('resumes a cancelled subscription, and leaves a running one alone', async () => {
        useDb({ row: paidRow })
        vi.mocked(stripe.subscriptions.retrieve).mockResolvedValueOnce(paying({ cancel_at_period_end: true }) as never)
        await resumeSubscription()
        expect(stripe.subscriptions.update).toHaveBeenCalledWith('sub_1', { cancel_at_period_end: false })

        vi.mocked(stripe.subscriptions.update).mockClear()
        vi.mocked(stripe.subscriptions.retrieve).mockResolvedValueOnce(paying() as never)
        await resumeSubscription()
        expect(stripe.subscriptions.update).not.toHaveBeenCalled()
    })

    describe('claimRetentionOffer', () => {
        it('mints the base-plan coupon once and stamps the claim on the subscription', async () => {
            useDb({ row: paidRow })
            vi.mocked(stripe.subscriptions.retrieve).mockResolvedValue(paying() as never)
            vi.mocked(stripe.coupons.retrieve).mockRejectedValue(Object.assign(new Error('No such coupon'), { code: 'resource_missing' }))
            vi.mocked(stripe.coupons.create).mockResolvedValue({ id: 'rerun_retention_base_1usd' } as never)

            await expect(claimRetentionOffer()).resolves.toBe('base_1usd')

            expect(stripe.coupons.create).toHaveBeenCalledWith(expect.objectContaining({ id: 'rerun_retention_base_1usd', amount_off: 4800, duration: 'once', applies_to: { products: ['prod_base'] } }))
            const [id, params, options] = vi.mocked(stripe.subscriptions.update).mock.calls[0]
            expect(id).toBe('sub_1')
            expect(params).toMatchObject({ discounts: [{ coupon: 'rerun_retention_base_1usd' }], metadata: { retention_offer_claimed_at: expect.any(String) } })
            expect(options).toEqual({ idempotencyKey: 'retention-offer:sub_1' })
        })

        it('reuses the coupon that already exists', async () => {
            useDb({ row: { ...paidRow, subscription_status: 'trialing' } })
            vi.mocked(stripe.subscriptions.retrieve).mockResolvedValue(paying({ status: 'trialing', trial_end: nowS() + 2 * DAY_S }) as never)
            vi.mocked(stripe.coupons.retrieve).mockResolvedValue({ id: 'rerun_retention_trial_half' } as never)

            await expect(claimRetentionOffer()).resolves.toBe('trial_half')
            expect(stripe.coupons.create).not.toHaveBeenCalled()
        })

        it('refuses a second claim, and never stacks on another discount', async () => {
            useDb({ row: paidRow })
            vi.mocked(stripe.subscriptions.retrieve).mockResolvedValueOnce(paying({ metadata: { retention_offer_claimed_at: '2026-09-01T00:00:00Z' } }) as never)
            await expect(claimRetentionOffer()).rejects.toThrow(/no longer available/)

            vi.mocked(stripe.subscriptions.retrieve).mockResolvedValueOnce(paying({ discounts: ['di_1'] }) as never)
            await expect(claimRetentionOffer()).rejects.toThrow(/no longer available/)

            expect(stripe.subscriptions.update).not.toHaveBeenCalled()
        })
    })

    describe('requestRenewalReminder', () => {
        it('stores the reminder a week before the renewal, for the person who asked', async () => {
            const db = useDb({ row: paidRow })
            m.getServerSession.mockResolvedValue({ user: { id: 'user-1', workspace_id: WORKSPACE_ID } })
            const subscription = paying()
            vi.mocked(stripe.subscriptions.retrieve).mockResolvedValue(subscription as never)

            const at = await requestRenewalReminder()

            const end = (subscription.items.data[0] as unknown as { current_period_end: number }).current_period_end
            expect(Date.parse(at)).toBe((end - 7 * DAY_S) * 1000)
            expect(db.updates()).toEqual([{ renewal_reminder_at: at, renewal_reminder_user_id: 'user-1' }])
        })

        it('refuses a renewal too close to remind about', async () => {
            useDb({ row: paidRow })
            m.getServerSession.mockResolvedValue({ user: { id: 'user-1', workspace_id: WORKSPACE_ID } })
            vi.mocked(stripe.subscriptions.retrieve).mockResolvedValue(sub({ default_payment_method: 'pm_1', items: [{ price: 'price_base', quantity: 1, end: nowS() + 3 * DAY_S }] }) as never)

            await expect(requestRenewalReminder()).rejects.toThrow(/too soon/)
        })
    })
})

describe('createPlanCheckoutSession', () => {
    const FRESH_WORKSPACE = { id: WORKSPACE_ID, name: 'Acme', trial_ends_at: null, subscription_status: null, is_sandbox: false, stripe_customer_id: 'cus_1', stripe_subscription_id: null }
    const BASE_SELECTION = { quantities: { credit_pack: 0, linkedin_slot: 0, whatsapp_slot: 0 }, interval: 'monthly' } as const

    beforeEach(() => {
        vi.mocked(stripe.subscriptions.list).mockResolvedValue({ data: [] } as never)
        vi.mocked(stripe.checkout.sessions.create).mockResolvedValue({ id: 'cs_1', client_secret: 'secret_1' } as never)
        vi.mocked(stripe.customers.retrieve).mockResolvedValue({ email: 'a@b.co' } as never)
    })

    it('turns away an account that still owes its phone number, before anything reaches Stripe', async () => {
        useDb({ row: { ...FRESH_WORKSPACE, stripe_customer_id: null } })
        m.isPhoneStepPending.mockResolvedValueOnce(true)
        await expect(createPlanCheckoutSession(BASE_SELECTION)).rejects.toThrow(PHONE_REQUIRED_MESSAGE)
        expect(stripe.customers.create).not.toHaveBeenCalled()
        expect(stripe.checkout.sessions.create).not.toHaveBeenCalled()
    })

    it('lends the placeholder of a phone account to a customer without an email', async () => {
        useDb({ row: FRESH_WORKSPACE })
        m.getServerSession.mockResolvedValue({ session: { email: '393480000000@phone.rerun.build' }, isAnonymous: false })
        vi.mocked(stripe.customers.retrieve).mockResolvedValue({ email: null } as never)
        await createPlanCheckoutSession(BASE_SELECTION)
        expect(stripe.customers.update).toHaveBeenCalledWith('cus_1', { email: '393480000000@phone.rerun.build' })
    })

    it('leaves the email of a customer that has one', async () => {
        useDb({ row: FRESH_WORKSPACE })
        await createPlanCheckoutSession(BASE_SELECTION)
        expect(stripe.customers.update).not.toHaveBeenCalled()
    })

    it('sells the selection in the app-rendered mode, billed today once the trial is spent', async () => {
        useDb({ row: { stripe_customer_id: 'cus_1', trial_ends_at: '2026-01-01', subscription_status: 'canceled', price_arm: '49' } })
        await expect(createPlanCheckoutSession({ quantities: { credit_pack: 1, linkedin_slot: 0, whatsapp_slot: 0 }, interval: 'yearly' })).resolves.toEqual({ clientSecret: 'secret_1', sessionId: 'cs_1', trial: false })

        const params = vi.mocked(stripe.checkout.sessions.create).mock.calls[0][0]!
        expect(params).toMatchObject({
            mode: 'subscription',
            ui_mode: 'elements',
            billing_address_collection: 'required',
            line_items: [
                { price: 'price_base_yearly', quantity: 1 },
                { price: 'price_credit_pack_yearly', quantity: 1 },
            ],
        })
        expect(params).not.toHaveProperty('custom_text')
        expect(params.subscription_data).not.toHaveProperty('trial_period_days')
    })

    it('sells the base plan monthly on a card trial, whatever was asked', async () => {
        useDb({ row: { stripe_customer_id: 'cus_1', trial_ends_at: null, subscription_status: null, price_arm: '49' } })
        await expect(createPlanCheckoutSession({ quantities: { credit_pack: 2, linkedin_slot: 0, whatsapp_slot: 0 }, interval: 'yearly' })).resolves.toMatchObject({ trial: true })

        const params = vi.mocked(stripe.checkout.sessions.create).mock.calls[0][0]!
        expect(params.line_items).toEqual([{ price: 'price_base', quantity: 1 }])
        expect(params.metadata).toMatchObject({ card_trial: '1', workspace_id: '7' })
        expect(params.subscription_data).toMatchObject({ trial_period_days: TRIAL_DAYS })
        expect(params.payment_method_types).toEqual(['card', 'link'])
    })

    it('sells the base plan at the price of the arm the workspace was drawn into', async () => {
        useDb({ row: { ...FRESH_WORKSPACE, price_arm: '29' } })
        await createPlanCheckoutSession(BASE_SELECTION)
        expect(vi.mocked(stripe.checkout.sessions.create).mock.calls[0][0]!.line_items).toEqual([{ price: 'price_base_29', quantity: 1 }])
    })

    it('prices the yearly plan of the $29 arm on its own yearly price, the add-ons on theirs', async () => {
        useDb({ row: { ...FRESH_WORKSPACE, price_arm: '29', trial_ends_at: '2026-01-01', subscription_status: 'canceled' } })
        await createPlanCheckoutSession({ quantities: { credit_pack: 2, linkedin_slot: 0, whatsapp_slot: 0 }, interval: 'yearly' })
        expect(vi.mocked(stripe.checkout.sessions.create).mock.calls[0][0]!.line_items).toEqual([
            { price: 'price_base_29_yearly', quantity: 1 },
            { price: 'price_credit_pack_yearly', quantity: 2 },
        ])
    })

    it('refuses a trial while every machine is taken', async () => {
        useDb({ row: FRESH_WORKSPACE })
        m.resolveEngineWaitlist.mockResolvedValue(true)
        await expect(createPlanCheckoutSession(BASE_SELECTION)).rejects.toThrow(/Every machine is taken/)
        expect(stripe.checkout.sessions.create).not.toHaveBeenCalled()
    })

    it('refuses a second plan subscription found on the customer', async () => {
        useDb({ row: FRESH_WORKSPACE })
        vi.mocked(stripe.subscriptions.list).mockResolvedValue({ data: [sub({ id: 'sub_live', status: 'past_due' })] } as never)
        await expect(createPlanCheckoutSession(BASE_SELECTION)).rejects.toThrow(/already has a subscription/)
        expect(stripe.checkout.sessions.create).not.toHaveBeenCalled()
    })

    it('refuses when the stored subscription is still billed', async () => {
        useDb({ row: { ...FRESH_WORKSPACE, stripe_subscription_id: 'sub_old' } })
        vi.mocked(stripe.subscriptions.retrieve).mockResolvedValue(sub({ id: 'sub_old', status: 'unpaid' }) as never)
        await expect(createPlanCheckoutSession(BASE_SELECTION)).rejects.toThrow(/already has a subscription/)
    })

    it('ignores live template subscriptions and dead plan ones on the customer', async () => {
        useDb({ row: { ...FRESH_WORKSPACE, stripe_subscription_id: 'sub_gone' } })
        vi.mocked(stripe.subscriptions.retrieve).mockRejectedValue(new Error('No such subscription'))
        vi.mocked(stripe.subscriptions.list).mockResolvedValue({
            data: [sub({ id: 'sub_tpl', metadata: { kind: 'template_purchase' } }), sub({ id: 'sub_dead', status: 'canceled' })],
        } as never)
        await expect(createPlanCheckoutSession(BASE_SELECTION)).resolves.toMatchObject({ trial: true })
    })

    it('creates the Stripe customer first when the workspace has none', async () => {
        const db = useDb({ row: { ...FRESH_WORKSPACE, stripe_customer_id: null } })
        vi.mocked(stripe.customers.create).mockResolvedValue({ id: 'cus_new' } as never)
        await createPlanCheckoutSession(BASE_SELECTION)
        expect(stripe.customers.create).toHaveBeenCalledWith({ email: 'a@b.co', name: 'Acme', metadata: { workspace_id: String(WORKSPACE_ID) } })
        expect(db.updates()[0]).toEqual({ stripe_customer_id: 'cus_new' })
        expect(vi.mocked(stripe.checkout.sessions.create).mock.calls[0][0]).toMatchObject({ customer: 'cus_new' })
    })

    it('refuses an unknown interval', async () => {
        useDb({ row: { stripe_customer_id: 'cus_1' } })
        await expect(createPlanCheckoutSession({ quantities: { credit_pack: 0, linkedin_slot: 0, whatsapp_slot: 0 }, interval: 'weekly' as never })).rejects.toThrow('Invalid billing interval.')
    })
})

describe('updatePlanCheckoutSession', () => {
    it('sends the whole list of line items again', async () => {
        useDb({ row: { price_arm: '49' } })
        vi.mocked(stripe.checkout.sessions.retrieve).mockResolvedValue({ status: 'open', mode: 'subscription', metadata: { workspace_id: '7' } } as never)
        await updatePlanCheckoutSession('cs_1', { quantities: { credit_pack: 1, linkedin_slot: 0, whatsapp_slot: 0 }, interval: 'monthly' })
        expect(stripe.checkout.sessions.update).toHaveBeenCalledWith('cs_1', { line_items: [{ price: 'price_base', quantity: 1 }, { price: 'price_credit_pack', quantity: 1 }] })
    })

    it('keeps the price of the arm when the selection changes', async () => {
        useDb({ row: { price_arm: '29' } })
        vi.mocked(stripe.checkout.sessions.retrieve).mockResolvedValue({ status: 'open', mode: 'subscription', metadata: { workspace_id: '7' } } as never)
        await updatePlanCheckoutSession('cs_1', { quantities: { credit_pack: 0, linkedin_slot: 0, whatsapp_slot: 0 }, interval: 'yearly' })
        expect(stripe.checkout.sessions.update).toHaveBeenCalledWith('cs_1', { line_items: [{ price: 'price_base_29_yearly', quantity: 1 }] })
    })

    it('refuses the session of another workspace, a closed one and a card trial', async () => {
        vi.mocked(stripe.checkout.sessions.retrieve).mockResolvedValueOnce({ status: 'open', mode: 'subscription', metadata: { workspace_id: '8' } } as never)
        await expect(updatePlanCheckoutSession('cs_1', { quantities: { credit_pack: 0, linkedin_slot: 0, whatsapp_slot: 0 }, interval: 'monthly' })).rejects.toThrow(/another workspace/)
        vi.mocked(stripe.checkout.sessions.retrieve).mockResolvedValueOnce({ status: 'complete', mode: 'subscription', metadata: { workspace_id: '7' } } as never)
        await expect(updatePlanCheckoutSession('cs_1', { quantities: { credit_pack: 0, linkedin_slot: 0, whatsapp_slot: 0 }, interval: 'monthly' })).rejects.toThrow(/closed/)
        vi.mocked(stripe.checkout.sessions.retrieve).mockResolvedValueOnce({ status: 'open', mode: 'subscription', metadata: { workspace_id: '7', card_trial: '1' } } as never)
        await expect(updatePlanCheckoutSession('cs_1', { quantities: { credit_pack: 0, linkedin_slot: 0, whatsapp_slot: 0 }, interval: 'monthly' })).rejects.toThrow(/trial plan/)
        expect(stripe.checkout.sessions.update).not.toHaveBeenCalled()
    })

    it('records the terms acceptance on the session', async () => {
        vi.mocked(stripe.checkout.sessions.retrieve).mockResolvedValue({ status: 'open', mode: 'subscription', metadata: { workspace_id: '7' } } as never)
        await acceptPlanTerms('cs_1')
        expect(stripe.checkout.sessions.update).toHaveBeenCalledWith('cs_1', { metadata: { terms_accepted_at: expect.any(String) } })
    })
})

describe('planChangeKind', () => {
    it('routes a selection by status and interval', () => {
        expect(planChangeKind('trialing', 'monthly', 'yearly')).toBe('end_trial')
        expect(planChangeKind('active', 'monthly', 'monthly')).toBe('same_interval')
        expect(planChangeKind('active', 'monthly', 'yearly')).toBe('switch_now')
        expect(planChangeKind('active', 'yearly', 'monthly')).toBe('switch_at_renewal')
    })
})

describe('changePlan', () => {
    const monthly = sub({
        default_payment_method: 'pm_1',
        items: [
            { price: 'price_base', quantity: 1, id: 'si_base' },
            { price: 'price_agent_pack', quantity: 2, id: 'si_agent' },
            { price: 'price_seat', quantity: 1, id: 'si_seat' },
        ],
    })

    beforeEach(() => {
        vi.mocked(stripe.customers.retrieve).mockResolvedValue({ invoice_settings: { default_payment_method: null } } as never)
    })

    it('keeps a subscription sold at $29 on the $29 price when it switches interval', async () => {
        useDb({ row: { stripe_subscription_id: 'sub_1', subscription_status: 'trialing' } })
        vi.mocked(stripe.subscriptions.retrieve).mockResolvedValue(sub({ status: 'trialing', default_payment_method: 'pm_1', items: [{ price: 'price_base_29', quantity: 1, id: 'si_base' }] }) as never)

        await changePlan({ quantities: { credit_pack: 0, linkedin_slot: 0, whatsapp_slot: 0 }, interval: 'yearly' })

        expect(vi.mocked(stripe.subscriptions.update).mock.calls[0][1]).toMatchObject({ items: [{ id: 'si_base', price: 'price_base_29_yearly', quantity: 1 }] })
    })

    it('ends a trial with the whole new plan billed today', async () => {
        useDb({ row: { stripe_subscription_id: 'sub_1', subscription_status: 'trialing' } })
        vi.mocked(stripe.subscriptions.retrieve).mockResolvedValue({ ...monthly, status: 'trialing' } as never)

        await expect(changePlan({ quantities: { credit_pack: 0, linkedin_slot: 0, whatsapp_slot: 0 }, interval: 'yearly' })).resolves.toEqual({ trialEnded: true, switchAt: null, paymentClientSecret: null })
        expect(stripe.subscriptions.update).toHaveBeenCalledWith('sub_1', {
            items: [
                { id: 'si_base', price: 'price_base_yearly', quantity: 1 },
                { id: 'si_agent', deleted: true },
                { id: 'si_seat', deleted: true },
            ],
            trial_end: 'now',
            proration_behavior: 'none',
            payment_behavior: 'pending_if_incomplete', expand: ['latest_invoice.confirmation_secret'],
        })
    })

    it('refuses to end a trial without a card', async () => {
        useDb({ row: { stripe_subscription_id: 'sub_1', subscription_status: 'trialing' } })
        vi.mocked(stripe.subscriptions.retrieve).mockResolvedValue({ ...monthly, status: 'trialing', default_payment_method: null } as never)
        await expect(changePlan({ quantities: { credit_pack: 0, linkedin_slot: 0, whatsapp_slot: 0 }, interval: 'monthly' })).rejects.toThrow('Add a payment method first.')
        expect(stripe.subscriptions.update).not.toHaveBeenCalled()
    })

    it('starts the year today on a switch from monthly, the unused month prorated', async () => {
        useDb({ row: { stripe_subscription_id: 'sub_1', subscription_status: 'active' } })
        vi.mocked(stripe.subscriptions.retrieve).mockResolvedValue(monthly as never)

        await changePlan({ quantities: { credit_pack: 1, linkedin_slot: 0, whatsapp_slot: 0 }, interval: 'yearly' })
        expect(stripe.subscriptions.update).toHaveBeenCalledWith('sub_1', {
            items: [
                { id: 'si_base', price: 'price_base_yearly', quantity: 1 },
                { id: 'si_agent', deleted: true },
                { id: 'si_seat', deleted: true },
                { price: 'price_credit_pack_yearly', quantity: 1 },
            ],
            proration_behavior: 'always_invoice',
            payment_behavior: 'pending_if_incomplete', expand: ['latest_invoice.confirmation_secret'],
        })
    })

    // A phase discount read back carries every reference it has; written back it takes exactly one.
    it.each([
        { name: 'the discount already on the subscription', read: { discount: 'di_1', coupon: 'co_1', promotion_code: 'promo_1' }, written: { discount: 'di_1' } },
        { name: 'the promotion code when the discount has no id', read: { discount: null, coupon: { id: 'co_1' }, promotion_code: { id: 'promo_1' } }, written: { promotion_code: 'promo_1' } },
        { name: 'the coupon alone', read: { discount: null, coupon: 'co_1', promotion_code: null }, written: { coupon: 'co_1' } },
    ])('keeps the paid year on a switch to monthly, billing more credit today, dropping a legacy pack at the renewal and carrying $name', async ({ read, written }) => {
        useDb({ row: { stripe_subscription_id: 'sub_1', subscription_status: 'active' } })
        const yearly = sub({
            default_payment_method: 'pm_1',
            items: [
                { price: 'price_base_yearly', quantity: 1, id: 'si_base' },
                { price: 'price_agent_pack_yearly', quantity: 1, id: 'si_agent' },
                { price: 'price_credit_pack_yearly', quantity: 1, id: 'si_credit' },
            ],
        })
        vi.mocked(stripe.subscriptions.retrieve).mockResolvedValue(yearly as never)
        vi.mocked(stripe.subscriptionSchedules.create).mockResolvedValue({
            id: 'sub_sched_1',
            phases: [
                {
                    start_date: 1_000,
                    end_date: PERIOD_END,
                    discounts: [read],
                    items: [
                        { price: 'price_base_yearly', quantity: 1 },
                        { price: 'price_agent_pack_yearly', quantity: 1 },
                        { price: 'price_credit_pack_yearly', quantity: 2 },
                    ],
                },
            ],
        } as never)

        const toMonthly = { quantities: { credit_pack: 2, linkedin_slot: 0, whatsapp_slot: 0 }, interval: 'monthly' } as const
        await expect(changePlan(toMonthly)).resolves.toEqual({ trialEnded: false, switchAt: iso(PERIOD_END), paymentClientSecret: null })

        expect(vi.mocked(stripe.subscriptions.update).mock.calls).toEqual([
            ['sub_1', { items: [{ id: 'si_credit', quantity: 2 }], proration_behavior: 'always_invoice', metadata: { plan_change_after_payment: JSON.stringify(toMonthly) }, payment_behavior: 'pending_if_incomplete', expand: ['latest_invoice.confirmation_secret'] }],
            ['sub_1', { proration_behavior: 'none', metadata: { plan_change_after_payment: '' } }],
        ])
        expect(stripe.subscriptionSchedules.create).toHaveBeenCalledWith({ from_subscription: 'sub_1' })
        expect(stripe.subscriptionSchedules.update).toHaveBeenCalledWith('sub_sched_1', {
            end_behavior: 'release',
            phases: [
                {
                    items: [
                        { price: 'price_base_yearly', quantity: 1 },
                        { price: 'price_agent_pack_yearly', quantity: 1 },
                        { price: 'price_credit_pack_yearly', quantity: 2 },
                    ],
                    discounts: [written],
                    start_date: 1_000,
                    end_date: PERIOD_END,
                },
                { items: [{ price: 'price_base', quantity: 1 }, { price: 'price_credit_pack', quantity: 2 }], duration: { interval: 'month', interval_count: 1 }, proration_behavior: 'none' },
            ],
        })
    })

    it('releases a waiting switch before any other change', async () => {
        useDb({ row: { stripe_subscription_id: 'sub_1', subscription_status: 'active' } })
        const scheduled = sub({ schedule: 'sub_sched_1', default_payment_method: 'pm_1', items: [{ price: 'price_base_yearly', quantity: 1, id: 'si_base' }] })
        const released = { ...scheduled, schedule: null }
        vi.mocked(stripe.subscriptions.retrieve).mockResolvedValueOnce(scheduled as never).mockResolvedValue(released as never)

        await changePlan({ quantities: { credit_pack: 1, linkedin_slot: 0, whatsapp_slot: 0 }, interval: 'yearly' })
        expect(stripe.subscriptionSchedules.release).toHaveBeenCalledWith('sub_sched_1')
        expect(stripe.subscriptions.update).toHaveBeenCalledWith('sub_1', { items: [{ price: 'price_credit_pack_yearly', quantity: 1 }], proration_behavior: 'always_invoice', payment_behavior: 'pending_if_incomplete', expand: ['latest_invoice.confirmation_secret'] })
    })
})

describe('a plan change the bank holds', () => {
    const HELD = { pending_update: { expires_at: 1 }, latest_invoice: { id: 'in_pending', confirmation_secret: { client_secret: 'pi_1_secret_2', type: 'payment_intent' } } }
    const TO_MONTHLY = { quantities: { credit_pack: 2, linkedin_slot: 0, whatsapp_slot: 0 }, interval: 'monthly' } as const
    const yearly = () => sub({ default_payment_method: 'pm_1', items: [{ price: 'price_base_yearly', quantity: 1, id: 'si_base' }, { price: 'price_credit_pack_yearly', quantity: 1, id: 'si_credit' }] })

    beforeEach(() => {
        vi.mocked(stripe.customers.retrieve).mockResolvedValue({ invoice_settings: { default_payment_method: null } } as never)
        vi.mocked(stripe.subscriptionSchedules.create).mockResolvedValue({ id: 'sub_sched_1', phases: [{ start_date: 1_000, end_date: PERIOD_END, discounts: [], items: [{ price: 'price_base_yearly', quantity: 1 }, { price: 'price_credit_pack_yearly', quantity: 2 }] }] } as never)
    })

    it('answers the renewal date of a switch to monthly without scheduling it yet', async () => {
        useDb({ row: { stripe_subscription_id: 'sub_1', subscription_status: 'active' } })
        vi.mocked(stripe.subscriptions.retrieve).mockResolvedValue(yearly() as never)
        vi.mocked(stripe.subscriptions.update).mockResolvedValue(HELD as never)

        await expect(changePlan(TO_MONTHLY)).resolves.toEqual({ trialEnded: false, switchAt: iso(PERIOD_END), paymentClientSecret: 'pi_1_secret_2' })
        expect(stripe.subscriptions.update).toHaveBeenCalledExactlyOnceWith('sub_1', {
            items: [{ id: 'si_credit', quantity: 2 }],
            proration_behavior: 'always_invoice',
            metadata: { plan_change_after_payment: JSON.stringify(TO_MONTHLY) },
            payment_behavior: 'pending_if_incomplete',
            expand: ['latest_invoice.confirmation_secret'],
        })
        expect(stripe.subscriptionSchedules.create).not.toHaveBeenCalled()
    })

    describe('finishPendingPlanChange', () => {
        const held = (selection: object, fields: Record<string, unknown> & { items?: ItemSpec[] } = {}) => {
            const applied = sub({ ...fields, metadata: { workspace_id: '7', plan: 'base', plan_change_after_payment: JSON.stringify(selection) } })
            vi.mocked(stripe.subscriptions.retrieve).mockResolvedValue(applied as never)
            return applied
        }

        it('applies the decreases the paid increase was waiting on, then forgets the selection', async () => {
            const applied = held({ quantities: { credit_pack: 0, linkedin_slot: 1, whatsapp_slot: 0 }, interval: 'monthly' }, {
                items: [{ price: 'price_base', quantity: 1 }, { price: 'price_credit_pack', quantity: 1, id: 'si_credit' }, { price: 'price_linkedin_slot', quantity: 1, id: 'si_linkedin' }],
            })

            await finishPendingPlanChange(applied)
            expect(vi.mocked(stripe.subscriptions.update).mock.calls).toEqual([
                ['sub_1', { items: [{ id: 'si_credit', deleted: true }], proration_behavior: 'none' }],
                ['sub_1', { metadata: { plan_change_after_payment: '' } }],
            ])
            expect(stripe.subscriptionSchedules.create).not.toHaveBeenCalled()
        })

        it('schedules the switch to monthly the paid increase was waiting on', async () => {
            const applied = held(TO_MONTHLY, { items: [{ price: 'price_base_yearly', quantity: 1, id: 'si_base' }, { price: 'price_credit_pack_yearly', quantity: 2, id: 'si_credit' }] })

            await finishPendingPlanChange(applied)
            expect(stripe.subscriptionSchedules.create).toHaveBeenCalledWith({ from_subscription: 'sub_1' })
            expect(stripe.subscriptionSchedules.update).toHaveBeenCalledWith('sub_sched_1', expect.objectContaining({ end_behavior: 'release' }))
            expect(vi.mocked(stripe.subscriptions.update).mock.calls).toEqual([['sub_1', { metadata: { plan_change_after_payment: '' } }]])
        })

        it('schedules nothing twice when a first delivery already did', async () => {
            const applied = held(TO_MONTHLY, { schedule: 'sub_sched_1', items: [{ price: 'price_base_yearly', quantity: 1, id: 'si_base' }, { price: 'price_credit_pack_yearly', quantity: 2, id: 'si_credit' }] })

            await finishPendingPlanChange(applied)
            expect(stripe.subscriptionSchedules.create).not.toHaveBeenCalled()
            expect(vi.mocked(stripe.subscriptions.update).mock.calls).toEqual([['sub_1', { metadata: { plan_change_after_payment: '' } }]])
        })

        it('does nothing for a subscription that carries no selection', async () => {
            vi.mocked(stripe.subscriptions.retrieve).mockResolvedValue(sub() as never)
            await finishPendingPlanChange(sub())
            expect(stripe.subscriptions.update).not.toHaveBeenCalled()
        })

        it('ignores a selection it cannot read', async () => {
            vi.mocked(stripe.subscriptions.retrieve).mockResolvedValue(sub({ metadata: { plan_change_after_payment: '{"quantities":{"credit_pack":-1}}' } }) as never)
            await finishPendingPlanChange(sub())
            expect(stripe.subscriptions.update).not.toHaveBeenCalled()
        })

        it('never touches a template subscription', async () => {
            await finishPendingPlanChange(sub({ metadata: { kind: 'template_purchase' } }))
            expect(stripe.subscriptions.retrieve).not.toHaveBeenCalled()
        })
    })
})

describe('previewPlanChange', () => {
    it('quotes a switch to yearly as the whole invoice, with the unused month given back', async () => {
        useDb({ row: { stripe_subscription_id: 'sub_1', subscription_status: 'active' } })
        vi.mocked(stripe.subscriptions.retrieve).mockResolvedValue(sub({ items: [{ price: 'price_base', quantity: 1, id: 'si_base' }] }) as never)
        vi.mocked(stripe.invoices.createPreview).mockResolvedValue({
            amount_due: 39155,
            total_taxes: [],
            lines: { data: [{ amount: -7645, parent: { subscription_item_details: { proration: true } } }, { amount: 46800, parent: { subscription_item_details: { proration: false } } }] },
        } as never)

        await expect(previewPlanChange({ quantities: { credit_pack: 0, linkedin_slot: 0, whatsapp_slot: 0 }, interval: 'yearly' })).resolves.toEqual({
            kind: 'switch_now',
            dueTodayCents: 39155,
            taxCents: 0,
            taxIncluded: true,
            nextRenewalIso: iso(PERIOD_END),
            unusedCreditCents: 7645,
        })
    })

    it('quotes nothing for a switch to monthly at unchanged agents', async () => {
        useDb({ row: { stripe_subscription_id: 'sub_1', subscription_status: 'active' } })
        vi.mocked(stripe.subscriptions.retrieve).mockResolvedValue(sub({ items: [{ price: 'price_base_yearly', quantity: 1 }] }) as never)
        await expect(previewPlanChange({ quantities: { credit_pack: 0, linkedin_slot: 0, whatsapp_slot: 0 }, interval: 'monthly' })).resolves.toBeNull()
    })
})

describe('createPlanCardSetupSession', () => {
    it('opens the card form of a past-due plan, but sells no plan on it', async () => {
        useDb({ row: { stripe_subscription_id: 'sub_1', subscription_status: 'past_due' } })
        vi.mocked(stripe.subscriptions.retrieve).mockResolvedValue(sub({ status: 'past_due' }) as never)
        vi.mocked(stripe.checkout.sessions.create).mockResolvedValue({ id: 'cs_s', client_secret: 'secret_s' } as never)
        vi.mocked(stripe.customers.retrieve).mockResolvedValue({ email: 'a@b.co' } as never)

        await expect(createPlanCardSetupSession()).resolves.toEqual({ clientSecret: 'secret_s', sessionId: 'cs_s' })
        expect(vi.mocked(stripe.checkout.sessions.create).mock.calls[0][0]).toMatchObject({ mode: 'setup', ui_mode: 'elements', metadata: { kind: 'plan_card_setup', subscription_id: 'sub_1' } })
        expect(vi.mocked(stripe.checkout.sessions.create).mock.calls[0][0]!.payment_method_types).toEqual(['card', 'link'])
    })
})

describe('createPlanCardSetupSession for a phone account', () => {
    it('lends its placeholder to a customer without an email', async () => {
        useDb({ row: { stripe_subscription_id: 'sub_1', subscription_status: 'trialing' } })
        m.getServerSession.mockResolvedValue({ session: { email: '393480000000@phone.rerun.build' }, isAnonymous: false })
        vi.mocked(stripe.subscriptions.retrieve).mockResolvedValue(sub({ status: 'trialing' }) as never)
        vi.mocked(stripe.checkout.sessions.create).mockResolvedValue({ id: 'cs_s', client_secret: 'secret_s' } as never)
        vi.mocked(stripe.customers.retrieve).mockResolvedValue({ email: null } as never)

        await createPlanCardSetupSession()
        expect(stripe.customers.update).toHaveBeenCalledWith('cus_1', { email: '393480000000@phone.rerun.build' })
    })
})

describe('syncStripeCustomerEmail', () => {
    function useCustomer(email: string | null) {
        const fake = fakeSupabase(table => {
            if (table === 'workspace_members') return { data: [{ workspace_id: WORKSPACE_ID }] }
            if (table === 'workspaces') return { data: [{ stripe_customer_id: 'cus_1' }] }
            return undefined
        })
        m.createServiceRoleClient.mockReturnValue(fake.client)
        vi.mocked(stripe.customers.retrieve).mockResolvedValue({ email } as never)
    }

    it('replaces the placeholder of a phone account with the address it confirms', async () => {
        useCustomer('393480000000@phone.rerun.build')
        await syncStripeCustomerEmail('user-1', 'ada@rerun.build')
        expect(stripe.customers.update).toHaveBeenCalledWith('cus_1', { email: 'ada@rerun.build' })
    })

    it('leaves a real address alone', async () => {
        useCustomer('teammate@rerun.build')
        await syncStripeCustomerEmail('user-1', 'ada@rerun.build')
        expect(stripe.customers.update).not.toHaveBeenCalled()
    })
})

describe('completeCardSetupSession', () => {
    it('pays the invoice a failed payment left open with the new card', async () => {
        useDb({ row: { stripe_subscription_id: 'sub_1', subscription_status: 'past_due' } })
        vi.mocked(stripe.subscriptions.retrieve).mockResolvedValue(sub({ status: 'past_due', default_payment_method: 'pm_new' }) as never)
        vi.mocked(stripe.invoices.list).mockResolvedValue({ data: [{ id: 'in_open' }] } as never)

        await completeCardSetupSession({ metadata: { subscription_id: 'sub_1' } } as never)
        expect(stripe.invoices.pay).toHaveBeenCalledWith('in_open', { payment_method: 'pm_new' })
    })

    it('leaves a trial to the dialog, which runs the plan change once the card is saved', async () => {
        useDb({ row: { stripe_subscription_id: 'sub_1', subscription_status: 'trialing' } })
        vi.mocked(stripe.subscriptions.retrieve).mockResolvedValue(sub({ status: 'trialing', default_payment_method: 'pm_new' }) as never)

        await completeCardSetupSession({ metadata: { subscription_id: 'sub_1' } } as never)
        expect(stripe.invoices.pay).not.toHaveBeenCalled()
        expect(vi.mocked(stripe.subscriptions.update).mock.calls.map(([, params]) => Object.keys(params ?? {}))).not.toContainEqual(expect.arrayContaining(['items']))
    })
})

describe('cancelSubscription with a waiting switch', () => {
    it('releases the schedule before setting the cancellation', async () => {
        useDb({ row: { stripe_subscription_id: 'sub_1', subscription_status: 'active' } })
        const scheduled = sub({ schedule: 'sub_sched_1', items: [{ price: 'price_base_yearly', quantity: 1 }] })
        vi.mocked(stripe.subscriptions.retrieve).mockResolvedValueOnce(scheduled as never).mockResolvedValue({ ...scheduled, schedule: null } as never)
        vi.mocked(stripe.customers.retrieve).mockResolvedValue({ invoice_settings: { default_payment_method: 'pm_1' } } as never)

        await cancelSubscription({ reason: 'too_expensive', comeback: 'maybe', comment: 'Too much for one coworker', check: 'genuine' })
        expect(stripe.subscriptionSchedules.release).toHaveBeenCalledWith('sub_sched_1')
        expect(stripe.subscriptions.update).toHaveBeenCalledWith('sub_1', expect.objectContaining({ cancel_at_period_end: true }))
    })
})

describe('listInvoices', () => {
    it('lists the finalized invoices of the customer', async () => {
        useDb({ row: { stripe_customer_id: 'cus_1' } })
        vi.mocked(stripe.invoices.list).mockResolvedValue({
            data: [
                { id: 'in_1', created: PERIOD_END, total: 4900, status: 'paid', invoice_pdf: 'https://pdf', hosted_invoice_url: 'https://inv' },
                { id: 'in_2', created: PERIOD_END, total: 0, status: 'draft' },
            ],
        } as never)
        await expect(listInvoices()).resolves.toEqual([{ id: 'in_1', createdAt: iso(PERIOD_END), amountCents: 4900, status: 'paid', pdfUrl: 'https://pdf', hostedUrl: 'https://inv' }])
    })
})

describe('business details', () => {
    const OLD = { id: 'txi_old', type: 'eu_vat', value: 'FR00000000000', verification: { status: 'verified' } }

    function useCustomer(customer: Record<string, unknown>) {
        useDb({ row: { id: WORKSPACE_ID, stripe_customer_id: 'cus_1' } })
        vi.mocked(stripe.customers.retrieve).mockResolvedValue({ id: 'cus_1', name: 'Acme', address: { country: 'FR' }, tax_ids: { data: [] }, ...customer } as never)
    }

    beforeEach(() => {
        vi.resetAllMocks()
        m.requireWorkspaceId.mockResolvedValue(WORKSPACE_ID)
    })

    it('creates the new number before removing the old one, and names the customer', async () => {
        useCustomer({ tax_ids: { data: [OLD] } })
        vi.mocked(stripe.customers.createTaxId).mockResolvedValue({ id: 'txi_new', type: 'eu_vat', value: 'FR12345678901', verification: { status: 'pending' } } as never)

        await expect(saveBusinessDetails({ name: ' Acme SAS ', type: 'eu_vat', value: '12 345 678 901' })).resolves.toEqual({
            name: 'Acme SAS',
            country: 'FR',
            taxId: { type: 'eu_vat', value: 'FR12345678901', status: 'pending' },
        })
        expect(stripe.customers.retrieve).toHaveBeenCalledWith('cus_1', { expand: ['tax_ids'] })
        expect(stripe.customers.createTaxId).toHaveBeenCalledWith('cus_1', { type: 'eu_vat', value: 'FR12345678901' })
        expect(stripe.customers.deleteTaxId).toHaveBeenCalledWith('cus_1', 'txi_old')
        expect(vi.mocked(stripe.customers.createTaxId).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(stripe.customers.deleteTaxId).mock.invocationCallOrder[0])
        expect(stripe.customers.update).toHaveBeenCalledWith('cus_1', { name: 'Acme SAS' })
    })

    it('keeps the number already on file and only renames', async () => {
        useCustomer({ tax_ids: { data: [OLD] } })

        const saved = await saveBusinessDetails({ name: 'Acme', type: 'eu_vat', value: 'FR00000000000' })
        expect(saved.taxId).toEqual({ type: 'eu_vat', value: 'FR00000000000', status: 'verified' })
        expect(stripe.customers.createTaxId).not.toHaveBeenCalled()
        expect(stripe.customers.deleteTaxId).not.toHaveBeenCalled()
        expect(stripe.customers.update).not.toHaveBeenCalled()
    })

    it('words the refusal of an invalid number and leaves the old one in place', async () => {
        useCustomer({ tax_ids: { data: [OLD] } })
        vi.mocked(stripe.customers.createTaxId).mockRejectedValue(Object.assign(new Error('Invalid value for eu_vat.'), { code: 'tax_id_invalid' }))

        await expect(saveBusinessDetails({ name: 'Acme', type: 'eu_vat', value: 'FR1' })).rejects.toThrow('This number is not valid for France.')
        expect(stripe.customers.deleteTaxId).not.toHaveBeenCalled()
    })

    it('refuses a kind of number that does not belong to the billing country', async () => {
        useCustomer({})
        await expect(saveBusinessDetails({ name: 'Acme', type: 'gb_vat', value: 'GB123456789' })).rejects.toThrow('This kind of number does not match your billing country, France.')
        expect(stripe.customers.createTaxId).not.toHaveBeenCalled()
    })

    it('asks for a card first when the customer has no billing address', async () => {
        useCustomer({ address: null })
        await expect(saveBusinessDetails({ name: 'Acme', type: 'eu_vat', value: 'FR12345678901' })).rejects.toThrow('Add a card first')
        expect(stripe.customers.createTaxId).not.toHaveBeenCalled()
    })

    it('refuses a workspace that has no Stripe customer, without creating one', async () => {
        useDb({ row: { id: WORKSPACE_ID, stripe_customer_id: null } })
        await expect(saveBusinessDetails({ name: 'Acme', type: 'eu_vat', value: 'FR12345678901' })).rejects.toThrow('Your workspace has no billing account yet.')
        expect(stripe.customers.create).not.toHaveBeenCalled()
    })

    it('removes every number on file', async () => {
        useCustomer({ tax_ids: { data: [OLD, { ...OLD, id: 'txi_2' }] } })
        await removeTaxId()
        expect(stripe.customers.deleteTaxId).toHaveBeenCalledWith('cus_1', 'txi_old')
        expect(stripe.customers.deleteTaxId).toHaveBeenCalledWith('cus_1', 'txi_2')
    })
})
