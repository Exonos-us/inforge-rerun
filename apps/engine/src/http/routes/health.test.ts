import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

process.env.RERUN_DATA_DIR = mkdtempSync(resolve(tmpdir(), 'rerun-health-'))
process.env.RERUN_API_KEY = 'secret'

const { describe, expect, it } = await import('vitest')
const { ENGINE_CAPABILITY_ARTIFACT_UPDATE, ENGINE_CAPABILITY_FILES_STREAM, ENGINE_CAPABILITY_FOREMAN_FILES, ENGINE_CAPABILITY_SCHEDULE_RENAME, ENGINE_CAPABILITY_OPENCODE, ENGINE_CAPABILITY_SKILL_IMPORT_CREATE } = await import('@rerun/contracts')
const { createServer } = await import('../server.js')
const { claimSession, registerRunAbort, releaseSession, unregisterRunAbort } = await import('../../runtime/run-control.js')
const { buildCommit, processStartedAt } = await import('../../runtime/build-info.js')
const { DATA_DIR_VERSION } = await import('../../datadir/migrations.js')
const { writeLastUpdate } = await import('../../runtime/last-update.js')

const app = createServer()

type Health = { status: string; activeAgents: number; activeRuns: number; claimedSessions: number; capabilities: string[]; commit: string | null; startedAt: string; layout: string; lastUpdate: unknown }

async function health(): Promise<Health> {
    const res = await app.request('/health')
    expect(res.status).toBe(200)
    return (await res.json()) as Health
}

describe('GET /health', () => {
    it('answers without the API key', async () => {
        expect((await app.request('/health')).status).toBe(200)
    })

    it('reports its status, build and capabilities', async () => {
        const body = await health()
        expect(body).toMatchObject({ status: 'ok', activeAgents: 0, activeRuns: 0, claimedSessions: 0, commit: buildCommit(), startedAt: processStartedAt() })
        expect(body.capabilities).toContain(ENGINE_CAPABILITY_FILES_STREAM)
        expect(body.capabilities).toContain(ENGINE_CAPABILITY_FOREMAN_FILES)
        expect(body.capabilities).toContain(ENGINE_CAPABILITY_SCHEDULE_RENAME)
        expect(body.capabilities).toContain(ENGINE_CAPABILITY_OPENCODE)
        expect(body.capabilities).toContain(ENGINE_CAPABILITY_ARTIFACT_UPDATE)
        expect(body.capabilities).toContain(ENGINE_CAPABILITY_SKILL_IMPORT_CREATE)
        expect(Number.isNaN(Date.parse(body.startedAt))).toBe(false)
    })

    it('says how its code is laid out and what the last update did', async () => {
        expect(await health()).toMatchObject({ layout: 'monorepo', lastUpdate: null })
        const last = writeLastUpdate({ status: 'error', commit: 'abc1234', error: 'checksum mismatch' })
        expect(await health()).toMatchObject({ lastUpdate: last })
    })

    // Nothing migrated this data-dir, so it reads as one from before the ladder.
    it('reports where the data-dir is against where this build takes it', async () => {
        expect(await health()).toMatchObject({ dataVersion: 0, dataVersionTarget: DATA_DIR_VERSION })
    })

    it('follows the live runs and the claimed sessions', async () => {
        registerRunAbort('run-a', 'agent-1')
        registerRunAbort('run-b', 'agent-1')
        claimSession('sess-a', 'run-a')
        expect(await health()).toMatchObject({ activeRuns: 2, claimedSessions: 1 })

        unregisterRunAbort('run-a')
        expect(await health()).toMatchObject({ activeRuns: 1, claimedSessions: 0 })

        claimSession('sess-c', 'run-c')
        expect(await health()).toMatchObject({ activeRuns: 1, claimedSessions: 1 })

        releaseSession('run-c')
        unregisterRunAbort('run-b')
        expect(await health()).toMatchObject({ activeRuns: 0, claimedSessions: 0 })
    })
})
