import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion, useScroll, useTransform } from 'framer-motion'
import { ArrowUpRight } from 'lucide-react'
import { DOCS_URL } from '../links'

const LINKS = [
  { href: '#money', label: 'How it works' },
  { href: '#strategies', label: 'Strategies' },
  { href: '#faq', label: 'FAQ' },
]

function Roll({ children }: { children: string }) {
  return <span className="nav-roll"><span>{children}</span><span aria-hidden="true">{children}</span></span>
}

/** Nux Labs' centered navigation and rolling labels, in Gizu's visual language. */
export default function Nav() {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState('')
  const root = useRef<HTMLElement>(null)
  const toggle = useRef<HTMLButtonElement>(null)
  const reduce = useReducedMotion()
  const { scrollY } = useScroll()
  const inset = useTransform(scrollY, [0, 160], [0, 14])
  const width = useTransform(scrollY, [0, 160], ['100%', 'calc(100% - 32px)'])
  const maxWidth = useTransform(scrollY, [0, 160], [1280, 1060])
  const height = useTransform(scrollY, [0, 160], [80, 64])
  const radius = useTransform(scrollY, [0, 160], [0, 16])
  const backgroundColor = useTransform(scrollY, [0, 120], ['rgba(7, 10, 15, 0)', 'rgba(7, 10, 15, 0.96)'])
  const borderColor = useTransform(scrollY, [0, 120], ['rgba(255, 255, 255, 0)', 'rgba(255, 255, 255, 0.09)'])

  useEffect(() => {
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) if (entry.isIntersecting) setActive(`#${entry.target.id}`)
    }, { rootMargin: '-15% 0px -55% 0px' })
    document.querySelectorAll('#top, #money, #strategies, #faq').forEach(section => observer.observe(section))
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!open) return
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setOpen(false); toggle.current?.focus() }
    }
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false) }
    const desktop = window.matchMedia('(min-width: 768px)')
    const resized = () => { if (desktop.matches) setOpen(false) }
    window.addEventListener('keydown', close)
    window.addEventListener('pointerdown', outside)
    desktop.addEventListener('change', resized)
    return () => {
      window.removeEventListener('keydown', close)
      window.removeEventListener('pointerdown', outside)
      desktop.removeEventListener('change', resized)
    }
  }, [open])

  return (
    <motion.header ref={root} className="gizu-nav" style={{ backgroundColor: open ? 'rgba(7, 10, 15, 0.98)' : backgroundColor, borderColor, top: reduce ? 12 : inset, width: reduce ? 'calc(100% - 32px)' : width, maxWidth: reduce ? 1060 : maxWidth, borderRadius: reduce ? 16 : radius }}>
      <motion.nav aria-label="Primary" className="gizu-nav-bar" style={{ height: reduce ? 64 : height }}>
        <a href="#top" aria-label="Gizu home" className="gizu-brand" onClick={() => setOpen(false)}><img src="/gizulogo.svg" alt="" className="h-7 w-auto" /><span>Gizu</span></a>
        <ul className="gizu-nav-links">{LINKS.map(link => <li key={link.href}><a href={link.href} aria-current={active === link.href ? 'location' : undefined}><Roll>{link.label}</Roll></a></li>)}</ul>
        <a href={DOCS_URL} className="gizu-nav-docs"><Roll>Documentation</Roll><ArrowUpRight size={15} aria-hidden="true" /></a>
        <button ref={toggle} type="button" aria-label={open ? 'Close navigation' : 'Open navigation'} aria-controls="mobile-navigation" aria-expanded={open} onClick={() => setOpen(value => !value)} className="gizu-nav-burger"><span /><span /></button>
      </motion.nav>
      <AnimatePresence>
        {open && <motion.nav id="mobile-navigation" aria-label="Mobile navigation" className="gizu-nav-panel" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={{ duration: reduce ? 0 : 0.24 }}>
          {LINKS.map((link, i) => <a key={link.href} href={link.href} aria-current={active === link.href ? 'location' : undefined} onClick={() => setOpen(false)}><span className="font-mono text-xs text-white/25">0{i + 1}</span><span>{link.label}</span><ArrowUpRight size={18} aria-hidden="true" /></a>)}
          <a href={DOCS_URL} onClick={() => setOpen(false)} className="!text-base !text-white/45"><span>Documentation</span><ArrowUpRight size={16} aria-hidden="true" /></a>
        </motion.nav>}
      </AnimatePresence>
    </motion.header>
  )
}
