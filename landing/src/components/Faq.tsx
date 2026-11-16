import { useRef, useState } from 'react'
import {
  AnimatePresence,
  motion,
  useScroll,
  useSpring,
  useTransform,
  type MotionValue,
} from 'framer-motion'
import { Plus } from 'lucide-react'
import Reveal from './Reveal'

const ITEMS = [
  {
    q: 'How do you make my investments private?',
    a: 'Gizu uses confidential routing and separate investment accounts to reduce the direct public connection between your funding wallet and your holdings. Your passkey controls access, and you approve transactions on your device.',
  },
  {
    q: 'What can other people see?',
    a: 'Source funding and destination transfers remain public. Confidential credit protects the middle segment, while providers can observe parts of the route. Timing and amounts can still reveal relationships.',
  },
  {
    q: 'Who controls my money?',
    a: 'Your passkey controls your account. You authorize investments and withdrawals.',
  },
  {
    q: 'Where do returns come from?',
    a: 'The underlying strategy of your selected vault. Review its curator, assets and risks before investing. Returns vary and are not guaranteed.',
  },
  {
    q: 'How long does it take?',
    a: 'Deposits and private withdrawals settle in batches. The app shows the expected timing for your chosen investment.',
  },
  {
    q: 'Can I lose money?',
    a: 'Yes. Encryption protects financial information; it does not remove investment risk.',
  },
]

/** The timeline spine keeps running here: each rule fills out from the middle
 *  as the page scrolls past it. */
function RuleFill({ p, from, to }: { p: MotionValue<number>; from: number; to: number }) {
  const scaleX = useTransform(p, [from, to], [0, 1], { clamp: true })
  return (
    <motion.span
      style={{ scaleX }}
      className="pointer-events-none absolute inset-x-0 top-0 h-px origin-center bg-gradient-to-r from-neon/40 via-neon to-neon/40"
    />
  )
}

export default function Faq() {
  const [open, setOpen] = useState<number | null>(0)
  const listRef = useRef<HTMLDivElement>(null)
  const { scrollYProgress } = useScroll({
    target: listRef,
    offset: ['start 85%', 'end 60%'],
  })
  const p = useSpring(scrollYProgress, { stiffness: 120, damping: 28, mass: 0.4 })
  const step = 1 / (ITEMS.length + 1)

  return (
    <section id="faq" className="shell scroll-mt-28 py-24 md:py-32">
      <div className="grid gap-12 lg:grid-cols-[0.8fr_1.2fr]">
        <Reveal direction="left">
          <h2 className="text-[clamp(32px,4.4vw,52px)] font-semibold leading-[1.02] tracking-[-0.025em]">
            FAQ
          </h2>
        </Reveal>

        <div ref={listRef} className="relative border-b border-white/[0.07]">
          {ITEMS.map((item, i) => {
            const isOpen = open === i
            return (
              <Reveal key={item.q} direction={i % 2 ? 'left' : 'right'} delay={0.04}>
                <div className="relative border-t border-white/[0.07]">
                  <RuleFill p={p} from={i * step} to={(i + 1) * step} />
                </div>
                <button
                  type="button"
                  id={`faq-question-${i}`}
                  aria-expanded={isOpen}
                  aria-controls={`faq-answer-${i}`}
                  onClick={() => setOpen(isOpen ? null : i)}
                  className="flex w-full items-start gap-6 py-7 text-left"
                >
                  <span className="flex-1 text-[19px] font-medium leading-snug">{item.q}</span>
                  <motion.span
                    animate={{ rotate: isOpen ? 45 : 0 }}
                    transition={{ duration: 0.25 }}
                    className={`mt-0.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border ${
                      isOpen ? 'border-neon/40 text-neon' : 'border-white/10 text-white/40'
                    }`}
                  >
                    <Plus size={16} />
                  </motion.span>
                </button>

                <div id={`faq-answer-${i}`} role="region" aria-labelledby={`faq-question-${i}`}>
                <AnimatePresence initial={false}>
                  {isOpen && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
                      className="overflow-hidden"
                    >
                      <p className="max-w-[62ch] pb-8 pr-4 text-[16px] leading-relaxed text-white/60 sm:pr-14">
                        {item.a}
                      </p>
                    </motion.div>
                  )}
                </AnimatePresence>
                </div>
              </Reveal>
            )
          })}
          <div className="relative">
            <RuleFill p={p} from={ITEMS.length * step} to={1} />
          </div>
        </div>
      </div>
    </section>
  )
}
