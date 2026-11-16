import { motion, useReducedMotion } from 'framer-motion'
import type { ReactNode } from 'react'

type Props = {
  children: ReactNode
  delay?: number
  className?: string
  y?: number
  direction?: 'left' | 'right' | 'up'
}

/** One scroll reveal used everywhere, so the page has a single motion language. */
export default function Reveal({ children, delay = 0, className = '', y = 24, direction = 'left' }: Props) {
  const reduce = useReducedMotion()
  return (
    <motion.div
      initial={reduce ? false : { opacity: 0, x: direction === 'left' ? -44 : direction === 'right' ? 44 : 0, y: direction === 'up' ? y : 0 }}
      whileInView={{ opacity: 1, x: 0, y: 0 }}
      viewport={{ once: true, amount: 0.12, margin: '0px 0px -40px 0px' }}
      transition={{ duration: reduce ? 0 : 0.7, delay: reduce ? 0 : delay, ease: [0.22, 1, 0.36, 1] }}
      data-reveal-direction={direction}
      className={className}
    >
      {children}
    </motion.div>
  )
}
