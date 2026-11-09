'use client'

import { useSearchParams } from 'next/navigation'
import { useCallback, useEffect, useRef, useState } from 'react'

import { track } from '@rerun/analytics/client'

import { saveForemanIntakeAction, waiveForemanProfileAction } from '@/app/api/_actions/foreman-intake.actions'
import { readArrivingIntent } from '@/lib/foreman/arriving-intent'
import { buildKickoffMarker, buildOwnKickoff, encodeIntent, type KickoffIntent } from '@/lib/foreman/kickoff-marker'
import { type ForemanArrival, type ForemanPhase } from '@/lib/foreman/phase'
import type { ForemanSurface } from '@/lib/foreman/surface'
import { arrivalPreviewPlan, intakePreviewPlan } from '@/lib/onboarding/intake'
import { useForemanStore } from '@/stores/foreman.store'
import { useOnboardingStore } from '@/stores/onboarding.store'
import { useSession } from '@/supabase/session/SessionProvider'

// Who opens the conversation. A first arrival is met by the foreman rather than by an empty board:
// the column opens by itself and the first message is one the user never typed, so the foreman is
// the one who speaks first.
//
// With one exception, and it is the common one: a workspace still in `discover` is met by the
// welcome card instead, which asks the three questions the model used to ask one round trip at a
// time. Nothing is sent while it is up, so the foreman costs nothing and thinks nothing until it is
// answered, and `start` is what the card calls on its way out. A first arrival always lands there,
// link or no link: what they came in with is named on the card, then honoured once they answered.
//
// Everyone else is left alone: the phase comes back `companion` for any workspace that is already
// running, and the column only learns which foreman it talks to, the one on the engine, or none at
// all when the workspace has no machine.
//
// An anonymous visitor gets the card too, and nothing past it: the answers are parked in the
// onboarding store and the account wall takes over. The phase is asked again once the session is a
// real account, which is when the parked answers are written, to whichever workspace they signed
// into, and the foreman is woken up.
type ForemanStateAnswer = { phase: ForemanPhase; firstName?: string; arrival?: ForemanArrival | null; surface: ForemanSurface }

async function fetchForemanState(query = ''): Promise<ForemanStateAnswer | null> {
    const res = await fetch(`/api/chat/foreman/state${query}`)
    return res.ok ? ((await res.json()) as ForemanStateAnswer) : null
}

/**
 * Asks again which foreman the workspace talks to: once the build has claimed the machine, or when a
 * foreman turned a message away because the workspace moved on under an open tab.
 */
export async function refreshForemanSurface(): Promise<void> {
    const state = await fetchForemanState().catch(() => null)
    if (!state) return
    useForemanStore.getState().setSurface(state.surface)
    if (state.phase === 'companion') useForemanStore.getState().setFunnel('companion')
}

// A ready-made arrival is never asked the welcome card after its install: the coworker's own chat is
// already asking what it needs, and a second questionnaire beside it read as two chats at once.
async function skipOwedWelcomeCard(): Promise<void> {
    await waiveForemanProfileAction().catch(() => {})
    const store = useForemanStore.getState()
    store.setArrival(null)
    store.setFunnel('companion')
    await refreshForemanSurface()
}

/**
 * Where a build that just landed leaves the column. Almost always with the foreman on the engine;
 * a workspace that installed what it arrived on before anyone asked who it is, `skipped`: the welcome
 * card it still owes is given up and the column gets out of the way of the coworker's chat.
 */
export async function settleBuiltFunnel(): Promise<'skipped' | 'companion'> {
    const state = await fetchForemanState().catch(() => null)
    const store = useForemanStore.getState()
    if (state) store.setSurface(state.surface)
    if (state?.phase === 'discover') {
        await skipOwedWelcomeCard()
        return 'skipped'
    }
    store.setArrival(null)
    store.setFunnel('companion')
    return 'companion'
}

export function useForemanKickoff({ send, messageCount, restoreDone }: { send: (text: string) => void; messageCount: number; restoreDone: boolean }) {
    const { workspace, isAnonymous, phoneStep } = useSession()
    const searchParams = useSearchParams()
    const funnel = useForemanStore(state => state.funnel)
    const intake = useForemanStore(state => state.intake)
    const [firstName, setFirstName] = useState<string | null>(null)
    // Ce avec quoi ils sont arrivés, nommé par le serveur. Dans le store et pas ici : la colonne en
    // fait son tunnel tant que ce n'est pas installé, le board le dessine, et les murs de compte et
    // de téléphone lui cèdent la place.
    const arrival = useForemanStore(state => state.arrival)
    // The phase is asked once per identity, not once per mount: signing up upgrades the anonymous
    // session in place, and signing into an existing account swaps the workspace under the column.
    // Either way the answer given to the anonymous visitor no longer holds.
    const identity = workspace ? `${workspace.id}:${isAnonymous ? 'anonymous' : 'account'}` : null
    const asked = useRef<string | null>(null)
    const [settled, setSettled] = useState<string | null>(null)
    const greeted = useRef(false)
    const intent = useRef<KickoffIntent | null>(null)
    // Arrived with a prompt written on the landing: they already said what they want, so the column
    // does not offer them the line under the welcome card, which would replace that prompt.
    const [prompted, setPrompted] = useState(false)
    // The line an anonymous visitor wrote under the welcome card, taken off the parked answers before
    // they are cleared, for `start` to open on once the account exists. Kept even when the answers
    // could not be written: the card is asked again, and the line still holds when it hands over.
    const parkedOwnAsk = useRef<string | null>(null)

    useEffect(() => {
        if (!identity || asked.current === identity) return
        asked.current = identity

        intent.current = readArrivingIntent(searchParams, useOnboardingStore.getState())
        setPrompted(intent.current?.kind === 'prompt')
        const query = intent.current ? `?intent=${encodeURIComponent(encodeIntent(intent.current))}` : ''

        void fetchForemanState(query)
            .then(async state => {
                const store = useForemanStore.getState()
                if (state) store.setSurface(state.surface)
                const onboarding = useOnboardingStore.getState()
                const parked = onboarding.pendingIntake
                // Tout ce qui n'est pas un tunnel rend la main à ce qui existait avant : la fiche
                // d'un lien profond, elle, n'attend que ça pour s'ouvrir. Des réponses parquées par
                // un anonyme qui s'est connecté sur un compte déjà lancé n'ont plus rien à y faire.
                if (!state || state.phase === 'companion') {
                    if (!isAnonymous) onboarding.clearPendingIntake()
                    store.setArrival(null)
                    store.setFunnel('companion')
                    return
                }
                setFirstName(state.firstName?.trim() || null)
                store.setArrival(state.arrival ?? null)
                // Rien n'est encore construit : ce qu'ils ont cliqué est posé sur le board, éteint.
                if (state.arrival && !state.arrival.installed && state.phase !== 'discover') store.setIntakePreview(arrivalPreviewPlan(state.arrival.coworker ?? state.arrival.title))

                // Plus d'engine dans le pool : le mur de waitlist prend l'écran et rien ne part. Les
                // réponses parquées sont quand même écrites, c'est la promesse du gate de compte, et
                // le Foreman les retrouvera quand une machine se libérera.
                if (state.phase === 'waitlist') {
                    if (parked && !isAnonymous) {
                        await saveForemanIntakeAction(parked).catch(() => {})
                        onboarding.clearPendingIntake()
                    }
                    store.setWaitlisted(true)
                    store.setFunnel('companion')
                    track('onboarding_step_viewed', { step: 'waitlist' })
                    return
                }
                store.setWaitlisted(false)

                if (state.phase === 'discover' && parked) {
                    // Déjà répondu, compte pas encore créé : on redessine ce que la carte dessinait et
                    // on laisse le mur de compte faire son travail.
                    if (isAnonymous) {
                        const industry = parked.industry ?? parked.decidedIndustry
                        if (industry) store.setIntakePreview(intakePreviewPlan(industry))
                        store.startFunnel(false)
                        return
                    }
                    const saved = await saveForemanIntakeAction(parked).then(
                        () => true,
                        () => false
                    )
                    parkedOwnAsk.current = onboarding.pendingOwnAsk
                    onboarding.clearPendingIntake()
                    // Des réponses qui n'ont pas pu être écrites se redemandent, plutôt que de laisser
                    // le Foreman écrire un plan sans le profil qu'il relit.
                    store.startFunnel(!saved)
                    track('onboarding_step_viewed', { step: saved ? 'plan' : 'discover' })
                    setSettled(identity)
                    return
                }
                if (!isAnonymous) onboarding.clearPendingIntake()

                // La découverte est une carte, pas une conversation : on l'ouvre et on ne parle pas.
                // Ouvrir sans mémoriser : le tunnel n'est pas un geste de l'utilisateur, il ne
                // décide pas de ce que celui-ci retrouvera aux chargements suivants. Un anonyme n'a
                // droit qu'à la carte : quoi que dise la phase, rien d'autre ne lui parle.
                if (isAnonymous && state.phase !== 'discover') {
                    // Arrivé sur une template ou un partage : la colonne lui demande son compte
                    // elle-même, à la place du mur, avec ce qu'il a cliqué sous les yeux.
                    if (state.phase === 'plan' && state.arrival) {
                        store.startFunnel(false)
                        track('onboarding_started', { mode: 'foreman', arrival: state.arrival.kind })
                        return
                    }
                    store.setFunnel('companion')
                    return
                }
                if (state.phase === 'discover' && state.arrival?.installed) {
                    await skipOwedWelcomeCard()
                    return
                }
                store.startFunnel(state.phase === 'discover')
                // Une vraie première arrivée : un retour de Google ou un reload devant le mur de compte
                // ont déjà des réponses parquées, et sont sortis plus haut.
                if (state.phase === 'discover') track('onboarding_started', { mode: 'foreman', arrival: intent.current?.kind ?? 'none' })
                // Le premier pas du funnel : où l'utilisateur atterrit. Les suivants sont déduits
                // des outils qui se terminent, dans useForemanFunnelAnalytics.
                track('onboarding_step_viewed', { step: state.phase })
                setSettled(identity)
            })
            .catch(() => useForemanStore.getState().setFunnel('companion'))
    }, [identity, isAnonymous, searchParams])

    // `ownAsk`: the line written in the composer under the welcome card. The foreman then opens on
    // the one coworker it describes rather than on the starter pack.
    const start = useCallback((ownAsk?: string) => {
        if (greeted.current) return
        greeted.current = true

        // Le brouillon de la landing est consommé ici, et pas plus tard : sans ça, dès que
        // save_profile stampe l'onboarding, la reprise de HomeContent le voit « onboardé » et crée
        // l'agent dans le dos du Foreman, en plein tunnel. Le slug d'une template et le token d'un
        // partage restent parqués, eux : c'est ce qui tient les autres chemins d'installation.
        if (intent.current?.kind === 'prompt') useOnboardingStore.getState().clearPendingFirstAgent()

        const asked = ownAsk?.trim() || parkedOwnAsk.current
        parkedOwnAsk.current = null
        send(asked ? buildOwnKickoff(asked) : buildKickoffMarker(intent.current))
    }, [send])

    // Only once the column knows what it is holding: a setup picked up mid-way resumes on its own
    // transcript, and a second marker there would restart the greeting on top of it. The card holds
    // it back too, and calls `start` itself once it has written the profile.
    // Never for an anonymous visitor, and never before the phase has been read for the identity in
    // place: right after a signup the funnel is still the one the anonymous visitor was given.
    // Nor while the phone wall is up or may still rise: the foreman waits for the account to be let in.
    useEffect(() => {
        if (funnel !== 'guided' || intake || !restoreDone || messageCount > 0 || isAnonymous || phoneStep !== 'clear' || !identity || settled !== identity) return
        start()
    }, [funnel, intake, restoreDone, messageCount, isAnonymous, phoneStep, identity, settled, start])

    return { start, firstName, arrival, prompted }
}
