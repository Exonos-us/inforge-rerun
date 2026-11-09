import { useState } from 'react'
import { ScrollView, View } from 'react-native'

import { usePaneSize } from '@/components/layout/PaneSize'
import { AppText } from '@/components/ui/AppText'

import { Markdown } from '../Markdown'
import { HitlAction, HitlCard } from './HitlCard'

// A notification the coworker raised and the conversation waits on until it is read. Pinned above the
// composer as on the web, so a long one scrolls inside rather than pushing the composer away.
export function AlertWidget({ message, onAcknowledge }: { message: string; onAcknowledge: () => Promise<void> }) {
    const { height } = usePaneSize()
    const [pending, setPending] = useState(false)
    const [failed, setFailed] = useState(false)
    const acknowledge = async () => {
        setPending(true)
        setFailed(false)
        try {
            await onAcknowledge()
        } catch {
            setFailed(true)
            setPending(false)
        }
    }
    return (
        <HitlCard symbol="bell" label="Notification">
            <ScrollView nestedScrollEnabled style={{ maxHeight: height * 0.22 }}>
                <Markdown text={message} />
            </ScrollView>
            {failed && (
                <AppText variant="footnote" tone="destructive">
                    Could not mark it as read. Try again.
                </AppText>
            )}
            <View style={{ flexDirection: 'row', justifyContent: 'flex-end' }}>
                <HitlAction label={pending ? 'Marking…' : 'Mark as read'} primary disabled={pending} onPress={acknowledge} />
            </View>
        </HitlCard>
    )
}
