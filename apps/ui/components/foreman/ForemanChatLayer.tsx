'use client'

import type { UIMessage } from 'ai'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useScrollFade } from '@rerun/ui/primitives'

import { Conversation, ConversationContent, ConversationScrollButton, type ConversationHandle } from '@/components/ai-elements/conversation'
import { Message, MessageContent } from '@/components/ai-elements/message'
import { ActionApprovalBlock } from '@/components/chat/ActionApprovalBlock'
import { mentionTokensOf } from '@/components/chat/MentionAutocomplete'
import { BudgetExhaustedNotice, usePriceArm } from '@rerun/cloud/billing.client'
import { ChatActivityLoader } from '@/components/chat/ChatActivityLoader'
import { ProviderErrorNotice } from '@/components/chat/ProviderErrorNotice'
import { Skeleton } from '@/components/ui/skeleton'
import type { ReadChatFile } from '@/components/chat/AttachmentLightbox'
import type { FileAccess } from '@/components/chat/FileCard'
import { useArriveByTop } from '@/hooks/useArriveByTop'
import type { ChatErrorKind } from '@/lib/chat-error'
import { hitlKindOf, pendingApprovals, serializeApprovalDecisions } from '@/lib/chat-hitl'
import { summarizePendingHitl } from '@/lib/chat/hitl-cue'
import { hitlCallBefore } from '@/lib/chat/hitl-receipts'
import type { MessageFeedbackRating } from '@rerun/contracts'
import type { RawUrlFor } from '@/lib/files/raw-url'
import { isEngineHitl, type PendingWidget } from '@/lib/foreman/pending-widget'
import type { ForemanNextStep } from '@/lib/foreman/next-steps'
import type { ForemanArrival } from '@/lib/foreman/phase'
import { isForemanWidgetTool } from '@/lib/foreman/tool-defs'
import { cn } from '@/lib/utils'
import { isSubscriptionEntitled } from '@rerun/cloud/billing'
import { useSession } from '@/supabase/session/SessionProvider'

import { isKickoffText, stripKickoff } from '@/lib/foreman/kickoff-marker'

import { ForemanTeamEmptyStateSlot } from './empty-state/ForemanTeamEmptyStateSlot'
import { ForemanNextSteps } from './ForemanNextSteps'
import { ForemanIntakeHeader } from './intake/ForemanIntakeHeader'
import type { ForemanIntakeController } from './intake/useForemanIntake'
import { FloatingMessage } from './FloatingMessage'
import { ForemanActivityIndicator } from './ForemanActivityIndicator'
import { useForemanMentionAgents } from './useForemanMentionAgents'
import { ForemanWelcome } from './ForemanWelcome'
import { EngineQuestionWidget } from './widgets/EngineQuestionWidget'
import { planAgentShortcuts } from './widgets/agent-picks'
import { renderForemanWidget, type AnswerWidget, type DismissWidget } from './widgets/renderForemanWidget'

// De quoi laisser un message entier se dissoudre plutôt que d'en gommer la dernière ligne.
const SCROLL_FADE = 56

type ForemanChatLayerProps = {
    messages: UIMessage[]
    streaming?: boolean
    /** Le tunnel d'onboarding, où c'est le Foreman qui parle le premier. */
    guided?: boolean
    /**
     * La carte d'accueil, quand elle tient le pied de la colonne. Elle possède alors tout le haut :
     * l'orbe, la question et sa ligne sont au-dessus du cadre, et l'accueil habituel d'une
     * conversation vide (la même orbe, le même genre de titre, quatre suggestions) raconterait la
     * même chose une deuxième fois juste en dessous.
     */
    intake?: ForemanIntakeController | null
    /** Carte répondue par un anonyme : rien ne se prépare tant qu'il n'a pas de compte. */
    gated?: boolean
    /** Ce avec quoi ils sont arrivés, nommé sur la carte d'accueil. Ne sert qu'avec `intake`. */
    arrival?: ForemanArrival | null
    /** La conversation du serveur est arrivée. Avant, une pile vide ne veut encore rien dire. */
    restored: boolean
    error?: { kind: ChatErrorKind; message: string } | null
    // What a widget answers with. Without it the widgets render read-only, which is what a
    // transcript replayed outside the live column needs.
    onWidgetAnswer?: AnswerWidget
    onWidgetDismiss?: DismissWidget
    // The widget the conversation is stopped on. An engine question is drawn after the last message;
    // any other one is already in the stack, inside the message that called it.
    pending?: PendingWidget | null
    // What a finished build leaves to press, drawn after the last message the way an engine question is.
    nextSteps?: ForemanNextStep[]
    onSuggestion?: (text: string) => void
    /** Writes into the composer without sending, for an empty-state action the user finishes typing. */
    onPrefill?: (text: string) => void
    onStop?: () => void
    /** Stops one delegated task of the run being streamed. Absent, the task shows no stop. */
    onStopTask?: (taskId: string) => void
    /** The row under an answer: copy, regenerate, thumbs. Only the foreman on the engine has it. */
    actions?: { onRegenerate: (messageId: string) => void; onRate: (messageId: string, rating: MessageFeedbackRating, messageText: string) => void; ratingOf: (messageId: string) => MessageFeedbackRating | null } | null
    rawUrlFor?: RawUrlFor
    readFile?: ReadChatFile
    sharedFiles?: FileAccess
    /** Ce qui porte la hauteur naturelle de la pile, que la sheet mobile mesure. */
    onStackElement?: (element: HTMLElement | null) => void
    className?: string
}

/**
 * La pile de messages du panneau. Aucun fond à elle : la colonne est posée sur la gouttière, hors de
 * la carte du board, donc un voile translucide n'a rien à laisser voir. Il éclaircissait seulement la
 * gouttière en un rectangle aux bords nets, décalé de l'en-tête et du composer qui, eux, n'en ont pas.
 * Le défilement est celui du chat d'un agent : `Conversation` colle au bas et rend le même bouton de
 * retour en bas.
 */
export function ForemanChatLayer({ messages, streaming, guided, intake, gated, arrival, restored, error, onWidgetAnswer, onWidgetDismiss, pending = null, nextSteps, onSuggestion, onPrefill, onStop, onStopTask, actions, rawUrlFor, readFile, sharedFiles, onStackElement, className }: ForemanChatLayerProps) {
    const { workspace } = useSession()
    const priceArm = usePriceArm()
    const entitled = isSubscriptionEntitled(workspace?.subscription_status)
    // `Conversation` possède son conteneur de défilement : on le récupère par son contexte, une
    // fois monté, pour que le fondu sache ce qu'il reste au-dessus et en dessous.
    const conversationRef = useRef<ConversationHandle | null>(null)
    const [scroller, setScroller] = useState<HTMLElement | null>(null)
    useEffect(() => {
        setScroller(conversationRef.current?.scrollRef.current ?? null)
        onStackElement?.(conversationRef.current?.contentRef.current ?? null)
    }, [onStackElement])
    const scrollMask = useScrollFade(scroller, { fadeSize: SCROLL_FADE })
    const mentionAgents = useForemanMentionAgents()
    const mentions = useMemo(() => mentionTokensOf(mentionAgents, []), [mentionAgents])
    const pendingRef = useArriveByTop(conversationRef, onWidgetAnswer && pending ? pending.toolCallId : null)
    const engineHitl = onWidgetAnswer && pending && isEngineHitl(pending.toolName) ? pending : null
    const engineHitlKind = engineHitl && hitlKindOf(engineHitl.toolName)
    const pendingCue = useMemo(
        () => (engineHitl && engineHitlKind ? { key: engineHitl.toolCallId, summary: summarizePendingHitl(engineHitlKind, (engineHitl.input ?? {}) as Record<string, unknown>), blockRef: pendingRef } : null),
        [engineHitl, engineHitlKind, pendingRef]
    )
    // `null` fait disparaître la part, `undefined` la rend à son étape d'outil normale : la question
    // de l'engine se dessine après le dernier message et sort donc de la pile. Le littéral compte :
    // un composant qui rend `null` laisserait, lui, un nœud vide dans la pile.
    // Un widget du hub garde la même enveloppe qu'il attende ou non : celle qui n'apparaîtrait qu'à
    // la fin du tour le remonterait, et la carte de plan rejouerait sa scène.
    const renderToolPart = onWidgetAnswer
        ? (part: Parameters<typeof renderForemanWidget>[0]) => {
              if (part.toolCallId === engineHitl?.toolCallId) return null
              const widget = renderForemanWidget(part, onWidgetAnswer, onWidgetDismiss, shortcuts)
              if (!widget || !isForemanWidgetTool(part.toolName)) return widget
              return <div ref={part.toolCallId === pending?.toolCallId ? pendingRef : undefined}>{widget}</div>
          }
        : undefined
    // Le message qui lance l'onboarding n'a pas été écrit par l'utilisateur : il ouvre le tour côté
    // modèle et n'a rien à faire dans la pile. Il porte pourtant parfois ce que l'utilisateur a
    // tapé sur la landing, et ça, ça doit se lire : on retire le marqueur au lieu de jeter le
    // message, et on ne jette que ce qu'il ne reste plus rien à afficher.
    const visible = messages.flatMap(message => {
        if (!message.parts.some(part => part.type === 'text' && isKickoffText((part as { text: string }).text))) return [message]
        const parts = message.parts.map(part => (part.type === 'text' ? { ...part, text: stripKickoff((part as { text: string }).text) } : part))
        const emptied = parts.every(part => part.type !== 'text' || !(part as { text: string }).text)
        return emptied ? [] : [{ ...message, parts } as UIMessage]
    })
    // Toutes les lignes de raccourci d'un message tiennent dans une seule carte, posée au premier appel.
    const shortcuts = planAgentShortcuts(visible)

    // Une pile vide veut dire deux choses opposées, et elles ne se rendent pas pareil. En tunnel,
    // elle veut dire que le premier tour n'est pas encore revenu : proposer « What is running in my
    // workspace? » à quelqu'un qui n'a pas de workspace, et le laisser cliquer par-dessus
    // l'onboarding en cours, est un faux départ, donc c'est l'orbe qui tient l'écran. Ailleurs elle
    // veut dire que la conversation du serveur est encore en vol, et ça se dit avec la forme de ce
    // qui va arriver.
    const empty = visible.length === 0 && !error
    // Pas pendant la carte : « Getting your workspace ready... » annonce un tour en vol, et là rien
    // n'est parti. C'est l'en-tête de la carte qui tient l'écran.
    const greeting = empty && guided && !intake
    const restoring = empty && !guided && !restored

    let notice: ReactNode = null
    if (error) {
        notice = (
            <Message from="assistant">
                <MessageContent>
                    {/* Pas de cellule « abonnement » : il n'y a pas de Box derrière le Foreman, donc
                        nulle part où brancher un plan Claude ou ChatGPT. */}
                    {error.kind === 'budget' ? <BudgetExhaustedNotice preTrial={!entitled} trialing={workspace?.subscription_status === 'trialing'} paused={!!workspace?.rerun_credit_paused_at} priceArm={priceArm} /> : <ProviderErrorNotice kind={error.kind} message={error.message} onStopRun={onStop} />}
                </MessageContent>
            </Message>
        )
    }

    return (
        <div className={cn('pointer-events-auto relative w-full', className)} style={{ contain: 'paint' }}>
            {/* Posé par-dessus la pile plutôt que dedans : il la trouve vide, et en sortant il se
                fond sur le premier message qui arrive au lieu de lui disputer la hauteur. */}
            <AnimatePresence>
                {greeting &&
                    (gated ? (
                        <ForemanWelcome key="gate" title="Your team is ready to be built" subtitle="Create your account and the Foreman starts building it right away." />
                    ) : (
                        <ForemanWelcome key="welcome" thinking={streaming} />
                    ))}
                {intake && <ForemanIntakeHeader key="intake" intake={intake} arrival={arrival} />}
            </AnimatePresence>

            <Conversation className="relative z-10 h-full" contextRef={conversationRef}>
                {/* Le fondu porte sur ce calque et pas sur la `Conversation` : le bouton de retour
                    en bas est son frère, ancré au ras du bord où le fondu est le plus fort, et il
                    doit rester net. Le calque ne défile pas, il couvre exactement la fenêtre du
                    conteneur qui défile, donc le fondu reste collé aux bords du panneau. */}
                <div className="h-full" style={{ maskImage: scrollMask, WebkitMaskImage: scrollMask }}>
                    {/* `justify-end` et `min-h-full` : une conversation de deux messages reste collée
                        au composer au lieu de flotter en haut du panneau. Sous `md` la sheet mesure
                        cette pile pour prendre sa hauteur, un `min-h-full` l'empêcherait de jamais
                        redescendre : c'est `mt-auto` qui la colle au composer, et il cède au
                        défilement quand la pile déborde. L'accueil et l'en-tête de la carte sont
                        posés en overlay, sans hauteur à eux : le plancher leur garde la place. Ce
                        plancher explicite rend la pile compressible par le scroller, et la sheet
                        qui la mesure rétrécirait d'un pixel à chaque tour : `shrink-0` l'en garde. */}
                    <ConversationContent
                        scrollClassName="max-md:flex max-md:flex-col md:[container-type:size]"
                        className={cn('justify-end gap-4 px-3 pb-5 max-md:mt-auto max-md:shrink-0 md:min-h-full', guided ? 'pt-12' : 'pt-24', intake || greeting ? 'max-md:min-h-72' : 'max-md:min-h-36')}
                    >
                        {restoring && <ForemanChatSkeleton />}
                        {empty && !greeting && !restoring && !intake ? (
                            <ForemanTeamEmptyStateSlot onSend={onSuggestion} onPrefill={onPrefill} />
                        ) : (
                            visible.map((message, index) => (
                                <FloatingMessage
                                    key={message.id}
                                    message={message}
                                    index={index}
                                    isActive={streaming && index === visible.length - 1}
                                    rawUrlFor={rawUrlFor}
                                    readFile={readFile}
                                    sharedFiles={sharedFiles}
                                    renderToolPart={renderToolPart}
                                    mentions={mentions}
                                    onStopTask={onStopTask}
                                    onRegenerate={engineHitl && index === visible.length - 1 ? undefined : actions?.onRegenerate}
                                    onRateMessage={actions?.onRate}
                                    feedbackRating={actions ? actions.ratingOf(message.id) : undefined}
                                    hitlCall={hitlCallBefore(visible, index)}
                                />
                            ))
                        )}
                        {engineHitl && onWidgetAnswer && (
                            <motion.div key={engineHitl.toolCallId} ref={pendingRef} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.28, ease: [0.4, 0, 0.2, 1] }}>
                                {engineHitl.toolName === 'ask_user' ? (
                                    <EngineQuestionWidget input={engineHitl.input} onAnswer={text => onWidgetAnswer(engineHitl.toolName, engineHitl.toolCallId, text)} onDismiss={onWidgetDismiss && (() => onWidgetDismiss(engineHitl.toolCallId))} />
                                ) : (
                                    <ActionApprovalBlock inline approvals={pendingApprovals((engineHitl.input ?? {}) as Record<string, unknown>)} onSubmit={decisions => onWidgetAnswer(engineHitl.toolName, engineHitl.toolCallId, serializeApprovalDecisions(decisions))} />
                                )}
                            </motion.div>
                        )}
                        {nextSteps && nextSteps.length > 0 && !streaming && (
                            <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.28, ease: [0.4, 0, 0.2, 1] }}>
                                <ForemanNextSteps steps={nextSteps} />
                            </motion.div>
                        )}
                        {/* Pendant l'accueil, le premier tour n'est souvent pas encore parti (le
                            workspace se prépare) : le loader se montre quand même, sinon l'écran a
                            l'air figé jusqu'au premier token. */}
                        {(streaming || (greeting && !gated)) && <ChatActivityLoader message={visible.at(-1)} indicator={<ForemanActivityIndicator />} />}
                        {notice}
                    </ConversationContent>
                </div>
                <ConversationScrollButton pending={pendingCue} />
            </Conversation>
        </div>
    )
}

/**
 * Ce qui tient la pile pendant qu'on va chercher la conversation sur le hub. Posé dans le flux et
 * non en overlay : la pile est collée au composer, donc les bulles fantômes occupent exactement la
 * place où le transcript va atterrir, et rien ne saute à son arrivée. Il se démonte d'un coup,
 * l'entrée en fondu de `FloatingMessage` porte le relais.
 */
function ForemanChatSkeleton() {
    return (
        <div aria-hidden className="flex flex-col gap-4">
            <SkeletonAssistantLines widths={['w-1/2', 'w-5/6', 'w-3/4']} />
            <div className="ml-auto flex w-fit max-w-[95%] flex-col gap-2 rounded-lg bg-secondary px-4 py-3">
                <Skeleton className="h-3.5 w-40" />
                <Skeleton className="h-3.5 w-24" />
            </div>
            <SkeletonAssistantLines widths={['w-2/3', 'w-4/5']} />
        </div>
    )
}

function SkeletonAssistantLines({ widths }: { widths: string[] }) {
    return (
        <div className="flex w-full flex-col gap-2">
            {widths.map(width => (
                <Skeleton key={width} className={cn('h-3.5', width)} />
            ))}
        </div>
    )
}
