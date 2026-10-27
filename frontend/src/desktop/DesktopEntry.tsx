import { motion } from 'framer-motion'
import type { MouseEventHandler } from 'react'
import { ArrowRight } from 'lucide-react'
import AsciiChameleon from '../chameleon/AsciiChameleon'
import GlitchText from '../components/GlitchText'
import BubbleUpButton from '../components/BubbleUpButton'
import Scramble from '../components/Scramble'

export default function DesktopEntry({
  onTestMobile,
  onRequestAccess,
}: {
  onTestMobile: MouseEventHandler<HTMLButtonElement>
  onRequestAccess: MouseEventHandler<HTMLButtonElement>
}) {
  return (
    <div className="relative flex h-[100dvh] w-full overflow-hidden bg-ink">
      {/* sol: ASCII bukalemun ve slogan */}
      <div className="relative hidden min-w-0 flex-1 flex-col justify-between p-14 lg:flex">
        <div className="pointer-events-none absolute inset-0">
          <AsciiChameleon anchorX={0.58} anchorY={0.25} size={0.12} />
          <div className="absolute inset-0 bg-gradient-to-b from-transparent via-transparent to-ink/90" />
        </div>

        <div className="relative flex items-center gap-3">
          <img src="/gizulogo.svg" alt="" className="h-8 w-auto" />
          <span className="text-[18px] font-medium tracking-tight">Gizu</span>
        </div>

        <div className="relative max-w-[620px]">
          <h1 className="text-[68px] font-semibold leading-[0.98] tracking-tighter">
            <motion.span
              initial={{ opacity: 0, y: 18 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.15, duration: 0.5 }}
              className="block"
            >
              <GlitchText className="text-neon">DeFi</GlitchText>{' '}
              <span className="text-white/55">in</span>
            </motion.span>
            <span className="block">
              {[
                { word: 'Stealth', accent: true },
                { word: 'Mode', accent: false },
              ].map(({ word, accent }, i) => (
                <motion.span
                  key={word}
                  initial={{ opacity: 0, y: 12, filter: 'blur(6px)' }}
                  animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
                  transition={{ delay: 0.85 + i * 0.3, duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
                  className="mr-[0.25em] inline-block"
                >
                  {accent ? (
                    <GlitchText className="text-neon">{word}</GlitchText>
                  ) : (
                    <span className="text-white/55">{word}</span>
                  )}
                </motion.span>
              ))}
            </span>
          </h1>
          <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 1.5 }}
            className="mt-7 max-w-[440px] text-[16px] leading-relaxed text-white/45"
          >
            Curated confidential vaults, settlement in minutes. Your keys stay on your device.
          </motion.p>
        </div>

        <div className="relative font-mono text-[10px] uppercase tracking-[0.35em] text-white/25">
          <Scramble text="invite only" />
        </div>
      </div>

      {/* sag: giris paneli */}
      <div className="relative flex w-full shrink-0 items-center justify-center px-10 lg:w-[520px] lg:border-l lg:border-white/[0.06]">
        <div className="w-full max-w-[380px]">
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
          >
            <h2 className="text-[28px] font-medium tracking-tight">Gizu on mobile</h2>
            <p className="mt-3 text-[14px] leading-relaxed text-white/45">
              Test the native iOS or Android app. Get an invitation to our supported testing experience, or explore the self-testing guide.
            </p>
            <motion.div
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 1.7 }}
              className="mt-8"
            >
              <BubbleUpButton onClick={onTestMobile}>
                Test On Mobile
                <ArrowRight size={18} strokeWidth={2.6} />
              </BubbleUpButton>
            </motion.div>
            <button
              onClick={onRequestAccess}
              className="mt-5 w-full text-center font-mono text-xs uppercase tracking-[0.3em] text-white/35"
            >
              Request access
            </button>
          </motion.div>
        </div>
      </div>
    </div>
  )
}
