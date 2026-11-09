'use client'

import { AnimatePresence, motion } from 'motion/react'
import { useCallback, useLayoutEffect, useRef, useState, type Ref } from 'react'

import { useMentionAutocomplete } from '@/components/chat/MentionAutocomplete'
import { ForemanComposer, type ForemanComposerMentionProps, type ForemanComposerProps } from '@/components/foreman/ForemanComposer'
import { ForemanSignInLink } from '@/components/foreman/ForemanSignInLink'
import { ForemanSignupGate } from '@/components/foreman/ForemanSignupGate'
import { ForemanTrialGate } from '@rerun/cloud/billing.client'
import { useForemanMentionAgents } from '@/components/foreman/useForemanMentionAgents'
import { ForemanIntakeCard } from '@/components/foreman/intake/ForemanIntakeCard'
import type { ForemanIntakeController } from '@/components/foreman/intake/useForemanIntake'
import type { TrialStep } from '@/lib/foreman/next-steps'
import { cn } from '@/lib/utils'
import { useSession } from '@/supabase/session/SessionProvider'

/**
 * Le pied de la colonne. Une question du Foreman attend dans la conversation, comme l'`ask_user`
 * d'un agent dans son panneau : le composer s'efface tant qu'elle est là et revient quand elle est
 * répondue. Il n'y a alors rien d'autre à faire que d'y répondre, et chaque widget porte sa propre
 * sortie (champ libre, Skip, « Not now ») pour que ça reste vrai.
 *
 * Une fois la carte d'essai posée, le composer ne revient plus jusqu'à ce que l'essai tourne : un
 * pied le remplace (`ForemanTrialGate`), sinon le Foreman, gratuit, répondrait à tout ce qui s'écrit.
 *
 * La carte d'accueil tient le pied, et devant tout le reste : elle se joue avant qu'aucun message
 * n'ait été envoyé, donc il ne peut rien y avoir d'autre en attente derrière elle.
 *
 * `ownEntry` : le composer reste sous la carte d'accueil, et sous le starter pack, pour qui sait déjà
 * ce qu'il veut. Ce qui s'y écrit répond à la carte (ForemanColumn choisit où ça part).
 */

// Le repli de hauteur de l'agent sheet, au chiffre près : les deux pieds de panneau doivent se lire
// pareil. `popLayout` est ce qui empêche le composer sortant et la carte entrante de se pousser.
const SLOT_MOTION = {
    initial: { height: 0, opacity: 0 },
    animate: { height: 'auto' as const, opacity: 1 },
    exit: { height: 0, opacity: 0 },
    transition: { duration: 0.28, ease: [0.4, 0, 0.2, 1] as [number, number, number, number] },
}

type ForemanComposerSlotProps = Omit<ForemanComposerProps, keyof ForemanComposerMentionProps> & {
    /** Une question attend dans la conversation : le pied ne porte plus rien. */
    aside: boolean
    /** `null` hors du tunnel, et dès que la carte a rendu ses réponses. */
    intake: ForemanIntakeController | null
    /** Carte répondue par un anonyme : plus rien ne part sans compte. */
    gated: boolean
    /** La carte d'essai est posée et l'essai ne tourne pas encore : plus rien ne part. */
    trialGate: TrialStep | null
    ref?: Ref<HTMLDivElement>
}

export function ForemanComposerSlot({ aside, intake, gated, trialGate, ref, ownEntry = false, ...composer }: ForemanComposerSlotProps) {
    const { isAnonymous } = useSession()
    const bare = aside && !intake && !gated && !trialGate

    const { composerRef } = composer
    const mentionAgents = useForemanMentionAgents()
    // Picking a mention writes `el.value` directly, which fires no React change event.
    const syncComposer = useCallback((text: string) => composerRef.current?.sync(text), [composerRef])
    const { inputRef, menu: mentionMenu, tokens: mentionTokens, textareaProps: mentionTextareaProps } = useMentionAutocomplete(mentionAgents, [], syncComposer)
    const composerShown = intake ? ownEntry : !gated && !trialGate && !aside

    // The composer folds inside an `overflow-hidden` box that would clip the menu, so the menu is
    // placed against the slot itself and sits on the field.
    const mentionMenuAnchorRef = useRef<HTMLDivElement>(null)
    const [mentionMenuTop, setMentionMenuTop] = useState(0)
    const mentionMenuOpen = mentionMenu !== null
    useLayoutEffect(() => {
        const root = mentionMenuAnchorRef.current?.offsetParent
        const input = inputRef.current
        if (!mentionMenuOpen || !root || !input) return
        setMentionMenuTop(input.getBoundingClientRect().top - root.getBoundingClientRect().top)
    }, [mentionMenuOpen, inputRef])

    return (
        // Docké ou flottant, le panneau est une carte à part entière : à partir de `md` le composer
        // y garde sous lui la même marge que sur les côtés.
        // Sous `md` le pied touche le bas de l'écran : il s'assoit sur la barre d'accueil. La
        // bannière cookies, quand elle est là, publie déjà un inset qui inclut la zone sûre, et le
        // panneau le porte, les deux ne s'additionnent donc pas.
        // Vide, il reste monté : c'est lui que la sheet mobile mesure, et il lui garde la zone sûre.
        <div ref={ref} className={cn('relative z-10 px-3', bare ? 'pb-[env(safe-area-inset-bottom)] md:pb-0' : 'pb-[max(0.75rem,env(safe-area-inset-bottom))] md:pb-3')}>
            <AnimatePresence initial={false} mode="popLayout">
                {intake ? (
                    <motion.div key="intake" {...SLOT_MOTION} className="overflow-hidden">
                        {/* Le composer dessous garde sa place : seule la carte défile sur un écran court. */}
                        <div className={cn('overflow-y-auto overscroll-contain', composerShown ? 'max-h-[calc(70svh-7.5rem)]' : 'max-h-[70svh]')}>
                            <ForemanIntakeCard intake={intake} />
                            {isAnonymous && (
                                <div className="pb-2">
                                    <ForemanSignInLink />
                                </div>
                            )}
                        </div>
                    </motion.div>
                ) : gated ? (
                    <motion.div key="gate" {...SLOT_MOTION} className="overflow-hidden">
                        <ForemanSignupGate />
                    </motion.div>
                ) : trialGate ? (
                    <motion.div key="trial-gate" {...SLOT_MOTION} className="overflow-hidden">
                        <ForemanTrialGate step={trialGate} />
                    </motion.div>
                ) : null}
            </AnimatePresence>
            {/* Une seule instance, hors de la bascule ci-dessus : passer de la carte d'accueil au chat
                ne la remonte pas. Deux composers montés le temps d'une sortie se disputaient la ref du
                champ, et celui qui partait la remettait à null sous celui qui arrivait. */}
            <AnimatePresence initial={false} mode="popLayout">
                {composerShown && (
                    <motion.div key="composer" {...SLOT_MOTION} className="overflow-hidden pb-px">
                        <ForemanComposer {...composer} ownEntry={ownEntry} textareaRef={inputRef} textareaProps={mentionTextareaProps} mentionTokens={mentionTokens} />
                    </motion.div>
                )}
            </AnimatePresence>
            {mentionMenu && (
                <div ref={mentionMenuAnchorRef} className="absolute inset-x-3" style={{ top: mentionMenuTop }}>
                    {mentionMenu}
                </div>
            )}
        </div>
    )
}
