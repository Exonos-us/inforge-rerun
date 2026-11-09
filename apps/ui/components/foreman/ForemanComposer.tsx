'use client'

import type { ChatStatus } from 'ai'
import { FOREMAN_AGENT_ID, MAX_UPLOAD_FILE_BYTES } from '@rerun/contracts'
import { useMemo, type ComponentProps, type RefObject } from 'react'

import { Context } from '@/components/ai-elements/context'
import { ChatComposer, type ChatComposerHandle, type ComposerQueue } from '@/components/chat/ChatComposer'
import { ForemanModelPill } from '@/components/foreman/ForemanModelPill'
import type { ContextStats } from '@/lib/chat/context-stats'
import { modelContextWindow } from '@/lib/engine/models'
import type { ForemanBackend } from '@/lib/foreman/phase'
import { OWN_ENTRY } from '@/components/foreman/intake/copy'
import { FOREMAN_MAX_UPLOAD_BYTES } from '@/lib/foreman/upload-limit'

export type ForemanComposerProps = {
    sessionId: string
    backend: ForemanBackend
    status: ChatStatus
    busy: boolean
    queue: ComposerQueue
    onSend: (text: string) => void
    onStop: () => void
    onUploadingChange: (uploading: boolean) => void
    composerRef: RefObject<ChatComposerHandle | null>
    /** The engine takes the foreman's files in its own workspace. Without it they stay on the hub. */
    filesOnEngine: boolean
    contextStats: ContextStats | null
    /**
     * Stands under the welcome card or the starter pack, where what is written answers the card: it
     * reads as that way out, and takes no file, which the card would have nowhere to put.
     */
    ownEntry?: boolean
} & ForemanComposerMentionProps

export type ForemanComposerMentionProps = Pick<ComponentProps<typeof ChatComposer>, 'textareaRef' | 'textareaProps' | 'mentionTokens'>

export function ForemanComposer({ sessionId, backend, status, busy, queue, onSend, onStop, onUploadingChange, composerRef, filesOnEngine, contextStats, ownEntry = false, textareaRef, textareaProps, mentionTokens }: ForemanComposerProps) {
    // On the engine a file lands in the foreman's own workspace, where its tools can open the path
    // the message names. The hub foreman reads its files from the hub's bucket.
    const onEngineFiles = backend === 'engine' && filesOnEngine
    const uploadTarget = useMemo(() => (onEngineFiles ? ({ kind: 'agent', agentId: FOREMAN_AGENT_ID } as const) : ({ kind: 'foreman', sessionId } as const)), [onEngineFiles, sessionId])

    return (
        <ChatComposer
            ref={composerRef}
            uid="foreman"
            uploadTarget={uploadTarget}
            maxFileSize={onEngineFiles ? MAX_UPLOAD_FILE_BYTES : FOREMAN_MAX_UPLOAD_BYTES}
            status={status}
            busy={busy}
            queue={queue}
            onSend={onSend}
            onStop={onStop}
            onUploadingChange={onUploadingChange}
            textareaRef={textareaRef}
            textareaProps={textareaProps}
            mentionTokens={mentionTokens}
            // An engine that predates the foreman's file routes would be handed a path it cannot
            // open.
            attachmentsEnabled={!ownEntry && (backend === 'hub' || filesOnEngine)}
            {...(ownEntry ? { placeholder: `${OWN_ENTRY}…` } : {})}
            modelSlot={<ForemanModelPill backend={backend} />}
            contextSlot={contextStats && <Context usedTokens={contextStats.used} maxTokens={contextStats.max ?? modelContextWindow(contextStats.model, contextStats.provider)} usage={contextStats.usage} modelId={contextStats.model} />}
        />
    )
}
