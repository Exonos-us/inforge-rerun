import { tool, type ModelMessage, type ToolSet } from 'ai'
import { z } from 'zod'
import type { RunContext } from '../../runtime/context.js'
import { cardCallTiming, type TurnOrder } from '../../agents/turn-order.js'
import type { AgentConfig } from '../../agents/types.js'
import { desktopAvailable } from '../../desktop/session.js'
import { publicHttpUrl } from '../url.js'

export const HITL_TOOL_NAMES = ['ask_user', 'request_approval', 'suggest_service', 'request_secret', 'request_mcp_sign_in', 'request_takeover'] as const
export type HitlToolName = (typeof HITL_TOOL_NAMES)[number]
export const HITL_TOOL_SET = new Set<string>(HITL_TOOL_NAMES)

// It closes a turn beside its message or its card: a row in the chat, nothing for the model to
// read. So it neither turns the message before it into narration nor hides a card.
export const TRAILING_TOOL_SET = new Set<string>(['skill_propose'])

// Both CLI providers surface Rerun's builtin tools through the bridged `rerun` MCP server, which
// namespaces them. Claude Code always prefixes `mcp__`; Codex only does when `prefix_mcp_tool_names`
// is on, so accept the bare form too.
const BRIDGE_PREFIX = /^(?:mcp__)?rerun__/

export function canonicalBridgeName(name: string | undefined): string {
    return name?.replace(BRIDGE_PREFIX, '') ?? ''
}

export function canonicalHitlName(name: string | undefined): string {
    return canonicalBridgeName(name)
}

export function isHitlToolName(name: string | undefined): boolean {
    return HITL_TOOL_SET.has(canonicalHitlName(name))
}

export type PendingHitl = { toolCallId: string; toolName: string; input: unknown }

function rejectedToolCallIds(messages: ModelMessage[]): Set<string> {
    const ids = new Set<string>()
    for (const m of messages) {
        if (!Array.isArray(m.content)) continue
        for (const part of m.content) {
            const p = part as { type?: string; toolCallId?: string; output?: { type?: string } }
            if (p?.type === 'tool-result' && p.toolCallId && p.output?.type === 'error-text') ids.add(p.toolCallId)
        }
    }
    return ids
}

// A HITL call whose input the model got wrong never reached the user, so the run is not waiting on
// anyone: treating it as pending would pin an unanswerable form above the composer.
export function findPendingHitl(messages: ModelMessage[]): PendingHitl | null {
    const rejected = rejectedToolCallIds(messages)
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i]
        if (!Array.isArray(m.content)) continue
        for (let j = m.content.length - 1; j >= 0; j--) {
            const p = m.content[j] as { type?: string; toolCallId?: string; toolName?: string; input?: unknown }
            if (p?.type !== 'tool-call' || TRAILING_TOOL_SET.has(canonicalBridgeName(p.toolName))) continue
            if (isHitlToolName(p.toolName) && p.toolCallId && !rejected.has(p.toolCallId)) {
                return { toolCallId: p.toolCallId, toolName: canonicalHitlName(p.toolName), input: p.input }
            }
            return null
        }
    }
    return null
}

// An invalid call is one the tool never ran: the model gets the validation error back and must be
// given the next step to fix it, instead of ending the turn on a question nobody was asked.
type StepLike = { text?: string; toolCalls?: ReadonlyArray<{ toolName: string; toolCallId?: string; invalid?: boolean }>; content?: ReadonlyArray<{ type: string; toolCallId?: string }> }

// A HITL call that threw delivered no card either: the model has to read the error and go on
// rather than end its turn on nothing.
export function lastStepHasHitlCall(steps: ReadonlyArray<StepLike>): boolean {
    const last = steps[steps.length - 1]
    const failed = new Set((last?.content ?? []).filter(part => part.type === 'tool-error').map(part => part.toolCallId))
    return !!last?.toolCalls?.some(c => !c.invalid && !(c.toolCallId && failed.has(c.toolCallId)) && isHitlToolName(c.toolName))
}

// A card sent with no message around it: the model drafted its explanation in its thinking and went
// straight to the call, so the user sees a question about a summary they never got.
export function hitlStepLacksMessage(steps: ReadonlyArray<StepLike>): boolean {
    return lastStepHasHitlCall(steps) && !(steps[steps.length - 1]?.text ?? '').trim()
}

// The turn ends on the card once it has its message. A card without one buys the model exactly one
// more step to write it, and the turn ends after that step whatever it holds. CLI providers run
// their whole turn as one step, so for them the first HITL step is always the last.
export function hitlTurnIsOver(steps: ReadonlyArray<StepLike>, cli: boolean): boolean {
    if (lastStepHasHitlCall(steps.slice(0, -1))) return true
    return lastStepHasHitlCall(steps) && (cli || !hitlStepLacksMessage(steps))
}

// A model that writes its message first is left to judge whether it did: the card may have come
// after a message, or after nothing.
export const HITL_ACK = {
    status: 'delivered',
    instruction: 'Delivered to the user. Call no other tool. If you wrote nothing to the user before this call, they are looking at a bare card: write now, as your normal message, what you found, why you ask, and in full what the question is about, then end your turn. The card shows below that message, so point to it as the card below, never above. If you already did, end your turn now. The user will reply in the chat and you will continue from their reply.',
} as const

// A model that calls first is told, not asked: a Claude's note before a call comes back as a
// thinking block the chat folds away, so a model that wrote one believes the user has read it and
// ends its turn on a line pointing at the card. The message is expected now, whatever came before.
export const HITL_ACK_CALL_FIRST = {
    status: 'delivered',
    instruction: 'Delivered to the user. Whatever you wrote before this call was at most a note, and a note written before a call is not shown to them: they are looking at the card. Write your message now, as your normal reply: what you found, why you ask, and in full what the card asks about, then end your turn. The card shows below that message, so point to it as the card below, never above. Call no other tool. The user will reply in the chat and you will continue from their reply.',
} as const

export function hitlAck(order: TurnOrder): typeof HITL_ACK | typeof HITL_ACK_CALL_FIRST {
    return order === 'call-first' ? HITL_ACK_CALL_FIRST : HITL_ACK
}

function hitlTool<S extends z.ZodTypeAny>(order: TurnOrder, description: string, inputSchema: S) {
    return tool({ description: `${description} ${cardCallTiming(order)}`, inputSchema, execute: async () => hitlAck(order) })
}

export function jsonTolerantArray<S extends z.ZodTypeAny>(schema: S) {
    return z.preprocess(v => {
        if (typeof v !== 'string') return v
        try {
            return JSON.parse(v)
        } catch {
            return v
        }
    }, schema)
}

// Several models serialise an omitted optional field as an explicit `null`, which `.optional()`
// rejects. The whole call would then fail validation and the form would never reach the user.
function nullTolerantOptional<S extends z.ZodTypeAny>(schema: S) {
    return z.preprocess(v => (v === null ? undefined : v), schema.optional())
}

export function approvalSummary(input: Record<string, unknown> | undefined): string {
    const approvals = (() => {
        const value = input?.approvals
        if (typeof value !== 'string') return value
        try {
            return JSON.parse(value)
        } catch {
            return value
        }
    })() as Array<{ action?: unknown }> | undefined

    if (Array.isArray(approvals) && approvals.length > 0) {
        const first = String(approvals[0]?.action ?? 'The coworker requests approval')
        return approvals.length > 1 ? `${first} (+${approvals.length - 1} more)` : first
    }

    // Read compatibility for approval calls persisted before the tool accepted batches.
    return String(input?.action ?? 'The coworker requests approval')
}

export function secretSummary(input: Record<string, unknown> | undefined): string {
    const secrets = (() => {
        const value = input?.secrets
        if (typeof value !== 'string') return value
        try {
            return JSON.parse(value)
        } catch {
            return value
        }
    })() as Array<{ key?: unknown; label?: unknown }> | undefined

    if (Array.isArray(secrets) && secrets.length > 0) {
        const first = String(secrets[0]?.label ?? secrets[0]?.key ?? 'a credential')
        return secrets.length > 1 ? `Needs ${first} (+${secrets.length - 1} more)` : `Needs ${first}`
    }

    return 'The coworker needs a credential'
}

export function takeoverSummary(input: Record<string, unknown> | undefined): string {
    const reason = typeof input?.reason === 'string' ? input.reason.trim() : ''
    return reason ? `Needs you in the browser: ${reason}` : 'The coworker needs you in the browser'
}

// Nobody watches a delegate, and the foreman's chat has no card for it.
export function offersTakeover(config: AgentConfig): boolean {
    return config.tools.browser && !config.ephemeral && config.kind !== 'foreman' && desktopAvailable()
}

// The rules on options and on what goes in the card live in the `asking_the_user` section of the
// prompt: the description keeps the shape of a call, not the whole doctrine, since it rides along
// on every step.
const askUserDescription = (cards: boolean) =>
    `Ask the user one or more questions at once, then END YOUR TURN until they reply. Use it only when you cannot proceed without their input. Anything they are asked to review or choose among (a hook, slides, images) must be in the turn that asks, in full, even when you showed it earlier or are asking again: its text in your message${cards ? ', its files in a card_file call made before this one' : ''}. Put every open question in the questions array, not across several turns. A question offers short options as buttons, or none for a free-text answer: options only when concrete choices help, never for a value only the user knows (a URL, a name, a number). Set multiple: true when the options combine. The user can always type a custom answer, attach files (they arrive as workspace paths) or skip a question. Keep each question to one short line and each option to a few words: longer explanations go in your message.`

const questionOption = z.union([
    z.string().min(1),
    z.object({
        label: z.string().min(1),
        description: nullTolerantOptional(z.string().min(1)).describe('One line on what picking it implies, only when the label does not say it.'),
    }),
])

export function askUserTool(ctx: RunContext): ToolSet {
    return {
        ask_user: hitlTool(
            ctx.turnOrder,
            askUserDescription(ctx.agent.config.tools.cards),
            z.object({
                questions: jsonTolerantArray(
                    z
                        .array(
                            z.object({
                                question: z.string().min(1).describe('The question alone, one short line: no greeting, lead-in or context, those go in your message.'),
                                header: nullTolerantOptional(z.string().min(1)).describe('One or two words shown above the question, e.g. "Format".'),
                                options: nullTolerantOptional(z.array(questionOption).min(2)).describe('Omit for a free-text question. Otherwise at least two short labels shown as buttons, six or fewer unless the set is genuinely enumerated (every channel, every account). Never a catch-all like "Other" or "All of the above": the free field already covers it, and every option is a real answer to the question.'),
                                multiple: nullTolerantOptional(z.boolean()).describe('Set true when the user may tick several options at once; ignored without options. Defaults to false.'),
                                suggestions: nullTolerantOptional(z.array(z.string().min(1)).min(2)).describe('Deprecated alias of options.'),
                            }),
                        )
                        .min(1),
                ).describe('Every question you need answered now, in one form.'),
            }),
        ),
    }
}

export function requestApprovalTool(ctx: Pick<RunContext, 'turnOrder'>): ToolSet {
    return {
        request_approval: hitlTool(
            ctx.turnOrder,
            'Request explicit approval before performing one or more consequential or irreversible actions, then END YOUR TURN until the user approves or declines each one. Group every approval you genuinely need right now into a single approvals array instead of asking one at a time, but never pad the batch with unnecessary actions or split one action artificially. Keep every card short: action is one concise line and detail holds only the concrete specifics — put any longer explanation in your message, not here. The user replies once with all decisions. Perform only approved actions. A standing go-ahead the user already gave for this kind of action ("join them all, no need to ask me") is that approval: do not call this tool for actions it covers. You must NOT perform a declined action or attempt any workaround to achieve the same result.',
            z.object({
                approvals: jsonTolerantArray(
                    z
                        .array(
                            z.object({
                                action: z.string().min(1).describe('A clear description of one action you want to take, kept to one short line. Any longer reasoning goes in your message, not here.'),
                                detail: nullTolerantOptional(z.string()).describe('Optional extra detail shown for this action (e.g. a command, a diff, a target). Keep it to the concrete specifics, not a long explanation.'),
                            }),
                        )
                        .min(1)
                        .max(20),
                ).describe('Every approval currently needed, grouped into one relevant batch. Include no filler and do not split one action into artificial sub-actions.'),
            }),
        ),
    }
}

export function suggestServiceTool(ctx: Pick<RunContext, 'turnOrder'>): ToolSet {
    return {
        suggest_service: hitlTool(
            ctx.turnOrder,
            'Suggest one or more catalog apps for the user to set up, then END YOUR TURN. Call it at the moment an action needs the app, after showing the user what you prepared, not as a first step. The UI shows a setup card per app where the user enters keys, signs in (OAuth), or skips. Use this — NOT rerun_hub_service_install — whenever a service needs credentials or a sign-in: never ask the user to paste secrets in the chat. Get exact slugs from rerun_hub_service_search / rerun_hub_service_details first.',
            z.object({
                services: jsonTolerantArray(
                    z
                        .array(
                            z.object({
                                slug: z.string().min(1).describe('Exact catalog slug from rerun_hub_service_search / rerun_hub_service_details.'),
                                reason: nullTolerantOptional(z.string().max(300)).describe('One short line telling the user why this app helps with their request. The card truncates it to a single line, so keep it to a brief phrase; put any longer explanation in your message.'),
                            }),
                        )
                        .min(1)
                        .max(20),
                ).describe('The apps to suggest, each identified by its exact catalog slug.'),
            }),
        ),
    }
}

export function requestSecretTool(ctx: Pick<RunContext, 'turnOrder'>): ToolSet {
    return {
        request_secret: hitlTool(
            ctx.turnOrder,
            'Ask the user for one or more credentials (API key, token, password) through a secure masked form, then END YOUR TURN. NEVER ask anyone to paste a secret into the chat: the conversation is stored and sent to the model, this form is not. Each value the user enters is written straight into your coworker variables on the engine and is NEVER shown to you: you only get back the names of the variables that were filled. Reference a filled variable as ${KEY} in an MCP server config (headers, url, env, args) or in a shell command; that placeholder is resolved at run time. For a password to type on your own screen, set the item\'s site: the computer type_secret action then types it there, and only there.Use suggest_service instead when the service exists in the Rerun catalog; use this tool for anything else that needs a key. Group every credential you need for the same setup into a single call.',
            z.object({
                secrets: jsonTolerantArray(
                    z
                        .array(
                            z.object({
                                key: z
                                    .string()
                                    .regex(/^[A-Z][A-Z0-9_]*$/)
                                    .describe('The environment variable name the value is stored under, SCREAMING_SNAKE_CASE (e.g. LINEAR_API_KEY). This is the name you later reference as ${KEY}.'),
                                label: z.string().min(1).describe('Short human label for the field, a few words (e.g. "Linear API key"). Not a sentence.'),
                                help: nullTolerantOptional(z.string().max(300)).describe('Optional single short line telling the user where to find this value. Any longer explanation goes in your message.'),
                                docsUrl: nullTolerantOptional(z.string().url()).describe('Optional link to the page where the user can create or copy this credential.'),
                                site: nullTolerantOptional(z.string().min(1).max(200)).describe('Only for a password or code you will type on your own screen: the site it signs in to, as a domain (e.g. "github.com"). The engine will refuse to type it anywhere else. Leave it out for keys used in configs and commands.'),
                            }),
                        )
                        .min(1)
                        .max(8),
                ).describe('Every credential needed for this setup, requested together in one form.'),
                reason: nullTolerantOptional(z.string().max(300)).describe('One short line shown above the form explaining what these credentials are for.'),
            }),
        ),
    }
}

// Registered alongside mcp_register rather than through the tool catalog: it only makes sense to an
// agent that can add MCP servers to itself.
export function mcpSignInTool(ctx: Pick<RunContext, 'turnOrder'>): ToolSet {
    return {
        request_mcp_sign_in: hitlTool(
            ctx.turnOrder,
            'Ask the user to sign in to an MCP server you registered with mcp_register that answered it requires sign-in, then END YOUR TURN. The user gets a card with a Connect button that runs the OAuth sign-in in a popup; you never see a token. Do not explain the sign-in steps yourself, the card does. The server\'s tools load once they are connected.',
            z.object({
                name: z.string().min(1).describe('The exact name the server was registered under with mcp_register.'),
                reason: nullTolerantOptional(z.string().max(300)).describe('One short line shown on the card telling the user what signing in unlocks.'),
            }),
        ),
    }
}

export function requestTakeoverTool(ctx: Pick<RunContext, 'turnOrder'>): ToolSet {
    return {
        request_takeover: hitlTool(
            ctx.turnOrder,
            'Hand your browser to the user so they do by hand what you cannot: sign in to an account, pass a captcha or a bot check, approve a device prompt. Then END YOUR TURN. The user sees your browser window on this URL, acts in it, and confirms when they are done; cookies and the signed-in session stay in your browser profile; when you get it back, the answer says whether its window is still open on your screen or closed. Use it only when a page you need is blocked behind something a person can clear, never to ask them to browse in your place.',
            z.object({
                url: publicHttpUrl.describe('The page to open for the user, usually the one that blocked you or its sign-in page.'),
                reason: z.string().min(1).max(200).describe('One short line telling the user what to do there, e.g. "Sign in to LinkedIn" or "Pass the Cloudflare check". Shown as the title of the card.'),
            }),
        ),
    }
}
