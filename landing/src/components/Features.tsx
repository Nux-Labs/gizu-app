import Reveal from './Reveal'
import VaultDiscovery from './portfolio/VaultDiscovery'

export default function Features() {
  return (
    <section id="strategies" aria-labelledby="features-title" className="relative scroll-mt-28 border-y border-white/[0.07] bg-[#070a0f]">
      <div className="shell py-20 md:py-28">
        <div className="mb-12 grid items-end gap-7 md:grid-cols-[1.2fr_0.8fr] md:gap-16">
          <Reveal direction="left"><h2 id="features-title" className="max-w-[15ch] text-[clamp(38px,5vw,64px)] font-medium leading-[1.02] tracking-[-0.04em]">Choose what your capital does.</h2></Reveal>
          <Reveal direction="right"><p className="max-w-[38ch] text-[17px] leading-relaxed text-white/55">Start with an asset. Get to know the protocol. Review the strategy before making it part of your portfolio.</p></Reveal>
        </div>
        <Reveal direction="right"><VaultDiscovery /></Reveal>
      </div>
    </section>
  )
}
