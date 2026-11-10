import { eq, inArray } from 'drizzle-orm'
import { normalizeSite, parseHitlReply } from '@rerun/contracts'
import { getSystemDb } from '../db/systemDb.js'
import { screenSecrets } from '../db/schema.js'
import { listMessages } from '../db/repos/messages.js'
import { badRequest } from '../lib/errors.js'
import { nowIso } from '../lib/ids.js'

// A screen secret is an ordinary coworker variable (the value lives in the agent's .env) plus the
// metadata here: the site it signs in to, and whether the user already allowed typing it there
// without asking each run. The value itself never passes through this module.

export type ScreenSecretMeta = { site: string; allowAlways: boolean }

export async function saveScreenSecretMeta(agentId: string, key: string, meta: { site: string; allowAlways?: boolean }): Promise<void> {
    const site = normalizeSite(meta.site)
    if (!site) throw badRequest(`Not a site: ${JSON.stringify(meta.site)}`)
    const { db } = await getSystemDb(agentId)
    const row = { key, site, approvedAlways: meta.allowAlways ? 1 : 0, createdAt: nowIso() }
    await db.insert(screenSecrets).values(row).onConflictDoUpdate({ target: screenSecrets.key, set: { site: row.site, approvedAlways: row.approvedAlways } })
}

export async function screenSecretMeta(agentId: string, key: string): Promise<ScreenSecretMeta | null> {
    const { db } = await getSystemDb(agentId)
    const [row] = await db.select().from(screenSecrets).where(eq(screenSecrets.key, key)).limit(1)
    return row ? { site: row.site, allowAlways: row.approvedAlways !== 0 } : null
}

export async function listScreenSecretMeta(agentId: string): Promise<Record<string, ScreenSecretMeta>> {
    const { db } = await getSystemDb(agentId)
    const rows = await db.select().from(screenSecrets)
    return Object.fromEntries(rows.map(row => [row.key, { site: row.site, allowAlways: row.approvedAlways !== 0 }]))
}

export async function dropScreenSecretMeta(agentId: string, keys: string[]): Promise<void> {
    if (keys.length === 0) return
    const { db } = await getSystemDb(agentId)
    await db.delete(screenSecrets).where(inArray(screenSecrets.key, keys))
}

// The action line the engine asks the model to put on the approval card, word for word: the scan
// below only recognizes this exact sentence, so a paraphrased card never unlocks the typing.
export const typeSecretApprovalAction = (key: string, site: string): string => `Type the saved secret ${key} into ${site}`

// What a user turn said, without the context block the engine appends when sending it to the model:
// the HITL reply protocol matches on the text the user's client wrote, which is the first text part.
function userTurnText(contentJson: string): string {
    try {
        const content = JSON.parse(contentJson) as unknown
        if (typeof content === 'string') return content
        if (Array.isArray(content)) {
            const part = content.find(p => (p as { type?: string })?.type === 'text' && typeof (p as { text?: unknown }).text === 'string') as { text: string } | undefined
            return part?.text ?? ''
        }
    } catch {}
    return ''
}

// Whether the user decided on typing this secret on this site in the current run. The run is
// everything since the user last wrote something that is not a HITL reply: an approval given in an
// earlier run does not carry over, and one given to the pending card is seen as soon as the reply
// resumes the run.
export async function secretUseDecision(agentId: string, sessionId: string, key: string, site: string): Promise<'approved' | 'declined' | null> {
    const action = typeSecretApprovalAction(key, site)
    const rows = await listMessages(agentId, sessionId)
    for (let i = rows.length - 1; i >= 0; i--) {
        if (rows[i].role !== 'user') continue
        const reply = parseHitlReply(userTurnText(rows[i].contentJson))
        if (!reply) return null
        if (reply.kind !== 'approval') continue
        const decision = reply.decisions.find(d => d.action.trim() === action)
        if (decision) return decision.decision
    }
    return null
}
