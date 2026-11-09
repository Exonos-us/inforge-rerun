import { realEmail } from '@/lib/auth/placeholder-email'
import { requireWorkspaceId } from '@/app/api/_auth/ownership'
import { Database } from '@/app/api/database.types'
import { getAppOrigin } from '@/lib/app-origin'
import {
    ADDON_KEYS,
    BASE_PLAN_SLUG,
    BILLING_INTERVALS,
    PLAN_CURRENCY,
    ZERO_QUANTITIES,
    basePriceCents,
    parsePriceArm,
    planPriceCents,
    quantitiesToColumns,
    type AddonQuantities,
    type BillingInterval,
    type PriceArm,
    type WorkspaceLimitColumns,
} from '@/ee/lib/billing/plans'
import { affiliateReferralMetadata } from '@/ee/lib/billing/affiliate'
import {
    CANCEL_COMEBACK_METADATA_KEY,
    CANCEL_REASON_CHECK_METADATA_KEY,
    RETENTION_CLAIMED_METADATA_KEY,
    addOneMonth,
    cancelFlowPhase,
    offerPriceCents,
    paidLeftCents,
    reminderDate,
    retentionCouponId,
    retentionCouponParams,
    retentionOfferFor,
    retentionOfferOfCoupon,
    type CancelComeback,
    type CancelPhase,
    type CancelReason,
    type CancelReasonCheck,
    type RetentionOfferKind,
} from '@/ee/lib/billing/cancel-flow'
import { ARCHIVE_RETENTION_DAYS } from '@/lib/archive/retention'
import { canEndTrialNow, isMachineEntitled, isSubscriptionEntitled } from '@/ee/lib/billing/entitlement'
import { BOX_DELETION_GRACE_MS } from '@/ee/lib/billing/grace'
import { isTemplateSubscription, stripeTimestampIso, subscriptionPeriodEndIso } from '@/ee/lib/billing/marketplace'
import { isSameSubscription, shouldAdoptSubscription } from '@/ee/lib/billing/ownership'
import { hasPeriodAdvanced, rerunPeriodUpdate } from '@/ee/lib/billing/period'
import { trialArm } from '@/ee/lib/billing/trial-experiment'
import { normalizeTaxIdValue, taxIdTypesFor, type TaxIdStatus, type TaxIdType } from '@/ee/lib/billing/tax-id'
import {
    addonForPriceId,
    basePriceId,
    intervalOfItems,
    isBasePriceId,
    isLegacyPlanItemPriceId,
    isYearlyBasePriceId,
    legacyBaseDiscountCents,
    priceArmOfItems,
    priceIdForAddon,
    quantitiesFromItems,
    stripe,
    subscriptionOfInvoice,
} from '@/ee/lib/billing/stripe'
import { TRIAL_ACTIVE_AGENTS, TRIAL_DAYS, type ForemanClient } from '@rerun/contracts'
import { createServiceRoleClient } from '@/supabase/serviceRole'
import { getServerSession, getSessionWorkspace } from '@/supabase/session/getServerSession'
import { reconcileAgentActivation, wakePlanLimitedAgents } from '@/app/api/_services/agent-activation.service'
import { SLOT_PAUSE_REASONS, subscriberTrialOpen, syncWorkspaceAppSlots } from '@/lib/apps/slots-sync'
import { APP_ADDON_KEYS, APP_SLUGS, SLOT_HOLDING_STATUSES } from '@/lib/apps/types'
import { APP_INFO } from '@/lib/apps/catalog'
import { isPhoneStepPending } from '@/app/api/_services/phone-gate.service'
import { PHONE_REQUIRED_MESSAGE } from '@/lib/phone/verification'
import { requestAgentActivationSync } from '@/trigger/sync-agent-activation'
import { selectMany, selectMaybeSingle, selectSingle } from '@/supabase/supabase-helpers'
import { sendPaymentFailedNotice } from '@/ee/lib/lifecycle/payment-failed-notice'
import { sendTrialStartedReceipt } from '@/ee/lib/lifecycle/trial-receipt'
import { reportSubscriptionCancelled, reportSubscriptionTransition, reportTrialConverted, reportTrialPaymentFailed } from './billing-analytics.service'
import { requestBoxRestore } from '@rerun/cloud/engines'
import { resolveEngineWaitlist } from '@/app/api/_services/waitlist.service'
import { syncEnginePlan } from '@/app/api/_services/workspace-engine.service'
import type Stripe from 'stripe'

type WorkspaceUpdate = Database['public']['Tables']['workspaces']['Update']

// Discriminates our setup-mode Checkout sessions in the `checkout.session.completed` webhook, which
// otherwise only knows subscription-mode sessions: the card a trial started without is collected
// there.
export const PLAN_CARD_SETUP_KIND = 'plan_card_setup'

const PLAN_PAYMENT_METHOD_TYPES: Stripe.Checkout.SessionCreateParams.PaymentMethodType[] = ['card', 'link']

// The waitlist wall only lives in the browser, and a template or share sheet opened over it used to
// start a trial on a workspace with no machine to give it. Every way onto the plan checks here.
export const ENGINE_WAITLIST_MESSAGE = 'Every machine is taken right now. Your trial can start as soon as one frees up.'

// Resolve (and lazily create) the Stripe customer for the caller's workspace.
// The customer id is persisted on the workspace so subsequent checkouts and the
// portal reuse it, and the webhook can map events back to the workspace.
// Exported for the marketplace checkout: a template is bought by the workspace, on the same
// customer, so creating a second one would split its billing history in two.
export async function ensureStripeCustomer(): Promise<{ workspaceId: number; customerId: string }> {
    const workspaceId = await requireWorkspaceId()
    const { session } = await getServerSession()
    const supabase = createServiceRoleClient()

    const { data: workspace } = await selectSingle(supabase, 'workspaces', ['id', 'name', 'stripe_customer_id'] as const, { id: workspaceId })
    if (workspace?.stripe_customer_id) return { workspaceId, customerId: workspace.stripe_customer_id }

    const customer = await stripe.customers.create({
        email: realEmail(session?.email) ?? undefined,
        name: workspace?.name ?? undefined,
        metadata: { workspace_id: String(workspaceId) },
    })

    const { error } = await supabase.from('workspaces').update<WorkspaceUpdate>({ stripe_customer_id: customer.id }).eq('id', workspaceId)
    if (error) throw new Error(`Failed to persist Stripe customer: ${error.message}`)

    return { workspaceId, customerId: customer.id }
}

// A customer created by an account that had no address yet, one born from a phone number, gets the
// address that account confirms later, so its invoices have somewhere to go. A customer that
// already carries one is left alone: it may be a teammate's.
export async function syncStripeCustomerEmail(userId: string, email: string): Promise<void> {
    const supabase = createServiceRoleClient()
    const { data: memberships } = await selectMany(supabase, 'workspace_members', ['workspace_id'] as const, { user_id: userId })
    const workspaceIds = (memberships ?? []).map(membership => membership.workspace_id)
    if (!workspaceIds.length) return

    const { data: workspaces } = await selectMany(supabase, 'workspaces', ['stripe_customer_id'] as const, { id: workspaceIds })
    for (const { stripe_customer_id: customerId } of workspaces ?? []) {
        if (!customerId) continue
        const customer = await stripe.customers.retrieve(customerId)
        if (customer.deleted || realEmail(customer.email)) continue
        await stripe.customers.update(customerId, { email })
    }
}

// A Checkout session rendered by the app (`ui_mode: 'elements'`) cannot be confirmed for a customer
// without an email, and the dialog has no field for one. An account born from a phone number lends
// its placeholder, which syncStripeCustomerEmail replaces once the account confirms a real address.
async function ensureCustomerEmail(customerId: string): Promise<void> {
    const { session } = await getServerSession()
    if (!session?.email) return
    const customer = await stripe.customers.retrieve(customerId)
    if (customer.deleted || customer.email) return
    await stripe.customers.update(customerId, { email: session.email })
}

// Everything the plan Checkout session carries but its line items: the free trial when the workspace
// has never had one, billed today otherwise, and the card collected either way. The limits are only
// applied to the workspace once the session completes, via the webhook.
//
// The line items are the caller's, priced on the arm of the price test returned beside the params.
async function basePlanCheckoutParams(): Promise<{ params: Omit<Stripe.Checkout.SessionCreateParams, 'line_items'>; priceArm: PriceArm }> {
    // Before the customer: a refused account leaves no orphan behind in Stripe.
    const { session } = await getServerSession()
    if (session && (await isPhoneStepPending(createServiceRoleClient(), session.id))) throw new Error(PHONE_REQUIRED_MESSAGE)

    const { workspaceId, customerId } = await ensureStripeCustomer()
    if (await resolveEngineWaitlist(workspaceId)) throw new Error(ENGINE_WAITLIST_MESSAGE)

    await refuseSecondPlanSubscription(workspaceId, customerId)
    await ensureCustomerEmail(customerId)

    // One trial per workspace, marked by `trial_ends_at`: the column is never cleared by the Stripe
    // sync (applySubscriptionToWorkspace), so non-null means the trial is spent, whatever came after.
    //
    // A workspace already entitled without Stripe behind it (a retired invitation code, a sandbox) is
    // the other way in here, and it must be billed from day one: a redeemed code left `trial_ends_at`
    // null, so without this check it would be handed a trial on top of the plan it already has.
    const supabase = createServiceRoleClient()
    const { data: workspace } = await selectSingle(supabase, 'workspaces', ['trial_ends_at', 'subscription_status', 'price_arm'] as const, { id: workspaceId })
    const trialEligible = !workspace?.trial_ends_at && !isSubscriptionEntitled(workspace?.subscription_status)

    const referral = await affiliateReferralMetadata()
    const params: Omit<Stripe.Checkout.SessionCreateParams, 'line_items'> = {
        mode: 'subscription',
        customer: customerId,
        // On the session because that is where Affonso looks, and on the subscription because that
        // is what bills every month after this one. The workspace id rides along so a session can be
        // read back and matched to its buyer without trusting the caller.
        metadata: { ...referral, workspace_id: String(workspaceId) },
        // Passed explicitly, and it has to be: left out, Stripe picks the currency from the
        // buyer's IP, and the live prices still carry the euro `currency_options` from when Rerun
        // sold in two currencies, so a European buyer would be charged in euros.
        currency: PLAN_CURRENCY,
        subscription_data: {
            metadata: { workspace_id: String(workspaceId), plan: BASE_PLAN_SLUG, ...referral },
            ...(trialEligible ? { trial_period_days: TRIAL_DAYS } : {}),
        },
        // Stripe's default in subscription mode, spelled out because it is the whole point: a trial
        // only starts once a card is on file, so there is nothing to cancel for lack of one.
        payment_method_collection: 'always',
        // Listed rather than left to the Dashboard: a method Stripe adds there (Amazon Pay) shows up in
        // the form untested, and Amazon Pay fails every trial setup. Apple and Google Pay ride on `card`.
        payment_method_types: PLAN_PAYMENT_METHOD_TYPES,
        // Plan prices are tax-exclusive: the advertised figure is the pre-tax base and Stripe adds
        // the buyer's local tax on top. Paired with `tax_id_collection`, a business buyer with a
        // valid intra-community VAT number reverse-charges it back to zero.
        automatic_tax: { enabled: true },
        tax_id_collection: { enabled: true },
        // Required as soon as an existing customer is passed, otherwise Stripe refuses to calculate.
        customer_update: { address: 'auto', name: 'auto' },
        allow_promotion_codes: true,
    }
    return { params, priceArm: parsePriceArm(workspace?.price_arm) }
}

// The trial the cardless arm of the trial test starts, without a card and without leaving the app:
// the subscription is created server-side and applied to the workspace on the spot, so the foreman
// can build on the turn that follows the user confirming it. Stripe stays the source of truth: the
// `customer.subscription.created` webhook repeats the same idempotent sync, and without a card by the
// end of the trial Stripe cancels the subscription (`missing_payment_method`), which the deletion
// handler turns into agents switched off and the workspace paused.
//
// Returns whether the workspace is entitled once this is done. Anything that disqualifies it (an
// anonymous session, a sandbox, a trial already spent, the card arm) answers false rather than
// throwing: the caller falls back on the card checkout, which knows how to bill a spent trial.
// The app sells nothing and has no card checkout to fall back on, so a trial it starts skips the arm.
export async function startCardlessTrial(client: ForemanClient = 'web'): Promise<boolean> {
    const { session, isAnonymous } = await getServerSession()
    if (!session || isAnonymous) return false

    const workspaceId = await requireWorkspaceId()
    const supabase = createServiceRoleClient()
    const { data: workspace } = await selectSingle(supabase, 'workspaces', ['trial_ends_at', 'subscription_status', 'is_sandbox', 'price_arm'] as const, { id: workspaceId })
    if (!workspace || workspace.is_sandbox) return false
    if (isSubscriptionEntitled(workspace.subscription_status)) return true
    if (workspace.trial_ends_at) return false
    if (client === 'web' && trialArm(workspaceId) === 'card') return false
    if (await isPhoneStepPending(supabase, session.id)) throw new Error(PHONE_REQUIRED_MESSAGE)
    if (await resolveEngineWaitlist(workspaceId)) throw new Error(ENGINE_WAITLIST_MESSAGE)

    const { customerId } = await ensureStripeCustomer()
    await refuseSecondPlanSubscription(workspaceId, customerId)

    const referral = await affiliateReferralMetadata()
    const subscription = await stripe.subscriptions.create(
        {
            customer: customerId,
            items: [{ price: basePriceId('monthly', parsePriceArm(workspace.price_arm)), quantity: 1 }],
            // Same trap as the checkout: left out, Stripe mints the subscription in whatever
            // `currency_options` the live price still carries.
            currency: PLAN_CURRENCY,
            trial_period_days: TRIAL_DAYS,
            trial_settings: { end_behavior: { missing_payment_method: 'cancel' } },
            metadata: { workspace_id: String(workspaceId), plan: BASE_PLAN_SLUG, origin: client, ...referral },
            // No address yet, so there is nothing to calculate: tax is switched back on when the card
            // is collected (applyCardSetupSession).
            automatic_tax: { enabled: false },
            payment_settings: { save_default_payment_method: 'on_subscription' },
        },
        // A second tab or a retried request resolves to the same subscription instead of two.
        { idempotencyKey: `cardless-trial-ws-${workspaceId}` }
    )

    await applySubscriptionToWorkspace(subscription)
    return isSubscriptionEntitled(subscription.status)
}

// --- The plan dialogs: a selection of agents and an interval, the card form in the app's own UI ---

export type PlanSelection = { quantities: AddonQuantities; interval: BillingInterval }

// The card trial sells one plan, with nothing to pick: the base plan, billed monthly once it ends.
const CARD_TRIAL_SELECTION: PlanSelection = { quantities: ZERO_QUANTITIES, interval: 'monthly' }

// Marks the session of a card trial, whose line items the dialog may not change.
const CARD_TRIAL_METADATA_KEY = 'card_trial'
const TERMS_ACCEPTED_METADATA_KEY = 'terms_accepted_at'

function assertValidSelection(selection: PlanSelection): void {
    assertValidQuantities(selection.quantities)
    if (!BILLING_INTERVALS.includes(selection.interval)) throw new Error('Invalid billing interval.')
}

function planLineItems({ quantities, interval }: PlanSelection, priceArm: PriceArm): { price: string; quantity: number }[] {
    return [
        { price: basePriceId(interval, priceArm), quantity: 1 },
        ...ADDON_KEYS.filter(key => quantities[key] > 0).map(key => ({ price: priceIdForAddon(key, interval), quantity: quantities[key] })),
    ]
}

export type PlanCheckoutSession = { clientSecret: string; sessionId: string; trial: boolean }

// The plan Checkout, rendered by the app itself (`ui_mode: 'elements'`): the Payment Element sits in
// the dialog's own column, under the dialog's own summary and button. Stripe still creates the
// subscription, computes the tax and takes promotion codes, exactly as on the hosted page.
//
// Two differences with the hosted session. The terms acceptance and its immediate-performance notice
// are shown by the dialog, because this mode refuses `custom_text`, and recorded on the session by
// acceptPlanTerms as the box is ticked. And the line items can change while the session is open
// (updatePlanCheckoutSession), so the agents slider and the interval toggle need no new session.
export async function createPlanCheckoutSession(selection: PlanSelection): Promise<PlanCheckoutSession> {
    assertValidSelection(selection)
    const { params, priceArm } = await basePlanCheckoutParams()
    const trial = !!params.subscription_data?.trial_period_days

    const checkout = await stripe.checkout.sessions.create({
        ...params,
        line_items: planLineItems(trial ? CARD_TRIAL_SELECTION : selection, priceArm),
        metadata: { ...params.metadata, ...(trial ? { [CARD_TRIAL_METADATA_KEY]: '1' } : {}) },
        // The address is what the tax is computed from, so the dialog always renders the address form.
        billing_address_collection: 'required',
        ui_mode: 'elements',
        // Only reached by a payment method that leaves the page to authenticate; a card confirms in place.
        return_url: `${await getAppOrigin()}/?billing=success`,
    })

    if (!checkout.client_secret) throw new Error('Stripe did not return a checkout secret')
    return { clientSecret: checkout.client_secret, sessionId: checkout.id, trial }
}

async function requireOpenPlanSession(sessionId: string): Promise<Stripe.Checkout.Session> {
    const workspaceId = await requireWorkspaceId()
    const session = await stripe.checkout.sessions.retrieve(sessionId)
    if (session.metadata?.workspace_id !== String(workspaceId)) throw new Error('This checkout belongs to another workspace')
    if (session.status !== 'open') throw new Error('This checkout is already closed.')
    return session
}

// The line items are sent whole, every time: Stripe drops whatever the list leaves out, which is how
// an interval switch replaces every price at once. The browser then reloads the session through
// `runServerUpdate`, so the totals it shows are Stripe's own.
export async function updatePlanCheckoutSession(sessionId: string, selection: PlanSelection): Promise<void> {
    assertValidSelection(selection)
    const session = await requireOpenPlanSession(sessionId)
    if (session.mode !== 'subscription') throw new Error('This checkout does not sell a plan.')
    if (session.metadata?.[CARD_TRIAL_METADATA_KEY]) throw new Error('The trial plan cannot be changed.')

    const { data: workspace } = await selectSingle(createServiceRoleClient(), 'workspaces', ['price_arm'] as const, { id: Number(session.metadata?.workspace_id) })
    await stripe.checkout.sessions.update(sessionId, { line_items: planLineItems(selection, parsePriceArm(workspace?.price_arm)) })
}

// The buyer ticked the terms in the dialog: the timestamp lands on the session, where Stripe keeps
// the rest of the evidence a dispute turns on.
export async function acceptPlanTerms(sessionId: string): Promise<void> {
    await requireOpenPlanSession(sessionId)
    await stripe.checkout.sessions.update(sessionId, { metadata: { [TERMS_ACCEPTED_METADATA_KEY]: new Date().toISOString() } })
}

// What became of a session, for the surface that opened it. The webhook is the only writer of the
// entitlement, so this is a read: `pending` means it has not landed yet, and `trial_refused` is the
// one outcome where a completed checkout leaves the workspace with nothing (enforceTrialCardClaim
// cancels a trial started on a card that already had one).
export type CheckoutOutcome = { state: 'entitled' | 'trial_refused' | 'pending' }

export async function readCheckoutOutcome(sessionId: string): Promise<CheckoutOutcome> {
    const workspaceId = await requireWorkspaceId()
    const session = await stripe.checkout.sessions.retrieve(sessionId)
    if (session.metadata?.workspace_id !== String(workspaceId)) throw new Error('This checkout belongs to another workspace')

    const supabase = createServiceRoleClient()
    const { data: workspace } = await selectSingle(supabase, 'workspaces', ['subscription_status', 'trial_ends_at'] as const, { id: workspaceId })
    if (isSubscriptionEntitled(workspace?.subscription_status)) return { state: 'entitled' }

    // A trial that was refused for card reuse is cancelled the moment it is created, and the
    // workspace is stamped as having spent its trial. Session complete plus trial spent plus no
    // entitlement is that case, and waiting longer would not change it.
    if (session.status === 'complete' && workspace?.trial_ends_at) return { state: 'trial_refused' }
    return { state: 'pending' }
}

// A subscription in any of these is still being billed, so a second one is a second bill.
const LIVE_SUBSCRIPTION_STATUSES = new Set<Stripe.Subscription.Status>(['active', 'trialing', 'past_due', 'unpaid'])
const ALREADY_SUBSCRIBED = 'Your workspace already has a subscription. Manage it from Billing.'

// Checkout mints a brand new subscription every time it completes, so a workspace that already has
// one and reaches this again pays twice for the same month. It is reachable: a failed renewal
// leaves the workspace past_due, and the way out of past_due is the portal, never a second
// subscription.
//
// Two passes, because either source can be the stale one: the workspace column is what the rest of
// the billing code trusts, and the customer's own subscriptions catch a column that was never
// written (a webhook that 500'd, a subscription created out of band).
async function refuseSecondPlanSubscription(workspaceId: number, customerId: string): Promise<void> {
    const supabase = createServiceRoleClient()
    const { data: workspace } = await selectMaybeSingle(supabase, 'workspaces', ['stripe_subscription_id'] as const, { id: workspaceId })

    if (workspace?.stripe_subscription_id) {
        const current = await stripe.subscriptions.retrieve(workspace.stripe_subscription_id).catch(() => null)
        if (current && LIVE_SUBSCRIPTION_STATUSES.has(current.status)) throw new Error(ALREADY_SUBSCRIBED)
    }

    const { data: subscriptions } = await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 100 })
    if (subscriptions.some(subscription => !isTemplateSubscription(subscription) && LIVE_SUBSCRIPTION_STATUSES.has(subscription.status))) {
        throw new Error(ALREADY_SUBSCRIBED)
    }
}

// The card form of the plan dialogs: a card for a trial that started without one (the dialog then
// runs the plan change itself), a new card for a paid plan, and the card that settles a failed
// payment. Same setup session as above, rendered by the app's own UI.
export async function createPlanCardSetupSession(): Promise<{ clientSecret: string; sessionId: string }> {
    const { workspaceId, subscription } = await requireEditablePlanSubscription({ allowPastDue: true })

    const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id
    await ensureCustomerEmail(customerId)
    const checkout = await stripe.checkout.sessions.create({
        mode: 'setup',
        customer: customerId,
        currency: PLAN_CURRENCY,
        payment_method_types: PLAN_PAYMENT_METHOD_TYPES,
        billing_address_collection: 'required',
        customer_update: { address: 'auto', name: 'auto' },
        tax_id_collection: { enabled: true },
        metadata: {
            kind: PLAN_CARD_SETUP_KIND,
            workspace_id: String(workspaceId),
            subscription_id: subscription.id,
        },
        ui_mode: 'elements',
        return_url: `${await getAppOrigin()}/?billing=1`,
    })

    if (!checkout.client_secret) throw new Error('Stripe did not return a checkout secret')
    return { clientSecret: checkout.client_secret, sessionId: checkout.id }
}

// A selection stored as a JSON string in Stripe metadata, read back defensively.
function parsePlanSelection(raw: string | undefined): PlanSelection | null {
    if (!raw) return null
    try {
        const parsed = JSON.parse(raw) as PlanSelection
        // Only the add-ons still sold: a selection stored before the agent pack was retired still carries it.
        const quantities = Object.fromEntries(ADDON_KEYS.map(key => [key, parsed.quantities?.[key] ?? ZERO_QUANTITIES[key]])) as AddonQuantities
        const selection = { quantities, interval: parsed.interval }
        assertValidSelection(selection)
        return selection
    } catch {
        return null
    }
}

// The browser's half of a completed setup session, run with the buyer's own session: the card is
// handed to the subscription. A trial paying now goes on from the dialog, which runs the plan change
// itself once the card is saved; a tab closed before that leaves a card on file, which converts the
// trial on its last day all the same.
//
// A failed payment is settled here: the new card pays the invoice still open, and a decline on it
// comes back to the person who typed the card. Only here and never in the webhook, for that reason.
export async function completeCardSetupSession(session: Stripe.Checkout.Session): Promise<void> {
    await applyCardSetupSession(session)

    const { subscription } = await requireEditablePlanSubscription({ allowPastDue: true })
    if (subscription.status === 'past_due') await payOpenInvoice(subscription, await checkoutPaymentMethodId(session, subscription))
}

async function payOpenInvoice(subscription: Stripe.Subscription, paymentMethodId: string | null): Promise<void> {
    const { data: open } = await stripe.invoices.list({ subscription: subscription.id, status: 'open', limit: 1 })
    const invoice = open[0]
    if (!invoice?.id) return
    await stripe.invoices.pay(invoice.id, paymentMethodId ? { payment_method: paymentMethodId } : {})
}

// Hand the card collected by a setup session to the plan subscription, then switch automatic tax
// back on now that the address exists. Runs from both the browser (completeCardSetupSession) and
// the webhook, so every step is idempotent: writing the same default twice is a no-op.
export async function applyCardSetupSession(session: Stripe.Checkout.Session): Promise<void> {
    const subscriptionId = session.metadata?.subscription_id
    if (!subscriptionId) return

    const subscription = await stripe.subscriptions.retrieve(subscriptionId)
    // The trial can have lapsed between the session being opened and the card arriving; a
    // canceled subscription refuses updates, and there is nothing left to convert anyway.
    if (subscription.status === 'canceled') return

    const paymentMethodId = await checkoutPaymentMethodId(session, subscription)
    if (paymentMethodId) await stripe.subscriptions.update(subscription.id, { default_payment_method: paymentMethodId })
    await adoptCheckoutPaymentMethodAsDefault(session, subscription)
    await enableAutomaticTaxOnPlanSubscription(subscription.id)
}

// Best effort: if the address still fails Stripe's tax location check, the card is saved all the
// same and the subscription simply keeps billing tax-free rather than failing the whole flow.
async function enableAutomaticTaxOnPlanSubscription(subscriptionId: string): Promise<void> {
    try {
        await stripe.subscriptions.update(subscriptionId, { automatic_tax: { enabled: true } })
    } catch (err) {
        console.error('[billing] could not enable automatic tax after card setup', err)
    }
}

// --- In-app subscription management (quantity changes) ---

export type SavedCard = { brand: string; last4: string; expMonth: number; expYear: number }

export type SubscriptionState = {
    entitled: boolean
    status: Stripe.Subscription.Status
    quantities: AddonQuantities
    interval: BillingInterval
    // The arm of the price test the subscription was sold on: what the dialog prices the plan with.
    priceArm: PriceArm
    // A switch to monthly waiting for the end of the paid year, with the plan it lands on.
    pendingSwitch: { selection: PlanSelection; at: string } | null
    // Flat amount taken off the list price on every invoice of the current interval, for a workspace
    // grandfathered on a legacy base price or holding a permanent promo on the whole subscription.
    monthlyDiscountCents: number
    // Columns that are currently higher than what the live subscription pays for: a
    // downgrade landing at the next renewal.
    pendingDowngrade: Partial<Pick<WorkspaceLimitColumns, 'rerun_budget_micros'>>
    periodEnd: string | null
    card: SavedCard | null
    // What the next invoice bills, tax included. null once the plan is set to end.
    nextInvoice: { at: string; amountCents: number } | null
    // The invoice a failed payment left open, for the past-due card form.
    openInvoice: { amountCents: number; createdAt: string } | null
    // False only on a trial started without a card before 2026-09-05 that has not been through the
    // setup Checkout yet: the dialog shows the add-a-card call to action off this, and add-on
    // purchases are refused without one. A trial out of Checkout always has a card.
    hasPaymentMethod: boolean
    // Cancellation already requested: the subscription runs to the end of the period and stops.
    // Nothing that bills a new cycle is offered on top of that.
    cancelAtPeriodEnd: boolean
    // Where the cancel flow can be opened from, and which one. null for a trial without a card,
    // which ends on its own.
    cancelPhase: CancelPhase | null
    // A retention offer claimed and still waiting for the invoice it discounts.
    retentionOffer: RetentionOfferKind | null
    business: BusinessDetails
}

// Only flat, never-ending coupons count: a percentage or a time-limited promo would make the
// figure shown next to the plan wrong the day it lapses, and the list price is the safe default.
//
// A coupon holds an amount in one currency, and a coupon minted in another one cannot be read as
// dollars: doing so would overstate the discount by the exchange rate.
function permanentCouponCents(coupon: Stripe.Coupon | null): number {
    if (!coupon || coupon.duration !== 'forever' || coupon.currency !== PLAN_CURRENCY) return 0
    return coupon.amount_off ?? 0
}

function permanentDiscountCents(subscription: Stripe.Subscription): number {
    return (subscription.discounts ?? []).reduce((sum, discount) => {
        const coupon = typeof discount === 'string' ? null : discount.source?.coupon
        return sum + permanentCouponCents(!coupon || typeof coupon === 'string' ? null : coupon)
    }, 0)
}

// Live subscription state for the billing dialog: current paid quantities plus any
// downgrade held until renewal (workspace columns higher than the derived limits).
export async function getSubscriptionState(): Promise<SubscriptionState | null> {
    const workspaceId = await requireWorkspaceId()
    const supabase = createServiceRoleClient()
    const { data: workspace } = await selectSingle(
        supabase,
        'workspaces',
        ['stripe_subscription_id', 'subscription_status', 'current_period_end', 'rerun_budget_micros'] as const,
        { id: workspaceId },
    )
    if (!workspace?.stripe_subscription_id) return null

    const subscription = await stripe.subscriptions.retrieve(workspace.stripe_subscription_id, {
        expand: ['discounts.source.coupon', 'customer.invoice_settings.default_payment_method', 'customer.tax_ids', 'default_payment_method'],
    })
    const { hasBase, quantities } = quantitiesFromItems(subscription.items.data)
    if (!hasBase) return null

    const customer = typeof subscription.customer === 'string' || subscription.customer.deleted ? null : subscription.customer
    const paymentMethod = subscription.default_payment_method ?? customer?.invoice_settings?.default_payment_method ?? null
    const hasPaymentMethod = !!paymentMethod

    const derived = quantitiesToColumns(quantities)
    const pendingDowngrade: SubscriptionState['pendingDowngrade'] = {}
    if (subscription.status !== 'trialing' && workspace.rerun_budget_micros > derived.rerun_budget_micros) pendingDowngrade.rerun_budget_micros = derived.rerun_budget_micros

    const [pendingSwitch, nextInvoice, openInvoice] = await Promise.all([
        readPendingSwitch(subscription),
        subscription.cancel_at_period_end ? null : readNextInvoice(subscription),
        subscription.status === 'past_due' ? readOpenInvoice(subscription) : null,
    ])

    return {
        entitled: subscription.status === 'active' || subscription.status === 'trialing',
        status: subscription.status,
        quantities,
        interval: intervalOfItems(subscription.items.data),
        priceArm: priceArmOfItems(subscription.items.data),
        pendingSwitch,
        monthlyDiscountCents: permanentDiscountCents(subscription) + legacyBaseDiscountCents(subscription.items.data),
        pendingDowngrade,
        periodEnd: workspace.current_period_end,
        card: savedCard(paymentMethod),
        nextInvoice,
        openInvoice,
        hasPaymentMethod,
        cancelAtPeriodEnd: subscription.cancel_at_period_end,
        cancelPhase: cancelFlowPhase(subscription.status, hasPaymentMethod),
        retentionOffer: pendingRetentionOffer(subscription),
        business: businessDetailsOf(customer),
    }
}

function savedCard(paymentMethod: string | Stripe.PaymentMethod | null): SavedCard | null {
    if (!paymentMethod || typeof paymentMethod === 'string' || !paymentMethod.card) return null
    const { brand, last4, exp_month, exp_year } = paymentMethod.card
    return { brand, last4, expMonth: exp_month, expYear: exp_year }
}

// Best effort: the dialog still opens on a plan whose upcoming invoice Stripe cannot preview.
async function readNextInvoice(subscription: Stripe.Subscription): Promise<SubscriptionState['nextInvoice']> {
    try {
        const invoice = await stripe.invoices.createPreview({ subscription: subscription.id })
        const at = stripeTimestampIso(invoice.next_payment_attempt ?? invoice.period_end)
        return at ? { at, amountCents: invoice.amount_due } : null
    } catch (err) {
        console.error('[billing] could not preview the next invoice', err)
        return null
    }
}

async function readOpenInvoice(subscription: Stripe.Subscription): Promise<SubscriptionState['openInvoice']> {
    const { data } = await stripe.invoices.list({ subscription: subscription.id, status: 'open', limit: 1 })
    const invoice = data[0]
    return invoice ? { amountCents: invoice.amount_due, createdAt: new Date(invoice.created * 1000).toISOString() } : null
}

export type InvoiceSummary = { id: string; createdAt: string; amountCents: number; status: string; pdfUrl: string | null; hostedUrl: string | null }

export async function listInvoices(): Promise<InvoiceSummary[]> {
    const workspaceId = await requireWorkspaceId()
    const supabase = createServiceRoleClient()
    const { data: workspace } = await selectSingle(supabase, 'workspaces', ['stripe_customer_id'] as const, { id: workspaceId })
    if (!workspace?.stripe_customer_id) return []

    const { data } = await stripe.invoices.list({ customer: workspace.stripe_customer_id, limit: 12 })
    return data
        .filter(invoice => invoice.id && invoice.status !== 'draft' && invoice.status !== 'void')
        .map(invoice => ({
            id: invoice.id!,
            createdAt: new Date(invoice.created * 1000).toISOString(),
            amountCents: invoice.total,
            status: invoice.status ?? 'open',
            pdfUrl: invoice.invoice_pdf ?? null,
            hostedUrl: invoice.hosted_invoice_url ?? null,
        }))
}

// --- Business details: the name and the tax ID the invoices carry ---

export type BusinessTaxId = { type: TaxIdType; value: string; status: TaxIdStatus | null }

// `country` is the billing address's: the tax ID types on offer are read off it, and a customer
// without one (a trial started without a card) has nothing to check a number against yet.
export type BusinessDetails = { name: string | null; country: string | null; taxId: BusinessTaxId | null }

function customerTaxIds(customer: Stripe.Customer): Stripe.TaxId[] {
    return customer.tax_ids?.data ?? []
}

function businessDetailsOf(customer: Stripe.Customer | null): BusinessDetails {
    if (!customer) return { name: null, country: null, taxId: null }
    const taxId = customerTaxIds(customer).find(id => id.type !== 'unknown')
    return {
        name: customer.name ?? null,
        country: customer.address?.country ?? null,
        taxId: taxId ? { type: taxId.type as TaxIdType, value: taxId.value, status: taxId.verification?.status ?? null } : null,
    }
}

async function requireBillingCustomer(): Promise<Stripe.Customer> {
    const workspaceId = await requireWorkspaceId()
    const { data: workspace } = await selectSingle(createServiceRoleClient(), 'workspaces', ['stripe_customer_id'] as const, { id: workspaceId })
    if (!workspace?.stripe_customer_id) throw new Error('Your workspace has no billing account yet.')
    const customer = await stripe.customers.retrieve(workspace.stripe_customer_id, { expand: ['tax_ids'] })
    if (customer.deleted) throw new Error('Your billing account was closed.')
    return customer
}

function countryName(country: string): string {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(country) ?? country
}

function isInvalidTaxIdError(err: unknown): boolean {
    return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'tax_id_invalid'
}

export type BusinessDetailsInput = { name: string; type: TaxIdType; value: string }

// One number per customer: the new one is created before the old ones go, so a number Stripe
// refuses leaves the one already on file in place. Only the invoices finalized from now on carry
// it; the ones already issued are left as they are.
export async function saveBusinessDetails(input: BusinessDetailsInput): Promise<BusinessDetails> {
    const customer = await requireBillingCustomer()
    const country = customer.address?.country
    if (!country) throw new Error('Add a card first: the number is checked against its billing address.')
    if (!taxIdTypesFor(country).includes(input.type)) throw new Error(`This kind of number does not match your billing country, ${countryName(country)}.`)

    const value = normalizeTaxIdValue(input.type, input.value, country)
    const existing = customerTaxIds(customer)
    let kept = existing.find(id => id.type === input.type && id.value === value)
    if (!kept) {
        try {
            kept = await stripe.customers.createTaxId(customer.id, { type: input.type, value })
        } catch (err) {
            if (isInvalidTaxIdError(err)) throw new Error(`This number is not valid for ${countryName(country)}.`)
            throw err
        }
    }
    const keptId = kept.id
    await Promise.all(existing.filter(id => id.id !== keptId).map(id => stripe.customers.deleteTaxId(customer.id, id.id)))

    const name = input.name.trim()
    if (name !== customer.name) await stripe.customers.update(customer.id, { name })

    return {
        name,
        country,
        taxId: { type: input.type, value: kept.value, status: kept.verification?.status ?? null },
    }
}

export async function removeTaxId(): Promise<void> {
    const customer = await requireBillingCustomer()
    await Promise.all(customerTaxIds(customer).map(id => stripe.customers.deleteTaxId(customer.id, id.id)))
}

function pendingRetentionOffer(subscription: Stripe.Subscription): RetentionOfferKind | null {
    for (const discount of subscription.discounts ?? []) {
        const coupon = typeof discount === 'string' ? null : discount.source?.coupon
        const kind = retentionOfferOfCoupon(typeof coupon === 'string' ? coupon : coupon?.id)
        if (kind) return kind
    }
    return null
}

// Shape both the subscription update and the invoice preview accept, so a single diff can
// feed the two calls: quoting a price from one set of items and charging another is how a
// confirmation dialog ends up lying about the amount.
type PlanItemChange = { id?: string; price?: string; quantity?: number; deleted?: boolean }

// Split the move from the subscription's current add-on quantities to `target` into the items
// that cost more and the items that cost less. `endingTrial` reports the case where the change
// cuts a trial short: a trial bills nothing and prorates nothing, so an add-on bought during
// one would be charged for but only delivered at conversion.
function planItemChanges(subscription: Stripe.Subscription, target: AddonQuantities): { increases: PlanItemChange[]; decreases: PlanItemChange[]; endingTrial: boolean } {
    const { quantities: current } = quantitiesFromItems(subscription.items.data)
    const interval = intervalOfItems(subscription.items.data)

    const itemIdByAddon = new Map<string, string>()
    for (const item of subscription.items.data) {
        const addon = addonForPriceId(item.price?.id)
        if (addon) itemIdByAddon.set(addon, item.id)
    }

    const increases: PlanItemChange[] = []
    const decreases: PlanItemChange[] = []
    for (const key of ADDON_KEYS) {
        if (target[key] === current[key]) continue
        const existingItemId = itemIdByAddon.get(key)
        const item: PlanItemChange = existingItemId
            ? target[key] === 0
                ? { id: existingItemId, deleted: true }
                : { id: existingItemId, quantity: target[key] }
            : { price: priceIdForAddon(key, interval), quantity: target[key] }
        ;(target[key] > current[key] ? increases : decreases).push(item)
    }

    return { increases, decreases, endingTrial: subscription.status === 'trialing' && increases.length > 0 }
}

// Load the plan subscription the caller is allowed to edit, with the same guards for the
// preview and the update: quoting an amount on a subscription the update would refuse is
// worse than refusing upfront.
//
// `allowPastDue` opens the card form to a failed payment, the one change a past-due plan can take.
async function requireEditablePlanSubscription({ allowPastDue = false }: { allowPastDue?: boolean } = {}): Promise<{ workspaceId: number; subscription: Stripe.Subscription }> {
    const workspaceId = await requireWorkspaceId()
    const supabase = createServiceRoleClient()
    const { data: workspace } = await selectSingle(supabase, 'workspaces', ['stripe_subscription_id', 'subscription_status'] as const, { id: workspaceId })

    if (!workspace?.stripe_subscription_id) throw new Error('No active subscription. Subscribe first.')
    const editable = workspace.subscription_status === 'active' || workspace.subscription_status === 'trialing' || (allowPastDue && workspace.subscription_status === 'past_due')
    if (!editable) throw new Error('Your subscription is not active.')

    const subscription = await stripe.subscriptions.retrieve(workspace.stripe_subscription_id)
    if (isTemplateSubscription(subscription)) throw new Error('No plan subscription found.')
    const { hasBase } = quantitiesFromItems(subscription.items.data)
    if (!hasBase) throw new Error('No plan subscription found.')

    return { workspaceId, subscription }
}

function assertValidQuantities(target: AddonQuantities): void {
    for (const key of ADDON_KEYS) {
        if (!Number.isInteger(target[key]) || target[key] < 0) throw new Error('Invalid add-on quantity.')
    }
}

// What the card is about to be charged for a set of quantities, before anything is applied.
export type PlanChangePreview = {
    // Total the invoice will carry, tax included: prices are tax-exclusive (TAX_BEHAVIOR), so
    // quoting the pre-tax figure would understate what actually leaves the account.
    dueTodayCents: number
    taxCents: number
    // False while automatic tax is off (a trial started without a card before 2026-09-05, before
    // the setup Checkout collects an address): the figure is pre-tax and the dialog must say so
    // instead of "Includes … tax".
    taxIncluded: boolean
    nextRenewalIso: string | null
}

function isProrationLine(line: Stripe.InvoiceLineItem): boolean {
    return !!(line.parent?.subscription_item_details?.proration || line.parent?.invoice_item_details?.proration)
}

function lineTaxCents(line: Stripe.InvoiceLineItem): number {
    return (line.taxes ?? []).reduce((sum, tax) => sum + tax.amount, 0)
}

// Dry-run of updateSubscriptionQuantities: same items, same proration, no write. Returns null
// when the change costs nothing today (a decrease only), which needs no confirmation.
export async function previewSubscriptionUpdate(target: AddonQuantities): Promise<PlanChangePreview | null> {
    assertValidQuantities(target)
    const { subscription } = await requireEditablePlanSubscription()
    const { increases, endingTrial } = planItemChanges(subscription, target)
    if (increases.length === 0) return null

    const invoice = await stripe.invoices.createPreview({
        subscription: subscription.id,
        subscription_details: {
            items: increases,
            proration_behavior: endingTrial ? 'none' : 'always_invoice',
            ...(endingTrial ? { trial_end: 'now' as const } : {}),
        },
    })

    // Ending the trial restarts the period now, so the preview is exactly the invoice about to
    // be collected. A mid-cycle increase is a different beast: the preview is the next invoice
    // and carries the coming cycle's recurring lines alongside the prorations, and only the
    // prorations are charged today. Summing them is right whichever way Stripe scopes the
    // preview. Customer-balance credit is ignored because no path here ever mints any:
    // decreases are applied with `proration_behavior: 'none'`.
    if (endingTrial) return trialEndPreview(invoice, subscription)

    const taxIncluded = subscription.automatic_tax?.enabled ?? true
    const prorations = invoice.lines.data.filter(isProrationLine)
    // No proration line means the preview holds nothing chargeable today that we can name with
    // confidence. Quoting the invoice total there would announce the next cycle as if it were
    // due now, so the dialog falls back to its generic wording instead.
    if (prorations.length === 0) return null

    const amountCents = prorations.reduce((sum, line) => sum + line.amount, 0)
    const taxCents = prorations.reduce((sum, line) => sum + lineTaxCents(line), 0)
    return {
        dueTodayCents: amountCents + taxCents,
        taxCents,
        taxIncluded,
        nextRenewalIso: subscriptionPeriodEndIso(subscription),
    }
}

// Ending a trial restarts the period, so the whole invoice is collected on the spot and its total
// is the figure to announce. Shared by both trial-ending paths: the quote and the charge come from
// the same reading of the same preview.
function trialEndPreview(invoice: Stripe.Invoice, subscription: Stripe.Subscription): PlanChangePreview {
    const taxCents = (invoice.total_taxes ?? []).reduce((sum, tax) => sum + tax.amount, 0)
    return {
        dueTodayCents: invoice.amount_due,
        taxCents,
        taxIncluded: subscription.automatic_tax?.enabled ?? true,
        nextRenewalIso: subscriptionPeriodEndIso(subscription),
    }
}

// Pushes a running trial's end back by `days`, read off Stripe rather than the workspace row so a
// webhook still in flight cannot shorten it. Like `endTrialNow`, nothing is written here: the
// `customer.subscription.updated` webhook moves `trial_ends_at`, and realtime carries it to the
// billing dialog. Returns false when there is no trial left to extend.
export async function extendTrial(subscriptionId: string, days: number, idempotencyKey: string): Promise<boolean> {
    const subscription = await stripe.subscriptions.retrieve(subscriptionId)
    if (subscription.status !== 'trialing' || !subscription.trial_end) return false

    await stripe.subscriptions.update(subscription.id, { trial_end: subscription.trial_end + days * 86_400, proration_behavior: 'none' }, { idempotencyKey })
    return true
}

function trialConversionState(subscription: Stripe.Subscription, hasPaymentMethod: boolean): { status: string; hasPaymentMethod: boolean; cancelAtPeriodEnd: boolean } {
    return { status: subscription.status, hasPaymentMethod, cancelAtPeriodEnd: subscription.cancel_at_period_end }
}

// --- Cancel flow ---

export type CancelFlowOffer = {
    kind: RetentionOfferKind
    priceCents: number
    fullPriceCents: number
    // The base plan alone at the price this workspace pays, which the $1 offer is worded against.
    basePriceCents: number
    billedOn: string
    fullPriceFrom: string
}

// Everything the cancel dialog quotes, read off the live subscription so the figures it shows are
// the ones Stripe will bill. Dates are ISO, formatted by the dialog in the reader's time zone.
export type CancelFlowState = {
    // The moment these figures were read, which the dialog counts days and draws its timeline from.
    now: string
    phase: CancelPhase
    // The renewal for a paying customer, the first charge for a trial: when access ends if they go.
    endsAt: string
    // How long the paused workspace is kept once access ends: a trial is paused two hours after its
    // notice, a paid plan on the spot, and the archive lives on for its retention after that.
    keptUntil: string
    reminderAt: string | null
    paidLeftCents: number
    offer: CancelFlowOffer | null
}

const DAY_MS = 24 * 60 * 60_000

type CancellableSubscription = { workspaceId: number; subscription: Stripe.Subscription; phase: CancelPhase; endsAt: Date }

async function requireCancellableSubscription(): Promise<CancellableSubscription> {
    const { workspaceId, subscription } = await requireEditablePlanSubscription()
    const phase = cancelFlowPhase(subscription.status, await subscriptionHasPaymentMethod(subscription))
    if (!phase) throw new Error('Your trial ends on its own, there is nothing to cancel.')

    const endsAtIso = phase === 'trial' ? stripeTimestampIso(subscription.trial_end) : subscriptionPeriodEndIso(subscription)
    if (!endsAtIso) throw new Error('Could not read your billing period.')
    return { workspaceId, subscription, phase, endsAt: new Date(endsAtIso) }
}

// What one period of the plan costs this workspace before tax, a grandfathered base price included.
function planPeriodCents(subscription: Stripe.Subscription): number {
    const { quantities } = quantitiesFromItems(subscription.items.data)
    return planPriceCents(quantities, intervalOfItems(subscription.items.data), priceArmOfItems(subscription.items.data)) - legacyBaseDiscountCents(subscription.items.data)
}

// The offers are priced on a month: a yearly plan gets none.
function retentionOfferOf({ subscription, phase }: CancellableSubscription): RetentionOfferKind | null {
    if (intervalOfItems(subscription.items.data) === 'yearly') return null
    return retentionOfferFor(phase, {
        metadata: subscription.metadata,
        discountCount: subscription.discounts?.length ?? 0,
        legacyBase: legacyBaseDiscountCents(subscription.items.data) > 0,
    })
}

function periodStartOf(subscription: Stripe.Subscription): Date | null {
    const start = subscription.items.data.find(item => isBasePriceId(item.price?.id))?.current_period_start
    return start ? new Date(start * 1000) : null
}

export async function getCancelFlowState(): Promise<CancelFlowState> {
    const cancellable = await requireCancellableSubscription()
    const { subscription, phase, endsAt } = cancellable
    if (subscription.cancel_at_period_end) throw new Error('Your subscription is already set to cancel.')

    const now = new Date()
    const monthlyCents = planPeriodCents(subscription)
    const periodStart = periodStartOf(subscription)
    const kind = retentionOfferOf(cancellable)
    const priceArm = priceArmOfItems(subscription.items.data)

    return {
        now: now.toISOString(),
        phase,
        endsAt: endsAt.toISOString(),
        keptUntil: new Date(endsAt.getTime() + (phase === 'trial' ? BOX_DELETION_GRACE_MS : 0) + ARCHIVE_RETENTION_DAYS * DAY_MS).toISOString(),
        reminderAt: reminderDate(phase, endsAt, now)?.toISOString() ?? null,
        paidLeftCents: phase === 'paid' && periodStart ? paidLeftCents(monthlyCents, periodStart, endsAt, now) : 0,
        offer: kind
            ? {
                  kind,
                  priceCents: offerPriceCents(kind, monthlyCents, priceArm),
                  fullPriceCents: monthlyCents,
                  basePriceCents: basePriceCents(priceArm),
                  billedOn: endsAt.toISOString(),
                  fullPriceFrom: addOneMonth(endsAt).toISOString(),
              }
            : null,
    }
}

// Cancels at the end of the period, never on the spot: a paying customer keeps what they paid for,
// a trial runs to its end and is never charged. The customer's own words land in
// `cancellation_details.comment` and the reason they were filed under in `feedback`, where
// the `customer.subscription.updated` webhook reads it into `subscription_cancel_requested`, which is
// also the one writer of `subscription_cancel_at`.
export async function cancelSubscription(input: { reason: CancelReason; comeback: CancelComeback; comment: string; check: CancelReasonCheck }): Promise<void> {
    const { subscription: loaded } = await requireCancellableSubscription()
    if (loaded.cancel_at_period_end) return
    const subscription = await releasePendingSwitch(loaded)

    await stripe.subscriptions.update(subscription.id, {
        cancel_at_period_end: true,
        cancellation_details: { feedback: input.reason, comment: input.comment },
        metadata: { [CANCEL_COMEBACK_METADATA_KEY]: input.comeback, [CANCEL_REASON_CHECK_METADATA_KEY]: input.check },
    })
}

export async function resumeSubscription(): Promise<void> {
    const { subscription } = await requireEditablePlanSubscription()
    if (!subscription.cancel_at_period_end) return

    await stripe.subscriptions.update(subscription.id, { cancel_at_period_end: false })
}

// Created on first use and found again by its fixed id afterwards. The $1 coupon is limited to the
// base plan's product, so the add-ons keep their price.
async function ensureRetentionCoupon(kind: RetentionOfferKind, subscription: Stripe.Subscription): Promise<string> {
    const priceArm = priceArmOfItems(subscription.items.data)
    const id = retentionCouponId(kind, priceArm)
    try {
        return (await stripe.coupons.retrieve(id)).id
    } catch (err) {
        if ((err as { code?: string }).code !== 'resource_missing') throw err
    }

    if (kind === 'trial_half') return (await stripe.coupons.create({ id, ...retentionCouponParams(kind, priceArm) })).id

    const product = subscription.items.data.find(item => isBasePriceId(item.price?.id))?.price.product
    if (!product) throw new Error('No plan subscription found.')
    const productId = typeof product === 'string' ? product : product.id
    return (await stripe.coupons.create({ id, ...retentionCouponParams(kind, priceArm), applies_to: { products: [productId] } })).id
}

// The offer is checked again here rather than trusted from the dialog: it is once per workspace, and
// the claim stamp on the subscription is what makes it so.
export async function claimRetentionOffer(): Promise<RetentionOfferKind> {
    const cancellable = await requireCancellableSubscription()
    const { subscription } = cancellable
    const kind = retentionOfferOf(cancellable)
    if (!kind) throw new Error('This offer is no longer available.')

    const coupon = await ensureRetentionCoupon(kind, subscription)
    await stripe.subscriptions.update(
        subscription.id,
        {
            discounts: [{ coupon }],
            metadata: { [RETENTION_CLAIMED_METADATA_KEY]: new Date().toISOString() },
        },
        { idempotencyKey: `retention-offer:${subscription.id}` },
    )
    return kind
}

// The paying customer's "remind me before I'm charged". A trial needs nothing stored: the email the
// day before its first charge goes out to every trial already.
export async function requestRenewalReminder(): Promise<string> {
    const { workspaceId, phase, endsAt } = await requireCancellableSubscription()
    if (phase !== 'paid') throw new Error('Only a paid plan renews.')

    const at = reminderDate(phase, endsAt, new Date())
    if (!at) throw new Error('Your plan renews too soon for a reminder.')

    const { user } = await getSessionWorkspace()
    if (!user?.id) throw new Error('Not authenticated')

    const supabase = createServiceRoleClient()
    const { error } = await supabase
        .from('workspaces')
        .update<WorkspaceUpdate>({ renewal_reminder_at: at.toISOString(), renewal_reminder_user_id: user.id })
        .eq('id', workspaceId)
    if (error) throw error
    return at.toISOString()
}

// --- Plan changes from the plan dialog: agents and interval together ---

// Every plan item moved onto `selection`: the base and add-on items keep their ids and change price,
// add-ons appear or go, and a legacy seat or agent pack item goes with the old interval, since a
// subscription bills every item on the same one.
function replacementItems(subscription: Stripe.Subscription, { quantities, interval }: PlanSelection): PlanItemChange[] {
    const priceArm = priceArmOfItems(subscription.items.data)
    const changes: PlanItemChange[] = []
    const kept = new Set<string>()
    for (const item of subscription.items.data) {
        const priceId = item.price?.id
        if (isBasePriceId(priceId)) {
            changes.push({ id: item.id, price: basePriceId(interval, priceArm), quantity: 1 })
            continue
        }
        const addon = addonForPriceId(priceId)
        if (addon && quantities[addon] > 0 && !kept.has(addon)) {
            kept.add(addon)
            changes.push({ id: item.id, price: priceIdForAddon(addon, interval), quantity: quantities[addon] })
            continue
        }
        if (addon || isLegacyPlanItemPriceId(priceId)) changes.push({ id: item.id, deleted: true })
    }
    for (const key of ADDON_KEYS) {
        if (quantities[key] > 0 && !kept.has(key)) changes.push({ price: priceIdForAddon(key, interval), quantity: quantities[key] })
    }
    return changes
}

// How a selection lands on the subscription:
// - during a trial, it ends the trial and bills the whole new plan today;
// - on the same interval, more is billed today (prorated) and less waits for the renewal;
// - monthly to yearly starts the year today, the unused month credited;
// - yearly to monthly waits for the end of the paid year, more agents still billed today.
export type PlanChangeKind = 'end_trial' | 'same_interval' | 'switch_now' | 'switch_at_renewal'

export function planChangeKind(status: string, current: BillingInterval, target: BillingInterval): PlanChangeKind {
    if (status === 'trialing') return 'end_trial'
    if (current === target) return 'same_interval'
    return target === 'yearly' ? 'switch_now' : 'switch_at_renewal'
}

// `paymentClientSecret` is set when the bank asked for 3-D Secure: the change waits as a Stripe
// pending update until the browser completes the payment with it, and lapses untouched otherwise.
export type PlanChangeResult = { trialEnded: boolean; switchAt: string | null; paymentClientSecret: string | null }

export const CHARGE_REFUSED_MESSAGE = "We couldn't charge your card. Nothing was charged, try again or change your card."

// The selection a pending update finishes once the bank confirms it, carried in the update's own
// metadata: Stripe writes it on the subscription at the very moment the paid increase lands, and
// drops it with the update if nobody pays. `finishPendingPlanChange` reads it from the webhook.
const PLAN_CHANGE_AFTER_PAYMENT_KEY = 'plan_change_after_payment'

// Charges the saved card for a change, and holds the change until the charge succeeds. A bank that
// asks for 3-D Secure would make `error_if_incomplete` throw and the customer could never pay; a
// pending update instead hands the browser the invoice's client secret, and Stripe voids the invoice
// and drops the change on its own if nobody confirms it.
async function updateWithPayment(subscriptionId: string, params: Stripe.SubscriptionUpdateParams, afterPayment: PlanSelection | null = null): Promise<string | null> {
    const updated = await stripe.subscriptions.update(subscriptionId, {
        ...params,
        ...(afterPayment ? { metadata: { [PLAN_CHANGE_AFTER_PAYMENT_KEY]: JSON.stringify(afterPayment) } } : {}),
        payment_behavior: 'pending_if_incomplete',
        expand: ['latest_invoice.confirmation_secret'],
    })
    if (!updated.pending_update) return null
    const invoice = typeof updated.latest_invoice === 'object' ? updated.latest_invoice : null
    const clientSecret = invoice?.confirmation_secret?.client_secret
    if (!clientSecret) throw new Error(CHARGE_REFUSED_MESSAGE)
    await assertPaymentAwaitsConfirmation(clientSecret)
    return clientSecret
}

// A pending update also holds a plain decline, which leaves the browser nothing to confirm: only a
// payment waiting on the bank goes back to it, a refusal comes back in the card's own words.
async function assertPaymentAwaitsConfirmation(clientSecret: string): Promise<void> {
    const intent = await stripe.paymentIntents.retrieve(clientSecret.split('_secret_')[0]!)
    if (intent.status === 'requires_action') return
    const refusal = intent.last_payment_error
    throw new Error(refusal?.type === 'card_error' && refusal.message ? refusal.message : CHARGE_REFUSED_MESSAGE)
}

// An app slot can only go once no account fills it: the billing dialog greys the button out, and
// this is the same rule for a request that does not come from it. Only a removal is judged, and only
// against the accounts a paid slot holds: the subscriber trial's free slot and an account already
// paused for want of one are not on the bill.
async function assertSlotRemovalLeavesConnections(workspaceId: number, subscription: Stripe.Subscription, target: AddonQuantities): Promise<void> {
    const { quantities: current } = quantitiesFromItems(subscription.items.data)
    const supabase = createServiceRoleClient()
    for (const slug of APP_SLUGS) {
        const addonKey = APP_ADDON_KEYS[slug]
        if (target[addonKey] >= current[addonKey]) continue
        const [{ data: connections }, { data: app }] = await Promise.all([
            selectMany(supabase, 'app_connections', ['status', 'pause_reason'] as const, { workspace_id: workspaceId, app_slug: slug, status: [...SLOT_HOLDING_STATUSES] }),
            selectMaybeSingle(supabase, 'workspace_apps', ['trial_ends_at', 'trial_settled_at'] as const, { workspace_id: workspaceId, app_slug: slug }),
        ])
        const onPaidSlots = (connections ?? []).filter(connection => !(connection.status === 'paused' && (SLOT_PAUSE_REASONS as readonly string[]).includes(connection.pause_reason ?? ''))).length - (subscriberTrialOpen(app) ? 1 : 0)
        const { name, providerLabel } = APP_INFO[slug]
        if (target[addonKey] < onPaidSlots) throw new Error(`Disconnect a ${providerLabel} account in ${name} before removing its slot.`)
    }
}

export async function changePlan(selection: PlanSelection): Promise<PlanChangeResult> {
    assertValidSelection(selection)
    const { workspaceId, subscription: loaded } = await requireEditablePlanSubscription()
    await assertSlotRemovalLeavesConnections(workspaceId, loaded, selection.quantities)
    const subscription = await releasePendingSwitch(loaded)
    const kind = planChangeKind(subscription.status, intervalOfItems(subscription.items.data), selection.interval)

    if (kind === 'end_trial') {
        await assertTrialConvertible(subscription)
        const paymentClientSecret = await updateWithPayment(subscription.id, {
            items: replacementItems(subscription, selection),
            trial_end: 'now',
            proration_behavior: 'none',
        })
        return { trialEnded: true, switchAt: null, paymentClientSecret }
    }

    if (kind === 'switch_now') {
        await assertPaymentMethod(subscription)
        const paymentClientSecret = await updateWithPayment(subscription.id, {
            items: replacementItems(subscription, selection),
            proration_behavior: 'always_invoice',
        })
        return { trialEnded: false, switchAt: null, paymentClientSecret }
    }

    // The increases are billed first and alone: the rest of the change (the decreases, the schedule
    // of a switch at renewal) only follows once they are paid. A later update carrying `items` would
    // make Stripe drop a pending increase and void its invoice, so while the bank is asked the rest
    // waits in the pending update's metadata for `finishPendingPlanChange`.
    const { increases, decreases } = planItemChanges(subscription, selection.quantities)
    const finishesLater = decreases.length > 0 || kind === 'switch_at_renewal'
    let paymentClientSecret: string | null = null
    if (increases.length > 0) {
        await assertPaymentMethod(subscription)
        paymentClientSecret = await updateWithPayment(subscription.id, { items: increases, proration_behavior: 'always_invoice' }, finishesLater ? selection : null)
    }
    if (paymentClientSecret) return { trialEnded: false, switchAt: kind === 'same_interval' ? null : subscriptionPeriodEndIso(subscription), paymentClientSecret }

    const switchAt = await finishPlanChange(subscription, selection, { clearAfterPayment: finishesLater && increases.length > 0 })
    return { trialEnded: false, switchAt, paymentClientSecret: null }
}

// The rest of a change once its increase is paid: the decreases, billed to nobody, then the schedule
// of a yearly plan going monthly at its renewal. Runs at once when the card paid on the spot, from
// the webhook once the bank confirmed otherwise, and recomputes everything from the subscription it
// is given so a replay finds nothing left to do.
async function finishPlanChange(subscription: Stripe.Subscription, selection: PlanSelection, { clearAfterPayment }: { clearAfterPayment: boolean }): Promise<string | null> {
    const { decreases } = planItemChanges(subscription, selection.quantities)
    if (decreases.length > 0 || clearAfterPayment) {
        await stripe.subscriptions.update(subscription.id, {
            ...(decreases.length > 0 ? { items: decreases } : {}),
            proration_behavior: 'none',
            ...(clearAfterPayment ? { metadata: { [PLAN_CHANGE_AFTER_PAYMENT_KEY]: '' } } : {}),
        })
    }

    if (planChangeKind(subscription.status, intervalOfItems(subscription.items.data), selection.interval) !== 'switch_at_renewal') return null
    if (subscription.schedule) return subscriptionPeriodEndIso(subscription)
    const refreshed = await stripe.subscriptions.retrieve(subscription.id)
    return scheduleIntervalSwitch(refreshed, selection)
}

// `customer.subscription.pending_update_applied`: the increase the bank held is paid and on the
// subscription, so is the selection it was part of. The subscription is read again rather than
// taken from the event, whose snapshot would hide a schedule or a clearing a first delivery did.
export async function finishPendingPlanChange(subscription: Stripe.Subscription): Promise<void> {
    if (isTemplateSubscription(subscription)) return
    const live = await stripe.subscriptions.retrieve(subscription.id)
    const selection = parsePlanSelection(live.metadata?.[PLAN_CHANGE_AFTER_PAYMENT_KEY])
    if (!selection) return
    await finishPlanChange(live, selection, { clearAfterPayment: false })
    await stripe.subscriptions.update(live.id, { metadata: { [PLAN_CHANGE_AFTER_PAYMENT_KEY]: '' } })
}

async function assertPaymentMethod(subscription: Stripe.Subscription): Promise<void> {
    if (!(await subscriptionHasPaymentMethod(subscription))) throw new Error('Add a payment method first.')
}

async function assertTrialConvertible(subscription: Stripe.Subscription): Promise<void> {
    const state = trialConversionState(subscription, await subscriptionHasPaymentMethod(subscription))
    if (canEndTrialNow(state)) return
    if (state.status !== 'trialing') throw new Error('Your subscription is already active.')
    if (state.cancelAtPeriodEnd) throw new Error('Your subscription is set to cancel. Resume it first.')
    throw new Error('Add a payment method first.')
}

// A phase discount is written with exactly one reference: Stripe refuses a coupon and a promotion
// code side by side, and the discount already on the subscription is the one to reuse.
function scheduleDiscountParam(discount: Stripe.SubscriptionSchedule.Phase.Discount): Stripe.SubscriptionScheduleUpdateParams.Phase.Discount | null {
    // Stripe types the expanded `discount` as the phase discount itself, so the id is read untyped.
    const idOf = (ref: unknown): string | null => (typeof ref === 'string' ? ref : ref && typeof ref === 'object' && 'id' in ref && typeof ref.id === 'string' ? ref.id : null)
    const existing = idOf(discount.discount)
    if (existing) return { discount: existing }
    const promotionCode = idOf(discount.promotion_code)
    if (promotionCode) return { promotion_code: promotionCode }
    const coupon = idOf(discount.coupon)
    return coupon ? { coupon } : null
}

// A yearly plan moving to monthly keeps the year it paid for: a two-phase schedule runs the current
// items to the end of the period, then the monthly ones, and releases the subscription after one
// monthly cycle so it is a plain subscription again. Phase one is copied whole, discounts included,
// because a phase written without them drops them.
async function scheduleIntervalSwitch(subscription: Stripe.Subscription, selection: PlanSelection): Promise<string> {
    const schedule = await stripe.subscriptionSchedules.create({ from_subscription: subscription.id })
    const current = schedule.phases[0]
    if (!current) throw new Error('Could not read the current billing period.')

    await stripe.subscriptionSchedules.update(schedule.id, {
        end_behavior: 'release',
        phases: [
            {
                items: current.items.map(item => ({ price: typeof item.price === 'string' ? item.price : item.price.id, quantity: item.quantity })),
                discounts: (current.discounts ?? []).flatMap(discount => scheduleDiscountParam(discount) ?? []),
                start_date: current.start_date,
                end_date: current.end_date,
            },
            { items: planLineItems(selection, priceArmOfItems(subscription.items.data)), duration: { interval: 'month', interval_count: 1 }, proration_behavior: 'none' },
        ],
    })
    return new Date(current.end_date * 1000).toISOString()
}

// Any other change to the plan, a cancellation included, supersedes a switch waiting for the
// renewal: the schedule is released first, so the subscription takes direct updates again.
async function releasePendingSwitch(subscription: Stripe.Subscription): Promise<Stripe.Subscription> {
    if (!subscription.schedule) return subscription
    const scheduleId = typeof subscription.schedule === 'string' ? subscription.schedule : subscription.schedule.id
    await stripe.subscriptionSchedules.release(scheduleId)
    return stripe.subscriptions.retrieve(subscription.id)
}

async function readPendingSwitch(subscription: Stripe.Subscription): Promise<SubscriptionState['pendingSwitch']> {
    if (!subscription.schedule) return null
    const scheduleId = typeof subscription.schedule === 'string' ? subscription.schedule : subscription.schedule.id
    const schedule = await stripe.subscriptionSchedules.retrieve(scheduleId)
    const next = schedule.phases.find(phase => phase.start_date > Date.now() / 1000)
    if (!next) return null

    const quantities: AddonQuantities = { ...ZERO_QUANTITIES }
    let interval: BillingInterval = 'monthly'
    for (const item of next.items) {
        const priceId = typeof item.price === 'string' ? item.price : item.price.id
        if (isYearlyBasePriceId(priceId)) interval = 'yearly'
        const addon = addonForPriceId(priceId)
        if (addon) quantities[addon] += item.quantity ?? 0
    }
    return { selection: { quantities, interval }, at: new Date(next.start_date * 1000).toISOString() }
}

export async function cancelPendingSwitch(): Promise<void> {
    const { subscription } = await requireEditablePlanSubscription()
    await releasePendingSwitch(subscription)
}

// What the plan dialog quotes for a selection, read off the same items the change would send.
// null when nothing is charged today: a decrease, or a switch to monthly, both landing at renewal.
export type PlanQuote = PlanChangePreview & {
    kind: PlanChangeKind
    // The part of the current period given back on a switch to yearly, as a positive amount.
    unusedCreditCents: number
}

export async function previewPlanChange(selection: PlanSelection): Promise<PlanQuote | null> {
    assertValidSelection(selection)
    const { subscription } = await requireEditablePlanSubscription()
    const kind = planChangeKind(subscription.status, intervalOfItems(subscription.items.data), selection.interval)

    if (kind === 'end_trial' || kind === 'switch_now') {
        const invoice = await stripe.invoices.createPreview({
            subscription: subscription.id,
            subscription_details: {
                items: replacementItems(subscription, selection),
                proration_behavior: kind === 'end_trial' ? 'none' : 'always_invoice',
                ...(kind === 'end_trial' ? { trial_end: 'now' as const } : {}),
            },
        })
        const unusedCreditCents = -invoice.lines.data.filter(line => isProrationLine(line) && line.amount < 0).reduce((sum, line) => sum + line.amount, 0)
        return { ...trialEndPreview(invoice, subscription), kind, unusedCreditCents }
    }

    const preview = await previewSubscriptionUpdate(selection.quantities)
    return preview ? { ...preview, kind, unusedCreditCents: 0 } : null
}

export async function subscriptionHasPaymentMethod(subscription: Stripe.Subscription): Promise<boolean> {
    if (subscription.default_payment_method) return true
    const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id
    const customer = await stripe.customers.retrieve(customerId)
    return !customer.deleted && !!customer.invoice_settings?.default_payment_method
}

// --- Webhook-side helpers (no auth session; keyed off the Stripe event) ---

export async function findWorkspaceId(subscription: Stripe.Subscription): Promise<number | null> {
    const fromMeta = subscription.metadata?.workspace_id
    if (fromMeta && !Number.isNaN(Number(fromMeta))) return Number(fromMeta)

    const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id
    const supabase = createServiceRoleClient()
    const { data } = await selectMaybeSingle(supabase, 'workspaces', ['id'] as const, { stripe_customer_id: customerId })
    return data?.id ?? null
}

// Is this the subscription the workspace is billed on? A customer can carry several plan
// subscriptions — a renewal that failed keeps retrying for days while the user re-subscribes — and
// all of them resolve to the same workspace here. Only the one it holds may move its status, or a
// dead sibling's retries flip a paid workspace to past_due, and its cancellation switches the
// agents off.
async function ownsWorkspacePlan(workspaceId: number, subscription: Stripe.Subscription): Promise<boolean> {
    const supabase = createServiceRoleClient()
    const { data } = await selectMaybeSingle(supabase, 'workspaces', ['stripe_subscription_id'] as const, { id: workspaceId })
    const owns = isSameSubscription(data?.stripe_subscription_id, subscription.id)
    if (!owns) console.warn(`[billing] ignoring ${subscription.id} for workspace ${workspaceId}, which is billed on ${data?.stripe_subscription_id}`)
    return owns
}

// Checkout hands the collected card to the subscription it just created, and leaves the customer
// itself without a default. Anything else billed on that customer, a template sold as a monthly
// subscription first of all, then has no card to fall back on. So the plan checkout's card becomes
// the customer's default. Best effort: a failure here must not 500 the webhook into a retry loop.
export async function adoptCheckoutPaymentMethodAsDefault(session: Stripe.Checkout.Session, subscription: Stripe.Subscription): Promise<void> {
    try {
        const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id
        const paymentMethodId = await checkoutPaymentMethodId(session, subscription)
        if (!customerId || !paymentMethodId) return

        await stripe.customers.update(customerId, { invoice_settings: { default_payment_method: paymentMethodId } })
    } catch (err) {
        console.error('[billing] could not adopt the checkout card as the customer default', err)
    }
}

// A trialing subscription is paid for by a SetupIntent, not a PaymentIntent, and the subscription
// does not always carry the payment method by the time the session completes. The session is
// optional because `customer.subscription.created` carries none: there, the subscription's own
// default is all there is, and a null answer simply means "ask again on the checkout event".
export async function checkoutPaymentMethodId(session: Stripe.Checkout.Session | undefined, subscription: Stripe.Subscription): Promise<string | null> {
    const fromSubscription = subscription.default_payment_method
    if (fromSubscription) return typeof fromSubscription === 'string' ? fromSubscription : fromSubscription.id

    if (!session?.setup_intent) return null
    const setupIntentId = typeof session.setup_intent === 'string' ? session.setup_intent : session.setup_intent.id
    const setupIntent = await stripe.setupIntents.retrieve(setupIntentId)
    if (!setupIntent.payment_method) return null
    return typeof setupIntent.payment_method === 'string' ? setupIntent.payment_method : setupIntent.payment_method.id
}

// null = unlimited, so it wins any max.
function maxLimit(a: number | null, b: number | null): number | null {
    if (a === null || b === null) return null
    return Math.max(a, b)
}

type ExistingWorkspaceRow = {
    current_period_end: string | null
    subscription_status: string | null
    max_agents: number | null
    max_seats: number | null
    rerun_budget_micros: number
}

// Sync a Stripe subscription onto its workspace: derived limits + subscription state.
// Called by the webhook on create/update/checkout-completed.
//
// The limit columns are derived from the subscription's item quantities (base + add-ons).
// Mid-period the merge takes the max of the existing columns and the derived limits: an
// increase (billed immediately) lands instantly, while a decrease (no proration) is held —
// the user keeps what they paid for until the period advances, at which point the derived
// limits are written exactly and any pending downgrade lands.
//
// A workspace's Stripe customer also carries its template subscriptions, and findWorkspaceId falls
// back to `stripe_customer_id`, so anything that is not a plan has to bail before the update: this
// snapshot is the workspace's own billing state and a marketplace purchase has no business in it.
//
// `adopt` says whether this subscription may become the workspace's plan subscription when it is
// not already. True for a deliberate purchase (Checkout completed, subscription created); false for
// the lifecycle events of a subscription that merely shares the customer, which must never rewrite
// the snapshot of the one being billed.
export async function applySubscriptionToWorkspace(subscription: Stripe.Subscription, { adopt = true }: { adopt?: boolean } = {}): Promise<void> {
    if (isTemplateSubscription(subscription)) return

    const workspaceId = await findWorkspaceId(subscription)
    if (!workspaceId) return

    const { hasBase, quantities } = quantitiesFromItems(subscription.items?.data ?? [])
    // Belt and braces with the guard above: a subscription without the base plan item cannot be
    // allowed to rewrite the limit columns just because its metadata was empty.
    if (!hasBase) return

    const supabase = createServiceRoleClient()
    const newPeriodEnd = subscriptionPeriodEndIso(subscription)

    const { data: existing } = await selectMaybeSingle(
        supabase,
        'workspaces',
        ['current_period_end', 'subscription_status', 'stripe_subscription_id', 'max_agents', 'max_seats', 'rerun_budget_micros'] as const,
        { id: workspaceId },
    )

    if (!adopt && !shouldAdoptSubscription({ id: existing?.stripe_subscription_id, status: existing?.subscription_status }, subscription.id)) {
        console.warn(`[billing] ignoring ${subscription.id} for workspace ${workspaceId}, which is billed on ${existing?.stripe_subscription_id}`)
        return
    }

    const derived = quantitiesToColumns(quantities)
    const advanced = hasPeriodAdvanced(existing?.current_period_end, newPeriodEnd)
    const limits = advanced || !existing ? derived : mergeHeldLimits(existing, derived)

    const trialEndsAt = stripeTimestampIso(subscription.trial_end)
    const trialStartedAt = stripeTimestampIso(subscription.trial_start)
    const update: WorkspaceUpdate = {
        stripe_subscription_id: subscription.id,
        stripe_price_id: subscription.items.data.find(item => isBasePriceId(item.price?.id))?.price.id ?? basePriceId(),
        subscription_status: subscription.status,
        current_period_end: newPeriodEnd,
        // Always written, never spread conditionally: a cancellation withdrawn from the portal has
        // to clear this back to null, and it is the only signal the reminder ladder counts down
        // from. Stripe fills `cancel_at` when `cancel_at_period_end` is set, but not in every API
        // version, so the period end is the fallback.
        subscription_cancel_at: subscription.cancel_at ? stripeTimestampIso(subscription.cancel_at) : subscription.cancel_at_period_end ? newPeriodEnd : null,
        // Never cleared once set: non-null marks the workspace's one free trial as spent, which is
        // what gates the trial in createCheckoutSession.
        ...(trialEndsAt ? { trial_ends_at: trialEndsAt } : {}),
        // Stripe keeps trial_start where it was when extendTrial pushes trial_end back: the WhatsApp
        // trial sequence counts its days from here, never from trial_ends_at.
        ...(trialStartedAt ? { trial_started_at: trialStartedAt } : {}),
        plan: BASE_PLAN_SLUG,
        ...limits,
        // Spread, never Object.assign: assigning after the literal is what let these two columns
        // through unchecked, and one of them is the workspace's credit.
        ...rerunPeriodUpdate(advanced, subscription.status, new Date().toISOString()),
    }

    // A trial adds no monthly credit: it runs on the signup top-up. The budget is held where it was,
    // after the merge, otherwise the max would hand out the full plan budget. The derived budget
    // arrives on conversion, when this runs again with an entitled `active` status.
    //
    // This cannot swallow a credit pack the workspace paid for: checkout only ever sells the
    // bare base plan, and buying an add-on ends the trial (changePlan), so a `trialing`
    // subscription carries no credit pack. The one add-on it can carry is an app slot
    // (addTrialSlot), which buys no credit.
    if (subscription.status === 'trialing') update.rerun_budget_micros = existing?.rerun_budget_micros ?? 0

    // A trial runs TRIAL_ACTIVE_AGENTS, not the plan's count, and the column is what the gate reads.
    // Held past an advanced period too: extendTrial moves the period end, and a trial raised by hand
    // in the admin must keep its number until conversion writes the plan's.
    if (subscription.status === 'trialing') update.max_agents = maxLimit(existing?.max_agents ?? TRIAL_ACTIVE_AGENTS, TRIAL_ACTIVE_AGENTS)

    const { error } = await supabase.from('workspaces').update<WorkspaceUpdate>(update).eq('id', workspaceId)
    if (error) throw error

    await syncWorkspaceAppSlots(supabase, workspaceId, quantities, { periodAdvanced: advanced })

    // The held-limits merge means max_agents only ever falls when the period advances, so this is
    // exactly where a downgrade lands: whatever no longer fits is switched off, never deleted.
    await requestAgentActivationSync(await reconcileAgentActivation(workspaceId))

    // The other way round: a trial turning into a plan lifts its cap on active coworkers, and the
    // ones the cap had switched off come back on with it rather than waiting for a click each.
    if (existing?.subscription_status === 'trialing' && subscription.status === 'active') {
        const { woken } = await wakePlanLimitedAgents(workspaceId)
        await requestAgentActivationSync(woken, { switchOn: true })
    }

    // Starting a trial locks the premium models on the box, converting it unlocks them. Not awaited:
    // the box may be asleep, and a webhook that waits for it times out.
    void syncEnginePlan(workspaceId)

    await reportSubscriptionTransition(subscription, workspaceId, existing?.subscription_status ?? null)

    // Only the cardless trial is cancelled for a missing card: a Checkout trial always has one.
    if (subscription.status === 'trialing' && trialEndsAt) await sendTrialStartedReceipt(supabase, workspaceId, trialEndsAt, TRIAL_DAYS, subscription.trial_settings?.end_behavior?.missing_payment_method !== 'cancel')

    // Somebody who comes back should find their Box on, not wait for the next hourly sweep. A
    // no-op unless the teardown had powered it off.
    if (isMachineEntitled(subscription.status)) await requestBoxRestore(workspaceId)
}

/**
 * Stamps the moment a workspace first paid for its plan. This is the hard guardrail behind the
 * teardown: a workspace with `first_paid_at` set never has its Box deleted automatically, only
 * powered off. Only a real charge counts -- a `$0` invoice is the trial's own, and an `active`
 * status proves nothing on its own (a full-discount coupon reaches it without a payment).
 */
export async function stampFirstPlanPayment(invoice: Stripe.Invoice): Promise<void> {
    if (!invoice.amount_paid || invoice.amount_paid <= 0) return

    const subscription = await subscriptionOfInvoice(invoice)
    if (!subscription || isTemplateSubscription(subscription)) return

    const workspaceId = await findWorkspaceId(subscription)
    if (!workspaceId) return
    if (!(await ownsWorkspacePlan(workspaceId, subscription))) return

    const supabase = createServiceRoleClient()
    const { data: existing } = await selectMaybeSingle(supabase, 'workspaces', ['first_paid_at'] as const, { id: workspaceId })
    if (existing?.first_paid_at) return

    const { error } = await supabase.from('workspaces').update<WorkspaceUpdate>({ first_paid_at: new Date().toISOString() }).eq('id', workspaceId)
    if (error) throw error

    await reportTrialConverted(subscription, workspaceId)
}

function mergeHeldLimits(existing: ExistingWorkspaceRow, derived: WorkspaceLimitColumns): WorkspaceLimitColumns {
    return {
        ...derived,
        max_agents: maxLimit(existing.max_agents, derived.max_agents),
        max_seats: maxLimit(existing.max_seats, derived.max_seats),
        rerun_budget_micros: Math.max(existing.rerun_budget_micros ?? 0, derived.rerun_budget_micros),
    }
}

// Mark a workspace's subscription as canceled. Plan/limits are kept and nothing is deleted; what
// ends is the right to run, so every agent is switched off. Re-subscribing gives the slots back and
// the user picks which agents fill them.
export async function markSubscriptionCanceled(subscription: Stripe.Subscription): Promise<void> {
    if (isTemplateSubscription(subscription)) return
    const workspaceId = await findWorkspaceId(subscription)
    if (!workspaceId) return
    if (!(await ownsWorkspacePlan(workspaceId, subscription))) return
    const supabase = createServiceRoleClient()
    const { error } = await supabase.from('workspaces').update<WorkspaceUpdate>({ subscription_status: 'canceled' }).eq('id', workspaceId)
    if (error) throw error
    await requestAgentActivationSync(await reconcileAgentActivation(workspaceId))
    await reportSubscriptionCancelled(subscription, workspaceId)
}

// The invoice of a change held by `updateWithPayment` while the bank asks for 3-D Secure: Stripe
// sends `invoice.payment_failed` for it, yet the subscription is untouched and nothing is owed.
function awaitsPendingUpdatePayment(subscription: Stripe.Subscription, invoice: Stripe.Invoice): boolean {
    if (!subscription.pending_update) return false
    const latestInvoiceId = typeof subscription.latest_invoice === 'string' ? subscription.latest_invoice : subscription.latest_invoice?.id
    return !!invoice.id && latestInvoiceId === invoice.id
}

// Flag a workspace as past_due after a failed invoice payment. The subscription is kept, so Stripe's
// retries or a new card bring it back at the same price, and so is the machine for one more day:
// the teardown counts from `payment_failed_at` (PAYMENT_FAILED_GRACE_MS), and the owner is told
// here. Both happen on the first attempt only, so a retry neither restarts the day nor writes again.
export async function markSubscriptionPastDue(subscription: Stripe.Subscription, invoice: Stripe.Invoice): Promise<void> {
    if (isTemplateSubscription(subscription)) return
    if (awaitsPendingUpdatePayment(subscription, invoice)) return
    const workspaceId = await findWorkspaceId(subscription)
    if (!workspaceId) return
    if (!(await ownsWorkspacePlan(workspaceId, subscription))) return
    const supabase = createServiceRoleClient()
    const { data: existing } = await selectMaybeSingle(supabase, 'workspaces', ['subscription_status', 'first_paid_at'] as const, { id: workspaceId })
    const firstAttempt = invoice.attempt_count <= 1
    const { error } = await supabase
        .from('workspaces')
        .update<WorkspaceUpdate>({ subscription_status: 'past_due', ...(firstAttempt ? { payment_failed_at: new Date().toISOString() } : {}) })
        .eq('id', workspaceId)
    if (error) throw error
    if (existing?.subscription_status === 'trialing') await reportTrialPaymentFailed(subscription, workspaceId, invoice)
    if (firstAttempt) {
        await sendPaymentFailedNotice(supabase, workspaceId, {
            id: invoice.id ?? null,
            amountDueCents: invoice.amount_due,
            currency: invoice.currency,
            hostedUrl: invoice.hosted_invoice_url ?? null,
            firstCharge: !existing?.first_paid_at,
        })
    }
}
