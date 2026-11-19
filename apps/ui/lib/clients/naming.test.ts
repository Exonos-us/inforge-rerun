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

    it('gives two skills of the same client different slugs', () => {
        expect(clientSkillSlug(MDC, 'Doc format')).not.toBe(clientSkillSlug(MDC, 'Comms tone'))
    })

    it('gives two non-Latin names of the same client different slugs', () => {
        expect(clientSkillSlug(MDC, '日本語')).not.toBe(clientSkillSlug(MDC, 'Привет'))
        expect(clientSkillSlug(MDC, 'Привет')).not.toBe(clientSkillSlug(MDC, 'العربية'))
        expect(clientSkillSlug(MDC, '日本語')).not.toBe(clientSkillSlug(MDC, 'العربية'))
    })

    it('derives a name that slugs to nothing from the name itself, always the same way', () => {
        expect(clientSkillSlug(MDC, '日本語')).toBe(clientSkillSlug(MDC, '日本語'))
        expect(clientSkillSlug(MDC, '日本語')).toMatch(/^client-a1b8d4fa-skill-[0-9a-z]+$/)
    })

    it('keeps a non-Latin skill addressable under its own client only', () => {
        expect(isClientSkillSlug(MDC, clientSkillSlug(MDC, '日本語'))).toBe(true)
        expect(isClientSkillSlug(BROWARD, clientSkillSlug(MDC, '日本語'))).toBe(false)
    })

    it('bounds the slug of a very long name', () => {
        const slug = clientSkillSlug(MDC, `Document ${'format '.repeat(40)}`)
        expect(slug.length).toBeLessThanOrEqual(64)
        expect(slug.startsWith('client-a1b8d4fa-document-format')).toBe(true)
        expect(slug.endsWith('-')).toBe(false)
    })
})

describe('isClientSkillSlug', () => {
    it('recognises the slug clientSkillSlug just built for that client', () => {
        expect(isClientSkillSlug(MDC, clientSkillSlug(MDC, 'Doc format'))).toBe(true)
    })

    it('does not recognise another client’s slug', () => {
        expect(isClientSkillSlug(BROWARD, clientSkillSlug(MDC, 'Doc format'))).toBe(false)
    })

    it('recognises its own client’s slugs', () => {
        expect(isClientSkillSlug(MDC, 'client-a1b8d4fa-doc-format')).toBe(true)
    })

    it('does not claim another client’s slug', () => {
        expect(isClientSkillSlug(BROWARD, 'client-a1b8d4fa-doc-format')).toBe(false)
    })

    it('does not claim a coworker’s own skill', () => {
        expect(isClientSkillSlug(MDC, 'permit-intake-triage')).toBe(false)
    })

    it('does not match a slug that merely starts with the same characters', () => {
        expect(isClientSkillSlug(MDC, 'client-a1b8d4faXX-doc')).toBe(false)
    })
})

describe('clientKnowledgeDir', () => {
    it('gives each client its own folder under knowledge/', () => {
        expect(clientKnowledgeDir(MDC)).toBe('knowledge/client-a1b8d4fa')
    })
})
