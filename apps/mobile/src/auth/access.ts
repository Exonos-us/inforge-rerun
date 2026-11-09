import { FOREMAN_AGENT_ID, type BoardAgent, type Box, type BoxAccessLevel, type WorkspaceRole } from '@rerun/contracts'

import { webHost } from '@/config/environment'

// The app's copy of the web's rules. They only decide which controls are open: the hub checks every
// write again and answers 403.

export const BOX_MANAGE_REASON = 'Only an admin or a manager of this Box can change this.'
export const AI_PROVIDERS_ADMIN_ONLY = 'Only an admin can change the AI providers.'
export const NO_MANAGED_BOX = `You need a Box you manage to add a coworker. Create one at ${webHost}, or ask an admin.`

// A hub older than roles sends none, and a copy of the account cached before them has none: both
// meant every member ran the workspace.
export const isAdminRole = (role: WorkspaceRole | undefined): boolean => role !== 'member'

// An older hub sends no access: every member managed every Box.
export const canManage = (access: BoxAccessLevel | undefined): boolean => access !== 'use'

export const manageReason = (access: BoxAccessLevel | undefined): string | null => (canManage(access) ? null : BOX_MANAGE_REASON)

export const manageableBoxes = (boxes: readonly Box[]): Box[] => boxes.filter(box => canManage(box.access))

// The Box a new coworker lands in: the one asked for or already picked when it can take one, the first
// that can otherwise.
export function boxForNewCoworker(manageable: readonly Box[], wanted: string | null): string | null {
    if (wanted && manageable.some(box => box.id === wanted)) return wanted
    return manageable[0]?.id ?? null
}

// Why the new coworker sheet offers no form, or null when it can: the Boxes are read, and one of them
// takes a coworker from the caller.
export function newCoworkerBlocker({ failed, manageable, admin }: { failed: boolean; manageable: readonly Box[] | null; admin: boolean }): string | null {
    if (failed) return 'We could not load your Boxes. Try again in a moment.'
    if (!manageable || manageable.length > 0) return null
    return admin ? `This workspace has no Box yet. Create one at ${webHost}.` : NO_MANAGED_BOX
}

// The caller's level on a coworker. `known` is false until a copy of the coworker, the phone's or the
// hub's, has said it: an absent level on a known coworker is an older hub, where every member managed.
export type CoworkerAccess = { access: BoxAccessLevel | undefined; known: boolean }

export const UNKNOWN_ACCESS: CoworkerAccess = { access: undefined, known: false }

type AccessSources = { agents?: readonly Pick<BoardAgent, 'id' | 'access'>[] | null; views?: readonly ({ agent: Pick<BoardAgent, 'access'> } | null | undefined)[] }

// What the phone already knows of the caller's level on a coworker, before the hub is asked: the board
// first, then the copies of the coworker, in the order given. The Foreman is everyone's.
export function knownCoworkerAccess(agentId: string, sources: AccessSources): CoworkerAccess {
    if (agentId === FOREMAN_AGENT_ID) return { access: 'manage', known: true }
    const agent = sources.agents?.find(candidate => candidate.id === agentId)
    if (agent) return { access: agent.access, known: true }
    const view = sources.views?.find(candidate => !!candidate)
    return view ? { access: view.agent.access, known: true } : UNKNOWN_ACCESS
}

// How a control that changes the coworker shows: greyed with no word until the level is known, greyed
// with the reason when the caller only uses the Box, open otherwise.
export type ManageLock = { locked: boolean; reason: string | null }

export const OPEN_LOCK: ManageLock = { locked: false, reason: null }

export function manageLock({ access, known }: CoworkerAccess): ManageLock {
    if (!known) return { locked: true, reason: null }
    return { locked: !canManage(access), reason: manageReason(access) }
}
