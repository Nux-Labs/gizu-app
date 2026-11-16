import { motion } from 'framer-motion'
import { ArrowDown } from 'lucide-react'
import AsciiField from './AsciiField'
import PhoneFrame from './PhoneFrame'
import EarlyAccessButton from './EarlyAccessButton'
import type { AccessPlatform, AccessSource } from '../services/earlyAccess'
import MobileDemo from './demo/MobileDemo'
import { useState } from 'react'

// Platform marks (Apple from Simple Icons, CC0). Not the official store badges:
// those may only be used once Gizu is listed on the App Store / Google Play.
const PLATFORMS = [
  {
    name: 'iOS',
    icon: (
      <svg viewBox="0 0 24 24" className="h-[24px] w-[24px] fill-white" aria-hidden="true">
        <path d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701" />
      </svg>
    ),
  },
  {
    name: 'Android',
    icon: (
      <svg viewBox="0 0 24 26" className="h-[24px] w-[22px]" aria-hidden="true">
        <path d="M2 1 13.5 13 2 25Z" fill="#00A0FF" />
        <path d="M2 1 17 10 13.5 13Z" fill="#34A853" />
        <path d="M17 10 22 13 17 16 13.5 13Z" fill="#FBBC04" />
        <path d="M13.5 13 17 16 2 25Z" fill="#EA4335" />
      </svg>
    ),
  },
]

export default function Hero({ paused = false, onEarlyAccess }: { paused?: boolean; onEarlyAccess: (source: AccessSource, platform?: AccessPlatform) => void }) {
  const [revealed, setRevealed] = useState(false)
  return (
    <section id="top" className="relative flex min-h-[100svh] flex-col justify-center pt-28">
      <div className="pointer-events-none absolute inset-0">
        <AsciiField fontSize={11} paused={paused} />
        <div className="absolute inset-0 bg-gradient-to-b from-ink/10 via-ink/35 to-ink" />
      </div>

      <div className="shell relative grid items-center gap-16 pb-32 lg:grid-cols-[1fr_auto] lg:gap-12">
        <div className="text-left">
          <h1 className="text-[clamp(44px,6.2vw,84px)] font-semibold leading-[0.98] tracking-[-0.03em]">
            <motion.span
              initial={{ opacity: 0, y: 28 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.7, delay: 0.15, ease: [0.22, 1, 0.36, 1] }}
              className="block"
            >
              Onchain Investing
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
                  Off the Record
                </span>
              </button>
            </motion.span>
          </h1>

          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, delay: 0.5 }}
            className="mt-11 flex flex-wrap items-center gap-3"
          >
            <EarlyAccessButton onClick={() => onEarlyAccess('landing-hero')} />
            {PLATFORMS.map(({ name, icon }) => (
              <button type="button"
                key={name}
                onClick={() => onEarlyAccess(name === 'iOS' ? 'landing-ios' : 'landing-android', name === 'iOS' ? 'ios' : 'android')}
                aria-label={`Test Gizu on ${name}`}
                className="inline-flex min-h-[52px] items-center gap-2.5 rounded-xl border border-white/10 bg-[#1c1c22] px-4 py-2 text-white transition-colors hover:border-white/30 hover:bg-[#24242c]"
              >
                {icon}
                <span className="flex flex-col text-left leading-none">
                  <span className="text-[10px] text-white/60">Test on</span>
                  <span className="mt-1 text-[16px] font-semibold tracking-tight">{name}</span>
                </span>
              </button>
            ))}
          </motion.div>
        </div>

        <motion.div
          initial={{ opacity: 0, y: 40 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.9, delay: 0.4, ease: [0.22, 1, 0.36, 1] }}
          className="mx-auto w-full max-w-[320px] sm:max-w-[340px] lg:mx-0 lg:w-[340px] lg:self-start"
        >
          <PhoneFrame alt="Interactive Gizu mobile app demo"><MobileDemo /></PhoneFrame>
        </motion.div>
      </div>

      <motion.a
        href="#money"
        aria-label="Scroll to how it works"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.7, delay: 0.9 }}
        className="absolute bottom-8 left-1/2 flex h-11 w-11 -translate-x-1/2 items-center justify-center rounded-full border border-white/15 text-white/60 transition-colors hover:border-white/40 hover:text-white"
      >
        <ArrowDown size={18} strokeWidth={2.2} className="animate-bounce motion-reduce:animate-none" />
      </motion.a>
    </section>
  )
}
