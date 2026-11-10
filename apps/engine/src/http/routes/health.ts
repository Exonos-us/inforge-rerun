import { Hono } from 'hono'
import { ENGINE_CAPABILITY_ARTIFACT_UPDATE, ENGINE_CAPABILITY_CUSTOM, ENGINE_CAPABILITY_OPENCODE, ENGINE_CAPABILITY_DESKTOP, ENGINE_CAPABILITY_DESKTOP_HOLD, ENGINE_CAPABILITY_FILES_STREAM, ENGINE_CAPABILITY_FOREMAN_FILES, ENGINE_CAPABILITY_SCHEDULE_RENAME } from '@rerun/contracts'
import { activeAgentCount } from '../../agents/registry.js'
import { activeRunCount, sessionClaimCount } from '../../runtime/run-control.js'
import { buildCommit, processStartedAt } from '../../runtime/build-info.js'
import { detectLayout } from '../../runtime/layout.js'
import { readLastUpdate } from '../../runtime/last-update.js'
import { DATA_DIR_VERSION } from '../../datadir/migrations.js'
import { readDataVersion } from '../../datadir/version.js'
import { desktopAvailable, desktopViewerCount } from '../../desktop/session.js'

export const healthRoutes = new Hono()

const layout = detectLayout().kind

healthRoutes.get('/health', c =>
    c.json({
        status: 'ok',
        activeAgents: activeAgentCount(),
        activeRuns: activeRunCount(),
        // Claims and controllers should move together; a gap between them is a leaked conversation.
        claimedSessions: sessionClaimCount(),
        desktopViewers: desktopViewerCount(),
        capabilities: [
            ENGINE_CAPABILITY_FILES_STREAM,
            ENGINE_CAPABILITY_FOREMAN_FILES,
            ENGINE_CAPABILITY_SCHEDULE_RENAME,
            ENGINE_CAPABILITY_ARTIFACT_UPDATE,
            ENGINE_CAPABILITY_OPENCODE,
            ENGINE_CAPABILITY_CUSTOM,
            ...(desktopAvailable() ? [ENGINE_CAPABILITY_DESKTOP, ENGINE_CAPABILITY_DESKTOP_HOLD] : []),
        ],
        commit: buildCommit(),
        startedAt: processStartedAt(),
        layout,
        lastUpdate: readLastUpdate(),
        dataVersion: readDataVersion(),
        dataVersionTarget: DATA_DIR_VERSION,
    }),
)
