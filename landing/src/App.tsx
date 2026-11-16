import Nav from './components/Nav'
import Hero from './components/Hero'
import HowItWorks from './components/HowItWorks'
import Faq from './components/Faq'
import Footer from './components/Footer'
import Features from './components/Features'
import { MotionConfig } from 'framer-motion'

export default function App() {
  return (
    <MotionConfig reducedMotion="user">
      <a href="#money" className="sr-only fixed left-4 top-4 z-[60] rounded-full bg-neon px-5 py-3 text-ink focus:not-sr-only">Skip to how it works</a>
      <Nav />
      <main>
        <Hero />
        <HowItWorks />
        <Features />
        <Faq />
      </main>
      <Footer />
    </MotionConfig>
  )
}
