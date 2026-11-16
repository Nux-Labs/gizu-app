import PhoneFrame from './PhoneFrame'
import Reveal from './Reveal'

// Drop the screenshots into landing/public/screens/ with these names.
const SCREENS = [
  { src: '/screens/portfolio.png', title: 'Portfolio', caption: 'Everything you hold, in one view.', tilt: 'md:[transform:perspective(1600px)_rotateY(14deg)_scale(0.92)]' },
  { src: '/screens/discover.png', title: 'Discover', caption: 'Stocks and vaults across chains.', tilt: '', featured: true },
  { src: '/screens/confirm.png', title: 'Confirm', caption: 'Approve every move with your passkey.', tilt: 'md:[transform:perspective(1600px)_rotateY(-14deg)_scale(0.92)]' },
]

export default function AppScreens() {
  return (
    <section id="app" aria-labelledby="app-title" className="relative scroll-mt-28 overflow-hidden border-y border-white/[0.07] bg-[#070a0f]">
      <div className="shell py-20 md:py-28">
        <Reveal direction="up" className="mb-14 md:mb-20">
          <h2 id="app-title" className="text-center text-[clamp(30px,3.6vw,48px)] font-semibold leading-[1.08] tracking-[-0.04em]">
            Your portfolio, in your pocket.
          </h2>
        </Reveal>

        <div className="no-scrollbar -mx-6 flex snap-x snap-mandatory gap-6 overflow-x-auto px-6 pb-4 md:mx-0 md:grid md:grid-cols-3 md:items-end md:gap-10 md:overflow-visible md:px-0 lg:gap-16">
          {SCREENS.map((screen, index) => (
            <Reveal
              key={screen.title}
              direction="up"
              delay={index * 0.12}
              className="w-[62vw] max-w-[260px] shrink-0 snap-center md:w-auto md:max-w-none"
            >
              {/* the reveal animates its own transform, so the lift sits on the figure */}
              <figure className={screen.featured ? 'md:-translate-y-10' : ''}>
                <PhoneFrame
                  src={screen.src}
                  alt={`Gizu ${screen.title.toLowerCase()} screen`}
                  className={screen.tilt}
                />
                <figcaption className="mt-8 text-center">
                  <div className="font-mono text-[11px] text-neon/70">{screen.title}</div>
                  <div className="mt-2 text-[15px] text-white/60">{screen.caption}</div>
                </figcaption>
              </figure>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  )
}
