'use server'

import { assertAgentAccess } from '@/app/api/_auth/access'
import { requireAdminContext, requireWorkspaceContext } from '@/app/api/_auth/ownership'
import {
    createGlobalComposioConnection,
    createGlobalKeyConnection,
    createGlobalOauthConnection,
    deleteGlobalConnection,
    disableGlobalApp,
    enableGlobalApp,
    getShareableService,
    listGlobalApps,
    listGlobalOptionsForSlug,
    listShareableCatalog,
    renameGlobalConnection,
    updateGlobalKeyConnection,
    type ShareableServiceDetails,
} from '@/app/api/_services/global-apps.service'
import type { GlobalAppConnection, GlobalAppOption, ShareableService } from '@/lib/services/types'

import type { ActionResult } from './space.actions'

// Global apps: the workspace's shared accounts. Reading is open to every member; connecting,
// rotating, renaming and disconnecting an account take a workspace admin; flipping one coworker's
// switch takes manage on that coworker, the same bar as installing an app on it.

export async function getGlobalAppsAction(): Promise<ActionResult<{ connections: GlobalAppConnection[] }>> {
    try {
        const ctx = await requireWorkspaceContext()
        return { ok: true, connections: await listGlobalApps(ctx.workspace.id) }
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'Could not read the global apps' }
    }
}

export async function listShareableCatalogAction(): Promise<ActionResult<{ services: ShareableService[] }>> {
    try {
        await requireWorkspaceContext()
        return { ok: true, services: await listShareableCatalog() }
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'Could not read the catalog' }
    }
}

export async function getShareableServiceAction(params: { slug: string }): Promise<ActionResult<{ service: ShareableServiceDetails }>> {
    try {
        await requireWorkspaceContext()
        return { ok: true, service: await getShareableService(params.slug) }
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'Could not read the service' }
    }
}

export async function createGlobalKeyConnectionAction(params: { slug: string; authMethodId: string; label: string; values: Record<string, string> }): Promise<ActionResult<{ id: string }>> {
    try {
        const ctx = await requireAdminContext('Only an admin can connect a workspace account')
        if (!params.label.trim()) return { ok: false, error: 'The account needs a label.' }
        const { id } = await createGlobalKeyConnection({ workspaceId: ctx.workspace.id, userId: ctx.userId, slug: params.slug, authMethodId: params.authMethodId, label: params.label.trim(), values: params.values })
        return { ok: true, id }
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'Could not connect the account' }
    }
}

export async function createGlobalComposioConnectionAction(params: { slug: string; label: string }): Promise<ActionResult<{ id: string }>> {
    try {
        const ctx = await requireAdminContext('Only an admin can connect a workspace account')
        if (!params.label.trim()) return { ok: false, error: 'The account needs a label.' }
        const { id } = await createGlobalComposioConnection({ workspaceId: ctx.workspace.id, userId: ctx.userId, slug: params.slug, label: params.label.trim() })
        return { ok: true, id }
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'Could not start the connection' }
    }
}

export async function createGlobalOauthConnectionAction(params: { slug: string; label: string; values: Record<string, string> }): Promise<ActionResult<{ id: string }>> {
    try {
        const ctx = await requireAdminContext('Only an admin can connect a workspace account')
        if (!params.label.trim()) return { ok: false, error: 'The account needs a label.' }
        const { id } = await createGlobalOauthConnection({ workspaceId: ctx.workspace.id, userId: ctx.userId, slug: params.slug, label: params.label.trim(), values: params.values })
        return { ok: true, id }
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'Could not start the sign-in' }
    }
}

export async function renameGlobalConnectionAction(params: { connectionId: string; label: string }): Promise<ActionResult> {
    try {
        const ctx = await requireAdminContext('Only an admin can rename a workspace account')
        if (!params.label.trim()) return { ok: false, error: 'The account needs a label.' }
        await renameGlobalConnection(ctx.workspace.id, params.connectionId, params.label.trim())
        return { ok: true }
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'Could not rename the account' }
    }
}

export async function updateGlobalKeyConnectionAction(params: { connectionId: string; values: Record<string, string> }): Promise<ActionResult<{ warnings: string[] }>> {
    try {
        const ctx = await requireAdminContext('Only an admin can rotate a workspace account')
        const { warnings } = await updateGlobalKeyConnection({ workspaceId: ctx.workspace.id, connectionId: params.connectionId, values: params.values })
        return { ok: true, warnings }
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'Could not update the account' }
    }
}

export async function deleteGlobalConnectionAction(params: { connectionId: string }): Promise<ActionResult<{ warnings: string[] }>> {
    try {
        const ctx = await requireAdminContext('Only an admin can disconnect a workspace account')
        const { warnings } = await deleteGlobalConnection({ workspaceId: ctx.workspace.id, connectionId: params.connectionId })
        return { ok: true, warnings }
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'Could not disconnect the account' }
    }
}

export async function enableGlobalAppAction(params: { connectionId: string; agentId: string }): Promise<ActionResult> {
    try {
        const ctx = await requireWorkspaceContext()
        const { actor } = await assertAgentAccess(params.agentId, 'manage')
        await enableGlobalApp({ workspaceId: ctx.workspace.id, connectionId: params.connectionId, agentId: params.agentId, actor })
        return { ok: true }
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'Could not enable the app' }
    }
}

export async function disableGlobalAppAction(params: { connectionId: string; agentId: string }): Promise<ActionResult> {
    try {
        const ctx = await requireWorkspaceContext()
        const { actor } = await assertAgentAccess(params.agentId, 'manage')
        await disableGlobalApp({ workspaceId: ctx.workspace.id, connectionId: params.connectionId, agentId: params.agentId, actor })
        return { ok: true }
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'Could not disable the app' }
    }
}

export async function listGlobalOptionsForSlugAction(params: { slug: string }): Promise<ActionResult<{ options: GlobalAppOption[] }>> {
    try {
        const ctx = await requireWorkspaceContext()
        return { ok: true, options: await listGlobalOptionsForSlug(ctx.workspace.id, params.slug) }
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'Could not read the workspace accounts' }
    }
}
