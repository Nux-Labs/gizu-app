import { lazy, Suspense, useId, useRef } from 'react'
import { LayoutGroup, useInView, useReducedMotion } from 'framer-motion'
import BentoCard from './BentoCard'
import StepVisual, { type VisualKind } from './StepVisual'
import Reveal from './Reveal'

const IllosApiGateway = lazy(() => import('./illustrations/api-gateway').then(module => ({ default: module.IllosApiGateway })))
const IllosCostMeter = lazy(() => import('./illustrations/cost-meter').then(module => ({ default: module.IllosCostMeter })))
const IllosToolCalls = lazy(() => import('./illustrations/tool-calls').then(module => ({ default: module.IllosToolCalls })))

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
      <div className="mb-12 grid items-end gap-6 md:grid-cols-[1.1fr_0.9fr] md:gap-16">
        <Reveal direction="left"><h2 id="how-title" className="text-[clamp(38px,5vw,64px)] font-medium leading-[1.02] tracking-[-0.04em]">How it works.</h2></Reveal>
        <Reveal direction="right"><p className="max-w-[42ch] text-[17px] leading-relaxed text-white/55">From your first deposit to your next investment. A connected flow, with privacy built into the route.</p></Reveal>
      </div>

      <div className="process-bento">
        <BentoCard number="01" title="One passkey. Your wallet." body="Open Gizu with a passkey. Your keys stay on your device, and every transaction starts with your approval." wide>
          <WalletArt kind="wallet" />
        </BentoCard>
        <BentoCard number="02" title="Fund your account." body="Receive USDC and see your available balance. Choose how much to put to work before moving anything.">
          <Suspense fallback={null}><IllosCostMeter className="bento-illustration" /></Suspense>
        </BentoCard>
        <BentoCard number="03" title="Take a private route." body="Confidential credit protects the middle of the route, reducing the direct public link between funding and holdings.">
          <Suspense fallback={null}><IllosApiGateway className="bento-illustration" /></Suspense>
        </BentoCard>
        <BentoCard number="04" title="Separate accounts. Connected experience." body="Supported deposits are distributed across investment accounts controlled by your wallet. Gizu keeps the moving parts together." wide>
          <Suspense fallback={null}><IllosToolCalls className="bento-illustration" /></Suspense>
        </BentoCard>
        <BentoCard number="05" title="Choose where your capital goes." body="Explore supported vaults, review the strategy and curator, and confirm the amount. Know the route, fees and limits before you invest." wide>
          <WalletArt kind="vault" />
        </BentoCard>
        <BentoCard number="06" title="Follow your position." body="See your holdings and operation progress in one place. Supported withdrawals return to private USDC before you make it public.">
          <WalletArt kind="shield" />
        </BentoCard>
      </div>
    </section>
  )
}
