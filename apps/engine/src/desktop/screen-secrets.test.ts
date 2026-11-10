import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

process.env.RERUN_DATA_DIR = mkdtempSync(resolve(tmpdir(), 'rerun-screen-secrets-'))
process.env.RERUN_API_KEY = ''

const { describe, expect, it } = await import('vitest')
const { serializeApprovalDecisions } = await import('@rerun/contracts')
const { appendMessage } = await import('../db/repos/messages.js')
const { dropScreenSecretMeta, listScreenSecretMeta, saveScreenSecretMeta, screenSecretMeta, secretUseDecision, typeSecretApprovalAction } = await import('./screen-secrets.js')

describe('screen secret metadata', () => {
    it('saves a site for a key, normalized, and reads it back', async () => {
        await saveScreenSecretMeta('a1', 'GITHUB_PASSWORD', { site: 'https://www.GitHub.com/login' })
        expect(await screenSecretMeta('a1', 'GITHUB_PASSWORD')).toEqual({ site: 'github.com', allowAlways: false })
    })

    it('overwrites the site and the standing approval on a second save', async () => {
        await saveScreenSecretMeta('a1', 'ROTATED', { site: 'old.example' })
        await saveScreenSecretMeta('a1', 'ROTATED', { site: 'new.example', allowAlways: true })
        expect(await screenSecretMeta('a1', 'ROTATED')).toEqual({ site: 'new.example', allowAlways: true })
    })

    it('refuses to save what is not a site', async () => {
        await expect(saveScreenSecretMeta('a1', 'BAD', { site: 'not a site' })).rejects.toThrow('Not a site')
        await expect(saveScreenSecretMeta('a1', 'BAD', { site: '' })).rejects.toThrow('Not a site')
        expect(await screenSecretMeta('a1', 'BAD')).toBeNull()
    })

    it('lists every key with its metadata and drops removed keys', async () => {
        await saveScreenSecretMeta('a2', 'ONE', { site: 'one.example' })
        await saveScreenSecretMeta('a2', 'TWO', { site: 'two.example', allowAlways: true })
        expect(await listScreenSecretMeta('a2')).toEqual({
            ONE: { site: 'one.example', allowAlways: false },
            TWO: { site: 'two.example', allowAlways: true },
        })
        await dropScreenSecretMeta('a2', ['ONE', 'NEVER_SAVED'])
        expect(await listScreenSecretMeta('a2')).toEqual({ TWO: { site: 'two.example', allowAlways: true } })
        expect(await screenSecretMeta('a2', 'ONE')).toBeNull()
    })

    it('answers null for an agent that never saved any', async () => {
        expect(await screenSecretMeta('fresh', 'ANY')).toBeNull()
        expect(await listScreenSecretMeta('fresh')).toEqual({})
    })
})

describe('secretUseDecision', () => {
    const approvalReply = (decision: 'approved' | 'declined', action: string) => serializeApprovalDecisions([{ action, decision }])

    it('finds the approval the user gave in the current run, exact action line only', async () => {
        await appendMessage('a3', 's1', { role: 'user', content: [{ type: 'text', text: 'Sign in to github for me' }] })
        await appendMessage('a3', 's1', { role: 'assistant', content: [{ type: 'text', text: 'I need your approval.' }] })
        await appendMessage('a3', 's1', { role: 'user', content: [{ type: 'text', text: approvalReply('approved', typeSecretApprovalAction('GITHUB_PASSWORD', 'github.com')) }] })
        expect(await secretUseDecision('a3', 's1', 'GITHUB_PASSWORD', 'github.com')).toBe('approved')
        expect(await secretUseDecision('a3', 's1', 'GITHUB_PASSWORD', 'other.example')).toBeNull()
        expect(await secretUseDecision('a3', 's1', 'OTHER_KEY', 'github.com')).toBeNull()
    })

    it('reads the approval even when the engine appended a context part to the turn', async () => {
        await appendMessage('a3', 's2', { role: 'user', content: [{ type: 'text', text: 'Go' }] })
        await appendMessage('a3', 's2', {
            role: 'user',
            content: [
                { type: 'text', text: approvalReply('approved', typeSecretApprovalAction('KEY', 'site.example')) },
                { type: 'text', text: '<now>2026-11-10</now>' },
            ],
        })
        expect(await secretUseDecision('a3', 's2', 'KEY', 'site.example')).toBe('approved')
    })

    it('reports a decline as a decline, not as a missing approval', async () => {
        await appendMessage('a3', 's3', { role: 'user', content: [{ type: 'text', text: 'Go' }] })
        await appendMessage('a3', 's3', { role: 'user', content: [{ type: 'text', text: approvalReply('declined', typeSecretApprovalAction('KEY', 'site.example')) }] })
        expect(await secretUseDecision('a3', 's3', 'KEY', 'site.example')).toBe('declined')
    })

    it('does not carry an approval over into the next run', async () => {
        await appendMessage('a3', 's4', { role: 'user', content: [{ type: 'text', text: 'Go' }] })
        await appendMessage('a3', 's4', { role: 'user', content: [{ type: 'text', text: approvalReply('approved', typeSecretApprovalAction('KEY', 'site.example')) }] })
        await appendMessage('a3', 's4', { role: 'user', content: [{ type: 'text', text: 'Now do something else' }] })
        expect(await secretUseDecision('a3', 's4', 'KEY', 'site.example')).toBeNull()
    })

    it('looks past other HITL replies of the same run', async () => {
        await appendMessage('a3', 's5', { role: 'user', content: [{ type: 'text', text: 'Go' }] })
        await appendMessage('a3', 's5', { role: 'user', content: [{ type: 'text', text: approvalReply('approved', typeSecretApprovalAction('KEY', 'site.example')) }] })
        await appendMessage('a3', 's5', { role: 'user', content: [{ type: 'text', text: 'Credential setup result:\n- KEY: provided (stored as a coworker variable)\n\nReference a provided variable as ${KEY} in an MCP server config (headers, url, env, args) or in a command. Never ask for the value itself: it is not available to you.' }] })
        expect(await secretUseDecision('a3', 's5', 'KEY', 'site.example')).toBe('approved')
    })

    it('answers null on a session with no messages', async () => {
        expect(await secretUseDecision('a3', 'empty', 'KEY', 'site.example')).toBeNull()
    })
})
