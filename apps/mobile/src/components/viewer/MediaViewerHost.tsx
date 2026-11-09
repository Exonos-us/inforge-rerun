import * as Sharing from 'expo-sharing'
import { useEffect, useRef, useState } from 'react'
import { Alert, Modal, StatusBar, useWindowDimensions, View, type ScrollViewInstance } from 'react-native'
import { GestureHandlerRootView, ScrollView } from 'react-native-gesture-handler'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { cachedFile, fileHeadersFor, isHubFileUrl } from '@/api/files'
import { useAuth } from '@/auth/AuthProvider'
import { AppText } from '@/components/ui/AppText'
import { GlassButton } from '@/components/ui/GlassButton'
import { spacing } from '@/theme/tokens'

import { FilePage } from './FilePage'
import { closeViewer, isImageItem, useViewerState, type ViewerItem } from './viewer-store'
import { ZoomableImage } from './ZoomableImage'

const isOnPhone = (url: string) => url.startsWith('file:') || url.startsWith('data:')

/**
 * The web's `AttachmentLightbox` as a full-screen viewer: the photos and files of one message or card,
 * swiped through one by one, with their name, where they sit in the set, and the share sheet to save
 * or send one on. Mounted once at the root; anything in the thread opens it through `openViewer`.
 */
export function MediaViewerHost() {
    const state = useViewerState()
    const { width } = useWindowDimensions()
    const insets = useSafeAreaInsets()
    const { session, me } = useAuth()
    const caller = session && me ? { accessToken: session.access_token, workspaceId: me.workspace.id } : null
    const [index, setIndex] = useState(0)
    const [zoomed, setZoomed] = useState(false)
    const [drag, setDrag] = useState(0)
    const pager = useRef<ScrollViewInstance>(null)
    const items = state?.items ?? []

    useEffect(() => {
        if (!state) return
        setIndex(state.index)
        setZoomed(false)
        setDrag(0)
    }, [state])

    // A window that resizes (an iPad in Split View, an iPhone Duo folding) keeps the item on screen.
    useEffect(() => {
        if (!state) return
        requestAnimationFrame(() => pager.current?.scrollTo({ x: index * width, animated: false }))
    }, [state, index, width])

    const headersFor = (url: string) => fileHeadersFor(caller, url)

    const localCopy = (item: ViewerItem) => {
        if (isOnPhone(item.url)) return Promise.resolve(item.url)
        if (!isHubFileUrl(item.url)) return cachedFile(null, item.url, item.name)
        if (!caller) return Promise.reject(new Error('signed out'))
        return cachedFile(caller, item.url, item.name)
    }

    const share = async () => {
        const item = items[index]
        if (!item) return
        try {
            await Sharing.shareAsync(await localCopy(item))
        } catch {
            Alert.alert('Could not share the file', 'Try again in a moment.')
        }
    }

    const current = items[index]
    return (
        <Modal visible={state !== null} animationType="fade" presentationStyle="overFullScreen" transparent onRequestClose={closeViewer} supportedOrientations={['portrait', 'landscape']}>
            <StatusBar barStyle="light-content" />
            {/* A modal sits outside the app's gesture root: its pinches need one of their own. */}
            <GestureHandlerRootView style={{ flex: 1, backgroundColor: `rgba(0,0,0,${1 - drag * 0.7})` }}>
                <ScrollView
                    ref={pager}
                    horizontal
                    pagingEnabled
                    scrollEnabled={!zoomed}
                    showsHorizontalScrollIndicator={false}
                    onMomentumScrollEnd={event => {
                        setIndex(Math.round(event.nativeEvent.contentOffset.x / width))
                        setZoomed(false)
                    }}
                >
                    {items.map((item, at) =>
                        isImageItem(item) ? (
                            <ZoomableImage key={`${at}:${item.url}`} uri={item.url} headers={headersFor(item.url)} active={at === index} onZoomChange={setZoomed} onDismiss={closeViewer} onDrag={setDrag} />
                        ) : (
                            <FilePage key={`${at}:${item.url}`} url={item.url} name={item.name} load={() => localCopy(item)} />
                        )
                    )}
                </ScrollView>
                {current && (
                    <View pointerEvents="box-none" style={{ position: 'absolute', top: insets.top + spacing.sm, left: spacing.lg, right: spacing.lg, flexDirection: 'row', alignItems: 'center', gap: spacing.md, opacity: 1 - drag }}>
                        <GlassButton symbol="xmark" label="Close" onPress={closeViewer} scheme="dark" />
                        <View style={{ flex: 1, alignItems: 'center' }}>
                            <AppText variant="callout" medium numberOfLines={1} style={{ color: '#ffffff' }}>
                                {current.name}
                            </AppText>
                            {items.length > 1 && (
                                <AppText variant="caption" style={{ color: 'rgba(255,255,255,0.7)', fontVariant: ['tabular-nums'] }}>
                                    {`${index + 1} / ${items.length}`}
                                </AppText>
                            )}
                        </View>
                        <GlassButton symbol="square.and.arrow.up" label="Share" onPress={share} scheme="dark" />
                    </View>
                )}
            </GestureHandlerRootView>
        </Modal>
    )
}
