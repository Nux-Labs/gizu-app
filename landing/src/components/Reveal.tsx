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
  return (
    <div
      data-reveal-direction={direction}
      data-reveal-delay={delay}
      data-reveal-y={y}
      className={className}
    >
      {children}
    </div>
  )
}
