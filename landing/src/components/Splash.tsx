import { useEffect } from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import AsciiChameleon from '../chameleon/AsciiChameleon'

const SESSION_KEY = 'gizu-intro-seen'

export function shouldShowIntro() {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || window.location.hash) return false
  try { return sessionStorage.getItem(SESSION_KEY) !== 'yes' } catch { return true }
}

export default function Splash({ onComplete }: { onComplete: () => void }) {
  const reduce = useReducedMotion()
  useEffect(() => {
    try { sessionStorage.setItem(SESSION_KEY, 'yes') } catch { /* Private storage may be unavailable. */ }
    if (reduce) { onComplete(); return }
    const timer = window.setTimeout(onComplete, 1700)
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') onComplete() }
    document.addEventListener('keydown', escape)
    return () => { window.clearTimeout(timer); document.removeEventListener('keydown', escape) }
  }, [onComplete, reduce])

  return (
    <motion.div className="gizu-splash" initial={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: reduce ? 0 : 0.4 }}>
      <div className="w-full max-w-[520px] px-6 text-center">
        <motion.div aria-hidden="true" className="h-[240px] w-full sm:h-[280px]" initial={{ opacity: 0, clipPath: 'inset(0 100% 0 0)' }} animate={{ opacity: 1, clipPath: 'inset(0 0% 0 0)' }} transition={{ duration: 1.1, ease: [0.22, 1, 0.36, 1] }}>
          <AsciiChameleon grid={false} anchorY={0.52} size={0.2} />
        </motion.div>
        <motion.p className="-mt-2 text-[30px] font-medium tracking-[-0.04em]" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.25, duration: 0.6 }}>Gizu</motion.p>
      </div>
      <button type="button" onClick={onComplete} className="absolute bottom-8 inline-flex min-h-11 items-center px-5 text-xs text-white/40 transition-colors hover:text-white">Skip intro</button>
    </motion.div>
  )
}
