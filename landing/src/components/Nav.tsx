import { motion, useReducedMotion, useScroll, useTransform } from 'framer-motion'
import { DOCS_URL } from '../links'

function Roll({ children }: { children: string }) {
  return <span className="nav-roll"><span>{children}</span><span aria-hidden="true">{children}</span></span>
}

/** Nux Labs' floating navigation and rolling label, in Gizu's visual language. */
export default function Nav() {
  const reduce = useReducedMotion()
  const { scrollY } = useScroll()
  const inset = useTransform(scrollY, [0, 160], [0, 14])
  const width = useTransform(scrollY, [0, 160], ['100%', 'calc(100% - 32px)'])
  const maxWidth = useTransform(scrollY, [0, 160], [1280, 1060])
  const height = useTransform(scrollY, [0, 160], [80, 64])
  const radius = useTransform(scrollY, [0, 160], [0, 16])
  const backgroundColor = useTransform(scrollY, [0, 120], ['rgba(7, 10, 15, 0)', 'rgba(7, 10, 15, 0.96)'])
  const borderColor = useTransform(scrollY, [0, 120], ['rgba(255, 255, 255, 0)', 'rgba(255, 255, 255, 0.09)'])

  return (
    <motion.header className="gizu-nav" style={{ backgroundColor, borderColor, top: reduce ? 12 : inset, width: reduce ? 'calc(100% - 32px)' : width, maxWidth: reduce ? 1060 : maxWidth, borderRadius: reduce ? 16 : radius }}>
      <motion.nav aria-label="Primary" className="gizu-nav-bar" style={{ height: reduce ? 64 : height }}>
        <a href="#top" aria-label="Gizu home" className="gizu-brand"><img src="/gizulogo.svg" alt="" className="h-7 w-auto" /><span>Gizu</span></a>
        <a href={DOCS_URL} className="gizu-nav-docs"><Roll>Documentation</Roll></a>
      </motion.nav>
    </motion.header>
  )
}
