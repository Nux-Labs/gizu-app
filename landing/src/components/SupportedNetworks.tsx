import Reveal from './Reveal'

const ITEMS = [
  { name: 'Ethereum', kind: 'Chain', logo: '/logos/ethereum.svg' },
  { name: 'Monad', kind: 'Chain', logo: '/logos/monad.png' },
  { name: 'Robinhood Chain', kind: 'Chain', logo: '/logos/robinhood-chain.svg' },
  { name: 'Morpho', kind: 'Protocol', logo: '/logos/morpho.png' },
  { name: 'Curvance', kind: 'Protocol', logo: '/logos/curvance.png' },
  { name: 'Aave', kind: 'Protocol', logo: '/logos/aave.png' },
]

function Logo({ item, hidden = false }: { item: (typeof ITEMS)[number]; hidden?: boolean }) {
  return (
    <li aria-hidden={hidden || undefined} className="flex shrink-0 items-center gap-3">
      <img
        src={item.logo}
        alt=""
        width={28}
        height={28}
        className="h-7 w-7 object-contain"
      />
      <span className="text-[15px] font-medium text-white/85">{item.name}</span>
      <span className="font-mono text-[10px] uppercase tracking-wider text-white/35">{item.kind}</span>
    </li>
  )
}

export default function SupportedNetworks() {
  return (
    <section aria-labelledby="networks-title" className="py-14 md:py-20">
      <Reveal direction="up">
        <h2 id="networks-title" className="text-center font-mono text-[11px] uppercase tracking-[0.18em] text-white/45">
          Supported chains &amp; protocols
        </h2>
      </Reveal>

      <div className="marquee mt-8">
        {/* each half repeats the list so it is wider than large screens; the second half
            makes the loop seamless and is hidden from screen readers */}
        <div className="marquee-track">
          <ul className="flex shrink-0 gap-14 pr-14">
            {ITEMS.map(item => <Logo key={item.name} item={item} />)}
            {ITEMS.map(item => <Logo key={`${item.name}-repeat`} item={item} hidden />)}
          </ul>
          <ul className="flex shrink-0 gap-14 pr-14" aria-hidden="true">
            {[...ITEMS, ...ITEMS].map((item, index) => <Logo key={index} item={item} />)}
          </ul>
        </div>
      </div>
    </section>
  )
}
