import { useRef } from 'react'
import { ScrollView, View, type ScrollViewInstance } from 'react-native'
import { LayoutAnimationConfig } from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import type { Coworker, Session } from '@/mocks/data'
import { spacing } from '@/theme/tokens'

import { CHAT_HEADER_HEIGHT } from './ChatHeader'
import { AssistantMessage, EmptyConversation, NeedsYouCard, UserBubble } from './Messages'
import { RunStatus } from './RunStatus'

export function ConversationPage({ coworker, session }: { coworker: Coworker; session: Session | undefined }) {
    const insets = useSafeAreaInsets()
    const scroll = useRef<ScrollViewInstance>(null)
    const messages = session?.messages ?? []
    const run = session?.run
    const empty = messages.length === 0 && !run
    const lastAssistant = messages.findLastIndex(message => message.role === 'assistant')

    return (
        <ScrollView ref={scroll} keyboardDismissMode="interactive" keyboardShouldPersistTaps="handled" onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: true })} contentContainerStyle={{ flexGrow: 1, justifyContent: empty ? 'center' : 'flex-end', paddingTop: insets.top + CHAT_HEADER_HEIGHT + spacing.lg, paddingBottom: spacing.lg, paddingHorizontal: spacing.xl - 4 }}>
            <LayoutAnimationConfig skipEntering>
                {empty ? (
                    <EmptyConversation coworker={coworker} />
                ) : (
                    <View style={{ gap: spacing.xl }}>
                        {messages.map((message, i) => (message.role === 'user' ? <UserBubble key={message.id} text={message.text} media={message.images?.map(url => ({ url, name: 'Photo', image: true }))} /> : <AssistantMessage key={message.id} text={message.text} showActions={i === lastAssistant && !run} />))}
                        {session?.pendingQuestion && !run && <NeedsYouCard question={session.pendingQuestion} />}
                        {run && <RunStatus coworker={coworker} phase={run.phase} />}
                    </View>
                )}
            </LayoutAnimationConfig>
        </ScrollView>
    )
}
