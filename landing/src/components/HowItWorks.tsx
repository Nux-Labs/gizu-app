import { useEffect, useRef, useState } from 'react'
import { motion, useMotionValueEvent, useScroll, useSpring, useTransform } from 'framer-motion'
import StepVisual, { type VisualKind } from './StepVisual'

type Step = {
  title: string
  body: string
  visual: VisualKind
}

const STEPS: Step[] = [
  {
    title: 'Your wallet',
    body: 'Connect the wallet you already use. Nothing about it changes and nothing leaves it yet.',
    visual: 'wallet',
  },
  {
    title: 'Funding account',
    body: 'Your balance lands on a funding account that only your passkey controls.',
    visual: 'funding',
  },
  {
    title: 'Confidential transfer',
    body: 'The same address keeps the value, only now nobody can read what it holds.',
    visual: 'route',
  },
  {
    title: 'Anonym invested accounts',
    body: 'Separate accounts hold your positions, all derived from the same passkey.',
    visual: 'keys',
  },
  {
    title: 'Your deposit',
    body: 'You choose an amount. Nothing else about you is attached to it.',
    visual: 'deposit',
  },
  {
    title: 'Encryption',
    body: 'The amount is encrypted before it touches a vault, and stays encrypted on chain.',
    visual: 'encrypt',
  },
  {
    title: 'Combined with other deposits',
    body: 'One deposit is split across anonym invested accounts, so no entry traces back to you.',
    visual: 'batch',
  },
  {
    title: 'Curated vault',
    body: 'The batch enters a curated strategy with a named curator and a published mandate.',
    visual: 'vault',
  },
  {
    title: 'Your anonym position',
    body: 'You hold anonym shares. Only you can read the balance, the yield and the exit.',
    visual: 'shield',
  },
]

/** Mounts the visual at rest, then lets it play, so every step animates.
 *  The shared carrier inside each visual morphs into the next one. */
function Frame({ visual, index }: { visual: VisualKind; index: number }) {
  const [on, setOn] = useState(false)

  // the box finishes gliding before anything inside it starts
  useEffect(() => {
    const id = window.setTimeout(() => setOn(true), 520)
    return () => window.clearTimeout(id)
  }, [index])

  return <StepVisual kind={visual} on={on} />
}

export default function HowItWorks() {
  const ref = useRef<HTMLElement>(null)
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start start', 'end end'] })
  const progress = useSpring(scrollYProgress, { stiffness: 140, damping: 30, mass: 0.4 })
  const [index, setIndex] = useState(0)

  useMotionValueEvent(scrollYProgress, 'change', (v) => {
    setIndex(Math.min(STEPS.length - 1, Math.max(0, Math.floor(v * STEPS.length))))
  })

  // the room behind the stage drifts, so it never reads as flat black
  const glowX = useTransform(progress, [0, 1], ['-18%', '18%'])
  const step = STEPS[index]

  return (
    <section
      ref={ref}
      id="money"
      className="relative"
      style={{ height: `${STEPS.length * 95 + 60}vh` }}
    >
      <div className="sticky top-0 flex h-[100svh] flex-col overflow-hidden">
        {/* depth behind everything */}
        <div className="pointer-events-none absolute inset-0 bg-[#07090e]" />
        <motion.div
          style={{ x: glowX }}
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(55%_45%_at_50%_45%,rgba(124,232,242,0.1),transparent_70%)]"
        />
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle,rgba(255,255,255,0.05)_1px,transparent_1px)] opacity-40 [background-size:26px_26px]" />
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(75%_60%_at_50%_50%,transparent,#04060a)]" />

        <div className="shell relative pt-24 text-center md:pt-28">
          <p className="eyebrow">How it works</p>
          <h2 className="mx-auto mt-3 max-w-[22ch] text-[clamp(24px,3vw,38px)] font-semibold leading-[1.05] tracking-[-0.025em]">
            From your wallet to an anonym position
          </h2>
        </div>

        <div className="shell relative flex flex-1 flex-col items-center justify-center gap-6 pb-14">
          <Frame key={index} visual={step.visual} index={index} />

          <div key={`text-${index}`} className="text-center">
            <motion.div
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.75, ease: [0.22, 1, 0.36, 1] }}
            >
              <h3 className="text-[clamp(24px,2.8vw,36px)] font-semibold leading-[1.1] tracking-[-0.02em]">
                {step.title}
              </h3>
              <p className="mx-auto mt-3 max-w-[46ch] text-[15px] leading-relaxed text-white/45 md:text-[17px]">
                {step.body}
              </p>
            </motion.div>
          </div>
        </div>
      </div>
    </section>
  )
}
