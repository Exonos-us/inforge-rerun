export function relative(at: string): string {
    const seconds = Math.max(0, Math.round((Date.now() - new Date(at).getTime()) / 1000))
    if (seconds < 90) return 'just now'
    const minutes = Math.round(seconds / 60)
    if (minutes < 60) return `${minutes} min ago`
    const hours = Math.round(minutes / 60)
    return hours < 24 ? `${hours} hour${hours > 1 ? 's' : ''} ago` : `${Math.round(hours / 24)} day${hours >= 48 ? 's' : ''} ago`
}
