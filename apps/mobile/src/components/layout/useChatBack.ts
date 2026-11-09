import { router, useNavigation } from 'expo-router'

import { useIsSplit } from '@/components/layout/PaneSize'

// Beside the sidebar, a conversation at the root of the stack has nothing to go back to: no button.
// A window that narrows (the Duo folding) can leave that conversation alone in the stack: back then
// lands on the Home.
export function useChatBack(): (() => void) | undefined {
    const split = useIsSplit()
    const navigation = useNavigation()
    if (split && !navigation.canGoBack()) return undefined
    return () => (router.canGoBack() ? router.back() : router.replace('/'))
}
