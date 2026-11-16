import { useId, useState } from 'react'
import { ArrowUpRight } from 'lucide-react'

// Adapted from portfolio/registry/ui/widgets/confidential-vault-grid.tsx.
// This is an interface illustration; it does not display live rates or balances.
const VAULTS = [
  { id: 'morpho', protocol: 'Morpho', asset: 'USDC', name: 'USDC vaults', network: 'Ethereum', logo: '/protocols/morpho.png', series: [22, 27, 24, 32, 29, 36, 34, 39, 37, 44, 40, 47] },
  { id: 'curvance', protocol: 'Curvance', asset: 'WMON', name: 'WMON vaults', network: 'Monad', logo: '/protocols/curvance.png', series: [18, 23, 28, 22, 30, 27, 34, 30, 37, 34, 39, 44] },
]

export default function VaultDiscovery() {
  const [filter, setFilter] = useState('All')
  const [selected, setSelected] = useState<string | null>(null)
  const uid = useId().replace(/:/g, '')
  const shown = filter === 'All' ? VAULTS : VAULTS.filter(vault => vault.protocol === filter)
  const active = VAULTS.find(vault => vault.id === selected)

  return (
    <div className="vault-preview">
      <div className="flex items-start justify-between gap-5">
        <h3 className="text-xl font-medium tracking-tight">Vault discovery</h3>
        <span className="pt-1 font-mono text-[10px] text-white/40">Interface preview</span>
      </div>
      <div className="mt-6 flex border-b border-white/10" role="group" aria-label="Preview vault protocols">
        {['All', 'Morpho', 'Curvance'].map(protocol => (
          <button key={protocol} type="button" aria-pressed={filter === protocol} onClick={() => { setFilter(protocol); setSelected(null) }} className={`min-h-11 flex-1 border-b px-3 text-[13px] transition-colors ${filter === protocol ? 'border-neon text-neon' : 'border-transparent text-white/45 hover:text-white'}`}>{protocol}</button>
        ))}
      </div>
      <div className="mt-5 grid grid-cols-2 gap-3">
        {shown.map(vault => {
          const points = vault.series.map((value, i) => `${i * 12},${66 - value}`).join(' ')
          const gradient = `${uid}-${vault.id}`
          return (
            <button key={vault.id} type="button" aria-pressed={selected === vault.id} onClick={() => setSelected(vault.id)} className={`vault-preview-card ${selected === vault.id ? 'border-neon/40' : 'border-white/10'}`}>
              <div className="flex items-center justify-between gap-3">
                <img src={vault.logo} alt="" width={30} height={30} className="h-[30px] w-[30px] object-contain" />
                <span className="font-mono text-[10px] text-white/45">{vault.asset}</span>
              </div>
              <svg viewBox="0 0 132 66" className="my-5 h-20 w-full" preserveAspectRatio="none" aria-hidden="true">
                <defs><linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1"><stop stopColor="#7ce8f2" stopOpacity="0.16" /><stop offset="1" stopColor="#7ce8f2" stopOpacity="0" /></linearGradient></defs>
                <polygon points={`0,66 ${points} 132,66`} fill={`url(#${gradient})`} />
                <polyline points={points} fill="none" stroke={vault.id === 'morpho' ? '#7ce8f2' : '#b9a6ff'} strokeWidth="1.5" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
              </svg>
              <h4 className="text-[15px] font-medium tracking-tight">{vault.name}</h4>
              <p className="mt-1 text-xs text-white/45">{vault.protocol}</p>
              <div className="mt-5 flex items-center justify-between border-t border-white/10 pt-3 text-[10px] text-white/50"><span>{vault.network}</span><ArrowUpRight size={13} aria-hidden="true" /></div>
            </button>
          )
        })}
      </div>
      <div className="mt-5 min-h-12 border-t border-white/10 pt-4 text-[12px] leading-relaxed text-white/50" aria-live="polite">
        {active ? `${active.protocol} / ${active.asset}: review strategy, curator and current terms in Gizu.` : 'Select a vault to explore the interface. Charts are illustrative.'}
      </div>
    </div>
  )
}
