export type ThreadPlacement<T> = {
    // Threads opened before the first message of General, or while it had none.
    leading: T[]
    // Threads opened after the message at that index and before the next one.
    after: Map<number, T[]>
}

const timeOf = (iso: string) => new Date(iso).getTime()

// Where each thread hangs in General: under the last message that was there when it opened, in the
// order they opened. `messageTimes` is one ISO time per message, as the transcript shows them.
export function threadsByMessage<T extends { createdAt: string }>(messageTimes: readonly string[], threads: readonly T[]): ThreadPlacement<T> {
    const leading: T[] = []
    const after = new Map<number, T[]>()
    const times = messageTimes.map(timeOf)
    const ordered = [...threads].sort((a, b) => timeOf(a.createdAt) - timeOf(b.createdAt))
    for (const thread of ordered) {
        const opened = timeOf(thread.createdAt)
        let anchor = -1
        for (let i = 0; i < times.length; i++) {
            if (times[i] <= opened) anchor = i
        }
        if (anchor === -1) {
            leading.push(thread)
            continue
        }
        const list = after.get(anchor) ?? []
        list.push(thread)
        after.set(anchor, list)
    }
    return { leading, after }
}
