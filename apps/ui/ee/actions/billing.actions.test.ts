import { beforeEach, describe, expect, it, vi } from 'vitest'

import { requireAdminContext, requireWorkspaceId } from '@/app/api/_auth/ownership'
import * as billing from '@/ee/services/billing.service'
import { markPaymentMethodAdded } from '@/app/api/_services/getting-started.service'
import { stripe } from '@/ee/lib/billing/stripe'
import {
    acceptPlanTermsAction,
    changePlanAction,
    confirmCardSetupAction,
    createPlanCardSetupAction,
    createPlanCheckoutAction,
    getSubscriptionStateAction,
    listInvoicesAction,
    previewPlanChangeAction,
    readCheckoutOutcomeAction,
    removeTaxIdAction,
    saveBusinessDetailsAction,
    updatePlanCheckoutAction,
} from './billing.actions'

vi.mock('@/ee/lib/billing/stripe', async importOriginal => ({ ...(await importOriginal<typeof import('@/ee/lib/billing/stripe')>()), stripe: (await import('@/ee/test/stripe-fake')).fakeStripe() }))
vi.mock('@/app/api/_auth/ownership', () => ({ requireAdminContext: vi.fn(), requireWorkspaceId: vi.fn() }))
vi.mock('@/app/api/_services/getting-started.service', () => ({ markPaymentMethodAdded: vi.fn() }))
vi.mock('@/ee/services/billing.service', () => ({
    CHARGE_REFUSED_MESSAGE: "We couldn't charge your card. Nothing was charged, try again or change your card.",
    PLAN_CARD_SETUP_KIND: 'plan_card_setup',
    acceptPlanTerms: vi.fn(),
    changePlan: vi.fn(),
    completeCardSetupSession: vi.fn(),
    createPlanCardSetupSession: vi.fn(),
    createPlanCheckoutSession: vi.fn(),
    getSubscriptionState: vi.fn(),
    listInvoices: vi.fn(),
    previewPlanChange: vi.fn(),
    readCheckoutOutcome: vi.fn(),
    removeTaxId: vi.fn(),
    saveBusinessDetails: vi.fn(),
    updatePlanCheckoutSession: vi.fn(),
}))

const BUSINESS = { name: 'Acme SAS', type: 'eu_vat', value: 'FR12345678901' } as const

const SELECTION = { quantities: { credit_pack: 1, linkedin_slot: 0, whatsapp_slot: 0 }, interval: 'yearly' } as const

beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(requireWorkspaceId).mockResolvedValue(42)
    vi.mocked(requireAdminContext).mockResolvedValue({ workspace: { id: 42 }, role: 'admin' } as never)
})

describe('a member who is not an admin', () => {
    const writes: [string, () => Promise<unknown>][] = [
        ['createPlanCheckoutAction', () => createPlanCheckoutAction(SELECTION)],
        ['updatePlanCheckoutAction', () => updatePlanCheckoutAction('cs_1', SELECTION)],
        ['acceptPlanTermsAction', () => acceptPlanTermsAction('cs_1')],
        ['createPlanCardSetupAction', () => createPlanCardSetupAction()],
        ['changePlanAction', () => changePlanAction(SELECTION)],
        ['confirmCardSetupAction', () => confirmCardSetupAction('cs_1')],
        ['saveBusinessDetailsAction', () => saveBusinessDetailsAction(BUSINESS)],
        ['removeTaxIdAction', () => removeTaxIdAction()],
    ]

    it.each(writes)('is refused %s before anything reaches Stripe', async (_name, action) => {
        vi.mocked(requireAdminContext).mockRejectedValue(new Error('Only an admin can manage billing'))

        await expect(action()).resolves.toEqual({ ok: false, error: 'Only an admin can manage billing' })
        expect(stripe.checkout.sessions.retrieve).not.toHaveBeenCalled()
        for (const fn of Object.values(billing)) if (vi.isMockFunction(fn)) expect(fn).not.toHaveBeenCalled()
    })

    it('still reads the subscription and the invoices', async () => {
        vi.mocked(requireAdminContext).mockRejectedValue(new Error('Only an admin can manage billing'))
        vi.mocked(billing.getSubscriptionState).mockResolvedValue(null)
        vi.mocked(billing.listInvoices).mockResolvedValue([])

        await expect(getSubscriptionStateAction()).resolves.toEqual({ ok: true, state: null })
        await expect(listInvoicesAction()).resolves.toEqual({ ok: true, invoices: [] })
    })
})

describe('confirmCardSetupAction', () => {
    function retrieved(session: Record<string, unknown>) {
        vi.mocked(stripe.checkout.sessions.retrieve).mockResolvedValue(session as never)
    }

    it('refuses a session that is not a card setup', async () => {
        retrieved({ status: 'complete', metadata: { kind: 'template_purchase', workspace_id: '42' } })
        await expect(confirmCardSetupAction('cs_1')).resolves.toEqual({ ok: false, error: 'Not a card setup session.' })
        expect(billing.completeCardSetupSession).not.toHaveBeenCalled()
    })

    it('refuses a session from another workspace', async () => {
        retrieved({ status: 'complete', metadata: { kind: 'plan_card_setup', workspace_id: '7' } })
        await expect(confirmCardSetupAction('cs_1')).resolves.toEqual({ ok: false, error: 'This session belongs to another workspace.' })
        expect(billing.completeCardSetupSession).not.toHaveBeenCalled()
    })

    it('refuses a card form that was not completed', async () => {
        retrieved({ status: 'open', metadata: { kind: 'plan_card_setup', workspace_id: '42' } })
        await expect(confirmCardSetupAction('cs_1')).resolves.toEqual({ ok: false, error: 'The card form was not completed.' })
        expect(billing.completeCardSetupSession).not.toHaveBeenCalled()
    })

    it('refuses an empty session id before reaching Stripe', async () => {
        await expect(confirmCardSetupAction('  ')).resolves.toMatchObject({ ok: false })
        expect(stripe.checkout.sessions.retrieve).not.toHaveBeenCalled()
    })

    it('attaches the card and ticks the checklist step', async () => {
        const session = { status: 'complete', metadata: { kind: 'plan_card_setup', workspace_id: '42' } }
        retrieved(session)

        await expect(confirmCardSetupAction(' cs_1 ')).resolves.toEqual({ ok: true })

        expect(stripe.checkout.sessions.retrieve).toHaveBeenCalledWith('cs_1')
        expect(billing.completeCardSetupSession).toHaveBeenCalledWith(session)
        expect(markPaymentMethodAdded).toHaveBeenCalledWith(42)
    })
})

describe('the thin billing actions', () => {
    const cases: [string, () => Promise<unknown>, () => void, unknown][] = [
        ['createPlanCheckoutAction', () => createPlanCheckoutAction(SELECTION), () => vi.mocked(billing.createPlanCheckoutSession).mockResolvedValue({ clientSecret: 'sec', sessionId: 'cs_1', trial: false }), { ok: true, clientSecret: 'sec', sessionId: 'cs_1', trial: false }],
        ['updatePlanCheckoutAction', () => updatePlanCheckoutAction('cs_1', SELECTION), () => vi.mocked(billing.updatePlanCheckoutSession).mockResolvedValue(undefined), { ok: true }],
        ['acceptPlanTermsAction', () => acceptPlanTermsAction('cs_1'), () => vi.mocked(billing.acceptPlanTerms).mockResolvedValue(undefined), { ok: true }],
        ['createPlanCardSetupAction', () => createPlanCardSetupAction(), () => vi.mocked(billing.createPlanCardSetupSession).mockResolvedValue({ clientSecret: 'sec', sessionId: 'cs_1' }), { ok: true, clientSecret: 'sec', sessionId: 'cs_1' }],
        ['previewPlanChangeAction', () => previewPlanChangeAction(SELECTION), () => vi.mocked(billing.previewPlanChange).mockResolvedValue(null), { ok: true, quote: null }],
        ['changePlanAction', () => changePlanAction(SELECTION), () => vi.mocked(billing.changePlan).mockResolvedValue({ trialEnded: false, switchAt: null, paymentClientSecret: null }), { ok: true, trialEnded: false, switchAt: null, paymentClientSecret: null }],
        ['listInvoicesAction', () => listInvoicesAction(), () => vi.mocked(billing.listInvoices).mockResolvedValue([]), { ok: true, invoices: [] }],
        ['getSubscriptionStateAction', () => getSubscriptionStateAction(), () => vi.mocked(billing.getSubscriptionState).mockResolvedValue(null), { ok: true, state: null }],
        [
            'saveBusinessDetailsAction',
            () => saveBusinessDetailsAction(BUSINESS),
            () => vi.mocked(billing.saveBusinessDetails).mockResolvedValue({ name: 'Acme SAS', country: 'FR', taxId: { type: 'eu_vat', value: 'FR12345678901', status: 'pending' } }),
            { ok: true, business: { name: 'Acme SAS', country: 'FR', taxId: { type: 'eu_vat', value: 'FR12345678901', status: 'pending' } } },
        ],
        ['removeTaxIdAction', () => removeTaxIdAction(), () => vi.mocked(billing.removeTaxId).mockResolvedValue(undefined), { ok: true }],
    ]

    it.each(cases)('%s wraps what the service answers', async (_name, action, arrange, expected) => {
        arrange()
        await expect(action()).resolves.toEqual(expected)
    })

    it.each(cases)('%s turns a service failure into its error message', async (_name, action) => {
        const failure = new Error('service exploded')
        for (const fn of Object.values(billing)) if (vi.isMockFunction(fn)) fn.mockRejectedValue(failure)

        await expect(action()).resolves.toEqual({ ok: false, error: 'service exploded' })
    })

    it('refuses business details without a name or a number before reaching the service', async () => {
        await expect(saveBusinessDetailsAction({ ...BUSINESS, name: '  ' })).resolves.toEqual({ ok: false, error: 'Enter the business name' })
        await expect(saveBusinessDetailsAction({ ...BUSINESS, value: '' })).resolves.toEqual({ ok: false, error: 'Enter the number' })
        expect(billing.saveBusinessDetails).not.toHaveBeenCalled()
    })

    it('falls back to a generic message when something that is not an Error is thrown', async () => {
        vi.mocked(billing.changePlan).mockRejectedValue('nope')
        await expect(changePlanAction(SELECTION)).resolves.toEqual({ ok: false, error: 'Failed to change your plan' })
    })

    it('passes on the decline the service already worded for the customer', async () => {
        vi.mocked(billing.changePlan).mockRejectedValue(new Error('Your card was declined.'))
        await expect(changePlanAction(SELECTION)).resolves.toEqual({ ok: false, error: 'Your card was declined.' })
    })

    it("keeps a card error Stripe itself throws in the card's own words", async () => {
        vi.mocked(billing.changePlan).mockRejectedValue(Object.assign(new Error('Your card has expired.'), { type: 'StripeCardError', code: 'expired_card' }))
        await expect(changePlanAction(SELECTION)).resolves.toEqual({ ok: false, error: 'Your card has expired.' })
    })

    it("never shows the customer Stripe's developer wording", async () => {
        const requiresAction = Object.assign(new Error('Payment for this subscription requires additional user action, but the requested payment behavior…'), {
            type: 'StripeCardError',
            code: 'subscription_payment_intent_requires_action',
        })
        vi.mocked(billing.changePlan).mockRejectedValue(requiresAction)
        await expect(changePlanAction(SELECTION)).resolves.toEqual({ ok: false, error: "We couldn't charge your card. Nothing was charged, try again or change your card." })
    })

    it('refuses a selection the schema does not know before reaching the service', async () => {
        await expect(changePlanAction({ quantities: { credit_pack: -1, linkedin_slot: 0, whatsapp_slot: 0 }, interval: 'monthly' })).resolves.toMatchObject({ ok: false })
        await expect(createPlanCheckoutAction({ quantities: { credit_pack: 0, linkedin_slot: 0, whatsapp_slot: 0 }, interval: 'weekly' as never })).resolves.toMatchObject({ ok: false })
        expect(billing.changePlan).not.toHaveBeenCalled()
        expect(billing.createPlanCheckoutSession).not.toHaveBeenCalled()
    })

    it('drops the agent pack a page loaded before the deploy still sends, rather than refusing the change', async () => {
        vi.mocked(billing.changePlan).mockResolvedValue({ trialEnded: true, switchAt: null, paymentClientSecret: null })
        const stale = { quantities: { agent_pack: 3, credit_pack: 0, linkedin_slot: 0, whatsapp_slot: 0 }, interval: 'monthly' } as never
        await expect(changePlanAction(stale)).resolves.toMatchObject({ ok: true })
        expect(billing.changePlan).toHaveBeenCalledWith({ quantities: { credit_pack: 0, linkedin_slot: 0, whatsapp_slot: 0 }, interval: 'monthly' })
    })
})
