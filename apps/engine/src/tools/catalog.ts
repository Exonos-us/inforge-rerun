import type { ToolSet } from 'ai'
import { filesystemTools } from './builtin/filesystem.js'
import { sharedTools } from './builtin/shared.js'
import { shellTools } from './builtin/shell.js'
import { webTools } from './builtin/web.js'
import { memoryTools } from './builtin/memory.js'
import { dbTools } from './builtin/db.js'
import { sharedDbTools } from './builtin/shared-db.js'
import { brainTools } from './builtin/brain.js'
import { skillTools } from './builtin/skills.js'
import { skillProposeTool } from './builtin/skill-propose.js'
import { selfTools } from './builtin/self.js'
import { scheduleTools } from './builtin/schedule.js'
import { triggerTools } from './builtin/trigger.js'
import { delegateTools } from './builtin/delegate.js'
import { callAgentTools } from './builtin/call-agent.js'
import { teamTools } from './builtin/team.js'
import { browserTools } from './builtin/browser.js'
import { visionTools } from './builtin/vision.js'
import { computerTools } from './builtin/computer.js'
import { notifyTools } from './builtin/notify.js'
import { hubTools } from './builtin/hub.js'
import { paidDataTools } from './builtin/paid-data.js'
import { paidDataOfferedSoFar } from '../paid-data/price.js'
import { cardTools } from './builtin/cards.js'
import { askUserTool, requestApprovalTool, requestSecretTool, requestTakeoverTool, suggestServiceTool } from './builtin/hitl.js'
import { agentConfigSchema, type AgentConfig } from '../agents/types.js'
import type { RunContext } from '../runtime/context.js'
import { desktopEnabled } from '../config/env.js'

type CapabilityKey = keyof AgentConfig['tools'] | 'self'

type FamilyDef = {
    family: CapabilityKey
    description: string
    build: (ctx: RunContext) => ToolSet
    enabled: (config: AgentConfig) => boolean
    hidden?: () => boolean
}

const FAMILIES: FamilyDef[] = [
    { family: 'filesystem', description: 'Read, write, edit and search files inside the coworker workspace.', build: filesystemTools, enabled: c => c.tools.filesystem },
    { family: 'shared', description: 'Read, write, edit and search files in the shared space every coworker can access.', build: sharedTools, enabled: c => c.tools.shared },
    { family: 'shell', description: 'Run shell commands inside the workspace, behind a command-policy denylist.', build: shellTools, enabled: c => c.tools.shell },
    { family: 'web', description: 'Fetch URLs, search the web, and download files into the workspace.', build: webTools, enabled: c => c.tools.web },
    { family: 'memory', description: 'Persist durable facts and recall them by hybrid semantic + keyword search.', build: memoryTools, enabled: c => c.tools.memory },
    { family: 'db', description: 'A private SQLite database the coworker can create, migrate and query for structured records.', build: dbTools, enabled: c => c.tools.db },
    { family: 'sharedDb', description: 'A SQLite database shared by every coworker of this space: common tables they all read and write.', build: sharedDbTools, enabled: c => c.tools.sharedDb },
    { family: 'brain', description: 'Search and read the company brain, what is known about the company, and propose changes a person reviews.', build: brainTools, enabled: c => c.tools.brain },
    { family: 'skills', description: 'Create, read, update and delete reusable skill folders: a SKILL.md procedure plus the reference files it loads on demand, and propose a capture the user approves inline.', build: ctx => ({ ...skillTools(ctx), ...skillProposeTool(ctx) }), enabled: c => c.tools.skills },
    { family: 'self', description: 'Self-improvement: rewrite its own soul, set how long its answers are, install packages, register MCP servers, and auto-curate its memory.', build: selfTools, enabled: c => c.selfImprovement.enabled },
    { family: 'schedule', description: 'Plan recurring (cron) or one-shot tasks the coworker runs without a user message.', build: scheduleTools, enabled: c => c.tools.schedule },
    { family: 'trigger', description: 'Expose public webhook URLs that start a run when an external service calls them, with the caller payload attached.', build: triggerTools, enabled: c => c.tools.trigger },
    { family: 'delegate', description: 'Spawn an ephemeral sub-coworker to run a self-contained subtask to completion.', build: delegateTools, enabled: c => c.tools.delegate },
    { family: 'callAgent', description: 'Message another persistent coworker on this engine, named with @name in the instructions.', build: callAgentTools, enabled: c => c.tools.callAgent },
    { family: 'team', description: 'Read the other coworkers of the workspace: their status, scheduled tasks, triggers and recent runs, without changing anything.', build: teamTools, enabled: c => c.tools.team },
    { family: 'browser', description: 'Navigate JavaScript-heavy or bot-protected pages with a real Chromium browser, capture screenshots, and hand the browser to the user for a sign-in or a captcha.', build: ctx => ({ ...browserTools(ctx), ...(desktopEnabled() ? requestTakeoverTool(ctx) : {}) }), enabled: c => c.tools.browser },
    { family: 'vision', description: 'Analyze workspace images with the coworker multimodal model.', build: visionTools, enabled: c => c.tools.vision },
    { family: 'computer', description: 'See and drive its own computer screen: take screenshots, click, type and scroll in the browser, the file manager and the terminal, while the user watches.', build: ctx => computerTools(ctx).tools, enabled: c => c.tools.computer, hidden: () => !desktopEnabled() },
    { family: 'computerRecording', description: 'Keep the evidence of screen work: an MP4 recording and the action screenshots of each screen session land in the screen/ folder of the coworker workspace.', build: () => ({}), enabled: c => c.tools.computerRecording, hidden: () => !desktopEnabled() },
    { family: 'notify', description: 'Notify the user out-of-band (something to see, question, approval request, progress, or completion) without pausing the run.', build: notifyTools, enabled: c => c.tools.notify },
    { family: 'hub', description: 'Search, install and manage ready-made services from the Rerun catalog, and publish files to public URLs.', build: hubTools, enabled: c => c.tools.hub },
    { family: 'paidData', description: 'Buy live data from a catalog: leads and companies, SEO metrics, Google results and Maps, and public profiles and posts on LinkedIn, TikTok, Instagram, X, YouTube, Facebook and Reddit, billed on the workspace Rerun credit.', build: paidDataTools, enabled: c => c.tools.paidData, hidden: () => !paidDataOfferedSoFar() },
    { family: 'cards', description: 'Show a table or a workspace file to the user as a rich card in the conversation.', build: cardTools, enabled: c => c.tools.cards },
    { family: 'quickReplies', description: 'Lets the coworker end a message with up to three short replies shown as buttons under it, sent in one click.', build: () => ({}), enabled: c => c.tools.quickReplies },
    { family: 'askUser', description: 'Ask the user a question with suggested answers and pause the run until they reply.', build: askUserTool, enabled: c => c.tools.askUser },
    { family: 'requestApproval', description: 'Request approval before a consequential action and pause the run until the user approves or declines.', build: requestApprovalTool, enabled: c => c.tools.requestApproval },
    { family: 'suggestService', description: 'Suggest catalog apps for the user to set up, pausing the run until they finish or skip.', build: suggestServiceTool, enabled: c => c.tools.suggestService },
    { family: 'requestSecret', description: 'Ask the user for an API key or token through a masked form that stores it as a coworker variable, without the secret ever passing through the conversation.', build: requestSecretTool, enabled: c => c.tools.requestSecret },
]

const introspectionCtx = { agent: { id: '_catalog', env: {}, soul: '', config: agentConfigSchema.parse({ name: '_catalog' }) }, turnOrder: 'message-first' } as unknown as RunContext

export type ToolInfo = { name: string; description: string }
export type FamilyInfo = { family: CapabilityKey; description: string; tools: ToolInfo[] }
export type AgentFamilyInfo = FamilyInfo & { enabled: boolean }

function toolsOf(def: FamilyDef): ToolInfo[] {
    const set = def.build(introspectionCtx)
    return Object.entries(set).map(([name, t]) => ({ name, description: (t as { description?: string }).description ?? '' }))
}

const shownFamilies = (): FamilyDef[] => FAMILIES.filter(def => !def.hidden?.())

export function toolCatalog(): FamilyInfo[] {
    return shownFamilies().map(def => ({ family: def.family, description: def.description, tools: toolsOf(def) }))
}

export function agentToolCatalog(config: AgentConfig): AgentFamilyInfo[] {
    return shownFamilies().map(def => ({ family: def.family, description: def.description, enabled: def.enabled(config), tools: toolsOf(def) }))
}
