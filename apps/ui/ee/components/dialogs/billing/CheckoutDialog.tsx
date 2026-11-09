'use client'

import { APP_INFO } from '@/lib/apps/catalog'
import { APP_ADDON_KEYS, APP_SLUGS } from '@/lib/apps/types'
import { useCheckout } from '@stripe/react-stripe-js/checkout'
import type { StripeExpressCheckoutElementConfirmEvent } from '@stripe/stripe-js'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { toast } from 'sonner'

import {
    acceptPlanTermsAction,
    confirmCardSetupAction,
    createPlanCardSetupAction,
    createPlanCheckoutAction,
    readCheckoutOutcomeAction,
    resumeSubscriptionAction,
    updatePlanCheckoutAction,
} from '@/ee/actions/billing.actions'
import { runPlanChange } from '@/ee/lib/billing/plan-payment'
import type { PlanSelection, SubscriptionState } from '@/ee/services/billing.service'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useWorkspaceAccess } from '@/hooks/useWorkspaceAccess'
import type { CheckoutRoute } from '@/ee/lib/billing/checkout-variant'
import { isSubscriptionEntitled } from '@/ee/lib/billing/entitlement'
import { PLAN_PRICES_CENTS, TRIAL_DAYS, ZERO_QUANTITIES, planPriceCents, trialEndDate, trialLimitsLabel, type AddonQuantities, type BillingInterval, type PriceArm } from '@/ee/lib/billing/plans'
import { usePriceArm } from '@/ee/lib/billing/usePriceArm'
import { TRIAL_ENDING_LEAD_MS } from '@/ee/lib/lifecycle/sequences'
import { useStartPending } from '@/lib/onboarding/useStartPending'
import { AGENT_LIMIT_TRIGGER, useBillingStore } from '@/stores/billing.store'
import { useForemanStore } from '@/stores/foreman.store'
import { hasPendingStart, useOnboardingStore } from '@/stores/onboarding.store'
import { useSession } from '@/supabase/session/SessionProvider'

import { BillingDialogShell } from './BillingDialogShell'
import { CreditCard } from './credit-usage/CreditCard'
import { UsagePane } from './credit-usage/UsagePane'
import { useCreditUsage } from './credit-usage/useCreditUsage'
import { checkoutCopy, longDate, nextInvoiceDate, shortDate, type CheckoutContext } from './checkout-copy'
import { BilledFlow, CardOnFile, Headline, IntervalToggle, PayFooter, PayHeader, PlanCard, RightTitle, SuccessPanel, SummaryRows, TermsConsent, TestimonialStrip, Timeline, UsdFlow, usd } from './parts'
import { StripeCheckoutProvider, StripePaymentFields, StripePaymentFieldsSkeleton, StripePromoCode } from './StripeCheckout'
import { usePlanQuote } from './usePlanQuote'

// The yearly price is what the dialog opens on, as designed; the toggle is one click away. Not during
// a trial: subscribing ends it and bills today, and a year upfront is not what a trial user expects.
const DEFAULT_INTERVAL: BillingInterval = 'yearly'
const OUTCOME_POLL_MS = 2_000
const OUTCOME_TIMEOUT_MS = 30_000
const SELECTION_DEBOUNCE_MS = 250

type Done = 'paid' | 'card_saved' | 'trial_started' | 'restoring'

const DAY_MS = 86_400_000

// A plan already running keeps its add-ons: an app slot put on during the trial would otherwise be
// dropped by the change that ends it.
function selectionOf(interval: BillingInterval, current?: AddonQuantities): PlanSelection {
    return { quantities: current ?? ZERO_QUANTITIES, interval }
}

function billedLabel(interval: BillingInterval, priceArm: PriceArm): string {
    return `${usd(planPriceCents(ZERO_QUANTITIES, interval, priceArm))}${interval === 'yearly' ? '/yr' : '/mo'}`
}

// A year from now reads with its year: "Oct 2" alone would read as today.
function invoiceDateLabel(interval: BillingInterval): string {
    const date = nextInvoiceDate(interval)
    return interval === 'yearly' ? longDate(date) : shortDate(date)
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : 'Something went wrong'
}

export function CheckoutDialog({
    route,
    state,
    onClose,
    onCancelTrial,
    onChanged,
    onTrialRefused,
}: {
    route: CheckoutRoute
    state: SubscriptionState | null
    onClose: () => void
    onCancelTrial: () => void
    onChanged: () => void
    onTrialRefused: () => void
}) {
    const { workspace, refreshWorkspace } = useSession()
    const { keptUntil } = useWorkspaceAccess()
    const parkedTemplate = useOnboardingStore(s => s.pendingTemplate)
    const parked = useOnboardingStore(s => hasPendingStart(s))
    const startPending = useStartPending()
    // A subscription keeps the price it was sold at; before there is one, the workspace's arm prices it.
    const workspacePriceArm = usePriceArm()
    const priceArm = state?.priceArm ?? workspacePriceArm

    const fixedPlan = route.variant === 'start_trial'
    const [interval, setBillingInterval] = useState<BillingInterval>(fixedPlan || workspace?.subscription_status === 'trialing' ? 'monthly' : DEFAULT_INTERVAL)
    const [done, setDone] = useState<Done | null>(null)
    const [placing, setPlacing] = useState(false)
    // Sent here by the trial's coworker cap: what lifts it is paying now, so the dialog opens on that.
    const [payNow, setPayNow] = useState(() => route.variant === 'trial_card' && useBillingStore.getState().trigger === AGENT_LIMIT_TRIGGER)
    const [usageOpen, setUsageOpen] = useState(false)
    const credit = useCreditUsage({ enabled: workspace?.subscription_status === 'trialing' })
    const [openedAt] = useState(() => Date.now())

    // A card trial opens on the trial itself, nothing due today: paying before its end is one step further.
    const trialView = route.variant === 'trial_card' && !payNow
    const planFixed = fixedPlan || trialView
    const trialEndsAt = workspace?.trial_ends_at ? new Date(workspace.trial_ends_at) : null
    const reminderAt = trialEndsAt ? new Date(trialEndsAt.getTime() - TRIAL_ENDING_LEAD_MS) : null
    const firstChargeCents = state?.nextInvoice?.amountCents ?? planPriceCents(state?.quantities ?? ZERO_QUANTITIES, state?.interval ?? 'monthly', priceArm)
    const startTrialEnds = trialEndDate(new Date(openedAt))
    const context: CheckoutContext = {
        billed: <BilledFlow cents={planPriceCents(ZERO_QUANTITIES, interval, priceArm)} interval={interval} />,
        nextInvoice: invoiceDateLabel(interval),
        trialEnds: route.variant === 'start_trial' ? shortDate(startTrialEnds) : trialEndsAt ? shortDate(trialEndsAt) : null,
        trialDaysLeft: trialEndsAt ? Math.ceil((trialEndsAt.getTime() - openedAt) / DAY_MS) : null,
        reminderOn: reminderAt && reminderAt.getTime() > openedAt ? shortDate(reminderAt) : null,
        firstCharge: usd(firstChargeCents),
        trialCancelled: !!state?.cancelAtPeriodEnd,
        keptUntil: keptUntil ? longDate(keptUntil) : null,
        parked: parkedTemplate ? { title: parkedTemplate.title, agentCount: parkedTemplate.agentCount } : null,
    }
    const copy = checkoutCopy(route.variant === 'trial_card' && payNow ? 'trial_card_pay_now' : route.variant, context)
    const selection = selectionOf(interval, state?.quantities)

    // On a trial, more credit comes with Pro: the card's button leads to paying now, or back to the
    // pane that already sells it.
    const startProNow = () => {
        setUsageOpen(false)
        if (route.variant === 'trial_card') setPayNow(true)
    }

    const finish = async (outcome: Done) => {
        await refreshWorkspace()
        onChanged()
        // Arrived on a template or a shared coworker: the column installs it the moment the plan is
        // on, so the dialog gets out of the way instead of asking for a click that starts nothing.
        if (useForemanStore.getState().arrival) return onClose()
        setDone(outcome)
    }

    const intro = <Headline badge={copy.badge} title={copy.title} subtitle={copy.subtitle} />
    const left = (
        <>
            <Timeline steps={copy.timeline} />
            <div className="mt-6 mb-4 flex flex-col gap-3">
                {!planFixed && <IntervalToggle value={interval} onChange={setBillingInterval} disabled={!!done} />}
                <PlanCard interval={planFixed ? 'monthly' : interval} priceArm={priceArm} freeTrial={planFixed} />
                {credit.trial && <CreditCard credit={credit} onAdd={startProNow} onOpenUsage={done ? undefined : () => setUsageOpen(true)} />}
            </div>
            <TestimonialStrip />
        </>
    )

    if (done) {
        const entitled = isSubscriptionEntitled(workspace?.subscription_status)
        const placeLabel = parkedTemplate ? (parkedTemplate.agentCount > 1 ? `Place ${parkedTemplate.agentCount} coworkers` : 'Place it on my board') : 'Start my coworker'
        const onDone = async () => {
            if (!parked) return onClose()
            setPlacing(true)
            try {
                await startPending()
                onClose()
            } finally {
                setPlacing(false)
            }
        }
        const success = successCopy(done, { interval, priceArm, trialEnds: context.trialEnds, firstCharge: context.firstCharge })
        return (
            <BillingDialogShell
                title={success.title}
                mobileOrder="payment-first"
                intro={intro}
                left={left}
                right={<SuccessPanel {...success} cta={parked ? placeLabel : success.cta} onDone={() => void onDone()} loading={placing || (parked && !entitled)} />}
            />
        )
    }

    const right = (() => {
        if (usageOpen) return <UsagePane credit={credit} onBack={() => setUsageOpen(false)} backLabel={trialView ? 'Trial' : 'Back'} />
        switch (route.payment) {
            case 'subscribe':
                return <SubscribePane key={route.variant} selection={selection} priceArm={priceArm} copy={copy} onDone={trialStarted => void finish(route.variant === 'paused' ? 'restoring' : trialStarted ? 'trial_started' : 'paid')} onTrialRefused={onTrialRefused} />
            case 'card_form':
                return <CardFormPane selection={selection} priceArm={priceArm} copy={copy} trialEnds={context.trialEnds} onDone={outcome => void finish(outcome)} />
            case 'card_on_file':
                if (trialView) return <TrialPane state={state} copy={copy} trialEnds={context.trialEnds} reminderOn={context.reminderOn} firstCharge={context.firstCharge} onContinue={onClose} onCancelTrial={onCancelTrial} onPayNow={() => setPayNow(true)} onResumed={onChanged} />
                return (
                    <CardOnFilePane
                        selection={selection}
                        priceArm={priceArm}
                        state={state}
                        copy={copy}
                        trialEnds={context.trialEnds}
                        onBack={route.variant === 'trial_card' ? () => setPayNow(false) : undefined}
                        onDone={() => void finish('paid')}
                        onCancelTrial={onCancelTrial}
                        onResumed={onChanged}
                    />
                )
        }
    })()

    return <BillingDialogShell title={copy.title} mobileOrder={planFixed ? 'payment-first' : 'plan-first'} intro={intro} left={left} right={right} />
}

function successCopy(done: Done, { interval, priceArm, trialEnds, firstCharge }: { interval: BillingInterval; priceArm: PriceArm; trialEnds: string | null; firstCharge: string }) {
    const next = `${invoiceDateLabel(interval)} · ${billedLabel(interval, priceArm)}`
    const planRows = [
        { label: 'Plan', value: 'Pro · Unlimited coworkers' },
        { label: 'Next invoice', value: next },
    ]
    switch (done) {
        case 'paid':
            return { title: "You're on Pro", body: 'Your receipt is on its way by email.', rows: planRows, cta: 'Back to my board' }
        case 'card_saved':
            return {
                title: 'Card saved',
                body: `Your trial keeps running. Pro starts on ${trialEnds ?? 'the last day of your trial'}, ${firstCharge} charged to this card.`,
                rows: [{ label: 'Plan', value: 'Pro · Unlimited coworkers' }],
                cta: 'Back to my board',
            }
        case 'trial_started':
            return { title: 'Your trial is on', body: `Nothing charged today. ${firstCharge} on ${trialEnds ?? 'the last day of your trial'} unless you cancel before.`, cta: 'Build my coworkers' }
        case 'restoring':
            return { title: 'Welcome back', body: 'Your workspace is being restored. Your coworkers wake up in about a minute.', rows: planRows, cta: 'Back to my board' }
    }
}

type PaneCopy = { cta: string; footnote?: string }

// --- A new subscription: the plan Checkout, the card form in this column ---

type SessionState = { clientSecret: string; sessionId: string } | { error: string } | null

// The server decides whether the session carries the trial, so "$0 due today" is read off the session
// it created rather than off the variant the browser guessed.
type PlanSessionState = { clientSecret: string; sessionId: string; trial: boolean } | { error: string } | null

function SubscribePane({ selection, priceArm, copy, onDone, onTrialRefused }: { selection: PlanSelection; priceArm: PriceArm; copy: PaneCopy; onDone: (trialStarted: boolean) => void; onTrialRefused: () => void }) {
    const [session, setSession] = useState<PlanSessionState>(null)
    const [sessionSelection] = useState(selection)

    useEffect(() => {
        let cancelled = false
        createPlanCheckoutAction(sessionSelection).then(result => {
            if (cancelled) return
            setSession(result.ok ? { clientSecret: result.clientSecret, sessionId: result.sessionId, trial: result.trial } : { error: result.error })
        })
        return () => {
            cancelled = true
        }
    }, [sessionSelection])

    if (!session) return <PaneSkeleton />
    if ('error' in session) return <PaneError message={session.error} />

    return (
        <StripeCheckoutProvider clientSecret={session.clientSecret}>
            <SubscribeForm sessionId={session.sessionId} sessionSelection={sessionSelection} selection={selection} priceArm={priceArm} trial={session.trial} copy={copy} onDone={() => onDone(session.trial)} onTrialRefused={onTrialRefused} />
        </StripeCheckoutProvider>
    )
}

function SubscribeForm({
    sessionId,
    sessionSelection,
    selection,
    priceArm,
    trial,
    copy,
    onDone,
    onTrialRefused,
}: {
    sessionId: string
    // The selection the session was created with: anything picked since is still to be sent.
    sessionSelection: PlanSelection
    selection: PlanSelection
    priceArm: PriceArm
    trial: boolean
    copy: PaneCopy
    onDone: () => void
    onTrialRefused: () => void
}) {
    const checkout = useCheckout()
    const [accepted, setAccepted] = useState(false)
    const [recordingTerms, setRecordingTerms] = useState(false)
    const [submitting, setSubmitting] = useState(false)
    const [updating, setUpdating] = useState(false)
    const [error, setError] = useState<ReactNode>(null)
    const [syncedKey, setSyncedKey] = useState(() => JSON.stringify(sessionSelection))
    const [failedKey, setFailedKey] = useState<string | null>(null)
    const inFlight = useRef<string | null>(null)
    const key = JSON.stringify(selection)
    const stale = syncedKey !== key

    // The interval toggle moves the session's line items; Stripe recomputes the totals and
    // `runServerUpdate` reloads them. A selection counts as synced only once Stripe has it: until then
    // the pay button stays off, so what is confirmed is always what is shown. `runServerUpdate`
    // hands back a new `checkout` mid-flight, which re-runs this effect: the in-flight guard keeps it
    // from sending the same selection twice, and `updating` in the deps lets a selection moved
    // during the flight go out once it lands. A failed selection waits for a retry or a new one.
    useEffect(() => {
        if (trial || checkout.type !== 'success' || !stale || failedKey === key || inFlight.current) return
        const timer = setTimeout(async () => {
            inFlight.current = key
            setUpdating(true)
            const result = await checkout.checkout.runServerUpdate(async () => {
                const update = await updatePlanCheckoutAction(sessionId, JSON.parse(key) as PlanSelection)
                if (!update.ok) throw new Error(update.error)
            })
            inFlight.current = null
            setUpdating(false)
            if (result.type === 'error') {
                setFailedKey(key)
                setError(
                    <>
                        {result.error.message}{' '}
                        <button type="button" onClick={() => setFailedKey(null)} className="text-foreground underline underline-offset-4">
                            Try again
                        </button>
                    </>,
                )
            } else {
                setSyncedKey(key)
                setError(null)
            }
        }, SELECTION_DEBOUNCE_MS)
        return () => clearTimeout(timer)
    }, [key, stale, failedKey, updating, trial, checkout, sessionId])

    const loaded = checkout.type === 'success' ? checkout.checkout : null
    const interval = selection.interval
    const amount = trial ? usd(0) : <UsdFlow cents={loaded?.total.total.minorUnitsAmount ?? planPriceCents(selection.quantities, interval, priceArm)} />
    // The price after the trial follows a promotion code; without one it stays the list price.
    const nextInvoice = loaded?.discountAmounts?.length ? loaded.recurring?.dueNext : null
    const afterTrialCents = nextInvoice ? Math.max(0, nextInvoice.subtotal.minorUnitsAmount - nextInvoice.discount.minorUnitsAmount) : planPriceCents(selection.quantities, 'monthly', priceArm)

    // Recorded when the box is ticked, never on the pay click: Safari only opens the Apple Pay sheet
    // inside the tap itself, so nothing may be awaited between that tap and `confirm`.
    const acceptTerms = async (checked: boolean) => {
        setAccepted(checked)
        if (!checked) return
        setRecordingTerms(true)
        setError(null)
        const terms = await acceptPlanTermsAction(sessionId)
        setRecordingTerms(false)
        if (terms.ok) return
        setAccepted(false)
        setError(terms.error)
    }

    const pay = async (expressCheckoutConfirmEvent?: StripeExpressCheckoutElementConfirmEvent) => {
        if (!loaded || submitting) return
        setSubmitting(true)
        setError(null)
        try {
            const result = await loaded.confirm({ redirect: 'if_required', expressCheckoutConfirmEvent })
            if (result.type === 'error') throw new Error(result.error.message)

            const outcome = await awaitOutcome(sessionId)
            if (outcome === 'trial_refused') {
                toast.error('This card already had a free trial', { description: 'You can still subscribe, billed today.' })
                onTrialRefused()
                return
            }
            onDone()
        } catch (err) {
            setError(errorMessage(err))
        } finally {
            setSubmitting(false)
        }
    }

    const blockedReason = !accepted ? 'Accept the terms first' : failedKey === key ? 'Your plan could not be updated' : stale ? 'Your plan is still updating' : undefined
    const walletBlocked = !loaded || submitting || updating || stale || !accepted || recordingTerms

    return (
        <>
            <PayHeader title={trial ? `Rerun Pro, free for ${TRIAL_DAYS} days` : 'Subscribe to Rerun Pro'} amount={amount} unit={trial ? 'due today' : interval === 'yearly' ? 'per year' : 'per month'} />
            {trial && (
                <p className="mt-2 text-sm text-muted-foreground">
                    Then <UsdFlow cents={afterTrialCents} /> per month, excl. VAT.
                </p>
            )}
            <div className="mt-4 flex flex-col">
                <StripePromoCode disabled={submitting || updating} />
            </div>
            <div className="mt-4">
                <StripePaymentFields wallet={{ onConfirm: event => void pay(event), disabledReason: walletBlocked ? (blockedReason ?? 'Please wait') : undefined }} />
            </div>
            <PayFooter
                cta={copy.cta}
                footnote={copy.footnote ?? 'By subscribing, you authorize Rerun to charge you until you cancel.'}
                onClick={() => void pay()}
                loading={submitting}
                disabled={walletBlocked || !loaded?.canConfirm}
                disabledReason={blockedReason}
                error={error}
            >
                <TermsConsent checked={accepted} onChange={checked => void acceptTerms(checked)} />
            </PayFooter>
        </>
    )
}

// The webhook writes the entitlement, so a confirmed payment is followed by a read until it lands.
// Past the timeout the payment went through all the same: the board catches up through realtime.
async function awaitOutcome(sessionId: string): Promise<'entitled' | 'trial_refused' | 'pending'> {
    const deadline = Date.now() + OUTCOME_TIMEOUT_MS
    while (Date.now() < deadline) {
        const result = await readCheckoutOutcomeAction(sessionId)
        if (result.ok && result.outcome.state !== 'pending') return result.outcome.state
        await new Promise(resolve => setTimeout(resolve, OUTCOME_POLL_MS))
    }
    return 'pending'
}

// --- A trial without a card: the card form, then paying now or at the end of the trial ---

function CardFormPane({ selection, priceArm, copy, trialEnds, onDone }: { selection: PlanSelection; priceArm: PriceArm; copy: PaneCopy; trialEnds: string | null; onDone: (outcome: 'paid' | 'card_saved') => void }) {
    const [session, setSession] = useState<SessionState>(null)

    useEffect(() => {
        let cancelled = false
        createPlanCardSetupAction().then(result => {
            if (cancelled) return
            setSession(result.ok ? { clientSecret: result.clientSecret, sessionId: result.sessionId } : { error: result.error })
        })
        return () => {
            cancelled = true
        }
    }, [])

    if (!session) return <PaneSkeleton />
    if ('error' in session) return <PaneError message={session.error} />

    return (
        <StripeCheckoutProvider clientSecret={session.clientSecret}>
            <CardForm sessionId={session.sessionId} selection={selection} priceArm={priceArm} copy={copy} trialEnds={trialEnds} onDone={onDone} />
        </StripeCheckoutProvider>
    )
}

function CardForm({ sessionId, selection, priceArm, copy, trialEnds, onDone }: { sessionId: string; selection: PlanSelection; priceArm: PriceArm; copy: PaneCopy; trialEnds: string | null; onDone: (outcome: 'paid' | 'card_saved') => void }) {
    const checkout = useCheckout()
    const loaded = checkout.type === 'success' ? checkout.checkout : null
    const [accepted, setAccepted] = useState(false)
    const [submitting, setSubmitting] = useState<'now' | 'later' | null>(null)
    const [error, setError] = useState<string | null>(null)
    const interval = selection.interval

    const save = async (when: 'now' | 'later', expressCheckoutConfirmEvent?: StripeExpressCheckoutElementConfirmEvent) => {
        if (!loaded || submitting) return
        setSubmitting(when)
        setError(null)
        try {
            const result = await loaded.confirm({ redirect: 'if_required', expressCheckoutConfirmEvent })
            if (result.type === 'error') throw new Error(result.error.message)
            const saved = await confirmCardSetupAction(sessionId)
            if (!saved.ok) throw new Error(saved.error)
            if (when === 'later') return onDone('card_saved')

            const changed = await runPlanChange(selection)
            if (!changed.ok) throw new Error(changed.error)
            onDone('paid')
        } catch (err) {
            setError(errorMessage(err))
        } finally {
            setSubmitting(null)
        }
    }

    return (
        <>
            <PayHeader title="Subscribe to Rerun Pro" amount={<UsdFlow cents={planPriceCents(selection.quantities, interval, priceArm)} />} unit={interval === 'yearly' ? 'per year' : 'per month'} />
            <p className="mt-2 text-sm text-muted-foreground">Excl. VAT, computed from your address.</p>
            <div className="mt-6">
                <StripePaymentFields wallet={{ onConfirm: event => void save('now', event), disabledReason: !accepted ? 'Accept the terms first' : submitting ? 'Please wait' : undefined }} />
            </div>
            <PayFooter
                cta={copy.cta}
                onClick={() => void save('now')}
                loading={submitting === 'now'}
                disabled={!loaded || !accepted || !!submitting}
                disabledReason={!accepted ? 'Accept the terms first' : undefined}
                error={error}
                footnote={
                    <>
                        Paying now ends your free trial today, and you authorize Rerun to charge you until you cancel. Rather finish your trial?{' '}
                        <button type="button" disabled={!loaded || !!submitting} onClick={() => void save('later')} className="text-foreground underline underline-offset-4 disabled:opacity-60">
                            {submitting === 'later' ? 'Saving…' : `Pay on ${trialEnds ?? 'the last day'}`}
                        </button>
                    </>
                }
            >
                <TermsConsent checked={accepted} onChange={setAccepted} />
            </PayFooter>
        </>
    )
}

// --- A trial with a card: the right column is the bill, paying is one click ---

function CardOnFilePane({
    selection,
    priceArm,
    state,
    copy,
    trialEnds,
    onBack,
    onDone,
    onCancelTrial,
    onResumed,
}: {
    selection: PlanSelection
    priceArm: PriceArm
    state: SubscriptionState | null
    copy: PaneCopy
    trialEnds: string | null
    onBack?: () => void
    onDone: () => void
    onCancelTrial: () => void
    onResumed: () => void
}) {
    const quote = usePlanQuote(selection, true)
    const [accepted, setAccepted] = useState(false)
    const [submitting, setSubmitting] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const interval = selection.interval

    const start = async () => {
        if (submitting) return
        setSubmitting(true)
        setError(null)
        const result = await runPlanChange(selection)
        setSubmitting(false)
        if (!result.ok) return setError(result.error)
        onDone()
    }

    const listCents = planPriceCents(selection.quantities, interval, priceArm)
    const amount = quote === 'loading' ? <Skeleton className="inline-block h-7 w-24 align-middle" /> : usd(quote?.dueTodayCents ?? listCents)

    if (state?.cancelAtPeriodEnd) return <TrialCancelledPane trialEnds={trialEnds} onResumed={onResumed} />

    return (
        <>
            {onBack && (
                <div className="mb-5">
                    <RightTitle onBack={onBack} backLabel="Your trial">
                        Start Pro today
                    </RightTitle>
                </div>
            )}
            <PayHeader title="End trial, start Rerun Pro" amount={amount} unit="due today" />
            <div className="mt-6 flex flex-col gap-3">
                <SummaryRows
                    rows={[
                        { label: 'Pro · Unlimited coworkers', value: <BilledFlow cents={listCents} interval={interval} /> },
                        {
                            label: quote && quote !== 'loading' && quote.taxIncluded ? 'Tax' : 'Tax, from your address',
                            value: quote === 'loading' ? <Skeleton className="inline-block h-4 w-12" /> : quote ? usd(quote.taxCents) : '-',
                            muted: true,
                        },
                        { label: 'Due today', value: amount, strong: true },
                    ]}
                />
                <CardOnFile card={state?.card ?? null} />
            </div>
            <PayFooter
                cta={copy.cta}
                footnote={copy.footnote}
                onClick={() => void start()}
                loading={submitting}
                disabled={!accepted}
                disabledReason="Accept the terms first"
                error={error}
            >
                <TermsConsent checked={accepted} onChange={setAccepted} />
            </PayFooter>
            {state?.cancelPhase === 'trial' && (
                <button type="button" onClick={onCancelTrial} className="mt-3 text-center text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground">
                    Cancel trial
                </button>
            )}
        </>
    )
}

// --- A trial with a card, as opened from the pill: what it costs today, when the card is charged ---

function TrialPane({
    state,
    copy,
    trialEnds,
    reminderOn,
    firstCharge,
    onContinue,
    onCancelTrial,
    onPayNow,
    onResumed,
}: {
    state: SubscriptionState | null
    copy: PaneCopy
    trialEnds: string | null
    reminderOn: string | null
    firstCharge: ReactNode
    onContinue: () => void
    onCancelTrial: () => void
    onPayNow: () => void
    onResumed: () => void
}) {
    if (state?.cancelAtPeriodEnd) return <TrialCancelledPane trialEnds={trialEnds} onResumed={onResumed} />

    const chargeDate = trialEnds ?? 'the end of your trial'
    return (
        <>
            <PayHeader title="Your free trial" amount={usd(0)} unit="due today" />
            <div className="mt-6 flex flex-col gap-3">
                <SummaryRows
                    rows={[
                        { label: 'Included', value: trialLimitsLabel() },
                        ...APP_SLUGS.flatMap(slug => {
                            const count = state?.quantities[APP_ADDON_KEYS[slug]] ?? 0
                            if (!state || count === 0) return []
                            const cents = count * PLAN_PRICES_CENTS[state.interval][APP_ADDON_KEYS[slug]]
                            return [{ label: `${APP_INFO[slug].providerLabel} slot${count === 1 ? '' : 's'} × ${count}`, value: `$0 now, ${usd(cents)}${state.interval === 'yearly' ? '/yr' : '/mo'} from ${chargeDate}` }]
                        }),
                        { label: 'Trial ends', value: chargeDate },
                        ...(reminderOn ? [{ label: 'Reminder by email', value: reminderOn }] : []),
                        { label: 'First charge', value: <>{firstCharge} on {chargeDate}</>, strong: true },
                    ]}
                />
                <CardOnFile card={state?.card ?? null} />
                <p className="text-sm text-muted-foreground">Cancel before {chargeDate} and nothing is charged. Your coworkers keep running until then.</p>
            </div>
            <PayFooter cta={copy.cta} onClick={onPayNow} />
            <Button variant="outline" size="lg" className="mt-3 h-11 w-full text-base" onClick={onContinue}>
                Continue my trial
            </Button>
            {state?.cancelPhase === 'trial' && (
                <button type="button" onClick={onCancelTrial} className="mt-4 text-center text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground">
                    Cancel trial
                </button>
            )}
        </>
    )
}

function TrialCancelledPane({ trialEnds, onResumed }: { trialEnds: string | null; onResumed: () => void }) {
    const [resuming, setResuming] = useState(false)

    const resume = async () => {
        setResuming(true)
        const result = await resumeSubscriptionAction()
        setResuming(false)
        if (!result.ok) return toast.error('Could not resume your trial', { description: result.error })
        onResumed()
    }

    return (
        <>
            <PayHeader title="Your trial ends" amount={trialEnds ?? ''} unit="nothing charged" />
            <p className="mt-6 text-sm text-muted-foreground">You cancelled your trial. Your coworkers keep running until then, and nothing is charged.</p>
            <PayFooter cta="Resume my trial" onClick={() => void resume()} loading={resuming} />
        </>
    )
}

function PaneSkeleton() {
    return (
        <div className="flex flex-1 flex-col">
            <div className="flex items-center gap-4">
                <Skeleton className="size-10 rounded-xl" />
                <div className="flex flex-col gap-2">
                    <Skeleton className="h-3.5 w-36" />
                    <Skeleton className="h-7 w-28" />
                </div>
            </div>
            <div className="mt-6">
                <StripePaymentFieldsSkeleton />
            </div>
            <Skeleton className="mt-auto h-11 w-full" />
        </div>
    )
}

function PaneError({ message }: { message: string }) {
    return (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
            <p className="text-sm font-medium">The payment form could not open</p>
            <p className="max-w-xs text-sm text-muted-foreground">{message}</p>
        </div>
    )
}
