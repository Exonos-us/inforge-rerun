import { AGENT_FOCUS_TABS, AGENT_TAB_LABELS, type AgentFocusTab } from '@/lib/board/types'
import type { ForemanPlanItem } from './phase'
import { MAX_PLAN_BOXES, MAX_PLAN_ITEMS } from './plan-items'
import { ACCOUNT_TOOL_DEFS } from '@/lib/mcp/account-tools'
import { SETTINGS_PANELS, SETTINGS_PANEL_LABELS, type SettingsPanel } from '@/lib/settings/panels'

// Which gestes the foremen are allowed to make. Pure data, no server import: the hub route wires
// the onboarding half to its handlers (lib/foreman/tools.ts), the engine foreman is briefed with the
// workspace half (./engine-brief), the browser resolves the client tools of both
// (components/foreman/foremanClientTools.ts), and the tests read it without booting any of them.

export type ForemanToolDef = { name: string; description: string; inputSchema: object }

// The account MCP tools the engine foreman is handed, run on the hub (foreman-hub.service.ts).
export const FOREMAN_MCP_TOOL_NAMES = [
    'list_spaces',
    'list_agents',
    'get_team_status',
    'get_agent',
    'create_agent',
    'update_agent',
    'delete_agent',
    'list_ai_connections',
    'set_default_model',
    'list_skills',
    'get_skill',
    'upsert_skill',
    'delete_skill',
    'list_schedules',
    'upsert_schedule',
    'run_schedule_now',
    'delete_schedule',
    'list_runs',
    'get_run',
    'search_connectors',
    'list_agent_connectors',
    'attach_connector',
    'detach_connector',
    'send_message',
    'read_skill_file',
    'list_triggers',
    'upsert_trigger',
    'test_trigger',
    'rotate_trigger_token',
    'delete_trigger',
    'list_tables',
    'db_query',
    'db_execute',
    'list_space_tables',
    'space_db_query',
    'space_db_execute',
    'list_connectors',
    'plan_agent_share',
    'create_agent_share',
    'list_agent_shares',
    'revoke_agent_share',
] as const

// No MCP tool covers the Boxes, but the app's own server actions do, so these three are declared
// here and dispatched onto them.
export const FOREMAN_BOX_TOOL_DEFS = [
    {
        name: 'create_boxes',
        description:
            'Create one Box per name, in order: a Box is a rectangle on the board that holds coworkers, so the workspace can be arranged by division, client or project. Free, and there is no limit on how many exist. Pass the whole organisation in a single call, including the divisions that stay empty for now, rather than one call per Box. The order draws the board: the first name lands at the centre and the ones after it are laid against its faces, one per side, so open with the division the user will spend their week in. The first Box of a workspace also claims the machine it runs on, which takes a few seconds and can come back unavailable; every Box after it is instant. The answer gives each Box its id and its four corners, so coworkers can be placed inside them straight away.',
        inputSchema: {
            type: 'object',
            properties: {
                names: { type: 'array', items: { type: 'string' }, description: 'One name per Box, in the order they should read on the board. Leave the array with a single empty string and Rerun names that Box after what the account does.' },
            },
            required: ['names'],
        },
    },
    {
        name: 'rename_box',
        description: 'Rename a Box. The name is what the user reads on the board, nothing else depends on it.',
        inputSchema: {
            type: 'object',
            properties: { boxId: { type: 'string' }, name: { type: 'string' } },
            required: ['boxId', 'name'],
        },
    },
    {
        name: 'delete_box',
        description:
            'Permanently delete a Box. It has to be empty first: move its coworkers to another Box, or delete them. Requires confirm: true.',
        inputSchema: {
            type: 'object',
            properties: { boxId: { type: 'string' }, confirm: { type: 'boolean' } },
            required: ['boxId', 'confirm'],
        },
    },
] as const

// The only tool that reads something outside the workspace. Rerun's own documentation is the one
// place where the answer to "what is a trigger", "what does a run cost" or "can I plug my own key"
// is written down; without it the model answers those from whatever it remembers of the charter.
export const FOREMAN_DOCS_TOOL_DEFS = [
    {
        name: 'search_docs',
        description:
            'Search the Rerun documentation (https://docs.rerun.build) and get back the passages that answer the question, each with the link it comes from. Use it for any question about how Rerun itself works, its limits, its pricing or its API, rather than answering from memory, and whenever you or the user are stuck: a tool that fails in a way you did not expect, a step in the app they cannot find or cannot get through. Hand the user the link of the passage you used. Query in English, in keywords rather than a sentence, however the user wrote to you.',
        inputSchema: {
            type: 'object',
            properties: { query: { type: 'string', description: 'What to look up, e.g. "webhook trigger token" or "trial credit limit".' } },
            required: ['query'],
        },
    },
] as const

// A Record rather than a list, so a tab added to the panel fails to compile here instead of reaching
// the model with no hint of what it shows.
const AGENT_TAB_HINTS: Record<AgentFocusTab, string> = {
    chat: 'talk to it',
    actions: 'its conversations waiting on the user',
    services: 'the apps it is plugged into',
    mcp: 'its MCP servers',
    skills: 'its skills',
    data: 'its tables',
    memories: 'what it remembers',
    files: 'its files',
    published: 'the links it published, and who can open each',
    scheduled: 'its recurring tasks',
    triggers: 'its public URLs that start a run',
    channels: 'the chats it answers in (its Slack channels today, other chat apps later), and the name and avatar it posts under in each',
    tools: 'the tools it is allowed to use',
    monitoring: 'its usage and cost',
    logs: 'its run history',
    setup: 'its install script, only for a template author',
    settings: 'its name, model and SOUL',
}

const SETTINGS_PANEL_HINTS: Record<SettingsPanel, string> = {
    workspace: 'the name and the icon of the workspace',
    members: 'who has access, and where a teammate is invited',
    api_keys: 'the keys of the Rerun API and how to plug a client onto MCP, on an active subscription or trial',
    ai_providers: 'the AI subscriptions and API keys every coworker of the workspace runs on',
    chat_apps: 'connecting the workspace to a chat app (Slack today, more later), and which coworkers answer in which channel',
    coworker_presets: 'the saved coworker definitions and team presets, where a whole squad is hired into a new Box with its Slack channel in one go',
    knowledge_base: 'the company brain (the pages every coworker reads about the company, and the changes coworkers propose to them), plus the files and the tables the whole workspace shares',
    billing: 'the plan, the add-ons, the card and the invoices',
    notifications: 'what gets notified, coworker by coworker, and the account emails',
    shortcuts: 'the keyboard shortcuts of the board',
    delete_account: 'where the user deletes their own Rerun account, only when they ask how to',
}

// The rail label rides along with each id, because the user names a tab by what they read on
// screen ("Apps", "Capabilities"), not by its id.
function describeTabs<T extends string>(tabs: readonly T[], labels: Record<T, string>, hints: Record<T, string>): string {
    return tabs.map(tab => `\`${tab}\` ("${labels[tab]}": ${hints[tab]})`).join(', ')
}

export type PlanItemKind = ForemanPlanItem['kind']

export const ALL_PLAN_KINDS: readonly PlanItemKind[] = ['agent', 'template', 'share']

const PLAN_BOXES_SCHEMA = {
    type: 'array',
    maxItems: MAX_PLAN_BOXES,
    description: `The divisions of their company, in the order they should read on the board: the first one is the heart of it, laid at the centre with the others around its four faces, so lead with the division their week actually happens in. One Box each, including the ones that hold no coworker yet: those are what show them their company fits here. Four, fewer only when the company plainly runs fewer.`,
    items: {
        type: 'object',
        properties: {
            name: { type: 'string', description: 'The division, in one or two words: Marketing, Sales, Finance, Support.' },
            role: { type: 'string', description: 'What that division covers, in a few plain words: "Enquiries, RFPs and pitches". It is only read on a Box with no coworker yet, as what will go in it later.' },
        },
        required: ['name'],
    },
}

// What a plan is allowed to hold, narrowed to the kinds this conversation can really land.
//
// The narrowing is the whole point: a team is designed, not picked, so a funnel that never met a
// ready-made one reads a schema where an agent is the only shape a plan item has. A template it
// cannot write down is a template the build phase never re-arms install_template for.
function planItemsSchema(kinds: readonly PlanItemKind[], pinned: readonly string[] | null): object {
    const ready = kinds.includes('template')
    const shared = kinds.includes('share')
    const box = pinned ? { type: 'string', enum: [...pinned], description: 'The Box its work belongs to, one of the Boxes already on their board.' } : { type: 'string', description: 'The Box this one lands in, named exactly as it appears in boxes.' }

    return {
        type: 'array',
        maxItems: MAX_PLAN_ITEMS,
        items: {
            type: 'object',
            properties: {
                kind: { type: 'string', enum: [...kinds] },
                ...(ready ? { slug: { type: 'string', description: 'For kind template: the library slug.' }, title: { type: 'string', description: 'For kind template: its title, for the record.' } } : {}),
                ...(shared ? { token: { type: 'string', description: 'For kind share: the token of the link they arrived on.' } } : {}),
                name: { type: 'string', description: 'For kind agent: what it will be called.' },
                role: { type: 'string', description: 'For kind agent: what it hands over, in one plain line of twelve words at most that starts with a verb: "Writes the case study for each finished project". No metaphor, no dash.' },
                need: { type: 'string', description: 'For kind agent: the pain from the interview this coworker goes after, in their words. Leave it out when the interview dug out none for its job.' },
                when: { type: 'string', description: 'For kind agent: what sets it off or how often it works, in a few words: "Every Monday", "When a brief comes in".' },
                beats: {
                    type: 'object',
                    description: 'For kind agent: one ordinary run of it at their company, played in a loop on the card. Three lines of five words at most, concrete enough to be theirs, and never naming an app.',
                    properties: {
                        trigger: { type: 'string', description: 'What just set it off: "New email: where is my order?", "Monday 8am, weekly run".' },
                        working: { type: 'string', description: 'What it is seen doing: "Reading order #4812", "Scoring 42 new projects".' },
                        delivered: { type: 'string', description: 'What it hands over: "Reply drafted for you", "6 leads worth a quote".' },
                    },
                    required: ['trigger', 'working', 'delivered'],
                },
                gets: {
                    type: 'array',
                    maxItems: 3,
                    items: { type: 'string' },
                    description: 'For kind agent: what they get from it this week, three plain lines of ten words at most, each a thing it hands over: "A drafted reply on every order question". Never an app, never a promise it cannot keep alone.',
                },
                box,
            },
            required: pinned ? ['kind', 'box'] : ['kind'],
        },
    }
}

// `pinned` is the onboarding's own layout: the Boxes are the ones the welcome card drew, so the model
// writes agents only and the app lays the Boxes into the call itself (pin-plan-boxes.ts).
export function showPlanDef(kinds: readonly PlanItemKind[], pinned: readonly string[] | null = null): { name: 'show_plan'; description: string; inputSchema: object } {
    return {
        name: 'show_plan',
        description: pinned
            ? 'Show the coworker you are proposing as a card, so the user reads it before anything is paid for or created: one coworker, under the Box of their board its work belongs to. They answer by confirming or by asking for changes. A confirmation is taken from there by the app itself: it writes the plan down and moves on, so there is nothing to call after it. Everything on the card is written in English, whatever language the conversation is in.'
            : 'Show the organisation you are proposing as a card, so the user reads it before anything is paid for or created: the one coworker you propose, under the division it goes in. A division left empty for now is still built on the board, only the card leaves it out. They answer by confirming or by asking for changes. A confirmation is taken from there by the app itself: it writes the plan down and moves on, so there is nothing to call after it. Everything on the card is written in English, whatever language the conversation is in.',
        inputSchema: {
            type: 'object',
            properties: {
                title: { type: 'string', description: 'Whose coworker this is, in a few words: "Your first coworker at Reloop".' },
                ...(pinned ? {} : { boxes: PLAN_BOXES_SCHEMA }),
                items: planItemsSchema(kinds, pinned),
            },
            required: pinned ? ['title', 'items'] : ['title', 'boxes', 'items'],
        },
    }
}

// `pinned` is the same layout as show_plan's: during the onboarding the template lands in one of the
// Boxes the welcome card drew, and the app lays all of them into the call itself (pin-plan-boxes.ts).
export function showTemplatesDef(pinned: readonly string[] | null = null): { name: 'show_templates'; description: string; inputSchema: object } {
    const box = pinned
        ? { type: 'string', enum: [...pinned], description: 'During onboarding, with a single template: the Box of their board it lands in.' }
        : { type: 'string', description: 'During onboarding, with a single template: the division of their company it lands in, one or two English words like Sales. Picking the card builds it in a Box of that name.' }

    return {
        name: 'show_templates',
        description:
            'Show a ready-made template as a card, for a template the user asked for or arrived on. Never a spontaneous recommendation and never a catalog to browse: the coworker you propose is one you designed for them, read back with show_plan. Three cards at most, each with one line saying what it would do for them in their own week. Send a single one and it is shown full size, with its board and its apps drawn from the library itself, which is what someone arriving on a link should see; several are shown as rows to pick from. Set allow_custom to offer building something for them instead. They can always answer in words rather than picking.',
        inputSchema: {
            type: 'object',
            properties: {
                templates: {
                    type: 'array',
                    description: 'Three at most, in the order you would read them aloud.',
                    items: {
                        type: 'object',
                        properties: {
                            slug: { type: 'string', description: 'The slug list_templates gave you, unchanged.' },
                            title: { type: 'string' },
                            why: { type: 'string', description: 'One line about what it would do for this person. Not the tagline.' },
                            agents: { type: 'number', description: 'How many coworkers it installs.' },
                            connectors: { type: 'array', items: { type: 'string' }, description: 'Connector slugs it needs.' },
                        },
                        required: ['slug', 'title', 'why'],
                    },
                },
                allow_custom: { type: 'boolean', description: 'Offers a "Build something for me" card beside them.' },
                box,
            },
            required: ['templates'],
        },
    }
}

// The onboarding half of the belt: the gestes a first arrival needs, none of which the MCP server
// carries. They are dispatched onto what the app already does (the company reader, the users row,
// the template library, the installer), and handed out phase by phase.
export const FOREMAN_ONBOARDING_TOOL_DEFS = [
    {
        name: 'analyze_website',
        description:
            "Read a company website and come back with what it sells, to whom, and which industry it belongs to. Use it as soon as the user gives their site rather than making them describe their own company. A site that cannot be read is a normal outcome: carry on asking.",
        inputSchema: {
            type: 'object',
            properties: { url: { type: 'string', description: 'The address as the user gave it. A bare domain works.' } },
            required: ['url'],
        },
    },
    {
        name: 'save_profile',
        description:
            'Write down what you learned about this person and their company. Call it once you have the picture, not after every answer: it also closes the discovery step, names the workspace and is what lets you move on to proposing a team. Everything is optional, send what you actually know.',
        inputSchema: {
            type: 'object',
            properties: {
                first_name: { type: 'string' },
                company_url: { type: 'string' },
                company_name: { type: 'string' },
                company_description: { type: 'string' },
                company_offering: { type: 'string', description: 'What they sell.' },
                company_audience: { type: 'string', description: 'Who they sell it to.' },
                industry: { type: 'string', description: 'The category analyze_website returned. Leave it out rather than inventing one.' },
                position: { type: 'string', description: 'What the user does in the company, in their words.' },
                use_cases: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'The jobs they want taken off their plate, only when the user listed them unprompted, one entry per job, in their own words.',
                },
                pain: { type: 'string', description: 'Deprecated: the first entry of use_cases is written here for you. Leave it out.' },
                tools: { type: 'array', items: { type: 'string' }, description: 'Catalog slugs of the apps they named.' },
                language: { type: 'string', description: 'The language they are writing in, in English, e.g. French.' },
            },
        },
    },
    {
        name: 'list_templates',
        description:
            'Ready-made teams from the Rerun library, already included in the plan, for someone who asks for one. An installed template arrives with its SOUL, its skills and its schedules written. A team you build for someone is designed from what they told you, not picked in here: this is an answer to a request, never a first move. Filter by the industry you detected.',
        inputSchema: {
            type: 'object',
            properties: {
                category: { type: 'string', description: 'The industry category to favour, as returned by analyze_website.' },
                query: { type: 'string', description: 'Free text to match against titles and tags.' },
            },
        },
    },
    {
        name: 'install_template',
        description:
            'Install a library template into a Box: every captured coworker is copied in with its SOUL, skills and schedules. Needs a Box, so call create_boxes first when the board is empty. Read the answer: some coworkers can fail while others land, and coworkers beyond the plan limit arrive switched off.',
        inputSchema: {
            type: 'object',
            properties: { slug: { type: 'string' }, boxId: { type: 'string' } },
            required: ['slug', 'boxId'],
        },
    },
    {
        name: 'install_shared_agent',
        description:
            'Install the coworker behind a share link into a Box, with the SOUL, skills and schedules its sender froze into it. The token is the one the user arrived with. Needs a Box, so call create_boxes first when the board is empty, and read the answer: a coworker beyond the plan limit arrives switched off.',
        inputSchema: {
            type: 'object',
            properties: { token: { type: 'string' }, boxId: { type: 'string' } },
            required: ['token', 'boxId'],
        },
    },
    {
        name: 'start_agent_setup',
        description:
            'Hand the coworkers their own setup: each one gets your message in its own chat and starts working on it straight away, so the user watches their team ask for what it needs instead of being walked through one panel at a time. This is how a connector that came back unauthorized is finished: the coworker offers the app itself, with a card the user signs in from, and asks its own questions. It does not wait for them, so call it once with every coworker that still needs something, then say one line and let the user go through them. A coworker installed from a template plays the install its author wrote instead of your message. It answers with the conversationId and the runId it opened on each coworker, which is what a show_agents row takes to lead the user inside that conversation.',
        inputSchema: {
            type: 'object',
            properties: {
                agents: {
                    type: 'array',
                    description: 'One entry per coworker that still needs something from the user. Pass them all in a single call: they start together, which is the whole point.',
                    items: {
                        type: 'object',
                        properties: {
                            agentId: { type: 'string' },
                            message: {
                                type: 'string',
                                description: 'Addressed to the coworker, not to the user: what it has to get working, which apps it needs signed in, what to check. Tell it to offer those apps with suggest_service and to ask anything else with ask_user, never to ask for a secret in the chat.',
                            },
                        },
                        required: ['agentId', 'message'],
                    },
                },
            },
            required: ['agents'],
        },
    },
] as const

// Questions asked as a widget under the message rather than as a sentence. The browser renders
// them and answers with addToolResult, so the turn resumes on the answer itself: nothing has to be
// parsed back out of what the user typed, and the answer survives a reload inside the transcript.
export const FOREMAN_WIDGET_TOOL_DEFS = [
    {
        name: 'ask_choice',
        description:
            'Ask a question whose answer is one of a few known options, rendered as buttons under your message. Four options at most, a few words each, or six when you set multiple and the answers genuinely combine. The form carries a free field of its own, so the user can always answer something else. Reach for ask_input when no option can be named, never for a plain sentence, and never use either one to ask for a secret. It answers { answered: true, answers }, or { answered: false, reason }: "typed" when they answered in the composer instead, in the message right after the form; "dismissed" or "abandoned" when they left it aside.',
        inputSchema: {
            type: 'object',
            properties: {
                question: { type: 'string' },
                options: { type: 'array', items: { type: 'string' }, description: 'Two to four short answers, up to six with multiple. Order them the way you would read them aloud.' },
                multiple: { type: 'boolean', description: 'True to let them tick several options at once rather than pick exactly one. Only for answers that really combine: the form says "Select all that apply" and hands back every option they ticked. Defaults to false.' },
            },
            required: ['question', 'options'],
        },
    },
    {
        name: 'ask_either',
        description:
            'Ask a question with exactly two answers, drawn as a small card under your message: a title, one short line under it, and one button per answer. One click answers it. The card carries a "Neither" link of its own. It answers { answered: true, answers: [the button they clicked] }, or { answered: false, reason }: "neither" when they turned both answers down, so never keep, offer again or write down either of them; "typed" when they answered in the composer instead, in the message right after the card; "dismissed" or "abandoned" when they left it aside.',
        inputSchema: {
            type: 'object',
            properties: {
                title: { type: 'string', description: 'The question, eight words at most, in the words they would use themselves.' },
                description: { type: 'string', description: 'One short line under the title saying why you ask or what the answer decides. Fifteen words at most.' },
                options: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 2, description: 'The two answers, a few words each. Each one is the label of a button.' },
            },
            required: ['title', 'description', 'options'],
        },
    },
    {
        name: 'open_checkout',
        description:
            'Offer the plan as a card in the conversation: the free trial when the workspace never had one, billed today otherwise; what it costs them and whether a card is asked for is in your instructions. Call it once they have agreed, never to pressure them. It answers when the plan is really on, and it can also come back refused when the card has already been used for a trial, or dismissed. Nothing can be created before it answers ok.',
        inputSchema: { type: 'object', properties: {} },
    },
    {
        name: 'open_template_purchase',
        description: 'The card of a paid template, put up by the app once the plan is on and before the template is installed. It answers when the workspace owns the template. Never call it yourself.',
        inputSchema: { type: 'object', properties: {} },
    },
    {
        name: 'ask_input',
        description:
            'Ask for one short written answer, as a field under your message: a website address, a company name, a role, or the open version of a question whose two answers were both turned down. One question per call. Never for a password, an API key or anything secret. It answers like ask_choice.',
        inputSchema: {
            type: 'object',
            properties: { question: { type: 'string' } },
            required: ['question'],
        },
    },
    {
        name: 'contact_team',
        description:
            'Hand a stuck user to a person on the Rerun team, as a card under your message that they send with one click: the message lands in the support chat, under their account, and the team answers them there and by email. Nothing is sent before they click. Call it when you cannot get them through yourself: a second answer did not unblock them, the problem is something no answer of yours can fix (a form that will not go through, a button that is not there, a screen that froze, a bug), or they are upset or ask for a person. It answers sent once they sent it: then say in one line that the team has their message and will answer in the chat bubble and by email, and never offer it a second time. It answers unanswered when they kept typing instead.',
        inputSchema: {
            type: 'object',
            properties: {
                summary: {
                    type: 'string',
                    description:
                        'The message the team receives, written as the user, in the first person and in their language: what they were trying to do, what blocks them, and what was already tried. Three sentences at most, with the exact words they used for the blocker.',
                },
            },
            required: ['summary'],
        },
    },
    showTemplatesDef(),
    showPlanDef(ALL_PLAN_KINDS),
    {
        name: 'show_starter_pack',
        description: 'The starter pack of their industry, put up by the app right after the welcome card: a rail of coworker cards they pick up to three of, or a line saying what they need instead. Never call it yourself.',
        inputSchema: { type: 'object', properties: {} },
    },
] as const

export type ForemanWidgetToolName = (typeof FOREMAN_WIDGET_TOOL_DEFS)[number]['name']

export const FOREMAN_WIDGET_TOOL_NAMES = FOREMAN_WIDGET_TOOL_DEFS.map(def => def.name) as readonly ForemanWidgetToolName[]

export function isForemanWidgetTool(name: string): name is ForemanWidgetToolName {
    return (FOREMAN_WIDGET_TOOL_NAMES as readonly string[]).includes(name)
}

// The tools the foreman calls but the server cannot run: they open a panel or frame the board,
// which only exist in the browser. They are declared server-side without an `execute`, streamed to
// the client as a tool call, and resolved through the board store, the same actions the user drives
// with the mouse. The engine foreman hands them over as intents (./engine-brief).
export const FOREMAN_CLIENT_TOOL_DEFS = [
    {
        name: 'focus_agent',
        description: `Open a coworker panel in front of the user, on one of its tabs. It takes over their screen and covers your answer, so call it only when their message asked you to open or show that coworker or that tab. Never call it to show what you just did: that is a show_agents row, which they click when they want to. The tabs: ${describeTabs(AGENT_FOCUS_TABS, AGENT_TAB_LABELS, AGENT_TAB_HINTS)}.`,
        inputSchema: {
            type: 'object',
            properties: {
                agentId: { type: 'string' },
                tab: { type: 'string', enum: [...AGENT_FOCUS_TABS] },
                conversationId: {
                    type: 'string',
                    description:
                        'Only with `chat`: the conversation to land on, as start_agent_setup answered it for that coworker. Without it the chat opens on a new empty conversation, beside the one the coworker is already running.',
                },
                runId: { type: 'string', description: 'The run answered with that conversation, so the chat picks its stream up live rather than waiting for the transcript.' },
            },
            required: ['agentId', 'tab'],
        },
    },
    {
        name: 'show_agents',
        description:
            'Put a short list of coworkers under your message, each one a row the user clicks to open that coworker and bring the board onto it. This is how you show what you just did, for one coworker as for several: give the row the tab your work landed on, `skills` after writing a skill, `scheduled` after a scheduled task, `logs` when a run went wrong, and it opens there. Use it too whenever your answer names several coworkers, the ones plugged into an app, the ones in error, the ones of a Box, rather than writing their names out in prose. It only draws the list: nothing opens until the user clicks.',
        inputSchema: {
            type: 'object',
            properties: {
                agents: {
                    type: 'array',
                    minItems: 1,
                    items: {
                        type: 'object',
                        properties: {
                            agentId: { type: 'string' },
                            tab: { type: 'string', enum: [...AGENT_FOCUS_TABS], description: 'The tab the row opens on, named as in focus_agent. Without it the row only selects the coworker.' },
                            conversationId: { type: 'string', description: 'Only with `chat`: the conversation the row lands on, as start_agent_setup answered it for that coworker.' },
                            runId: { type: 'string', description: 'The run answered with that conversation, so the chat picks its stream up live.' },
                        },
                        required: ['agentId'],
                    },
                },
            },
            required: ['agents'],
        },
    },
    {
        name: 'open_settings',
        description: `Open one of the account panels in front of the user, over the board. Call it rather than describing where to click, whenever the answer lives in one of them: a question about the plan or the invoice, a teammate to invite, notifications to turn down, a key to issue. The panels: ${describeTabs(SETTINGS_PANELS, SETTINGS_PANEL_LABELS, SETTINGS_PANEL_HINTS)}. You only open them, you cannot change anything inside: the user sets it themselves, so say one line and wait rather than narrating the steps. The one exception is what coworkers run on, which you set yourself with update_agent and set_default_model; ai_providers is only where a subscription or a key is added, reconnected or removed.`,
        inputSchema: {
            type: 'object',
            properties: {
                panel: { type: 'string', enum: [...SETTINGS_PANELS] },
            },
            required: ['panel'],
        },
    },
    {
        name: 'open_connector_setup',
        description:
            'Leave under your message a row that leads to the Apps tab of a coworker, where the user connects a service themselves. This is the only way to finish a connector that needs a secret or an OAuth popup: attach_connector declares the app, but it cannot hold a credential. Call it right after attach_connector when the connector came back unauthorized, then tell them in one line to connect the app from that row. It counts as the Apps row of that coworker: do not add it again with show_agents. Nothing opens until they click, and never ask for the credential yourself.',
        inputSchema: {
            type: 'object',
            properties: {
                agentId: { type: 'string' },
                slug: { type: 'string', description: 'Catalog slug of the connector to point the user at.' },
            },
            required: ['agentId', 'slug'],
        },
    },
    {
        name: 'open_template_card',
        description:
            'Open the full card of a template in front of the user, with its coworkers, its apps and its install button. Use it for a template you cannot install yourself: a paid one, which install_template refuses on purpose, or one the user asked to read in detail before deciding.',
        inputSchema: {
            type: 'object',
            properties: { slug: { type: 'string', description: 'Slug of the template to open.' } },
            required: ['slug'],
        },
    },
    {
        name: 'recenter_board',
        description:
            'Frame the board on everything it holds, the view the recenter button in the corner of the canvas gives. The user keeps the framing they left off at, so a workspace that just grew leaves them zoomed in on a corner of it: call this once the Boxes of an organisation are laid out, after creating a coworker outside the part of the board they are looking at, and whenever they say they cannot find something on it. It moves the camera and nothing else.',
        inputSchema: { type: 'object', properties: {} },
    },
    {
        name: 'open_brain_page',
        description:
            'Open the company brain in front of the user, over the board: on a page, by its slug, once you wrote it or when they ask to see it; on the changes the coworkers proposed, with proposals set to true; on the company card with neither. It only shows the brain, it changes nothing in it.',
        inputSchema: {
            type: 'object',
            properties: {
                slug: { type: 'string', description: 'Slug of the brain page to show.' },
                proposals: { type: 'boolean', description: 'Show the changes waiting for review instead of a page.' },
            },
        },
    },
] as const

export type ForemanClientToolName = (typeof FOREMAN_CLIENT_TOOL_DEFS)[number]['name']

export const FOREMAN_CLIENT_TOOL_NAMES = FOREMAN_CLIENT_TOOL_DEFS.map(def => def.name) as readonly ForemanClientToolName[]

export function isForemanClientTool(name: string): name is ForemanClientToolName {
    return (FOREMAN_CLIENT_TOOL_NAMES as readonly string[]).includes(name)
}

export function accountToolDef(name: string): ForemanToolDef {
    const def = ACCOUNT_TOOL_DEFS.find(entry => entry.name === name)
    if (!def) throw new Error(`Unknown account tool: ${name}`)
    return def
}

// The hub foreman only walks the onboarding: getting to know them, the plan, the trial. Everything
// that acts on the workspace is the engine foreman's, once the build has claimed the machine.
const HUB_ONBOARDING_TOOL_NAMES = ['analyze_website', 'save_profile'] as const
const HUB_CLIENT_TOOL_NAMES = ['open_template_card'] as const

export const FOREMAN_TOOL_DEFS: ForemanToolDef[] = [
    ...FOREMAN_DOCS_TOOL_DEFS,
    ...FOREMAN_ONBOARDING_TOOL_DEFS.filter(def => (HUB_ONBOARDING_TOOL_NAMES as readonly string[]).includes(def.name)),
    ...FOREMAN_WIDGET_TOOL_DEFS,
    ...FOREMAN_CLIENT_TOOL_DEFS.filter(def => (HUB_CLIENT_TOOL_NAMES as readonly string[]).includes(def.name)),
]

// Every name the hub belt can hold, as a union: a phase that lists a tool under a name nobody
// declares stops compiling instead of quietly handing the model a shorter belt than it reads about.
export type ForemanToolName = (typeof FOREMAN_DOCS_TOOL_DEFS)[number]['name'] | (typeof HUB_ONBOARDING_TOOL_NAMES)[number] | ForemanWidgetToolName | (typeof HUB_CLIENT_TOOL_NAMES)[number]

export const FOREMAN_TOOL_NAMES = FOREMAN_TOOL_DEFS.map(def => def.name) as readonly ForemanToolName[]
