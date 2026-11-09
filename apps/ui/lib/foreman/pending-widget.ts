import { hitlInputIsUsable, hitlKindOf, stripBridgePrefix } from '@rerun/contracts'
import { lastAssistantMessageIsCompleteWithToolCalls, type ChatStatus, type UIMessage } from 'ai'

import { isForemanWidgetTool, type ForemanWidgetToolName } from './tool-defs'

// The two questions the engine foreman can stop on. They are the engine's own ask_user and
// request_approval, answered by a user message rather than a tool result.
export type EngineHitlToolName = 'ask_user' | 'request_approval'

export type PendingWidget = { toolName: ForemanWidgetToolName | EngineHitlToolName; toolCallId: string; input: unknown }

// An engine question is drawn after the last message, the way an agent's chat draws its own. Every
// other widget waits where it streamed in, inside the message that called it.
export function isEngineHitl(toolName: string): toolName is EngineHitlToolName {
    return toolName === 'ask_user' || toolName === 'request_approval'
}

// A pending widget is the only thing left to answer, so the composer steps aside for it. Two
// exceptions. The hand-off to the team: someone already stuck is not left with one button between
// them and the chat. The starter pack: whoever already knows the coworker they want writes it there,
// and the line answers the pack (ForemanColumn). The trial card is not one: past it the composer is
// gone for good (`trialStep`).
export function keepsComposer(pending: PendingWidget): boolean {
    return pending.toolName === 'contact_team' || pending.toolName === 'show_starter_pack'
}

type ToolPart = { type: string; toolCallId?: string; toolName?: string; state?: string; input?: unknown; rawInput?: unknown; output?: unknown }

export function widgetName(part: ToolPart): ForemanWidgetToolName | null {
    if (!part.type.startsWith('tool-')) return null
    const name = part.type.slice('tool-'.length)
    return isForemanWidgetTool(name) ? name : null
}

/**
 * The widget the conversation is stopped on, and for which the composer steps aside.
 * Same reading as the agent chat's pending HITL call: the last message has to be the assistant's,
 * and it has to still carry a widget nothing has answered. A widget is answered through
 * `addToolResult`, so the mark is the tool state, where an agent's question is closed by the user
 * message that follows it.
 */
export function findPendingWidget(messages: UIMessage[], status: ChatStatus): PendingWidget | null {
    if (status === 'streaming' || status === 'submitted') return null
    const last = messages[messages.length - 1]
    if (!last || last.role !== 'assistant') return null

    for (let index = last.parts.length - 1; index >= 0; index--) {
        const part = last.parts[index] as ToolPart
        const toolName = widgetName(part)
        if (!toolName || part.state !== 'input-available' || !part.toolCallId) continue
        return { toolName, toolCallId: part.toolCallId, input: part.input }
    }
    return null
}

/**
 * Whether the hub chat sends the conversation back on its own: a widget just answered leaves the
 * turn waiting on it. A build ends on an answered tool call too, and the empty step runScript closes
 * on never reaches the browser's copy of the message (the SDK writes no state on a bare step chunk):
 * sent back, it lands on a hub that is done with the onboarding and answers onboarding_over.
 */
export function resumesAfterAnswer({ messages }: { messages: UIMessage[] }): boolean {
    if (messages.at(-1)?.parts.some(part => part.type === 'tool-build_team')) return false
    return lastAssistantMessageIsCompleteWithToolCalls({ messages })
}

/**
 * The engine foreman's question, read the way the agent chat reads its pending HITL call: the last
 * message is the assistant's and its last HITL call is still unanswered, since the answer is the
 * user message that would follow it. Claude reaches the call through the bridged MCP server, so its
 * name comes back namespaced.
 */
export function findPendingEngineHitl(messages: UIMessage[], status: ChatStatus): PendingWidget | null {
    if (status === 'streaming' || status === 'submitted') return null
    const last = messages[messages.length - 1]
    if (!last || last.role !== 'assistant') return null

    for (let index = last.parts.length - 1; index >= 0; index--) {
        const part = last.parts[index] as ToolPart
        const rawName = part.type === 'dynamic-tool' ? part.toolName : part.type.startsWith('tool-') ? part.type.slice('tool-'.length) : null
        if (!rawName || !part.toolCallId) continue
        const kind = hitlKindOf(rawName)
        if (kind !== 'question' && kind !== 'approval') continue
        const input = (part.input ?? part.rawInput ?? {}) as Record<string, unknown>
        if (!hitlInputIsUsable(kind, input)) return null
        return { toolName: stripBridgePrefix(rawName) as EngineHitlToolName, toolCallId: part.toolCallId, input }
    }
    return null
}
