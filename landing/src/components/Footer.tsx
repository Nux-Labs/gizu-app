import { ArrowUpRight } from 'lucide-react'
import AsciiChameleon from '../chameleon/AsciiChameleon'

const LINKS = [
  { label: 'How it works', href: '#money' },
  { label: 'FAQ', href: '#faq' },
  { label: 'Docs', href: '#top' },
  { label: 'X', href: '#top' },
  { label: 'GitHub', href: '#top' },
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

          <form
            onSubmit={(e) => e.preventDefault()}
            className="flex w-full max-w-[380px] items-center gap-2 rounded-full border border-white/10 p-1.5 pl-5"
          >
            <input
              type="email"
              placeholder="Email address"
              className="h-10 w-full min-w-0 bg-transparent text-[14px] outline-none placeholder:text-white/30"
            />
            <button className="flex h-10 shrink-0 items-center gap-1.5 rounded-full bg-gradient-to-br from-[#bff6fb] to-[#d7ccff] px-5 text-[13px] font-semibold text-ink">
              Join
              <ArrowUpRight size={15} strokeWidth={2.6} />
            </button>
          </form>
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
          <nav className="flex flex-wrap items-center gap-x-7 gap-y-3">
            {LINKS.map((l) => (
              <a key={l.label} href={l.href} className="text-[13.5px] text-white/50 hover:text-white">
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
