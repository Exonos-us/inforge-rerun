'use server'

import { requireLightSessionActor } from '@/app/api/_auth/access'
import { requireWorkspaceId } from '@/app/api/_auth/ownership'
import {
    getProjectKnowledge,
    linkProjectKnowledge,
    listKnowledgeEngagements,
    listKnowledgeSpaces,
    unlinkProjectKnowledge,
    type KnowledgeEngagementsResult,
    type KnowledgeSpacesResult,
    type ProjectKnowledgeView,
} from '@/app/api/_services/project-knowledge.service'

export type ActionResult<T = unknown> = ({ ok: true } & T) | { ok: false; error: string }

const message = (err: unknown, fallback: string) => (err instanceof Error ? err.message : fallback)

export async function listKnowledgeSpacesAction(): Promise<ActionResult<{ result: KnowledgeSpacesResult }>> {
    try {
        const workspaceId = await requireWorkspaceId()
        return { ok: true, result: await listKnowledgeSpaces(workspaceId) }
    } catch (err) {
        return { ok: false, error: message(err, 'Failed to list Confluence spaces') }
    }
}

export async function listKnowledgeEngagementsAction(params: { spaceKey: string }): Promise<ActionResult<{ result: KnowledgeEngagementsResult }>> {
    try {
        const workspaceId = await requireWorkspaceId()
        return { ok: true, result: await listKnowledgeEngagements(workspaceId, params.spaceKey) }
    } catch (err) {
        return { ok: false, error: message(err, 'Failed to list engagements') }
    }
}

export async function getProjectKnowledgeAction(params: { spaceId: string }): Promise<ActionResult<{ knowledge: ProjectKnowledgeView | null }>> {
    try {
        const actor = await requireLightSessionActor()
        return { ok: true, knowledge: await getProjectKnowledge(actor, params.spaceId) }
    } catch (err) {
        return { ok: false, error: message(err, 'Failed to read the project knowledge') }
    }
}

export async function linkProjectKnowledgeAction(params: { spaceId: string; spaceKey: string; pageId: string | null; pageTitle: string | null }): Promise<ActionResult<{ warnings: string[] }>> {
    try {
        const actor = await requireLightSessionActor()
        const { warnings } = await linkProjectKnowledge({ actor, spaceId: params.spaceId, spaceKey: params.spaceKey, pageId: params.pageId, pageTitle: params.pageTitle })
        return { ok: true, warnings }
    } catch (err) {
        return { ok: false, error: message(err, 'Failed to link the engagement') }
    }
}

export async function unlinkProjectKnowledgeAction(params: { spaceId: string }): Promise<ActionResult> {
    try {
        const actor = await requireLightSessionActor()
        await unlinkProjectKnowledge(actor, params.spaceId)
        return { ok: true }
    } catch (err) {
        return { ok: false, error: message(err, 'Failed to unlink') }
    }
}
