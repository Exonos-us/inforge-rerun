import type { AuthoredSkill } from '@/lib/presets/types'

// JSON strings are valid YAML double-quoted scalars, so a composed frontmatter survives any name.
export function authoredSkillMarkdown(skill: AuthoredSkill): string {
    const quote = (value: string) => JSON.stringify(value.replace(/\s+/g, ' ').trim())
    return `---\nname: ${quote(skill.name)}\ndescription: ${quote(skill.description)}\n---\n\n${skill.body}`
}
