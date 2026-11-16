import { useRef, useState, type MouseEvent } from 'react'
import { AnimatePresence, MotionConfig } from 'framer-motion'
import Shell from './components/Shell'
import Onboarding from './components/Onboarding'
import RequestAccess from './components/RequestAccess'
import TestOnMobile from './components/TestOnMobile'
import useIsDesktop from './useIsDesktop'
import DesktopEntry from './desktop/DesktopEntry'

export default function App() {
  const isDesktop = useIsDesktop()
  const [testing, setTesting] = useState(false)
  const [requesting, setRequesting] = useState(false)
  const testTrigger = useRef<HTMLButtonElement | null>(null)
  const requestTrigger = useRef<HTMLButtonElement | null>(null)
  const entryProps = {
    onTestMobile: (event: MouseEvent<HTMLButtonElement>) => {
      testTrigger.current = event.currentTarget
      setTesting(true)
    },
    onRequestAccess: (event: MouseEvent<HTMLButtonElement>) => {
      requestTrigger.current = event.currentTarget
      setRequesting(true)
    },
  }

  return (
    <MotionConfig reducedMotion="user">
      {isDesktop ? (
        <DesktopEntry {...entryProps} />
      ) : (
        <Shell>
          <Onboarding {...entryProps} />
        </Shell>
      )}
      {testing && (
        <TestOnMobile onClose={() => setTesting(false)} returnFocusTo={testTrigger.current} />
      )}
      <AnimatePresence>
        {requesting && (
          <RequestAccess
            variant={isDesktop ? 'modal' : 'sheet'}
            onClose={() => setRequesting(false)}
            returnFocusTo={requestTrigger.current}
          />
        )}
      </AnimatePresence>
    </MotionConfig>
  )
}
