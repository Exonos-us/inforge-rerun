import { MAX_UPLOAD_FILE_BYTES, type SkillSummary } from '@rerun/contracts'
import * as DocumentPicker from 'expo-document-picker'
import * as Haptics from 'expo-haptics'
import { GlassView } from 'expo-glass-effect'
import * as ImagePicker from 'expo-image-picker'
import { type Ref, useEffect, useEffectEvent, useImperativeHandle, useRef, useState } from 'react'
import { Alert, Text, TextInput, View, type TextInputInstance } from 'react-native'

import { addPasteImagesListener } from '@/chat/composer-paste'
import { useGlassStyle } from '@/components/ui/GlassButton'
import type { Coworker } from '@/mocks/data'
import type { Model } from '@/mocks/models'
import { useTheme } from '@/theme/theme'
import { fonts, radius, spacing } from '@/theme/tokens'

import { AttachmentStrip } from './AttachmentStrip'
import { fitAttachments, imageAttachment, MAX_ATTACHMENTS, type ComposerAttachment } from './attachments'
import { AttachMenu, CONTROL, ModelChip, RoundButton, TargetPicker } from './ComposerControls'
import { MentionSuggestions } from './MentionSuggestions'
import { insertAtCaret, insertMention, mentionItems, mentionQueryAt, type MentionAgent, type MentionItem } from './mentions'
import { useVoiceMessage, type VoiceSender } from './useVoiceMessage'
import { VoiceRecorderBar } from './VoiceRecorderBar'

const LINE_HEIGHT = 21

export type ComposerHandle = { focus: () => void }

type ComposerProps = {
    value: string
    onChangeText: (text: string) => void
    attachments?: ComposerAttachment[]
    onAttachmentsChange?: (attachments: ComposerAttachment[]) => void
    onSend: () => void
    onStop: () => void
    running: boolean
    placeholder: string
    // Left out until the conversation can carry them: no model chip, no attachments, no voice messages.
    model?: Model
    onOpenModel?: () => void
    canAttach?: boolean
    voice?: VoiceSender
    target?: { coworker: Coworker; choices: Coworker[]; onPick: (id: string) => void }
    // What `/` and `@` offer, as on the web: none of either leaves its menu shut.
    skills?: SkillSummary[]
    mentionAgents?: MentionAgent[]
    autoFocus?: boolean
    ref?: Ref<ComposerHandle>
}

// A pill at rest, a card once in use (focused, holding text or attachments, or listening).
export function Composer({ value, onChangeText, attachments = [], onAttachmentsChange = () => {}, onSend, onStop, running, placeholder, model, onOpenModel, canAttach = true, voice, target, skills = [], mentionAgents = [], autoFocus, ref }: ComposerProps) {
    const theme = useTheme()
    const glass = useGlassStyle()
    const [focused, setFocused] = useState(Boolean(autoFocus))
    const input = useRef<TextInputInstance>(null)
    useImperativeHandle(ref, () => ({ focus: () => input.current?.focus() }), [])
    const [caret, setCaret] = useState(value.length)
    // Where the caret goes once the text a menu just wrote is on screen.
    const pendingCaret = useRef<number | null>(null)
    const recorder = useVoiceMessage(voice)
    const recording = recorder.status !== 'idle'
    const canRecord = Boolean(voice)
    const expanded = focused || value.length > 0 || attachments.length > 0 || recording
    const hasText = value.trim().length > 0
    const canSend = hasText || attachments.length > 0
    const inputText = { paddingHorizontal: expanded ? spacing.xs : canAttach ? 0 : spacing.sm, paddingVertical: (CONTROL - LINE_HEIGHT) / 2, fontFamily: fonts.regular, fontSize: 16, lineHeight: LINE_HEIGHT } as const

    const mention = focused && !recording ? mentionQueryAt(value, Math.min(caret, value.length)) : null
    const suggestions = mention ? mentionItems(mention, mentionAgents, skills) : []

    useEffect(() => {
        if (pendingCaret.current === null) return
        input.current?.setSelection(pendingCaret.current, pendingCaret.current)
        pendingCaret.current = null
    }, [value])

    const write = (next: { text: string; caret: number }) => {
        pendingCaret.current = next.caret
        setCaret(next.caret)
        onChangeText(next.text)
    }

    const pickMention = (item: MentionItem) => {
        if (!mention) return
        Haptics.selectionAsync()
        write(insertMention(value, Math.min(caret, value.length), mention, item))
    }

    const pickSkill = (slug: string) => {
        write(insertAtCaret(value, Math.min(caret, value.length), `/${slug}`))
        input.current?.focus()
    }

    const add = (added: ComposerAttachment[]) => {
        const { attachments: next, tooBig, noRoom } = fitAttachments(attachments, added)
        if (tooBig.length > 0) Alert.alert(tooBig.length === 1 ? 'This file is too large' : 'These files are too large', `${tooBig.map(file => file.name).join(', ')}: ${MAX_UPLOAD_FILE_BYTES / 1024 / 1024} MB at most.`)
        if (noRoom.length > 0) Alert.alert('Too many files', `${MAX_ATTACHMENTS} at most: ${noRoom.map(file => file.name).join(', ')} left out.`)
        onAttachmentsChange(next)
    }

    // Only the composer being typed in: the pager keeps its neighbours' composers mounted.
    const onPasted = useEffectEvent((uris: string[]) => add(uris.map(imageAttachment)))
    useEffect(() => {
        if (!focused || !canAttach) return
        return addPasteImagesListener(onPasted)
    }, [focused, canAttach])

    const pickPhotos = async () => {
        const room = MAX_ATTACHMENTS - attachments.length
        if (room <= 0) return
        // Compatible hands over a JPEG instead of the library's HEIC, which the models do not all read.
        const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsMultipleSelection: true, selectionLimit: room, quality: 0.8, preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible })
        if (!result.canceled) add(result.assets.map((asset, index) => ({ ...imageAttachment(asset.uri, attachments.length + index), size: asset.fileSize })))
    }

    const takePhoto = async () => {
        if (attachments.length >= MAX_ATTACHMENTS) return
        const { granted } = await ImagePicker.requestCameraPermissionsAsync()
        if (!granted) return
        const result = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 0.8 }).catch(() => null)
        if (result && !result.canceled) add([imageAttachment(result.assets[0].uri, attachments.length)])
    }

    const pickFiles = async () => {
        if (attachments.length >= MAX_ATTACHMENTS) return
        const result = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true }).catch(() => null)
        if (result && !result.canceled) add(result.assets.map(asset => ({ uri: asset.uri, name: asset.name, mimeType: asset.mimeType ?? 'application/octet-stream', size: asset.size })))
    }

    const startRecording = async () => {
        if (await recorder.start()) Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
    }

    const stop = () => {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium)
        onStop()
    }

    // As on the web: with nothing to send the mic is the main action, or stop while a turn runs; once
    // there is something to send, send takes over and the mic steps back (or out, for text).
    const actions = running ? (
        canSend ? (
            <>
                <RoundButton symbol="stop.fill" label="Stop" onPress={stop} />
                <RoundButton symbol="arrow.up" label="Send" tone="primary" onPress={() => onSend()} />
            </>
        ) : (
            <RoundButton symbol="stop.fill" label="Stop" tone="primary" onPress={stop} />
        )
    ) : !canSend ? (
        canRecord ? (
            <RoundButton symbol="mic" label="Record a voice message" tone="primary" onPress={startRecording} />
        ) : (
            <RoundButton symbol="arrow.up" label="Send" tone="primary" disabled onPress={() => onSend()} />
        )
    ) : (
        <>
            {!hasText && canRecord && <RoundButton symbol="mic" label="Record a voice message" onPress={startRecording} />}
            <RoundButton symbol="arrow.up" label="Send" tone="primary" onPress={() => onSend()} />
        </>
    )

    return (
        <View style={{ gap: spacing.sm }}>
            {mention && suggestions.length > 0 && <MentionSuggestions trigger={mention.trigger} items={suggestions} onPick={pickMention} />}
            <GlassView key={theme.scheme} colorScheme={theme.scheme} glassEffectStyle={glass} style={{ borderRadius: expanded ? radius.xl : radius.pill, borderCurve: 'continuous', paddingHorizontal: expanded ? spacing.md : spacing.sm, paddingTop: expanded ? spacing.md : spacing.sm, paddingBottom: spacing.sm, gap: spacing.sm }}>
                {expanded && target && (
                    <View style={{ paddingHorizontal: spacing.xs }}>
                        <TargetPicker target={target.coworker} choices={target.choices} onPick={target.onPick} />
                    </View>
                )}
                {expanded && attachments.length > 0 && <AttachmentStrip attachments={attachments} onRemove={uri => onAttachmentsChange(attachments.filter(attachment => attachment.uri !== uri))} />}
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.xs }}>
                    {!expanded && canAttach && <AttachMenu onPhotos={pickPhotos} onCamera={takePhoto} onFiles={pickFiles} skills={skills} onSkill={pickSkill} />}
                    {recorder.status === 'idle' ? (
                        <View style={{ flex: 1 }}>
                            {/* A multiline input wraps its placeholder: this one stays on a single line, cut short. */}
                            {value.length === 0 && (
                                <Text numberOfLines={1} pointerEvents="none" style={[inputText, { position: 'absolute', left: 0, right: 0, top: 0, color: theme.mutedForeground }]}>
                                    {placeholder}
                                </Text>
                            )}
                            <TextInput ref={input} value={value} onChangeText={onChangeText} onSelectionChange={event => setCaret(event.nativeEvent.selection.end)} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} autoFocus={autoFocus} multiline accessibilityLabel={placeholder} testID="composer-input" style={[inputText, { minHeight: expanded ? 44 : CONTROL, maxHeight: 132, color: theme.foreground }]} />
                        </View>
                    ) : (
                        <VoiceRecorderBar status={recorder.status} error={recorder.error} getLiveState={recorder.getLiveState} />
                    )}
                    {!expanded && actions}
                </View>
                {expanded && (
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
                        {recording ? (
                            <>
                                <RoundButton symbol="xmark" label="Discard recording" tone="plain" disabled={recorder.status === 'processing'} onPress={() => void recorder.discard()} />
                                <View style={{ flex: 1 }} />
                                {recorder.status === 'failed' ? <RoundButton symbol="arrow.clockwise" label="Retry sending the recording" tone="primary" onPress={recorder.retry} /> : <RoundButton symbol="arrow.up" label="Send the recording" tone="primary" busy={recorder.status !== 'recording'} onPress={() => void recorder.finish()} />}
                            </>
                        ) : (
                            <>
                                {canAttach && <AttachMenu onPhotos={pickPhotos} onCamera={takePhoto} onFiles={pickFiles} skills={skills} onSkill={pickSkill} />}
                                <View style={{ flex: 1 }} />
                                {model && onOpenModel && <ModelChip model={model} onPress={onOpenModel} />}
                                {actions}
                            </>
                        )}
                    </View>
                )}
            </GlassView>
        </View>
    )
}
