import { describe, expect, it } from 'vitest'
import { channelNameFor, coworkerNameFor, roleKeyOf, shortCodeOf, slugOf, spaceNameFor } from './naming'

describe('shortCodeOf', () => {
    it('takes the initials of a multi-word client', () => {
        expect(shortCodeOf('Miami Dade County')).toBe('mdc')
    })

    it('keeps the start of a one-word client', () => {
        expect(shortCodeOf('Inforge')).toBe('inforg')
    })

    it('survives punctuation and empty input', () => {
        expect(shortCodeOf('A.T. & T.')).toBe('at')
        expect(shortCodeOf('   ')).toBe('')
    })
})

describe('the derived trio', () => {
    it('builds the MDC Acme scenario from two words', () => {
        expect(channelNameFor('mdc', 'Acme')).toBe('mdc-acme')
        expect(spaceNameFor('mdc', 'Acme')).toBe('MDC Acme Project')
    })

    it('slugs a project with spaces into one channel word', () => {
        expect(channelNameFor('mdc', 'Tax Portal')).toBe('mdc-tax-portal')
    })

    it('leaves nothing weird when a half is missing', () => {
        expect(channelNameFor('mdc', '')).toBe('mdc')
        expect(spaceNameFor('', '')).toBe('')
    })
})

describe('coworker names', () => {
    it('shortens a multi-word role to its initials', () => {
        expect(roleKeyOf('Project Engineer')).toBe('pe')
        expect(roleKeyOf('Product Owner')).toBe('po')
        expect(roleKeyOf('Engineer')).toBe('engineer')
    })

    it('numbers a role only when it is hired more than once', () => {
        expect(coworkerNameFor('mdc', 'Acme', 'Project Engineer', 1, 3)).toBe('mdc-acme-pe-1')
        expect(coworkerNameFor('mdc', 'Acme', 'Project Engineer', 3, 3)).toBe('mdc-acme-pe-3')
        expect(coworkerNameFor('mdc', 'Acme', 'Product Owner', 1, 1)).toBe('mdc-acme-po')
    })

    it('never produces an empty name', () => {
        expect(roleKeyOf('')).toBe('coworker')
        expect(slugOf('—')).toBe('')
        expect(coworkerNameFor('', '', '', 1, 1)).toBe('coworker')
    })
})
