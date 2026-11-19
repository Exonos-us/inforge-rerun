import type { AuthoredSkill } from '@/lib/presets/types'

// JSON strings are valid YAML double-quoted scalars, so a composed frontmatter survives any name.
export function authoredSkillMarkdown(skill: AuthoredSkill): string {
    const quote = (value: string) => JSON.stringify(value.replace(/\s+/g, ' ').trim())
    return `---\nname: ${quote(skill.name)}\ndescription: ${quote(skill.description)}\n---\n\n${skill.body}`
}

// The other direction, for an uploaded SKILL.md: the name and description its frontmatter
// declares, for the row the editor shows. The raw text stays untouched — it is what the hire
// imports.
function jsonScalar(head: string): string {
    try {
        const value: unknown = JSON.parse(head)
        return typeof value === 'string' ? value : head
    } catch {
        return head.replace(/^"|"$/g, '')
    }
}

export function parseSkillMeta(content: string, fallback: string): { name: string; description: string } {
    const lines = (content.match(/^---\s*\n([\s\S]*?)\n---/)?.[1] ?? '').split('\n')
    const pick = (key: string) => {
        const at = lines.findIndex(line => line.startsWith(`${key}:`))
        if (at < 0) return ''
        const head = lines[at].slice(key.length + 1).trim()
        // A block scalar holds its value in the indented lines under it, so the header line carries
        // nothing to read: `description: >` taken as the value shows the coworker a description of
        // ">" and the skill stops being findable by what it is for.
        // authoredSkillMarkdown writes the value with JSON.stringify, so a name holding a quote
        // comes back escaped unless it is parsed rather than trimmed of its quotes.
        if (!/^[>|][-+]?\d*$/.test(head)) return head.startsWith('"') ? jsonScalar(head) : head.replace(/^'|'$/g, '')
        const body: string[] = []
        for (const line of lines.slice(at + 1)) {
            if (line.trim() && !/^\s/.test(line)) break
            body.push(line.trim())
        }
        return head.startsWith('>') ? body.join(' ').trim() : body.join('\n').trim()
    }
    return { name: pick('name') || fallback, description: pick('description') }
}
