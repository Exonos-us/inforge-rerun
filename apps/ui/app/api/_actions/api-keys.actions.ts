'use server'

import { accountLabel } from '@/lib/auth/placeholder-email'
import { actorFromContext, keepVisible, manageableSpaceIds } from '@/app/api/_auth/access'
import { requireAdminContext, requireWorkspaceContext, type WorkspaceContext } from '@/app/api/_auth/ownership'
import type { Database } from '@/app/api/database.types'
import { getAppOrigin } from '@/lib/app-origin'
import { isWorkspaceApiEntitled } from '@rerun/cloud/billing'
import { apiKeyPrefix, generateApiKey, hashApiKey } from '@/lib/mcp/api-keys'
import { mcpAccountUrl } from '@/lib/mcp/connect'
import { IMPORT_KEY_TTL_MS } from '@/lib/mcp/import-scope'
import { buildImportPrompt } from '@/lib/agent-import/prompt'
import { importSource, isImportSourceId, type ImportSourceId } from '@/lib/agent-import/sources'
import { selectAll, selectCount, selectMany, selectMaybeSingle } from '@/supabase/supabase-helpers'

import type { ActionResult } from './space.actions'

// A key acts as the whole workspace, so only an admin issues or revokes one; every member sees the
// list. The subscription is gated too, trial included. A sandbox, which has no subscription at
// all, is entitled by nature: see `isWorkspaceApiEntitled`.

const API_KEYS_ADMIN_ONLY = 'Only an admin can manage API keys'

const MAX_ACTIVE_KEYS = 20
const MAX_NAME_LENGTH = 60

// key_hash stays out: nothing on the client has any use for it.
const API_KEY_COLUMNS = ['id', 'name', 'key_prefix', 'created_by', 'last_used_at', 'created_at', 'expires_at'] as const

export type ApiKeyView = {
    id: string
    name: string
    keyPrefix: string
    createdBy: string | null
    lastUsedAt: string | null
    createdAt: string
}

// The key id comes from the client, so ownership is proven before anything is written: without
// this check a member could revoke another workspace's key by guessing its uuid.
async function assertKeyInWorkspace(ctx: WorkspaceContext, id: string): Promise<void> {
    const { data: key } = await selectMaybeSingle(ctx.supabase, 'api_keys', ['workspace_id'] as const, { id })
    if (!key || key.workspace_id !== ctx.workspace.id) throw new Error('Key not found')
}

export async function listApiKeysAction(): Promise<ActionResult<{ keys: ApiKeyView[]; mcpUrl: string; entitled: boolean }>> {
    try {
        const ctx = await requireWorkspaceContext()
        // A revoked key is dead and cannot come back, so it only adds noise here. The row stays in
        // the database for the admin view, which is where its history is still worth something.
        const { data } = await selectAll(
            ctx.supabase,
            'api_keys',
            API_KEY_COLUMNS,
            { workspace_id: ctx.workspace.id, revoked_at: { isNull: true } },
            { column: 'created_at', ascending: false },
        )

        const now = Date.now()
        const live = (data ?? []).filter(k => !k.expires_at || Date.parse(k.expires_at) > now)
        const keys: ApiKeyView[] = live.map(k => ({
            id: k.id,
            name: k.name,
            keyPrefix: k.key_prefix,
            createdBy: k.created_by,
            lastUsedAt: k.last_used_at,
            createdAt: k.created_at,
        }))

        // Resolved on the server: in dev each Conductor workspace runs on its own port, so a
        // constant would hand out a command pointing at another app, or at nothing.
        return { ok: true, keys, mcpUrl: mcpAccountUrl(await getAppOrigin()), entitled: isWorkspaceApiEntitled(ctx.workspace) }
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'Failed to load API keys' }
    }
}

// The full key exists here and in the response, never again: the database only keeps its hash.
export async function createApiKeyAction(rawName: string): Promise<ActionResult<{ key: string }>> {
    try {
        const ctx = await requireAdminContext(API_KEYS_ADMIN_ONLY)
        if (!isWorkspaceApiEntitled(ctx.workspace)) {
            return { ok: false, error: 'The Rerun API needs an active subscription. Start your subscription to create a key.' }
        }

        const name = rawName.trim()
        if (!name) return { ok: false, error: 'Give the key a name, so you can tell it apart later.' }
        if (name.length > MAX_NAME_LENGTH) return { ok: false, error: `Keep the name under ${MAX_NAME_LENGTH} characters.` }

        const { data: activeCount } = await selectCount(ctx.supabase, 'api_keys', { workspace_id: ctx.workspace.id, revoked_at: { isNull: true }, scope: 'account' })
        if ((activeCount ?? 0) >= MAX_ACTIVE_KEYS) {
            return { ok: false, error: `This workspace already has ${MAX_ACTIVE_KEYS} active keys. Revoke one to create another.` }
        }

        const key = generateApiKey()
        const { error } = await ctx.supabase.from('api_keys').insert<Database['public']['Tables']['api_keys']['Insert']>({
            workspace_id: ctx.workspace.id,
            name,
            key_prefix: apiKeyPrefix(key),
            key_hash: hashApiKey(key),
            created_by: accountLabel(ctx.authUser.email),
            created_by_user_id: ctx.userId,
        })
        if (error) return { ok: false, error: error.message }

        return { ok: true, key }
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'Failed to create the key' }
    }
}

// Import keys stay off MAX_ACTIVE_KEYS: each one lives a day and reaches a single coworker, and a
// member trying several sources should never be told to revoke a real key first.
export async function createImportKeyAction(sourceId: ImportSourceId, requestedSpaceId: string | null = null): Promise<ActionResult<{ connectorUrl: string; prompt: string; expiresAt: string }>> {
    try {
        if (!isImportSourceId(sourceId)) return { ok: false, error: 'Unknown source' }
        const ctx = await requireWorkspaceContext()
        if (!isWorkspaceApiEntitled(ctx.workspace)) {
            return { ok: false, error: 'Importing a coworker needs an active subscription.' }
        }

        const spaceId = await importDestination(ctx, requestedSpaceId)
        const key = generateApiKey()
        const expiresAt = new Date(Date.now() + IMPORT_KEY_TTL_MS).toISOString()
        const { error } = await ctx.supabase.from('api_keys').insert<Database['public']['Tables']['api_keys']['Insert']>({
            workspace_id: ctx.workspace.id,
            name: `Import · ${importSource(sourceId).label}`,
            key_prefix: apiKeyPrefix(key),
            key_hash: hashApiKey(key),
            created_by: accountLabel(ctx.authUser.email),
            created_by_user_id: ctx.userId,
            scope: 'agent_import',
            expires_at: expiresAt,
        })
        if (error) return { ok: false, error: error.message }

        const connectorUrl = `${mcpAccountUrl(await getAppOrigin())}/${key}`
        return { ok: true, connectorUrl, prompt: buildImportPrompt(sourceId, connectorUrl, spaceId), expiresAt }
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'Failed to prepare the import' }
    }
}

// The Box the coworker lands in, named in the prompt so create_agent never has to guess between
// several. The one asked for when the member manages it, otherwise the first one they manage.
async function importDestination(ctx: WorkspaceContext, requested: string | null): Promise<string> {
    const [{ data: all }, manageable] = await Promise.all([
        selectMany(ctx.supabase, 'spaces', ['id'] as const, { workspace_id: ctx.workspace.id }, { column: 'created_at', ascending: true }),
        manageableSpaceIds(actorFromContext(ctx)),
    ])
    const spaces = keepVisible(all ?? [], manageable, space => space.id)
    if (spaces.length === 0) throw new Error('You manage no Box in this workspace yet. Create one first.')
    return spaces.find(space => space.id === requested)?.id ?? spaces[0].id
}

export async function revokeApiKeyAction(id: string): Promise<ActionResult> {
    try {
        const ctx = await requireAdminContext(API_KEYS_ADMIN_ONLY)
        await assertKeyInWorkspace(ctx, id)

        const { error } = await ctx.supabase.from('api_keys').update<Database['public']['Tables']['api_keys']['Update']>({ revoked_at: new Date().toISOString() }).eq('id', id)
        if (error) return { ok: false, error: error.message }
        return { ok: true }
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'Failed to revoke the key' }
    }
}
