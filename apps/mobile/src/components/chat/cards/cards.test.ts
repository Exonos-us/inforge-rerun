import { fileHeadersFor, isHubFileUrl, mediaUrl, rawFileUrl } from '@/api/files'

import { cardOf, connectCardOf, eventCardOf, formatBytes, toneOf } from './cards'

jest.mock('expo-file-system', () => ({ Directory: class {}, File: class {}, Paths: {} }))
jest.mock('expo-sharing', () => ({ shareAsync: jest.fn() }))
jest.mock('@/config/environment', () => ({ environment: { apiUrl: 'https://hub.test' } }))

const table = { kind: 'table', scope: 'agent', table: 'leads', columns: ['name'], rows: [{ name: 'Acme' }], total: 40, columnsTruncated: false }
// What the engine hands back once the transcript is reloaded: the MCP content array, as a JSON string, in an envelope.
const reloaded = (payload: object) => ({ type: 'json', value: JSON.stringify([{ type: 'text', text: JSON.stringify(payload) }]) })

describe('cardOf', () => {
    it('reads a table card from the live stream and from a reloaded transcript alike', () => {
        expect(cardOf({ type: 'tool-card_table', state: 'output-available', output: table })).toMatchObject({ kind: 'table', card: { table: 'leads', total: 40 } })
        expect(cardOf({ type: 'dynamic-tool', toolName: 'rerun__card_table', state: 'output-available', output: reloaded(table) })).toMatchObject({ kind: 'table' })
    })

    it('reads a file card, the single-file shape of older engines included', () => {
        expect(cardOf({ type: 'tool-card_file', state: 'output-available', output: { path: 'out/report.pdf', name: 'report.pdf', size: 2048 } })).toMatchObject({ kind: 'file', card: { files: [{ name: 'report.pdf', scope: 'agent' }] } })
    })

    it('reads the picture Codex generated on a ChatGPT plan as a file card', () => {
        const generated = { kind: 'file', files: [{ path: 'generated-images/ig_1.png', name: 'ig_1.png', size: 70, scope: 'agent' }] }
        expect(cardOf({ type: 'dynamic-tool', toolName: 'image_generation', state: 'output-available', output: generated })).toMatchObject({ kind: 'file', card: { files: [{ name: 'ig_1.png' }] } })
        expect(cardOf({ type: 'dynamic-tool', toolName: 'image_generation', state: 'output-available', output: { error: 'not on this plan' } })).toBeNull()
    })

    it('leaves a call still running, a broken output and any other tool to the steps', () => {
        expect(cardOf({ type: 'tool-card_table', state: 'input-available' })).toBeNull()
        expect(cardOf({ type: 'tool-card_table', state: 'output-available', output: { kind: 'table' } })).toBeNull()
        expect(cardOf({ type: 'tool-web_search', state: 'output-available', output: table })).toBeNull()
    })
})

describe('files', () => {
    it('streams a file through the hub, from the coworker or the shared folder', () => {
        expect(rawFileUrl({ agentId: 'a1', path: 'out/report 1.pdf' })).toBe('https://hub.test/api/files/raw?agentId=a1&path=out%2Freport%201.pdf')
        expect(rawFileUrl({ agentId: 'a1', path: 'logo.png', scope: 'shared' })).toBe('https://hub.test/api/files/raw?scope=shared&path=logo.png')
    })

    it('loads a card image from the web as is, from the Box through the hub, and never from a made-up scheme', () => {
        expect(mediaUrl('https://cdn.test/a.png', 'a1')).toBe('https://cdn.test/a.png')
        expect(mediaUrl('photos/a.png', 'a1')).toBe('https://hub.test/api/files/raw?agentId=a1&path=photos%2Fa.png')
        expect(mediaUrl('data:image/png;base64,xx', 'a1')).toBeNull()
    })

    it('hands the token to the hub alone, never to an address that merely looks like ours', () => {
        const caller = { accessToken: 'jwt', workspaceId: 7 }
        expect(isHubFileUrl('https://hub.test/api/files/raw?agentId=a1&path=a.png')).toBe(true)
        expect(isHubFileUrl('https://hub.test/api/foreman/files/raw?sessionId=s1&path=a.png')).toBe(true)
        expect(fileHeadersFor(caller, 'https://hub.test/api/files/raw?agentId=a1&path=a.png')).toMatchObject({ Authorization: 'Bearer jwt', 'x-workspace-id': '7' })
        expect(fileHeadersFor(caller, 'https://evil.example/api/files/raw?p=1')).toBeUndefined()
        expect(fileHeadersFor(caller, 'https://hub.test.evil.example/api/files/raw?p=1')).toBeUndefined()
        expect(fileHeadersFor(caller, 'https://evil.example/x?u=https://hub.test/api/files/raw?p=1')).toBeUndefined()
        expect(fileHeadersFor(caller, 'https://hub.test/api/files/rawer?p=1')).toBeUndefined()
        expect(fileHeadersFor(caller, 'https://cdn.test/a.png')).toBeUndefined()
    })

    it('says a size the way a person reads it', () => {
        expect(formatBytes(900)).toBe('900 B')
        expect(formatBytes(2048)).toBe('2 KB')
        expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB')
    })

    it('keeps the tone the agent chose, and hashes a stable one otherwise', () => {
        expect(toneOf('Won', { Won: 'green' })).toBe('green')
        expect(toneOf('Lost')).toBe(toneOf('Lost'))
    })
})

describe('eventCardOf', () => {
    const done = (type: string, patch: object) => ({ type, state: 'output-available', ...patch })

    it('shows a notification the person received, not one that never went out', () => {
        expect(eventCardOf(done('tool-notify_user', { input: { message: 'Report ready' }, output: 'ok' }))).toEqual({ kind: 'notification', message: 'Report ready' })
        expect(eventCardOf(done('tool-notify_user', { input: { message: 'Report ready' }, output: 'Notification not delivered: muted' }))).toBeNull()
    })

    it('reads a finished setup with what it switched on', () => {
        expect(eventCardOf(done('tool-install_complete', { output: { status: 'complete', summary: 'Daily digest at 8', activated: { schedules: ['daily'], triggers: [] } } }))).toEqual({ kind: 'setup', summary: 'Daily digest at 8', schedules: 1, triggers: 0 })
    })

    it('tells a Brain page proposed from one that changed', () => {
        expect(eventCardOf(done('tool-brain_propose', { input: { baseHash: 'abc' }, output: { status: 'proposed', title: 'Pricing' } }))).toEqual({ kind: 'brain-proposal', title: 'Pricing', mode: 'edit' })
        expect(eventCardOf(done('tool-brain_write', { output: { status: 'saved', slug: 'pricing', title: 'Pricing', mode: 'create' } }))).toMatchObject({ kind: 'brain-change', change: { status: 'saved', title: 'Pricing' } })
    })

    it('leaves a call still running, or answered in words, as a step', () => {
        expect(eventCardOf({ type: 'tool-notify_user', state: 'input-available', input: { message: 'x' } })).toBeNull()
        expect(eventCardOf(done('tool-brain_write', { output: 'Conflict: the page changed' }))).toBeNull()
    })
})

describe('connectCardOf', () => {
    it('shows an app the coworker installed, and one still waiting on a sign-in', () => {
        expect(connectCardOf({ type: 'tool-rerun_hub_service_install', state: 'output-available', output: { status: 'installed', key: 'k', slug: 'gmail', name: 'Gmail', toolNames: ['gmail'], message: '' } })).toEqual({ kind: 'service-installed', name: 'Gmail', toolNames: ['gmail'] })
        expect(connectCardOf({ type: 'tool-rerun_hub_service_install', state: 'output-available', output: reloaded({ status: 'needs_auth', key: 'k', slug: 'notion', name: 'Notion', message: '' }) })).toEqual({ kind: 'service-needs-auth', slug: 'notion', name: 'Notion' })
    })

    it('shows a server registered outside the catalog, saved or refused', () => {
        expect(connectCardOf({ type: 'tool-mcp_register', state: 'output-available', input: { name: 'linear', url: 'https://mcp.linear.app' }, output: 'Registered linear.' })).toEqual({ kind: 'mcp-server', card: { name: 'linear', url: 'https://mcp.linear.app', outcome: 'saved' } })
        expect(connectCardOf({ type: 'tool-mcp_register', state: 'output-available', input: { name: 'x' }, output: 'Could not reach x via http: timeout. Nothing was saved.' })).toMatchObject({ card: { outcome: 'failed', failure: 'timeout. Nothing was saved.' } })
    })

    it('leaves a search of the catalog and a call still running to the steps', () => {
        expect(connectCardOf({ type: 'tool-rerun_hub_service_search', state: 'output-available', output: [] })).toBeNull()
        expect(connectCardOf({ type: 'tool-rerun_hub_service_install', state: 'input-available' })).toBeNull()
    })
})
