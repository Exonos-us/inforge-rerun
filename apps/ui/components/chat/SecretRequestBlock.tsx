'use client'

import { answerSecretRequestAction, getAgentKeysAction, updateAgentKeysAction } from '@/app/api/_actions/agent.actions'
import { serializeSecretResult } from '@/lib/chat-hitl'
import { SecretRequestBlock as SecretRequestBlockBase, type SecretRequestItem } from '@rerun/ui/chat'
import { useEffect, useState } from 'react'

type SecretRequestBlockProps = {
    agentId: string
    // The conversation that raised the request: answering it only takes the right to use the coworker.
    sessionId: string | null
    secrets: SecretRequestItem[]
    reason?: string
    // Called once the credentials are stored on the engine, with the summary chat message that
    // resumes the run. It only ever carries variable names, never a value.
    onDone: (summary: string) => void
    onSkip: () => void
    onDismiss: () => void
    inline?: boolean
}

export function SecretRequestBlock({ agentId, sessionId, secrets, reason, onDone, onSkip, onDismiss, inline }: SecretRequestBlockProps) {
    const [existingKeys, setExistingKeys] = useState<string[]>([])

    useEffect(() => {
        let cancelled = false
        getAgentKeysAction(agentId).then(result => {
            if (!cancelled) setExistingKeys(result.keys)
        })
        return () => {
            cancelled = true
        }
    }, [agentId])

    return (
        <SecretRequestBlockBase
            secrets={secrets}
            reason={reason}
            existingKeys={existingKeys}
            inline={inline}
            onSubmit={async (values, allowAlways) => {
                // Without a conversation to read the request back from, the site rides along from the
                // same card input the user just read and answered.
                const screen = Object.fromEntries(secrets.filter(item => item.site && values[item.key]).map(item => [item.key, { site: item.site as string, allowAlways: allowAlways.includes(item.key) }]))
                const result = sessionId ? await answerSecretRequestAction(sessionId, values, allowAlways) : await updateAgentKeysAction(agentId, { set: values, ...(Object.keys(screen).length ? { screen } : {}) })
                if (!result.success) throw new Error(result.error ?? 'Could not save the credentials')
                onDone(serializeSecretResult(secrets, Object.keys(values)))
            }}
            onSkip={onSkip}
            onDismiss={onDismiss}
        />
    )
}
