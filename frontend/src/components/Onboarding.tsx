import { motion } from 'framer-motion'
import type { MouseEventHandler } from 'react'
import { ArrowRight } from 'lucide-react'
import GlitchText from './GlitchText'
import GradientWaves from './GradientWaves'
import BubbleUpButton from './BubbleUpButton'

export default function Onboarding({
  onTestMobile,
  onRequestAccess,
}: {
  onTestMobile: MouseEventHandler<HTMLButtonElement>
  onRequestAccess: MouseEventHandler<HTMLButtonElement>
}) {
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div className="pointer-events-none absolute inset-0">
        <GradientWaves
          horizonColor="#070a10"
          waveColor="#3fa9b5"
          crestColor="#b9a6ff"
          speed={0.22}
          amplitude={1.9}
          waveScale={0.45}
          waveRatio={0.9}
          swell={26}
          turbulence={11}
          tilt={1.11}
          zoom={1}
          height={5.5}
          fogDepth={18}
          detail="high"
          brightness={1}
          opacity={1}
          mouseInteraction={false}
          grain
          grainIntensity={0.03}
        />
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-transparent via-ink/25 to-ink" />
      </div>

      <div className="relative flex min-h-0 flex-1 flex-col px-6 pb-10 pt-16">
        <motion.div
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex items-center gap-2.5"
        >
          <img src="/gizulogo.svg" alt="" className="h-7 w-auto" />
          <span className="text-[16px] font-medium tracking-tight">Gizu</span>
        </motion.div>

        <div className="mt-auto">
          <h1 className="text-[46px] font-semibold leading-[1.0] tracking-tighter">
            <motion.span
              initial={{ opacity: 0, y: 16 }}
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
                  initial={{ opacity: 0, y: 10, filter: 'blur(6px)' }}
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
            className="mt-6 max-w-[310px] text-[15px] leading-relaxed text-white/45"
          >
            Curated confidential vaults, settlement in minutes. Your keys stay on your device.
          </motion.p>
        </div>

        <div className="mt-10">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 1.7 }}
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
        </div>
      </div>
    </div>
  )
}
