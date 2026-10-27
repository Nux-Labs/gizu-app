import { motion } from 'framer-motion'
import { Check, X } from 'lucide-react'
import Scramble from './Scramble'
import ParticleDotOrb from './ParticleDotOrb'
import useIsDesktop from '../useIsDesktop'

export type SignState = 'signing' | 'done' | 'failed'

export default function SignOverlay({
  state,
  doneLabel,
  detail,
  onCancel,
  tone = 'positive',
}: {
  state: SignState
  doneLabel: string
  detail?: string
  onCancel?: () => void
  tone?: 'positive' | 'negative'
}) {
  const negative = tone === 'negative'
  const accent = negative ? '#c4576a' : '#7ce8f2'
  const isDesktop = useIsDesktop()

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-ink/95 backdrop-blur-xl"
    >
      <ParticleDotOrb
        className="pointer-events-none absolute inset-0 h-full w-full"
        speed={1.4}
        color={accent}
        distance={isDesktop ? 17 : 20}
        spread={isDesktop ? 14 : 11}
        dotScale={isDesktop ? 3 : 2.4}
        count={isDesktop ? 420 : 560}
        burst={state !== 'signing'}
      />

      {/* tik/carpi kurenin merkezinde */}
      {state !== 'signing' && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <motion.span
            initial={{ scale: 0.4, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ delay: 0.55, type: 'spring', stiffness: 220, damping: 18 }}
          >
            {state === 'done' ? (
              <Check size={56} strokeWidth={2} style={{ color: accent }} />
            ) : (
              <X size={56} strokeWidth={2} className="text-rose-400" />
            )}
          </motion.span>
        </div>
      )}

      <div className="absolute inset-x-0 bottom-24 flex flex-col items-center">
        <div
          className={`font-mono text-[11px] uppercase tracking-[0.3em] ${
            state === 'failed' ? 'text-rose-400/80' : 'text-neon/80'
          }`}
        >
          {state === 'signing' && <Scramble text="signing with passkey" />}
          {state === 'done' && <Scramble text={doneLabel} />}
          {state === 'failed' && <Scramble text="signature rejected" />}
        </div>

        {state === 'done' && detail && (
          <div className="mt-3 font-mono text-[10px] text-white/25">{detail}</div>
        )}
      </div>

      {state === 'signing' && onCancel && (
        <button
          onClick={onCancel}
          className="absolute inset-x-0 bottom-12 font-mono text-[10px] uppercase tracking-[0.3em] text-white/35"
        >
          cancel
        </button>
      )}
    </motion.div>
  )
}
