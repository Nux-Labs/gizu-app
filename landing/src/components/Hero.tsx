import { motion } from 'framer-motion'
import { ArrowUpRight } from 'lucide-react'
import AsciiField from './AsciiField'
import { APP_URL } from '../links'
import { useState } from 'react'

export default function Hero({ paused = false }: { paused?: boolean }) {
  const [revealed, setRevealed] = useState(false)
  return (
    <section id="top" className="relative flex min-h-[100svh] flex-col justify-center pt-28">
      <div className="pointer-events-none absolute inset-0">
        <AsciiField fontSize={11} paused={paused} />
        <div className="absolute inset-0 bg-gradient-to-b from-ink/10 via-ink/35 to-ink" />
      </div>

      <div className="shell relative pb-32 text-center">
        <div className="mx-auto max-w-[900px]">
          <h1 className="text-[clamp(44px,7vw,84px)] font-semibold leading-[0.98] tracking-[-0.03em]">
            <motion.span
              initial={{ opacity: 0, y: 28 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.7, delay: 0.15, ease: [0.22, 1, 0.36, 1] }}
              className="block"
            >
              Your DeFi investments.
            </motion.span>
            <motion.span
              initial={{ opacity: 0, y: 28 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.7, delay: 0.32, ease: [0.22, 1, 0.36, 1] }}
              className="block"
            >
              {/* the promise stays encrypted until you look at it */}
              <button
                type="button"
                aria-label="Reveal privacy message"
                aria-pressed={revealed}
                onClick={() => setRevealed(value => !value)}
                className="group inline-block rounded-lg text-left"
              >
                <span className={`text-gradient inline-block transition-[filter,opacity] duration-700 ease-out group-hover:blur-0 group-hover:opacity-100 group-focus-visible:blur-0 group-focus-visible:opacity-100 motion-reduce:blur-0 ${revealed ? 'blur-0 opacity-100' : 'blur-[10px] opacity-70'}`}>
                  Now private.
                </span>
              </button>
            </motion.span>
          </h1>

          <motion.p
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, delay: 0.5 }}
            className="mx-auto mt-7 max-w-[52ch] text-[18px] leading-relaxed text-white/55"
          >
            Your wallet. Your investments. A more private way to move between them.
          </motion.p>

          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, delay: 0.62 }}
            className="mt-11 flex flex-wrap items-center justify-center gap-3"
          >
            <a href={APP_URL} className="btn-neon">
              Explore the app
              <ArrowUpRight size={17} strokeWidth={2.4} />
            </a>
            <a href="#money" className="btn-ghost">How it works</a>
          </motion.div>
          <div className="mt-12 flex flex-wrap items-center justify-center gap-x-7 gap-y-3 font-mono text-[11px] text-white/50">
            {['Passkey access', 'Keys on your device', 'Private routing'].map((label) => (
              <span key={label}>{label}</span>
            ))}
          </div>
        </div>

      </div>
    </section>
  )
}
