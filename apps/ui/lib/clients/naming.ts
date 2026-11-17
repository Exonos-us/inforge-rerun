import { slugOf } from '@/lib/presets/naming'

// A client's skills live under a slug keyed on its id, so that changing a Box's client removes
// exactly that client's files and a coworker's own skill can never collide with one of them.
// Not the short code: shortCodeOf() is initials-based ("Miami Dade County" and "Miami Dade City"
// both give "mdc") and the code stays editable, so a rename would orphan everything installed.
const PREFIX = 'client'
const KEY_LENGTH = 8

function keyOf(clientId: string): string {
    return clientId.replace(/-/g, '').slice(0, KEY_LENGTH)
}

export function clientNamespace(clientId: string): string {
    return `${PREFIX}-${keyOf(clientId)}`
}

export function clientSkillSlug(clientId: string, skillName: string): string {
    return `${clientNamespace(clientId)}-${slugOf(skillName) || 'skill'}`
}

export function isClientSkillSlug(slug: string, clientId: string): boolean {
    return slug.startsWith(`${clientNamespace(clientId)}-`)
}

export function clientKnowledgeDir(clientId: string): string {
    return `knowledge/${clientNamespace(clientId)}`
}
