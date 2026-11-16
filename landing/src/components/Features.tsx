import { ArrowUpRight, ArrowRight } from 'lucide-react'
import Reveal from './Reveal'
import VaultDiscovery from './portfolio/VaultDiscovery'
import { APP_URL } from '../links'

export default function Features() {
  return (
    <section id="strategies" aria-labelledby="features-title" className="relative scroll-mt-24 border-y border-white/[0.07] bg-[#070a0f]">
      <div className="shell grid items-center gap-12 py-20 md:py-28 lg:grid-cols-[0.9fr_1.1fr] lg:gap-24">
        <Reveal>
          <p className="eyebrow">Inside Gizu</p>
          <h2 id="features-title" className="mt-5 max-w-[14ch] text-[clamp(38px,4.5vw,60px)] font-medium leading-[1.05] tracking-[-0.04em]">Explore the vault.<br /><span className="text-white/40">Know the details.</span></h2>
          <p className="mt-6 max-w-[37ch] text-[17px] leading-[1.75] text-white/55">Compare assets, networks and strategy information before choosing where to invest.</p>
          <div className="mt-10 border-t border-white/10">
            {[
              ['Discover', 'Browse supported vaults and protocols.'],
              ['Review', 'Understand the assets, curator and risks.'],
              ['Invest', 'Choose an amount and approve on your device.'],
            ].map(([title, body]) => (
              <div key={title} className="grid grid-cols-[76px_1fr] gap-5 border-b border-white/10 py-4">
                <span className="text-sm font-medium text-white/85">{title}</span>
                <p className="text-sm leading-relaxed text-white/45">{body}</p>
              </div>
            ))}
          </div>
          <a href={APP_URL} className="mt-9 inline-flex min-h-11 items-center gap-3 text-sm font-medium text-neon hover:text-white">Explore in Gizu <ArrowUpRight size={17} aria-hidden="true" /></a>
        </Reveal>
        <Reveal delay={0.1}><VaultDiscovery /></Reveal>
      </div>
      <div className="shell">
        <div className="flex flex-wrap items-center justify-between gap-5 border-t border-white/10 py-7">
          <p className="text-sm text-white/45">Available on iOS and Android. Features vary by platform.</p>
          <a href={APP_URL} className="inline-flex min-h-11 items-center gap-3 text-sm text-white/80 hover:text-neon">Get mobile access <ArrowRight size={16} aria-hidden="true" /></a>
        </div>
      </div>
    </section>
  )
}
