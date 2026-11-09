import { BorderBeam } from '@rerun/ui'

import { Icon } from '@/components/ui/icon'
import { PRO_PERKS } from '@/ee/lib/billing/pro-perks'

export function PerksComparison() {
    return (
        <div className="@container relative flex flex-col rounded-2xl bg-background/60 p-4 ring-1 ring-border sm:p-5">
            <BorderBeam />
            <table className="w-full text-sm">
                <thead>
                    <tr className="text-left text-xs text-muted-foreground">
                        <th className="pb-2 font-normal">
                            <span className="sr-only">Feature</span>
                        </th>
                        <th className="pb-2 pl-4 font-normal">Trial</th>
                        <th className="pb-2 pl-4 font-medium text-foreground">Pro</th>
                    </tr>
                </thead>
                <tbody className="divide-y divide-border">
                    {PRO_PERKS.map(perk => (
                        <tr key={perk.id}>
                            <th scope="row" className="py-2.5 text-left font-normal whitespace-nowrap text-muted-foreground">
                                <span className="flex items-center gap-2.5">
                                    <Icon size="sm" icon={perk.icon} className="@max-md:hidden" />
                                    {perk.title}
                                </span>
                            </th>
                            <td className="py-2.5 pl-4 text-muted-foreground">
                                {perk.trial}
                                {perk.trialDetail && <span className="block text-xs">{perk.trialDetail}</span>}
                            </td>
                            <td className="py-2.5 pl-4 font-medium">
                                {perk.pro}
                                {perk.proDetail && <span className="block text-xs font-normal text-muted-foreground">{perk.proDetail}</span>}
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    )
}
