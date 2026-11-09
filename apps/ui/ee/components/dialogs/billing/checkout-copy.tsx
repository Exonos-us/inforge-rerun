import type { ReactNode } from 'react'

import type { BadgeTone } from '@rerun/ui/primitives'

import type { CheckoutVariant } from '@/ee/lib/billing/checkout-variant'
import { longDate, shortDate } from '@/ee/lib/billing/dates'
import { BASE_PLAN_CREDITS, TRIAL_ACTIVE_AGENTS, TRIAL_CREDITS, TRIAL_DAYS, creditsLabel, trialChargeLine, type BillingInterval } from '@/ee/lib/billing/plans'

import type { TimelineStep } from './parts'

export { longDate, shortDate }

export function nextInvoiceDate(interval: BillingInterval, from = new Date()): Date {
    const next = new Date(from)
    if (interval === 'yearly') next.setFullYear(next.getFullYear() + 1)
    else next.setMonth(next.getMonth() + 1)
    return next
}

export type CheckoutContext = {
    // The price of one invoice with its period, "$29/mo" or "$276/yr", animated as the toggle moves.
    billed: ReactNode
    nextInvoice: string
    trialEnds: string | null
    trialDaysLeft: number | null
    // The day before the trial ends, when the reminder email goes out. null once that day is past.
    reminderOn: string | null
    // What the card is charged when the trial rolls into Pro.
    firstCharge: string
    trialCancelled: boolean
    keptUntil: string | null
    parked: { title: string; agentCount: number } | null
    // The coworker that stopped on its trial credit, when the paywall was opened from its chat.
    coworker: string | null
}

export type CheckoutCopy = {
    badge?: { label: string; tone: BadgeTone }
    title: string
    subtitle: string
    timeline: TimelineStep[]
    cta: string
    // The pay button once the amount due today is known, so it reads exactly what is charged.
    payCta?: (amount: string) => string
    // How a refused payment reads, for a screen where the customer must hear their trial is safe.
    refusal?: (message: string) => string
    footnote?: string
}

const CANCEL_STEP: TimelineStep = { when: 'Anytime', title: 'Cancel in a click', detail: 'No notice period' }

function trialBadge(context: CheckoutContext): CheckoutCopy['badge'] {
    if (context.trialDaysLeft == null) return { label: 'Free trial', tone: 'brand' }
    return { label: `Free trial · ${context.trialDaysLeft <= 0 ? 'ends today' : `${context.trialDaysLeft} ${context.trialDaysLeft === 1 ? 'day' : 'days'} left`}`, tone: 'brand' }
}

function upgradeTimeline(context: CheckoutContext): TimelineStep[] {
    return [{ when: 'Today', title: 'Pro starts', detail: 'Unlimited coworkers' }, { when: context.nextInvoice, title: 'Next invoice', detail: <>{context.billed}, excl. VAT</> }, CANCEL_STEP]
}

// Subscribing during a trial ends it on the spot and bills the whole plan today: said on the first
// step, never left for the invoice to reveal.
function endTrialTimeline(context: CheckoutContext): TimelineStep[] {
    return [
        { when: 'Today', title: 'Trial ends, Pro starts', detail: <>{context.billed} charged today, unlimited coworkers</> },
        { when: context.nextInvoice, title: 'Next invoice', detail: <>{context.billed}, excl. VAT</> },
        CANCEL_STEP,
    ]
}

function endTrialFootnote(trialEnds: string): string {
    return `This ends your free trial today. To pay nothing today, keep your trial: Pro starts on ${trialEnds} on its own.`
}

// A failed end of trial leaves everything as it was: Stripe holds the change until the bank says yes.
function trialUnchanged(message: string): string {
    return /nothing was charged/i.test(message) ? `${message} Your trial is unchanged.` : `${message} Nothing was charged and your trial is unchanged.`
}

function parkedLabel(parked: CheckoutContext['parked']): string {
    if (!parked) return 'Your coworker'
    return parked.agentCount > 1 ? `${parked.title} · ${parked.agentCount} coworkers` : parked.title
}

// `trial_card_pay_now` is not a route: it is the trial screen once the user asks to pay before the end.
export type CheckoutCopyKey = CheckoutVariant | 'trial_card_pay_now'

function trialTimeline(trialEnds: string, context: CheckoutContext): TimelineStep[] {
    if (context.trialCancelled) return [{ when: 'Today', title: 'Trial running', detail: '$0 today' }, { when: trialEnds, title: 'Trial ends', detail: 'Nothing charged' }]
    return [
        { when: 'Today', title: 'Trial running', detail: '$0 today' },
        ...(context.reminderOn ? [{ when: context.reminderOn, title: 'Reminder by email', detail: 'The day before, to decide calmly' }] : []),
        { when: trialEnds, title: 'Pro starts', detail: <>{context.firstCharge}, cancel before and pay nothing</> },
    ]
}

export function checkoutCopy(variant: CheckoutCopyKey, context: CheckoutContext): CheckoutCopy {
    const trialEnds = context.trialEnds ?? 'the end of your trial'
    switch (variant) {
        case 'start_trial':
            return {
                badge: { label: `${TRIAL_DAYS}-day free trial`, tone: 'green' },
                title: 'Start your free trial',
                subtitle: trialChargeLine(context.firstCharge, trialEnds),
                timeline: [
                    { when: 'Today', title: 'Trial starts', detail: `$0 today, ${TRIAL_ACTIVE_AGENTS} coworkers and ${creditsLabel(TRIAL_CREDITS)} of AI usage` },
                    { when: trialEnds, title: 'Pro starts', detail: `${context.firstCharge} charged, unlimited coworkers and ${creditsLabel(BASE_PLAN_CREDITS)} a month` },
                    { when: 'Anytime', title: 'Cancel in a click', detail: 'Reminder the day before' },
                ],
                cta: 'Start free trial',
                footnote: `$0 today. Cancel before ${trialEnds} and you are not charged.`,
            }
        case 'trial_cardless':
            return {
                badge: trialBadge(context),
                title: 'Upgrade to Pro',
                subtitle: 'Everything you built during the trial stays and keeps running.',
                timeline: endTrialTimeline(context),
                cta: 'End trial & subscribe',
            }
        case 'trial_card':
            return {
                badge: trialBadge(context),
                title: 'Your free trial',
                subtitle: context.trialCancelled
                    ? `You cancelled your trial. Your coworkers keep running until ${trialEnds}, and nothing is charged.`
                    : `Nothing to pay today. Pro starts on ${trialEnds} on its own${context.reminderOn ? ', and we email you the day before' : ''}.`,
                timeline: trialTimeline(trialEnds, context),
                cta: 'Upgrade to Pro now',
            }
        case 'trial_card_pay_now':
            return {
                badge: trialBadge(context),
                title: 'Upgrade to Pro',
                subtitle: `The trial runs ${TRIAL_ACTIVE_AGENTS} coworkers. Start Pro now for unlimited coworkers, or let the trial roll into Pro on ${trialEnds}.`,
                timeline: endTrialTimeline(context),
                cta: 'End trial & start Pro now',
                footnote: endTrialFootnote(trialEnds),
            }
        case 'credit_locked':
            return {
                badge: trialBadge(context),
                title: context.coworker ? 'Keep going with Pro' : 'Rerun credits come with Pro',
                subtitle: context.coworker
                    ? `${context.coworker} picks up where it stopped.`
                    : `Your ${TRIAL_CREDITS.toLocaleString('en-US')} trial credits are used up. Pro includes ${creditsLabel(BASE_PLAN_CREDITS)} every month, and you can add more anytime.`,
                timeline: endTrialTimeline(context),
                cta: context.coworker ? 'Pay & resume' : 'End trial & subscribe',
                payCta: context.coworker ? amount => `Pay ${amount} & resume` : undefined,
                refusal: trialUnchanged,
                footnote: 'Close this and nothing is charged. Your trial stays as it is.',
            }
        case 'no_plan':
            return {
                title: 'Subscribe to Pro',
                subtitle: 'Unlimited coworkers, one price. Cancel anytime.',
                timeline: upgradeTimeline(context),
                cta: 'Subscribe',
            }
        case 'complimentary':
            return {
                badge: { label: 'Complimentary access', tone: 'brand' },
                title: 'Subscribe to Pro',
                subtitle: 'Your workspace has complimentary access. Subscribe to add credits on top of it.',
                timeline: upgradeTimeline(context),
                cta: 'Subscribe',
            }
        case 'paused':
            return {
                badge: { label: context.keptUntil ? `Paused · saved until ${context.keptUntil}` : 'Paused', tone: 'orange' },
                title: 'Restart Pro',
                subtitle: 'Your coworkers, memories and files are archived. They come back exactly as you left them.',
                timeline: [{ when: 'Today', title: 'Restore starts', detail: 'Coworkers back in a minute' }, { when: context.nextInvoice, title: 'Next invoice', detail: <>{context.billed}, excl. VAT</> }, CANCEL_STEP],
                cta: 'Restart Pro',
            }
        case 'template':
            return {
                badge: { label: parkedLabel(context.parked), tone: 'brand' },
                title: 'Get Pro to install it',
                subtitle: 'It is ready. It lands on your board the moment you subscribe.',
                timeline: [
                    { when: 'Today', title: 'It installs', detail: context.parked && context.parked.agentCount > 1 ? `${context.parked.agentCount} coworkers placed` : 'Placed on your board' },
                    { when: context.nextInvoice, title: 'Next invoice', detail: <>{context.billed}, excl. VAT</> },
                    CANCEL_STEP,
                ],
                cta: 'Subscribe',
            }
    }
}
