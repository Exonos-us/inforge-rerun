'use client'

import { useCheckout } from '@stripe/react-stripe-js/checkout'
import type { StripeExpressCheckoutElementConfirmEvent } from '@stripe/stripe-js'
import { Badge, Stripes, type BadgeTone } from '@rerun/ui/primitives'
import { useEffect, useState, type ReactNode } from 'react'
import { toast } from 'sonner'

import {
    cancelPendingSwitchAction,
    confirmCardSetupAction,
    createPlanCardSetupAction,
    listInvoicesAction,
    resumeSubscriptionAction,
} from '@/ee/actions/billing.actions'
import { runPlanChange } from '@/ee/lib/billing/plan-payment'
import type { InvoiceSummary, PlanSelection, SubscriptionState } from '@/ee/services/billing.service'
import { Button } from '@/components/ui/button'
import { PanelSteps } from '@/components/ui/panel-steps'
import { Skeleton } from '@/components/ui/skeleton'
import { useWorkspaceAccess } from '@/hooks/useWorkspaceAccess'
import { BASE_PLAN_CREDITS, CREDITS_PER_PACK, PLAN_PRICES_CENTS, creditsLabel, formatCredits, planDiscountCents, planPriceCents, type AddonKey, type AddonQuantities, type BillingInterval } from '@/ee/lib/billing/plans'
import { ChevronRightIcon, CoinsIcon, ExternalLinkIcon, MinusIcon, PlusIcon, Receipt } from '@/lib/icons'
import { useSession } from '@/supabase/session/SessionProvider'

import { BillingDialogShell } from './BillingDialogShell'
import { BusinessDetailsPane, BusinessDetailsRow } from './BusinessDetailsPane'
import { AppsSection, appSlotsLabel, appSlotsOf, useAppSlots, withAppSlots, type AppSlots, type AppSlotsState } from './AppsSection'
import { useEnabledPaidApps } from '@/components/layout/FeatureFlagsProvider'
import { appInfo } from '@/lib/apps/catalog'
import { APP_SLUGS, type AppSlug } from '@/lib/apps/types'
import { usePaidAppsStore } from '@/stores/paid-apps.store'
import { CreditCard } from './credit-usage/CreditCard'
import { UsagePane } from './credit-usage/UsagePane'
import { useCreditUsage } from './credit-usage/useCreditUsage'
import { longDate, shortDate } from './checkout-copy'
import { BilledFlow, CardOnFile, CountFlow, IntervalToggle, Notice, PayFooter, PlanCard, RightTitle, SuccessPanel, SummaryRows, TermsConsent, usd } from './parts'
import { StripeCheckoutProvider, StripePaymentFields, StripePaymentFieldsSkeleton } from './StripeCheckout'
import { usePlanQuote } from './usePlanQuote'

type Drill = 'overview' | 'card' | 'invoices' | 'credit' | 'usage' | 'business'
type Success = { title: string; body: string; rows?: { label: string; value: string }[] }

function billed(cents: number, interval: BillingInterval): string {
    return `${usd(cents)}${interval === 'yearly' ? '/yr' : '/mo'}`
}

// What the plan bills each interval at `quantities`, with the legacy price and the promos it keeps.
function planBillCents(state: SubscriptionState, quantities: AddonQuantities, interval: BillingInterval): number {
    return Math.max(0, planPriceCents(quantities, interval, state.priceArm) - planDiscountCents(state, interval))
}

function statusOf(state: SubscriptionState): { label: string; tone: BadgeTone } {
    if (state.status === 'past_due') return { label: 'Payment failed', tone: 'red' }
    if (state.cancelAtPeriodEnd) return { label: state.periodEnd ? `Ends ${shortDate(state.periodEnd)}` : 'Ending', tone: 'orange' }
    if (state.pendingSwitch) return { label: `Monthly from ${shortDate(state.pendingSwitch.at)}`, tone: 'yellow' }
    return { label: 'Active', tone: 'green' }
}

// `appSlots` stands in for the fetched accounts, for the lab only.
export function PlanDialog({
    state,
    highlightAddon,
    onClose,
    onCancel,
    onChanged,
    appSlots,
}: {
    state: SubscriptionState
    highlightAddon: AddonKey | null
    onClose: () => void
    onCancel: () => void
    onChanged: () => Promise<void>
    appSlots?: Partial<Record<AppSlug, AppSlotsState>>
}) {
    const { refreshWorkspace } = useSession()
    const currentSlots = appSlotsOf(state.quantities)
    const [slots, setSlots] = useState<AppSlots>(currentSlots)
    const enabledApps = useEnabledPaidApps()
    const shownApps = APP_SLUGS.filter(slug => enabledApps.includes(slug) || currentSlots[slug] > 0)
    const fetchedSlots = useAppSlots(shownApps, !!appSlots)
    const slotsStates = appSlots ?? fetchedSlots
    const openApp = usePaidAppsStore(s => s.openApp)
    const [interval, setBillingInterval] = useState<BillingInterval>(state.interval)
    const [drill, setDrill] = useState<Drill>(highlightAddon === 'credit_pack' ? 'credit' : 'overview')
    const [success, setSuccess] = useState<Success | null>(null)
    const credit = useCreditUsage()

    const pastDue = state.status === 'past_due'
    const locked = pastDue || state.cancelAtPeriodEnd || !!success
    const dirty = APP_SLUGS.some(slug => slots[slug] !== currentSlots[slug]) || interval !== state.interval
    const renewal = state.periodEnd ? shortDate(state.periodEnd) : 'your renewal'
    const selection: PlanSelection = { quantities: withAppSlots(state.quantities, slots), interval }
    const currentBillCents = planBillCents(state, state.quantities, state.interval)

    const done = async (next: Success) => {
        await refreshWorkspace()
        await onChanged()
        setSuccess(next)
    }

    const reset = () => {
        setSlots(currentSlots)
        setBillingInterval(state.interval)
    }

    const status = statusOf(state)
    const left = (
        <>
            <div className="flex flex-col items-start gap-3">
                <Badge size="sm" tone={status.tone}>
                    {status.label}
                </Badge>
                <h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">Rerun Pro</h2>
                <p className="text-base text-muted-foreground">
                    Unlimited coworkers · billed {state.interval} · {state.cancelAtPeriodEnd ? 'ends' : 'renews'} {renewal}
                </p>
            </div>
            <div className="mt-6 flex flex-col gap-3">
                <IntervalToggle value={interval} onChange={setBillingInterval} disabled={locked} />
                <PlanCard interval={interval} priceArm={state.priceArm} discountCents={planDiscountCents(state, interval)} />
            </div>
            <div className="mt-3">
                <CreditCard credit={credit} highlight={drill === 'credit'} onAdd={state.cancelAtPeriodEnd || pastDue ? undefined : () => setDrill('credit')} onOpenUsage={state.cancelAtPeriodEnd || pastDue ? undefined : () => setDrill('usage')} />
            </div>
            {shownApps.length > 0 && (
                <div className="mt-6">
                    <AppsSection
                        rows={shownApps.map(slug => ({
                            slug,
                            value: slots[slug],
                            current: currentSlots[slug],
                            slotsState: slotsStates[slug] ?? { overview: null, loaded: false },
                            onOpen: enabledApps.includes(slug)
                                ? () => {
                                      onClose()
                                      openApp(slug)
                                  }
                                : undefined,
                        }))}
                        interval={interval}
                        renewal={renewal}
                        disabled={locked}
                        onChange={(slug, value) => setSlots(current => ({ ...current, [slug]: value }))}
                    />
                </div>
            )}
        </>
    )

    const right = (() => {
        if (success) return <SuccessPanel title={success.title} body={success.body} rows={success.rows} cta="Done" onDone={onClose} />
        if (pastDue) return <PastDuePane state={state} onDone={() => void done({ title: 'Payment received', body: 'Your card is updated and Pro is active again.' })} />
        if (state.cancelAtPeriodEnd) return <CancelPendingPane state={state} currentBillCents={currentBillCents} onResumed={() => void done({ title: 'Pro is back on', body: `Your plan renews on ${renewal}.` })} />
        if (dirty) return <ChangePane state={state} currentBillCents={currentBillCents} selection={selection} onReset={reset} onDone={next => void done(next)} />

        return (
            <PanelSteps stepKey={drill} depth={drill === 'overview' ? 0 : 1}>
                {drill === 'card' ? (
                    <CardPane
                        onBack={() => setDrill('overview')}
                        onSaved={async () => {
                            await onChanged()
                            toast.success('Card updated')
                            setDrill('overview')
                        }}
                    />
                ) : drill === 'invoices' ? (
                    <InvoicesPane onBack={() => setDrill('overview')} />
                ) : drill === 'credit' ? (
                    <CreditPane state={state} onBack={() => setDrill('overview')} onDone={next => void done(next)} />
                ) : drill === 'usage' ? (
                    <UsagePane credit={credit} onBack={() => setDrill('overview')} />
                ) : drill === 'business' ? (
                    <BusinessDetailsPane business={state.business} onBack={() => setDrill('overview')} onSaved={onChanged} />
                ) : (
                    <OverviewPane
                        state={state}
                        creditLeftMicros={credit.balance?.leftMicros ?? null}
                        onCard={() => setDrill('card')}
                        onInvoices={() => setDrill('invoices')}
                        onUsage={() => setDrill('usage')}
                        onBusiness={() => setDrill('business')}
                        onCancel={onCancel}
                        onChanged={onChanged}
                    />
                )}
            </PanelSteps>
        )
    })()

    return <BillingDialogShell title="Rerun Pro" left={left} right={right} />
}

function OverviewPane({
    state,
    creditLeftMicros,
    onCard,
    onInvoices,
    onUsage,
    onBusiness,
    onCancel,
    onChanged,
}: {
    state: SubscriptionState
    creditLeftMicros: number | null
    onCard: () => void
    onInvoices: () => void
    onUsage: () => void
    onBusiness: () => void
    onCancel: () => void
    onChanged: () => Promise<void>
}) {
    const [keeping, setKeeping] = useState(false)

    const keepYearly = async () => {
        setKeeping(true)
        const result = await cancelPendingSwitchAction()
        setKeeping(false)
        if (!result.ok) return toast.error('Could not keep your yearly plan', { description: result.error })
        await onChanged()
    }

    const rows = [
        { label: 'Next invoice', value: state.nextInvoice ? `${shortDate(state.nextInvoice.at)} · ${usd(state.nextInvoice.amountCents)}` : '-' },
        { label: 'Billed', value: `${state.interval === 'yearly' ? 'Yearly' : 'Monthly'}, tax included`, muted: true },
        ...(state.pendingSwitch ? [{ label: 'From ' + shortDate(state.pendingSwitch.at), value: `Monthly · ${billed(planPriceCents(state.pendingSwitch.selection.quantities, 'monthly', state.priceArm), 'monthly')}` }] : []),
    ]

    return (
        <>
            <Stripes fade="bottom" className="opacity-50" />
            <div className="relative flex flex-1 flex-col">
                <RightTitle>Billing</RightTitle>
                <div className="mt-6 flex flex-col gap-3">
                    <SummaryRows rows={rows} />
                    <CardOnFile card={state.card} action="Update" onAction={onCard} />
                    <button type="button" onClick={onInvoices} className="flex items-center justify-between rounded-xl bg-background/60 px-4 py-3 text-sm ring-1 ring-border hover:bg-background">
                        <span className="flex items-center gap-3">
                            <Receipt className="size-4 text-muted-foreground" />
                            Invoices
                        </span>
                        <span className="text-muted-foreground underline underline-offset-4">View all</span>
                    </button>
                    <BusinessDetailsRow business={state.business} onOpen={onBusiness} />
                    <button type="button" onClick={onUsage} className="flex items-center justify-between rounded-xl bg-background/60 px-4 py-3 text-sm ring-1 ring-border hover:bg-background">
                        <span className="flex items-center gap-3">
                            <CoinsIcon className="size-4 text-muted-foreground" />
                            Credit usage
                        </span>
                        <span className="flex items-center gap-1 text-muted-foreground">
                            {creditLeftMicros != null && <span className="tabular-nums">{formatCredits(creditLeftMicros)} left</span>}
                            <ChevronRightIcon className="size-4" />
                        </span>
                    </button>
                    {state.pendingSwitch && (
                        <Button variant="outline" onClick={() => void keepYearly()} disabled={keeping}>
                            Keep my yearly plan
                        </Button>
                    )}
                </div>
                <div className="mt-auto flex flex-col gap-3 pt-6">
                    <p className="text-center text-xs text-muted-foreground">Switch the billing to see the new price.</p>
                    {state.cancelPhase && (
                        <button type="button" onClick={onCancel} className="text-center text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground">
                            Cancel plan
                        </button>
                    )}
                </div>
            </div>
        </>
    )
}

// What switching the billing or the app slots would do, quoted before anything is applied.
function ChangePane({
    state,
    currentBillCents,
    selection,
    onReset,
    onDone,
}: {
    state: SubscriptionState
    currentBillCents: number
    selection: PlanSelection
    onReset: () => void
    onDone: (success: Success) => void
}) {
    const [accepted, setAccepted] = useState(false)
    const [submitting, setSubmitting] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const slots = appSlotsOf(selection.quantities)
    const currentSlots = appSlotsOf(state.quantities)
    const planLabel = (slotCounts: AppSlots) => `Unlimited coworkers${appSlotsLabel(slotCounts)}`
    const changedApps = APP_SLUGS.filter(slug => slots[slug] !== currentSlots[slug])
    const interval = selection.interval
    const newBillCents = planBillCents(state, selection.quantities, interval)
    const newBill = billed(newBillCents, interval)
    const renewal = state.periodEnd ? shortDate(state.periodEnd) : 'your renewal'
    const switchingDown = state.interval === 'yearly' && interval === 'monthly'
    const switchingUp = state.interval === 'monthly' && interval === 'yearly'
    const increase = APP_SLUGS.some(slug => slots[slug] > currentSlots[slug])
    const chargesToday = switchingUp || increase

    const quote = usePlanQuote(selection, chargesToday)

    const apply = async () => {
        setSubmitting(true)
        setError(null)
        const result = await runPlanChange(selection)
        setSubmitting(false)
        if (!result.ok) return setError(result.error)
        if (result.switchAt) return onDone({ title: 'Switch scheduled', body: `Your yearly plan runs to its end. Monthly billing starts on ${shortDate(result.switchAt)}.` })
        if (!chargesToday) return onDone({ title: 'Change scheduled', body: `You keep ${planLabel(currentSlots)} until ${renewal}, then ${planLabel(slots)} at ${newBill}.` })
        onDone({ title: 'Plan updated', body: `${planLabel(slots)}, billed ${interval}. Your receipt is on its way by email.` })
    }

    const newBillFlow = <BilledFlow cents={newBillCents} interval={interval} />
    const onlySlots = !switchingUp && !switchingDown
    const title = switchingDown ? (
        'Switch to monthly'
    ) : onlySlots && changedApps.length === 1 ? (
        <>
            Change to <CountFlow value={slots[changedApps[0]]} /> {appInfo(changedApps[0]).providerLabel} slot{slots[changedApps[0]] === 1 ? '' : 's'}
        </>
    ) : onlySlots ? (
        'Change your app slots'
    ) : (
        'Switch to yearly'
    )
    const quoteValue = (cents: number | undefined) => (quote === 'loading' ? <Skeleton className="inline-block h-4 w-14" /> : cents == null ? '-' : usd(cents))

    const rows = chargesToday
        ? [
              { label: `Pro · ${planLabel(slots)}, ${interval}`, value: newBillFlow },
              ...(switchingUp ? [{ label: `Unused time on your ${state.interval} plan`, value: quote && quote !== 'loading' ? `-${usd(quote.unusedCreditCents)}` : quoteValue(undefined), muted: true }] : []),
              { label: 'Due today, tax included', value: quoteValue(quote && quote !== 'loading' ? quote.dueTodayCents : undefined), strong: true },
              ...(switchingDown ? [{ label: 'From ' + renewal, value: <>Monthly · {newBillFlow}</>, muted: true }] : []),
          ]
        : [
              { label: 'Until ' + renewal, value: `${planLabel(currentSlots)} · ${billed(currentBillCents, state.interval)}` },
              {
                  label: 'From ' + renewal,
                  value: (
                      <>
                          {planLabel(slots)} · {newBillFlow}
                      </>
                  ),
                  strong: true,
              },
          ]

    return (
        <>
            <RightTitle onBack={onReset} backLabel="Keep my plan">
                {title}
            </RightTitle>
            <div className="mt-6 flex flex-col gap-3">
                <SummaryRows rows={rows} />
                {chargesToday && <CardOnFile card={state.card} />}
            </div>
            <PayFooter
                cta={chargesToday ? 'Confirm and pay' : switchingDown ? `Switch on ${renewal}` : `Schedule for ${renewal}`}
                footnote={chargesToday ? (switchingDown ? `Billed now for the new slots. Monthly billing starts on ${renewal}.` : onlySlots ? 'The new slots are ready as soon as the payment goes through.' : 'Your yearly plan starts as soon as the payment goes through.') : 'Nothing is charged today.'}
                onClick={() => void apply()}
                loading={submitting}
                disabled={(chargesToday && (!accepted || quote === 'loading'))}
                disabledReason={!accepted ? 'Accept the terms first' : undefined}
                error={error}
            >
                {chargesToday && <TermsConsent checked={accepted} onChange={setAccepted} />}
            </PayFooter>
        </>
    )
}

function CancelPendingPane({ state, currentBillCents, onResumed }: { state: SubscriptionState; currentBillCents: number; onResumed: () => void }) {
    const [resuming, setResuming] = useState(false)
    const ends = state.periodEnd ? shortDate(state.periodEnd) : 'the end of your period'

    const resume = async () => {
        setResuming(true)
        const result = await resumeSubscriptionAction()
        setResuming(false)
        if (!result.ok) return toast.error('Could not resume your plan', { description: result.error })
        onResumed()
    }

    return (
        <>
            <RightTitle>Pro ends on {ends}</RightTitle>
            <div className="mt-6 flex flex-col gap-3">
                <p className="text-sm text-muted-foreground">Your coworkers keep running until then. After that the workspace pauses and its data is saved for 90 days.</p>
                <SummaryRows rows={[{ label: 'Next invoice', value: 'None', muted: true }]} />
            </div>
            <PayFooter cta="Resume Pro" footnote={`Resuming keeps your plan and bills ${billed(currentBillCents, state.interval)} on ${ends}.`} onClick={() => void resume()} loading={resuming} />
        </>
    )
}

// --- The card: a setup session in the app's own UI, for a new card or a failed payment ---

function useSetupSession(): { clientSecret: string; sessionId: string } | { error: string } | null {
    const [session, setSession] = useState<{ clientSecret: string; sessionId: string } | { error: string } | null>(null)
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
    return session
}

function SetupForm({ sessionId, cta, footnote, onSaved }: { sessionId: string; cta: string; footnote?: string; onSaved: () => void }) {
    const checkout = useCheckout()
    const loaded = checkout.type === 'success' ? checkout.checkout : null
    const [submitting, setSubmitting] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const save = async (expressCheckoutConfirmEvent?: StripeExpressCheckoutElementConfirmEvent) => {
        if (!loaded || submitting) return
        setSubmitting(true)
        setError(null)
        try {
            const result = await loaded.confirm({ redirect: 'if_required', expressCheckoutConfirmEvent })
            if (result.type === 'error') throw new Error(result.error.message)
            const saved = await confirmCardSetupAction(sessionId)
            if (!saved.ok) throw new Error(saved.error)
            onSaved()
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Your card could not be saved')
        } finally {
            setSubmitting(false)
        }
    }

    return (
        <>
            <div className="mt-6">
                <StripePaymentFields wallet={{ onConfirm: event => void save(event), disabledReason: submitting ? 'Please wait' : undefined }} />
            </div>
            <PayFooter cta={cta} footnote={footnote} onClick={() => void save()} loading={submitting} disabled={!loaded} error={error} />
        </>
    )
}

function SetupSessionPane({ children }: { children: (sessionId: string) => ReactNode }) {
    const session = useSetupSession()
    if (!session) return <StripePaymentFieldsSkeleton />
    if ('error' in session) return <Notice tone="danger">{session.error}</Notice>
    return <StripeCheckoutProvider clientSecret={session.clientSecret}>{children(session.sessionId)}</StripeCheckoutProvider>
}

function CardPane({ onBack, onSaved }: { onBack: () => void; onSaved: () => void }) {
    return (
        <>
            <RightTitle onBack={onBack}>Update your card</RightTitle>
            <SetupSessionPane>{sessionId => <SetupForm sessionId={sessionId} cta="Save card" footnote="Your next invoices are charged to this card." onSaved={onSaved} />}</SetupSessionPane>
        </>
    )
}

function PastDuePane({ state, onDone }: { state: SubscriptionState; onDone: () => void }) {
    const { access } = useWorkspaceAccess()
    const due = state.openInvoice ? usd(state.openInvoice.amountCents) : null
    return (
        <>
            <RightTitle>Update your card</RightTitle>
            <div className="mt-6">
                <Notice tone="danger">
                    {due ? `Your ${due} payment${state.openInvoice ? ` on ${shortDate(state.openInvoice.createdAt)}` : ''} was declined.` : 'Your last payment was declined.'}{' '}
                    {access === 'paused' ? 'Your workspace is paused and comes back as soon as it goes through.' : 'Pay it now to keep your workspace running.'}
                </Notice>
            </div>
            <SetupSessionPane>{sessionId => <SetupForm sessionId={sessionId} cta={due ? `Update card and pay ${due}` : 'Update card and pay'} onSaved={onDone} />}</SetupSessionPane>
        </>
    )
}

function InvoicesPane({ onBack }: { onBack: () => void }) {
    const [invoices, setInvoices] = useState<InvoiceSummary[] | null>(null)

    useEffect(() => {
        let cancelled = false
        listInvoicesAction().then(result => {
            if (cancelled) return
            if (!result.ok) toast.error('Could not load your invoices', { description: result.error })
            setInvoices(result.ok ? result.invoices : [])
        })
        return () => {
            cancelled = true
        }
    }, [])

    return (
        <>
            <RightTitle onBack={onBack}>Invoices</RightTitle>
            <div className="mt-6 flex flex-col divide-y divide-border rounded-xl bg-background/60 ring-1 ring-border">
                {invoices === null
                    ? Array.from({ length: 4 }, (_, index) => (
                          <div key={index} className="flex items-center justify-between px-4 py-3">
                              <Skeleton className="h-4 w-24" />
                              <Skeleton className="h-4 w-16" />
                          </div>
                      ))
                    : invoices.length === 0
                      ? <p className="px-4 py-6 text-center text-sm text-muted-foreground">No invoice yet.</p>
                      : invoices.map(invoice => (
                            <a
                                key={invoice.id}
                                href={invoice.pdfUrl ?? invoice.hostedUrl ?? undefined}
                                target="_blank"
                                rel="noreferrer"
                                className="flex items-center justify-between gap-4 px-4 py-3 text-sm hover:bg-background"
                            >
                                <span>{longDate(invoice.createdAt)}</span>
                                <span className="flex items-center gap-3">
                                    {invoice.status !== 'paid' && <span className="text-xs text-muted-foreground capitalize">{invoice.status}</span>}
                                    <span className="tabular-nums">{usd(invoice.amountCents)}</span>
                                    <ExternalLinkIcon className="size-3.5 text-muted-foreground" />
                                </span>
                            </a>
                        ))}
            </div>
        </>
    )
}

// Rerun credit is a monthly quantity on the plan: each pack adds its credit every month.
function CreditPane({ state, onBack, onDone }: { state: SubscriptionState; onBack: () => void; onDone: (success: Success) => void }) {
    const current = state.quantities.credit_pack
    const [packs, setPacks] = useState(current + 1)
    const [accepted, setAccepted] = useState(false)
    const [submitting, setSubmitting] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const selection: PlanSelection = { quantities: { ...state.quantities, credit_pack: packs }, interval: state.interval }
    const increase = packs > current
    const packPrice = PLAN_PRICES_CENTS[state.interval].credit_pack
    const quote = usePlanQuote(selection, increase)

    const apply = async () => {
        setSubmitting(true)
        setError(null)
        const result = await runPlanChange(selection)
        setSubmitting(false)
        if (!result.ok) return setError(result.error)
        onDone({
            title: increase ? 'Credits added' : 'Change scheduled',
            body: increase ? `You now get ${creditsLabel(BASE_PLAN_CREDITS + packs * CREDITS_PER_PACK)} every month. Your coworkers pick up where they stopped.` : 'Your credits stay as they are until your renewal.',
        })
    }

    return (
        <>
            <RightTitle onBack={onBack}>Add Rerun credits</RightTitle>
            <p className="mt-2 text-sm text-muted-foreground">
                Each pack adds {creditsLabel(CREDITS_PER_PACK)} every month, for {billed(packPrice, state.interval)}.
            </p>
            <div className="mt-6 flex flex-col gap-3">
                <div className="flex items-center justify-between rounded-xl bg-background/60 px-4 py-3 ring-1 ring-border">
                    <div>
                        <p className="text-sm font-medium">
                            {packs} {packs === 1 ? 'pack' : 'packs'}
                        </p>
                        <p className="text-xs text-muted-foreground">+{creditsLabel(packs * CREDITS_PER_PACK)} a month</p>
                    </div>
                    <div className="flex items-center gap-2">
                        <Button variant="outline" size="icon-sm" aria-label="One pack less" onClick={() => setPacks(value => Math.max(0, value - 1))} disabled={packs === 0}>
                            <MinusIcon />
                        </Button>
                        <Button variant="outline" size="icon-sm" aria-label="One pack more" onClick={() => setPacks(value => value + 1)}>
                            <PlusIcon />
                        </Button>
                    </div>
                </div>
                {increase && (
                    <SummaryRows
                        rows={[
                            { label: 'Due today, tax included', value: quote === 'loading' ? <Skeleton className="inline-block h-4 w-14" /> : quote ? usd(quote.dueTodayCents) : '-', strong: true },
                            { label: 'Then', value: billed(planBillCents(state, selection.quantities, state.interval), state.interval), muted: true },
                        ]}
                    />
                )}
                <CardOnFile card={state.card} />
            </div>
            <PayFooter
                cta={increase ? 'Add credits' : packs === current ? 'Pick a number of packs' : 'Remove at renewal'}
                footnote={increase ? 'Charged now, prorated to your renewal.' : 'Nothing is charged today.'}
                onClick={() => void apply()}
                loading={submitting}
                disabled={packs === current || (increase && (!accepted || quote === 'loading'))}
                disabledReason={increase && !accepted ? 'Accept the terms first' : undefined}
                error={error}
            >
                {increase && <TermsConsent checked={accepted} onChange={setAccepted} />}
            </PayFooter>
        </>
    )
}
