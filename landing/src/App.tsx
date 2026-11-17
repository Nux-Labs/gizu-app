import Nav from './components/Nav'
import Hero from './components/Hero'
import HowItWorks from './components/HowItWorks'
import Faq from './components/Faq'
import Footer from './components/Footer'
import AppScreens from './components/AppScreens'
import SupportedNetworks from './components/SupportedNetworks'
import { AnimatePresence, MotionConfig } from 'framer-motion'
import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import Splash, { shouldShowIntro } from './components/Splash'
import { useScrollAnimations } from './useScrollAnimations'
import { setScrollPaused } from './smoothScroll'
import EarlyAccessDialog from './components/EarlyAccessDialog'
import type { AccessPlatform, AccessRequest, AccessSource } from './services/earlyAccess'

export default function App() {
  const [intro, setIntro] = useState(shouldShowIntro)
  const [access, setAccess] = useState<AccessRequest | null>(null)
  const openAccess = (source: AccessSource, platform?: AccessPlatform) => setAccess({ source, platform })
  const content = useRef<HTMLDivElement>(null)
  const completeIntro = useCallback(() => setIntro(false), [])
  useScrollAnimations(content)
  useLayoutEffect(() => {
    if (content.current) content.current.inert = intro
    setScrollPaused(intro)
    return () => setScrollPaused(false)
  }, [intro])
  return (
    <MotionConfig reducedMotion="user">
      <AnimatePresence>{intro && <Splash key="intro" onComplete={completeIntro} />}</AnimatePresence>
      <div ref={content}>
        <a href="#money" className="sr-only fixed left-4 top-4 z-[60] rounded-lg bg-neon px-5 py-3 text-ink focus:not-sr-only">Skip to how it works</a>
        <Nav />
        <main>
          <Hero paused={intro || !!access} onEarlyAccess={openAccess} />
          <SupportedNetworks />
          <HowItWorks />
          <AppScreens />
          <Faq />
        </main>
        <Footer onEarlyAccess={() => openAccess('landing-footer')} />
      </div>
      <AnimatePresence>{access && <EarlyAccessDialog key="early-access" request={access} onClose={() => setAccess(null)} />}</AnimatePresence>
    </MotionConfig>
  )
}
