import { Host, Picker, Text } from '@expo/ui/swift-ui'
import { pickerStyle, tag } from '@expo/ui/swift-ui/modifiers'
import type { CoworkerFile, CoworkerFileKind, CoworkerFiles as CoworkerFilesView } from '@rerun/contracts'
import { Fragment, useState } from 'react'
import { Pressable, View } from 'react-native'

import { AuthedImage } from '@/components/chat/cards/CardParts'
import { formatBytes } from '@/components/chat/cards/cards'
import { usePaneSize } from '@/components/layout/PaneSize'
import { columnsFor } from '@/components/layout/split'
import { AppText } from '@/components/ui/AppText'
import { Card, GROUPED_ROW_HEIGHT, Separator } from '@/components/ui/GroupedList'
import { Skeleton } from '@/components/ui/Skeleton'
import { useTheme } from '@/theme/theme'
import { radius, spacing } from '@/theme/tokens'

import { CoworkerPage, LoadFailed } from './CoworkerPage'

const FEWEST_COLUMNS = 3
const MIN_TILE = 120
const GRID_GAP = 2
const DOC_TILE = 36
const DOC_INSET = spacing.lg + DOC_TILE + spacing.md

const KINDS: { value: CoworkerFileKind; label: string }[] = [
    { value: 'media', label: 'Media' },
    { value: 'doc', label: 'Docs' },
]

const extensionOf = (name: string) => (name.includes('.') ? (name.split('.').pop() ?? '').toLowerCase() : '')

function monthLabel(iso: string | null, now: Date): string {
    if (!iso) return 'Earlier'
    const date = new Date(iso)
    if (date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth()) return 'This month'
    return date.toLocaleDateString(undefined, date.getFullYear() === now.getFullYear() ? { month: 'long' } : { month: 'long', year: 'numeric' })
}

// The files arrive newest first, so a month is a run of neighbours.
function byMonth(files: CoworkerFile[]): { label: string; files: CoworkerFile[] }[] {
    const now = new Date()
    const groups: { label: string; files: CoworkerFile[] }[] = []
    for (const file of files) {
        const label = monthLabel(file.modifiedAt, now)
        const last = groups.at(-1)
        if (last?.label === label) last.files.push(file)
        else groups.push({ label, files: [file] })
    }
    return groups
}

function MonthTitle({ children }: { children: string }) {
    return (
        <AppText variant="footnote" tone="muted" medium style={{ paddingHorizontal: spacing.xs }}>
            {children}
        </AppText>
    )
}

type FileProps = { file: CoworkerFile; onOpen: () => void }

function MediaTile({ file, url, size, onOpen }: FileProps & { url: string; size: number }) {
    return (
        <Pressable onPress={onOpen} accessibilityRole="button" accessibilityLabel={`Open ${file.name}`} style={({ pressed }) => ({ width: size, height: size, opacity: pressed ? 0.7 : 1 })}>
            <AuthedImage url={url} style={{ width: size, height: size }} />
        </Pressable>
    )
}

function DocTile({ name }: { name: string }) {
    const theme = useTheme()
    const extension = extensionOf(name)
    return (
        <View style={{ width: DOC_TILE, height: DOC_TILE, borderRadius: radius.sm, borderCurve: 'continuous', backgroundColor: theme.muted, alignItems: 'center', justifyContent: 'center' }}>
            <AppText variant="caption" tone="muted" medium numberOfLines={1} maxFontSizeMultiplier={1} style={{ fontSize: extension.length > 4 ? 9 : 11 }}>
                {extension || 'file'}
            </AppText>
        </View>
    )
}

function DocRow({ file, onOpen }: FileProps) {
    const theme = useTheme()
    const extension = extensionOf(file.name)
    const detail = [formatBytes(file.size), extension.toUpperCase()].filter(Boolean).join(' · ')
    return (
        <Pressable onPress={onOpen} accessibilityRole="button" accessibilityLabel={`Open ${file.name}`} style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: spacing.md, minHeight: GROUPED_ROW_HEIGHT + 8, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, backgroundColor: pressed ? theme.muted : 'transparent' })}>
            <DocTile name={file.name} />
            <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                <AppText variant="body" numberOfLines={1}>
                    {file.name}
                </AppText>
                <AppText variant="footnote" tone="muted" numberOfLines={1}>
                    {detail}
                </AppText>
            </View>
        </Pressable>
    )
}

function FilesSkeleton({ kind, tile }: { kind: CoworkerFileKind; tile: number }) {
    if (kind === 'media') {
        return (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: GRID_GAP }}>
                {Array.from({ length: 6 }, (_, index) => (
                    <Skeleton key={index} style={{ width: tile, height: tile, borderRadius: 0 }} />
                ))}
            </View>
        )
    }
    return (
        <Card>
            {[0, 1, 2].map(index => (
                <Fragment key={index}>
                    {index > 0 && <Separator inset={DOC_INSET} />}
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md, minHeight: GROUPED_ROW_HEIGHT + 8, paddingHorizontal: spacing.lg }}>
                        <Skeleton style={{ width: DOC_TILE, height: DOC_TILE }} />
                        <View style={{ gap: 6 }}>
                            <Skeleton style={{ width: [150, 110, 170][index], height: 14 }} />
                            <Skeleton style={{ width: 70, height: 12 }} />
                        </View>
                    </View>
                </Fragment>
            ))}
        </Card>
    )
}

type CoworkerFilesProps = {
    name: string
    // Null while on its way.
    view: CoworkerFilesView | null
    urlOf: (file: CoworkerFile) => string
    onOpen: (file: CoworkerFile) => void
    failed?: boolean
    onBack: () => void
}

// What the coworker made and keeps in its folder, newest first, the way a chat app shows what a
// contact sent: pictures in a grid, everything else as a list.
export function CoworkerFiles({ name, view, urlOf, onOpen, failed, onBack }: CoworkerFilesProps) {
    const theme = useTheme()
    const { width } = usePaneSize()
    const [kind, setKind] = useState<CoworkerFileKind>('media')
    const inner = width - spacing.lg * 2
    const columns = columnsFor(inner, MIN_TILE, FEWEST_COLUMNS)
    const tile = Math.floor((inner - GRID_GAP * (columns - 1)) / columns)
    const shown = view?.files.filter(file => file.kind === kind) ?? null

    return (
        <CoworkerPage title="Files" onBack={onBack}>
            <Host matchContents={{ vertical: true }} colorScheme={theme.scheme} style={{ alignSelf: 'stretch' }}>
                <Picker selection={kind} onSelectionChange={value => setKind(value as CoworkerFileKind)} modifiers={[pickerStyle('segmented')]}>
                    {KINDS.map(option => (
                        <Text key={option.value} modifiers={[tag(option.value)]}>
                            {option.label}
                        </Text>
                    ))}
                </Picker>
            </Host>

            {!shown ? (
                failed ? <LoadFailed /> : <FilesSkeleton kind={kind} tile={tile} />
            ) : shown.length === 0 ? (
                <View style={{ alignItems: 'center', gap: spacing.xs, paddingVertical: spacing.xxl, paddingHorizontal: spacing.xl }}>
                    <AppText variant="headline" tone="muted">
                        {kind === 'media' ? 'No media' : 'No docs'}
                    </AppText>
                    <AppText variant="footnote" tone="muted" style={{ textAlign: 'center' }}>
                        What {name} makes will show up here.
                    </AppText>
                </View>
            ) : (
                byMonth(shown).map(group => (
                    <View key={group.label} style={{ gap: spacing.sm }}>
                        <MonthTitle>{group.label}</MonthTitle>
                        {kind === 'media' ? (
                            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: GRID_GAP }}>
                                {group.files.map(file => (
                                    <MediaTile key={file.path} file={file} url={urlOf(file)} size={tile} onOpen={() => onOpen(file)} />
                                ))}
                            </View>
                        ) : (
                            <Card>
                                {group.files.map((file, index) => (
                                    <Fragment key={file.path}>
                                        {index > 0 && <Separator inset={DOC_INSET} />}
                                        <DocRow file={file} onOpen={() => onOpen(file)} />
                                    </Fragment>
                                ))}
                            </Card>
                        )}
                    </View>
                ))
            )}

            {view?.truncated ? (
                <AppText variant="footnote" tone="muted" style={{ textAlign: 'center' }}>
                    The newest files only. All of them are on the web.
                </AppText>
            ) : null}
        </CoworkerPage>
    )
}
