export type ImportSourceId = 'openclaw' | 'hermes' | 'grok' | 'other'

export type ImportSource = {
    id: ImportSourceId
    label: string
    // Where the source keeps what makes the agent itself, in the words the prompt hands it.
    whereToLook: string
    // Grok reads a connector URL from its settings before it can call anything.
    connectorStep?: string
}

export const IMPORT_SOURCES: readonly ImportSource[] = [
    {
        id: 'openclaw',
        label: 'OpenClaw',
        whereToLook:
            'Your OpenClaw home, usually ~/.openclaw. In its workspace folder: SOUL.md, AGENTS.md, IDENTITY.md, TOOLS.md (who you are and how you work), USER.md and MEMORY.md plus the memory/ folder (what you know), HEARTBEAT.md (your periodic check), the skills/ folder (one SKILL.md per skill, with its files), and your cron jobs. Other files in the workspace are your working files.',
    },
    {
        id: 'hermes',
        label: 'Hermes Agent',
        whereToLook:
            'Your Hermes home, usually ~/.hermes: SOUL.md (who you are), memories/MEMORY.md and memories/USER.md (what you know), the skills/ folder (one SKILL.md per skill, with its files) and your cron jobs in cron/. Skip config.yaml, .env and the sessions database.',
    },
    {
        id: 'grok',
        label: 'Grok',
        whereToLook:
            'Your custom instructions and persona (who you are and how you work), what you remember about me, the recurring tasks you run for me with their schedule, and the procedures you follow for them.',
        connectorStep: 'Add the URL in grok.com/connectors as a custom connector, then paste the prompt.',
    },
    {
        id: 'other',
        label: 'Other',
        whereToLook:
            'Wherever you keep your system prompt or persona, your memory about me, your skills or procedures, your scheduled tasks and your working files.',
    },
]

export function importSource(id: ImportSourceId): ImportSource {
    return IMPORT_SOURCES.find(source => source.id === id) ?? IMPORT_SOURCES[IMPORT_SOURCES.length - 1]
}

export function isImportSourceId(value: unknown): value is ImportSourceId {
    return IMPORT_SOURCES.some(source => source.id === value)
}
