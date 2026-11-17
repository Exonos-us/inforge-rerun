import { slugOf } from '@/lib/presets/naming'

// A client's skills live under a slug keyed on its id, so that changing a Box's client removes
// exactly that client's files and a coworker's own skill can never collide with one of them.
// Not the short code: shortCodeOf() is initials-based ("Miami Dade County" and "Miami Dade City"
// both give "mdc") and the code stays editable, so a rename would orphan everything installed.
const PREFIX = 'client'
// 8 hex characters are 32 bits of randomness only because client ids are gen_random_uuid(), which
// is uuid v4. A move to uuid v7, or to any time-ordered id, turns this prefix into a timestamp and
// two clients created the same second share a namespace: lengthen the key before changing the id.
const KEY_LENGTH = 8
const NAME_LENGTH = 48

function keyOf(clientId: string): string {
    return clientId.replace(/-/g, '').slice(0, KEY_LENGTH)
}

// Names in a non-Latin script all slug to the empty string, and skills install with overwrite:
// true, so a shared fallback would let one client keep a single skill. FNV-1a stays inline rather
// than using node:crypto because this module is imported by client components, and the editor has
// to show the slug it is about to write.
function fnv1a36(text: string): string {
    let hash = 0x811c9dc5
    for (let index = 0; index < text.length; index += 1) {
        hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193) >>> 0
    }
    return hash.toString(36)
}

function skillKeyOf(skillName: string): string {
    const slug = slugOf(skillName).slice(0, NAME_LENGTH).replace(/-+$/, '')
    return slug || `skill-${fnv1a36(skillName)}`
}

export function clientNamespace(clientId: string): string {
    return `${PREFIX}-${keyOf(clientId)}`
}

export function clientSkillSlug(clientId: string, skillName: string): string {
    return `${clientNamespace(clientId)}-${skillKeyOf(skillName)}`
}

export function isClientSkillSlug(clientId: string, slug: string): boolean {
    return slug.startsWith(`${clientNamespace(clientId)}-`)
}

// Whether a slug or a knowledge folder belongs to some client rather than to the coworker itself.
// A coworker moved between two engagements has to drop what the client it is leaving put on it,
// and that client is not always readable: its row may be gone, and a restored data-dir can carry a
// namespace no Box of this workspace points at. So the question is asked of the name alone, and
// the prefix it reads stays here next to the one clientNamespace writes.
export function isAnyClientNamespace(name: string): boolean {
    return name.startsWith(`${PREFIX}-`)
}

export const CLIENT_KNOWLEDGE_ROOT = 'knowledge'

export function clientKnowledgeDir(clientId: string): string {
    return `${CLIENT_KNOWLEDGE_ROOT}/${clientNamespace(clientId)}`
}
