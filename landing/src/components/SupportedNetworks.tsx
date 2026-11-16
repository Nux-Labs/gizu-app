import { useLayoutEffect, useRef } from 'react'
import gsap from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import Reveal from './Reveal'

gsap.registerPlugin(ScrollTrigger)

const GROUPS = [
  {
    title: 'Chains',
    items: [
      { name: 'Ethereum', logo: '/logos/ethereum.svg' },
      { name: 'Monad', logo: '/logos/monad.png' },
      { name: 'Robinhood Chain', logo: '/logos/robinhood-chain.svg' }
    ]
  },
  {
    title: 'Protocols',
    items: [
      { name: 'Morpho', logo: '/logos/morpho.png' },
      { name: 'Curvance', logo: '/logos/curvance.png' },
      { name: 'Aave', logo: '/logos/aave.png' }
    ]
  }
]

export default function SupportedNetworks() {
  const section = useRef<HTMLElement>(null)
  useLayoutEffect(() => {
    const media = gsap.matchMedia()
    media.add(
      '(prefers-reduced-motion: no-preference)',
      () => {
        section
          .current!.querySelectorAll<HTMLElement>('.network-track')
          .forEach((track, index) => {
            gsap.fromTo(
              track,
              { xPercent: index ? -24 : -5 },
              {
                xPercent: index ? -5 : -24,
                ease: 'none',
                scrollTrigger: {
                  trigger: section.current,
                  start: 'top bottom',
                  end: 'bottom top',
                  scrub: 0.8,
                  invalidateOnRefresh: true
                }
              }
            )
          })
      },
      section
    )
    return () => media.revert()
  }, [])

  return (
    <section
      ref={section}
      aria-labelledby="networks-title"
      className="network-section py-16 md:py-24"
    >
      <div className="shell mb-10 md:mb-14">
        <Reveal direction="left">
          <h2
            id="networks-title"
            className="text-[clamp(30px,3.6vw,48px)] font-medium leading-[1.08] tracking-[-0.04em]"
          >
            Connected across chains.
          </h2>
        </Reveal>
      </div>
      <div className="network-window">
        {GROUPS.map((group) => (
          <div key={group.title} className="network-lane">
            <h3 className="sr-only">{group.title}</h3>
            <ul
              className="network-track"
              aria-label={`Supported ${group.title.toLowerCase()}`}
            >
              {[0, 1, 2].flatMap((copy) =>
                group.items.map((item) => (
                  <li
                    key={`${copy}-${item.name}`}
                    aria-hidden={copy > 0 || undefined}
                  >
                    <img
                      src={item.logo}
                      alt=""
                      width={56}
                      height={56}
                      loading="lazy"
                    />
                    <span>{item.name}</span>
                  </li>
                ))
              )}
            </ul>
          </div>
        ))}
      </div>
    </section>
  )
}
