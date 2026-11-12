'use client'

import { deleteGlobalConnectionAction, disableGlobalAppAction, enableGlobalAppAction, getShareableServiceAction, renameGlobalConnectionAction, updateGlobalKeyConnectionAction } from '@/app/api/_actions/global-apps.actions'
import { Group } from '@/components/connections/AiProvidersPanel'
import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog'
import { GlobalComposioConnect } from '@/components/global-apps/GlobalComposioConnect'
import { GlobalMcpOAuthConnect } from '@/components/global-apps/GlobalMcpOAuthConnect'
import { GlobalAppStatusBadge } from '@/components/global-apps/GlobalAppsList'
import { openPendingSignInPopup } from '@/components/services/sign-in-popup'
import { ServiceFields } from '@/components/services/ServiceFields'
import { Button } from '@/components/ui/button'
import { Icon } from '@/components/ui/icon'
import { Input } from '@/components/ui/input'
import { PanelEditorBody, PanelEditorHeader, PanelEditorShell } from '@/components/ui/panel-editor'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { TooltipDisabledReason } from '@/components/ui/tooltip'
import { useCanManageAgent } from '@/hooks/useBoxAccess'
import { BOX_MANAGE_REASON } from '@/lib/board/box-access'
import { UNNAMED_BOX_LABEL, type IsoAgent } from '@/lib/board/types'
import { serviceIconProps } from '@/lib/services/icons'
import type { AuthMethodSummary, GlobalAppConnection } from '@/lib/services/types'
import { Loader2Icon, SearchIcon } from '@/lib/icons'
import { useIsWorkspaceAdmin } from '@/supabase/session/SessionProvider'
import { useBoardStore } from '@/stores/board.store'
import { Field } from '@/components/ui/field'
import { Badge } from '@rerun/ui/primitives'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'

const ADMIN_REASON = 'Only an admin of the workspace can do this'

type GlobalAppDetailPageProps = {
    connection: GlobalAppConnection
    onBack: () => void
    reload: () => Promise<void>
    onDeleted: () => void
}

// One workspace account: the account itself on top (rename, reconnect or rotate, disconnect),
// then every coworker of the board with a switch. Enabling compiles the app onto the coworker
// with the shared credential; disabling strips exactly that and nothing else.
export function GlobalAppDetailPage({ connection, onBack, reload, onDeleted }: GlobalAppDetailPageProps) {
    const isAdmin = useIsWorkspaceAdmin()
    const adminReason = isAdmin ? undefined : ADMIN_REASON

    return (
        <PanelEditorShell>
            <PanelEditorHeader title={connection.name} onBack={onBack}>
                <Badge size="xs" tone="neutral" glow={false}>
                    {connection.label}
                </Badge>
                <GlobalAppStatusBadge status={connection.status} />
            </PanelEditorHeader>
            <PanelEditorBody>
                <AccountSection connection={connection} reload={reload} onDeleted={onDeleted} adminReason={adminReason} />
                <CoworkersSection connection={connection} reload={reload} />
            </PanelEditorBody>
        </PanelEditorShell>
    )
}

function AccountSection({ connection, reload, onDeleted, adminReason }: { connection: GlobalAppConnection; reload: () => Promise<void>; onDeleted: () => void; adminReason?: string }) {
    const [label, setLabel] = useState(connection.label)
    const [saving, setSaving] = useState(false)
    const [deleting, setDeleting] = useState(false)
    const disabled = Boolean(adminReason)

    const saveLabel = async () => {
        setSaving(true)
        const res = await renameGlobalConnectionAction({ connectionId: connection.id, label })
        setSaving(false)
        if (!res.ok) {
            toast.error(res.error)
            return
        }
        await reload()
        toast.success('Account renamed')
    }

    const disconnect = async () => {
        setDeleting(true)
        const res = await deleteGlobalConnectionAction({ connectionId: connection.id })
        setDeleting(false)
        if (!res.ok) {
            toast.error(res.error)
            return
        }
        for (const warning of res.warnings) toast.warning(warning)
        await reload()
        onDeleted()
    }

    const count = connection.agentIds.length
    return (
        <Group title="Account">
            <div className="space-y-3 rounded-md border border-border p-3">
                <div className="flex items-center gap-3">
                    <Icon {...serviceIconProps(connection.icon, connection.category)} size="sm" />
                    <p className="min-w-0 flex-1 truncate text-sm">
                        {connection.name}
                        {connection.accountLabel && <span className="text-muted-foreground"> · signed in as {connection.accountLabel}</span>}
                    </p>
                </div>
                <Field label="Account label" helperText="How this account reads everywhere: here and on each coworker's Apps tab.">
                    <div className="flex items-center gap-2">
                        <Input value={label} disabled={disabled} className="h-8 text-sm" onChange={e => setLabel(e.target.value)} />
                        {label.trim() !== connection.label && (
                            <Button size="sm" variant="outline" disabled={disabled || saving || !label.trim()} onClick={saveLabel}>
                                {saving ? <Loader2Icon className="size-3.5 animate-spin" /> : 'Save'}
                            </Button>
                        )}
                    </div>
                </Field>
                <div className="flex flex-wrap items-center gap-2">
                    {connection.kind === 'key' ? <RotateCredential connection={connection} reload={reload} adminReason={adminReason} /> : <ReconnectSignIn connection={connection} reload={reload} adminReason={adminReason} />}
                    <TooltipDisabledReason reason={adminReason}>
                        <ConfirmDialog
                            title={`Disconnect ${connection.name} (${connection.label})?`}
                            description={count > 0 ? `${count} coworker${count === 1 ? ' loses' : 's lose'} ${connection.name} until an account is connected again.` : `Nothing uses this account right now.`}
                            confirmLabel="Disconnect"
                            pending={deleting}
                            onConfirm={disconnect}
                        >
                            <Button size="sm" variant="ghost" disabled={disabled} className="text-destructive">
                                Disconnect
                            </Button>
                        </ConfirmDialog>
                    </TooltipDisabledReason>
                </div>
            </div>
        </Group>
    )
}

// Rotate a pasted credential: the new values land on the connection, then on every enabled
// coworker in the same call.
function RotateCredential({ connection, reload, adminReason }: { connection: GlobalAppConnection; reload: () => Promise<void>; adminReason?: string }) {
    const [inputs, setInputs] = useState<AuthMethodSummary['inputs'] | null>(null)
    const [values, setValues] = useState<Record<string, string>>({})
    const [open, setOpen] = useState(false)
    const [busy, setBusy] = useState(false)

    const start = async () => {
        if (open) {
            setOpen(false)
            return
        }
        const res = await getShareableServiceAction({ slug: connection.slug })
        if (!res.ok) {
            toast.error(res.error)
            return
        }
        const method = res.service.methods.find(m => m.id === connection.authMethodId) ?? res.service.methods[0]
        setInputs(method?.inputs ?? [])
        setValues({})
        setOpen(true)
    }

    const submit = async () => {
        setBusy(true)
        const res = await updateGlobalKeyConnectionAction({ connectionId: connection.id, values })
        setBusy(false)
        if (!res.ok) {
            toast.error(res.error)
            return
        }
        for (const warning of res.warnings) toast.warning(warning)
        toast.success(`Every enabled coworker now runs on the new credential.`)
        setOpen(false)
        await reload()
    }

    return (
        <>
            <TooltipDisabledReason reason={adminReason}>
                <Button size="sm" variant="outline" disabled={Boolean(adminReason)} onClick={start}>
                    {open ? 'Keep the current credential' : 'Replace the credential'}
                </Button>
            </TooltipDisabledReason>
            {open && inputs && (
                <div className="w-full space-y-3 rounded-md border border-border bg-muted/30 p-3">
                    <ServiceFields inputs={inputs} values={values} onChange={(key, value) => setValues(prev => ({ ...prev, [key]: value }))} />
                    <div className="flex justify-end">
                        <Button size="sm" disabled={busy} onClick={submit}>
                            {busy ? <Loader2Icon className="size-3.5 animate-spin" /> : 'Save and update every coworker'}
                        </Button>
                    </div>
                </div>
            )}
        </>
    )
}

function ReconnectSignIn({ connection, reload, adminReason }: { connection: GlobalAppConnection; reload: () => Promise<void>; adminReason?: string }) {
    const [signIn, setSignIn] = useState<{ popup: Window | null } | null>(null)

    if (signIn) {
        const done = async () => {
            setSignIn(null)
            await reload()
        }
        return (
            <div className="w-full">
                {connection.kind === 'composio' ? (
                    <GlobalComposioConnect connectionId={connection.id} name={connection.name} autoStart pendingPopup={signIn.popup} onAuthorized={done} />
                ) : (
                    <GlobalMcpOAuthConnect connectionId={connection.id} name={connection.name} autoStart pendingPopup={signIn.popup} onAuthorized={done} />
                )}
            </div>
        )
    }
    return (
        <TooltipDisabledReason reason={adminReason}>
            <Button size="sm" variant="outline" disabled={Boolean(adminReason)} onClick={() => setSignIn({ popup: openPendingSignInPopup(connection.name) })}>
                Reconnect
            </Button>
        </TooltipDisabledReason>
    )
}

const ALL_BOXES = 'all'

function CoworkersSection({ connection, reload }: { connection: GlobalAppConnection; reload: () => Promise<void> }) {
    const agents = useBoardStore(s => s.agents)
    const spaces = useBoardStore(s => s.spaces)
    const [query, setQuery] = useState('')
    const [boxId, setBoxId] = useState(ALL_BOXES)
    const [busy, setBusy] = useState<string | null>(null)

    const boxName = (spaceId: string) => spaces.find(space => space.id === spaceId)?.name?.trim() || UNNAMED_BOX_LABEL
    const enabled = useMemo(() => new Set(connection.agentIds), [connection.agentIds])

    const shown = useMemo(() => {
        const needle = query.trim().toLowerCase()
        return agents.filter(agent => {
            if (boxId !== ALL_BOXES && agent.spaceId !== boxId) return false
            if (!needle) return true
            return `${agent.name} ${agent.handle ?? ''} ${agent.description ?? ''}`.toLowerCase().includes(needle)
        })
    }, [agents, query, boxId])

    const toggle = async (agent: IsoAgent, on: boolean) => {
        setBusy(agent.id)
        const res = on ? await enableGlobalAppAction({ connectionId: connection.id, agentId: agent.id }) : await disableGlobalAppAction({ connectionId: connection.id, agentId: agent.id })
        if (!res.ok) toast.error(res.error)
        await reload()
        setBusy(null)
    }

    return (
        <Group title={`Coworkers · ${connection.agentIds.length} of ${agents.length} enabled`}>
            <div className="flex flex-wrap items-center gap-2">
                <div className="relative min-w-40 flex-1">
                    <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
                    <Input value={query} placeholder="Search coworkers" aria-label="Search coworkers" className="h-8 pl-8 text-sm" onChange={e => setQuery(e.target.value)} />
                </div>
                <Select value={boxId} onValueChange={setBoxId}>
                    <SelectTrigger className="h-8 w-36 text-sm">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value={ALL_BOXES}>All Boxes</SelectItem>
                        {spaces.map(space => (
                            <SelectItem key={space.id} value={space.id}>
                                {space.name?.trim() || UNNAMED_BOX_LABEL}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            </div>
            {agents.length === 0 ? (
                <p className="py-4 text-center text-xs text-muted-foreground">No coworker on the board yet. Hire one, then enable this account for it here.</p>
            ) : shown.length === 0 ? (
                <p className="py-4 text-center text-xs text-muted-foreground">No coworker matches.</p>
            ) : (
                shown.map(agent => <CoworkerRow key={agent.id} agent={agent} boxName={boxName(agent.spaceId)} enabled={enabled.has(agent.id)} busy={busy === agent.id} connected={connection.status === 'connected'} onToggle={on => toggle(agent, on)} />)
            )}
            <p className="text-xs text-muted-foreground">Enabling a coworker gives it everything this account can do. It shows on the coworker's Apps tab with a Global badge.</p>
        </Group>
    )
}

function initialsOf(name: string): string {
    return (
        name
            .split(/\s+/)
            .filter(Boolean)
            .slice(0, 2)
            .map(word => word[0]?.toUpperCase() ?? '')
            .join('') || '?'
    )
}

function CoworkerRow({ agent, boxName, enabled, busy, connected, onToggle }: { agent: IsoAgent; boxName: string; enabled: boolean; busy: boolean; connected: boolean; onToggle: (on: boolean) => void }) {
    const canManage = useCanManageAgent(agent.id)
    const reason = !canManage ? BOX_MANAGE_REASON : !connected && !enabled ? 'Reconnect the account first.' : undefined

    return (
        <div className="flex items-center gap-2.5 rounded-md border border-border px-2.5 py-2">
            <span className="grid size-7 shrink-0 place-items-center rounded-md bg-muted text-[11px] font-medium text-muted-foreground">{initialsOf(agent.name)}</span>
            <div className="min-w-0 flex-1">
                <p className="truncate text-sm">{agent.name}</p>
                <p className="truncate text-xs text-muted-foreground">{[agent.handle ? `@${agent.handle}` : null, agent.description].filter(Boolean).join(' · ') || 'No description yet.'}</p>
            </div>
            {agent.disabledAt && (
                <Badge size="xs" tone="neutral" glow={false}>
                    Off
                </Badge>
            )}
            <Badge size="xs" tone="neutral" glow={false}>
                {boxName}
            </Badge>
            <TooltipDisabledReason reason={reason}>
                <span className="inline-flex">
                    {busy ? <Loader2Icon className="size-4 animate-spin text-muted-foreground" /> : <Switch checked={enabled} disabled={Boolean(reason)} aria-label={`Use this account for ${agent.name}`} onCheckedChange={onToggle} />}
                </span>
            </TooltipDisabledReason>
        </div>
    )
}
