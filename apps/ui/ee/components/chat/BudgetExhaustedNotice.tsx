'use client'

import { toast } from 'sonner'

import { setRerunCreditPausedAction } from '@/ee/actions/billing.actions'
import { NoticeActions, type NoticeAction } from '@/components/chat/NoticeActions'
import { Button } from '@/components/ui/button'
import { Icon } from '@/components/ui/icon'
import { ProviderIcon } from '@/lib/engine/provider-icons'
import { useBillingStore } from '@/stores/billing.store'
import { BorderBeam } from '@rerun/ui'
import { ArrowRightIcon, CheckIcon, CoinsIcon, CreditCardIcon, PauseIcon, Play, ZapOffIcon } from '@/lib/icons'
import { usd } from '@/ee/components/dialogs/billing/parts'
import { BASE_PLAN_CREDITS, DEFAULT_PRICE_ARM, TRIAL_CREDITS, ZERO_QUANTITIES, creditsLabel, planPriceCents, type PriceArm } from '@/ee/lib/billing/plans'
import { NOTICE_PERKS } from '@/ee/lib/billing/pro-perks'

type SubscriptionProvider = 'claude' | 'codex'

// `onConnectProvider` opens the workspace's AI providers on the sign-in of the plan that was picked.
// A chat with no board behind it has nowhere to send the user, so it leaves the two buttons out
// rather than showing dead ones, and the notice is down to its one paid way out.
//
// `preTrial` is the foreman's case: the credit that just ran out is the signup allowance, a top-up
// that does not come back, on a workspace with no plan. Telling that user about a monthly reset and
// selling them credits would be wrong twice. Passed in rather than read from the session, so the
// notice keeps rendering in the UI kit, outside every provider.
//
// `trialing` is the same signup allowance running out during the trial: it does not reset either,
// and credit packs are not sold on a trial. What opens more is the plan itself, paid today.
//
// `paused` is a member having turned the credit off: the hub answers the same 402, but nothing ran
// out, and the one way out is turning it back on.
// `ownConnection` is a Claude or ChatGPT plan already connected to the Box while this conversation
// still ran on Rerun: inviting to connect it again would only sign in once more and change nothing.
// Running the conversation on it is the way out that works.
//
// `noCredit` is a workspace that never had any Rerun credit, such as a workspace added before its
// plan: nothing was used up, so the notice does not say it was.
//
// On a trial, `coworker` names who stopped, `onPaid` hands the checkout a way to pick the task back
// up, and `resuming` is the moment between paying and the plan landing, when the notice turns into
// the receipt. `onResumeNow` is the hand-held way back if that moment drags on.
export type BudgetNoticeOwnConnection = { label: string; provider: string; onUse: () => void }

type TrialUpgrade = { coworker?: string; priceArm?: PriceArm; onPaid?: () => void; resuming?: boolean; onResumeNow?: () => void }

export function BudgetExhaustedNotice({
    onConnectProvider,
    ownConnection,
    preTrial,
    trialing,
    paused,
    noCredit,
    ...upgrade
}: { onConnectProvider?: (provider: SubscriptionProvider) => void; ownConnection?: BudgetNoticeOwnConnection; preTrial?: boolean; trialing?: boolean; paused?: boolean; noCredit?: boolean } & TrialUpgrade) {
    const openBilling = useBillingStore(s => s.openBilling)

    if (paused) {
        const resume = async () => {
            const result = await setRerunCreditPausedAction(false)
            if (!result.ok) toast.error(result.error)
        }
        return (
            <div className="relative mb-2 space-y-2.5 overflow-hidden rounded-lg px-4 pt-3 pb-4">
                <BorderBeam animated pattern="arcs" tone="orange" glow width={1} duration={7} />
                <div className="flex items-center gap-2.5 text-sm">
                    <Icon size="sm" tone="orange" icon={PauseIcon} />
                    <span className="font-medium">Rerun credits paused</span>
                </div>
                <p className="text-sm">Your coworkers can&apos;t use Rerun models or paid data until someone resumes them.</p>
                <NoticeActions actions={[{ key: 'resume', leading: <Icon icon={Play} size="sm" />, title: 'Resume Rerun credits', description: 'Spending starts again right away.', cta: 'Resume', onClick: resume }]} />
            </div>
        )
    }

    if (preTrial) {
        return (
            <div className="relative mb-2 space-y-2.5 overflow-hidden rounded-lg px-4 pt-3 pb-4">
                <BorderBeam animated pattern="arcs" tone="red" glow width={1} duration={7} />
                <div className="flex items-center gap-2.5 text-sm">
                    <Icon size="sm" tone="red" icon={ZapOffIcon} className="bg-red-500/10 text-foreground" />
                    <span className="font-medium">Rerun credits</span>
                </div>
                <p className="text-sm">You&apos;ve used up the {creditsLabel(TRIAL_CREDITS)} that come with a new account. Subscribing is what opens the rest.</p>
                <NoticeActions actions={[{ key: 'trial', leading: <Icon icon={CreditCardIcon} size="sm" />, title: 'Subscribe now', description: 'Your coworkers keep working, cancel any time.', cta: 'Subscribe', onClick: () => openBilling(undefined, 'budget_exhausted_pre_trial') }]} />
            </div>
        )
    }

    if (trialing && !noCredit) return <TrialUpgradeNotice {...upgrade} onConnectProvider={onConnectProvider} ownConnection={ownConnection} />

    // A workspace with no credit at all has no month that will refill it: what opens credit is the plan.
    const paidWayOut: NoticeAction = trialing || noCredit
        ? {
              key: 'plan',
              leading: <Icon icon={CreditCardIcon} size="sm" />,
              title: 'Subscribe now',
              cta: 'Subscribe',
              description: trialing ? `Ends your trial today. ${creditsLabel(BASE_PLAN_CREDITS)} included every month.` : `${creditsLabel(BASE_PLAN_CREDITS)} included every month.`,
              onClick: () => openBilling(undefined, trialing ? 'budget_exhausted_trial' : 'budget_exhausted'),
          }
        : {
              key: 'credits',
              leading: <Icon icon={CoinsIcon} size="sm" />,
              title: 'Top up your Rerun credits',
              cta: 'Top up',
              description: 'Or wait, it resets next month.',
              onClick: () => openBilling('credit_pack', 'budget_exhausted'),
          }
    const usedUp = noCredit ? 'This workspace has no Rerun credits yet.' : trialing ? `You've used up the ${creditsLabel(TRIAL_CREDITS)} of your free trial.` : "You've used up your Rerun credits for this period."

    return (
        <div className="relative mb-2 space-y-2.5 overflow-hidden rounded-lg px-4 pt-3 pb-4">
            <BorderBeam animated pattern="arcs" tone="red" glow width={1} duration={7} />
            <div className="flex items-center gap-2.5 text-sm">
                <Icon size="sm" tone="red" icon={ZapOffIcon} className="bg-red-500/10 text-foreground" />
                <span className="font-medium">Rerun credits</span>
            </div>
            {ownConnection ? (
                <>
                    <p className="text-sm">
                        {usedUp} This conversation ran on Rerun, and your {ownConnection.label} plan is connected.
                    </p>
                    <Button size="sm" className="w-full" onClick={ownConnection.onUse}>
                        <ProviderIcon provider={ownConnection.provider} className="size-3.5" />
                        <span className="truncate">Run on {ownConnection.label}</span>
                    </Button>
                    <div className="flex items-center gap-2 text-xs uppercase">
                        <span className="flex-1 border-t" />
                        <span className="text-muted-foreground">Or</span>
                        <span className="flex-1 border-t" />
                    </div>
                    <NoticeActions actions={[{ ...paidWayOut, variant: 'outline' }]} />
                </>
            ) : onConnectProvider ? (
                <>
                    <p className="text-sm">{usedUp} Already paying for Claude or ChatGPT? Run your coworkers on that plan, at no extra cost here.</p>
                    <div className="grid grid-cols-2 gap-2">
                        <Button size="sm" onClick={() => onConnectProvider('claude')}>
                            <ProviderIcon provider="claude" className="size-3.5" />
                            Connect Claude
                        </Button>
                        <Button size="sm" onClick={() => onConnectProvider('codex')}>
                            <ProviderIcon provider="openai" className="size-3.5" />
                            Connect ChatGPT
                        </Button>
                    </div>
                    <div className="flex items-center gap-2 text-xs uppercase">
                        <span className="flex-1 border-t" />
                        <span className="text-muted-foreground">Or</span>
                        <span className="flex-1 border-t" />
                    </div>
                    <NoticeActions actions={[{ ...paidWayOut, variant: 'outline' }]} />
                </>
            ) : (
                <>
                    <p className="text-sm">{trialing || noCredit ? `${usedUp} Subscribe to keep your coworkers working.` : `${usedUp} It resets next month.`}</p>
                    <NoticeActions actions={[paidWayOut]} />
                </>
            )}
        </div>
    )
}

function TrialUpgradeNotice({ coworker, priceArm = DEFAULT_PRICE_ARM, onPaid, resuming, onResumeNow, onConnectProvider, ownConnection }: TrialUpgrade & { onConnectProvider?: (provider: SubscriptionProvider) => void; ownConnection?: BudgetNoticeOwnConnection }) {
    const openBilling = useBillingStore(s => s.openBilling)

    if (resuming) {
        return (
            <div className="mb-2 flex flex-wrap items-center gap-x-2.5 gap-y-2 px-1 text-sm">
                <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-green-500/15 text-green-500 ring-1 ring-green-500/30">
                    <CheckIcon className="size-3" />
                </span>
                <span className="min-w-0 flex-1">
                    <span className="font-medium">You&apos;re on Pro.</span> <span className="text-muted-foreground">{coworker ?? 'Your coworker'} picks the task back up.</span>
                </span>
                {onResumeNow && (
                    <Button size="xs" variant="outline" onClick={onResumeNow}>
                        Resume
                    </Button>
                )}
            </div>
        )
    }

    const monthly = usd(planPriceCents(ZERO_QUANTITIES, 'monthly', priceArm))
    return (
        <div className="relative mb-2 space-y-3 overflow-hidden rounded-lg px-4 pt-3 pb-4">
            <BorderBeam animated pattern="arcs" tone="red" glow width={1} duration={7} />
            <div className="flex items-start gap-2.5">
                <Icon size="sm" tone="red" icon={ZapOffIcon} className="bg-red-500/10 text-foreground" />
                <div className="min-w-0 text-sm">
                    <p className="font-medium">Trial credits used up</p>
                    {coworker && <p className="text-muted-foreground">{coworker} stopped.</p>}
                </div>
            </div>
            <Button size="lg" className="w-full" onClick={() => openBilling(undefined, 'budget_exhausted_trial', { coworker, onPaid })}>
                <span className="truncate">Continue with Pro · {monthly}/mo</span>
                <ArrowRightIcon className="size-3.5" />
            </Button>
            <ul className="flex flex-wrap justify-center gap-x-4 gap-y-1">
                {NOTICE_PERKS.map(perk => (
                    <li key={perk.id} className="flex items-center gap-1.5 text-xs">
                        <CheckIcon className="size-3.5 shrink-0 text-green-500" />
                        {perk.headline}
                    </li>
                ))}
            </ul>
            {ownConnection ? (
                <div className="flex justify-center">
                    <Button size="xs" variant="ghost" className="max-w-full text-muted-foreground" onClick={ownConnection.onUse}>
                        <ProviderIcon provider={ownConnection.provider} className="size-3" />
                        <span className="truncate">Run on {ownConnection.label}</span>
                    </Button>
                </div>
            ) : (
                onConnectProvider && (
                    <div className="flex flex-wrap items-center justify-center gap-x-1 gap-y-1 text-xs text-muted-foreground">
                        <span>Or use my plan:</span>
                        <Button size="xs" variant="ghost" className="text-muted-foreground" onClick={() => onConnectProvider('claude')}>
                            <ProviderIcon provider="claude" className="size-3" />
                            Claude
                        </Button>
                        <Button size="xs" variant="ghost" className="text-muted-foreground" onClick={() => onConnectProvider('codex')}>
                            <ProviderIcon provider="openai" className="size-3" />
                            ChatGPT
                        </Button>
                    </div>
                )
            )}
        </div>
    )
}
