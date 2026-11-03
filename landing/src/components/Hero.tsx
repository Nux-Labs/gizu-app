import { motion } from 'framer-motion'
import { ArrowUpRight } from 'lucide-react'
import AsciiField from './AsciiField'

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
              <span className="group inline-block cursor-default">
                <span className="text-gradient inline-block blur-[10px] transition-[filter,opacity] duration-700 ease-out group-hover:blur-0 opacity-70 group-hover:opacity-100 motion-reduce:blur-0">
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
            Encrypted balances. Encrypted positions. Encrypted returns.
          </motion.p>

          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, delay: 0.62 }}
            className="mt-11 flex flex-wrap items-center justify-center gap-3"
          >
            <a href="#top" className="btn-neon">
              Explore the app
              <ArrowUpRight size={17} strokeWidth={2.4} />
            </a>
            <a href="#money" className="btn-ghost">How it works</a>
          </motion.div>
        </div>

      </div>
    </section>
  )
}
