import type { AuthoredSkill } from '@/lib/presets/types'

// JSON strings are valid YAML double-quoted scalars, so a composed frontmatter survives any name.
export function authoredSkillMarkdown(skill: AuthoredSkill): string {
    const quote = (value: string) => JSON.stringify(value.replace(/\s+/g, ' ').trim())
    return `---\nname: ${quote(skill.name)}\ndescription: ${quote(skill.description)}\n---\n\n${skill.body}`
}

// The other direction, for an uploaded SKILL.md: the name and description its frontmatter
// declares, for the row the editor shows. The raw text stays untouched — it is what the hire
// imports.
export function parseSkillMeta(content: string, fallback: string): { name: string; description: string } {
    const frontmatter = content.match(/^---\s*\n([\s\S]*?)\n---/)?.[1] ?? ''
    const pick = (key: string) =>
        frontmatter
            .match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))?.[1]
            .trim()
            .replace(/^['"]|['"]$/g, '') ?? ''
    return { name: pick('name') || fallback, description: pick('description') }
}
