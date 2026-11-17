import { describe, expect, it } from 'vitest'

import { clientKnowledgeDir, clientSkillSlug, isClientSkillSlug } from './naming'

const MDC = 'a1b8d4fa-0db3-4de6-9305-f1fb9c37ca34'
const BROWARD = 'c7e2119b-55aa-4f01-9f3e-2b6d0e4a7781'

describe('clientSkillSlug', () => {
    it('namespaces a skill under its client id', () => {
        expect(clientSkillSlug(MDC, 'Document format')).toBe('client-a1b8d4fa-document-format')
    })

    it('gives two clients whose short codes would collide different slugs', () => {
        // "Miami Dade County" and "Miami Dade City" both shortCodeOf() to "mdc".
        expect(clientSkillSlug(MDC, 'Doc format')).not.toBe(clientSkillSlug(BROWARD, 'Doc format'))
    })

    it('collapses punctuation and case', () => {
        expect(clientSkillSlug(MDC, 'Comms / tone!')).toBe('client-a1b8d4fa-comms-tone')
    })

    it('keeps a name that slugs to nothing addressable', () => {
        expect(clientSkillSlug(MDC, '日本語')).toBe('client-a1b8d4fa-skill')
    })
})

describe('isClientSkillSlug', () => {
    it('recognises its own client’s slugs', () => {
        expect(isClientSkillSlug('client-a1b8d4fa-doc-format', MDC)).toBe(true)
    })

    it('does not claim another client’s slug', () => {
        expect(isClientSkillSlug('client-a1b8d4fa-doc-format', BROWARD)).toBe(false)
    })

    it('does not claim a coworker’s own skill', () => {
        expect(isClientSkillSlug('permit-intake-triage', MDC)).toBe(false)
    })

    it('does not match a slug that merely starts with the same characters', () => {
        expect(isClientSkillSlug('client-a1b8d4faXX-doc', MDC)).toBe(false)
    })
})

describe('clientKnowledgeDir', () => {
    it('gives each client its own folder under knowledge/', () => {
        expect(clientKnowledgeDir(MDC)).toBe('knowledge/client-a1b8d4fa')
    })
})
