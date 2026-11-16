import type { PointerEvent, ReactNode } from 'react'
import { motion, useReducedMotion } from 'framer-motion'

/** Adapted from Wildjury's Otari bento: pointer-lit surface and masked border. */
export default function BentoCard({
  number, title, body, children, wide = false,
}: {
  number: string
  title: string
  body: string
  children: ReactNode
  wide?: boolean
}) {
  const reduce = useReducedMotion()
  const fromLeft = Number(number) % 2 === 1
  const track = (event: PointerEvent<HTMLElement>) => {
    if (event.pointerType !== 'mouse') return
    const rect = event.currentTarget.getBoundingClientRect()
    event.currentTarget.style.setProperty('--mx', `${event.clientX - rect.left}px`)
    event.currentTarget.style.setProperty('--my', `${event.clientY - rect.top}px`)
  }

  return (
    <motion.article
      className={`bento-tile ${wide ? 'bento-wide' : ''}`} onPointerMove={track}
      initial={reduce ? false : { opacity: 0, x: fromLeft ? -48 : 48 }}
      whileInView={{ opacity: 1, x: 0 }}
      viewport={{ once: true, amount: 0.12, margin: '0px 0px -40px 0px' }}
      transition={{ duration: reduce ? 0 : 0.75, ease: [0.22, 1, 0.36, 1] }}
      data-reveal-direction={fromLeft ? 'left' : 'right'}
    >
      <div aria-hidden="true" className="bento-art">{children}</div>
      <div className="bento-copy">
        <span className="font-mono text-[11px] text-neon/70">{number}</span>
        <h3 className="mt-4 text-[23px] font-medium leading-tight tracking-[-0.025em]">{title}</h3>
        <p className="mt-3 max-w-[54ch] text-[15px] leading-[1.75] text-white/55">{body}</p>
      </div>
    </motion.article>
  )
}
