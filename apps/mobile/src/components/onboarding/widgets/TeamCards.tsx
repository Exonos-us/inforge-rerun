import { SymbolView, type SFSymbol } from 'expo-symbols'
import { ActivityIndicator, View } from 'react-native'

import { ForemanOrb } from '@/components/orb/ForemanOrb'
import { AppText } from '@/components/ui/AppText'
import { Button } from '@/components/ui/Button'
import { webHost } from '@/config/environment'
import { useTheme } from '@/theme/theme'
import { radius, spacing } from '@/theme/tokens'

import type { BuildResult, BuildTask } from '../parts'

function Frame({ children }: { children: React.ReactNode }) {
    const theme = useTheme()
    return <View style={{ gap: spacing.md, padding: spacing.lg, borderRadius: radius.lg, borderCurve: 'continuous', borderWidth: 1, borderColor: theme.border, backgroundColor: theme.card }}>{children}</View>
}

export type TeamStartState = 'starting' | 'failed' | 'blocked' | 'started'

// The step between the confirmed plan and the build. The app sells nothing: it starts the workspace on
// its own the moment the plan is confirmed, and only says something when that did not go through.
export function TeamStartCard({ state, onRetry }: { state: TeamStartState; onRetry: () => void }) {
    const theme = useTheme()
    if (state === 'started') {
        return (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.xs }}>
                <SymbolView name="checkmark.circle.fill" size={13} tintColor={theme.mutedForeground} />
                <AppText variant="footnote" tone="muted">
                    Workspace ready
                </AppText>
            </View>
        )
    }
    return (
        <Frame>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}>
                <ForemanOrb size={32} state={state === 'starting' ? 'thinking' : 'idle'} />
                <View style={{ flex: 1, gap: 2 }}>
                    <AppText variant="headline">{state === 'starting' ? 'Getting your workspace ready' : state === 'failed' ? 'That did not go through' : 'This workspace cannot start here'}</AppText>
                    <AppText variant="footnote" tone="muted">
                        {state === 'starting' ? 'Your coworker is built right after.' : state === 'failed' ? 'Nothing was lost. Try again in a moment.' : `Finish setting it up at ${webHost}.`}
                    </AppText>
                </View>
            </View>
            {state === 'failed' && <Button label="Try again" onPress={onRetry} />}
        </Frame>
    )
}

const TASK_LOOK: Record<BuildTask['status'], { symbol: SFSymbol | null; tone: 'default' | 'muted' | 'destructive' }> = {
    queued: { symbol: 'circle.dashed', tone: 'muted' },
    dispatched: { symbol: 'circle.dashed', tone: 'muted' },
    running: { symbol: null, tone: 'default' },
    done: { symbol: 'checkmark.circle.fill', tone: 'default' },
    error: { symbol: 'exclamationmark.circle.fill', tone: 'destructive' },
    stopped: { symbol: 'minus.circle', tone: 'muted' },
}

function TaskRow({ task }: { task: BuildTask }) {
    const theme = useTheme()
    const look = TASK_LOOK[task.status]
    const color = look.tone === 'destructive' ? theme.destructive : look.tone === 'muted' ? theme.mutedForeground : theme.foreground
    return (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md, minHeight: 28 }}>
            <View style={{ width: 18, alignItems: 'center' }}>{look.symbol ? <SymbolView name={look.symbol} size={16} tintColor={color} /> : <ActivityIndicator size="small" color={theme.mutedForeground} />}</View>
            <AppText variant="callout" tone={look.tone === 'muted' ? 'muted' : 'default'} numberOfLines={1} style={{ flex: 1 }}>
                {task.title}
            </AppText>
        </View>
    )
}

// The build, live: one row per thing being put on the board. Once it is done, the coworker it put first
// is the one to start, as the button the web leaves under its build. A build that put nobody on the board
// is run again from here: the composer is gone past the plan.
export function BuildCard({ tasks, result, starting, onStartLead, onRetry }: { tasks: BuildTask[]; result: BuildResult | null; starting: boolean; onStartLead: () => void; onRetry: (() => void) | null }) {
    const done = result !== null
    const empty = done && result.agents === 0
    return (
        <Frame>
            <AppText variant="headline">{!done ? 'Building your team' : empty ? 'Your team could not be built' : 'Your team is ready'}</AppText>
            <View style={{ gap: spacing.xs }}>
                {tasks.map((task, index) => (
                    <TaskRow key={`${index}-${task.title}`} task={task} />
                ))}
            </View>
            {empty && (
                <AppText variant="footnote" tone="muted">
                    Nothing was lost. Try again in a moment.
                </AppText>
            )}
            {done && !empty && result.failed.length > 0 && (
                <AppText variant="footnote" tone="muted">
                    {result.failed.length === 1 ? `${result.failed[0]} could not be built yet.` : `${result.failed.length} coworkers could not be built yet.`}
                </AppText>
            )}
            {empty && onRetry && <Button label="Try again" onPress={onRetry} />}
            {done && result.lead && <Button label={`Start installing ${result.lead.name}`} size="lg" loading={starting} onPress={onStartLead} />}
        </Frame>
    )
}

// No machine is free for the build: the web's waitlist wall. Their answers are kept, and the screen opens
// on its own once a machine frees up.
export function WaitlistNotice() {
    return (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.lg, paddingHorizontal: spacing.xl }}>
            <ForemanOrb size={64} />
            <View style={{ alignItems: 'center', gap: spacing.xs }}>
                <AppText variant="title" style={{ textAlign: 'center' }}>
                    We&apos;re at full capacity right now
                </AppText>
                <AppText variant="callout" tone="muted" style={{ textAlign: 'center' }}>
                    Every machine is taken. You&apos;re on the waitlist: your answers are saved, and this opens on its own as soon as one frees up.
                </AppText>
            </View>
        </View>
    )
}
