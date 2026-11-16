import { useLayoutEffect, type RefObject } from 'react'
import gsap from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'

gsap.registerPlugin(ScrollTrigger)

/** Scroll entrances share Lenis' GSAP clock; local UI interactions stay independent. */
export function useScrollAnimations(scope: RefObject<HTMLElement>) {
  useLayoutEffect(() => {
    if (!scope.current) return
    const media = gsap.matchMedia()
    media.add('(prefers-reduced-motion: no-preference)', () => {
      scope.current!.querySelectorAll<HTMLElement>('[data-reveal-direction]').forEach(element => {
        const { revealDirection, revealDelay = '0', revealDistance = '44', revealY = '24' } = element.dataset
        const distance = Number(revealDistance)
        gsap.fromTo(element, {
          opacity: 0,
          x: revealDirection === 'left' ? -distance : revealDirection === 'right' ? distance : 0,
          y: revealDirection === 'up' ? Number(revealY) : 0,
        }, {
          opacity: 1, x: 0, y: 0,
          duration: 0.8,
          delay: Number(revealDelay),
          ease: 'power3.out',
          clearProps: 'opacity,transform',
          scrollTrigger: { trigger: element, start: 'top bottom-=40', once: true },
        })
      })
    }, scope)

    // Accordion and font/layout changes can move triggers after initial load.
    let refreshFrame = 0
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(refreshFrame)
      refreshFrame = requestAnimationFrame(() => ScrollTrigger.refresh())
    })
    observer.observe(scope.current)
    return () => {
      observer.disconnect()
      cancelAnimationFrame(refreshFrame)
      media.revert()
    }
  }, [scope])
}
