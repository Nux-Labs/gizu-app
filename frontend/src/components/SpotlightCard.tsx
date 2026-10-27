import { useState, type ReactNode } from 'react'
import { motion, useMotionTemplate, useMotionValue, useReducedMotion } from 'framer-motion'

// portfolio/registry/cankatui/spotlight-card uyarlamasi (cn ve motion/react bagimliligi cikarildi)
export default function SpotlightCard({
  children,
  className = '',
  contentClassName = '',
  spotlightColor = 'rgba(124,232,242,0.12)',
  spotlightSize = 260,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & {
  children: ReactNode
  contentClassName?: string
  spotlightColor?: string
  spotlightSize?: number
}) {
  const reduce = useReducedMotion()
  const mouseX = useMotionValue(-spotlightSize)
  const mouseY = useMotionValue(-spotlightSize)
  const [moved, setMoved] = useState(false)

  const onMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (reduce) return
    const rect = e.currentTarget.getBoundingClientRect()
    mouseX.set(e.clientX - rect.left)
    mouseY.set(e.clientY - rect.top)
    if (!moved) setMoved(true)
  }

  const background = useMotionTemplate`radial-gradient(${spotlightSize}px circle at ${mouseX}px ${mouseY}px, ${spotlightColor}, transparent 80%)`

  return (
    <div
      onMouseMove={onMove}
      onMouseLeave={() => setMoved(false)}
      className={`group relative overflow-hidden rounded-2xl border border-white/[0.09] bg-[rgba(8,12,18,0.84)] backdrop-blur-[14px] ${className}`}
      {...props}
    >
      <motion.div
        aria-hidden
        className="pointer-events-none absolute inset-0 transition-opacity duration-300"
        style={{ background, opacity: moved ? 1 : 0 }}
      />
      <div className={`relative ${contentClassName}`}>{children}</div>
    </div>
  )
}
