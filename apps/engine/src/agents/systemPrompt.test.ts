import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

process.env.RERUN_DATA_DIR = mkdtempSync(resolve(tmpdir(), 'rerun-system-prompt-'))

const { afterEach, describe, expect, it, vi } = await import('vitest')
const { agentConfigSchema } = await import('@rerun/contracts')
const { buildSystemPrompt: buildSystemPromptBlocks, systemPromptText, currentTimeNote, nowBlock, userBlock, userLanguageBlock } = await import('./systemPrompt.js')

// The tests read the prompt as the model does, both blocks joined.
const buildSystemPrompt = async (...args: Parameters<typeof buildSystemPromptBlocks>) => systemPromptText(await buildSystemPromptBlocks(...args))

const agent = {
    id: 'prompt-agent',
    config: agentConfigSchema.parse({ name: 'Prompt test', provider: 'rerun', tools: { memory: false, db: false, schedule: false } }),
    soul: 'You are a test agent.',
    env: {},
    resolved: { connection: null, provider: 'rerun', model: 'rerun-max' },
}

function agentWith(tools: Record<string, boolean>) {
    return { ...agent, config: agentConfigSchema.parse({ name: 'Prompt test', provider: 'rerun', tools }) }
}

function agentWithVerbosity(verbosity: string, selfImprovementEnabled: boolean) {
    return { ...agent, config: agentConfigSchema.parse({ name: 'Prompt test', provider: 'rerun', verbosity, selfImprovement: { enabled: selfImprovementEnabled }, tools: { memory: false, db: false, schedule: false } }) }
}

describe('buildSystemPrompt database sections', () => {
    it('drops the "only one database" claim once the shared one is reachable', async () => {
        const prompt = await buildSystemPrompt(agentWith({ db: true, sharedDb: true }), { source: 'chat' })
        expect(prompt).toContain('<shared_database>')
        expect(prompt).toContain('private SQL database that no other coworker can read')
        expect(prompt).not.toContain('one private SQL database, and only one')
        expect(prompt).toContain('RERUN_SHARED_DB')
    })

    it('keeps the single-database wording and says nothing about sharing when the gate is off', async () => {
        const prompt = await buildSystemPrompt(agentWith({ db: true, sharedDb: false }), { source: 'chat' })
        expect(prompt).toContain('one private SQL database, and only one')
        expect(prompt).not.toContain('<shared_database>')
        expect(prompt).not.toContain('RERUN_SHARED_DB')
    })

    it('still states the routing doctrine when the shared database is empty', async () => {
        const prompt = await buildSystemPrompt(agentWith({ db: true, sharedDb: true }), { source: 'chat' })
        expect(prompt).toContain('Your private database stays the default')
    })
})

describe('company brain section', () => {
    it('tells the agent to read the brain and propose changes, never to write it', async () => {
        const prompt = await buildSystemPrompt(agentWith({ brain: true }), { source: 'chat' })
        expect(prompt).toContain('<company_brain>')
        expect(prompt).toContain('The company brain is still empty.')
    })

    it('leaves the section out when the brain tools are off', async () => {
        const prompt = await buildSystemPrompt(agentWith({ brain: false }), { source: 'chat' })
        expect(prompt).not.toContain('<company_brain>')
    })
})

describe('operating notes', () => {
    it('checks what a site or a file holds at the source before stating it', async () => {
        const prompt = await buildSystemPrompt(agent, { source: 'chat' })
        const section = prompt.slice(prompt.indexOf('<operating_notes>'), prompt.indexOf('</operating_notes>'))
        expect(section).toContain('a sitemap and robots.txt for a site')
        expect(section).toContain('a search that returns nothing says nothing about what exists')
    })

    it('reads a message sent under the user\'s name as its recipient: the link, one ask, their language, no placeholder', async () => {
        const prompt = await buildSystemPrompt(agent, { source: 'chat' })
        const section = prompt.slice(prompt.indexOf('<operating_notes>'), prompt.indexOf('</operating_notes>'))
        expect(section).toContain('is read once as its recipient before it leaves')
        expect(section).toContain('says what the user offers with the link to it')
        expect(section).toContain("is in the recipient's language")
        expect(section).toContain('carries no bracketed placeholder')
        expect(section).toContain("is signed with the user's own name (the <user> block, or ask for it when you have none)")
    })

    it('tells the agent that nothing outlives its turn', async () => {
        const prompt = await buildSystemPrompt(agent, { source: 'chat' })
        expect(prompt).toContain('Nothing keeps running once your turn ends')
        expect(prompt).toContain('never tell the user you will come back')
    })

    it('tells the agent its tool calls and reasoning stay out of sight, so what the user should read goes in the reply', async () => {
        const prompt = await buildSystemPrompt(agent, { source: 'chat' })
        expect(prompt).toContain('<what_the_user_sees>')
        expect(prompt).toContain('Never point to it as "above"')
    })

    it('puts a text the user sends elsewhere in one draft block, which the chat draws as a card to copy', async () => {
        const prompt = await buildSystemPrompt(agent, { source: 'chat' })
        const section = prompt.slice(prompt.indexOf('<what_the_user_sees>'), prompt.indexOf('</what_the_user_sees>'))
        expect(section).toContain('```draft')
        expect(section).toContain('copy button')
    })

    it('keeps tool names and the catalog out of the message, and says a missing route in one line of the user\'s words', async () => {
        const prompt = await buildSystemPrompt(agent, { source: 'chat' })
        const section = prompt.slice(prompt.indexOf('<what_the_user_sees>'), prompt.indexOf('</what_the_user_sees>'))
        expect(section).toContain('never write a tool name, a capability id or a parameter in your message')
        expect(section).toContain('say so in one line in their words')
    })

    it('wants what a card asks about in the turn that asks, again when the card is sent again', async () => {
        const prompt = await buildSystemPrompt(agent, { source: 'chat' })
        const section = prompt.slice(prompt.indexOf('<what_the_user_sees>'), prompt.indexOf('</what_the_user_sees>'))
        expect(section).toContain('goes in full in the message the card goes out with')
        expect(section).toContain('Having shown it a few messages earlier does not count')
        expect(section).toContain('a card you send again')
        expect(section).not.toContain('before the question')
    })

    it('spares an ephemeral delegate the rule, its reader is the coworker that called it', async () => {
        const delegate = { ...agent, config: agentConfigSchema.parse({ name: 'Prompt test delegate', provider: 'rerun', ephemeral: true, tools: { memory: false, db: false, schedule: false } }) }
        expect(await buildSystemPrompt(delegate, { source: 'chat' })).not.toContain('<what_the_user_sees>')
    })
})

describe('skills section', () => {
    it('states the capture doctrine even when the agent has no skill yet', async () => {
        const prompt = await buildSystemPrompt(agentWith({ skills: true }), { source: 'chat' })
        expect(prompt).toContain('<skills>')
        expect(prompt).toContain('You have no skill yet')
        expect(prompt).toContain('Never write a skill on your own initiative')
    })

    it('sends the capture through the inline proposal, never through a question', async () => {
        const prompt = await buildSystemPrompt(agentWith({ skills: true, askUser: true }), { source: 'chat' })
        expect(prompt).toContain('propose it in that same turn with one skill_propose call')
        expect(prompt).toContain('The call does not pause you and writes nothing')
        expect(prompt).toContain('say in one short sentence that you suggest keeping this as a skill')
        expect(prompt).toContain('no question that waits for an answer')
        expect(prompt).not.toContain('single ask_user question')
        expect(prompt).not.toContain('a bare acknowledgement is a failure')
    })

    it('tells the model a card without a message is a message the user never got', async () => {
        const prompt = await buildSystemPrompt(agentWith({ askUser: true }), { source: 'chat' })
        expect(prompt).toContain('The card never carries your explanation')
        expect(prompt).toContain('leaves the user with a bare card')
        const without = await buildSystemPrompt(agentWith({ askUser: false, requestApproval: false }), { source: 'chat' })
        expect(without).not.toContain('The card never carries your explanation')
    })

    it('places the card below the message, whichever comes first in the reply', async () => {
        for (const provider of ['claude', 'codex'] as const) {
            const prompt = await buildSystemPrompt(agentWith({ askUser: true }), { source: 'chat' }, provider)
            const section = prompt.slice(prompt.indexOf('<asking_the_user>'), prompt.indexOf('</asking_the_user>'))
            expect(section).toContain('the card shows at the bottom of the conversation, below your message')
            expect(section).toContain('never the card above')
        }
        const without = await buildSystemPrompt(agentWith({ askUser: false, requestApproval: false, suggestService: false, requestSecret: false }), { source: 'chat' })
        expect(without).not.toContain('never the card above')
    })

    it('holds the proposal back while a flow is still being built', async () => {
        const prompt = await buildSystemPrompt(agentWith({ skills: true }), { source: 'chat' })
        expect(prompt).toContain('never while it is still being shaped')
        expect(prompt).toContain('is settled the moment they state it')
        expect(prompt).toContain('propose nothing and keep building')
        expect(prompt).toContain('one skill_propose call that carries the whole flow as it ended up')
        expect(prompt).toContain('never one call per step')
    })

    it('says the same thing whether or not anyone is watching the run', async () => {
        const chat = await buildSystemPrompt(agentWith({ skills: true, askUser: true }), { source: 'chat' })
        const scheduled = await buildSystemPrompt(agentWith({ skills: true, askUser: true }), { source: 'schedule', slug: 'weekly', name: 'Weekly' })
        expect(scheduled).toContain('propose it in that same turn with one skill_propose call')
        expect(scheduled).not.toContain('do not pause it with ask_user just to propose a capture')
        expect(chat).not.toContain('do not pause it with ask_user just to propose a capture')
    })

    it('aims at the skill that already covers the ground', async () => {
        const prompt = await buildSystemPrompt(agentWith({ skills: true }), { source: 'chat' })
        expect(prompt).toContain("aim at the skill that already covers that ground with mode 'edit'")
    })

    it('drops every skill instruction when the tools are off', async () => {
        const prompt = await buildSystemPrompt(agentWith({ skills: false }), { source: 'chat' })
        expect(prompt).not.toContain('<skills>')
        expect(prompt).not.toContain('skill_')
    })

    it('drops the capture note when self-improvement is off', async () => {
        const off = { ...agent, config: agentConfigSchema.parse({ name: 'Prompt test', provider: 'rerun', selfImprovement: { enabled: false }, tools: { skills: true } }) }
        const prompt = await buildSystemPrompt(off, { source: 'chat' })
        expect(prompt).not.toContain('skill_propose')
    })
})

describe('current time', () => {
    afterEach(() => {
        vi.useRealTimers()
    })

    it('states the UTC day and points at the per-turn block', async () => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date('2026-08-16T14:32:07Z'))
        const prompt = await buildSystemPrompt(agent, { source: 'chat' })
        expect(prompt).toContain('<current_time>')
        expect(prompt).toContain('Today is Sunday, 16 August 2026 (UTC)')
        expect(prompt).toContain('<now> block')
    })

    it('stays byte-identical across the same UTC day so the cached prefix survives', () => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date('2026-08-16T01:05:00Z'))
        const morning = currentTimeNote()
        vi.setSystemTime(new Date('2026-08-16T23:58:00Z'))
        expect(currentTimeNote()).toBe(morning)
        vi.setSystemTime(new Date('2026-08-17T00:02:00Z'))
        expect(currentTimeNote()).not.toBe(morning)
    })

    it('carries the exact timestamp in the turn block', () => {
        expect(nowBlock(new Date('2026-08-16T14:32:07Z'))).toBe('<now>\n2026-08-16T14:32:07Z (Sunday, 16 August 2026, 14:32 UTC)\n</now>')
    })

    it('names the language of the user in the turn block of an install, and adds nothing without one', () => {
        expect(userLanguageBlock('French')).toMatch(/^<user_language>\nFrench: /)
        expect(userLanguageBlock(undefined)).toBe('')
    })

    it('names the user in the turn block so what goes out under their name is signed with it', () => {
        expect(userBlock('Yassine')).toMatch(/^<user>\nYassine: the person you are talking to/)
        expect(userBlock('Yassine')).toContain('sign with it what goes out under their name')
        expect(userBlock(undefined)).toBe('')
    })
})

describe('buildSystemPrompt provider notes', () => {
    it.each(['claude', 'codex'] as const)('adds the MCP bridge note for the effective %s provider', async provider => {
        const prompt = await buildSystemPrompt(agent, { source: 'chat' }, provider)
        expect(prompt).toContain('<bridged_tools>')
        expect(prompt).toContain('mcp__rerun__ask_user')
    })

    it.each(['rerun', 'openai', 'anthropic', 'google', 'openrouter'] as const)('leaves the %s prompt without the bridge note', async provider => {
        const prompt = await buildSystemPrompt(agent, { source: 'chat' }, provider)
        expect(prompt).not.toContain('<bridged_tools>')
        expect(prompt).not.toContain('mcp__rerun__ask_user')
    })

    it.each([['claude', 'WebSearch'], ['codex', 'web_search']] as const)('points web_search at the %s built-in', async (provider, builtIn) => {
        const prompt = await buildSystemPrompt(agent, { source: 'chat' }, provider)
        expect(prompt).toContain(`web_search is the one exception: it names your own built-in ${builtIn} tool`)
    })

    it.each(['codex', 'claude', 'anthropic'] as const)('tells %s to make the closing calls before writing its message', async provider => {
        const prompt = await buildSystemPrompt(agent, { source: 'chat' }, provider)
        expect(prompt).toContain('<turn_order>')
        expect(prompt).toContain('a message written before a call does not reach the user as your message')
        expect(prompt).not.toContain('A turn ends in this order, your message first')
    })

    it('puts the message before the closing calls on a Rerun alias the hub has not resolved', async () => {
        const prompt = await buildSystemPrompt(agent, { source: 'chat' }, 'rerun')
        expect(prompt).toContain('A turn ends in this order, your message first')
        expect(prompt).not.toContain('a message written before a call does not reach the user as your message')
    })

    it('leaves the turn order out for an agent with nothing that closes a turn', async () => {
        const nothingCloses = { ...agent, config: agentConfigSchema.parse({ name: 'Prompt test agent', provider: 'rerun', tools: { askUser: false, requestApproval: false, suggestService: false, requestSecret: false, quickReplies: false, skills: false, paidData: false, browser: false }, selfImprovement: { enabled: false } }) }
        const prompt = await buildSystemPrompt(nothingCloses, { source: 'chat' }, 'codex')
        expect(prompt).not.toContain('<turn_order>')
    })
})

describe('verbosity section', () => {
    it('says nothing at all when the level is normal and the agent cannot change it', async () => {
        const prompt = await buildSystemPrompt(agentWithVerbosity('normal', false), { source: 'chat' })
        expect(prompt).not.toContain('<verbosity>')
    })

    it('still offers the tool at the normal level, so the agent knows the setting exists', async () => {
        const prompt = await buildSystemPrompt(agentWithVerbosity('normal', true), { source: 'chat' })
        expect(prompt).toContain('<verbosity>')
        expect(prompt).toContain('verbosity_set')
        expect(prompt).toContain('currently normal')
    })

    it('asks for one or two sentences at the minimal level', async () => {
        const prompt = await buildSystemPrompt(agentWithVerbosity('minimal', false), { source: 'chat' })
        expect(prompt).toContain('<verbosity>')
        expect(prompt).toContain('Answer in one or two sentences')
        expect(prompt).not.toContain('verbosity_set')
    })

    it('states that the length never buys less work', async () => {
        const prompt = await buildSystemPrompt(agentWithVerbosity('concise', false), { source: 'chat' })
        expect(prompt).toContain('never buys you fewer steps')
    })

    it('opens the tap at the detailed level instead of tightening it', async () => {
        const prompt = await buildSystemPrompt(agentWithVerbosity('detailed', false), { source: 'chat' })
        expect(prompt).toContain('Take the room you need')
        expect(prompt).not.toContain('Lead with the result and stop there')
    })
})

describe('memory routing', () => {
    it('puts how-to knowledge in a skill and keeps memory as the fallback', async () => {
        const prompt = await buildSystemPrompt(agentWith({ memory: true, skills: true }), { source: 'chat' })
        expect(prompt).toContain('goes through the skill proposal described in your skills section, at the moment set there')
        expect(prompt).toContain('belongs in a skill, and editing the skill that already covers it comes before creating a new one')
        expect(prompt).toContain('memory_write is the fallback for what no skill governs')
        expect(prompt).toContain('once it is in a skill, delete the memory that held it with memory_delete')
    })

    it('refuses to call a misfiled procedure saved', async () => {
        const prompt = await buildSystemPrompt(agentWith({ memory: true, skills: true }), { source: 'chat' })
        expect(prompt).toContain('A procedure sitting in your memory is misfiled')
    })
})

describe('buildSystemPrompt sub-agent rules', () => {
    it('tells an ephemeral delegate to give up on a refusing source and to answer on its own', async () => {
        const delegate = { ...agent, config: agentConfigSchema.parse({ name: 'Prompt test delegate', provider: 'rerun', ephemeral: true, tools: { memory: false, db: false, schedule: false } }) }
        const prompt = await buildSystemPrompt(delegate, { source: 'chat' })
        expect(prompt).toContain('<sub_agent_rules>')
        expect(prompt).toContain('never ask a question')
        expect(prompt).toContain('A source that refuses you twice')
    })

    it('says nothing about sub-agent rules to a persistent agent', async () => {
        expect(await buildSystemPrompt(agent, { source: 'chat' })).not.toContain('<sub_agent_rules>')
    })
})

describe('reporting failures', () => {
    it('tells the agent to open its final message with what failed, and not to announce an action early', async () => {
        const prompt = await buildSystemPrompt(agent, { source: 'chat' })
        expect(prompt).toContain('<reporting_failures>')
        expect(prompt).toContain('your final message opens with that')
        expect(prompt).toContain('before the tool call that does it has returned')
        expect(prompt).toContain('is still news to the reader')
    })

    it('holds for a sub-agent too, whose caller reads only its result', async () => {
        const delegate = { ...agent, config: agentConfigSchema.parse({ name: 'Prompt test delegate', provider: 'rerun', ephemeral: true, tools: { memory: false, db: false, schedule: false } }) }
        expect(await buildSystemPrompt(delegate, { source: 'chat' })).toContain('<reporting_failures>')
    })
})

describe('quick replies section', () => {
    // The replies are a block of the message, never a call: a tool to call right before or after
    // the message had the model drafting that message in its thinking instead of writing it.
    it('tells a regular agent to close its message with the block, on every provider', async () => {
        for (const provider of ['rerun', 'claude', 'codex'] as const) {
            const prompt = await buildSystemPrompt(agent, { source: 'chat' }, provider)
            expect(prompt).toContain('<quick_replies>')
            expect(prompt).toContain('one per line, between a <quick_replies> line and a </quick_replies> line, as the very last lines of your message')
            expect(prompt).toContain('a reply never stands in for telling the user that something failed')
            expect(prompt).toContain('never when your message waits for something only the user has (a URL, an ID, a name, an email, a file, an access)')
            expect(prompt).toContain('the block is left out entirely, even for the other questions of that message')
            expect(prompt).not.toContain('suggest_replies')
        }
    })

    it('keeps the replies out of the turn order, which only orders the cards', async () => {
        expect(await buildSystemPrompt(agent, { source: 'chat' }, 'codex')).toMatch(/the calls first: .*at most one card that asks the user something \(.*ask_user.*\); \d\) your message, complete/)
        expect(await buildSystemPrompt(agent, { source: 'chat' }, 'rerun')).toMatch(/A turn ends in this order, your message first: 1\) your message.*\) at most one card that asks the user something/)
    })

    it('stays out of a sub-agent, and out of an agent with the switch off', async () => {
        const delegate = { ...agent, config: agentConfigSchema.parse({ name: 'Prompt test delegate', provider: 'rerun', ephemeral: true, tools: { memory: false, db: false, schedule: false } }) }
        expect(await buildSystemPrompt(delegate, { source: 'chat' })).not.toContain('<quick_replies>')
        expect(await buildSystemPrompt(agentWith({ quickReplies: false }), { source: 'chat' })).not.toContain('<quick_replies>')
    })

    it('leaves the ban on a card written as a tag to the asking section, replies or not', async () => {
        for (const config of [agent, agentWith({ quickReplies: false })]) {
            const prompt = await buildSystemPrompt(config, { source: 'chat' })
            const section = prompt.slice(prompt.indexOf('<asking_the_user>'), prompt.indexOf('</asking_the_user>'))
            expect(section).toContain('a tag like <ask_user> shows to the user as raw text')
            expect(prompt.split('a tag like <ask_user>').length).toBe(2)
        }
    })
})

describe('paid data section', () => {
    const paidDataSection = async () => {
        const prompt = await buildSystemPrompt(agentWith({ paidData: true }), { source: 'chat' })
        return prompt.slice(prompt.indexOf('<paid_data>'), prompt.indexOf('</paid_data>'))
    }

    it('points the coworker at the catalog tool instead of an index in the description', async () => {
        const section = await paidDataSection()
        expect(section).toContain('paid_data_catalog reads that catalog for free')
        expect(section).not.toContain('indexed in its description')
    })

    it('spends small batches without asking, whether or not approvals are on, and asks in plain words before a big one', async () => {
        for (const requestApproval of [true, false]) {
            const prompt = await buildSystemPrompt(agentWith({ paidData: true, requestApproval }), { source: 'chat' })
            expect(prompt).not.toContain('request_spend')
            expect(prompt).not.toContain('Spend without asking')
            expect(prompt).toContain('Up to 200 credits over a task, you use it without asking first')
            expect(prompt).toContain('about how many credits it costs')
            expect(prompt).toContain('say in one short line of your message what you are about to buy')
            expect(prompt).toContain('with no card and no tool (not ask_user, not request_approval)')
        }
    })

    it('buys a big spend without asking when nobody typed the run: a routine, a webhook', async () => {
        for (const trigger of [
            { source: 'schedule', slug: 'weekly', name: 'Weekly' },
            { source: 'trigger', slug: 'hook', name: 'Hook' },
        ] as const) {
            const prompt = await buildSystemPrompt(agentWith({ paidData: true, askUser: true }), trigger)
            expect(prompt).toContain('You use it without asking first: call it directly')
            expect(prompt).not.toContain('big spend')
        }
    })

    it('buys a big spend without asking as an ephemeral delegate, which has no user to answer', async () => {
        const delegate = { ...agent, config: agentConfigSchema.parse({ name: 'Prompt test delegate', provider: 'rerun', ephemeral: true, tools: { paidData: true, memory: false, db: false, schedule: false } }) }
        const prompt = await buildSystemPrompt(delegate, { source: 'chat' })
        expect(prompt).toContain('You use it without asking first: call it directly')
        expect(prompt).not.toContain('big spend')
    })

    it('sizes a spend to the plan unless the user asked for a volume, and keeps the data off the screen', async () => {
        const section = await paidDataSection()
        expect(section).toContain('when the user asks for a volume (1,000 leads), plan that volume')
        expect(section).toContain('never gather this data by hand on your computer')
    })

    it('routes people, contact, company, social and SEO data to paid_data from the first step, not after a round of web searches', async () => {
        const section = await paidDataSection()
        expect(section).toContain('Pick the tool by the shape of what you need')
        expect(section).toContain('paid_data is the tool from the first step')
        expect(section).not.toContain('prefer web_search and web_fetch, which are free')
    })

    it('checks the rows it bought against every criterion, and the signals none of their fields carry on each site, before delivering', async () => {
        const section = await paidDataSection()
        expect(section).toContain('Rows paid_data returns are candidates, not your answer')
        expect(section).toContain('any filter the answer says the provider ignored')
        expect(section).toContain("check them on each candidate's own site or profile with web_fetch or browser_navigate in the same turn")
        expect(section).toContain('never a count you do not hold')
    })

    it('completes a partial result with the paid step in the same turn instead of offering it', async () => {
        const section = await paidDataSection()
        expect(section).toContain('companies but no decision-maker')
        expect(section).toContain('complete it with paid_data in the same turn')
        expect(section).not.toContain('offer the paid step')
    })

    it('closes a capability for the task once a call cost far more than the catalog said or bought nothing usable', async () => {
        const section = await paidDataSection()
        expect(section).toContain('billed well above what the catalog said')
        expect(section).toContain('that capability is closed for the rest of the task')
        expect(section).toContain('never try it again with other inputs')
    })

    it('calls it paid data to the user', async () => {
        expect(await paidDataSection()).toContain('never paid_data, a capability id or a catalog')
    })
})

describe('project knowledge section', () => {
    it('injects the hub-written project note and leaves the section out without one', async () => {
        const { mkdir, writeFile, rm } = await import('node:fs/promises')
        const { projectNotePath } = await import('../config/paths.js')
        const { dirname } = await import('node:path')

        const before = await buildSystemPrompt(agentWith({ memory: false, db: false, schedule: false }), { source: 'chat' })
        expect(before).not.toContain('<project_knowledge>')

        const notePath = projectNotePath(agent.id)
        await mkdir(dirname(notePath), { recursive: true })
        await writeFile(notePath, '# Project knowledge\nYour Box "NSCB Licensing" is the project for the engagement "73 NSCB".')
        try {
            const prompt = await buildSystemPrompt(agentWith({ memory: false, db: false, schedule: false }), { source: 'chat' })
            expect(prompt).toContain('<project_knowledge>')
            expect(prompt).toContain('73 NSCB')
        } finally {
            await rm(notePath, { force: true })
        }
    })
})
