'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'

const LINKS = [
  { href: '/', label: 'Home' },
  { href: '/verify', label: 'Verify' },
  { href: '/results', label: 'Example report' },
]

export function MainNav() {
  const pathname = usePathname()
  return (
    <nav aria-label="Main" className="hidden md:block">
      <ul className="flex items-center gap-8">
        {LINKS.map((link) => {
          const active = pathname === link.href
          return (
            <li key={link.href}>
              <Link
                href={link.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'relative py-5 text-sm transition-colors',
                  active
                    ? 'font-semibold text-foreground after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:rounded-full after:bg-primary'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {link.label}
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
