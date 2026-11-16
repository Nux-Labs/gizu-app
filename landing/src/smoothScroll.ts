import gsap from 'gsap'
import Lenis from 'lenis'
import 'lenis/dist/lenis.css'

let lenis: Lenis | undefined

export function scrollToPosition(target: number | HTMLElement, offset = 0) {
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const top = typeof target === 'number' ? target : target.getBoundingClientRect().top + window.scrollY
  if (lenis && !reduce) {
    // Numeric destinations avoid applying CSS scroll-margin/padding a second time.
    lenis.scrollTo(top + offset, { duration: 0.85 })
  } else {
    window.scrollTo({ top: top + offset, behavior: reduce ? 'instant' : 'smooth' })
  }
}

/** Wheel smoothing only. Native touch scrolling and reduced-motion settings stay in control. */
export function startSmoothScroll() {
  const media = window.matchMedia('(prefers-reduced-motion: reduce)')
  const tick = (time: number) => lenis?.raf(time * 1000)
  const sync = () => {
    lenis?.destroy()
    lenis = media.matches ? undefined : new Lenis({ duration: 0.9, smoothWheel: true, anchors: false })
  }
  sync()
  media.addEventListener('change', sync)
  gsap.ticker.add(tick)

  const onClick = (event: MouseEvent) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href^="#"]') : null
    const id = link?.hash.slice(1)
    if (!id) return
    const target = document.getElementById(decodeURIComponent(id))
    if (!target) return
    event.preventDefault()
    history.pushState(null, '', `#${id}`)
    scrollToPosition(target, -88)
    target.tabIndex = -1
    target.focus({ preventScroll: true })
  }
  document.addEventListener('click', onClick)

  return () => {
    document.removeEventListener('click', onClick)
    media.removeEventListener('change', sync)
    gsap.ticker.remove(tick)
    lenis?.destroy()
    lenis = undefined
  }
}
