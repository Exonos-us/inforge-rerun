'use client'

import { OWN_ENTRY } from '@/components/foreman/intake/copy'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Gauge } from '@/components/ui/gauge'
import { Icon } from '@/components/ui/icon'
import { readStarterPack, readStarterPackAnswer, type StarterPackAnswer, type StarterPackCard } from '@/lib/foreman/starter-pack'
import { MAX_STARTER_PICKS } from '@/lib/onboarding/starter-packs'
import { ArrowRight, CircleCheckIcon, LockIcon } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { StarterPackRail } from './StarterPackRail'
import { useStarterPicks } from './useStarterPicks'

// The starter pack of their industry, put up by the app right after the welcome card: the coworkers
// a company like theirs starts with, up to three of them picked off their cards, or one line saying
// what they need instead, written in the composer that stays under the cards (ForemanColumn).
// Picking is the plan: nothing is asked after it but the trial.

type StarterPackWidgetProps = {
    input: unknown
    output?: unknown
    onAnswer: (answer: StarterPackAnswer) => void
}

export function StarterPackWidget({ input, output, onAnswer }: StarterPackWidgetProps) {
    const { cards } = readStarterPack(input)
    const answered = readStarterPackAnswer(output)

    if (answered) return <StarterPackVerdict cards={cards} answer={answered} />
    return <StarterPackPicker cards={cards} onAnswer={onAnswer} />
}

function StarterPackPicker({ cards, onAnswer }: { cards: StarterPackCard[]; onAnswer: (answer: StarterPackAnswer) => void }) {
    const picks = useStarterPicks()
    const count = picks.picked.length

    return (
        <div className="mb-2 flex flex-col gap-3">
            <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 flex-col gap-0.5">
                    <p className="text-sm font-medium text-foreground">Your starter team</p>
                    <p className="text-xs text-muted-foreground">Pick up to {MAX_STARTER_PICKS}. Each one sets itself up with you once it is on your board.</p>
                </div>
                <PickProgress count={count} />
            </div>

            <StarterPackRail cards={cards} picks={picks} />

            {picks.blocked && (
                <Alert variant="warning" stripes className="grid-cols-[auto_1fr] gap-x-3 gap-y-0">
                    <Icon icon={LockIcon} size="sm" className="row-span-2 self-center" />
                    <AlertTitle className="col-start-2 leading-tight">Your trial runs {MAX_STARTER_PICKS} coworkers</AlertTitle>
                    <AlertDescription className="col-start-2 leading-snug">Drop one to take this one instead. The others can join once you are on a plan.</AlertDescription>
                </Alert>
            )}

            <div className="flex justify-end">
                <Button size="sm" disabled={!count} onClick={() => onAnswer({ answered: true, chosen: picks.picked })} className="max-sm:w-full">
                    {count === 0 ? 'Pick at least one' : count === 1 ? 'Hire this one' : `Hire these ${count}`}
                    {count > 0 && <ArrowRight data-icon="inline-end" className="size-3.5" />}
                </Button>
            </div>
        </div>
    )
}

// The places the trial holds, filling as cards are picked: read before the fourth card is tried.
function PickProgress({ count }: { count: number }) {
    return (
        <div className={cn('flex shrink-0 items-center gap-1.5 text-xs tabular-nums transition-colors', count ? 'text-primary' : 'text-muted-foreground')} aria-label={`${count} of ${MAX_STARTER_PICKS} picked`}>
            <Gauge ratio={count / MAX_STARTER_PICKS} complete={count >= MAX_STARTER_PICKS} className="size-6" />
            <span aria-hidden>
                {count}/{MAX_STARTER_PICKS}
            </span>
        </div>
    )
}

// Replayed from the transcript once answered: what was hired, as a line each, rather than an
// invitation to choose again.
function StarterPackVerdict({ cards, answer }: { cards: StarterPackCard[]; answer: StarterPackAnswer }) {
    if (!answer.answered) return null
    const rows = 'custom' in answer ? [{ key: 'custom', title: OWN_ENTRY, line: answer.custom }] : cards.filter(card => answer.chosen.includes(card.slug)).map(card => ({ key: card.slug, title: card.promise, line: card.agent }))

    return (
        <div className="mb-2 flex flex-col gap-1.5 rounded-lg border border-border bg-muted/20 px-3 py-2">
            <p className="text-xs text-muted-foreground">Your starter team</p>
            {rows.map(row => (
                <div key={row.key} className="flex min-w-0 items-start gap-2">
                    <Icon icon={CircleCheckIcon} size="xs" className="mt-0.5 shrink-0 text-emerald-500" />
                    <div className="min-w-0">
                        <p className="text-sm text-foreground">{row.title}</p>
                        <p className="line-clamp-2 text-xs text-muted-foreground">{row.line}</p>
                    </div>
                </div>
            ))}
        </div>
    )
}
