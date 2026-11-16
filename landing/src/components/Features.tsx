import { ArrowUpRight, Fingerprint, Route, Layers3 } from 'lucide-react'
import Reveal from './Reveal'
import { APP_URL } from '../links'

const FEATURES = [
  { icon: Fingerprint, number: '01', title: 'Access that feels familiar.', body: 'Open your wallet with a passkey. Review and approve transactions on your device, where your keys belong.', detail: 'Your device. Your approval.' },
  { icon: Route, number: '02', title: 'Privacy along the way.', body: 'Confidential routing and separate investment accounts help reduce the public connection between funding and holdings.', detail: 'A private middle step.' },
  { icon: Layers3, number: '03', title: 'A clearer view of your capital.', body: 'Discover supported tokens and vaults. Follow your balances, positions and operation progress in one mobile experience.', detail: 'Less switching. More clarity.' },
]

export default function Features() {
  return (
    <section id="strategies" aria-labelledby="features-title" className="shell scroll-mt-28 py-24 md:py-32">
      <Reveal>
        <p className="eyebrow text-neon/80">Built around you</p>
        <div className="mt-5 flex flex-wrap items-end justify-between gap-6">
          <h2 id="features-title" className="max-w-[19ch] text-[clamp(32px,4.4vw,56px)] font-medium leading-[1.08] tracking-[-0.035em]">Your next move.<br />With more peace of mind.</h2>
          <p className="max-w-[35ch] text-base leading-relaxed text-white/60">The details matter. From opening your wallet to following your next investment.</p>
        </div>
      </Reveal>
      <div className="mt-12 grid gap-4 md:grid-cols-3">
        {FEATURES.map(({ icon: Icon, ...feature }) => (
          <Reveal key={feature.number}>
            <article className="flex h-full flex-col rounded-[24px] border border-white/10 bg-gradient-to-b from-white/[0.035] to-transparent p-7 md:p-8">
              <div className="flex items-center justify-between"><Icon size={28} strokeWidth={1.4} className="text-neon" aria-hidden="true" /><span className="font-mono text-xs text-white/30">{feature.number}</span></div>
              <h3 className="mt-12 max-w-[18ch] text-[25px] font-medium leading-tight tracking-tight">{feature.title}</h3>
              <p className="mb-8 mt-4 text-[15px] leading-relaxed text-white/60">{feature.body}</p>
              <p className="mt-auto border-t border-white/10 pt-5 font-mono text-[11px] text-neon/70">{feature.detail}</p>
            </article>
          </Reveal>
        ))}
      </div>
      <Reveal>
        <div className="mt-12 flex flex-col items-start justify-between gap-6 rounded-[24px] border border-neon/15 bg-neon/[0.035] p-7 sm:flex-row sm:items-center md:p-9">
          <div><h3 className="text-2xl font-medium tracking-tight">Meet your mobile wallet.</h3><p className="mt-2 text-sm text-white/60">Explore Gizu for iOS and Android.</p></div>
          <a href={APP_URL} className="btn-neon shrink-0">Explore the app <ArrowUpRight size={17} aria-hidden="true" /></a>
        </div>
      </Reveal>
    </section>
  )
}
