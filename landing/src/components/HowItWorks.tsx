import { useId, useRef } from 'react'
import { LayoutGroup, useInView, useReducedMotion } from 'framer-motion'
import BentoCard from './BentoCard'
import StepVisual, { type VisualKind } from './StepVisual'
import Reveal from './Reveal'

function WalletArt({ kind }: { kind: VisualKind }) {
  const ref = useRef<HTMLDivElement>(null)
  const layoutId = useId()
  const visible = useInView(ref, { amount: 0.25 })
  const reduce = useReducedMotion()
  return (
    <div ref={ref} className={`bento-wallet-art bento-wallet-${kind}`}>
      <LayoutGroup id={layoutId}>
        <StepVisual kind={kind} on={visible || !!reduce} />
      </LayoutGroup>
    </div>
  )
}

export default function HowItWorks() {
  return (
    <section id="money" aria-labelledby="how-title" className="shell scroll-mt-28 py-20 md:py-28">
      <Reveal direction="up" className="mb-14 md:mb-20">
        <h2 id="how-title" className="mx-auto max-w-[20ch] text-center md:max-w-none text-[clamp(30px,3.6vw,48px)] font-semibold leading-[1.08] tracking-[-0.04em]">
          Any chain <span className="text-gradient">confidential</span> investment app.
        </h2>
      </Reveal>
      <div className="process-bento">
        <BentoCard number="01" title="A passkey wallet. No seed phrase." body="Create and unlock your wallet with Face ID, fingerprint or a supported passkey manager. Your keys stay on your device, and nothing moves without your approval." wide>
          <WalletArt kind="wallet" />
        </BentoCard>
        <BentoCard number="02" title="Add funds your way." body="Buy USDC with a card or bank transfer, or send it from an exchange or another wallet. Top up once, invest across any chain.">
          <img src="/art/funding.webp" alt="" loading="lazy" width={1200} height={800} className="bento-generated-art" />
        </BentoCard>
        <BentoCard number="03" title="Choose where your capital goes." body="Tokenized stocks, yield vaults and more from every chain, in one place. Review the asset, fees and limits, then confirm the amount." wide>
          <img src="/art/investments.webp" alt="" loading="lazy" width={1200} height={800} className="bento-generated-art" />
        </BentoCard>
        <BentoCard number="04" title="Shielded before it's invested." body="Once you confirm, your USDC moves into a confidential balance that block explorers can't read. Every investment starts from there, so it's much harder to trace back to you.">
          <img src="/art/shielding.webp" alt="" loading="lazy" width={1200} height={800} className="bento-generated-art" />
        </BentoCard>
        <BentoCard number="05" title="Spread across fresh wallets." body="Each investment lands in one to five new wallets, all controlled by your passkey. No single address shows the full picture, but Gizu shows it to you as one portfolio." wide>
          <img src="/art/fresh-wallets.webp" alt="" loading="lazy" width={1200} height={800} className="bento-generated-art" />
        </BentoCard>
        <BentoCard number="06" title="Follow your position." body="Every holding, across every wallet and chain, in one live portfolio. Check in anytime and make your next move.">
          <WalletArt kind="shield" />
        </BentoCard>
      </div>
    </section>
  )
}
