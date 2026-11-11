import {
    BarChart3Icon,
    BotIcon,
    CodeIcon,
    CreditCardIcon,
    ListChecksIcon,
    MegaphoneIcon,
    MessageSquareIcon,
    PlugIcon,
    SearchIcon,
    ShoppingBagIcon,
    UsersIcon,
    type LucideIcon,
} from '@/lib/icons'

// Surcharges explicites par string `icon` (ou slug) renvoyée par la DB.
const BY_NAME: Record<string, LucideIcon> = {
    stripe: CreditCardIcon,
    metricool: MegaphoneIcon,
    'brand-voice': MessageSquareIcon,
}

// Fallback par catégorie de service quand `icon` est null/inconnu.
// Aligné sur SERVICE_CATEGORIES (lib/services/manifest.ts).
const BY_CATEGORY: Record<string, LucideIcon> = {
    payments: CreditCardIcon,
    ecommerce: ShoppingBagIcon,
    crm: UsersIcon,
    marketing: MegaphoneIcon,
    seo: SearchIcon,
    analytics: BarChart3Icon,
    dev: CodeIcon,
    productivity: ListChecksIcon,
    other: BotIcon,
}

// Ordre de résolution : string `icon` connue → fallback catégorie → PlugIcon par défaut.
export function resolveServiceIcon(icon: string | null, category?: string): LucideIcon {
    if (icon && BY_NAME[icon]) return BY_NAME[icon]
    if (category && BY_CATEGORY[category]) return BY_CATEGORY[category]
    return PlugIcon
}

// `icon` peut être soit un nom Lucide (catalogue historique), soit une URL d'image de
// marque générée par le pipeline brand-icon (logo.dev → FAL → Storage). On renvoie les
// props prêtes à étaler sur <Icon> : `src` pour un logo, `icon` (Lucide) sinon.
export function serviceIconProps(icon: string | null, category?: string): { src: string } | { icon: LucideIcon } {
    if (icon && (/^https?:\/\//i.test(icon) || (icon.startsWith('/') && !icon.startsWith('//')))) return { src: icon }
    return { icon: resolveServiceIcon(icon, category) }
}
