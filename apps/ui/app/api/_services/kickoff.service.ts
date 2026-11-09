import { callableEngineAgentIds, requireLightSessionActor, type Actor } from '@/app/api/_auth/access'
import { createSessionRow, resolveAgentTarget, updateSessionStatus } from '@/app/api/_services/chat.service'
import { recordSessionParticipant } from '@/app/api/_services/notification-audience.service'
import type { Database } from '@/app/api/database.types'
import { generateSessionTitle } from '@/lib/ai/generate-title'
import { reformulateKickoff } from '@/lib/ai/reformulate-kickoff'
import { chat } from '@/lib/engine/client'
import { createServiceRoleClient } from '@/supabase/serviceRole'
import type { MessageAuthor } from '@rerun/contracts'

export type KickoffResult = { ok: true; sessionId: string; runId: string | null } | { ok: false; error: string; agentGone: boolean }

// Sends a freshly created agent's first message entirely server-side, so delivery never depends
// on the chat panel mounting client-side. The engine pumps the run stream itself
// (registerRunStream), so the run completes even though nobody consumes the HTTP response here;
// the UI re-attaches to it afterwards via /api/chat/resume with the returned run id.
// `actor` is the v1 route's caller; omitted, the browser session's.
export async function startKickoff(agentId: string, input: { kickoff?: string; description?: string }, author: MessageAuthor, actor?: Actor): Promise<KickoffResult> {
    let target: Awaited<ReturnType<typeof resolveAgentTarget>>
    try {
        target = await resolveAgentTarget(agentId, actor)
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'Coworker not found', agentGone: true }
    }

    try {
        const kickoff = input.kickoff?.trim()
        const description = input.description?.trim()
        const message = kickoff || (description ? await reformulateKickoff(description).catch(() => description) : '')
        if (!message) return { ok: false, error: 'Nothing to send', agentGone: true }

        const callableAgentIds = await callableEngineAgentIds(actor ?? (await requireLightSessionActor()))
        const engineRes = await chat(target.conn, target.engineAgentId, { message, source: 'dashboard', author, callableAgentIds })
        if (!engineRes.ok) {
            const errBody = await engineRes.text().catch(() => '')
            return { ok: false, error: `Engine error: ${engineRes.status} ${errBody}`, agentGone: false }
        }

        const engineSessionId = engineRes.headers.get('x-session-id')
        const runId = engineRes.headers.get('x-run-id')
        engineRes.body?.cancel().catch(() => {})
        if (!engineSessionId) return { ok: false, error: 'Engine did not return a session id', agentGone: false }

        const sessionId = await createSessionRow(agentId, engineSessionId, message, null, undefined, 'thread', message)
        await updateSessionStatus(sessionId, 'working')
        await recordSessionParticipant(sessionId, author.id)

        generateSessionTitle(message)
            .then(async title => {
                const supabase = createServiceRoleClient()
                await supabase.from('sessions').update<Database['public']['Tables']['sessions']['Update']>({ title }).eq('id', sessionId)
            })
            .catch(() => {})

        return { ok: true, sessionId, runId }
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'Failed to send the kickoff', agentGone: false }
    }
}
