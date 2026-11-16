import { motion } from 'framer-motion'
import { ArrowUpRight } from 'lucide-react'
import AsciiField from './AsciiField'
import { APP_URL } from '../links'

export default function Hero() {
  return (
    <section id="top" className="relative flex min-h-[100svh] flex-col justify-center pt-28">
      <div className="pointer-events-none absolute inset-0">
        <AsciiField fontSize={11} />
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
              <span className="inline-block">
                <span className="text-gradient inline-block">
                  Now private.
                </span>
              </span>
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
          <div className="mt-12 flex flex-wrap items-center justify-center gap-x-6 gap-y-3 font-mono text-[11px] text-white/50">
            {['Passkey access', 'Keys on your device', 'Private routing'].map((label) => (
              <span key={label} className="inline-flex items-center gap-2"><span className="h-1 w-1 rounded-full bg-neon/70" />{label}</span>
            ))}
          </div>
        </div>

      </div>
    </section>
  )
}
