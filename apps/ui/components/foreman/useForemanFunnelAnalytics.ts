'use client'

import type { UIMessage } from 'ai'
import { useEffect, useRef } from 'react'

import { track } from '@rerun/analytics/client'

import { readQuestionOutput } from '@/components/foreman/widgets/question-answer'
import { readOwnAsk } from '@/lib/foreman/kickoff-marker'
import { readStarterPackAnswer } from '@/lib/foreman/starter-pack'

// The funnel, read off the conversation. The survey emitted its steps from its own stepper; there is
// no stepper here, and the phase lives on the server, so the honest client-side signal is the tool
// the foreman just finished: each one is the act that closes a step, which is what the funnel was
// ever counting. One user message counts too: the kickoff that carries the line written under the
// welcome card, which is the plan without any card having gone up.
//
// Keyed on toolCallId (and on the id of that message), so a re-render, a reload replaying the
// transcript, or a stream that lands the same part twice all count once. Nothing is read before the
// saved conversation is restored: seeded on an empty stack, every tool of a previous visit would be
// counted again the moment it arrives.

type ToolPart = { type: string; toolCallId?: string; state?: string; input?: unknown; output?: unknown; text?: unknown }

// The step a tool closes, and the one it opens. `once` keeps a phase from being counted twice. A plan
// only opens the build for a workspace whose plan is already on: for the others the trial card stands
// in between, and is what opens its own step.
const NEXT_STEP: Record<string, string> = { discover: 'plan', plan: 'build', trial: 'build' }

type PlanVia = 'plan_card' | 'template' | 'starter_pack' | 'custom'

function step(name: string, once: (key: string) => boolean, options: { via?: PlanVia; opensNext?: boolean } = {}): void {
    if (!once(`completed:${name}`)) return
    track('onboarding_step_completed', options.via ? { step: name, via: options.via } : { step: name })
    const next = NEXT_STEP[name]
    if (next && options.opensNext !== false && once(`viewed:${next}`)) track('onboarding_step_viewed', { step: next })
}

const CHECKOUT_REASONS = ['trial_refused', 'dismissed', 'pending'] as const
type CheckoutReason = (typeof CHECKOUT_REASONS)[number]

// The trial card is on screen from the moment its tool is called, long before it answers.
export function viewTrialStep(once: (key: string) => boolean): void {
    if (once('viewed:trial')) track('onboarding_step_viewed', { step: 'trial' })
}

function strings(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
}

// The line written under the welcome card is the plan, as a line written over the starter pack is:
// one coworker, no card answered.
export function emitOwnAsk(once: (key: string) => boolean, entitled: boolean): void {
    track('onboarding_plan_answered', { confirmed: true, agents: 1, via: 'custom', from: 'intake' })
    step('plan', once, { via: 'custom', opensNext: entitled })
}

function carriesOwnAsk(message: UIMessage): boolean {
    return message.role === 'user' && message.parts.some(part => part.type === 'text' && typeof (part as ToolPart).text === 'string' && readOwnAsk((part as ToolPart).text as string) !== null)
}

export function emit(name: string, input: unknown, output: unknown, once: (key: string) => boolean, entitled: boolean): void {
    switch (name) {
        case 'ask_choice': {
            // A single-answer ask_choice is a profile question, the role among them, not a step of
            // the funnel. The interview opens on the use-case question, its first multiple choice,
            // and it is the one counted: the ones after it dig into those jobs.
            const args = (input ?? {}) as { multiple?: unknown; options?: unknown }
            if (args.multiple !== true || !once('use_cases')) return
            const options = strings(args.options)
            const answers = strings((output as { answers?: unknown } | null)?.answers)
            return track('onboarding_use_cases_selected', { proposed: options.length, selected: answers.length, custom: answers.some(answer => !options.includes(answer)) })
        }
        case 'ask_either': {
            const answer = readQuestionOutput(output)
            track('onboarding_either_answered', { outcome: answer?.answered ? 'picked' : (answer?.reason ?? 'abandoned') })
            // The interview opens on the job question, and its first answered card is the one
            // counted: the one after it digs into that job. A card sent back with "Neither" picked
            // nothing, so the next one is still the job question.
            const answers = answer?.answered ? answer.answers : []
            if (!answers.length || !once('use_cases')) return
            const options = strings(((input ?? {}) as { options?: unknown }).options)
            return track('onboarding_use_cases_selected', { proposed: options.length, selected: answers.length, custom: false })
        }
        case 'save_profile':
            return step('discover', once)
        // The card coming back confirmed is what closes the plan: the app writes it down from there.
        case 'show_plan': {
            const answer = (output ?? {}) as { answered?: unknown; confirmed?: unknown }
            if (answer.answered !== true) return
            const items = ((input ?? {}) as { items?: unknown[] }).items ?? []
            const confirmed = answer.confirmed === true
            track('onboarding_plan_answered', { confirmed, agents: items.length })
            if (confirmed) step('plan', once, { via: 'plan_card', opensNext: entitled })
            return
        }
        // A template link has no plan card: picking the template on its own card is the plan.
        case 'show_templates':
            if (typeof (output as { chosen?: unknown } | null)?.chosen === 'string') step('plan', once, { via: 'template', opensNext: entitled })
            return
        // The starter pack is the plan: the cards they hired, or the one coworker they described.
        case 'show_starter_pack': {
            const answer = readStarterPackAnswer(output)
            if (!answer?.answered) return
            const custom = 'custom' in answer
            track('onboarding_plan_answered', { confirmed: true, agents: custom ? 1 : answer.chosen.length, via: custom ? 'custom' : 'starter_pack', ...(custom ? { from: 'pack' } : { picked: answer.chosen }) })
            return step('plan', once, { via: custom ? 'custom' : 'starter_pack', opensNext: entitled })
        }
        case 'open_checkout': {
            const answer = (output ?? {}) as { ok?: unknown; reason?: unknown }
            const ok = answer.ok === true
            const reason = CHECKOUT_REASONS.find(known => known === answer.reason) as CheckoutReason | undefined
            track('onboarding_checkout_answered', ok || !reason ? { ok } : { ok, reason })
            if (ok) step('trial', once)
            return
        }
        case 'contact_team':
            return track('onboarding_help_answered', { sent: (output as { sent?: unknown } | null)?.sent === true })
        // The build closes when there is a team. The first run is not a step of this hook: it is the
        // server's `agent_run_completed`.
        case 'build_team': {
            const result = (output ?? {}) as { agents?: unknown[]; failed?: unknown[] }
            const agents = result.agents?.length ?? 0
            track('onboarding_team_built', { agents, failed: result.failed?.length ?? 0, error: false })
            if (agents === 0) return
            track('first_agent_created', { template: 'foreman' })
            return step('build', once)
        }
    }
}

export function useForemanFunnelAnalytics({ messages, guided, restoreDone, entitled }: { messages: UIMessage[]; guided: boolean; restoreDone: boolean; entitled: boolean }) {
    const counted = useRef(new Set<string>())
    const steps = useRef(new Set<string>())
    const once = (key: string) => (steps.current.has(key) ? false : (steps.current.add(key), true))
    // Everything already in the transcript belongs to a previous visit: it was counted then, and
    // counting it again on every reload would read as a user who redid their onboarding.
    const seeded = useRef(false)

    useEffect(() => {
        if (!guided || !restoreDone) return
        if (!seeded.current) {
            seeded.current = true
            for (const message of messages) {
                if (message.role === 'user') counted.current.add(message.id)
                for (const part of message.parts) {
                    const id = (part as ToolPart).toolCallId
                    if (id) counted.current.add(id)
                }
            }
            return
        }
        for (const message of messages) {
            if (message.role === 'user' && !counted.current.has(message.id)) {
                counted.current.add(message.id)
                if (carriesOwnAsk(message)) emitOwnAsk(once, entitled)
            }
            for (const part of message.parts) {
                const tool = part as ToolPart
                if (!tool.type.startsWith('tool-') || !tool.toolCallId || counted.current.has(tool.toolCallId)) continue
                // A build that threw is the one failure worth a trace: nothing else comes after it.
                if (tool.state === 'output-error' && tool.type === 'tool-build_team') {
                    counted.current.add(tool.toolCallId)
                    track('onboarding_team_built', { agents: 0, failed: 0, error: true })
                    continue
                }
                if (tool.type === 'tool-open_checkout' && tool.state !== 'output-error') viewTrialStep(once)
                if (tool.state !== 'output-available') continue
                counted.current.add(tool.toolCallId)
                emit(tool.type.slice('tool-'.length), tool.input, tool.output, once, entitled)
            }
        }
    }, [messages, guided, restoreDone, entitled])
}
