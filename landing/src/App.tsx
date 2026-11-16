import Nav from './components/Nav'
import Hero from './components/Hero'
import HowItWorks from './components/HowItWorks'
import Faq from './components/Faq'
import Footer from './components/Footer'
import Features from './components/Features'
import { AnimatePresence, MotionConfig } from 'framer-motion'
import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import Splash, { shouldShowIntro } from './components/Splash'

export default function App() {
  const [intro, setIntro] = useState(shouldShowIntro)
  const content = useRef<HTMLDivElement>(null)
  const completeIntro = useCallback(() => setIntro(false), [])
  useLayoutEffect(() => {
    if (content.current) content.current.inert = intro
  }, [intro])
  return (
    <MotionConfig reducedMotion="user">
      <AnimatePresence>{intro && <Splash key="intro" onComplete={completeIntro} />}</AnimatePresence>
      <div ref={content}>
        <a href="#money" className="sr-only fixed left-4 top-4 z-[60] rounded-lg bg-neon px-5 py-3 text-ink focus:not-sr-only">Skip to how it works</a>
        <Nav />
        <main>
          <Hero paused={intro} />
          <HowItWorks />
          <Features />
          <Faq />
        </main>
        <Footer />
      </div>
    </MotionConfig>
  )
}
