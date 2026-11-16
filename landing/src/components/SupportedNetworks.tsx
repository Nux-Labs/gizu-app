import Reveal from './Reveal'
import { useRef } from 'react'
import { useInView } from 'framer-motion'

const GROUPS = [
  { title: 'Chains', items: [{ name: 'Ethereum', logo: '/logos/ethereum.svg' }, { name: 'Monad', logo: '/logos/monad.png' }, { name: 'Robinhood Chain', logo: '/logos/robinhood-chain.svg' }] },
  { title: 'Protocols', items: [{ name: 'Morpho', logo: '/logos/morpho.png' }, { name: 'Curvance', logo: '/logos/curvance.png' }, { name: 'Aave', logo: '/logos/aave.png' }] },
]

export default function SupportedNetworks() {
  const panel = useRef<HTMLDivElement>(null)
  const visible = useInView(panel, { amount: 0.2 })
  return (
    <section aria-labelledby="networks-title" className="shell py-14 md:py-20">
      <div ref={panel} className={`network-panel ${visible ? 'is-visible' : ''}`}>
        <Reveal direction="left" className="network-intro"><h2 id="networks-title">Connected across chains.</h2><p>Your assets and investment protocols, brought together in Gizu.</p></Reveal>
        <div className="network-groups">{GROUPS.map((group, index) => <Reveal key={group.title} direction="right" delay={index * 0.08} className="network-group"><h3>{group.title}</h3><ul>{group.items.map(item => <li key={item.name}><div><img src={item.logo} alt="" width={28} height={28} loading="lazy" /></div><span>{item.name}</span></li>)}</ul></Reveal>)}</div>
      </div>
    </section>
  )
}
