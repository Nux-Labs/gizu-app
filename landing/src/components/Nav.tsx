import { useEffect, useState } from 'react'
import { ArrowUpRight, Menu, X } from 'lucide-react'
import { APP_URL } from '../links'

const LINKS = [
  { href: '#money', label: 'How it works' },
  { href: '#strategies', label: 'Strategies' },
  { href: '#faq', label: 'FAQ' },
]

export default function Nav() {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!open) return
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [open])

  return (
    <header className="fixed inset-x-0 top-0 z-50 border-b border-white/[0.07] bg-ink/80 backdrop-blur-xl">
      <nav aria-label="Primary" className="shell flex h-20 items-center gap-3">
        <a href="#top" className="flex shrink-0 items-center gap-2.5" onClick={() => setOpen(false)}>
          <img src="/gizulogo.svg" alt="" className="h-6 w-auto" />
          <span className="text-[17px] font-medium tracking-tight">Gizu</span>
        </a>
        <ul className="ml-12 hidden items-center gap-8 md:flex">
          {LINKS.map(link => <li key={link.href}><a href={link.href} className="inline-flex min-h-11 items-center text-sm text-white/55 transition-colors hover:text-white">{link.label}</a></li>)}
        </ul>
        <a href={APP_URL} className="ml-auto inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-lg bg-gradient-to-br from-[#bff6fb] to-[#d7ccff] px-4 text-[12px] font-semibold text-ink sm:px-5 sm:text-sm"><span className="hidden min-[360px]:inline">Explore the app</span><span className="min-[360px]:hidden">Explore app</span><ArrowUpRight size={16} aria-hidden="true" /></a>
        <button type="button" aria-label={open ? 'Close navigation' : 'Open navigation'} aria-controls="mobile-navigation" aria-expanded={open} onClick={() => setOpen(value => !value)} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-white/10 md:hidden">{open ? <X size={18} /> : <Menu size={18} />}</button>
      </nav>
      {open && <nav id="mobile-navigation" aria-label="Mobile navigation" className="shell border-t border-white/10 pb-4 md:hidden">{LINKS.map(link => <a key={link.href} href={link.href} onClick={() => setOpen(false)} className="flex min-h-14 items-center justify-between border-b border-white/10 text-sm text-white/75">{link.label}<ArrowUpRight size={15} aria-hidden="true" /></a>)}</nav>}
    </header>
  )
}
