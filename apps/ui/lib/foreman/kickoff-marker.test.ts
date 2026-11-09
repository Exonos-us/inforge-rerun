import { describe, expect, it } from 'vitest'

import { buildKickoffMarker, buildOwnKickoff, decodeIntent, encodeIntent, isKickoffText, parseKickoff, readOwnAsk, stripKickoff, type KickoffIntent } from './kickoff-marker'

const cases: KickoffIntent[] = [
    { kind: 'template', slug: 'seo-newsroom' },
    { kind: 'share', token: 'a'.repeat(32) },
    { kind: 'prompt', text: 'Sort my inbox every morning' },
]

describe('kickoff marker', () => {
    it('carries every intent there and back', () => {
        for (const intent of cases) expect(parseKickoff(buildKickoffMarker(intent))?.intent).toEqual(intent)
    })

    it('opens a conversation with nothing attached', () => {
        expect(parseKickoff(buildKickoffMarker(null))).toEqual({ intent: null })
        expect(isKickoffText('[[foreman:start]]')).toBe(true)
    })

    // What someone types in the landing composer is free text: it holds newlines and brackets, which
    // is exactly why a prompt travels under the marker rather than inside it.
    it('survives a prompt full of the characters the marker is made of', () => {
        const text = 'Watch [[my]] feed\nand post ]] a summary'
        expect(parseKickoff(buildKickoffMarker({ kind: 'prompt', text }))?.intent).toEqual({ kind: 'prompt', text })
    })

    // The landing composer reads a name and apps in the prompt, and both ride the head line.
    it('carries the name and the apps the landing composer read with the prompt', () => {
        const intent: KickoffIntent = { kind: 'prompt', text: 'Sort my inbox every morning', name: 'Inbox Sorter', apps: ['gmail', 'google-sheets'] }
        expect(parseKickoff(buildKickoffMarker(intent))?.intent).toEqual(intent)
        expect(stripKickoff(buildKickoffMarker(intent))).toBe('Sort my inbox every morning')
    })

    it('survives a name full of the characters the marker is made of', () => {
        const intent: KickoffIntent = { kind: 'prompt', text: 'Watch my feed', name: 'My ]] agent: v2 & co' }
        const marker = buildKickoffMarker(intent)
        expect(marker.split('\n')).toHaveLength(2)
        expect(parseKickoff(marker)?.intent).toEqual(intent)
    })

    it('bounds what a hand-written marker claims, as the landing link is bounded', () => {
        const parsed = parseKickoff(`[[foreman:start:prompt:name=${'a'.repeat(80)}&apps=gmail,<script>,../etc]]\nSort my inbox`)
        expect(parsed?.intent).toEqual({ kind: 'prompt', text: 'Sort my inbox', name: 'a'.repeat(60), apps: ['gmail'] })
    })

    // Written under the welcome card: no arriving intent, so the starter pack step still owns the
    // conversation, and the line shows in the stack as theirs.
    it('carries a line written under the welcome card without making it an arriving intent', () => {
        const marker = buildOwnKickoff('  Chase my unpaid invoices\nevery Monday ]] ')
        expect(isKickoffText(marker)).toBe(true)
        expect(parseKickoff(marker)).toEqual({ intent: null })
        expect(readOwnAsk(marker)).toBe('Chase my unpaid invoices\nevery Monday ]]')
        expect(stripKickoff(marker)).toBe('Chase my unpaid invoices\nevery Monday ]]')
        expect(readOwnAsk(buildKickoffMarker(null))).toBeNull()
        expect(readOwnAsk(buildKickoffMarker({ kind: 'prompt', text: 'Sort my inbox' }))).toBeNull()
    })

    it('is not a kickoff when the first line is not the marker', () => {
        expect(parseKickoff('Hello')).toBeNull()
        expect(parseKickoff('Hello\n[[foreman:start]]')).toBeNull()
        expect(isKickoffText('Hello')).toBe(false)
    })

    // The stack shows what the user wrote and never the marker, so a bare start disappears whole
    // while a prompt keeps its words.
    it('leaves nothing of a bare start and everything of a prompt', () => {
        expect(stripKickoff(buildKickoffMarker(null))).toBe('')
        expect(stripKickoff(buildKickoffMarker({ kind: 'prompt', text: 'Sort my inbox' }))).toBe('Sort my inbox')
        expect(stripKickoff('Just a message')).toBe('Just a message')
    })

    it('rides the query string of the phase probe in the same grammar', () => {
        expect(decodeIntent(encodeIntent({ kind: 'template', slug: 'seo-newsroom' }))).toEqual({ kind: 'template', slug: 'seo-newsroom' })
        expect(decodeIntent(null)).toBeNull()
        expect(decodeIntent('nonsense')).toBeNull()
    })
})
