import { SHARE_TOOL_DEFS } from './share-tools'
import { TEMPLATE_TOOL_DEFS } from './template-tools'

export const MAX_MEMORIES_PER_CALL = 100
export const MAX_MEMORY_CHARS = 20_000
export const MAX_UPLOAD_MB = 5

// Static MCP tool definitions advertised by the Rerun account server for `tools/list`.
// Pure data (no server deps) so the route can serve them without importing the service layer.
//
// Audience: an AI coding agent (Claude Code and friends) configuring a Rerun account from
// outside the app. The surface covers shaping an agent — prompt, skills, scheduled tasks,
// webhook triggers, connectors, private database — and checking what it did: send_message and
// the run tools exist so an agent can be tested without first inventing a routine for it.
//
// Descriptions are the only documentation the calling model gets, so anything surprising
// (what a field really promises, what a call leaves behind) belongs here rather than in a
// comment it will never read.
// Same shape as the `setup` field of capture_template_agents, on purpose: an agent written from
// here and an agent captured into a template answer the same question in the same words.
const SETUP_PROPERTY = {
    type: 'object',
    description:
        'The guided setup this coworker runs on the account of whoever installs it, and the answer a template cannot be submitted without. `required: false` means it works out of the box; `required: true` means the copy opens on a "Start installation" button and runs `prompt` on its own to walk its new owner through the setup. Answering here also marks the setup done for this agent: you are its author, so it never installs itself.',
    properties: {
        required: { type: 'boolean' },
        prompt: { type: 'string', description: 'Addressed to the coworker, not to the user: what to check, what to ask for with ask_user, what to test. Required when `required` is true, and erased when it is false.' },
    },
    required: ['required'],
} as const

// Which AI connection and model a coworker runs on, the same three fields at creation and on an
// update. `connectionId` is the one that names a subscription: two Claude accounts are both
// `claude`, and only the id tells them apart.
const MODEL_PIN_PROPERTIES = {
    connectionId: {
        type: 'string',
        description:
            'The AI connection (a subscription or an API key) to run on, by its id from list_ai_connections. This is how you pick one account among several of the same provider. It is checked: an unknown id, a connection that is not signed in or a model it does not serve is refused with what is available.',
    },
    provider: {
        type: 'string',
        description:
            'rerun | anthropic | claude | codex | openai | google | openrouter | opencode | custom. A shortcut for `connectionId` that only works while the workspace has a single connection of that provider; with several, the call is refused and lists them. It replaces whatever connection the coworker was pinned to.',
    },
    model: {
        type: ['string', 'null'],
        description:
            'A model the connection serves, as list_ai_connections spells it. Omit it at creation and the coworker runs the workspace default model, following it whenever that default changes. Pass null to go back to that after pinning one: it also drops the pinned connection. On the `rerun` provider: rerun-max. On `opencode` the id carries its catalog: `go/…` is paid by the Go plan, `console/…` by the account credits.',
    },
} as const

// The same pin on a scheduled task or a trigger, where picking nothing means following the coworker.
const AUTOMATION_MODEL_PIN_PROPERTIES = {
    connectionId: { type: 'string', description: 'Run this one on a given AI connection, by its id from list_ai_connections, instead of the one its coworker runs on. Goes with `model`.' },
    model: { type: ['string', 'null'], description: 'Run this one on a model of its own. Omit it and it runs whatever its coworker runs, following it when that changes. Pass null to go back to that.' },
} as const

const AGENT_TOOL_DEFS = [
    {
        name: 'list_spaces',
        description: 'List the Boxes of the account. A Box groups the coworkers of one team, client or project. Call this first when you need a spaceId to create a coworker.',
        inputSchema: { type: 'object', properties: {} },
    },
    {
        name: 'list_agents',
        description: 'List the coworkers of the account: id, display name, handle (the mention/call key), description and Box. The id returned here is what every other tool takes as agentId.',
        inputSchema: {
            type: 'object',
            properties: { spaceId: { type: 'string', description: 'Optional: restrict to one Box.' } },
        },
    },
    {
        name: 'get_team_status',
        description:
            'What each coworker is doing right now, read from the machine at the moment of the call (the status list_agents carries can be stale). For each: `status` (working, waiting_human, error, idle, offline, switched_off, unconfigured), the runs in flight with their trigger, start and step count, the conversations waiting on a person (an approval, a question, a connector to sign in), and the last run that ended, with its error when it failed. Call this to answer who is working, what is blocked or who is in error.',
        inputSchema: {
            type: 'object',
            properties: {
                spaceId: { type: 'string', description: 'Optional: restrict to one Box.' },
                agentId: { type: 'string', description: 'Optional: restrict to one coworker.' },
            },
        },
    },
    {
        name: 'get_agent',
        description:
            'Full picture of one coworker in a single call: its SOUL (the system prompt that defines who it is), what it runs on (`runsOn`: the AI connection, provider and model it resolves to, and whether it follows the workspace default), enabled tool families, custom MCP servers, its guided-setup answer with the install instructions behind it, plus the list of its skills, scheduled tasks and apps. Skills and scheduled tasks are summarised here — use get_skill and list_schedules for their full text. A part the Box could not read comes back empty (`runsOn` keeps its provider and model but loses `connectionName`) and is named in `unavailable` (e.g. ["schedules"]): only a list absent from it is really empty. Read this before changing anything.',
        inputSchema: {
            type: 'object',
            properties: { agentId: { type: 'string' } },
            required: ['agentId'],
        },
    },
    {
        name: 'create_agent',
        description:
            'Create a coworker. `soul` is its system prompt in markdown — who it is, what it owns, how it works — and it is the single most important field, so write it properly rather than leaving it empty. Model, tool families and self-improvement flags can be set here, in one call: a coworker created with defaults may rewrite its own prompt and install its own tools, so pass selfImprovement explicitly when that is not what you want. The coworker is placed on the account board and is immediately visible in the app.',
        inputSchema: {
            type: 'object',
            properties: {
                name: { type: 'string', description: 'Free display name, e.g. "Content Manager".' },
                description: { type: 'string', description: 'One line on what this coworker is for.' },
                soul: { type: 'string', description: 'The coworker system prompt, in markdown.' },
                spaceId: { type: 'string', description: 'Optional when the account has a single Box.' },
                connectors: { type: 'array', items: { type: 'string' }, description: 'Optional catalog slugs to declare on the coworker (see attach_connector). The response gives each one its real status.' },
                ...MODEL_PIN_PROPERTIES,
                verbosity: { type: 'string', description: 'How long its answers to the user are: minimal | concise | normal | detailed. Defaults to normal, the model native behaviour. It shapes the prose only, never how much work the coworker does.' },
                tools: { type: 'object', description: 'Capability families, all on by default, e.g. {"shell": false, "browser": false}.', additionalProperties: { type: 'boolean' } },
                selfImprovement: {
                    type: 'object',
                    description: 'Defaults to everything on. {"allowSoulEdit": false, "allowToolInstall": false} pins the coworker to the prompt and tools you gave it.',
                    additionalProperties: { type: 'boolean' },
                },
                setup: SETUP_PROPERTY,
            },
            required: ['name'],
        },
    },
    {
        name: 'update_agent',
        description:
            'Update a coworker. Every field is optional and only what you pass is changed. Use `soul` to rewrite its prompt, `tools` to toggle capability families (e.g. {"browser": false}). To change what it runs on, read list_ai_connections first and pass `connectionId` with `model`; the response then carries `runsOn`, the connection and model it really resolves to, which is what to report. Renaming moves the handle too: it is re-derived from the new `name`, and every @oldhandle written into the other coworkers (souls, skills, scheduled tasks, memories) is rewritten to the new one. Pass `handle` only to set a call key that differs from the name. Pass `spaceId` to move the coworker to another Box.',
        inputSchema: {
            type: 'object',
            properties: {
                agentId: { type: 'string' },
                spaceId: {
                    type: 'string',
                    description:
                        'Move the coworker to this Box. A Box is a rectangle on the account board, not a machine: the coworker keeps its files, its handle, its skills and its history. It lands on the first free cell of that Box.',
                },
                name: { type: 'string', description: 'New display name. The handle is re-derived from it and @mentions of the old handle are rewritten.' },
                handle: { type: 'string', description: 'The mention / call key, when it should differ from the one derived from the name. Existing @handle references are rewritten.' },
                description: { type: 'string' },
                soul: { type: 'string', description: 'Full replacement of the system prompt, in markdown.' },
                ...MODEL_PIN_PROPERTIES,
                verbosity: { type: 'string', description: 'How long its answers to the user are: minimal | concise | normal | detailed. Defaults to normal, the model native behaviour. It shapes the prose only, never how much work the coworker does.' },
                tools: { type: 'object', description: 'Capability families to toggle, e.g. {"shell": false, "browser": true}.', additionalProperties: { type: 'boolean' } },
                selfImprovement: { type: 'object', description: 'e.g. {"allowSoulEdit": false}.', additionalProperties: { type: 'boolean' } },
                setup: SETUP_PROPERTY,
            },
            required: ['agentId'],
        },
    },
    {
        name: 'list_ai_connections',
        description:
            'The AI connections of the workspace, which is what every coworker runs on: the subscriptions (Claude, ChatGPT, OpenCode) and API keys plugged into it, plus the keyless Rerun one. For each: its `id`, the name the user gave it (often the account email), its provider, the models it serves, whether it is signed in, and whether it holds the workspace default. `default` is the connection and model every coworker that picked nothing runs on. Read this before changing what a coworker runs on, and whenever the user names a subscription or an account: the id is the only way to tell two accounts of the same provider apart. Connections are added and removed by the user, in AI providers.',
        inputSchema: { type: 'object', properties: {} },
    },
    {
        name: 'set_default_model',
        description:
            'Set the workspace default: the AI connection and model every coworker that picked no model of its own runs on, along with their scheduled tasks and triggers. It moves all of them at once, and with them which account is billed, so say which coworkers follow the default before calling it when the user asked about a few of them only. A coworker pinned to a model of its own is not touched: pass model null to update_agent to put it back on the default. The pair is checked the same way as on update_agent.',
        inputSchema: {
            type: 'object',
            properties: {
                connectionId: { type: 'string', description: 'The id of the connection, from list_ai_connections.' },
                model: { type: 'string', description: 'A model that connection serves.' },
            },
            required: ['connectionId', 'model'],
        },
    },
    {
        name: 'delete_agent',
        description: 'Permanently delete a coworker, with its skills, scheduled tasks, memory and workspace files. Irreversible. Requires confirm: true.',
        inputSchema: {
            type: 'object',
            properties: { agentId: { type: 'string' }, confirm: { type: 'boolean' } },
            required: ['agentId', 'confirm'],
        },
    },

    {
        name: 'list_skills',
        description:
            'List a coworker skills: slug, name, description and the paths of the reference files each one carries. A skill is a procedure the coworker loads on demand when the task matches its description. A skill an app installed comes back flagged `readOnly` with its `connector`: it belongs to that app and can only change by reconfiguring it.',
        inputSchema: {
            type: 'object',
            properties: { agentId: { type: 'string' } },
            required: ['agentId'],
        },
    },
    {
        name: 'get_skill',
        description:
            'Read one skill in full: its body, plus every reference file it carries with its size in bytes. The files content is not included — read one with read_skill_file when the body points at it.',
        inputSchema: {
            type: 'object',
            properties: { agentId: { type: 'string' }, slug: { type: 'string' } },
            required: ['agentId', 'slug'],
        },
    },
    {
        name: 'read_skill_file',
        description:
            'Read one 100,000-character page of a reference file bundled with a skill, e.g. references/format.md. One file per call: get_skill lists what a skill carries, this returns the requested page and nextOffset when more remains. Read before rewriting it through upsert_skill, since that call replaces a file whole.',
        inputSchema: {
            type: 'object',
            properties: {
                agentId: { type: 'string' },
                slug: { type: 'string' },
                path: { type: 'string', description: 'Path of the file inside the skill folder, as returned by get_skill.' },
                offset: { type: 'integer', minimum: 0, description: 'Character offset to start at. Omit or pass 0 for the first page; use nextOffset to continue.' },
            },
            required: ['agentId', 'slug', 'path'],
        },
    },
    {
        name: 'upsert_skill',
        description:
            'Create a skill, or replace it when one with the same name already exists. `description` is what makes the coworker decide to load the skill, so state when to use it. `body` is the markdown procedure. `files` adds or replaces reference documents the skill body can point to, which keeps the body short; a file already on the skill and not listed again is kept, and `removeFiles` is how one goes away. The body and `files` are written in one atomic swap; `removeFiles` runs after it, so a failed deletion leaves that file behind. Pass `slug` (from list_skills) to update a skill whose name you are also changing — without it, a new name creates a second skill. A skill an app installed is refused, by slug or by a name that lands on it: reconfigure the app instead.',
        inputSchema: {
            type: 'object',
            properties: {
                agentId: { type: 'string' },
                name: { type: 'string' },
                slug: { type: 'string', description: 'Existing skill to update, when the name is changing too.' },
                description: { type: 'string', description: 'When the coworker should reach for this skill.' },
                body: { type: 'string', description: 'The procedure, in markdown.' },
                files: {
                    type: 'array',
                    description: 'Optional reference files, e.g. [{"path": "references/api.md", "content": "…"}]. A file is written whole, so read_skill_file first when editing one.',
                    items: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
                },
                removeFiles: {
                    type: 'array',
                    description: 'Reference files to delete from the skill, e.g. ["references/old.md"]. Applied once the skill itself is written.',
                    items: { type: 'string' },
                },
            },
            required: ['agentId', 'name', 'body'],
        },
    },
    {
        name: 'write_memory',
        description: `Add memories to a coworker: what it knows about its owner, their preferences, facts it learned. Each entry is one memory, indexed for recall. Up to ${MAX_MEMORIES_PER_CALL} entries per call and ${MAX_MEMORY_CHARS.toLocaleString('en-US')} characters each; split a long memory file into one entry per fact or section, and call again for more. Entries that fail are listed in \`failed\` with the reason, the others are kept.`,
        inputSchema: {
            type: 'object',
            properties: {
                agentId: { type: 'string' },
                memories: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            content: { type: 'string', description: 'The memory, in plain text or markdown.' },
                            kind: { type: 'string', description: 'preference | fact | learned | note | task. Defaults to note.' },
                            tags: { type: 'array', items: { type: 'string' } },
                        },
                        required: ['content'],
                    },
                },
            },
            required: ['agentId', 'memories'],
        },
    },
    {
        name: 'upload_workspace_file',
        description: `Write one file into the coworker's own workspace folder, creating the folders on the way and replacing a file already at that path. \`path\` is relative to the workspace, e.g. "notes/clients.md". Text goes as is (encoding utf8, the default); a binary file goes base64-encoded with encoding base64. Up to ${MAX_UPLOAD_MB} MB either way, once decoded. One file per call.`,
        inputSchema: {
            type: 'object',
            properties: {
                agentId: { type: 'string' },
                path: { type: 'string' },
                content: { type: 'string' },
                encoding: { type: 'string', enum: ['utf8', 'base64'] },
            },
            required: ['agentId', 'path', 'content'],
        },
    },
    {
        name: 'delete_skill',
        description: "Delete a skill and its files. Requires confirm: true. An app's own skill is refused: uninstall that app to remove it.",
        inputSchema: {
            type: 'object',
            properties: { agentId: { type: 'string' }, slug: { type: 'string' }, confirm: { type: 'boolean' } },
            required: ['agentId', 'slug', 'confirm'],
        },
    },

    {
        name: 'list_schedules',
        description:
            'List a coworker scheduled tasks in full: slug, name, `body` (the instruction the coworker receives when it fires), cron or one-off date, timezone, the connection and model of its own when it has one (null means it follows its coworker), enabled state and last run. This is the way to audit what an existing scheduled task actually does.',
        inputSchema: {
            type: 'object',
            properties: { agentId: { type: 'string' } },
            required: ['agentId'],
        },
    },
    {
        name: 'upsert_schedule',
        description:
            'Create a scheduled task, or update it when `slug` is given. `body` is the instruction the coworker receives when it fires, written as if you were talking to it. Pass `cron` for a recurring task (5-field cron) or `runAt` for a one-off ISO date. It runs on whatever its coworker runs unless you pass `model` (and `connectionId`) to give it a model of its own. Three things to know: passing `body` on an update replaces the whole instruction, so read the current one with list_schedules and edit that text — never write a body from memory; the slug is derived from the name and is what run_schedule_now and delete_schedule address, so read it back from the response; and an update can change a cron but cannot clear it nor turn a recurring task into a one-off — delete and recreate for that.',
        inputSchema: {
            type: 'object',
            properties: {
                agentId: { type: 'string' },
                slug: { type: 'string', description: 'Omit to create, pass an existing slug to update.' },
                name: { type: 'string' },
                description: { type: 'string' },
                body: { type: 'string', description: 'The instruction sent to the coworker when the task fires.' },
                cron: { type: 'string', description: 'e.g. "0 9 * * 1" for every Monday at 9.' },
                runAt: { type: 'string', description: 'ISO date for a one-off run.' },
                timezone: { type: 'string', description: 'IANA timezone, e.g. "Europe/Paris".' },
                enabled: { type: 'boolean' },
                ...AUTOMATION_MODEL_PIN_PROPERTIES,
            },
            required: ['agentId'],
        },
    },
    {
        name: 'run_schedule_now',
        description:
            'Fire a scheduled task immediately, without waiting for its cron. Works on a disabled task too, and does not enable it or touch its last-run date, so it is safe for testing an instruction before putting the task live. Returns a runId — read the outcome with get_run.',
        inputSchema: {
            type: 'object',
            properties: { agentId: { type: 'string' }, slug: { type: 'string' } },
            required: ['agentId', 'slug'],
        },
    },
    {
        name: 'delete_schedule',
        description: 'Delete a scheduled task. Requires confirm: true.',
        inputSchema: {
            type: 'object',
            properties: { agentId: { type: 'string' }, slug: { type: 'string' }, confirm: { type: 'boolean' } },
            required: ['agentId', 'slug', 'confirm'],
        },
    },

    {
        name: 'list_triggers',
        description:
            'List a coworker webhook triggers in full: slug, name, `body` (the instruction the coworker receives when the URL is called), accepted HTTP methods, enabled state, the connection and model of its own when it has one (null means it follows its coworker), how many times it fired, and `url`, the public webhook address to paste into the other service. That URL carries the secret, so treat every one of them as a credential.',
        inputSchema: {
            type: 'object',
            properties: { agentId: { type: 'string' } },
            required: ['agentId'],
        },
    },
    {
        name: 'upsert_trigger',
        description:
            'Create a webhook trigger, or update it when `slug` is given. It gives the coworker a public URL: whoever calls it starts a run. `body` is the instruction the coworker receives, and the caller HTTP payload is appended to it automatically inside a <trigger_payload> block, so write the instruction as "a Stripe refund event arrives, do X with it", not as if the payload had to be fetched. `methods` defaults to POST alone. The response carries the full `url`, which is a secret: anyone holding it can fire the coworker. Three things to know: passing `body` on an update replaces the whole instruction, so read the current one with list_triggers and edit that text — never write a body from memory; the slug is derived from the name and is what test_trigger, rotate_trigger_token and delete_trigger address, so read it back from the response; and a trigger cannot be renamed, because the public URL is built from the slug, so delete and recreate, knowing the URL changes.',
        inputSchema: {
            type: 'object',
            properties: {
                agentId: { type: 'string' },
                slug: { type: 'string', description: 'Omit to create, pass an existing slug to update.' },
                name: { type: 'string' },
                description: { type: 'string' },
                body: { type: 'string', description: 'The instruction sent to the coworker when the URL is called.' },
                methods: {
                    type: 'array',
                    description: 'Accepted HTTP methods, e.g. ["POST"]. Defaults to ["POST"].',
                    items: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
                },
                enabled: { type: 'boolean' },
                ...AUTOMATION_MODEL_PIN_PROPERTIES,
            },
            required: ['agentId'],
        },
    },
    {
        name: 'test_trigger',
        description:
            'Fire a trigger yourself with a sample payload, to check the instruction before handing the URL to another service. Returns a runId, and get_run reads the outcome. This is a real fire, not a dry run: it counts towards the trigger fire count and updates its last-fired date. It also needs the trigger to be enabled. Unlike run_schedule_now, firing a disabled trigger fails, because the engine answers a disabled trigger exactly like a missing one.',
        inputSchema: {
            type: 'object',
            properties: {
                agentId: { type: 'string' },
                slug: { type: 'string' },
                body: { type: ['string', 'object'], description: 'The payload. An object is sent as JSON. Defaults to empty.' },
                method: { type: 'string', description: 'Defaults to the first method the trigger accepts.', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
                query: { type: 'string', description: 'Query string to simulate, without the leading "?".' },
                contentType: { type: 'string', description: 'Defaults to application/json when the body is JSON.' },
            },
            required: ['agentId', 'slug'],
        },
    },
    {
        name: 'rotate_trigger_token',
        description: 'Issue a new secret for a trigger and return its new URL. The previous URL stops working immediately, so every service already configured with it has to be updated. Use this when a URL has leaked.',
        inputSchema: {
            type: 'object',
            properties: { agentId: { type: 'string' }, slug: { type: 'string' } },
            required: ['agentId', 'slug'],
        },
    },
    {
        name: 'delete_trigger',
        description: 'Delete a webhook trigger. Its URL stops working at once and any service calling it starts failing. Requires confirm: true.',
        inputSchema: {
            type: 'object',
            properties: { agentId: { type: 'string' }, slug: { type: 'string' }, confirm: { type: 'boolean' } },
            required: ['agentId', 'slug', 'confirm'],
        },
    },

    {
        name: 'send_message',
        description:
            'Talk to a coworker and get its answer. This is how you test an agent: no scheduled task needed. The call waits up to `waitSeconds` for the run to finish and returns the final text; if the coworker is still working when that runs out it returns status "running" with a runId, and the run carries on — poll get_run for the result. Pass `sessionId` to continue an earlier conversation instead of starting a fresh one.',
        inputSchema: {
            type: 'object',
            properties: {
                agentId: { type: 'string' },
                message: { type: 'string' },
                sessionId: { type: 'string', description: 'Continue this conversation. Omit to start a new one.' },
                waitSeconds: { type: 'number', description: 'How long to wait for the answer. Default 120, max 600.' },
            },
            required: ['agentId', 'message'],
        },
    },
    {
        name: 'list_runs',
        description: 'Recent executions of a coworker, newest first: status, what triggered them, model, tokens, cost and error. Use it to see whether a scheduled task or a message actually did anything.',
        inputSchema: {
            type: 'object',
            properties: { agentId: { type: 'string' }, limit: { type: 'number', description: 'Default 20, max 200.' } },
            required: ['agentId'],
        },
    },
    {
        name: 'get_run',
        description: 'One execution: its final output, status, error, token usage and cost. Set includeToolCalls to also get every tool the coworker called with its input and result, which is what you read when the output is not what you expected. Each input and result is cut at 2,000 characters with a [truncated] marker: a preview to diagnose from, not the full payload.',
        inputSchema: {
            type: 'object',
            properties: { agentId: { type: 'string' }, runId: { type: 'string' }, includeToolCalls: { type: 'boolean' } },
            required: ['agentId', 'runId'],
        },
    },

    {
        name: 'list_tables',
        description:
            'Structure of the coworker private database: every table with its columns, SQLite types, primary keys and not-null flags. Each coworker has exactly one private database, persistent across runs, and no other coworker can read it. The workspace has a separate database every one of its coworkers shares: see list_space_tables.',
        inputSchema: {
            type: 'object',
            properties: { agentId: { type: 'string' } },
            required: ['agentId'],
        },
    },
    {
        name: 'db_query',
        description: 'Run a read-only SELECT against the coworker private database and get the rows back. Use ? placeholders with `params` rather than pasting values into the SQL. Anything that writes is refused here — use db_execute.',
        inputSchema: {
            type: 'object',
            properties: {
                agentId: { type: 'string' },
                sql: { type: 'string', description: 'A single SELECT (or WITH … SELECT).' },
                params: { type: 'array', description: 'Values bound to the ? placeholders, in order.', items: {} },
                limit: { type: 'number', description: 'Max rows returned. Default 100, max 1000.' },
            },
            required: ['agentId', 'sql'],
        },
    },
    {
        name: 'db_execute',
        description:
            'Change the coworker private database: CREATE / ALTER / DROP a table, or INSERT / UPDATE / DELETE rows. This is how you give a coworker its tables up front instead of hoping it creates them on its first run. Pass one `sql` statement, or `statements` to run several atomically in a single transaction (the right way to lay out a schema). It is plain SQLite, so column types are TEXT, INTEGER, REAL, BLOB or NUMERIC.',
        inputSchema: {
            type: 'object',
            properties: {
                agentId: { type: 'string' },
                sql: { type: 'string', description: 'A single statement.' },
                params: { type: 'array', description: 'Values bound to the ? placeholders in sql, in order.', items: {} },
                statements: {
                    type: 'array',
                    description: 'Several statements applied atomically, e.g. a whole schema.',
                    items: { type: 'object', properties: { sql: { type: 'string' }, params: { type: 'array', items: {} } }, required: ['sql'] },
                },
            },
            required: ['agentId'],
        },
    },

    {
        name: 'list_space_tables',
        description:
            'Structure of the database shared by every coworker of the workspace: every table with its columns, SQLite types, primary keys and not-null flags. It is separate from each coworker private database, and every coworker reads and writes it. Get the spaceId from list_spaces.',
        inputSchema: {
            type: 'object',
            properties: { spaceId: { type: 'string' } },
            required: ['spaceId'],
        },
    },
    {
        name: 'space_db_query',
        description: 'Run a read-only SELECT against the database shared by every coworker of the workspace and get the rows back. Use ? placeholders with `params` rather than pasting values into the SQL. Anything that writes is refused here — use space_db_execute.',
        inputSchema: {
            type: 'object',
            properties: {
                spaceId: { type: 'string' },
                sql: { type: 'string', description: 'A single SELECT (or WITH … SELECT).' },
                params: { type: 'array', description: 'Values bound to the ? placeholders, in order.', items: {} },
                limit: { type: 'number', description: 'Max rows returned. Default 100, max 1000.' },
            },
            required: ['spaceId', 'sql'],
        },
    },
    {
        name: 'space_db_execute',
        description:
            'Change the database shared by every coworker of the workspace: CREATE / ALTER / DROP a table, or INSERT / UPDATE / DELETE rows. This is how you lay out the common tables a group of coworkers works from, before any of them runs. Every coworker sees the result immediately, so prefer CREATE TABLE IF NOT EXISTS and do not drop a table the coworkers already fill. Pass one `sql` statement, or `statements` to run several atomically in a single transaction. It is plain SQLite, so column types are TEXT, INTEGER, REAL, BLOB or NUMERIC.',
        inputSchema: {
            type: 'object',
            properties: {
                spaceId: { type: 'string' },
                sql: { type: 'string', description: 'A single statement.' },
                params: { type: 'array', description: 'Values bound to the ? placeholders in sql, in order.', items: {} },
                statements: {
                    type: 'array',
                    description: 'Several statements applied atomically, e.g. a whole schema.',
                    items: { type: 'object', properties: { sql: { type: 'string' }, params: { type: 'array', items: {} } }, required: ['sql'] },
                },
            },
            required: ['spaceId'],
        },
    },

    {
        name: 'search_connectors',
        description:
            'Semantic search over the Rerun app library (Stripe, Gmail, Notion, Slack, …) — the ready-made integrations a coworker can be given. Describe the capability in natural language ("send emails", "read a CRM") and use the returned slug with attach_connector. `setup` tells you what declaring it will actually leave behind: "active" (works straight away), "needs_auth" (waiting for a sign-in) or "needs_config" (waiting for a credential, or for the owner to pick between several ways to connect). This search returns the best matches only — use list_connectors when you need to know whether something exists at all.',
        inputSchema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Natural-language description of the capability needed.' },
                category: { type: 'string', description: 'Optional category filter.' },
            },
        },
    },
    {
        name: 'list_connectors',
        description: 'Walk the whole app library page by page, in a stable order. Use it to prove an app is absent, which a semantic search can never do, or to see what a category holds. Returns `total` so you know when you are done.',
        inputSchema: {
            type: 'object',
            properties: {
                category: { type: 'string', description: 'Optional category filter.' },
                limit: { type: 'number', description: 'Default 60, max 200.' },
                offset: { type: 'number', description: 'Default 0.' },
            },
        },
    },
    {
        name: 'list_agent_connectors',
        description:
            'List the apps declared on a coworker with their status: "active" (ready to use), "needs_config" (waiting for credentials) or "needs_auth" (waiting for a sign-in). An app can be connected several times, one account each: every row carries its `key` (the bare slug for the first account, `slug@id` for the others) and the `label` that tells the accounts apart.',
        inputSchema: {
            type: 'object',
            properties: { agentId: { type: 'string' } },
            required: ['agentId'],
        },
    },
    {
        name: 'attach_connector',
        description:
            'Declare an app on a coworker. When the app needs no credentials and no sign-in it is installed right away; otherwise it is recorded as pending and the account owner finishes the connection from the Rerun app, where the sign-in and the credential form live. The returned `status` is the truth, whatever the catalog suggested, and `key` names the account it declared. NEVER ask anyone for an API key, a password or a token: this tool takes no secret, by design. Declaring an app on a coworker that will become a template is exactly the intended use — the person installing the template connects their own account.',
        inputSchema: {
            type: 'object',
            properties: {
                agentId: { type: 'string' },
                slug: { type: 'string', description: 'Catalog slug, from search_connectors.' },
                newInstance: { type: 'boolean', description: 'Add another account of an app that supports several; ignored otherwise.' },
            },
            required: ['agentId', 'slug'],
        },
    },
    {
        name: 'detach_connector',
        description: 'Remove an app account from an agent: its tools, its credentials and the skill it installed. Pass the `key` from list_agent_connectors to target one account of an app connected several times. Requires confirm: true.',
        inputSchema: {
            type: 'object',
            properties: {
                agentId: { type: 'string' },
                key: { type: 'string', description: 'Account key from list_agent_connectors, e.g. gmail@k3x9ab.' },
                slug: { type: 'string', description: 'Catalog slug, removes the first account of the app.' },
                confirm: { type: 'boolean' },
            },
            required: ['agentId', 'confirm'],
        },
    },
] as const

// The sharing and template halves are declared next door: same server, same key, and this file was
// already long enough. Sharing sits between the two because it acts on the agents of any account,
// where the template tools need an expert sandbox.
export const ACCOUNT_TOOL_DEFS = [...AGENT_TOOL_DEFS, ...SHARE_TOOL_DEFS, ...TEMPLATE_TOOL_DEFS]

export const ACCOUNT_TOOL_NAMES = ACCOUNT_TOOL_DEFS.map(t => t.name)
