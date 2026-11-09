import { describe, expect, it } from 'vitest'

import { ACCOUNT_TOOL_DEFS, ACCOUNT_TOOL_NAMES } from './account-tools'
import { IMPORT_TOOL_NAMES, importToolDefs } from './import-scope'

describe('the import scope', () => {
    it('names only tools the account server advertises', () => {
        expect([...IMPORT_TOOL_NAMES].filter(name => !(ACCOUNT_TOOL_NAMES as readonly string[]).includes(name))).toEqual([])
        expect(importToolDefs(ACCOUNT_TOOL_DEFS)).toHaveLength(IMPORT_TOOL_NAMES.size)
    })

    it('reaches nothing that deletes, runs, messages or reads the rest of the account', () => {
        const forbidden = /^(delete_|detach_|send_message|run_|test_|rotate_|db_|space_db_|list_agents|list_spaces|list_runs|get_run|set_default_model)/
        expect([...IMPORT_TOOL_NAMES].filter(name => forbidden.test(name))).toEqual([])
    })

    // Outside agents (Grok, OpenAI-based ones) refuse a tool whose description runs past 1,024
    // characters, and an import key is precisely what those agents hold.
    it('keeps every import tool description within 1,024 characters', () => {
        expect(importToolDefs(ACCOUNT_TOOL_DEFS).filter(tool => tool.description.length > 1024).map(tool => tool.name)).toEqual([])
    })
})
