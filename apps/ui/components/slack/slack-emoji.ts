// Slack stores an avatar as a :shortcode:; people recognise the picture, not the code. The set
// offered by the picker, each with the glyph it renders as — the stored value stays Slack's.
export const EMOJI_CHOICES = [
    [':wrench:', '🔧'],
    [':art:', '🎨'],
    [':rocket:', '🚀'],
    [':mag:', '🔍'],
    [':memo:', '📝'],
    [':robot_face:', '🤖'],
    [':bar_chart:', '📊'],
    [':inbox_tray:', '📥'],
    [':bulb:', '💡'],
    [':test_tube:', '🧪'],
    [':hammer_and_wrench:', '🛠️'],
    [':mega:', '📣'],
] as const

const BY_SHORTCODE = new Map<string, string>(EMOJI_CHOICES)

// The glyph for a stored shortcode; a custom one outside the picker set falls back to the code
// itself, which is still what Slack will show it as to anyone without that custom emoji.
export function emojiGlyph(shortcode: string | null): string | null {
    if (!shortcode) return null
    return BY_SHORTCODE.get(shortcode) ?? null
}
