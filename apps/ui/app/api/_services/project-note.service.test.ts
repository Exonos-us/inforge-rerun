import { beforeEach, describe, expect, it, vi } from 'vitest'

const { deleteFile, makeDir, writeFileText, selectMaybeSingle } = vi.hoisted(() => ({
    deleteFile: vi.fn(async (_conn: unknown, _base: string, _path: string) => {}),
    makeDir: vi.fn(async (_conn: unknown, _base: string, _path: string) => {}),
    writeFileText: vi.fn(async (_conn: unknown, _base: string, _path: string, _content: string) => {}),
    selectMaybeSingle: vi.fn(),
}))
vi.mock('@/lib/engine/client', () => ({ deleteFile, makeDir, writeFileText }))
vi.mock('@/supabase/supabase-helpers', () => ({ selectMaybeSingle }))
vi.mock('@/supabase/serviceRole', () => ({ createServiceRoleClient: () => ({}) }))

import { clientNoteSection, refreshProjectNote, type ClientNote } from './project-note.service'

const MDC = 'a1b8d4fa-0db3-4de6-9305-f1fb9c37ca34'
const conn = { baseUrl: 'https://engine.test', apiKey: 'k' }

function clientNote(overrides: Partial<ClientNote> = {}): ClientNote {
    return {
        id: MDC,
        name: 'Miami-Dade County',
        shortCode: 'mdc',
        skills: [{ name: 'docs-create', description: 'Documents headed to the County', body: '', raw: '', files: [] }],
        hasDocs: false,
        ...overrides,
    }
}

function answers(rows: Record<string, unknown>) {
    selectMaybeSingle.mockImplementation(async (_client: unknown, table: string) => ({ data: rows[table] ?? null }))
}

beforeEach(() => {
    vi.clearAllMocks()
})

describe('clientNoteSection', () => {
    // The whole point of the note: the skill's own description scopes it to what the County will
    // read, so a coworker asked for an internal brief rules it out and is right to by that text
    // alone. The note is what makes the client the frame instead of the subject.
    it('claims every deliverable of the Box, whatever it is about', () => {
        const note = clientNoteSection(clientNote())

        expect(note).toContain('This Box works for Miami-Dade County')
        expect(note).toContain('whatever the subject')
        expect(note).toMatch(/internal programme is still a Miami-Dade County deliverable/)
    })

    it('forbids the silent skip rather than the judgement', () => {
        const note = clientNoteSection(clientNote())

        expect(note).toContain('Never decide on your own that one of them does not apply')
        expect(note).toContain('say so in your message and ask')
    })

    it('names each skill by the slug the coworker reads it with', () => {
        const note = clientNoteSection(clientNote())

        expect(note).toContain(`client-${MDC.slice(0, 8)}-docs-create`)
    })

    it('still states who the client is when it brings no skill', () => {
        const note = clientNoteSection(clientNote({ skills: [] }))

        expect(note).toContain('This Box works for Miami-Dade County')
        expect(note).not.toContain('house standard')
    })

    it('points at the documents folder only when there are documents', () => {
        expect(clientNoteSection(clientNote({ hasDocs: true }))).toContain(`knowledge/client-${MDC.slice(0, 8)}`)
        expect(clientNoteSection(clientNote())).not.toContain('knowledge/')
    })
})

describe('refreshProjectNote', () => {
    it('writes the client section for a Box with no Confluence engagement', async () => {
        answers({ spaces: { name: 'ACME showcase' } })

        await refreshProjectNote(conn, 'engine-agent-1', 'space-1', clientNote())

        expect(writeFileText).toHaveBeenCalledTimes(1)
        expect(writeFileText.mock.calls[0][2]).toBe('.rerun/project.md')
        expect(writeFileText.mock.calls[0][3]).toContain('This Box works for Miami-Dade County')
    })

    // Both features write one file, so the one that runs last must not drop the other's section.
    it('keeps the engagement alongside the client', async () => {
        answers({ spaces: { name: 'ACME showcase' }, space_knowledge: { site_url: 'https://acme.atlassian.net', space_key: 'MDC', space_name: 'Miami-Dade', page_id: null, page_title: null, page_index: [] } })

        await refreshProjectNote(conn, 'engine-agent-1', 'space-1', clientNote())

        const note = writeFileText.mock.calls[0][3]
        expect(note).toContain('# Client — Miami-Dade County')
        expect(note).toContain('# Project knowledge')
    })

    it('leaves the engagement standing when the Box loses its client', async () => {
        answers({ spaces: { name: 'ACME showcase' }, space_knowledge: { site_url: 'https://acme.atlassian.net', space_key: 'MDC', space_name: 'Miami-Dade', page_id: null, page_title: null, page_index: [] } })

        await refreshProjectNote(conn, 'engine-agent-1', 'space-1', null)

        const note = writeFileText.mock.calls[0][3]
        expect(note).not.toContain('Miami-Dade County')
        expect(note).toContain('# Project knowledge')
        expect(deleteFile).not.toHaveBeenCalled()
    })

    it('deletes the file when nothing is left to say', async () => {
        answers({ spaces: { name: 'ACME showcase' } })

        await refreshProjectNote(conn, 'engine-agent-1', 'space-1', null)

        expect(writeFileText).not.toHaveBeenCalled()
        expect(deleteFile).toHaveBeenCalledWith(conn, '/agents/engine-agent-1/files', '.rerun/project.md')
    })

    // The Box's row still names the old client while the change is in flight, so the flow that is
    // changing it passes the new one; everything else reads what stands.
    it('reads the client from the Box when the caller passes none', async () => {
        answers({ spaces: { name: 'ACME showcase', client_id: MDC }, clients: { id: MDC, name: 'Miami-Dade County', short_code: 'mdc', skills: [], knowledge: [] } })

        await refreshProjectNote(conn, 'engine-agent-1', 'space-1')

        expect(writeFileText.mock.calls[0][3]).toContain('This Box works for Miami-Dade County')
    })
})
