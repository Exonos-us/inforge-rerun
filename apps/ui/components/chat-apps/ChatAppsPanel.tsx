'use client'

import { Group } from '@/components/connections/AiProvidersPanel'
import { SlackSettingsPage } from '@/components/slack/SlackSettingsPage'
import { Icon } from '@/components/ui/icon'
import { PanelScroller } from '@/components/ui/panel-list'
import { PanelRow } from '@/components/ui/panel-row'
import { PanelSteps } from '@/components/ui/panel-steps'
import { useCatalogServices } from '@/hooks/useCatalogServices'
import { useChatAppsSummary } from '@/hooks/useChatAppsSummary'
import { ChevronRightIcon } from '@/lib/icons'
import { serviceIconProps } from '@/lib/services/icons'
import { Badge } from '@rerun/ui/primitives'
import { useEffect, useState } from 'react'

import { relative } from '../slack/relative-time'

// The hub: one row per chat app the coworkers can talk through. Slack is live; the others are
// named so the entry stays the same when they land. Each row opens that app's own page.
export function ChatAppsPanel() {
    const { resolved } = useCatalogServices(['slack', 'microsoft-teams'])
    const { summary, refresh } = useChatAppsSummary()
    const [page, setPage] = useState<'hub' | 'slack'>('hub')

    useEffect(() => {
        void refresh()
    }, [refresh])

    const slackIcon = resolved.get('slack')?.icon ?? null
    const slack = summary?.slack

    return (
        <PanelSteps stepKey={page} depth={page === 'hub' ? 0 : 1}>
            {page === 'slack' ? (
                <SlackSettingsPage icon={slackIcon} onBack={() => setPage('hub')} />
            ) : (
                <PanelScroller className="flex flex-col gap-6 p-4">
                    <Group title="Apps">
                        <PanelRow
                            leading={<Icon {...serviceIconProps(slackIcon, 'productivity')} size="sm" />}
                            title="Slack"
                            description={slackDescription(slack)}
                            onClick={() => setPage('slack')}
                            actions={
                                <>
                                    <SlackBadge slack={slack} />
                                    <ChevronRightIcon className="ml-1 size-4 text-muted-foreground" />
                                </>
                            }
                        />
                        <PanelRow
                            className="opacity-70"
                            leading={<Icon {...serviceIconProps(resolved.get('microsoft-teams')?.icon ?? null, 'productivity')} size="sm" />}
                            title="Microsoft Teams"
                            description="Chat with your coworkers in Teams channels."
                            actions={<Badge size="xs" tone="neutral">Soon</Badge>}
                        />
                    </Group>
                    <p className="text-xs text-muted-foreground">A coworker answers wherever it was invited. Each app keeps its own settings and checks.</p>
                </PanelScroller>
            )}
        </PanelSteps>
    )
}

function slackDescription(slack: { connected: boolean; teamName: string | null; channelCount: number; healthy: boolean; lastEventAt: string | null } | undefined): string {
    if (!slack?.connected) return 'Put your coworkers in Slack channels and talk to them there.'
    const parts = [slack.teamName ?? 'Connected', `${slack.channelCount} channel${slack.channelCount === 1 ? '' : 's'}`]
    if (slack.healthy && slack.lastEventAt) parts.push(`events OK ${relative(slack.lastEventAt)}`)
    return parts.join(' · ')
}

function SlackBadge({ slack }: { slack: { connected: boolean; healthy: boolean } | undefined }) {
    if (!slack) return null
    if (!slack.connected) return <Badge size="xs" tone="neutral">Set up</Badge>
    if (!slack.healthy) return <Badge size="xs" tone="orange">Needs attention</Badge>
    return <Badge size="xs" tone="green">Connected</Badge>
}
