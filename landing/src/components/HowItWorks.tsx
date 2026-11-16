import { useRef, useState } from 'react'
import { motion, useMotionValueEvent, useScroll } from 'framer-motion'
import { ArrowDown, ArrowLeft, ArrowRight } from 'lucide-react'
import StepVisual, { type VisualKind } from './StepVisual'
import { scrollToPosition } from '../smoothScroll'

type Step = { title: string; body: string; visual: VisualKind; phase: string }

const STEPS: Step[] = [
  {
    title: 'Start with your wallet.',
    body: 'Open Gizu with a passkey. Your keys stay on your device, and you approve the actions that move your funds.',
    visual: 'wallet', phase: 'Your access',
  },
  {
    title: 'One place to fund.',
    body: 'Receive USDC in your funding account. See your available balance before choosing your next investment.',
    visual: 'funding', phase: 'Your access',
  },
  {
    title: 'A more private route.',
    body: 'A confidential middle step reduces the direct public connection between your funding account and your investments.',
    visual: 'route', phase: 'Private routing',
  },
  {
    title: 'Separate investment accounts.',
    body: 'Your positions live in separate accounts, controlled through the same native wallet. One experience, with less public linkage.',
    visual: 'keys', phase: 'Private routing',
  },
  {
    title: 'Choose your amount.',
    body: 'Explore a supported vault and enter how much you want to invest. Review the route, limits and fees before continuing.',
    visual: 'deposit', phase: 'Your investment',
  },
  {
    title: 'Confidential in transit.',
    body: 'Confidential credit protects the private segment of the route. Source funding and destination transfers remain public.',
    visual: 'encrypt', phase: 'Your investment',
  },
  {
    title: 'Distributed with care.',
    body: 'Supported deposits can be distributed across investment accounts. Gizu keeps track of the route and its progress for you.',
    visual: 'batch', phase: 'Your investment',
  },
  {
    title: 'Put your capital to work.',
    body: 'Your deposit enters the selected vault. Review its strategy and curator, and remember that returns vary and capital is at risk.',
    visual: 'vault', phase: 'Your position',
  },
  {
    title: 'Stay close to your position.',
    body: 'Track your holdings in Gizu and choose when to withdraw. Supported withdrawals return to private USDC before you make it public.',
    visual: 'shield', phase: 'Your position',
  },
]

// Short screens and reduced-motion users get a normal, self-paced section.
const SCROLL_STORY = '(min-width: 1024px) and (min-height: 820px) and (prefers-reduced-motion: no-preference)'

export default function HowItWorks() {
  const ref = useRef<HTMLElement>(null)
  const [index, setIndex] = useState(0)
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start start', 'end end'] })

  useMotionValueEvent(scrollYProgress, 'change', (value) => {
    if (window.matchMedia(SCROLL_STORY).matches) {
      setIndex(Math.min(STEPS.length - 1, Math.max(0, Math.floor(value * STEPS.length))))
    }
  })

  const selectStep = (next: number) => {
    if (next < 0 || next >= STEPS.length) return
    if (ref.current && window.matchMedia(SCROLL_STORY).matches) {
      const top = ref.current.getBoundingClientRect().top + window.scrollY
      const travel = ref.current.offsetHeight - window.innerHeight
      scrollToPosition(top + travel * ((next + 0.3) / STEPS.length))
    } else {
      setIndex(next)
    }
  }

  const step = STEPS[index]

  return (
    <section ref={ref} id="money" aria-labelledby="how-title" className="how-story relative scroll-mt-20">
      <div className="how-stage relative flex flex-col justify-center overflow-hidden border-y border-white/[0.07] bg-[#070a10]">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_75%_50%,rgba(124,232,242,0.08),transparent_65%)]" />
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle,rgba(255,255,255,0.045)_1px,transparent_1px)] [background-size:28px_28px]" />
        <div className="shell relative py-12 lg:py-10">
          <div className="flex flex-wrap items-end justify-between gap-5 border-b border-white/10 pb-7">
            <div>
              <p className="eyebrow text-neon/80">How it works</p>
              <h2 id="how-title" className="mt-4 max-w-[22ch] text-[clamp(30px,3.7vw,52px)] font-medium leading-[1.08] tracking-[-0.035em]">
                A little less public.<br />A lot more yours.
              </h2>
            </div>
            <a href="#strategies" className="inline-flex min-h-11 items-center gap-2 text-sm text-white/60 transition-colors hover:text-neon">
              Explore Gizu <ArrowDown size={16} aria-hidden="true" />
            </a>
          </div>
          <div className="grid items-center gap-5 py-7 lg:grid-cols-[0.8fr_1.2fr] lg:gap-12 lg:py-8">
            <div className="order-2 lg:order-1">
              <p className="flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.16em] text-neon/80">
                <span className="h-px w-7 bg-neon/50" /> {step.phase}
              </p>
              <motion.div key={index} initial={{ opacity: 0.6, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }}>
                <h3 id="step-title" className="mt-5 max-w-[15ch] text-[clamp(30px,3.5vw,48px)] font-medium leading-[1.08] tracking-[-0.035em]">{step.title}</h3>
                <p className="mt-5 max-w-[37ch] text-base leading-[1.75] text-white/60 lg:text-[17px]">{step.body}</p>
              </motion.div>
              <div className="mt-7 flex items-center gap-3">
                <button type="button" aria-label="Previous step" disabled={index === 0} onClick={() => selectStep(index - 1)} className="story-arrow">
                  <ArrowLeft size={18} aria-hidden="true" />
                </button>
                <span className="min-w-16 text-center font-mono text-xs tabular-nums text-white/60">
                  <span className="text-white">{String(index + 1).padStart(2, '0')}</span> / {String(STEPS.length).padStart(2, '0')}
                </span>
                <button type="button" aria-label="Next step" disabled={index === STEPS.length - 1} onClick={() => selectStep(index + 1)} className="story-arrow">
                  <ArrowRight size={18} aria-hidden="true" />
                </button>
              </div>
            </div>
            <div aria-hidden="true" className="story-visual order-1 min-w-0 rounded-[28px] border border-white/[0.08] bg-ink/50 lg:order-2">
              <StepVisual key={step.visual} kind={step.visual} on />
            </div>
          </div>
          <nav aria-label="How it works steps" className="flex gap-1.5 overflow-x-auto border-t border-white/10 pt-5">
            {STEPS.map((item, i) => (
              <button key={item.visual} type="button" aria-label={`Step ${i + 1}: ${item.title}`} aria-current={index === i ? 'step' : undefined} onClick={() => selectStep(i)} className="group min-h-11 min-w-11 flex-1 py-2 text-left">
                <span className={`block h-1 rounded-full transition-colors duration-300 ${i === index ? 'bg-neon shadow-[0_0_14px_#7ce8f240]' : i < index ? 'bg-neon/35' : 'bg-white/10 group-hover:bg-white/30'}`} />
                <span className={`mt-3 block font-mono text-[10px] ${index === i ? 'text-neon' : 'text-white/40'}`}>{String(i + 1).padStart(2, '0')}</span>
              </button>
            ))}
          </nav>
          <p className="story-scroll-hint mt-2 hidden items-center gap-2 font-mono text-[10px] uppercase tracking-widest text-white/40"><ArrowDown size={12} aria-hidden="true" /> Scroll to explore, or choose a step</p>
        </div>
      </div>
    </section>
  )
}
