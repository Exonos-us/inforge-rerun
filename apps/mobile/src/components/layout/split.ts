// A window wide enough for the coworker list beside the conversation: an iPad, the inner screen of an
// unfolded iPhone Duo. The conversation never gets narrower than the narrowest iPhone it is designed for.
export const SIDEBAR = { min: 260, max: 340, share: 0.32 } as const
export const DETAIL_MIN_WIDTH = 360

export function sidebarWidth(windowWidth: number): number {
    return Math.min(SIDEBAR.max, Math.max(SIDEBAR.min, Math.round(windowWidth * SIDEBAR.share)))
}

export function isSplit(windowWidth: number): boolean {
    return windowWidth - sidebarWidth(windowWidth) >= DETAIL_MIN_WIDTH
}

// How many cells of at least `minCell` fit across `width`, never fewer than `fewest`.
export function columnsFor(width: number, minCell: number, fewest: number): number {
    return Math.max(fewest, Math.floor(width / minCell))
}

// A conversation reads as a column, even on an iPad: lines past this width are hard to follow.
export const CHAT_COLUMN_MAX_WIDTH = 760

// A form or a short notice (sign-in, consent) keeps the width of a phone on an iPad.
export const FORM_COLUMN_MAX_WIDTH = 440
