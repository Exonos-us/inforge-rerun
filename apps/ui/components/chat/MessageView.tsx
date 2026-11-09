'use client'

import { Message, MessageAction, MessageActions, MessageContent } from '@/components/ai-elements/message'
import { Source, Sources, SourcesContent, SourcesTrigger } from '@/components/ai-elements/sources'
import { Suggestion, Suggestions } from '@/components/ai-elements/suggestion'
import { ApprovalBlock } from '@/components/chat/ApprovalBlock'
import { AgentInstallBlock } from '@/components/chat/AgentInstallBlock'
import { AgentWorkspaceMessage } from '@/components/chat/AgentWorkspaceMessage'
import type { ReadChatFile } from '@/components/chat/AttachmentLightbox'
import { CopyAction } from '@/components/chat/CopyAction'
import { MessageAttachments } from '@/components/chat/MessageAttachments'
import { FileCard, type FileAccess } from '@/components/chat/FileCard'
import { HitlReceipt } from '@/components/chat/HitlReceipt'
import { NeedsAuthCard, NotificationCard, SetupCompleteCard } from '@/components/chat/SetupEventCards'
import { McpServerCard } from '@/components/chat/McpServerCard'
import { TableCard } from '@/components/chat/TableCard'
import { CompactionStep, type CompactionData } from '@/components/chat/CompactionBlock'
import { ExpandableMessage } from '@/components/chat/ExpandableMessage'
import { MessageBubbles } from '@/components/chat/MessageBubbles'
import { MessageTimeTooltip } from '@/components/chat/MessageTimeTooltip'
import { PaidSourcesPill } from '@/components/chat/PaidSourcesPill'
import { USER_BUBBLE_INK, USER_BUBBLE_SHAPE } from '@/components/chat/bubble-styles'
import { ReasoningStep } from '@/components/chat/ReasoningBlock'
import { ScheduledRunBlock } from '@/components/chat/ScheduledRunBlock'
import { BrainChangeBlock, brainChangeOf } from '@/components/chat/BrainChangeBlock'
import { BrainProposalBlock } from '@/components/chat/BrainProposalBlock'
import { SkillProposalBlock } from '@/components/chat/SkillProposalBlock'
import { StepGroup, type StepGroupItem } from '@/components/chat/StepGroup'
import { SubRunBlock } from '@/components/chat/SubRunBlock'
import { ToolCallStep, toolStatusOf, type ToolState } from '@/components/chat/ToolCallBlock'
import { VoiceUserMessage } from '@/components/chat/VoiceUserMessage'
import { WebhookRunBlock } from '@/components/chat/WebhookRunBlock'
import { ServiceInstalledBlock } from '@/components/services/ServiceInstalledBlock'
import { PublishedChatCard } from '@/components/published/PublishedChatCard'
import { usePublishedAccessEnabled } from '@/components/layout/FeatureFlagsProvider'
import { parseAttachments } from '@/lib/chat/attachments-marker'
import { hitlKindOf, parseHitlReply } from '@/lib/chat-hitl'
import type { HitlCallPart } from '@/lib/chat/hitl-receipts'
import type { ComposerMention } from '@/lib/chat/composer-links'
import { parseInstallMessage } from '@/lib/chat/install-marker'
import { mcpRegisterCardOf } from '@/lib/chat/mcp-register-card'
import type { RawUrlFor } from '@/lib/files/raw-url'
import { stripBridgePrefix } from '@/lib/chat/bridge-name'
import { cancelSubRunAction } from '@/app/api/_actions/agent.actions'
import { isSubRunLive, pairSubRuns, SUB_RUN_TOOL_NAMES } from '@/lib/chat/sub-run-progress'
import { parseHubOutput } from '@/lib/services/parse-hub-output'
import type { InstallResult, PublishResult } from '@/lib/services/types'
import type { EngineSkillProposal } from '@/lib/engine/types'
import { useToolDisplay } from '@/hooks/useToolDisplay'
import { parseTriggerPayload } from '@/lib/triggers/trigger-payload'
import { parseScheduledRun } from '@/lib/schedules/scheduled-run'
import { parseVoiceMessage } from '@/lib/voice/marker'
import { cn } from '@/lib/utils'
import { QUICK_REPLIES_TOOL, fileCardSchema, quickRepliesOf, quickReplyDraft, skillProposalIdOf, tableCardSchema, toolActivityOf, type MessageFeedbackRating, type PaidTurnSources } from '@rerun/contracts'
import type { UIMessage } from 'ai'
import { BrainIcon, FoldVerticalIcon, RefreshCcwIcon, ThumbsDownIcon, ThumbsUpIcon } from '@/lib/icons'
import { Fragment, isValidElement, memo, type ReactNode } from 'react'

type RenderStep =
    | ({ kind: 'group-item' } & StepGroupItem)
    | { kind: 'standalone'; key: string; node: ReactNode; trace?: boolean }
    | { kind: 'text'; key: string; node: ReactNode; markdown: string; streaming: boolean }
    | { kind: 'under-text'; key: string; node: ReactNode }
    | null

// One assistant turn as a caller's own layout receives it: the words, the traces of the work
// (tool rows, reasoning, sub-runs) and the blocks the agent shows (cards, notices).
export type AssistantStep =
    | { kind: 'text'; key: string; node: ReactNode; markdown: string; streaming: boolean }
    | { kind: 'trace'; key: string; node: ReactNode }
    | { kind: 'block'; key: string; node: ReactNode }

type NormalizedSource = { url?: string; title?: string }

type MessagePartLike = { type: string; text?: string; [key: string]: unknown }

export function messageText(message: { parts: readonly MessagePartLike[] }): string {
    return message.parts
        .filter((p): p is { type: 'text'; text: string } => p.type === 'text' && 'text' in p)
        .map(p => p.text)
        .join('')
}

function messageSources(message: { parts: readonly MessagePartLike[] }): NormalizedSource[] {
    return message.parts
        .filter(p => p.type === 'source-url' || p.type === 'source-document')
        .map(p => {
            const sp = p as { url?: string; title?: string; filename?: string }
            return { url: sp.url, title: sp.title ?? sp.filename ?? sp.url }
        })
}

function FeedbackAction({ rating, current, onRate }: { rating: MessageFeedbackRating; current: MessageFeedbackRating | null; onRate: (rating: MessageFeedbackRating) => void }) {
    const pressed = current === rating
    const Glyph = rating === 'up' ? ThumbsUpIcon : ThumbsDownIcon
    return (
        <MessageAction tooltip={rating === 'up' ? 'Good response' : 'Bad response'} aria-pressed={pressed} className={cn(pressed ? 'bg-accent text-foreground' : 'text-muted-foreground')} onClick={() => onRate(rating)}>
            <Glyph className="size-3.5" />
        </MessageAction>
    )
}

export type MessageViewProps = {
    message: { id: string; role: UIMessage['role']; parts: readonly MessagePartLike[] }
    isActive?: boolean
    // Only the thread's last assistant message draws the coworker beside its steps.
    isLastAssistant?: boolean
    agentId?: string
    pendingHitlToolCallId?: string
    // The custom MCP server a pending sign-in card is about: its Connect lives on that card.
    pendingMcpSignIn?: string
    // On a user reply to a setup block: the call it answers, which fills in what the reply leaves out.
    hitlCall?: HitlCallPart
    pendingAlertToolCallId?: string
    activeRunId?: string | null
    onStopTask?: (taskId: string) => void
    onSendMessage?: (opts: { text: string }) => void
    // Where a quick reply that still needs a value from the user goes to be finished. Without it,
    // such a reply is not offered at all: sent as is, it would reach the coworker empty-handed.
    onDraftReply?: (text: string) => void
    // The agent's suggested replies only stand while this is the last word of a finished turn.
    showQuickReplies?: boolean
    onRegenerate?: (messageId: string) => void
    // Thumbs only show when this is passed, so read-only transcripts and the onboarding stay without them.
    onRateMessage?: (messageId: string, rating: MessageFeedbackRating, messageText: string) => void
    feedbackRating?: MessageFeedbackRating | null
    // Skill proposals live in their own table, keyed by the tool call that raised them: the tool
    // result is frozen at write time, and a widget has to survive a reload with a live status.
    skillProposals?: Map<string, EngineSkillProposal>
    decidingProposalId?: string | null
    onDecideProposal?: (proposalId: string, decision: 'accept' | 'dismiss') => void
    // The proposals the dock above the composer is holding: they are decided there, not here.
    pinnedProposalIds?: ReadonlySet<string>
    // Where attachments and recordings are read from when they are not a Box's. `agentId` says
    // which Box owns a file; these two say the bytes are reachable at all.
    rawUrlFor?: RawUrlFor
    readFile?: ReadChatFile
    sharedFiles?: FileAccess
    // A caller's own rendering for a tool step, tried before everything below. `undefined` falls
    // through to the normal collapsed step, `null` hides it, a node replaces it. The foreman's
    // widgets come in through here, so this file keeps knowing nothing about them.
    renderToolPart?: (part: ToolPartLike) => ReactNode | null | undefined
    // The agent's guided install is still open, so its divider reads as started, not complete.
    installing?: boolean
    // The `@agent` and `/skill` the composer drew as tokens, drawn the same in the user's bubble.
    mentions?: ComposerMention[]
    // A caller's own arrangement of an assistant turn, in place of the stacked steps. Has to keep
    // its identity between renders, or the memo below stops holding.
    assistantLayout?: (steps: AssistantStep[]) => ReactNode
    // When the message was written, shown on hover of its bubble.
    createdAt?: string
    // Where the paid data of the turn came from, on the turn's last assistant message only.
    paidSources?: PaidTurnSources
}

export type ToolPartLike = { toolName: string; toolCallId: string; state: string; input?: unknown; output?: unknown; errorText?: string }

// Wraps what `renderToolPart` returns for a tool that runs before the model writes about it: the
// call lands ahead of the text in the parts, yet it belongs under the text it illustrates.
export function UnderText({ children }: { children: ReactNode }) {
    return children
}

function MessageViewInner({ message, isActive = false, isLastAssistant = false, agentId, pendingHitlToolCallId, pendingMcpSignIn, hitlCall, pendingAlertToolCallId, activeRunId, onStopTask: stopTaskOverride, onSendMessage, onDraftReply, showQuickReplies = false, onRegenerate, onRateMessage, feedbackRating = null, rawUrlFor, readFile, sharedFiles, skillProposals, decidingProposalId, onDecideProposal, pinnedProposalIds, renderToolPart, installing, mentions, assistantLayout, createdAt, paidSources }: MessageViewProps) {
    const toolDisplay = useToolDisplay(agentId)
    const publishedAccess = usePublishedAccessEnabled()
    const sources = message.role === 'assistant' ? messageSources(message) : []
    const install = message.role === 'user' ? parseInstallMessage(messageText(message)) : null
    const hitlReply = message.role === 'user' && !install ? parseHitlReply(messageText(message)) : null
    const scheduledRun = message.role === 'user' && !install && !hitlReply ? parseScheduledRun(messageText(message)) : null
    const triggerPayload = message.role === 'user' && !install && !hitlReply && !scheduledRun ? parseTriggerPayload(messageText(message)) : null
    const automated = !!scheduledRun || !!triggerPayload
    // A voice message sent with files carries the attachments marker after its voice marker.
    const attachments = message.role === 'user' && !install && !hitlReply && !automated ? parseAttachments(messageText(message)) : null
    const voice = message.role === 'user' && !install && !hitlReply && !automated ? parseVoiceMessage(attachments?.text ?? messageText(message)) : null
    const subRuns = pairSubRuns(message.parts)
    const quickReplies = showQuickReplies && onSendMessage ? quickRepliesOf(message).filter(reply => onDraftReply || quickReplyDraft(reply) === null) : []
    const onStopTask = stopTaskOverride ?? (activeRunId && agentId ? (taskId: string) => void cancelSubRunAction(agentId, activeRunId, taskId) : undefined)

    // Files sent without a word: the thumbnails are the whole message, an empty bubble under them would be noise.
    if (attachments && !attachments.text) {
        return (
            <Message from={message.role}>
                <MessageAttachments agentId={agentId} paths={attachments.paths} rawUrlFor={rawUrlFor} readFile={readFile} />
            </Message>
        )
    }

    if (voice) return <VoiceUserMessage voice={voice} agentId={agentId} rawUrlFor={rawUrlFor} readFile={readFile} attachmentPaths={attachments?.paths} createdAt={createdAt} />

    const renderAssistantSteps = (): AssistantStep[] => {
        const lastPart = message.parts.length - 1
        const firstText = message.parts.findIndex(part => part.type === 'text' && !!part.text)
        const classify = (part: (typeof message.parts)[number], i: number): RenderStep => {
            const gkey = `${message.id}-${i}`
            if (part.type === 'text') {
                if (!part.text) return null
                const streaming = isActive && i === lastPart
                return { kind: 'text', key: gkey, markdown: part.text, streaming, node: <MessageBubbles agentId={agentId} isAnimating={streaming} createdAt={i === firstText ? createdAt : undefined}>{part.text}</MessageBubbles> }
            }
            if (part.type === 'reasoning') {
                const rp = part as { text: string }
                const streaming = isActive && i === lastPart
                if (!rp.text && !streaming) return null
                const node = <ReasoningStep text={rp.text} isStreaming={streaming} />
                return { kind: 'group-item', key: gkey, iconProps: { icon: BrainIcon }, node, status: streaming ? 'running' : 'done', runningLabel: 'Thinking' }
            }
            if (part.type === 'data-delegate' || part.type === 'data-call-agent') {
                const orphan = subRuns.orphans.get((part as { id?: string }).id ?? '')
                if (!orphan) return null
                const toolName = SUB_RUN_TOOL_NAMES[orphan.kind]
                const live = orphan.tasks.some(isSubRunLive)
                const node = <SubRunBlock toolName={toolName} agentId={agentId} state={live ? 'input-available' : 'output-available'} progress={orphan} onStopTask={onStopTask} dense={!live} />
                // A live sub-run opens itself and carries each task's stop button, so it stays out of the folded steps.
                return live ? { kind: 'standalone', key: gkey, node, trace: true } : { kind: 'group-item', key: gkey, iconProps: toolDisplay(toolName).iconProps, node, status: 'done' }
            }
            if (part.type === 'data-compaction') {
                const cp = part as unknown as { id?: string; data: CompactionData }
                const key = cp.id ?? gkey
                const node = <CompactionStep data={cp.data} />
                return { kind: 'group-item', key, iconProps: { icon: FoldVerticalIcon }, node, status: cp.data.status, runningLabel: 'Compacting' }
            }
            if (part.type.startsWith('tool-') || part.type === 'dynamic-tool') {
                const toolPart = part as { toolCallId: string; state: string; toolName?: string; input?: unknown; inputText?: string; output?: unknown; errorText?: string; type: string; approval?: { id: string } }
                // Claude reaches the builtins through the bridged `rerun` MCP server, which namespaces them.
                const toolName = stripBridgePrefix(toolPart.toolName ?? toolPart.type.replace(/^tool-/, ''))
                const key = toolPart.toolCallId
                const custom = renderToolPart?.({ toolName, toolCallId: key, state: toolPart.state, input: toolPart.input, output: toolPart.output, errorText: toolPart.errorText })
                if (custom === null) return null
                if (isValidElement(custom) && custom.type === UnderText) return { kind: 'under-text', key, node: custom }
                if (custom !== undefined) return { kind: 'standalone', key, node: custom }
                // Drawn as chips under the whole message, wherever the call sits among the parts.
                if (toolName === QUICK_REPLIES_TOOL) return null
                // A setup block still waiting is pinned above the composer, and once answered the
                // user's reply draws a receipt that says what was asked: the step adds nothing
                // either way. A failed call keeps its step, which is where the error shows.
                if (hitlKindOf(toolName) && (toolPart.toolCallId === pendingHitlToolCallId || toolPart.state === 'output-available')) return null
                // Same idea for the alert still pinned above the composer.
                if (toolPart.toolCallId === pendingAlertToolCallId) return null
                if (toolName === 'notify_user' && toolPart.state === 'output-available') {
                    const message = (toolPart.input as { message?: unknown } | undefined)?.message
                    const undelivered = JSON.stringify(toolPart.output ?? '').includes('Notification not delivered')
                    if (typeof message === 'string' && message.trim() && !undelivered) return { kind: 'standalone', key, node: <NotificationCard message={message} /> }
                }
                if (toolName === 'install_complete' && toolPart.state === 'output-available') {
                    const out = parseHubOutput<{ status?: string; summary?: string; activated?: { schedules?: string[]; triggers?: string[] } }>(toolPart.output)
                    if (out?.status === 'complete') {
                        return { kind: 'standalone', key, node: <SetupCompleteCard agentId={agentId} summary={out.summary ?? ''} schedules={out.activated?.schedules ?? []} triggers={out.activated?.triggers ?? []} /> }
                    }
                }
                // Only an actual install gets rich UI. Browsing the catalog (search,
                // list installed) stays a collapsed tool step: the agent often looks
                // things up mid-task and a full service card is noise there.
                if (toolName === 'rerun_hub_service_install' && toolPart.state === 'output-available') {
                    const out = parseHubOutput<InstallResult>(toolPart.output)
                    if (out?.status === 'installed') {
                        return { kind: 'standalone', key, node: <ServiceInstalledBlock agentId={agentId} name={out.name} toolNames={out.toolNames} /> }
                    }
                    if (out?.status === 'needs_auth') return { kind: 'standalone', key, node: <NeedsAuthCard agentId={agentId} slug={out.slug} name={out.name} /> }
                }
                // What a coworker published, and who can open it, where it said so.
                if (publishedAccess && toolName === 'rerun_hub_publish_file' && toolPart.state === 'output-available') {
                    const out = parseHubOutput<PublishResult>(toolPart.output)
                    if (out?.status === 'published' && out.slug) return { kind: 'standalone', key, node: <PublishedChatCard agentId={agentId} result={out} /> }
                }
                // A server registered outside the catalog: what the user sees in Apps, and the one
                // place a sign-in it still owes can be made.
                if ((toolName === 'mcp_register' || toolName === 'mcp_login') && toolPart.state === 'output-available') {
                    const card = mcpRegisterCardOf(toolName, toolPart.input, toolPart.output)
                    if (card) return { kind: 'standalone', key, node: <McpServerCard agentId={agentId} {...card} signInPending={card.name === pendingMcpSignIn} /> }
                }
                // A card is the agent showing something to the user, so it replaces the
                // collapsed tool step entirely. A payload we cannot read falls back to it.
                if (toolName === 'card_table' && toolPart.state === 'output-available') {
                    const card = tableCardSchema.safeParse(parseHubOutput(toolPart.output))
                    if (card.success) return { kind: 'standalone', key, node: <TableCard agentId={agentId} card={card.data} rawUrlFor={rawUrlFor} /> }
                }
                // A picture Codex generated on a ChatGPT plan comes back shaped like a file card.
                if ((toolName === 'card_file' || toolName === 'image_generation') && toolPart.state === 'output-available') {
                    const card = fileCardSchema.safeParse(parseHubOutput(toolPart.output))
                    if (card.success) return { kind: 'standalone', key, node: <FileCard agentId={agentId} card={card.data} rawUrlFor={rawUrlFor} readFile={readFile} sharedFiles={sharedFiles} /> }
                }
                // The proposal row replaces the tool step entirely. A call that only joined the
                // proposal already waiting shows nothing: that row is rendered where it was raised.
                // While the dock above the composer holds it the spot stays empty, and the
                // transcript takes the row back as a trace once the decision has landed.
                if (toolName === 'brain_propose' && toolPart.state === 'output-available') {
                    const out = parseHubOutput<{ status?: string; title?: string }>(toolPart.output)
                    const input = toolPart.input as { baseHash?: string | null } | undefined
                    if ((out?.status === 'proposed' || out?.status === 'updated') && out.title) {
                        return { kind: 'standalone', key, node: <BrainProposalBlock title={out.title} mode={input?.baseHash ? 'edit' : 'create'} /> }
                    }
                }
                if (toolPart.state === 'output-available') {
                    const change = brainChangeOf(toolName, toolPart.output)
                    if (change) return { kind: 'standalone', key, node: <BrainChangeBlock change={change} /> }
                }
                if (toolName === 'skill_propose') {
                    const proposalId = skillProposalIdOf(toolPart.output)
                    if (!proposalId || pinnedProposalIds?.has(proposalId)) return null
                    const proposal = skillProposals?.get(proposalId)
                    if (!proposal) return null
                    return {
                        kind: 'standalone',
                        key,
                        node: <SkillProposalBlock agentId={agentId} proposal={proposal} pending={decidingProposalId === proposal.id} onDecide={onDecideProposal} />,
                    }
                }
                if (toolPart.state === 'approval-requested' && activeRunId && agentId) {
                    return { kind: 'standalone', key, node: <ApprovalBlock toolName={toolName} input={toolPart.input} runId={activeRunId} agentId={agentId} /> }
                }
                const state = toolPart.state as ToolState
                const progress = subRuns.byToolCallId.get(toolPart.toolCallId)
                const status = toolStatusOf(state)
                if (progress && status === 'running') {
                    return { kind: 'standalone', key, trace: true, node: <SubRunBlock toolName={toolName} agentId={agentId} state={state} output={toolPart.output} errorText={toolPart.errorText} progress={progress} onStopTask={onStopTask} /> }
                }
                const node = progress ? (
                    <SubRunBlock toolName={toolName} agentId={agentId} state={state} output={toolPart.output} errorText={toolPart.errorText} progress={progress} onStopTask={onStopTask} dense />
                ) : (
                    <ToolCallStep toolName={toolName} agentId={agentId} state={state} input={toolPart.input} inputText={toolPart.inputText} output={toolPart.output} errorText={toolPart.errorText} />
                )
                const display = toolDisplay(toolName, toolPart.input)
                return { kind: 'group-item', key, iconProps: display.iconProps, node, status, runningLabel: toolActivityOf(toolName, toolPart.input) ?? `Running ${display.label}` }
            }
            return null
        }

        const rendered: AssistantStep[] = []
        let run: StepGroupItem[] = []
        let heldUnderText: { key: string; node: ReactNode }[] = []
        const releaseUnderText = () => {
            for (const held of heldUnderText) rendered.push({ kind: 'block', key: held.key, node: held.node })
            heldUnderText = []
        }
        let lastGroupAt = -1
        let lastGroupItems: StepGroupItem[] = []
        const flush = () => {
            if (run.length > 0) {
                lastGroupAt = rendered.length
                lastGroupItems = run
                rendered.push({ kind: 'trace', key: `group-${run[0].key}`, node: <StepGroup items={run} /> })
            }
            run = []
        }
        message.parts.forEach((part, i) => {
            const step = classify(part, i)
            if (!step) return
            if (step.kind === 'group-item') run.push(step)
            else if (step.kind === 'under-text') heldUnderText.push({ key: step.key, node: step.node })
            else if (step.kind === 'text') {
                flush()
                rendered.push(step)
                releaseUnderText()
            } else {
                flush()
                rendered.push({ kind: step.trace ? 'trace' : 'block', key: step.key, node: step.node })
            }
        })
        flush()
        releaseUnderText()
        // The coworker stands once in the thread, beside the last steps it took.
        if (isLastAssistant && lastGroupAt >= 0) rendered[lastGroupAt] = { ...rendered[lastGroupAt], node: <StepGroup items={lastGroupItems} agentId={agentId} /> }
        return rendered
    }

    const assistantSteps = message.role === 'assistant' ? renderAssistantSteps() : null
    const inkBubble = message.role === 'user'
    // The SDK pushes the assistant message before its first token, so its empty shell would
    // eat one of the conversation gaps and open a band above the loader.
    const showPaidSources = !!paidSources && !isActive
    if (assistantSteps && assistantSteps.length === 0 && sources.length === 0 && !showPaidSources) return null

    // Not the user speaking, so no bubble: a divider across the thread marks where the install, the
    // routine or the webhook began.
    if (install) return <AgentInstallBlock agentId={agentId} agentName={install.agentName} guide={install.guide} installing={installing} />
    if (scheduledRun) return <ScheduledRunBlock agentId={agentId} run={scheduledRun} />
    if (triggerPayload) return <WebhookRunBlock agentId={agentId} payload={triggerPayload} />

    // A setup block answered: what the user decided, not the reply written for the agent.
    if (hitlReply) return <HitlReceipt reply={hitlReply} call={hitlCall} agentId={agentId} rawUrlFor={rawUrlFor} readFile={readFile} />

    return (
        <Message from={message.role}>
            {attachments && <MessageAttachments agentId={agentId} paths={attachments.paths} rawUrlFor={rawUrlFor} readFile={readFile} />}
            <MessageTimeTooltip createdAt={inkBubble ? createdAt : undefined} side="left">
                <MessageContent className={cn(USER_BUBBLE_SHAPE, inkBubble && USER_BUBBLE_INK, assistantSteps && assistantLayout && 'overflow-visible')} data-ink={inkBubble || undefined}>
                    {assistantSteps ? (
                        assistantLayout ? assistantLayout(assistantSteps) : assistantSteps.map(step => <Fragment key={step.key}>{step.node}</Fragment>)
                    ) : message.role === 'user' ? (
                        <ExpandableMessage agentId={agentId} mentions={mentions}>{attachments ? attachments.text : messageText(message)}</ExpandableMessage>
                    ) : (
                        <AgentWorkspaceMessage agentId={agentId}>{messageText(message)}</AgentWorkspaceMessage>
                    )}
                </MessageContent>
            </MessageTimeTooltip>
            {sources.length > 0 && (
                <Sources>
                    <SourcesTrigger count={sources.length} />
                    <SourcesContent>
                        {sources.map((s, i) => (
                            <Source key={`${message.id}-src-${i}`} href={s.url} title={s.title} />
                        ))}
                    </SourcesContent>
                </Sources>
            )}
            {showPaidSources && <PaidSourcesPill sources={paidSources} />}
            {quickReplies.length > 0 && (
                <Suggestions className="animate-in fade-in duration-300">
                    {quickReplies.map(reply => (
                        <Suggestion
                            key={reply}
                            suggestion={reply}
                            onClick={text => {
                                const draft = quickReplyDraft(text)
                                if (draft) onDraftReply?.(draft)
                                else onSendMessage?.({ text })
                            }}
                        />
                    ))}
                </Suggestions>
            )}
            {message.role === 'assistant' && !isActive && onRegenerate && messageText(message).length > 0 && (
                <MessageActions className={cn('-mt-1 transition-opacity group-hover:opacity-100 group-[:not(:last-child)]:-mb-4', feedbackRating === null && 'opacity-0')}>
                    <CopyAction text={messageText(message)} />
                    <MessageAction tooltip="Regenerate" onClick={() => onRegenerate(message.id)}>
                        <RefreshCcwIcon className="size-3.5" />
                    </MessageAction>
                    {onRateMessage && (
                        <>
                            <FeedbackAction rating="up" current={feedbackRating} onRate={rating => onRateMessage(message.id, rating, messageText(message))} />
                            <FeedbackAction rating="down" current={feedbackRating} onRate={rating => onRateMessage(message.id, rating, messageText(message))} />
                        </>
                    )}
                </MessageActions>
            )}
        </Message>
    )
}

/**
 * Renders one conversation message: markdown text, reasoning, tool calls,
 * compaction, service UIs, and consecutive steps grouped into a StepGroup.
 * The single source of truth shared by the live chat and read-only transcripts
 * (e.g. scheduled-task run history). Interactive props are optional: omit them
 * to render a message read-only.
 *
 * Memoised: a conversation renders every message it holds, and the host re-renders on every
 * streamed chunk. Without this, one answer being written repaints the whole transcript, tool
 * blocks and all, at the rate the tokens land.
 */
export const MessageView = memo(MessageViewInner)
