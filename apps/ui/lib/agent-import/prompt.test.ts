import { MAX_MEMORIES_PER_CALL, MAX_UPLOAD_MB } from '@/lib/mcp/account-tools'
import { describe, expect, it } from 'vitest'

import { buildImportPrompt } from './prompt'
import { IMPORT_SOURCES } from './sources'

const URL = 'https://app.rerun.build/api/mcp/account/rk_abc'

describe('buildImportPrompt', () => {
    it.each(IMPORT_SOURCES.map(source => source.id))('hands %s the connector, where to look and the rules', id => {
        const prompt = buildImportPrompt(id, URL, 'box-1')

        expect(prompt).toContain(URL)
        expect(prompt).toContain('spaceId "box-1"')
        expect(prompt).toContain(IMPORT_SOURCES.find(source => source.id === id)!.whereToLook)
        expect(prompt).toContain('Copy word for word')
        expect(prompt).toContain('Never send an API key')
        expect(prompt).toContain('create_agent is called once')
        expect(prompt).toContain('call get_agent')
    })

    it('states the same limits as the tools', () => {
        const prompt = buildImportPrompt('other', URL, null)

        expect(prompt).toContain(`up to ${MAX_MEMORIES_PER_CALL} entries per call`)
        expect(prompt).toContain(`anything over ${MAX_UPLOAD_MB} MB`)
    })

    it('names no Box when there is none to pin', () => {
        expect(buildImportPrompt('openclaw', URL, null)).not.toContain('spaceId')
    })

    it('points OpenClaw and Hermes at their own home folders', () => {
        expect(buildImportPrompt('openclaw', URL, null)).toContain('~/.openclaw')
        expect(buildImportPrompt('hermes', URL, null)).toContain('~/.hermes')
    })
})
