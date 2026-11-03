import { useEffect } from 'react'
import { ArrowUpRight } from 'lucide-react'

const LINKS = [
  { href: '#money', label: 'How it works' },
  { href: '#strategies', label: 'Strategies' },
  { href: '#faq', label: 'FAQ' },
]

export default function Nav() {
  useEffect(() => {
    const root = document.documentElement
    let current = 0
    let target = 0
    let raf = 0

    const read = () => {
      target = Math.min(1, window.scrollY / 160)
      if (!raf) raf = requestAnimationFrame(tick)
    }

    // trails the wheel by a beat, so the morph reads as eased
    const tick = () => {
      current += (target - current) * 0.16
      if (Math.abs(target - current) < 0.001) current = target
      root.style.setProperty('--nav-p', current.toFixed(4))
      raf = current === target ? 0 : requestAnimationFrame(tick)
    }

    read()
    window.addEventListener('scroll', read, { passive: true })
    return () => {
      window.removeEventListener('scroll', read)
      cancelAnimationFrame(raf)
      root.style.removeProperty('--nav-p')
    }
  }, [])

  return (
    <header className="nav-shell fixed inset-x-0 top-0 z-50">
      <nav aria-label="Primary" className="nav-bar mx-auto flex items-center gap-3">
        <a href="#top" className="flex shrink-0 items-center gap-2.5">
          <img src="/gizulogo.svg" alt="" className="h-6 w-auto" />
          <span className="text-[17px] font-medium tracking-tight">Gizu</span>
        </a>

        <ul className="nav-links ml-10 hidden items-center md:flex">
          {LINKS.map((l) => (
            <li key={l.href}>
              <a href={l.href} className="text-[14px] text-white/55 transition-colors hover:text-white">
                {l.label}
              </a>
            </li>
          ))}
        </ul>

        <a
          href="#top"
          className="nav-cta ml-auto inline-flex shrink-0 items-center justify-center gap-2 rounded-full bg-gradient-to-br from-[#bff6fb] to-[#d7ccff] text-[14px] font-semibold text-ink"
        >
          Explore the app
          <ArrowUpRight size={16} strokeWidth={2.4} />
        </a>
      </nav>
    </header>
  )
}
