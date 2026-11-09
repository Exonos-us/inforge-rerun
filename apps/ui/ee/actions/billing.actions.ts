'use server'

import type { Database } from '@/app/api/database.types'
import { actorFromContext } from '@/app/api/_auth/access'
import { requireAdminContext, requireWorkspaceContext, requireWorkspaceId } from '@/app/api/_auth/ownership'
import {
    CHARGE_REFUSED_MESSAGE,
    acceptPlanTerms,
    cancelPendingSwitch,
    cancelSubscription,
    changePlan,
    claimRetentionOffer,
    completeCardSetupSession,
    createPlanCardSetupSession,
    createPlanCheckoutSession,
    listInvoices,
    previewPlanChange,
    removeTaxId,
    saveBusinessDetails,
    type BusinessDetails,
    updatePlanCheckoutSession,
    type InvoiceSummary,
    type PlanChangeResult,
    type PlanCheckoutSession,
    type PlanQuote,
    type PlanSelection,
    getCancelFlowState,
    getSubscriptionState,
    readCheckoutOutcome,
    requestRenewalReminder,
    resumeSubscription,
    startCardlessTrial,
    PLAN_CARD_SETUP_KIND,
    type CancelFlowState,
    type CheckoutOutcome,
    type SubscriptionState,
} from '@/ee/services/billing.service'
import { loadCancelFlowActivity, type CancelFlowActivity } from '@/ee/services/cancel-flow-activity.service'
import { getCreditUsage } from '@/ee/services/credit-usage.service'
import { markPaymentMethodAdded } from '@/app/api/_services/getting-started.service'
import { CANCEL_COMEBACKS, cancelReasonTextSchema, type CancelReason, type RetentionOfferKind } from '@/ee/lib/billing/cancel-flow'
import { readCancelReason } from '@/ee/lib/billing/read-cancel-reason'
import type { CreditUsage } from '@/ee/lib/billing/credit-usage'
import { BILLING_INTERVALS } from '@/ee/lib/billing/plans'
import { stripe } from '@/ee/lib/billing/stripe'
import type { TaxIdType } from '@/ee/lib/billing/tax-id'
import { z } from 'zod'

const sessionIdSchema = z.string().trim().min(1).max(200)

const requireBillingAdmin = () => requireAdminContext('Only an admin can manage billing')

const planSelectionSchema = z.object({
    quantities: z.object({ credit_pack: z.number().int().min(0).max(1000), linkedin_slot: z.number().int().min(0).max(1000), whatsapp_slot: z.number().int().min(0).max(1000) }),
    interval: z.enum(BILLING_INTERVALS),
})

function failure(err: unknown, fallback: string): { ok: false; error: string } {
    return { ok: false, error: err instanceof Error ? err.message : fallback }
}

// What an embedded checkout ended up doing to the workspace. The widget polls this beside the
// realtime workspace row: the row is faster when the webhook lands, this is the one that can say
// "the trial was refused" rather than leaving the widget waiting forever.
export async function readCheckoutOutcomeAction(sessionId: string): Promise<{ ok: true; outcome: CheckoutOutcome } | { ok: false; error: string }> {
    try {
        const outcome = await readCheckoutOutcome(z.string().trim().min(1).max(200).parse(sessionId))
        return { ok: true, outcome }
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'Failed to read this checkout' }
    }
}

// The trial the cardless arm of the trial test starts from the offer card, without a card. `entitled:
// false` is not an error: the workspace simply goes through the card checkout instead.
export async function startTrialAction(): Promise<{ ok: true; entitled: boolean } | { ok: false; error: string }> {
    try {
        await requireBillingAdmin()
        return { ok: true, entitled: await startCardlessTrial() }
    } catch (err) {
        return failure(err, 'Failed to start the trial')
    }
}

// What follows a completed setup session: the card is attached to the subscription, and a pay-now
// session converts the trial on the spot, while a card-only one leaves the trial running. The
// session id comes from the client, so the session must prove it belongs to the caller.
export async function confirmCardSetupAction(sessionId: string): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
        const { workspace } = await requireBillingAdmin()
        const workspaceId = workspace.id
        const session = await stripe.checkout.sessions.retrieve(z.string().trim().min(1).max(200).parse(sessionId))
        if (session.metadata?.kind !== PLAN_CARD_SETUP_KIND) throw new Error('Not a card setup session.')
        if (session.metadata?.workspace_id !== String(workspaceId)) throw new Error('This session belongs to another workspace.')
        if (session.status !== 'complete') throw new Error('The card form was not completed.')
        await completeCardSetupSession(session)
        await markPaymentMethodAdded(workspaceId)
        return { ok: true }
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'Failed to save your card' }
    }
}






// Live subscription state for the billing dialog: paid add-on quantities plus any
// downgrade pending until the next renewal. null when the workspace has no plan
// subscription yet.
export async function getSubscriptionStateAction(): Promise<{ ok: true; state: SubscriptionState | null } | { ok: false; error: string }> {
    try {
        return { ok: true, state: await getSubscriptionState() }
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'Failed to load subscription' }
    }
}

// What the cancel dialog quotes: dates, the share of the month already paid, and the retention
// offer if this workspace can still have it.
export async function getCancelFlowStateAction(): Promise<{ ok: true; state: CancelFlowState } | { ok: false; error: string }> {
    try {
        return { ok: true, state: await getCancelFlowState() }
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'Failed to load your subscription' }
    }
}

// The agents and their runs, read off the workspace's engine. Best effort: null when the machine
// does not answer, and the dialog simply leaves those figures out.
export async function getCancelFlowActivityAction(): Promise<{ ok: true; activity: CancelFlowActivity | null } | { ok: false; error: string }> {
    try {
        return { ok: true, activity: await loadCancelFlowActivity(await requireWorkspaceId()) }
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'Failed to load your coworkers' }
    }
}

// Whether what the customer wrote reads as a reason, and which one. A model that does not answer
// lets them through: the dialog counts the refusals and stops refusing, this never holds anyone.
export async function checkCancelReasonAction(text: string): Promise<{ ok: true; genuine: boolean; reason: CancelReason } | { ok: false; error: string }> {
    try {
        await requireBillingAdmin()
        const reading = await readCancelReason(cancelReasonTextSchema.parse(text))
        return { ok: true, genuine: reading?.genuine ?? true, reason: reading?.reason ?? 'other' }
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'Failed to read your answer' }
    }
}

const cancelInputSchema = z.object({
    comeback: z.enum(CANCEL_COMEBACKS),
    comment: cancelReasonTextSchema,
})

// The text is read again here rather than trusting the dialog with its own verdict, and whatever
// the reading says the cancellation goes through: it only decides how the answer is filed.
export async function cancelSubscriptionAction(input: z.input<typeof cancelInputSchema>): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
        await requireBillingAdmin()
        const parsed = cancelInputSchema.parse(input)
        const reading = await readCancelReason(parsed.comment)
        await cancelSubscription({ ...parsed, reason: reading?.reason ?? 'other', check: reading ? (reading.genuine ? 'genuine' : 'rejected') : 'unchecked' })
        return { ok: true }
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'Failed to cancel your subscription' }
    }
}

export async function resumeSubscriptionAction(): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
        await requireBillingAdmin()
        await resumeSubscription()
        return { ok: true }
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'Failed to resume your subscription' }
    }
}

export async function claimRetentionOfferAction(): Promise<{ ok: true; offer: RetentionOfferKind } | { ok: false; error: string }> {
    try {
        await requireBillingAdmin()
        return { ok: true, offer: await claimRetentionOffer() }
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'Failed to apply the offer' }
    }
}

export async function requestRenewalReminderAction(): Promise<{ ok: true; reminderAt: string } | { ok: false; error: string }> {
    try {
        await requireBillingAdmin()
        return { ok: true, reminderAt: await requestRenewalReminder() }
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'Failed to set the reminder' }
    }
}

// --- The plan dialogs ---

// The plan Checkout rendered by the dialog itself. On a card trial the server sells the base plan
// monthly whatever the selection says, and `trial` tells the dialog so.
export async function createPlanCheckoutAction(selection: PlanSelection): Promise<({ ok: true } & PlanCheckoutSession) | { ok: false; error: string }> {
    try {
        await requireBillingAdmin()
        return { ok: true, ...(await createPlanCheckoutSession(planSelectionSchema.parse(selection))) }
    } catch (err) {
        return failure(err, 'Failed to start checkout')
    }
}

// Called through the Checkout client's `runServerUpdate`, which reloads the session afterwards.
export async function updatePlanCheckoutAction(sessionId: string, selection: PlanSelection): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
        await requireBillingAdmin()
        await updatePlanCheckoutSession(sessionIdSchema.parse(sessionId), planSelectionSchema.parse(selection))
        return { ok: true }
    } catch (err) {
        return failure(err, 'Failed to update your plan')
    }
}

export async function acceptPlanTermsAction(sessionId: string): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
        await requireBillingAdmin()
        await acceptPlanTerms(sessionIdSchema.parse(sessionId))
        return { ok: true }
    } catch (err) {
        return failure(err, 'Failed to record your acceptance')
    }
}

// The card form of the plan dialogs: the card goes on file, or settles a failed payment. Completed
// through confirmCardSetupAction; a trial paying today then runs the plan change from the dialog.
export async function createPlanCardSetupAction(): Promise<{ ok: true; clientSecret: string; sessionId: string } | { ok: false; error: string }> {
    try {
        await requireBillingAdmin()
        return { ok: true, ...(await createPlanCardSetupSession()) }
    } catch (err) {
        return failure(err, 'Failed to open the card form')
    }
}

export async function previewPlanChangeAction(selection: PlanSelection): Promise<{ ok: true; quote: PlanQuote | null } | { ok: false; error: string }> {
    try {
        return { ok: true, quote: await previewPlanChange(planSelectionSchema.parse(selection)) }
    } catch (err) {
        return failure(err, 'Failed to preview your plan change')
    }
}

export async function changePlanAction(selection: PlanSelection): Promise<({ ok: true } & PlanChangeResult) | { ok: false; error: string }> {
    try {
        await requireBillingAdmin()
        return { ok: true, ...(await changePlan(planSelectionSchema.parse(selection))) }
    } catch (err) {
        return { ok: false, error: planChargeErrorMessage(err) }
    }
}

// The service already words a declined charge for the customer. Stripe's own wording is for
// developers except on a card error, so anything else Stripe throws reaches the customer as one
// readable line and the log keeps the rest.
function planChargeErrorMessage(err: unknown): string {
    const stripeError = err as { type?: string; code?: string; message?: string } | null
    if (!stripeError?.type?.startsWith('Stripe')) return err instanceof Error ? err.message : 'Failed to change your plan'
    if (stripeError.type === 'StripeCardError' && !stripeError.code?.startsWith('subscription_') && stripeError.message) return stripeError.message
    console.error('[billing] plan change refused by Stripe', err)
    return CHARGE_REFUSED_MESSAGE
}

export async function cancelPendingSwitchAction(): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
        await requireBillingAdmin()
        await cancelPendingSwitch()
        return { ok: true }
    } catch (err) {
        return failure(err, 'Failed to keep your yearly plan')
    }
}

// Where the workspace's Rerun credit went this period, for the billing dialog.
export async function getCreditUsageAction(): Promise<{ ok: true; usage: CreditUsage } | { ok: false; error: string }> {
    try {
        const ctx = await requireWorkspaceContext()
        return { ok: true, usage: await getCreditUsage(ctx.supabase, actorFromContext(ctx)) }
    } catch (err) {
        return failure(err, 'Failed to load your credit usage')
    }
}

// An admin can pause the Rerun credit, and resume it: while it is paused the hub refuses every Rerun
// model and paid data call, so nothing is spent without someone turning it back on.
export async function setRerunCreditPausedAction(paused: boolean): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
        const { workspace, supabase } = await requireBillingAdmin()
        const { error } = await supabase
            .from('workspaces')
            .update<Database['public']['Tables']['workspaces']['Update']>({ rerun_credit_paused_at: paused ? new Date().toISOString() : null })
            .eq('id', workspace.id)
        if (error) return { ok: false, error: error.message }
        return { ok: true }
    } catch (err) {
        return failure(err, paused ? 'Failed to pause Rerun credits' : 'Failed to resume Rerun credits')
    }
}

export async function listInvoicesAction(): Promise<{ ok: true; invoices: InvoiceSummary[] } | { ok: false; error: string }> {
    try {
        return { ok: true, invoices: await listInvoices() }
    } catch (err) {
        return failure(err, 'Failed to load your invoices')
    }
}

// The type is only shaped here: the service checks it against the billing country.
const businessDetailsSchema = z.object({
    name: z.string().trim().min(1, 'Enter the business name').max(256),
    type: z.string().regex(/^[a-z]{2}_[a-z_]+$/),
    value: z.string().trim().min(1, 'Enter the number').max(64),
})

export async function saveBusinessDetailsAction(input: z.input<typeof businessDetailsSchema>): Promise<{ ok: true; business: BusinessDetails } | { ok: false; error: string }> {
    try {
        await requireBillingAdmin()
        const parsed = businessDetailsSchema.safeParse(input)
        if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid business details' }
        return { ok: true, business: await saveBusinessDetails({ ...parsed.data, type: parsed.data.type as TaxIdType }) }
    } catch (err) {
        return failure(err, 'Failed to save your business details')
    }
}

export async function removeTaxIdAction(): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
        await requireBillingAdmin()
        await removeTaxId()
        return { ok: true }
    } catch (err) {
        return failure(err, 'Failed to remove the number')
    }
}
