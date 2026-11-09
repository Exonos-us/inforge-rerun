import { describe, expect, it } from 'vitest'

import { threadsByMessage } from './thread-rows'

const thread = (id: string, createdAt: string) => ({ id, createdAt })

describe('threadsByMessage', () => {
    const times = ['2026-11-08T09:00:00Z', '2026-11-08T10:00:00Z', '2026-11-08T11:00:00Z']

    it('hangs a thread under the last message that was there when it opened', () => {
        const placed = threadsByMessage(times, [thread('a', '2026-11-08T10:30:00Z')])
        expect(placed.leading).toEqual([])
        expect([...placed.after]).toEqual([[1, [thread('a', '2026-11-08T10:30:00Z')]]])
    })

    it('puts a thread opened at the very time of a message under that message', () => {
        const placed = threadsByMessage(times, [thread('a', '2026-11-08T10:00:00Z')])
        expect(placed.after.get(1)).toHaveLength(1)
    })

    it('leads with the threads older than the first message, or when there is none', () => {
        expect(threadsByMessage(times, [thread('old', '2026-11-07T10:00:00Z')]).leading.map(t => t.id)).toEqual(['old'])
        expect(threadsByMessage([], [thread('a', '2026-11-08T10:30:00Z')]).leading.map(t => t.id)).toEqual(['a'])
    })

    it('keeps the threads of one message in the order they opened, whatever order they came in', () => {
        const placed = threadsByMessage(times, [thread('later', '2026-11-08T12:00:00Z'), thread('sooner', '2026-11-08T11:30:00Z')])
        expect(placed.after.get(2)?.map(t => t.id)).toEqual(['sooner', 'later'])
    })
})
