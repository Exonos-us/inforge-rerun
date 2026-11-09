import { FOREMAN_AGENT_ID } from '@rerun/contracts'

import { CoworkerRow } from '@/components/home/CoworkerRow'
import type { ForemanLast } from '@/components/home/useForemanLast'

// The Foreman as the first row of the Home: no pin, no time, its last conversation under its name.
export function ForemanRow({ last, selected, onPress }: { last: ForemanLast; selected?: boolean; onPress: () => void }) {
    return <CoworkerRow coworker={{ id: FOREMAN_AGENT_ID, kind: 'foreman', name: 'Rerun', status: last.running ? 'working' : 'idle' }} line={{ text: last.title || 'Ask anything', tone: 'muted' }} minutesAgo={null} unread={false} selected={selected} onPress={onPress} />
}
