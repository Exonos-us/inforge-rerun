'use server'

import { actorFromContext, assertAgentAccess, assertSpaceAccess } from '@/app/api/_auth/access'
import { requireWorkspaceContext } from '@/app/api/_auth/ownership'
import { connectionForWorkspace } from '@/app/api/_services/slack.service'
import {
    createCoworkerPresetFromScratch,
    deleteCoworkerPreset,
    deleteTeamPreset,
    duplicateCoworkerPreset,
    hireFromPreset,
    hireTeam,
    listCoworkerPresets,
    listTeamPresets,
    saveAgentAsPreset,
    saveTeamPreset,
    updateCoworkerPreset,
    type CoworkerPresetView,
    type HireAnswer,
    type HireOutcome,
    type PresetPatch,
    type RosterEntry,
    type TeamPresetView,
} from '@/app/api/_services/preset.service'
import { MAX_PRESET_KNOWLEDGE_BYTES, MAX_PRESET_SKILLS_BYTES, type TeamPresetMember } from '@/lib/presets/types'

import type { ActionResult } from './space.actions'

// The store: list, save, edit, delete presets, and the two ways out of it — one hire into an
// existing Box, or a whole team into a new one. Any member who can manage the target may hire;
// saving a preset takes manage on the coworker it captures.

export type PresetStoreView = {
    presets: CoworkerPresetView[]
    teams: TeamPresetView[]
    slackConnected: boolean
}

export async function getPresetStoreAction(): Promise<ActionResult<{ state: PresetStoreView }>> {
    try {
        const ctx = await requireWorkspaceContext()
        const [presets, teams, connection] = await Promise.all([
            listCoworkerPresets(ctx.supabase, ctx.workspace.id),
            listTeamPresets(ctx.supabase, ctx.workspace.id),
            connectionForWorkspace(ctx.workspace.id),
        ])
        return { ok: true, state: { presets, teams, slackConnected: connection !== null && connection.status === 'connected' } }
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'Could not read the presets' }
    }
}

export async function saveAgentAsPresetAction(params: { agentId: string }): Promise<ActionResult<{ preset: CoworkerPresetView }>> {
    try {
        const ctx = await requireWorkspaceContext()
        const { actor } = await assertAgentAccess(params.agentId, 'manage')
        const preset = await saveAgentAsPreset({ workspaceId: ctx.workspace.id, agentId: params.agentId, actor, createdBy: ctx.userId })
        return { ok: true, preset }
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'Could not save the coworker as a preset' }
    }
}

export async function createPresetAction(params: { name: string; role?: string; description?: string; soul?: string; tags?: string[] }): Promise<ActionResult<{ preset: CoworkerPresetView }>> {
    try {
        const ctx = await requireWorkspaceContext()
        if (!params.name.trim()) return { ok: false, error: 'The coworker needs a name.' }
        const preset = await createCoworkerPresetFromScratch({
            workspaceId: ctx.workspace.id,
            name: params.name.trim(),
            role: params.role?.trim() ?? '',
            description: params.description?.trim() ?? '',
            soul: params.soul?.trim() ?? '',
            tags: [...new Set((params.tags ?? []).map(tag => tag.trim()).filter(Boolean))],
            createdBy: ctx.userId,
        })
        return { ok: true, preset }
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'Could not create the preset' }
    }
}

export async function duplicatePresetAction(params: { presetId: string }): Promise<ActionResult<{ preset: CoworkerPresetView }>> {
    try {
        const ctx = await requireWorkspaceContext()
        const preset = await duplicateCoworkerPreset(ctx.workspace.id, params.presetId, ctx.userId)
        return { ok: true, preset }
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'Could not duplicate the preset' }
    }
}

export async function updatePresetAction(params: { presetId: string } & PresetPatch): Promise<ActionResult> {
    try {
        const ctx = await requireWorkspaceContext()
        const { presetId, ...patch } = params
        if (patch.name !== undefined && !patch.name.trim()) return { ok: false, error: 'A preset needs a name.' }
        if (patch.tags !== undefined) patch.tags = [...new Set(patch.tags.map(tag => tag.trim()).filter(Boolean))]
        if (patch.skills !== undefined) {
            patch.skills = patch.skills.filter(skill => skill.name.trim())
            if (JSON.stringify(patch.skills).length > MAX_PRESET_SKILLS_BYTES) return { ok: false, error: 'The skills are too heavy for a preset (2 MB in all). Put the big ones on a live coworker and capture it instead.' }
        }
        if (patch.routines !== undefined) patch.routines = patch.routines.filter(routine => routine.name.trim())
        if (patch.knowledge !== undefined) {
            patch.knowledge = patch.knowledge.filter(doc => doc.path.trim())
            if (patch.knowledge.some(doc => doc.path.includes('..') || doc.path.startsWith('/'))) return { ok: false, error: 'A document name cannot leave its folder.' }
            if (JSON.stringify(patch.knowledge).length > MAX_PRESET_KNOWLEDGE_BYTES) return { ok: false, error: 'The knowledge is too heavy for a preset (2 MB in all). Give the big files to a hired coworker instead.' }
        }
        if (patch.connectorSlugs !== undefined) patch.connectorSlugs = [...new Set(patch.connectorSlugs.map(slug => slug.trim()).filter(Boolean))]
        await updateCoworkerPreset(ctx.workspace.id, presetId, patch)
        return { ok: true }
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'Could not update the preset' }
    }
}

export async function deletePresetAction(params: { presetId: string }): Promise<ActionResult> {
    try {
        const ctx = await requireWorkspaceContext()
        await deleteCoworkerPreset(ctx.workspace.id, params.presetId)
        return { ok: true }
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'Could not delete the preset' }
    }
}

export async function saveTeamPresetAction(params: { id?: string; name: string; description?: string; tags?: string[]; members: TeamPresetMember[] }): Promise<ActionResult> {
    try {
        const ctx = await requireWorkspaceContext()
        if (!params.name.trim()) return { ok: false, error: 'A team preset needs a name.' }
        if (params.members.length === 0) return { ok: false, error: 'Pick at least one coworker preset.' }
        const tags = [...new Set((params.tags ?? []).map(tag => tag.trim()).filter(Boolean))]
        await saveTeamPreset({ workspaceId: ctx.workspace.id, id: params.id, name: params.name.trim(), description: params.description?.trim() ?? '', tags, members: params.members, createdBy: ctx.userId })
        return { ok: true }
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'Could not save the team preset' }
    }
}

export async function deleteTeamPresetAction(params: { teamId: string }): Promise<ActionResult> {
    try {
        const ctx = await requireWorkspaceContext()
        await deleteTeamPreset(ctx.workspace.id, params.teamId)
        return { ok: true }
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'Could not delete the team preset' }
    }
}

export async function hireFromPresetAction(params: { spaceId: string; roster: RosterEntry; answers: HireAnswer[] }): Promise<ActionResult<{ outcome: HireOutcome }>> {
    try {
        const ctx = await requireWorkspaceContext()
        const { actor } = await assertSpaceAccess(params.spaceId, 'manage')
        if (!params.roster.name.trim()) return { ok: false, error: 'The coworker needs a name.' }
        const outcome = await hireFromPreset({ workspaceId: ctx.workspace.id, actor, spaceId: params.spaceId, roster: { ...params.roster, name: params.roster.name.trim() }, answers: params.answers })
        return { ok: true, outcome }
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'Could not hire the coworker' }
    }
}

export async function hireTeamAction(params: { spaceName: string; roster: RosterEntry[]; channel: { name: string; isPrivate: boolean } | null; answers: HireAnswer[] }): Promise<ActionResult<{ outcome: HireOutcome }>> {
    try {
        const ctx = await requireWorkspaceContext()
        if (params.roster.some(entry => !entry.name.trim())) return { ok: false, error: 'Every coworker needs a name.' }
        const outcome = await hireTeam({
            workspaceId: ctx.workspace.id,
            userId: ctx.userId,
            userEmail: ctx.userEmail,
            actor: actorFromContext(ctx),
            spaceName: params.spaceName,
            roster: params.roster.map(entry => ({ ...entry, name: entry.name.trim() })),
            channel: params.channel,
            answers: params.answers,
        })
        return { ok: true, outcome }
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'Could not hire the team' }
    }
}
