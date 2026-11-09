import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('@rerun/cloud/billing', async importOriginal => ({ ...(await importOriginal<object>()), ...(await import('@/test/cloud-fakes')).CLOUD_ENTITLEMENTS }))

const mocks = vi.hoisted(() => ({
    insert: vi.fn(),
    selectMaybeSingle: vi.fn(),
}))

vi.mock('@/supabase/serviceRole', () => ({
    createServiceRoleClient: () => ({
        from: () => ({
            insert: (payload: unknown) => ({ select: () => ({ single: () => Promise.resolve(mocks.insert(payload)) }) }),
        }),
    }),
}))
vi.mock('@/supabase/supabase-helpers', () => ({ selectMaybeSingleWithJoins: vi.fn(), selectManyWithJoins: vi.fn(), selectMaybeSingle: mocks.selectMaybeSingle, selectSingle: vi.fn(), selectCount: vi.fn(), selectMany: vi.fn(), selectAll: vi.fn() }))
vi.mock('@/lib/engine/client', () => ({ listRuns: vi.fn(), getRunSteps: vi.fn() }))
vi.mock('./workspace-engine.service', () => ({ findWorkspaceEngine: vi.fn(), NoEngineError: class NoEngineError extends Error {} }))

const { createSessionRow, findGeneralSession, FIRST_MESSAGE_MAX_CHARS, GENERAL_SESSION_TITLE, GeneralAlreadyOpenError } = await import('./chat.service')

describe('createSessionRow', () => {
    beforeEach(() => {
        mocks.insert.mockReset().mockReturnValue({ data: { id: 'row-1' }, error: null })
        mocks.selectMaybeSingle.mockReset().mockResolvedValue({ data: null, error: null })
    })

    it('writes a thread by default, named after its first message', async () => {
        await expect(createSessionRow('a1', 'engine-1', 'Why did signups drop on Tuesday?')).resolves.toBe('row-1')
        expect(mocks.insert.mock.calls[0][0]).toMatchObject({ agent_id: 'a1', engine_session_id: 'engine-1', title: 'Why did signups drop on Tuesday?', kind: 'thread', source: 'dashboard' })
    })

    it('keeps the message a thread opened with, cut to what General shows', async () => {
        const long = 'x'.repeat(FIRST_MESSAGE_MAX_CHARS + 40)
        await createSessionRow('a1', 'engine-1', 'Why did signups drop?', null, 'builder', 'thread', `  ${long}  `)
        expect(mocks.insert.mock.calls[0][0]).toMatchObject({ first_message: 'x'.repeat(FIRST_MESSAGE_MAX_CHARS) })
    })

    it('leaves the opening message empty for an install or a thread the engine started', async () => {
        await createSessionRow('a1', 'engine-1', 'Setting up Acme', null, 'builder', 'thread', null)
        expect(mocks.insert.mock.calls[0][0]).toMatchObject({ first_message: null })
    })

    it('writes General under its fixed name whatever the first message says, and keeps none', async () => {
        await createSessionRow('a1', 'engine-1', 'Hello there', null, 'builder', 'general', 'Hello there')
        expect(mocks.insert.mock.calls[0][0]).toMatchObject({ title: GENERAL_SESSION_TITLE, kind: 'general', source: 'builder', first_message: null })
    })

    it('names the General that won the race when a second one is refused', async () => {
        mocks.insert.mockReturnValue({ data: null, error: { code: '23505' } })
        mocks.selectMaybeSingle.mockResolvedValue({ data: { id: 'row-first', engine_session_id: 'engine-first' }, error: null })

        const refused = await createSessionRow('a1', 'engine-2', 'Hello', null, 'builder', 'general').catch(err => err)
        expect(refused).toBeInstanceOf(GeneralAlreadyOpenError)
        expect(refused.general).toEqual({ id: 'row-first', engineSessionId: 'engine-first' })
        expect(mocks.selectMaybeSingle.mock.calls[0][3]).toEqual({ agent_id: 'a1', kind: 'general' })
    })

    it('still fails a thread the database refused', async () => {
        mocks.insert.mockReturnValue({ data: null, error: { code: '23505' } })
        await expect(createSessionRow('a1', 'engine-2', 'Hello')).rejects.toThrow('Failed to create session')
    })
})

describe('findGeneralSession', () => {
    it('is null until someone has spoken in General', async () => {
        mocks.selectMaybeSingle.mockReset().mockResolvedValue({ data: null, error: null })
        await expect(findGeneralSession('a1')).resolves.toBeNull()
    })

    it('names the row and its engine session once it exists', async () => {
        mocks.selectMaybeSingle.mockReset().mockResolvedValue({ data: { id: 'row-g', engine_session_id: 'engine-g' }, error: null })
        await expect(findGeneralSession('a1')).resolves.toEqual({ id: 'row-g', engineSessionId: 'engine-g' })
    })
})
