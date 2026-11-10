// The shape of every human-in-the-loop tool call the engine can pause on, read back from the raw
// tool input. Lives here because the web chat and the iOS one both parse it, and because the
// strings sent back are a protocol the agent reads: two wordings would be two protocols.
import { appendAttachmentsRef, attachmentDisplayName, buildAttachmentsRef, parseAttachments } from './chat-attachments.js'
import { stripBridgePrefix } from './chat-tool-name.js'
import type { TakeoverResult } from './desktop.js'

export type QuestionOption = { label: string; description?: string }

export type QuestionItem = { question: string; header?: string; options: QuestionOption[]; multiple?: boolean }

export type ApprovalItem = {
    action: string
    detail?: string
}

export type ApprovalDecision = ApprovalItem & {
    decision: 'approved' | 'declined'
    note?: string
}

export type SecretRequestItem = {
    key: string
    label: string
    help?: string
    docsUrl?: string
    // The site a screen secret signs in to (a password typed with the computer's type_secret).
    // Absent for ordinary credentials referenced as ${KEY} in configs and commands.
    site?: string
}

export type ServiceSuggestionItem = { slug: string; reason?: string }

export type TakeoverRequest = { url: string; reason: string }

export type McpSignInRequest = { name: string; reason?: string }

export type HitlKind = 'question' | 'approval' | 'secret' | 'service' | 'mcp' | 'takeover'

export const HITL_TOOL_NAMES = {
    ask_user: 'question',
    request_approval: 'approval',
    request_secret: 'secret',
    suggest_service: 'service',
    request_mcp_sign_in: 'mcp',
    request_takeover: 'takeover',
} as const satisfies Record<string, HitlKind>

export function hitlKindOf(toolName: string): HitlKind | null {
    return HITL_TOOL_NAMES[stripBridgePrefix(toolName) as keyof typeof HITL_TOOL_NAMES] ?? null
}

// What the run is resumed with when the user closes a block instead of answering it. The agent
// reads these, so both surfaces have to send the very same sentence.
export const HITL_CANCELLED = {
    question: '[User dismissed the questions without answering]',
    secret: '[User declined to provide the credentials]',
    service: '[User dismissed the app setup without configuring]',
    mcp: '[User skipped signing in to the MCP server]',
    takeover: '[User declined to take over the browser]',
} as const

function coerceJsonArray(value: unknown): unknown {
    if (typeof value !== 'string') return value
    try {
        return JSON.parse(value)
    } catch {
        return value
    }
}

const HITL_INPUT_KEYS: Record<HitlKind, string[]> = {
    // The singular keys are the legacy shapes persisted before these tools took batches.
    question: ['questions', 'question'],
    approval: ['approvals', 'action'],
    secret: ['secrets'],
    service: ['services'],
    mcp: ['name'],
    takeover: ['url'],
}

// A rejected tool call reaches the UI with its input stripped, and the forms below would then render
// their placeholders: an empty question card the user cannot answer. Better to fall through to the
// regular tool step, which at least shows what went wrong.
export function hitlInputIsUsable(kind: HitlKind, input: Record<string, unknown>): boolean {
    return HITL_INPUT_KEYS[kind].some(key => input[key] !== undefined && input[key] !== null)
}

function toQuestionOption(value: unknown): QuestionOption | null {
    if (typeof value === 'string') return value.trim() ? { label: value } : null
    if (!value || typeof value !== 'object') return null
    const { label, description } = value as { label?: unknown; description?: unknown }
    if (typeof label !== 'string' || !label.trim()) return null
    return typeof description === 'string' && description.trim() ? { label, description } : { label }
}

function toQuestionItem(question: unknown, options: unknown, multiple: unknown, header?: unknown): QuestionItem {
    const choices = Array.isArray(options) ? options.map(toQuestionOption).filter(option => option !== null) : []
    return {
        question: String(question ?? 'The coworker has a question'),
        ...(typeof header === 'string' && header.trim() ? { header } : {}),
        options: choices,
        multiple: multiple === true && choices.length > 0,
    }
}

export function pendingQuestions(input: Record<string, unknown>): QuestionItem[] {
    const questions = coerceJsonArray(input.questions)
    if (Array.isArray(questions)) {
        return questions.map(value => {
            const item = (value ?? {}) as { question?: unknown; header?: unknown; options?: unknown; suggestions?: unknown; multiple?: unknown }
            const options = Array.isArray(item.options) ? item.options : item.suggestions
            return toQuestionItem(item.question, options, item.multiple, item.header)
        })
    }

    return [toQuestionItem(input.question, Array.isArray(input.options) ? input.options : input.suggestions, input.multiple)]
}

// An option written as an object (a label with its description) is the first ask_user shape an iOS
// build that shipped before it cannot draw: it would hand the object to a text node. The server
// stamps such a call v2 on its way to every client, since the model never writes `v` itself.
const QUESTION_OPTIONS_VERSION = 2

function questionsCarryOptionObjects(input: Record<string, unknown>): boolean {
    const questions = coerceJsonArray(input.questions)
    if (!Array.isArray(questions)) return false
    return questions.some(value => {
        const item = (value ?? {}) as { options?: unknown; suggestions?: unknown }
        const options = Array.isArray(item.options) ? item.options : item.suggestions
        return Array.isArray(options) && options.some(option => option !== null && typeof option === 'object')
    })
}

export function withHitlVersion<T>(toolName: string | undefined, input: T): T {
    if (!toolName || hitlKindOf(toolName) !== 'question') return input
    if (!input || typeof input !== 'object' || Array.isArray(input)) return input
    const record = input as Record<string, unknown>
    if (hitlVersionOf(record) >= QUESTION_OPTIONS_VERSION || !questionsCarryOptionObjects(record)) return input
    return { ...record, v: QUESTION_OPTIONS_VERSION } as T
}

export type QuestionAnswer = { question: string; answers: string[]; attachments?: string[] }

// Each block names its own files so the agent knows which answer they belong to, while the paths
// travel once in the trailing marker, which is what renders them as tiles in the bubble.
export function serializeAnswers(answers: QuestionAnswer[]): string {
    const blocks = answers.map(a => {
        const values = a.answers.map(value => value.trim()).filter(Boolean)
        const files = a.attachments ?? []
        if (values.length === 0 && files.length === 0) return `**${a.question}**\n[skipped]`
        const lines = values.length > 1 ? values.map(value => `- ${value}`) : values
        if (files.length > 0) lines.push(`Attached: ${files.map(attachmentDisplayName).join(', ')}`)
        return `**${a.question}**\n${lines.join('\n')}`
    })
    const text = `Here are my answers:\n\n${blocks.join('\n\n')}`
    const paths = answers.flatMap(a => a.attachments ?? [])
    return paths.length > 0 ? appendAttachmentsRef(text, buildAttachmentsRef(paths)) : text
}

export function pendingApprovals(input: Record<string, unknown>): ApprovalItem[] {
    const approvals = coerceJsonArray(input.approvals)
    if (Array.isArray(approvals) && approvals.length > 0) {
        return approvals.map(value => {
            const item = (value ?? {}) as { action?: unknown; detail?: unknown }
            return {
                action: String(item.action ?? 'The coworker requests approval'),
                detail: typeof item.detail === 'string' ? item.detail : undefined,
            }
        })
    }

    // Read compatibility for approval calls persisted before request_approval accepted batches.
    return [
        {
            action: String(input.action ?? 'The coworker requests approval'),
            detail: typeof input.detail === 'string' ? input.detail : undefined,
        },
    ]
}

export function pendingSecrets(input: Record<string, unknown>): SecretRequestItem[] {
    const secrets = coerceJsonArray(input.secrets)
    if (!Array.isArray(secrets)) return []
    return secrets
        .map(value => {
            const item = (value ?? {}) as { key?: unknown; label?: unknown; help?: unknown; docsUrl?: unknown; site?: unknown }
            return {
                key: String(item.key ?? ''),
                label: String(item.label ?? item.key ?? 'Credential'),
                help: typeof item.help === 'string' ? item.help : undefined,
                docsUrl: typeof item.docsUrl === 'string' ? item.docsUrl : undefined,
                site: typeof item.site === 'string' && item.site.trim() ? item.site.trim() : undefined,
            }
        })
        .filter(item => item.key.length > 0)
}

export function pendingServices(input: Record<string, unknown>): ServiceSuggestionItem[] {
    const services = coerceJsonArray(input.services)
    if (!Array.isArray(services)) return []
    return services
        .map(value => {
            const item = (value ?? {}) as { slug?: unknown; reason?: unknown }
            return { slug: String(item.slug ?? ''), reason: typeof item.reason === 'string' ? item.reason : undefined }
        })
        .filter(item => item.slug.length > 0)
}

export function pendingMcpSignIn(input: Record<string, unknown>): McpSignInRequest {
    return {
        name: typeof input.name === 'string' ? input.name : '',
        reason: typeof input.reason === 'string' && input.reason.trim() ? input.reason.trim() : undefined,
    }
}

export function pendingTakeover(input: Record<string, unknown>): TakeoverRequest {
    return {
        url: typeof input.url === 'string' ? input.url : '',
        reason: typeof input.reason === 'string' && input.reason.trim() ? input.reason.trim() : 'The coworker needs you in its browser',
    }
}

const TAKEOVER_HEADER = 'Browser handed back.'
const TAKEOVER_SAVED = 'Whatever I did there is saved in your browser profile.'
const TAKEOVER_CLOSED = 'The window is closed: open the page again with computer_open_app when you were working on your screen, with browser_navigate otherwise, and check what it shows before you go on.'
const TAKEOVER_LEFT_OPEN = 'The window is still open on your screen, on that page: take a screenshot to see where it stands before you go on. browser_navigate reads in that same window.'

// The page the browser was on tells the agent whether the wall was passed, without it having to ask.
export function serializeTakeoverResult({ url, open }: TakeoverResult): string {
    return `${TAKEOVER_HEADER}\n${url ? `I left your browser on ${url}` : 'I closed your browser.'}\n\n${TAKEOVER_SAVED} ${url && open ? TAKEOVER_LEFT_OPEN : TAKEOVER_CLOSED}`
}

const TAKEOVER_RESULT = /^Browser handed back\.\n(?:I left your browser on (\S+)|I closed your browser\.)\n\nWhatever I did there is saved/

export function parseTakeoverResult(text: string): { url: string | null } | null {
    const match = TAKEOVER_RESULT.exec(text.trim())
    return match ? { url: match[1] ?? null } : null
}

// Resumes the run with the names of the variables that were filled, never a value: the
// credentials go straight to the engine's agent .env and must not reach the conversation.
export function serializeSecretResult(secrets: SecretRequestItem[], providedKeys: string[]): string {
    const provided = new Set(providedKeys)
    const lines = secrets.map(item => `- ${item.key}: ${provided.has(item.key) ? 'provided (stored as a coworker variable)' : 'skipped'}`)
    return `Credential setup result:\n${lines.join('\n')}\n\nReference a provided variable as \${KEY} in an MCP server config (headers, url, env, args) or in a command. Never ask for the value itself: it is not available to you.`
}

// A reset the user walked away from is not the same as never touching the connector: the agent
// must not read it as "the user declined this one".
export type ServiceSetupOutcome = 'connected' | 'skipped' | 'reset' | 'not-found'

// `replaces` is the name of the app the agent asked for when the user picked an alternative in its
// place, so the agent knows to work with the other app rather than wait for the one it named.
export function serializeServiceSetupResult(entries: { slug: string; name: string; outcome: ServiceSetupOutcome; replaces?: string }[]): string {
    const lines = entries.length === 0 ? ['- (no apps suggested)'] : entries.map(entry => {
        if (entry.outcome === 'not-found') return `- ${entry.slug}: not found in the catalog`
        const name = entry.replaces ? `${entry.name} (instead of ${entry.replaces})` : entry.name
        if (entry.outcome === 'connected') return `- ${name}: connected`
        if (entry.outcome === 'reset') return `- ${name}: connection reset, not reconnected`
        return `- ${name}: skipped`
    })
    return `App setup result:\n${lines.join('\n')}\n\nPlease continue.`
}

export function serializeMcpSignInResult(name: string): string {
    return `MCP sign-in result:\n- ${name}: connected\n\nIts tools are available now. Please continue.`
}

type HitlPart = { type: string; toolCallId?: string; toolName?: string; input?: unknown; rawInput?: unknown; output?: unknown }

export type PendingHitl = { kind: HitlKind; toolCallId: string; input: Record<string, unknown>; output: unknown }

// The question, approval, secret... the agent stopped on, when the transcript ends on one: the last
// HITL call of the closing assistant message. Shared by the web and the app chat. The caller still
// rules out a live stream and a session already idle, whose block was closed.
export function findPendingHitl(messages: readonly { role: string; parts: readonly unknown[] }[], dismissedCallId: string | null = null): PendingHitl | null {
    const last = messages[messages.length - 1]
    if (!last || last.role !== 'assistant') return null
    for (let index = last.parts.length - 1; index >= 0; index--) {
        const part = last.parts[index] as HitlPart
        const toolName = part.toolName ?? (part.type.startsWith('tool-') ? part.type.slice('tool-'.length) : '')
        const kind = hitlKindOf(toolName)
        if (!kind || !part.toolCallId) continue
        // A call rejected by input validation keeps its payload in `rawInput`, the AI SDK moving it
        // out of `input`. Recover it so the form still holds the real questions, and skip the call
        // entirely when nothing usable is left.
        const input = (part.input ?? part.rawInput ?? {}) as Record<string, unknown>
        if (!hitlInputIsUsable(kind, input)) return null
        if (part.toolCallId === dismissedCallId) return null
        return { kind, toolCallId: part.toolCallId, input, output: part.output }
    }
    return null
}

// How a HITL input grows without stranding a client that shipped earlier, the iOS app above all,
// which only updates when its users do: a field is never removed nor given another meaning, and a
// shape a client could not read the old way takes a new version in `v` (absent means 1). A client
// draws the versions it knows and, past them, shows what is asked as text to be answered in its
// composer.
export function hitlVersionOf(input: Record<string, unknown>): number {
    const version = input.v
    return typeof version === 'number' && Number.isInteger(version) && version > 0 ? version : 1
}

export type UnknownPendingCall = { toolCallId: string; toolName: string; input: Record<string, unknown> }

// The tool call the closing assistant message stopped on, still without a result, when it is no HITL
// this client knows: one an engine newer than the client pauses on. A run that died mid-call ends the
// same way, so the caller only asks once the session says it waits on a human.
export function findUnknownPendingCall(messages: readonly { role: string; parts: readonly unknown[] }[]): UnknownPendingCall | null {
    const last = messages[messages.length - 1]
    if (!last || last.role !== 'assistant') return null
    for (let index = last.parts.length - 1; index >= 0; index--) {
        const part = last.parts[index] as HitlPart & { state?: string }
        const isCall = part.type === 'dynamic-tool' || part.type.startsWith('tool-')
        if (!isCall) continue
        const toolName = stripBridgePrefix(part.toolName ?? part.type.slice('tool-'.length))
        if (!part.toolCallId || hitlKindOf(toolName) || part.output !== undefined || part.state === 'output-available' || part.state === 'output-error') return null
        return { toolCallId: part.toolCallId, toolName, input: (part.input ?? part.rawInput ?? {}) as Record<string, unknown> }
    }
    return null
}

export type PendingAlert = { toolCallId: string | null; message: string }

const ALERT_FALLBACK_MESSAGE = 'The coworker sent you a notification.'

function toolNameOf(part: { type: string; toolName?: string }): string {
    const raw = part.toolName ?? (part.type.startsWith('tool-') ? part.type.slice('tool-'.length) : '')
    return stripBridgePrefix(raw)
}

// The notification the session is waiting on: the last `notify_user` raised with kind `info`. It is
// not necessarily the last tool call, since it does not stop the run. The status in the database is
// what decides whether one is pending, so a transcript that no longer holds the call (history
// trimmed, notification raised in an earlier run) still gets a block to acknowledge.
export function findPendingAlert(messages: readonly { role: string; parts: readonly unknown[] }[]): PendingAlert {
    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i]
        if (message.role !== 'assistant') continue
        for (let j = message.parts.length - 1; j >= 0; j--) {
            const part = message.parts[j] as { type: string; toolCallId?: string; toolName?: string; input?: unknown }
            if (typeof part?.type !== 'string' || toolNameOf(part) !== 'notify_user') continue
            const input = (part.input ?? {}) as Record<string, unknown>
            // `kind` defaults to `info` in the tool schema, so a call that left it out is one of these.
            if ((input.kind ?? 'info') !== 'info') continue
            return { toolCallId: part.toolCallId ?? null, message: typeof input.message === 'string' && input.message.trim() ? input.message : ALERT_FALLBACK_MESSAGE }
        }
    }
    return { toolCallId: null, message: ALERT_FALLBACK_MESSAGE }
}

export function serializeApprovalDecisions(decisions: ApprovalDecision[]): string {
    const blocks = decisions.map((item, index) => {
        const status = item.decision === 'approved' ? 'APPROVED' : 'DECLINED'
        const note = item.decision === 'declined' && item.note?.trim() ? `\nReason: ${item.note.trim()}` : ''
        return `${index + 1}. **${status}** — ${item.action}${note}`
    })

    return `Here are my approval decisions:\n\n${blocks.join('\n\n')}\n\nPerform only the approved actions. Do not perform any declined action or attempt any workaround to achieve the same result.`
}

// The replies above, read back so the thread can draw what the user decided instead of the prose
// written for the agent. Each parser only accepts the exact shape its serializer writes: anything
// else is something the user typed, and stays a bubble.

const SERVICE_RESULT = /^App setup result:\n([\s\S]*)\n\nPlease continue\.$/
const SERVICE_SUFFIXES: [string, ServiceSetupOutcome][] = [
    [': connected', 'connected'],
    [': connection reset, not reconnected', 'reset'],
    [': not found in the catalog', 'not-found'],
    [': skipped', 'skipped'],
]
const INSTEAD_OF = /^(.*) \(instead of (.*)\)$/

export type ServiceSetupEntry = { name: string; outcome: ServiceSetupOutcome; replaces?: string }

function parseServiceLine(line: string): ServiceSetupEntry | null {
    if (!line.startsWith('- ')) return null
    const body = line.slice(2)
    const match = SERVICE_SUFFIXES.find(([suffix]) => body.endsWith(suffix))
    if (!match) return null
    const [suffix, outcome] = match
    const label = body.slice(0, -suffix.length)
    const replaced = outcome === 'not-found' ? null : INSTEAD_OF.exec(label)
    return replaced ? { name: replaced[1], outcome, replaces: replaced[2] } : { name: label, outcome }
}

// A `not-found` entry carries the slug the agent asked for, since the catalog had no name for it.
export function parseServiceSetupResult(text: string): ServiceSetupEntry[] | null {
    const match = SERVICE_RESULT.exec(text.trim())
    if (!match) return null
    if (match[1] === '- (no apps suggested)') return []
    const entries = match[1].split('\n').map(parseServiceLine)
    return entries.every(entry => entry !== null) ? (entries as ServiceSetupEntry[]) : null
}

const SECRET_RESULT = /^Credential setup result:\n([\s\S]*)\n\nReference a provided variable as/
// Transcripts written before the copy said "coworker" still carry "an agent variable".
const SECRET_LINE = /^- (\S+): (provided \(stored as (?:an agent|a coworker) variable\)|skipped)$/

export function parseSecretResult(text: string): { key: string; provided: boolean }[] | null {
    const match = SECRET_RESULT.exec(text.trim())
    if (!match) return null
    const entries = match[1].split('\n').map(line => SECRET_LINE.exec(line))
    if (!entries.every(entry => entry !== null)) return null
    return (entries as RegExpExecArray[]).map(entry => ({ key: entry[1], provided: entry[2] !== 'skipped' }))
}

const MCP_SIGN_IN_RESULT = /^MCP sign-in result:\n- (\S+): connected\n\nIts tools are available now\. Please continue\.$/

export function parseMcpSignInResult(text: string): { name: string } | null {
    const match = MCP_SIGN_IN_RESULT.exec(text.trim())
    return match ? { name: match[1] } : null
}

const APPROVAL_RESULT = /^Here are my approval decisions:\n\n([\s\S]*)\n\nPerform only the approved actions\./
const APPROVAL_BLOCK_START = /\n\n(?=\d+\. \*\*(?:APPROVED|DECLINED)\*\* — )/
const APPROVAL_BLOCK = /^\d+\. \*\*(APPROVED|DECLINED)\*\* — ([^\n]*)(?:\nReason: ([\s\S]*))?$/

export function parseApprovalDecisions(text: string): Omit<ApprovalDecision, 'detail'>[] | null {
    const match = APPROVAL_RESULT.exec(text.trim())
    if (!match) return null
    const blocks = match[1].split(APPROVAL_BLOCK_START).map(block => APPROVAL_BLOCK.exec(block))
    if (!blocks.every(block => block !== null)) return null
    return (blocks as RegExpExecArray[]).map(([, status, action, note]): Omit<ApprovalDecision, 'detail'> => (note === undefined ? { action, decision: status === 'APPROVED' ? 'approved' : 'declined' } : { action, decision: 'declined', note }))
}

const ANSWERS_HEADER = 'Here are my answers:\n\n'
const QUESTION_LINE = /^\*\*(.+)\*\*$/
const ATTACHED_LINE = /^Attached: (.+)$/

// A block starts at a bold line after a blank one. An answer typed with a line of its own in bold
// would split there, which only costs that one answer its layout.
export function parseAnswers(text: string): QuestionAnswer[] | null {
    const withFiles = parseAttachments(text)
    const body = (withFiles?.text ?? text).trim()
    if (!body.startsWith(ANSWERS_HEADER)) return null
    const paths = withFiles?.paths ?? []
    const blocks = body.slice(ANSWERS_HEADER.length).split(/\n\n(?=\*\*.+\*\*\n)/)
    const answers: QuestionAnswer[] = []
    for (const block of blocks) {
        const [heading, ...lines] = block.split('\n')
        const question = QUESTION_LINE.exec(heading)
        if (!question || lines.length === 0) return null
        if (lines.length === 1 && lines[0] === '[skipped]') {
            answers.push({ question: question[1], answers: [] })
            continue
        }
        const attached = ATTACHED_LINE.exec(lines.at(-1) ?? '')
        const values = attached ? lines.slice(0, -1) : lines
        const listed = values.length > 1 && values.every(line => line.startsWith('- '))
        const answer: QuestionAnswer = { question: question[1], answers: listed ? values.map(line => line.slice(2)) : values.length > 0 ? [values.join('\n')] : [] }
        if (attached) {
            const names = attached[1].split(', ')
            answer.attachments = paths.filter(path => names.includes(attachmentDisplayName(path)))
        }
        answers.push(answer)
    }
    return answers
}

export type HitlReply =
    | { kind: 'service'; entries: ServiceSetupEntry[] }
    | { kind: 'question'; answers: QuestionAnswer[] }
    | { kind: 'secret'; entries: { key: string; provided: boolean }[] }
    | { kind: 'mcp'; name: string }
    | { kind: 'approval'; decisions: Omit<ApprovalDecision, 'detail'>[] }
    | { kind: 'takeover'; url: string | null }
    | { kind: 'cancelled'; of: keyof typeof HITL_CANCELLED }

export function parseHitlReply(text: string): HitlReply | null {
    const trimmed = text.trim()
    const cancelled = (Object.keys(HITL_CANCELLED) as (keyof typeof HITL_CANCELLED)[]).find(kind => HITL_CANCELLED[kind] === trimmed)
    if (cancelled) return { kind: 'cancelled', of: cancelled }
    const services = parseServiceSetupResult(trimmed)
    if (services) return { kind: 'service', entries: services }
    const answers = parseAnswers(trimmed)
    if (answers) return { kind: 'question', answers }
    const secrets = parseSecretResult(trimmed)
    if (secrets) return { kind: 'secret', entries: secrets }
    const mcp = parseMcpSignInResult(trimmed)
    if (mcp) return { kind: 'mcp', name: mcp.name }
    const decisions = parseApprovalDecisions(trimmed)
    if (decisions) return { kind: 'approval', decisions }
    const takeover = parseTakeoverResult(trimmed)
    if (takeover) return { kind: 'takeover', url: takeover.url }
    return null
}
