'use client'

import { type PointerEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { track } from '@rerun/analytics/client'
import { FOREMAN_AGENT_ID } from '@rerun/contracts'
import { cancelSubRunAction } from '@/app/api/_actions/agent.actions'
import { readFileAction } from '@/app/api/_actions/file.actions'
import { readWorkspaceFileAction } from '@/app/api/_actions/workspace-file.actions'
import { foremanEngineFilesAction, readForemanFileAction } from '@/app/api/_actions/foreman-file.actions'
import { decideIndustryAction, saveForemanIntakeAction } from '@/app/api/_actions/foreman-intake.actions'
import { streamLiveDiscoveries } from '@/components/builder/discoveries/useCompanyDiscoveries'
import type { ChatComposerHandle } from '@/components/chat/ChatComposer'
import { MessageFeedbackDialog } from '@/components/chat/MessageFeedbackDialog'
import { ArrivalHeader, type ArrivalPick } from '@/components/foreman/arrival/ArrivalHeader'
import { ArrivalWall } from '@/components/foreman/arrival/ArrivalWall'
import { arrivalStepOf } from '@/components/foreman/arrival/flow'
import { ForemanChatLayer } from '@/components/foreman/ForemanChatLayer'
import { ForemanHeader } from '@/components/foreman/ForemanHeader'
import { ForemanComposerSlot } from '@/components/foreman/ForemanComposerSlot'
import { ForemanDockResizeHandle } from '@/components/foreman/ForemanDockResizeHandle'
import { ForemanResizeHandle } from '@/components/foreman/ForemanResizeHandle'
import { ForemanRoutines } from '@/components/foreman/ForemanRoutines'
import { FLOAT_CORNER_CLASSES, FLOAT_SIZE_CLASSES, floatSizeStyle } from '@/components/foreman/placement-classes'
import { useForemanDrag } from '@/components/foreman/useForemanDrag'
import { useForemanChat } from '@/components/foreman/useForemanChat'
import { useForemanDockFeed } from '@/components/foreman/useForemanDockFeed'
import { useForemanIntake } from '@/components/foreman/intake/useForemanIntake'
import { readPlan } from '@/components/foreman/widgets/plan-card'
import { useForemanFunnelAnalytics } from '@/components/foreman/useForemanFunnelAnalytics'
import { useForemanKickoff } from '@/components/foreman/useForemanKickoff'
import { useForemanScriptedSteps } from '@/components/foreman/useForemanScriptedSteps'
import { useForemanSheetHeight } from '@/components/foreman/useForemanSheetHeight'
import { useForemanSheetResize } from '@/components/foreman/useForemanSheetResize'
import { useForemanTurnNotification } from '@/components/foreman/useForemanTurnNotification'
import { useMessageFeedback } from '@/hooks/useMessageFeedback'
import { useQueuedMessage } from '@/hooks/useQueuedMessage'
import { isSubscriptionEntitled } from '@rerun/cloud/billing'
import { classifyChatError, unwrapChatError } from '@/lib/chat-error'
import { cn } from '@/lib/utils'
import { shouldFlush } from '@/lib/chat/queued-message'
import { foremanNextSteps, trialStep } from '@/lib/foreman/next-steps'
import { keepsComposer } from '@/lib/foreman/pending-widget'
import { SHOW_STARTER_PACK_TOOL } from '@/lib/foreman/starter-pack'
import { lastShownPlan, lastShownStarterPlan, lastShownTemplatePlan } from '@/lib/foreman/shown-plan'
import { agentFileRawUrl, foremanFileRawUrl, sharedFileRawUrl } from '@/lib/files/raw-url'
import { type ForemanPlacement, dockedForemanSide } from '@/lib/foreman-layout'
import { browserPermission } from '@/lib/notifications/browser'
import { intakePreviewPlan, type ForemanIntake } from '@/lib/onboarding/intake'
import { useBoardCoverStore } from '@/stores/board-cover.store'
import { useForemanStore } from '@/stores/foreman.store'
import { useTemplateFlowStore } from '@/stores/template-flow.store'
import { templateCardImage } from '@/lib/templates/card-image'
import { useNotificationsStore } from '@/stores/notifications.store'
import { useOnboardingStore } from '@/stores/onboarding.store'
import { useSession } from '@/supabase/session/SessionProvider'

const TRANSITION_MS = 300

// `open` vaut `null` tant que la préférence n'est pas tranchée, le temps de l'hydratation : la piste
// de grille s'ouvre quand même (le défaut desktop), mais le panneau reste hors de la tabulation, au
// cas où l'écran serait un téléphone — là le calque est translaté hors champ.
export function ForemanColumn({ open, placement }: { open: boolean | null; placement: ForemanPlacement }) {
    const sessionId = useForemanStore(state => state.sessionId)
    const guided = useForemanStore(state => state.funnel === 'guided')
    // Le tunnel guidé n'affiche pas de tabs : un onglet resté ouvert avant ne doit pas y cacher le chat.
    const onRoutines = useForemanStore(state => state.tab === 'routines') && !guided
    const intakeOpen = useForemanStore(state => state.intake)
    const { isAnonymous, workspace, phoneStep } = useSession()
    const pendingIntake = useOnboardingStore(state => state.pendingIntake)
    const gated = isAnonymous && pendingIntake !== null && !intakeOpen
    const { messages, sendMessage, status, error, stop, regenerate, answerWidget, dismissWidget, pendingWidget, restoreDone, composerBackend, backend, contextStats, runError, reconnecting, activeRunId } = useForemanChat()
    const busy = status === 'submitted' || status === 'streaming' || reconnecting

    // Ce que le board dessine à gauche pendant tout le tunnel. L'organisation vit dans le transcript
    // et non dans un state à nous, donc elle survit à « Looks good », au checkout et au rechargement.
    // La clé est le plan sérialisé parce que `messages` change à chaque token : sans elle, le board
    // reconstruirait sa scène des dizaines de fois par message.
    const planKey = useMemo(() => {
        const input = lastShownPlan(messages) ?? lastShownTemplatePlan(messages) ?? lastShownStarterPlan(messages)
        return input ? JSON.stringify(input) : null
    }, [messages])
    const shownPlan = useMemo(() => (planKey ? readPlan(JSON.parse(planKey)) : null), [planKey])
    useEffect(() => {
        useForemanStore.getState().setPlanPreview(shownPlan)
    }, [shownPlan])

    const { queued, restoredId: restoredQueuedId, enqueue: enqueueMessage, clear: clearQueued } = useQueuedMessage('foreman')
    const composerRef = useRef<ChatComposerHandle | null>(null)
    const startNewChat = useCallback(() => {
        useForemanStore.getState().newChat()
        composerRef.current?.focus()
    }, [])
    const [uploading, setUploading] = useState(false)
    const [stopping, setStopping] = useState(false)

    // The kickoff marker goes through here too, and the store turns it away like every message of
    // the funnel: the browser notification permission is only asked once the onboarding is over.
    const askNotificationPermission = useNotificationsStore(state => state.askPermission)
    // What the last send carried, and whether it came from the queue: a conversation that refuses
    // the message has to give it back rather than swallow it.
    const lastSent = useRef<{ text: string; queued: boolean } | null>(null)
    const send = useCallback(
        (text: string) => {
            if (browserPermission() === 'default') askNotificationPermission()
            const accepted = sendMessage({ text })
            if (accepted) lastSent.current = { text, queued: false }
            return accepted
        },
        [sendMessage, askNotificationPermission]
    )
    // Typed while the turn was about to resume on its own: it leaves right after, like a message
    // typed during the turn.
    const sendOrQueue = useCallback(
        (text: string) => {
            if (!send(text)) enqueueMessage(text, null)
        },
        [send, enqueueMessage]
    )
    // A draft already in the composer wins: `restore` leaves it alone and the action only focuses it.
    const prefill = useCallback((text: string) => {
        composerRef.current?.restore(text)
        composerRef.current?.focus()
    }, [])
    // Un nouvel arrivant n'a rien à taper : le Foreman ouvre sa colonne et parle le premier. Sauf en
    // découverte, où c'est la carte d'accueil qui tient l'écran et `start` qui attend qu'elle ait
    // fini.
    const { start, firstName, arrival, prompted } = useForemanKickoff({ send, messageCount: messages.length, restoreDone })

    // La carte écrit le profil elle-même, donc quand elle rend la main la phase est déjà `plan` : le
    // kickoff fait monter le starter pack de leur industrie, sans un tour de modèle. Arrivé sur un
    // template ou un partage, c'est la carte du lien qui monte à sa place.
    //
    // Un anonyme n'écrit rien : ses réponses sont parquées, la carte se ferme et c'est un bouton de
    // création de compte qui prend la place du composer. Le kickoff les écrit une fois le compte créé.
    const intakeHandlers = useMemo(
        () => ({
            onDecideIndustry: (input: string) => decideIndustryAction(input),
            onAnalyzeSite: (url: string) => void streamLiveDiscoveries(url).then(ok => track('onboarding_company_analyzed', { ok })),
            onSubmit: async (intake: ForemanIntake, ownAsk?: string) => {
                const industry = intake.industry ?? intake.decidedIndustry
                track('onboarding_website_submitted', industry ? { provided: !!intake.companyUrl, industry } : { provided: !!intake.companyUrl })
                track('onboarding_step_completed', { step: 'discover' })
                if (isAnonymous) {
                    useOnboardingStore.getState().setPendingIntake(intake, ownAsk)
                    useForemanStore.getState().closeIntake()
                    return
                }
                // The full read of the site can file them under another industry than the one the
                // board has been drawing, and the plan lays out the Boxes of the stored one.
                const saved = await saveForemanIntakeAction(intake).catch(err => {
                    // The composer already let go of the line: it goes back where they wrote it.
                    if (ownAsk) composerRef.current?.restore(ownAsk)
                    throw err
                })
                useForemanStore.getState().setIntakePreview(intakePreviewPlan(saved.industry))
                useForemanStore.getState().closeIntake()
                track('onboarding_step_viewed', { step: 'plan' })
                // A line written under the card is the plan: the funnel counts it off the kickoff that
                // carries it (useForemanFunnelAnalytics), as it counts a line written over the pack.
                start(ownAsk)
            },
        }),
        [isAnonymous, start]
    )
    const intake = useForemanIntake({ firstName, handlers: intakeHandlers })

    // Le composer reste sous la carte d'accueil et sous le starter pack : ce qui s'y écrit est le
    // coworker qu'ils veulent. Sous la carte il coupe court aux questions, sous le pack il y répond
    // comme une carte choisie. Pas sous la carte d'un lien : ils sont venus pour ce qu'il installe.
    // Ni sous celle d'un prompt écrit sur la landing : ils l'ont déjà dit, la ligne l'écraserait.
    const packPending = pendingWidget?.toolName === SHOW_STARTER_PACK_TOOL ? pendingWidget : null
    const ownEntry = (intakeOpen && !arrival && !prompted) || !!packPending
    const sendFromComposer = useCallback(
        (text: string) => {
            if (intakeOpen) {
                // The field is already empty when a line is refused (a first one still saving).
                if (!intake.sendOwn(text)) composerRef.current?.restore(text)
                return
            }
            if (packPending) return answerWidget(packPending.toolName, packPending.toolCallId, { answered: true, custom: text.trim() })
            sendOrQueue(text)
        },
        [intakeOpen, intake, packPending, answerWidget, sendOrQueue]
    )

    // Arrived on a template or a shared coworker: until it is installed the column is its tunnel.
    // The account and the phone code take the whole of it, the rest is the conversation itself,
    // where the trial, the purchase and the build already live.
    const arrivalStep = guided && arrival && !arrival.installed ? arrivalStepOf({ isAnonymous, phonePending: phoneStep === 'pending', messages }) : null
    const arrivalWall = arrivalStep === 'account' || arrivalStep === 'phone' ? arrivalStep : null
    const linkTemplate = useTemplateFlowStore(state => state.linkTemplate)
    const arrivalPick = useMemo<ArrivalPick | null>(() => {
        if (!arrival) return null
        const template = arrival.kind === 'template' && linkTemplate?.title === arrival.title ? linkTemplate : null
        return template ? { title: arrival.title, name: arrival.coworker, by: template.creator?.name, image: templateCardImage(template), connectors: template.connectors } : { title: arrival.title, name: arrival.coworker }
    }, [arrival, linkTemplate])
    // Le tunnel se lit dans les outils qui passent : plus de stepper à instrumenter depuis que
    // c'est une conversation.
    const entitled = isSubscriptionEntitled(workspace?.subscription_status)
    useForemanFunnelAnalytics({ messages, guided, restoreDone, entitled })
    useForemanScriptedSteps({ messages, status, guided, restoreDone, send })
    useForemanTurnNotification({ messages, status, guided })
    const nextSteps = useMemo(() => foremanNextSteps(messages, { entitled }), [messages, entitled])
    const trialGate = useMemo(() => (guided ? trialStep(messages, { entitled }) : null), [guided, messages, entitled])

    // Une étape de la checklist du board, confiée depuis l'extérieur de la colonne. Elle attend la
    // conversation restaurée et un tour fini, puis s'y ajoute : jamais un nouveau chat, qui perdrait
    // ce que le Foreman sait déjà et ferait la course avec la restauration. Hors du tunnel seulement,
    // la pastille n'existant qu'en companion.
    const pendingPrompt = useForemanStore(state => state.pendingPrompt)
    const companion = useForemanStore(state => state.funnel === 'companion')
    useEffect(() => {
        if (!pendingPrompt || !restoreDone || busy || !companion) return
        if (send(pendingPrompt)) useForemanStore.getState().clearPendingPrompt()
    }, [pendingPrompt, restoreDone, busy, companion, send])

    // Sur le hub, couper le flux suffit : la boucle meurt avec lui. Sur l'engine, `stop` annule aussi
    // le run là-bas.
    const handleStop = useCallback(() => void stop(), [stop])

    const displayedError = runError || error ? unwrapChatError(runError ?? error?.message) : null
    const noticeError = useMemo(() => (displayedError === null ? null : { kind: classifyChatError(displayedError), message: displayedError }), [displayedError])
    useForemanDockFeed({ messages, busy, open: open === true, pending: pendingWidget, failed: displayedError !== null })

    // ⌘K lands in whichever composer is on screen: this one once the column is open, the pill's
    // otherwise. A request made while the column was closed belongs to the pill and stays there.
    const focusRequest = useForemanStore(state => state.composerFocusRequest)
    const handledFocusRequest = useRef(focusRequest)
    useEffect(() => {
        if (handledFocusRequest.current === focusRequest) return
        handledFocusRequest.current = focusRequest
        if (open) composerRef.current?.focus()
    }, [focusRequest, open])

    // L'orbe en tête de colonne est décorative : Escape et le bouton de l'en-tête sont les deux
    // seules sorties, et le tunnel les condamne toutes les deux : la carte d'accueil vit ici. Ouvrir un agent ne fait que mettre la colonne en retrait (BoardChatSplit) :
    // elle revient quand sa sheet se referme.
    useEffect(() => {
        if (!open || guided) return
        // Un Escape tapé dans une dialog ouverte par-dessus (le compte, le checkout) ferme la dialog,
        // pas la colonne d'où elle a été ouverte.
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key !== 'Escape' || (event.target instanceof Element && event.target.closest('[role="dialog"], [role="alertdialog"], [role="menu"]'))) return
            useForemanStore.getState().close()
        }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
    }, [open, guided])

    // Le message en attente part dès que le tour en cours est fini, comme dans le chat d'un agent.
    const flushingRef = useRef<string | null>(null)
    useEffect(() => {
        if (status !== 'streaming' && status !== 'submitted') flushingRef.current = null
    }, [status])

    const canFlush = shouldFlush({ queued, busy, uploading, status, hasError: displayedError !== null })
    useEffect(() => {
        if (!canFlush || !queued || flushingRef.current) return
        if (!sendMessage({ text: queued.text }, { queued: true })) return
        flushingRef.current = queued.id
        lastSent.current = { text: queued.text, queued: true }
        clearQueued()
    }, [canFlush, queued, clearQueued, sendMessage])

    // The engine refused the send because the conversation still holds a run. A queued message goes
    // back to waiting, it left on its own and will leave on its own again; a typed one goes back to
    // the composer the user is still looking at.
    useEffect(() => {
        if (!error || classifyChatError(unwrapChatError(error.message)) !== 'run_in_flight') return
        const sent = lastSent.current
        lastSent.current = null
        if (!sent) return
        if (sent.queued) enqueueMessage(sent.text, null)
        else composerRef.current?.restore(sent.text)
    }, [error, enqueueMessage])

    // Un message trouvé en attente à l'ouverture ne part jamais tout seul : le tour derrière lequel
    // il patientait est mort avec le flux, donc il retourne dans le composer plutôt que de surgir
    // des jours plus tard.
    useEffect(() => {
        if (!open || !queued || queued.id !== restoredQueuedId || busy || flushingRef.current || stopping) return
        if (!composerRef.current?.restore(queued.text)) return
        clearQueued()
    }, [open, queued, restoredQueuedId, busy, stopping, clearQueued])

    const sendQueuedNow = useCallback(async () => {
        if (!queued) return
        setStopping(true)
        await stop()
        setStopping(false)
    }, [queued, stop])

    const queue = useMemo(
        () => ({
            text: queued?.text ?? null,
            pending: stopping,
            enqueue: (text: string) => enqueueMessage(text, null),
            onSendNow: () => void sendQueuedNow(),
            onDiscard: clearQueued,
        }),
        [queued, stopping, enqueueMessage, sendQueuedNow, clearQueued]
    )

    // Les fichiers du Foreman ne vivent pas sur une Box : les vignettes, la lightbox et la lecture
    // du vocal passent par le seau du hub, sous la clé de cette conversation.
    // On the engine they live in the foreman's own workspace there, once the engine can take them.
    const surface = useForemanStore(state => state.surface)
    const [filesOnEngine, setFilesOnEngine] = useState(false)
    useEffect(() => {
        if (!open || surface !== 'engine') return
        let cancelled = false
        void foremanEngineFilesAction().then(supported => {
            if (!cancelled) setFilesOnEngine(supported)
        })
        return () => {
            cancelled = true
        }
    }, [open, surface])
    const engineFiles = backend === 'engine' && filesOnEngine
    const rawUrlFor = useCallback((path: string) => (engineFiles ? agentFileRawUrl(FOREMAN_AGENT_ID, path) : foremanFileRawUrl(sessionId, path)), [engineFiles, sessionId])
    const readFile = useCallback((path: string) => (engineFiles ? readFileAction(FOREMAN_AGENT_ID, path) : readForemanFileAction(sessionId, path)), [engineFiles, sessionId])
    const sharedFiles = useMemo(() => (engineFiles ? { rawUrlFor: sharedFileRawUrl, readFile: readWorkspaceFileAction } : undefined), [engineFiles])

    const stopTask = useMemo(() => (activeRunId ? (taskId: string) => void cancelSubRunAction(FOREMAN_AGENT_ID, activeRunId, taskId) : undefined), [activeRunId])

    // Regenerate and the thumbs belong to the foreman on the engine. The onboarding's turns build
    // things, and replaying one would build them twice.
    const feedback = useMessageFeedback(backend === 'engine' ? sessionId : null, 'foreman')
    const { rate: rateMessage, votes } = feedback
    const messageActions = useMemo(() => (backend === 'engine' ? { onRegenerate: regenerate, onRate: rateMessage, ratingOf: (messageId: string) => votes.get(messageId)?.rating ?? null } : null), [backend, regenerate, rateMessage, votes])

    const panelRef = useRef<HTMLDivElement>(null)
    const { onPointerDown: onHeaderPointerDown, dragOrigin } = useForemanDrag({ panelRef, placement })
    const dragging = useForemanStore(state => state.dropTarget !== null)
    const floating = placement.mode === 'float' || dragging
    const dockSide = placement.mode === 'dock' ? placement.side : null
    const dockedSide = dockedForemanSide({ open, placement, dragging })
    const [stackEl, setStackEl] = useState<HTMLElement | null>(null)
    const [slotEl, setSlotEl] = useState<HTMLDivElement | null>(null)
    useForemanSheetHeight({ panelRef, stackEl, slotEl })
    const { onPointerDown: onSheetPointerDown, toggleDetent } = useForemanSheetResize({ panelRef })
    const handleHeaderPointerDown = useCallback(
        (event: PointerEvent<HTMLElement>) => {
            onSheetPointerDown(event)
            onHeaderPointerDown(event)
        },
        [onSheetPointerDown, onHeaderPointerDown]
    )

    // Redimensionner la piste de grille redimensionne le layer GPU du board à chaque frame : on le
    // gèle le temps de la transition, par le canal qui met déjà le board en pause sous une dialog.
    // Pas au montage, sinon on gèlerait l'atterrissage des tuiles au premier rendu du board. Ouvrir
    // ou fermer la fenêtre flottante ne touche à aucune piste : là rien à geler.
    const mounted = useRef(false)
    useEffect(() => {
        if (!mounted.current) {
            mounted.current = true
            return
        }
        let released = false
        const release = useBoardCoverStore.getState().cover()
        const releaseOnce = () => {
            if (released) return
            released = true
            release()
        }
        const timer = setTimeout(releaseOnce, TRANSITION_MS + 20)
        return () => {
            clearTimeout(timer)
            releaseOnce()
        }
    }, [dockedSide])

    useEffect(() => {
        if (!dragging) return
        return useBoardCoverStore.getState().cover()
    }, [dragging])

    return (
        // `inert` plutôt que `hidden` : la colonne repliée garde sa position de scroll, elle doit
        // seulement quitter l'ordre de tabulation le temps qu'elle est à zéro. Sous `md` elle n'est
        // pas une piste de la grille mais une sheet qui monte du bas, haute comme ce qu'elle porte
        // (voir `useForemanSheetHeight`) tant qu'on ne l'a pas tirée sur un cran (voir
        // `useForemanSheetResize`), et le board reste vivant au-dessus : le placement choisi
        // sur desktop ne s'y applique pas. Là-haut, docké, rien ne bouge : c'est la
        // piste qui s'anime et jamais le panneau. Flottant, le panneau quitte la grille pour un coin
        // du viewport, et c'est lui qui apparaît. Tenu par l'en-tête, il suit le pointeur depuis
        // l'origine du viewport, `useForemanDrag` écrit sa translation.
        <div
            ref={panelRef}
            inert={!open}
            style={floating ? { ...floatSizeStyle(placement), ...(dragOrigin ? { transform: `translate3d(${dragOrigin.x}px, ${dragOrigin.y}px, 0)` } : null) } : undefined}
            className={cn(
                'absolute inset-0 z-50 min-w-0 overflow-hidden transition-transform duration-300 ease-in-out motion-reduce:transition-none max-md:top-auto md:translate-y-0',
                'max-md:h-[var(--foreman-sheet-drag-h,var(--foreman-sheet-detent-h,clamp(18rem,calc(var(--foreman-sheet-h,18rem)+var(--consent-inset,0px)),calc(96dvh-env(safe-area-inset-top)))))] max-md:max-h-[calc(96dvh-env(safe-area-inset-top))] max-md:min-h-[min(calc(var(--foreman-sheet-slot-h,0px)+4.5rem+var(--consent-inset,0px)),calc(96dvh-env(safe-area-inset-top)))] max-md:rounded-t-2xl max-md:border-t max-md:border-border max-md:shadow-2xl',
                'max-md:transition-[translate,height] max-md:duration-500 max-md:ease-[cubic-bezier(0.32,0.72,0,1)] max-md:data-[sheet-dragging]:max-h-none max-md:data-[sheet-dragging]:transition-none',
                !open && 'translate-y-full',
                floating
                    ? cn(
                          'md:fixed md:inset-auto md:z-50 md:overflow-visible',
                          FLOAT_SIZE_CLASSES,
                          dragging || placement.mode !== 'float'
                              ? 'md:top-0 md:left-0 md:transition-none'
                              : cn(FLOAT_CORNER_CLASSES[placement.corner], 'md:transition-[opacity,scale] md:duration-200 md:ease-out motion-reduce:md:transition-none'),
                          open === false && 'md:pointer-events-none md:scale-95 md:opacity-0'
                      )
                    : cn(
                          'md:relative md:inset-auto md:z-auto md:row-start-1 md:block md:transition-none',
                          dockSide === 'left' ? 'md:col-start-1' : 'md:col-start-3',
                          // Ouverte, la piste ne découpe que du côté du board, là où elle révèle le panneau :
                          // partout ailleurs elle couperait l'ombre de la carte qu'il devient.
                          // Fermée elle découpe tout, sinon cette ombre dépasserait dans la gouttière.
                          open !== false && (dockSide === 'left' ? 'md:overflow-visible md:[clip-path:inset(-1rem_0_-1rem_-1rem)]' : 'md:overflow-visible md:[clip-path:inset(-1rem_-1rem_-1rem_0)]')
                      )
            )}
        >
            {/* Docké : la largeur de la piste et bord extérieur collé à celui de la piste, le panneau
                ne se reflow pas pendant l'ouverture, la piste qui s'ouvre le révèle depuis le bord de
                l'écran en le décollant de l'`overflow-hidden`. Les deux lisent --foreman-dock-track,
                posé par BoardChatSplit. Sur mobile le fond est opaque : là le panneau n'est pas une piste
                de la grille mais une sheet posée sur le board, et le board ne doit pas se lire à
                travers. Docké à partir de `md`, il devient une carte comme le board, rentrée de l'écart
                qui les sépare. Flottant il est une carte posée sur le board. La
                largeur du panneau ne s'applique qu'à partir de `md` : ancrée sur un écran de 390px,
                elle pousserait le composer hors champ. */}
            <div
                className={cn(
                    'absolute inset-y-0 flex w-full flex-col bg-background pb-[var(--consent-inset)]',
                    floating
                        ? 'right-0 md:inset-x-0 md:overflow-hidden md:rounded-xl md:border md:border-border md:shadow-2xl'
                        : cn(
                              'md:w-[calc(var(--foreman-dock-track)-8px)] md:overflow-hidden md:rounded-3xl md:border md:border-border md:shadow',
                              dockSide === 'left' ? 'left-0' : 'right-0'
                          )
                )}
            >
                <ForemanHeader placement={placement} onDragPointerDown={handleHeaderPointerDown} onToggleSheetDetent={toggleDetent} onNewChat={startNewChat} />
                {/* Masqués et pas démontés hors de l'onglet Assistant : un aller-retour sur Routines
                    ne doit perdre ni le brouillon du composer ni la position dans la conversation. */}
                {arrivalStep && arrivalPick && (
                    <div className={cn('flex flex-col gap-6 px-5 pt-14', arrivalWall ? 'min-h-0 flex-1 overflow-y-auto pb-5' : 'shrink-0')}>
                        <ArrivalHeader pick={arrivalPick} step={arrivalStep} paid={!!arrival?.paid || arrivalStep === 'purchase'} />
                        {arrivalWall && <ArrivalWall step={arrivalWall} />}
                    </div>
                )}
                <div className={onRoutines || arrivalWall ? 'hidden' : 'contents'}>
                    <ForemanChatLayer
                        messages={messages}
                        streaming={busy}
                        guided={guided}
                        intake={intakeOpen ? intake : null}
                        gated={gated}
                        arrival={arrival}
                        restored={restoreDone}
                        error={noticeError}
                        onWidgetAnswer={answerWidget}
                        onWidgetDismiss={dismissWidget}
                        pending={pendingWidget}
                        nextSteps={nextSteps}
                        onSuggestion={sendOrQueue}
                        onPrefill={prefill}
                        onStop={handleStop}
                        onStopTask={stopTask}
                        actions={messageActions}
                        rawUrlFor={rawUrlFor}
                        readFile={readFile}
                        sharedFiles={sharedFiles}
                        onStackElement={setStackEl}
                        className="min-h-0 flex-1"
                    />
                    <ForemanComposerSlot
                        ref={setSlotEl}
                        intake={intakeOpen ? intake : null}
                        gated={gated}
                        trialGate={trialGate}
                        aside={!!pendingWidget && !keepsComposer(pendingWidget)}
                        ownEntry={ownEntry}
                        composerRef={composerRef}
                        sessionId={sessionId}
                        backend={composerBackend}
                        status={status}
                        busy={busy}
                        queue={queue}
                        onSend={sendFromComposer}
                        onStop={handleStop}
                        onUploadingChange={setUploading}
                        filesOnEngine={filesOnEngine}
                        contextStats={contextStats}
                    />
                </div>
                <MessageFeedbackDialog open={feedback.dialogOpen} rating={feedback.dialogRating} onOpenChange={feedback.onDialogOpenChange} onSubmit={feedback.submitDetails} />
                {onRoutines && <ForemanRoutines docked={placement.mode === 'dock'} className="min-h-0 flex-1 pt-24" />}
            </div>
            {placement.mode === 'float' && !dragging && open && <ForemanResizeHandle panelRef={panelRef} placement={placement} />}
            {placement.mode === 'dock' && !dragging && open && <ForemanDockResizeHandle panelRef={panelRef} placement={placement} />}
        </div>
    )
}
