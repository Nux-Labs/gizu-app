import { useRef, type ReactNode } from 'react'
import { motion, useAnimation, useReducedMotion } from 'framer-motion'

type Props = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  children?: ReactNode
  className?: string
}

export default function BubbleUpButton({ children, className = '', disabled, ...props }: Props) {
  const controls = useAnimation()
  const reduce = useReducedMotion()
  const intent = useRef(false)

  const fill = async () => {
    if (disabled) return
    intent.current = true
    await controls.start({
      clipPath: 'ellipse(120% 120% at 50% 100%)',
      transition: reduce ? { duration: 0 } : { type: 'spring', stiffness: 300, damping: 32 },
    })
  }

  const drain = async () => {
    intent.current = false
    await controls.start({
      clipPath: 'ellipse(120% 120% at 50% -120%)',
      transition: reduce ? { duration: 0 } : { type: 'spring', stiffness: 300, damping: 32 },
    })
    if (!intent.current) controls.set({ clipPath: 'ellipse(0% 0% at 50% 100%)' })
  }

  return (
    <button
      type="button"
      onMouseEnter={fill}
      onMouseLeave={drain}
      onFocus={fill}
      onBlur={drain}
      onPointerDown={fill}
      onPointerUp={drain}
      onPointerCancel={drain}
      disabled={disabled}
      className={`relative isolate flex min-h-14 w-full cursor-pointer items-center justify-center overflow-clip rounded-3xl bg-gradient-to-br from-[#bff6fb] to-[#d7ccff] px-5 py-4 text-ink transition-transform active:scale-[0.97] ${
        disabled ? 'cursor-not-allowed opacity-50' : ''
      } ${className}`}
      {...props}
    >
      <motion.div
        animate={controls}
        initial={{ clipPath: 'ellipse(0% 0% at 50% 100%)' }}
        className="absolute inset-0 bg-neon"
        aria-hidden="true"
      />
      <span
        className="relative z-10 flex min-w-0 flex-wrap items-center justify-center gap-2 text-center text-[15px] font-semibold leading-[22px] text-ink"
      >
        {children}
      </span>
    </button>
  )
}
