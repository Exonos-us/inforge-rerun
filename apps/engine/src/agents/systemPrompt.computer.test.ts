import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { vi } from 'vitest'

process.env.RERUN_DATA_DIR = mkdtempSync(resolve(tmpdir(), 'rerun-system-prompt-computer-'))
process.env.RERUN_API_KEY = ''

const box = vi.hoisted(() => ({ desktop: true, capture: true }))

vi.mock('../desktop/session.js', async importOriginal => ({
    ...(await importOriginal<typeof import('../desktop/session.js')>()),
    desktopAvailable: () => box.desktop,
    computerAvailable: () => box.desktop && box.capture,
}))

const { beforeEach, describe, expect, it } = await import('vitest')
const { agentConfigSchema } = await import('@rerun/contracts')
const { buildSystemPrompt: buildSystemPromptBlocks, systemPromptText } = await import('./systemPrompt.js')

// The tests read the prompt as the model does, both blocks joined.
const buildSystemPrompt = async (...args: Parameters<typeof buildSystemPromptBlocks>) => systemPromptText(await buildSystemPromptBlocks(...args))

function agentWith(tools: Record<string, boolean>) {
    return {
        id: 'prompt-computer-agent',
        config: agentConfigSchema.parse({ name: 'Prompt test', provider: 'rerun', tools: { memory: false, db: false, schedule: false, ...tools } }),
        soul: 'You are a test agent.',
        env: {},
        resolved: { connection: null, provider: 'rerun', model: 'rerun-max' },
    } as any
}

beforeEach(() => {
    box.desktop = true
    box.capture = true
})

describe('computer section', () => {
    it('leaves the section out on an OpenCode model that cannot read a screenshot', async () => {
        const onModel = (model: string) => ({ ...agentWith({ computer: true }), resolved: { connection: null, provider: 'opencode', model } })
        expect(await buildSystemPrompt(onModel('go/deepseek-v4-pro'), { source: 'chat' }, 'opencode')).not.toContain('<computer>')
        expect(await buildSystemPrompt(onModel('go/kimi-k3.1-pro'), { source: 'chat' }, 'opencode')).toContain('<computer>')
    })

    it('tells an agent with a computer how to use it, and to hand a sign-in to the user', async () => {
        const prompt = await buildSystemPrompt(agentWith({ computer: true }), { source: 'chat' })
        expect(prompt).toContain('<computer>')
        expect(prompt).toContain('computer_open_app')
        expect(prompt).toContain('request_takeover')
    })

    it('leaves the takeover out when the agent has no browser to hand over', async () => {
        const prompt = await buildSystemPrompt(agentWith({ computer: true, browser: false }), { source: 'chat' })
        const section = prompt.slice(prompt.indexOf('<computer>'), prompt.indexOf('</computer>'))
        expect(section).toContain('computer_open_app')
        expect(section).not.toContain('request_takeover')
    })

    it('offers to finish on the site a job that ends there, an application rather than an email, and waits for the go-ahead to submit', async () => {
        const prompt = await buildSystemPrompt(agentWith({ computer: true }), { source: 'chat' })
        const section = prompt.slice(prompt.indexOf('<computer>'), prompt.indexOf('</computer>'))
        expect(section).toContain('applying to a job offer')
        expect(section).toContain('handing them the sign-in with request_takeover')
        expect(section).toContain('go-ahead before the final submit')
    })

    it('counts a site as signed in only on the screenshot it acts in, and says so when the page keeps reloading or the window is gone', async () => {
        const prompt = await buildSystemPrompt(agentWith({ computer: true }), { source: 'chat' })
        const section = prompt.slice(prompt.indexOf('<computer>'), prompt.indexOf('</computer>'))
        expect(section).toContain('counts as signed in only on the screenshot you are about to act in')
        expect(section).toContain('When a page keeps reloading or the window is gone, say so')
        expect(section).toContain('the shortest way to do that step themselves')
    })

    it('counts an action on a site as done only on a screenshot that shows its result, and never repeats it to find out', async () => {
        const prompt = await buildSystemPrompt(agentWith({ computer: true }), { source: 'chat' })
        const section = prompt.slice(prompt.indexOf('<computer>'), prompt.indexOf('</computer>'))
        expect(section).toContain('counts as done only on a screenshot that shows its result (the confirmation, the new state)')
        expect(section).toContain('text you quote from the screen comes from a screenshot you read')
        expect(section).toContain('say it is not confirmed and look again, never doing the action twice')
    })

    it('keeps the screen for acting and sends information gathering to the browser and paid data', async () => {
        const prompt = await buildSystemPrompt(agentWith({ computer: true, paidData: true }), { source: 'chat' })
        const section = prompt.slice(prompt.indexOf('<computer>'), prompt.indexOf('</computer>'))
        expect(section).toContain('It is never for gathering information')
        expect(section).toContain('get public platform data (social profiles and posts, prospects, companies, search and SEO data) with paid_data')
        expect(section).toContain('open a page in the browser, that means browser_navigate, not your screen')
    })

    it('leaves paid data out of the computer section when the agent cannot buy it', async () => {
        const prompt = await buildSystemPrompt(agentWith({ computer: true, paidData: false }), { source: 'chat' })
        const section = prompt.slice(prompt.indexOf('<computer>'), prompt.indexOf('</computer>'))
        expect(section).toContain('It is never for gathering information')
        expect(section).not.toContain('paid_data')
    })

    it('explains the zoomed coordinate frame to the generic dialect, never to the Anthropic-native toolset', async () => {
        const generic = await buildSystemPrompt(agentWith({ computer: true }), { source: 'chat' })
        expect(generic).toContain('zoom into that region: screenshots and coordinates then refer to the zoomed view')
        const anthropic = { ...agentWith({ computer: true }), resolved: { connection: null, provider: 'anthropic', model: 'claude-opus-5-5' } }
        const native = await buildSystemPrompt(anthropic, { source: 'chat' }, 'anthropic')
        expect(native).toContain('zoom into that region first')
        expect(native).not.toContain('refer to the zoomed view')
    })

    it('tells codex alone to open each screenshot with its own image reader', async () => {
        expect(await buildSystemPrompt(agentWith({ computer: true }), { source: 'chat' }, 'codex')).toContain('view_image')
        expect(await buildSystemPrompt(agentWith({ computer: true }), { source: 'chat' }, 'claude')).not.toContain('view_image')
        expect(await buildSystemPrompt(agentWith({ computer: true }), { source: 'chat' })).not.toContain('view_image')
    })

    it('says nothing of a computer to an agent that has none', async () => {
        expect(await buildSystemPrompt(agentWith({ computer: false }), { source: 'chat' })).not.toContain('<computer>')
        box.capture = false
        expect(await buildSystemPrompt(agentWith({ computer: true }), { source: 'chat' })).not.toContain('<computer>')
    })
})

describe('service catalog next to a computer', () => {
    it('offers wa.me links next to mailto: links when a messaging app is not connected', async () => {
        const prompt = await buildSystemPrompt(agentWith({ computer: true }), { source: 'chat' })
        const section = prompt.slice(prompt.indexOf('<service_catalog>'), prompt.indexOf('</service_catalog>'))
        expect(section).toContain('mailto: links with the subject and body filled in')
        expect(section).toContain('wa.me links with the number and the message filled in')
    })

    const catalogOf = (prompt: string) => prompt.slice(prompt.indexOf('<service_catalog>'), prompt.indexOf('</service_catalog>'))

    it('does the work of a paid relay service on the screen instead of suggesting it', async () => {
        const catalog = catalogOf(await buildSystemPrompt(agentWith({ computer: true }), { source: 'chat' }))
        expect(catalog).toContain('Unipile')
        expect(catalog).toContain('computer_open_app')
        expect(catalog).toContain('request_takeover')
    })

    it('keeps reading public data off the screen, through paid data when the agent has it', async () => {
        const withPaidData = catalogOf(await buildSystemPrompt(agentWith({ computer: true, paidData: true }), { source: 'chat' }))
        expect(withPaidData).not.toContain('scraping')
        expect(withPaidData).toContain('is not this case: get it with paid_data, never on your screen')
        expect(withPaidData).toContain('using the web, the browser, paid_data, your database')
        const withoutPaidData = catalogOf(await buildSystemPrompt(agentWith({ computer: true, paidData: false }), { source: 'chat' }))
        expect(withoutPaidData).toContain('is not this case: get it with browser_navigate, never on your screen')
        expect(withoutPaidData).toContain('using the web, the browser, your database')
    })

    it('leaves the takeover out of that exception when the agent has no browser to hand over', async () => {
        const catalog = catalogOf(await buildSystemPrompt(agentWith({ computer: true, browser: false }), { source: 'chat' }))
        expect(catalog).toContain('Unipile')
        expect(catalog).not.toContain('request_takeover')
    })

    it('keeps the catalog rules unchanged for an agent with no computer', async () => {
        expect(catalogOf(await buildSystemPrompt(agentWith({ computer: false }), { source: 'chat' }))).not.toContain('computer')
        box.capture = false
        expect(catalogOf(await buildSystemPrompt(agentWith({ computer: true }), { source: 'chat' }))).not.toContain('Unipile')
    })
})
