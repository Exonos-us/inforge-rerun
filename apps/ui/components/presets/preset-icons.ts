import { EMOJI_CHOICES, emojiGlyph } from '@/components/slack/slack-emoji'

// A preset's icon is a Slack :shortcode:, the same value a channel binding stores, so the emoji
// chosen at hire is exactly the avatar the coworker posts under.

export function presetGlyph(icon: string | null): string {
    return emojiGlyph(icon || null) ?? '🤖'
}

export function nextPresetIcon(icon: string | null): string {
    const index = EMOJI_CHOICES.findIndex(([code]) => code === icon)
    return EMOJI_CHOICES[(index + 1) % EMOJI_CHOICES.length][0]
}
