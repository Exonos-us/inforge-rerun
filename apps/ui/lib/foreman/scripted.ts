import 'server-only'

import { createIdGenerator, type UIMessage, type UIMessageStreamWriter } from 'ai'

import type { WorkspaceContext } from '@/app/api/_auth/ownership'
import type { SubRunTask } from '@/lib/chat/sub-run-progress'
import { buildTeamOnce } from './build-once'
import { isKickoffText, readOwnAsk } from './kickoff-marker'
import { writePlan, type WrittenPlan } from './onboarding-tools'
import { foremanPhase, isNamedReadyMade, type ForemanPhase, type ForemanState } from './phase'
import { pinnedPlanBoxes, planKinds } from './phases'
import { lastShownPlan, planRevisionAsk, templateCardPlan } from './shown-plan'
import { readStarterPackAnswer, SHOW_STARTER_PACK_TOOL, starterPackPlan, type StarterPackInput } from './starter-pack'
import { loadStarterPack, nameCustomCoworker } from './starter-pack-offer'
import { owedTemplatePurchase, type OwedTemplatePurchase } from './template-purchase'

// The steps of the funnel nobody has to think about, run by the app instead of the model. Once the
// plan card comes back confirmed, what follows is never a decision: the plan is written down as it
// was shown, the trial card goes up, and the moment the trial is on the team is built. Handing those
// to a model made each of them one more turn to wait on, and one more place it could decide
// otherwise.
//
// They are written into the conversation as the same tool parts the model used to produce, so a
// reload, the funnel analytics, the build's live block and the model's next turn all read them as
// if nothing had changed.

export const OPEN_CHECKOUT_TOOL = 'open_checkout'
export const BUILD_TEAM_TOOL = 'build_team'
export const OPEN_TEMPLATE_PURCHASE_TOOL = 'open_template_purchase'

export type ScriptedIntent = 'confirm_plan' | 'offer_trial' | 'build'

// `template` is the card of the template they arrived on, written into the conversation already
// picked: the board and the column draw it from there, the same as a card they had answered.
export type ForemanScript =
    | { kind: 'offer_pack'; pack: StarterPackInput }
    | { kind: 'offer_trial'; template?: TemplateCard }
    | { kind: 'offer_purchase'; purchase: OwedTemplatePurchase; template?: TemplateCard }
    | { kind: 'build'; state: ForemanState; template?: TemplateCard }

type TemplateCard = { templates: { slug: string; title: string; why: string }[]; box?: string; boxes: { name: string }[] }

const SHOW_TEMPLATES_TOOL = 'show_templates'

type LoosePart = { type: string; state?: string; input?: unknown; output?: unknown; text?: string }

const TOOL_CALL_ID = createIdGenerator({ prefix: 'call', size: 16 })

function lastToolPart(message: UIMessage): LoosePart | null {
    const parts = message.parts as LoosePart[]
    for (let index = parts.length - 1; index >= 0; index--) {
        if (parts[index].type.startsWith('tool-')) return parts[index]
    }
    return null
}

function confirmedPlanCard(message: UIMessage): boolean {
    const tool = lastToolPart(message)
    if (tool?.type !== 'tool-show_plan' || tool.state !== 'output-available') return false
    const output = tool.output as { answered?: unknown; confirmed?: unknown } | null
    return output?.answered === true && output.confirmed === true
}

// Someone who arrived on a template link confirms it on its own card. Picking it is the plan: the
// template holds its agents, so a plan card after it would only ask the same yes a second time.
function chosenTemplatePlan(message: UIMessage): ReturnType<typeof templateCardPlan> {
    const tool = lastToolPart(message)
    if (tool?.type !== 'tool-show_templates' || tool.state !== 'output-available') return null
    const chosen = (tool.output as { chosen?: unknown } | null)?.chosen
    return typeof chosen === 'string' && chosen ? templateCardPlan(tool.input, chosen) : null
}

// The plan a ready-made link is written down as, and for a template the card it is shown on.
type ArrivedPlan = { shown: { items: unknown[]; boxes: { name: string }[] }; template?: TemplateCard }

// Someone who arrived on a template or on a shared coworker already chose it by clicking the link,
// and its own setup asks the rest once it is installed: asking them to pick it again was one more
// card and one more model turn before the trial. It lands in the first Box of their board, the one
// the board centres on. A link that no longer resolves has no title and is left to the model.
function arrivedReadyMadePlan(state: ForemanState, messages: UIMessage[]): ArrivedPlan | null {
    const last = messages.at(-1)
    const intent = state.intent
    if (state.phase !== 'plan' || !intent || !isNamedReadyMade(intent) || !last || !isKickoff(last)) return null
    const pinned = pinnedPlanBoxes(state)
    const boxes = pinned.map(name => ({ name }))
    if (intent.kind === 'share') return { shown: { items: [{ kind: 'share', token: intent.token, name: intent.title, box: pinned[0] }], boxes } }
    if (intent.kind !== 'template' || !intent.title) return null
    const template: TemplateCard = { templates: [{ slug: intent.slug, title: intent.title, why: '' }], box: pinned[0], boxes }
    const shown = templateCardPlan(template)
    return shown ? { shown, template } : null
}

// What the starter pack step does with this request. Someone who came in with nothing in hand is
// offered the pack of their industry the moment the welcome card hands over, and never interviewed:
// the cards they pick are the plan, and the line they write instead of picking is the one coworker
// built for them. Typing over the cards is that same line, and so is a line written under the
// welcome card before the pack ever went up: the kickoff carries it, and the cards are skipped. A
// link they arrived on is left to its own card, and a conversation the pack never opened (the
// welcome card failed, the model asked the profile itself) to the model.
type StarterPackStep = { kind: 'offer' } | { kind: 'picked'; input: unknown; chosen: string[] } | { kind: 'custom'; asked: string }

function lastStarterPackPart(messages: UIMessage[]): LoosePart | null {
    for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index]
        if (message.role !== 'assistant') continue
        const tool = lastToolPart(message)
        if (tool) return tool.type === `tool-${SHOW_STARTER_PACK_TOOL}` ? tool : null
    }
    return null
}

function typedText(message: UIMessage): string {
    return (message.parts as LoosePart[])
        .flatMap(part => (part.type === 'text' && typeof part.text === 'string' ? [part.text] : []))
        .join('\n')
        .trim()
}

function starterPackStep(state: ForemanState, messages: UIMessage[]): StarterPackStep | null {
    const last = messages.at(-1)
    if (state.phase !== 'plan' || state.intent || !last) return null
    if (isKickoff(last)) {
        const asked = readOwnAsk(typedText(last))
        return asked ? { kind: 'custom', asked } : { kind: 'offer' }
    }

    const card = lastStarterPackPart(messages)
    if (!card || card.state !== 'output-available') return null
    if (last.role === 'user') {
        const asked = typedText(last)
        return asked ? { kind: 'custom', asked } : null
    }
    const answer = readStarterPackAnswer(card.output)
    if (!answer?.answered) return { kind: 'offer' }
    return 'custom' in answer ? { kind: 'custom', asked: answer.custom } : { kind: 'picked', input: card.input, chosen: answer.chosen }
}

// The plan their answer to the pack becomes: the templates they picked, or one coworker written from
// their own line. Neither goes back through a card: they already said yes on this one.
async function writeStarterPlan(ctx: WorkspaceContext, state: ForemanState, step: Exclude<StarterPackStep, { kind: 'offer' }>): Promise<WrittenPlan> {
    const title = state.answers.company_name ?? state.workspaceName
    if (step.kind === 'picked') return writePlan(ctx, { ...starterPackPlan(step.input, step.chosen), title }, ['template'])
    const pinned = pinnedPlanBoxes(state)
    const { name, role } = await nameCustomCoworker(step.asked)
    return writePlan(ctx, { title, items: [{ kind: 'agent', name, role, box: pinned[0] }], boxes: pinned.map(box => ({ name: box })) }, ['agent'], step.asked)
}

function confirmedCard(message: UIMessage): boolean {
    return message.role === 'assistant' && (confirmedPlanCard(message) || chosenTemplatePlan(message) !== null)
}

function isKickoff(message: UIMessage): boolean {
    return message.role === 'user' && (message.parts as LoosePart[]).some(part => part.type === 'text' && typeof part.text === 'string' && isKickoffText(part.text))
}

/** Which step the app runs itself for this request, or `null` when the model has something to decide. */
export function scriptedIntent(phase: ForemanPhase, messages: UIMessage[]): ScriptedIntent | null {
    // Whatever the request says: a build has nothing left to discuss, and a message typed while it
    // was being built is answered by the team it builds.
    if (phase === 'build') return 'build'

    const last = messages.at(-1)
    if (!last) return null

    if (phase === 'plan') return confirmedCard(last) ? 'confirm_plan' : null

    // The trial card goes up on its own: right after the confirmation when the plan was written by an
    // earlier request that did not get to put it up, and when a conversation opens on this step.
    if (phase === 'trial') return confirmedCard(last) || isKickoff(last) ? 'offer_trial' : null

    return null
}

export type PreparedScript = { script: ForemanScript } | { planError: string } | null

/**
 * Settles what has to happen before anything is streamed: the confirmed plan is written here, so a
 * plan that cannot be written goes back to the model with the reason instead of starting a stream
 * the app would have to abandon halfway.
 */
export async function prepareScript(ctx: WorkspaceContext, state: ForemanState, messages: UIMessage[]): Promise<PreparedScript> {
    const pack = starterPackStep(state, messages)
    if (pack?.kind === 'offer') {
        const offered = await loadStarterPack(ctx, state)
        return offered ? { script: { kind: 'offer_pack', pack: offered } } : null
    }

    const arrived = arrivedReadyMadePlan(state, messages)
    const intent = arrived || pack ? 'confirm_plan' : scriptedIntent(state.phase, messages)
    if (!intent) return null
    if (intent === 'offer_trial') return { script: { kind: 'offer_trial' } }
    if (intent === 'build') return { script: await buildOrPurchase(ctx, state) }

    let next: ForemanState
    try {
        const last = messages.at(-1)
        const readyMade = arrived ? arrived.shown : last ? chosenTemplatePlan(last) : null
        // Installed ahead of the welcome card: the mark is written with the plan, and it is what
        // brings the card back once the build is done.
        const installedFirst = !!arrived && !state.foreman.profileAt
        const written = pack
            ? await writeStarterPlan(ctx, state, pack)
            : readyMade
              ? await writePlan(ctx, { ...readyMade, title: state.answers.company_name ?? state.workspaceName }, planKinds(state), null, installedFirst)
              : await writePlan(ctx, lastShownPlan(messages), planKinds(state), planRevisionAsk(messages), false, state.foreman)
        const foreman = { ...state.foreman, ...written }
        next = { ...state, foreman, answers: { ...state.answers, foreman } }
    } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        if (!pack) return { planError: reason }
        // The model has no card to fix here: the pack goes back up, as it was offered.
        console.error('[foreman] starter pack plan refused:', reason)
        const offered = await loadStarterPack(ctx, state)
        return offered ? { script: { kind: 'offer_pack', pack: offered } } : { planError: reason }
    }

    const phase = foremanPhase({ foreman: next.foreman, onboardingCompletedAt: next.onboardingCompletedAt, entitled: next.entitled, trialing: next.trialing, agentCount: next.agents.length, arrivedReadyMade: isNamedReadyMade(next.intent) })
    const shown = arrived?.template ? { template: arrived.template } : {}
    if (phase === 'trial') return { script: { kind: 'offer_trial', ...shown } }
    if (phase === 'build') return { script: { ...(await buildOrPurchase(ctx, { ...next, phase })), ...shown } }
    return null
}

// A plan is on, so the team can be built, unless what the plan holds is a template still to be
// bought: then its card goes up first, and the build is what its answer brings.
async function buildOrPurchase(ctx: WorkspaceContext, state: ForemanState): Promise<ForemanScript> {
    const purchase = await owedTemplatePurchase(ctx, state.foreman.plan)
    return purchase ? { kind: 'offer_purchase', purchase } : { kind: 'build', state }
}

export async function runScript(script: ForemanScript, { ctx, writer, signal, reload }: { ctx: WorkspaceContext; writer: UIMessageStreamWriter; signal?: AbortSignal; reload: () => Promise<ForemanState> }): Promise<void> {
    const toolCallId = TOOL_CALL_ID()
    writer.write({ type: 'start' })
    writer.write({ type: 'start-step' })

    if (script.kind === 'offer_pack') {
        // No output: the card answers it itself, and that answer is what brings the next request.
        writer.write({ type: 'tool-input-available', toolCallId, toolName: SHOW_STARTER_PACK_TOOL, input: script.pack })
        writer.write({ type: 'finish-step' })
        writer.write({ type: 'finish' })
        return
    }

    if (script.template) {
        const cardCallId = TOOL_CALL_ID()
        writer.write({ type: 'tool-input-available', toolCallId: cardCallId, toolName: SHOW_TEMPLATES_TOOL, input: script.template })
        writer.write({ type: 'tool-output-available', toolCallId: cardCallId, output: { answered: true, chosen: script.template.templates[0].slug } })
    }

    if (script.kind === 'offer_trial' || script.kind === 'offer_purchase') {
        // No output: the card answers it itself, and that answer is what brings the next request.
        if (script.kind === 'offer_trial') writer.write({ type: 'tool-input-available', toolCallId, toolName: OPEN_CHECKOUT_TOOL, input: {} })
        else writer.write({ type: 'tool-input-available', toolCallId, toolName: OPEN_TEMPLATE_PURCHASE_TOOL, input: script.purchase })
        writer.write({ type: 'finish-step' })
        writer.write({ type: 'finish' })
        return
    }

    writer.write({ type: 'tool-input-available', toolCallId, toolName: BUILD_TEAM_TOOL, input: {} })
    // Same id as the tool part: it is what pairs the live block to the build instead of leaving it to
    // render on its own as a delegation.
    const emit = (tasks: SubRunTask[]) => writer.write({ type: 'data-delegate', id: toolCallId, data: { tasks } })
    try {
        const result = await buildTeamOnce({ ctx, state: script.state, emit, signal, reload })
        writer.write({ type: 'tool-output-available', toolCallId, output: result })
    } catch (err) {
        writer.write({ type: 'tool-output-error', toolCallId, errorText: err instanceof Error ? err.message : String(err) })
    }
    writer.write({ type: 'finish-step' })
    // An empty step to close on, so the saved transcript does not end on answered tool calls. It never
    // reaches the browser's copy of the message: what keeps the browser from sending the finished team
    // back is resumesAfterAnswer (pending-widget.ts).
    writer.write({ type: 'start-step' })
    writer.write({ type: 'finish-step' })
    writer.write({ type: 'finish' })
}
