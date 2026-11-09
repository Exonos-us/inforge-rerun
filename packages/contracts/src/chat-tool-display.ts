import { capabilityOfCall, PAID_DATA_TOOL, paidDataEntry } from './paid-data.js'

// What a tool call reads as in the chat's steps, the same on every client: each one draws its own
// icon beside it.
const TOOL_LABELS: Record<string, string> = {
    shell_exec: 'Terminal',

    fs_read: 'Read File',
    fs_write: 'Write File',
    fs_edit: 'Edit File',
    fs_list: 'List Files',
    fs_search: 'Search Files',

    shared_read: 'Read Shared File',
    shared_write: 'Write Shared File',
    shared_edit: 'Edit Shared File',
    shared_list: 'List Shared Files',
    shared_search: 'Search Shared Files',

    browser_navigate: 'Browse Web',
    computer: 'Used its computer',
    computer_open_app: 'Opened an app',
    web_fetch: 'Fetch Page',
    web_search: 'Web Search',
    WebSearch: 'Web Search',
    leads_people_search: 'Find People',
    leads_email_find: 'Find Email',
    leads_email_verify: 'Verify Email',
    leads_phone_find: 'Find Phone',
    google_serp: 'Google Results',
    google_maps_search: 'Google Maps',
    paid_data: 'Paid data',
    paid_data_catalog: 'Paid data catalog',
    paid_data_read: 'Read paid data',
    download: 'Download',

    memory_write: 'Save to Memory',
    memory_recall: 'Recall Memory',
    brain_search: 'Search the Brain',
    brain_read: 'Read the Brain',
    brain_propose: 'Propose to the Brain',
    brain_write: 'Write to the Brain',
    brain_delete: 'Remove from the Brain',
    brain_proposals: 'Review Brain changes',
    brain_decide: 'Decide a Brain change',

    vision_analyze: 'Analyze Image',

    delegate_tasks: 'Delegate Tasks',
    call_agent: 'Call Coworker',
    team_status: 'Team Status',
    team_list_schedules: "List a Coworker's Schedules",
    team_list_triggers: "List a Coworker's Triggers",
    team_list_runs: "List a Coworker's Runs",
    team_get_run: "Read a Coworker's Run",

    schedule_list: 'List Schedules',
    schedule_create: 'Create Schedule',
    schedule_update: 'Update Schedule',
    schedule_delete: 'Delete Schedule',
    trigger_list: 'List Triggers',
    trigger_create: 'Create Trigger',
    trigger_get: 'Read Trigger',
    trigger_update: 'Update Trigger',
    trigger_rotate_token: 'Rotate Trigger Secret',
    trigger_delete: 'Delete Trigger',

    skill_list: 'List Skills',
    skill_read: 'Read Skill',
    skill_read_file: 'Read Skill File',
    skill_write_file: 'Write Skill File',
    skill_delete_file: 'Delete Skill File',
    skill_create: 'Create Skill',
    skill_import: 'Import Skill',
    skill_edit: 'Edit Skill',
    skill_update: 'Update Skill',
    skill_delete: 'Delete Skill',
    skill_propose: 'Skill Proposal',

    soul_update: 'Update Personality',
    verbosity_set: 'Adjust Response Length',
    tool_install: 'Install Tool',
    mcp_register: 'Connect Integration',
    mcp_login: 'Sign in to Integration',
    mcp_login_complete: 'Finish Sign-in',
    mcp_status: 'Integration Status',

    card_table: 'Show a table',
    card_file: 'Show a file',
    image_generation: 'Generate an image',
    table_view_save: 'Save a table view',
    table_view_delete: 'Delete a table view',

    rerun_hub_service_search: 'Search Apps',
    rerun_hub_service_details: 'App Details',
    rerun_hub_service_install: 'Install App',
    rerun_hub_service_list_installed: 'List Apps',
    rerun_hub_service_uninstall: 'Remove App',
    rerun_hub_publish_file: 'Publish File',
    rerun_hub_unpublish_file: 'Unpublish File',
    rerun_hub_list_published: 'List Published Files',

    task_complete: 'Task Complete',

    // The foreman's belt. Same map as everything else, so its tool calls wear a real label in
    // the Foreman's column instead of a title-cased tool name under a wrench.
    list_spaces: 'List Boxes',
    list_agents: 'List Coworkers',
    get_agent: 'Read Coworker',
    create_agent: 'Create Coworker',
    update_agent: 'Update Coworker',
    delete_agent: 'Delete Coworker',
    list_ai_connections: 'List AI Providers',
    set_default_model: 'Set Default Model',
    list_skills: 'List Skills',
    get_skill: 'Read Skill',
    upsert_skill: 'Write Skill',
    delete_skill: 'Delete Skill',
    list_schedules: 'List Scheduled Tasks',
    upsert_schedule: 'Schedule Task',
    run_schedule_now: 'Run Task Now',
    delete_schedule: 'Delete Scheduled Task',
    list_runs: 'List Runs',
    get_run: 'Read Run',
    search_connectors: 'Search Apps',
    list_agent_connectors: 'List Apps',
    attach_connector: 'Add App',
    detach_connector: 'Remove App',
    send_message: 'Message Coworker',
    create_boxes: 'Create Boxes',
    build_team: 'Build Team',
    write_agent: 'Writing its SOUL and install',
    rename_box: 'Rename Box',
    delete_box: 'Delete Box',
    focus_agent: 'Open Coworker',
    show_agents: 'Show Coworkers',
    open_connector_setup: 'Open App Setup',
    open_settings: 'Open Settings',
    recenter_board: 'Recenter Board',
    open_brain_page: 'Open the Brain',
    read_attachment: 'Read Attachment',
    search_docs: 'Search Docs',
    analyze_website: 'Read Website',
    save_profile: 'Save Profile',
    save_needs: 'Save Needs',
    list_templates: 'Browse Templates',
    propose_plan: 'Write Plan',
    install_template: 'Install Template',
    install_shared_agent: 'Install Shared Coworker',
    open_template_card: 'Open Template',
    start_agent_setup: 'Hand Over Setup',
    open_checkout: 'Start Trial',
    open_template_purchase: 'Buy Template',
    ask_choice: 'Asked the user',
    ask_either: 'Asked the user',
    ask_input: 'Asked the user',
    show_templates: 'Showed Templates',
    show_plan: 'Showed the Plan',
    show_starter_pack: 'Showed the Starter Pack',
    contact_team: 'Offered the Team',

    ask_user: 'Asked the user',
    request_approval: 'Requested approval',
    suggest_service: 'Suggested an app',
    request_secret: 'Requested a credential',
    request_mcp_sign_in: 'Asked you to sign in to an MCP server',
    request_takeover: 'Asked you to take over the browser',
    request_spend: 'Asked to spend credits',
    notify_user: 'Notified you',
    install_complete: 'Finished the setup',
}

// What a step reads as while it runs, beside the coworker at work. A tool missing here falls back
// on its label on each client.
const TOOL_ACTIVITIES: Record<string, string> = {
    shell_exec: 'Running a command',

    fs_read: 'Reading a file',
    fs_write: 'Writing a file',
    fs_edit: 'Editing a file',
    fs_list: 'Listing files',
    fs_search: 'Searching files',

    shared_read: 'Reading a shared file',
    shared_write: 'Writing a shared file',
    shared_edit: 'Editing a shared file',
    shared_list: 'Listing shared files',
    shared_search: 'Searching shared files',

    browser_navigate: 'Browsing the web',
    computer: 'Using its computer',
    computer_open_app: 'Opening an app',
    web_fetch: 'Reading a page',
    web_search: 'Searching the web',
    WebSearch: 'Searching the web',
    leads_people_search: 'Finding people',
    leads_email_find: 'Finding an email',
    leads_email_verify: 'Verifying an email',
    leads_phone_find: 'Finding a phone number',
    google_serp: 'Searching Google',
    google_maps_search: 'Searching Google Maps',
    download: 'Downloading',

    memory_write: 'Saving to memory',
    memory_recall: 'Recalling memory',
    brain_search: 'Searching the Brain',
    brain_read: 'Reading the Brain',
    brain_propose: 'Proposing a Brain change',
    brain_write: 'Writing to the Brain',

    vision_analyze: 'Looking at an image',
    image_generation: 'Generating an image',

    delegate_tasks: 'Delegating tasks',
    call_agent: 'Calling a coworker',
    team_status: 'Checking the team',
    team_list_runs: "Reading a coworker's runs",
    team_get_run: "Reading a coworker's run",

    skill_read: 'Reading a skill',
    skill_read_file: 'Reading a skill',
    skill_create: 'Creating a skill',
    skill_edit: 'Editing a skill',
    skill_update: 'Updating a skill',

    rerun_hub_service_search: 'Searching apps',
    rerun_hub_service_install: 'Installing an app',

    list_agents: 'Looking at the team',
    create_agent: 'Creating a coworker',
    update_agent: 'Updating a coworker',
    send_message: 'Messaging a coworker',
    build_team: 'Building the team',
    search_docs: 'Searching the docs',
    analyze_website: 'Reading the website',
    list_templates: 'Browsing templates',
    propose_plan: 'Writing the plan',
    install_template: 'Installing a template',
}

export function toolActivityOf(toolName: string, input?: unknown): string | undefined {
    const capability = toolName === PAID_DATA_TOOL ? capabilityOfCall(toolName, input) : null
    if (capability) return paidDataEntry(capability).activity
    return TOOL_ACTIVITIES[toolName]
}

export function isKnownTool(toolName: string): boolean {
    return toolName in TOOL_LABELS
}

export function formatToolName(name: string): string {
    return name
        .replace(/_/g, ' ')
        .trim()
        .replace(/\b\w/g, c => c.toUpperCase())
}

// A paid_data call is named after the capability it bought: "Reading TikTok", not "Paid data".
export function toolLabelOf(toolName: string, input?: unknown): string {
    const capability = toolName === PAID_DATA_TOOL ? capabilityOfCall(toolName, input) : null
    if (capability) return paidDataEntry(capability).activity
    if (TOOL_LABELS[toolName]) return TOOL_LABELS[toolName]
    if (toolName.startsWith('mcp_')) return formatToolName(toolName.replace(/^mcp__?/, '').replace(/__/g, ' '))
    return formatToolName(toolName)
}

const HEADLINE_ARGS = ['preview', 'command', 'path', 'query', 'url']

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const isReadable = (value: unknown): value is string => typeof value === 'string' && !!value && !UUID_PATTERN.test(value.trim())

export const argsOf = (input: unknown) => (input && typeof input === 'object' ? (input as Record<string, unknown>) : undefined)

export function agentIdOf(input: unknown): string | undefined {
    const agentId = argsOf(input)?.agentId
    return typeof agentId === 'string' && agentId ? agentId : undefined
}

// The one line of detail a step shows after its label: what it ran, read or looked up.
export function toolHeadline(input: unknown, agentName?: string): string | undefined {
    const args = argsOf(input)
    if (!args) return undefined
    // A paid_data call says what it looked up, not which capability: the label already names it.
    if (typeof args.capability === 'string' && argsOf(args.params)) return toolHeadline(args.params)
    const named = HEADLINE_ARGS.map(name => args[name]).find(isReadable)
    return named ?? (agentName || Object.values(args).find(isReadable))
}
