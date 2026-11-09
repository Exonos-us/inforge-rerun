import { columnsFor, DETAIL_MIN_WIDTH, isSplit, sidebarWidth } from '@/components/layout/split'

const IPHONE_17 = 402
const IPHONE_PRO_MAX = 440
const DUO_OUTER = 466
const DUO_INNER_PORTRAIT = 626
const IPAD_MINI_PORTRAIT = 744
const IPAD_13_THIRD = 375
const IPAD_13_LANDSCAPE = 1376

describe('split layout', () => {
    it('keeps every iPhone screen on one column', () => {
        for (const width of [IPHONE_17, IPHONE_PRO_MAX, DUO_OUTER, IPAD_13_THIRD]) expect(isSplit(width)).toBe(false)
    })

    it('puts the list beside the conversation on the unfolded Duo and on an iPad', () => {
        for (const width of [DUO_INNER_PORTRAIT, IPAD_MINI_PORTRAIT, IPAD_13_LANDSCAPE]) expect(isSplit(width)).toBe(true)
    })

    it('never leaves the conversation narrower than an iPhone', () => {
        for (let width = 300; width <= 1400; width += 2) {
            if (isSplit(width)) expect(width - sidebarWidth(width)).toBeGreaterThanOrEqual(DETAIL_MIN_WIDTH)
        }
    })

    it('grows the list with the window, within bounds', () => {
        expect(sidebarWidth(DUO_INNER_PORTRAIT)).toBe(260)
        expect(sidebarWidth(1000)).toBe(320)
        expect(sidebarWidth(IPAD_13_LANDSCAPE)).toBe(340)
    })

    it('fits more columns on a wider pane, never fewer than asked', () => {
        expect(columnsFor(354, 108, 3)).toBe(3)
        expect(columnsFor(1000, 108, 3)).toBe(9)
        expect(columnsFor(200, 108, 3)).toBe(3)
    })
})
