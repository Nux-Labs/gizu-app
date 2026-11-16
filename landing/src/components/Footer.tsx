import { ArrowUpRight } from 'lucide-react'
import AsciiChameleon from '../chameleon/AsciiChameleon'
import { APP_URL, DOCS_URL, REPOSITORY_URL } from '../links'

const LINKS = [
  { label: 'How it works', href: '#money' },
  { label: 'FAQ', href: '#faq' },
  { label: 'Docs', href: DOCS_URL },
  { label: 'GitHub', href: REPOSITORY_URL },
]

export default function Footer() {
  return (
    <footer className="relative overflow-hidden border-t border-white/[0.07]">
      <div className="shell relative pt-16">
        <div className="flex flex-col gap-10 md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-2.5">
            <img src="/gizulogo.svg" alt="" className="h-6 w-auto" />
            <span className="text-[17px] font-medium tracking-tight">Gizu</span>
          </div>

          <div className="flex flex-wrap items-center gap-5">
            <p className="text-sm text-white/60">Your next chapter starts here.</p>
            <a href={APP_URL} className="btn-neon">
              Get mobile access
              <ArrowUpRight size={15} strokeWidth={2.6} />
            </a>
          </div>
        </div>
      </div>

      {/* the mascot gets its own strip between the form and the links */}
      <div
        aria-hidden
        className="pointer-events-none relative mt-4 h-[300px] [mask-image:linear-gradient(to_bottom,transparent,#000_22%,#000_78%,transparent)]"
      >
        <AsciiChameleon anchorX={0.5} anchorY={0.52} size={0.25} />
      </div>

      <div className="shell relative pb-12">
        <div className="flex flex-col gap-5 border-t border-white/[0.06] pt-7 sm:flex-row sm:items-center sm:justify-between">
          <nav aria-label="Footer" className="flex flex-wrap items-center gap-x-7 gap-y-3">
            {LINKS.map((l) => (
              <a key={l.label} href={l.href} className="inline-flex min-h-11 items-center text-[13.5px] text-white/60 hover:text-white">
                {l.label}
              </a>
            ))}
          </nav>

          <p className="text-[12.5px] text-white/30">
            Encryption does not remove investment risk.
          </p>
        </div>
      </div>
    </footer>
  )
}
