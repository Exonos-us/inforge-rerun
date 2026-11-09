import { MAX_STARTER_PICKS } from '@rerun/contracts'
import * as Haptics from 'expo-haptics'
import { Image } from 'expo-image'
import { SymbolView } from 'expo-symbols'
import { useState } from 'react'
import { Pressable, ScrollView, View } from 'react-native'

import { AnswerInput } from '@/components/chat/hitl/QuestionWidget'
import { usePaneSize } from '@/components/layout/PaneSize'
import { AppText } from '@/components/ui/AppText'
import { Button } from '@/components/ui/Button'
import { useTheme } from '@/theme/theme'
import { radius, spacing } from '@/theme/tokens'

import { readStarterPack, type StarterCard, type StarterPackOutput } from '../parts'

const CARD_SHARE = 0.72
const CARD_MAX_WIDTH = 340
const IMAGE_RATIO = 1200 / 630

function PackCard({ card, width, picked, onToggle }: { card: StarterCard; width: number; picked: boolean; onToggle: () => void }) {
    const theme = useTheme()
    const image = card.image && (theme.scheme === 'light' && card.image.lightSrc ? card.image.lightSrc : card.image.src)
    return (
        <Pressable onPress={onToggle} accessibilityRole="checkbox" accessibilityState={{ checked: picked }} accessibilityLabel={card.promise} style={{ width, borderRadius: radius.lg, borderCurve: 'continuous', borderWidth: 1, borderColor: picked ? theme.foreground : theme.border, backgroundColor: theme.card, overflow: 'hidden' }}>
            <View style={{ width: '100%', aspectRatio: IMAGE_RATIO, backgroundColor: theme.muted }}>
                {image && <Image source={{ uri: image }} contentFit="cover" style={{ flex: 1 }} />}
                {picked && (
                    <View style={{ position: 'absolute', top: spacing.sm, right: spacing.sm, width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.foreground }}>
                        <SymbolView name="checkmark" size={11} weight="bold" tintColor={theme.background} />
                    </View>
                )}
            </View>
            <View style={{ flex: 1, gap: spacing.xs, padding: spacing.md }}>
                <AppText variant="headline" numberOfLines={2}>
                    {card.promise}
                </AppText>
                {card.line.length > 0 && (
                    <AppText variant="footnote" tone="muted" numberOfLines={2}>
                        {card.line}
                    </AppText>
                )}
            </View>
        </Pressable>
    )
}

// The starter team of their industry, put up by the hub right after the welcome card: a rail of
// coworkers to pick from, or a line saying what they need instead.
export function StarterPackCard({ input, onAnswer }: { input: unknown; onAnswer: (output: StarterPackOutput) => void }) {
    const cards = readStarterPack(input)
    const { width } = usePaneSize()
    const [picked, setPicked] = useState<string[]>([])
    const [full, setFull] = useState(false)
    const [writing, setWriting] = useState(false)
    const [asked, setAsked] = useState('')
    const cardWidth = Math.min(CARD_MAX_WIDTH, Math.round(width * CARD_SHARE))

    const toggle = (slug: string) => {
        Haptics.selectionAsync()
        if (picked.includes(slug)) {
            setFull(false)
            setPicked(current => current.filter(value => value !== slug))
            return
        }
        if (picked.length >= MAX_STARTER_PICKS) return setFull(true)
        setPicked(current => [...current, slug])
    }

    return (
        <View style={{ gap: spacing.md }}>
            <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md }}>
                <View style={{ flex: 1, gap: 2 }}>
                    <AppText variant="headline">Your starter team</AppText>
                    <AppText variant="footnote" tone="muted">
                        {full ? `Up to ${MAX_STARTER_PICKS} to start. Drop one to take this one.` : `Pick up to ${MAX_STARTER_PICKS}. Each one sets itself up with you.`}
                    </AppText>
                </View>
                <AppText variant="footnote" tone={picked.length ? 'default' : 'muted'} medium style={{ fontVariant: ['tabular-nums'] }}>
                    {picked.length}/{MAX_STARTER_PICKS}
                </AppText>
            </View>

            <ScrollView horizontal showsHorizontalScrollIndicator={false} snapToInterval={cardWidth + spacing.md} decelerationRate="fast" style={{ marginHorizontal: -(spacing.xl - 4) }} contentContainerStyle={{ gap: spacing.md, paddingHorizontal: spacing.xl - 4 }}>
                {cards.map(card => (
                    <PackCard key={card.slug} card={card} width={cardWidth} picked={picked.includes(card.slug)} onToggle={() => toggle(card.slug)} />
                ))}
            </ScrollView>

            {writing ? (
                <View style={{ gap: spacing.sm }}>
                    <View style={{ flexDirection: 'row' }}>
                        <AnswerInput value={asked} onChangeText={setAsked} onSubmit={() => asked.trim() && onAnswer({ answered: true, custom: asked.trim() })} placeholder="What should your coworker do?" last autoFocus />
                    </View>
                    <View style={{ flexDirection: 'row', gap: spacing.sm }}>
                        <Button label="Back" variant="ghost" onPress={() => setWriting(false)} />
                        <Button label="Send" stretch disabled={!asked.trim()} onPress={() => onAnswer({ answered: true, custom: asked.trim() })} />
                    </View>
                </View>
            ) : (
                <View style={{ gap: spacing.sm }}>
                    <Button label={picked.length === 0 ? 'Pick at least one' : picked.length === 1 ? 'Hire this one' : `Hire these ${picked.length}`} disabled={!picked.length} onPress={() => onAnswer({ answered: true, chosen: picked })} />
                    <Button label="None of these, tell me what you need" variant="ghost" size="sm" onPress={() => setWriting(true)} />
                </View>
            )}
        </View>
    )
}
