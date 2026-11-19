import { describe, expect, it } from 'vitest'
import { authoredSkillMarkdown, parseSkillMeta } from './skill-markdown'

describe('parseSkillMeta', () => {
    it('reads a plain scalar', () => {
        expect(parseSkillMeta('---\nname: docs-create\ndescription: Documents for the County\n---\n\nBody', 'fallback')).toEqual({
            name: 'docs-create',
            description: 'Documents for the County',
        })
    })

    // How Claude's own skills are written. Read as a plain scalar the description came out as ">",
    // which is what a coworker saw when deciding whether the skill applied.
    it('folds a > block into one line', () => {
        const content = ['---', 'name: docs-create', 'description: >', '  The Miami-Dade deliverable skill: creates a', '  self-contained HTML document.', '---', '', 'Body'].join('\n')

        expect(parseSkillMeta(content, 'fallback').description).toBe('The Miami-Dade deliverable skill: creates a self-contained HTML document.')
    })

    it('keeps the line breaks of a | block', () => {
        const content = ['---', 'name: n', 'description: |', '  First line.', '  Second line.', '---'].join('\n')

        expect(parseSkillMeta(content, 'fallback').description).toBe('First line.\nSecond line.')
    })

    it('accepts the chomping and indentation indicators', () => {
        for (const marker of ['>-', '>+', '|-', '>2']) {
            const content = ['---', 'name: n', `description: ${marker}`, '  Kept.', '---'].join('\n')
            expect(parseSkillMeta(content, 'fallback').description).toBe('Kept.')
        }
    })

    it('stops the block at the next key', () => {
        const content = ['---', 'description: >', '  Only this.', 'name: docs-create', '---'].join('\n')

        expect(parseSkillMeta(content, 'fallback')).toEqual({ name: 'docs-create', description: 'Only this.' })
    })

    it('falls back to the given name and an empty description', () => {
        expect(parseSkillMeta('no frontmatter at all', 'from-the-filename')).toEqual({ name: 'from-the-filename', description: '' })
    })

    it('reads back what authoredSkillMarkdown writes', () => {
        const skill = { name: 'County: "house" style', description: 'Anything they read', body: 'b', raw: '', files: [] }

        expect(parseSkillMeta(authoredSkillMarkdown(skill), 'fallback')).toEqual({ name: skill.name, description: skill.description })
    })
})
