import { useId, useState } from 'react'
import { ArrowRight, ArrowUpRight, Check, Layers } from 'lucide-react'
import { APP_URL } from '../../links'

// Adapted from portfolio/registry/ui/widgets/confidential-vault-grid.tsx.
// The charts illustrate the interface, rather than live rates or balances.
const VAULTS = [
  { id: 'morpho', protocol: 'Morpho', asset: 'USDC', network: 'Ethereum', logo: '/protocols/morpho.png', color: '#7ce8f2', series: [22, 27, 24, 32, 29, 36, 34, 39, 37, 44, 40, 47] },
  { id: 'curvance', protocol: 'Curvance', asset: 'WMON', network: 'Monad', logo: '/protocols/curvance.png', color: '#b9a6ff', series: [18, 23, 28, 22, 30, 27, 34, 30, 37, 34, 39, 44] },
]

export default function VaultDiscovery() {
  const [filter, setFilter] = useState('All')
  const [selected, setSelected] = useState('morpho')
  const uid = useId().replace(/:/g, '')
  const shown = filter === 'All' ? VAULTS : VAULTS.filter(vault => vault.protocol === filter)
  const active = VAULTS.find(vault => vault.id === selected) ?? VAULTS[0]

  return (
    <div className="vault-workspace">
      <div className="vault-workspace-bar">
        <div className="flex items-center gap-3 text-base font-medium"><Layers size={18} className="text-neon" aria-hidden="true" />Your investment workspace</div>
        <span className="text-xs text-white/40">Interactive preview</span>
      </div>
      <div className="vault-workspace-body">
        <div className="min-w-0 p-5 sm:p-8">
          <div className="mb-7 flex flex-wrap gap-x-6 border-b border-white/10" role="group" aria-label="Preview vault protocols">
            {['All', 'Morpho', 'Curvance'].map(protocol => (
              <button key={protocol} type="button" aria-pressed={filter === protocol} onClick={() => { setFilter(protocol); if (protocol !== 'All') setSelected(VAULTS.find(vault => vault.protocol === protocol)!.id) }} className={`min-h-11 border-b px-1 text-sm transition-colors ${filter === protocol ? 'border-neon text-neon' : 'border-transparent text-white/45 hover:text-white'}`}>{protocol === 'All' ? 'All vaults' : protocol}</button>
            ))}
          </div>
          <div className="grid grid-cols-1 gap-4 min-[440px]:grid-cols-2">
            {shown.map(vault => {
              const points = vault.series.map((value, i) => `${i * 12},${66 - value}`).join(' ')
              const gradient = `${uid}-${vault.id}`
              const isSelected = selected === vault.id
              return (
                <button key={vault.id} type="button" aria-pressed={isSelected} aria-controls={`${uid}-details`} onClick={() => setSelected(vault.id)} className={`vault-preview-card ${isSelected ? 'border-neon/50 bg-neon/[0.03]' : 'border-white/10'}`}>
                  <div className="flex items-center justify-between gap-3">
                    <img src={vault.logo} alt="" width={36} height={36} className="h-9 w-9 object-contain" />
                    <span className={`flex h-6 w-6 items-center justify-center rounded-md border ${isSelected ? 'border-neon/30 text-neon' : 'border-white/10 text-white/25'}`} aria-hidden="true">{isSelected ? <Check size={13} /> : <ArrowUpRight size={13} />}</span>
                  </div>
                  <h3 className="mt-7 text-[28px] font-medium tracking-tight">{vault.asset}</h3>
                  <p className="mt-1 text-sm text-white/45">{vault.protocol} vaults</p>
                  <svg viewBox="0 0 132 66" className="my-6 h-24 w-full" preserveAspectRatio="none" aria-hidden="true">
                    <defs><linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1"><stop stopColor={vault.color} stopOpacity="0.2" /><stop offset="1" stopColor={vault.color} stopOpacity="0" /></linearGradient></defs>
                    <path d="M0 22H132M0 44H132M0 65H132" stroke="#ffffff09" fill="none" />
                    <polygon points={`0,66 ${points} 132,66`} fill={`url(#${gradient})`} />
                    <polyline points={points} fill="none" stroke={vault.color} strokeWidth="1.5" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
                  </svg>
                  <div className="flex items-center justify-between border-t border-white/10 pt-4 text-xs text-white/50"><span>{vault.network}</span><span>{isSelected ? 'Selected' : 'View details'}</span></div>
                </button>
              )
            })}
          </div>
        </div>
        <div id={`${uid}-details`} className="vault-detail" aria-live="polite" aria-atomic="true">
          <div className="flex items-center gap-4"><img src={active.logo} alt="" className="h-10 w-10 object-contain" /><h3 className="text-2xl font-medium tracking-tight">{active.protocol}</h3></div>
          <p className="mt-5 text-[15px] leading-relaxed text-white/50">A closer look before you commit.</p>
          <dl className="mt-7">
            {[['Deposit asset', active.asset], ['Network', active.network], ['Protocol', active.protocol]].map(([label, value]) => <div key={label} className="flex justify-between gap-4 border-t border-white/10 py-4 text-sm"><dt className="text-white/40">{label}</dt><dd>{value}</dd></div>)}
          </dl>
          <p className="mt-5 text-sm leading-relaxed text-white/45">Review the curator, strategy, current rates and withdrawal terms in Gizu.</p>
          <a href={APP_URL} className="mt-8 flex min-h-[52px] items-center justify-between gap-4 border-t border-neon/30 pt-4 text-sm font-medium text-neon hover:text-white">Continue in Gizu<ArrowRight size={17} aria-hidden="true" /></a>
        </div>
      </div>
      <p className="border-t border-white/[0.07] px-5 py-4 text-xs leading-relaxed text-white/35 sm:px-8">Interface preview. Charts are illustrative. Current availability and investment terms are shown in the app.</p>
    </div>
  )
}
